import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express, { type Request, type Response, type NextFunction } from 'express';
import type pino from 'pino';
import type { Config } from '../config/loader.js';
import { createMetaSignatureVerifier } from './security.js';
import { parseMetaWebhook } from '../meta/parser.js';
import type { IncomingMessage, ParseResult, StatusUpdate } from '../meta/types.js';

export interface AppDeps {
  config: Config;
  logger: pino.Logger;
}

/**
 * Channel union used by the route-level summary log. Wider than the parser's
 * `Channel` because we still log `'unknown'` at the channel-summary level for
 * payloads with no recognized `object` discriminator.
 */
export type Channel = 'whatsapp' | 'messenger' | 'instagram' | 'unknown';

type RawBodyRequest = Request & { rawBody?: Buffer };

const PACKAGE_VERSION: string = (() => {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.resolve(here, '../../package.json');
    const raw = readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : '0.1.0';
  } catch {
    return '0.1.0';
  }
})();

export function objectToChannel(object: unknown): Channel {
  if (object === 'whatsapp_business_account') return 'whatsapp';
  if (object === 'page') return 'messenger';
  if (object === 'instagram') return 'instagram';
  return 'unknown';
}

/**
 * Parse the webhook body and emit structured logs for the dispatcher.
 *
 * Emits three log shapes:
 *  1. One per-channel summary log (`inbound.{channel}`) — backwards-compat
 *     with the Stage 1 integration tests and the only log shape that fires
 *     for unknown / empty payloads.
 *  2. One per-message log (`inbound.message`) for every parsed `IncomingMessage`.
 *  3. One per-status log (`inbound.status`) for every parsed `StatusUpdate`.
 *
 * Returns the {@link ParseResult} so callers (Stage 5 conversation agent,
 * unit tests) can act on it. The HTTP route handler discards the return
 * value after ACKing 200 — Meta retries non-2xx for 7 days so we ACK
 * before we parse.
 */
export function dispatchWebhook(
  body: unknown,
  logger: pino.Logger,
  _config: Config
): ParseResult {
  const objectField =
    body !== null && typeof body === 'object'
      ? (body as { object?: unknown }).object
      : undefined;
  const entry =
    body !== null && typeof body === 'object'
      ? (body as { entry?: unknown }).entry
      : undefined;
  const entryCount = Array.isArray(entry) ? entry.length : 0;
  const channel = objectToChannel(objectField);

  // The parser is documented as non-throwing — defensive try/catch is here as
  // a safety net only. If it ever fires we've already ACKed 200, so we can't
  // re-throw without crashing the process. Surface as `error` and move on.
  let result: ParseResult;
  try {
    result = parseMetaWebhook(body);
  } catch (err) {
    logger.error({ err, channel }, 'dispatcher parse failed unexpectedly');
    result = { messages: [], statuses: [] };
  }

  // Per-message logs. Use `warn` for `type: 'unknown'` so unmodeled inbounds
  // surface in observability; `info` for everything else.
  for (const msg of result.messages) {
    logIncomingMessage(logger, msg);
  }

  // Per-status logs are always `info` — status updates are routine.
  for (const status of result.statuses) {
    logStatusUpdate(logger, status);
  }

  // Channel-level summary log. Kept as the FINAL emit so its position in the
  // log stream remains stable for downstream log-driven assertions / tooling.
  // Unknown channel logs at `warn`; everything else at `info`.
  const summaryFields = {
    channel,
    entryCount,
    messageCount: result.messages.length,
    statusCount: result.statuses.length,
    traceMarker: `inbound.${channel}` as const
  };

  if (channel === 'unknown') {
    logger.warn({ ...summaryFields, objectField }, 'inbound webhook with unknown object field');
  } else {
    logger.info(summaryFields, 'inbound webhook received');
  }

  return result;
}

function logIncomingMessage(logger: pino.Logger, msg: IncomingMessage): void {
  const fields = {
    channel: msg.channel,
    traceMarker: 'inbound.message' as const,
    messageType: msg.type,
    channelMessageId: msg.channelMessageId,
    // PII redaction is a Stage 6 concern — log full ids for now so the
    // wiring is debuggable end-to-end. Stage 6 will gate on config.nodeEnv.
    channelScopedUserId: msg.channelScopedUserId,
    channelScopedBusinessId: msg.channelScopedBusinessId,
    timestamp: msg.timestamp,
    isEcho: msg.isEcho ?? false,
    hasMedia: msg.media !== undefined,
    hasReplyTo: msg.replyTo !== undefined
  };
  // `unknown` types surface at `warn` so unmodeled inbounds get attention.
  if (msg.type === 'unknown') {
    logger.warn(fields, 'inbound message parsed');
  } else {
    logger.info(fields, 'inbound message parsed');
  }
}

function logStatusUpdate(logger: pino.Logger, status: StatusUpdate): void {
  const fields: Record<string, unknown> = {
    channel: status.channel,
    traceMarker: 'inbound.status',
    channelMessageId: status.channelMessageId,
    status: status.status,
    timestamp: status.timestamp
  };
  if (status.errorCode !== undefined) fields.errorCode = status.errorCode;
  if (status.errorTitle !== undefined) fields.errorTitle = status.errorTitle;
  logger.info(fields, 'inbound status update');
}

export function createApp(deps: AppDeps): express.Express {
  const { config, logger } = deps;
  const app = express();
  const startedAtMs = Date.now();

  app.use(
    express.json({
      limit: '5mb',
      verify: (req, _res, buf) => {
        (req as RawBodyRequest).rawBody = Buffer.isBuffer(buf) ? Buffer.from(buf) : Buffer.alloc(0);
      }
    })
  );

  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({
      status: 'ok',
      uptimeSeconds: Math.floor((Date.now() - startedAtMs) / 1000),
      version: PACKAGE_VERSION,
      nodeVersion: process.version
    });
  });

  app.get('/webhook', (req: Request, res: Response) => {
    const mode = typeof req.query['hub.mode'] === 'string' ? req.query['hub.mode'] : undefined;
    const verifyToken =
      typeof req.query['hub.verify_token'] === 'string' ? req.query['hub.verify_token'] : undefined;
    const challenge =
      typeof req.query['hub.challenge'] === 'string' ? req.query['hub.challenge'] : undefined;
    const tokenMatches = verifyToken === config.meta.verifyToken;

    if (mode === 'subscribe' && tokenMatches) {
      logger.info(
        { mode, hasChallenge: challenge !== undefined, tokenMatches: true },
        'meta webhook verification accepted'
      );
      res.status(200).type('text/plain').send(challenge ?? '');
      return;
    }

    logger.warn(
      { mode, hasChallenge: challenge !== undefined, tokenMatches },
      'meta webhook verification rejected'
    );
    res.status(403).end();
  });

  // Build the candidate secret set for inbound signature verification. WhatsApp
  // and Messenger webhooks are signed with META_APP_SECRET; Instagram webhooks
  // are signed with INSTAGRAM_APP_SECRET (proven against the live API
  // 2026-05-20). The verifier accepts a signature that matches ANY configured
  // secret — see src/http/security.ts for the try-all rationale.
  const signatureSecrets = [config.meta.appSecret];
  if (config.instagram?.appSecret && !signatureSecrets.includes(config.instagram.appSecret)) {
    signatureSecrets.push(config.instagram.appSecret);
  }

  // Foot-gun guard: an enabled Instagram channel WITHOUT its app secret means
  // every inbound IG webhook will fail signature verification (401) silently
  // from the developer's perspective. We don't throw at config load (so
  // WhatsApp+Messenger-only and partial setups keep running), but we surface it
  // loudly at startup so the cause is discoverable.
  if (config.channels.instagram && !config.instagram?.appSecret) {
    logger.warn(
      { channel: 'instagram' },
      'Instagram channel enabled but INSTAGRAM_APP_SECRET not set — inbound Instagram webhooks will fail signature verification.'
    );
  }

  const verifier = createMetaSignatureVerifier(signatureSecrets, logger);
  app.post('/webhook', verifier, (req: Request, res: Response) => {
    // ACK before parsing — Meta retries non-2xx for 7 days then drops, so the
    // 200 is load-bearing. Stage 5 will consume the returned ParseResult; for
    // now it's discarded on the route path and unit-testable via dispatchWebhook.
    res.status(200).send('EVENT_RECEIVED');
    void dispatchWebhook(req.body, logger, config);
  });

  app.use((req: Request, res: Response) => {
    logger.debug({ method: req.method, path: req.path, traceMarker: '404' }, 'no route matched');
    res.status(404).json({ error: 'not_found' });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    logger.error(
      { err, method: req.method, path: req.path },
      'unhandled error in express pipeline'
    );
    if (res.headersSent) return;
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
