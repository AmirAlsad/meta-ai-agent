/**
 * Webhook capture infrastructure for setup / capture scripts.
 *
 * This is the boot-and-tear-down primitive every Stage 3 script uses to
 * receive real webhook deliveries from Meta. It wires together:
 *  - an Express app whose middleware mirrors the production app
 *    (`createApp` in `src/http/app.ts`) — same raw-body capture, same
 *    signature verifier, same `GET /webhook` verification handshake.
 *  - an ngrok tunnel (via {@link startTunnel}) for the public callback URL.
 *  - an in-memory ring of captured webhooks plus a subscriber list, so a
 *    guided-capture script can `await` the next inbound matching a scenario.
 *  - file-based capture writes under `.captures/meta/{channel}/`.
 *
 * Two routes are exposed:
 *  - `GET /webhook` — verify-token handshake, identical to production.
 *  - `POST /webhook` — capture handler. Always 200 ACKs (see below); records
 *    the body, runs it through `parseMetaWebhook`, fires subscribers.
 *
 * WHY mirror production middleware (not wrap `createApp`): the production
 * route handler logs + dispatches, but a capture handler needs to record the
 * body for later inspection without fighting the production app's logger
 * shape. Mirroring is cleaner separation.
 *
 * WHY ACK-then-mark-invalid for signature failures (in strict mode 401, in
 * lenient mode 200): in PRODUCTION the right move is 401 on bad signatures
 * so Meta retries broken deliveries (it doesn't — it retries on non-2xx for
 * 7 days, dropping after). But this is the CAPTURE server. During setup the
 * developer is actively iterating on app secret config; we want every
 * delivery surfaced for inspection so they can SEE the signature mismatch
 * and fix it, not have Meta drown them in retries of the same broken
 * payload. So in lenient mode (`acceptInvalidSignatures: true`) we ACK 200
 * and mark `signatureValid: false`; in strict mode (the default) we 401 to
 * match production behavior.
 */
import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction
} from 'express';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';
import pino from 'pino';

import type { Config } from '../../src/config/loader.js';
import type { ParseResult } from '../../src/meta/types.js';
import { parseMetaWebhook } from '../../src/meta/parser.js';
import { verifyMetaSignature } from '../../src/http/security.js';
import { objectToChannel } from '../../src/http/app.js';
import { startTunnel, type ActiveTunnel } from './tunnel.js';

type CaptureChannelHint = 'whatsapp' | 'messenger' | 'instagram' | 'unknown';

export interface CapturedWebhook {
  /** ms since epoch when the request hit the capture handler. */
  receivedAt: number;
  /** Channel inferred from the top-level `object` field. */
  channelHint: CaptureChannelHint;
  /** Parsed JSON of the request body (or `undefined` if body was empty). */
  rawBody: unknown;
  /** Result of running the body through the production parser. */
  parsed: ParseResult;
  /** Whether X-Hub-Signature-256 verified. */
  signatureValid: boolean;
  /**
   * Safe-to-log subset of request headers. Sensitive header values are
   * redacted (we keep the LENGTH of the signature so the developer can spot
   * "I'm sending a different shaped signature than Meta sends") but never
   * the value.
   */
  headers: Record<string, string>;
  /** Optional tag set by guided-capture for fixture filenames. */
  scenario?: string;
}

export type CaptureSubscriber = (cap: CapturedWebhook) => void;

export interface CaptureServerHandle {
  /** Public HTTPS URL (from the tunnel) suitable for Meta webhook config. */
  url: string;
  /** Local port the server is bound to (defaults to `config.port`). */
  localPort: number;
  /** Subscribe to captured webhooks. Returns an unsubscribe fn. */
  onWebhook(cb: CaptureSubscriber): () => void;
  /**
   * Write a captured webhook to `.captures/meta/{channelHint}/{filename}.json`.
   * Returns the absolute path written. Creates dir tree if missing. If a file
   * with the same name already exists, appends `-1`, `-2`, etc.
   */
  saveCapture(
    cap: CapturedWebhook,
    opts?: { dir?: string; filename?: string }
  ): Promise<string>;
  /**
   * Return recent captures (most-recent last). Useful for guided-capture
   * scripts that want to scan the buffer for a matching scenario without
   * subscribing.
   */
  getRecentCaptures(limit?: number): CapturedWebhook[];
  /** Shut down Express and ngrok cleanly. */
  close(): Promise<void>;
}

export interface CaptureTunnelOverride {
  url: string;
  close(): Promise<void>;
}

export interface CaptureServerOptions {
  config: Config;
  /** Defaults to `config.port` (3000). */
  port?: number;
  /**
   * Pass-through to {@link startTunnel}. Ignored if {@link tunnelOverride}
   * is set. `domain` defaults to `config.ngrokDomain` (which is required at
   * config-load time); callers rarely need to override it.
   */
  tunnel?: { domain?: string; authtoken?: string };
  /**
   * Inject a pre-built tunnel object (e.g. an already-running ngrok session,
   * or a fake for unit tests). When set, the server does NOT call
   * `startTunnel` and uses `tunnelOverride.url` as the public URL.
   */
  tunnelOverride?: CaptureTunnelOverride;
  /**
   * If true, signature-failed requests are STILL captured (with
   * `signatureValid: false`) and ACK 200. If false (the default), they 401
   * — matching production behavior and surfacing the problem to the developer
   * via Meta's webhook-test UI. See top-of-file WHY-comment for the rationale.
   */
  acceptInvalidSignatures?: boolean;
  /** Directory under which captures are written. Default `.captures/meta`. */
  capturesDir?: string;
  /** Optional logger (e.g. for tests). Defaults to a pino-pretty info logger. */
  logger?: pino.Logger;
  /** Cap on the in-memory capture ring. Default 200. */
  maxBufferedCaptures?: number;
}

/** Boot the capture server + tunnel. Returns a handle for the caller. */
export async function startCaptureServer(
  opts: CaptureServerOptions
): Promise<CaptureServerHandle> {
  const logger = opts.logger ?? defaultLogger();
  const port = opts.port ?? opts.config.port ?? 3000;
  const capturesDir = opts.capturesDir ?? path.resolve(process.cwd(), '.captures/meta');
  const acceptInvalid = opts.acceptInvalidSignatures === true;
  const maxBuffer = opts.maxBufferedCaptures ?? 200;

  const captures: CapturedWebhook[] = [];
  const subscribers = new Set<CaptureSubscriber>();

  const app = buildExpressApp({
    config: opts.config,
    acceptInvalid,
    logger,
    onCapture: (cap) => {
      captures.push(cap);
      // Bound the in-memory ring — long-running capture sessions can collect
      // hundreds of webhooks; we don't need to keep them all in process memory
      // since saveCapture writes to disk anyway.
      if (captures.length > maxBuffer) captures.shift();
      for (const sub of subscribers) {
        try {
          sub(cap);
        } catch (err) {
          // Subscriber errors must not break the ack loop. Log and continue.
          logger.error({ err }, 'capture subscriber threw');
        }
      }
    }
  });

  const server = await listen(app, port);
  const boundPort = portFromServer(server, port);

  // Tunnel: use the override if provided (unit tests); otherwise spin a real
  // ngrok tunnel via the shared helper.
  let tunnel: ActiveTunnel | CaptureTunnelOverride;
  if (opts.tunnelOverride) {
    tunnel = opts.tunnelOverride;
  } else {
    tunnel = await startTunnel({
      port: boundPort,
      // `domain` is required by startTunnel; default to the config's
      // ngrokDomain (validated at load time) so callers don't have to
      // thread it through. An explicit `opts.tunnel.domain` still wins for
      // ad-hoc overrides.
      domain: opts.tunnel?.domain ?? opts.config.ngrokDomain,
      ...(opts.tunnel?.authtoken !== undefined ? { authtoken: opts.tunnel.authtoken } : {})
    });
  }

  return {
    url: tunnel.url,
    localPort: boundPort,
    onWebhook(cb) {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    async saveCapture(cap, saveOpts) {
      return writeCapture(cap, {
        dir: saveOpts?.dir ?? capturesDir,
        ...(saveOpts?.filename !== undefined ? { filename: saveOpts.filename } : {})
      });
    },
    getRecentCaptures(limit) {
      if (limit === undefined) return captures.slice();
      return captures.slice(-limit);
    },
    async close() {
      await Promise.allSettled([closeServer(server), tunnel.close()]);
    }
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Express app construction                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

interface BuildAppArgs {
  config: Config;
  acceptInvalid: boolean;
  logger: pino.Logger;
  onCapture: (cap: CapturedWebhook) => void;
}

type RawBodyRequest = Request & { rawBody?: Buffer };

function buildExpressApp(args: BuildAppArgs): Express {
  const { config, acceptInvalid, logger, onCapture } = args;
  const app = express();

  // Candidate secrets for inbound signature verification — mirror production
  // (src/http/app.ts). WhatsApp + Messenger sign with META_APP_SECRET; Instagram
  // signs with INSTAGRAM_APP_SECRET (proven against the live API 2026-05-20).
  // The verifier accepts a signature matching ANY configured secret, so the
  // capture server now correctly accepts real Instagram webhooks during setup
  // instead of 401ing them (strict mode) or marking them signatureValid: false
  // (lenient mode).
  const signatureSecrets = [config.meta.appSecret];
  if (config.instagram?.appSecret && !signatureSecrets.includes(config.instagram.appSecret)) {
    signatureSecrets.push(config.instagram.appSecret);
  }
  if (config.channels.instagram && !config.instagram?.appSecret) {
    logger.warn(
      { channel: 'instagram' },
      'Instagram channel enabled but INSTAGRAM_APP_SECRET not set — captured Instagram webhooks will fail signature verification.'
    );
  }

  app.use(
    express.json({
      limit: '5mb',
      verify: (req, _res, buf) => {
        (req as RawBodyRequest).rawBody = Buffer.isBuffer(buf) ? Buffer.from(buf) : Buffer.alloc(0);
      }
    })
  );

  // GET /webhook — verify-token handshake. Mirror production behavior so
  // capture scripts can complete Meta's webhook setup flow without booting
  // the production app.
  app.get('/webhook', (req: Request, res: Response) => {
    const mode = typeof req.query['hub.mode'] === 'string' ? req.query['hub.mode'] : undefined;
    const verifyToken =
      typeof req.query['hub.verify_token'] === 'string' ? req.query['hub.verify_token'] : undefined;
    const challenge =
      typeof req.query['hub.challenge'] === 'string' ? req.query['hub.challenge'] : undefined;
    const tokenMatches = verifyToken === config.meta.verifyToken;

    if (mode === 'subscribe' && tokenMatches) {
      logger.info({ mode, hasChallenge: challenge !== undefined }, 'capture verification accepted');
      res.status(200).type('text/plain').send(challenge ?? '');
      return;
    }
    logger.warn({ mode, tokenMatches }, 'capture verification rejected');
    res.status(403).end();
  });

  // POST /webhook — the capture handler.
  app.post('/webhook', (req: Request, res: Response) => {
    const rawBody = (req as RawBodyRequest).rawBody ?? Buffer.alloc(0);
    const signatureHeader = req.header('x-hub-signature-256');
    const signatureValid = verifyMetaSignature(rawBody, signatureHeader, signatureSecrets);

    if (!signatureValid && !acceptInvalid) {
      // Strict mode (default): match production. 401 surfaces the problem to
      // Meta's webhook-test UI so the developer notices their app secret is
      // wrong. We do NOT capture the body in this branch — capturing a body
      // we couldn't verify could leak fake / replayed payloads into the
      // captures dir.
      logger.warn(
        { bodyBytes: rawBody.length, signaturePresent: signatureHeader !== undefined },
        'capture rejecting invalid signature (strict mode)'
      );
      res.status(401).json({ error: 'invalid_signature' });
      return;
    }

    // ACK 200 BEFORE doing any parse work so Meta sees a fast response. The
    // production app does the same; we follow the same contract for the
    // capture path.
    res.status(200).send('EVENT_RECEIVED');

    const rawBodyParsed = req.body as unknown;
    const objectField =
      typeof rawBodyParsed === 'object' && rawBodyParsed !== null
        ? (rawBodyParsed as { object?: unknown }).object
        : undefined;
    const channelHint = objectToChannel(objectField);

    let parsed: ParseResult = { messages: [], statuses: [] };
    try {
      parsed = parseMetaWebhook(rawBodyParsed);
    } catch (err) {
      logger.error({ err, channelHint }, 'capture parse failed unexpectedly');
    }

    const captured: CapturedWebhook = {
      receivedAt: Date.now(),
      channelHint,
      rawBody: rawBodyParsed,
      parsed,
      signatureValid,
      headers: redactHeaders(req.headers)
    };
    logger.info(
      {
        channelHint,
        messageCount: parsed.messages.length,
        statusCount: parsed.statuses.length,
        signatureValid
      },
      'captured webhook'
    );
    onCapture(captured);
  });

  // 404 for anything else — capture scripts don't expose health / admin.
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not_found' });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err }, 'capture server unhandled error');
    if (res.headersSent) return;
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}

/**
 * Redact request headers to a safe-to-log subset. We KEEP:
 *  - content-type, user-agent, host (operational debugging)
 *  - x-hub-signature-256 LENGTH only (so the developer can spot a malformed
 *    signature without leaking the value).
 */
function redactHeaders(headers: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  const passthrough = ['content-type', 'user-agent', 'host', 'content-length'];
  for (const key of passthrough) {
    const v = headers[key];
    if (typeof v === 'string') out[key] = v;
  }
  const sig = headers['x-hub-signature-256'];
  if (typeof sig === 'string') {
    out['x-hub-signature-256'] = `[redacted, length=${sig.length}]`;
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* HTTP server lifecycle                                                      */
/* ────────────────────────────────────────────────────────────────────────── */

async function listen(app: Express, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => resolve(server));
    server.on('error', reject);
  });
}

function portFromServer(server: Server, fallback: number): number {
  const addr = server.address();
  if (typeof addr === 'object' && addr !== null && typeof addr.port === 'number') {
    return addr.port;
  }
  return fallback;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    // We swallow the error from `server.close` because by the time close()
    // is called, the most common cause of error is "server isn't listening"
    // which we don't care about — we wanted it shut.
    server.close(() => resolve());
  });
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Capture writes                                                             */
/* ────────────────────────────────────────────────────────────────────────── */

async function writeCapture(
  cap: CapturedWebhook,
  opts: { dir: string; filename?: string }
): Promise<string> {
  const channelDir = path.resolve(opts.dir, cap.channelHint);
  await mkdir(channelDir, { recursive: true });

  const baseName = opts.filename ?? defaultFilename(cap);
  const filePath = await firstAvailablePath(channelDir, baseName);
  await writeFile(filePath, `${JSON.stringify(cap, null, 2)}\n`, { mode: 0o600 });
  return filePath;
}

function defaultFilename(cap: CapturedWebhook): string {
  const ts = new Date(cap.receivedAt).toISOString().replace(/[:.]/g, '-');
  // Prefer a meaningful suffix: scenario tag wins; then the first message
  // type; then the channel hint. This keeps captures human-scannable in the
  // .captures/ tree.
  const messageType = cap.parsed.messages[0]?.type;
  const statusType = cap.parsed.statuses[0]?.status;
  const suffix = cap.scenario ?? messageType ?? statusType ?? cap.channelHint;
  return `${ts}-${sanitizeSegment(suffix)}.json`;
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-') || 'webhook';
}

/**
 * If `${dir}/${name}.json` exists, try `${name}-1.json`, `${name}-2.json`,
 * etc. Avoids silently overwriting captures from the same second.
 */
async function firstAvailablePath(dir: string, name: string): Promise<string> {
  const ext = path.extname(name);
  const stem = ext.length > 0 ? name.slice(0, -ext.length) : name;
  const fallbackExt = ext.length > 0 ? ext : '.json';
  let candidate = path.join(dir, `${stem}${fallbackExt}`);
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await access(candidate, fsConstants.F_OK);
    } catch {
      return candidate;
    }
    attempt += 1;
    candidate = path.join(dir, `${stem}-${attempt}${fallbackExt}`);
    // Guard against pathological loops.
    if (attempt > 9999) {
      throw new Error(`Unable to find an unused capture filename under ${dir} for ${name}`);
    }
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Logger                                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

function defaultLogger(): pino.Logger {
  // Try to enable pretty output when stdout is a TTY; fall back to JSON for
  // CI / pipes. pino-pretty is a devDep so we don't `require` it unconditionally.
  if (process.stdout.isTTY === true) {
    try {
      return pino({
        level: 'info',
        transport: { target: 'pino-pretty', options: { colorize: true } }
      });
    } catch {
      // Fall through to plain JSON logger if pino-pretty isn't available.
    }
  }
  return pino({ level: 'info' });
}
