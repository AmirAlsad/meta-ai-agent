/**
 * Stage 3 — passive payload-capture server.
 *
 * Long-running Express + ngrok process whose ONLY job is to receive real
 * webhook deliveries from Meta, decorate them with parser output + signature
 * validity, and write each one as a JSON file under `.captures/meta/{channel}/`.
 *
 * No business logic — no chat dispatch, no outbound replies, just `200 ACK`.
 *
 * WHY mount our own capture server (via `startCaptureServer`) instead of
 * reusing the production `createApp`:
 *  - `createApp` wires up the dispatch logger that fans out to the Stage-5
 *    conversation agent. Capture runs do NOT want side effects. They want a
 *    bit-faithful copy of the body + headers on disk for later promotion to
 *    `tests/fixtures/captured/`.
 *  - The capture server applies the SAME signature middleware as production
 *    so we still catch app-secret typos at the door; it just diverges after
 *    the verification step.
 *  - `startCaptureServer` exposes an `onWebhook` subscription which we use
 *    here to drive the per-capture file write + log line. Wrapping `createApp`
 *    would require monkey-patching its router to intercept bodies.
 *
 * WHY `process.exitCode = N; return;` rather than `process.exit(N)`: we hold
 * an ngrok tunnel + Express server handle. Hard-exit orphans them and leaves
 * the ngrok session counted against your account's active-tunnels quota.
 * Setting `exitCode` lets the `finally` block tear down cleanly.
 */
import 'dotenv/config';
import path from 'node:path';

import { loadConfig, type Config } from '../../src/config/loader.js';
import { startTunnel, type ActiveTunnel } from '../lib/tunnel.js';
import {
  startCaptureServer,
  type CaptureServerHandle,
  type CapturedWebhook
} from '../lib/capture-server.js';
import { registerAllWebhooks } from '../setup/register-webhooks.js';
import { info, success, warn, fail, divider, registerShutdown } from '../lib/console.js';
import pino from 'pino';

/* ────────────────────────────────────────────────────────────────────────── */
/* CLI flags                                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

export interface FixtureCaptureFlags {
  help: boolean;
  port: number | undefined;
  ngrokDomain: string | undefined;
  capturesDir: string | undefined;
  acceptInvalidSignatures: boolean;
  noWebhookRegistration: boolean;
}

/** Parse `process.argv` slice into a typed flag bag. Throws on unknown flags. */
export function parseFlags(argv: readonly string[]): FixtureCaptureFlags {
  const flags: FixtureCaptureFlags = {
    help: false,
    port: undefined,
    ngrokDomain: undefined,
    capturesDir: undefined,
    acceptInvalidSignatures: false,
    noWebhookRegistration: false
  };
  for (const raw of argv) {
    if (raw === '--help' || raw === '-h') {
      flags.help = true;
      continue;
    }
    if (raw === '--accept-invalid-signatures') {
      flags.acceptInvalidSignatures = true;
      continue;
    }
    if (raw === '--no-webhook-registration') {
      flags.noWebhookRegistration = true;
      continue;
    }
    if (raw.startsWith('--port=')) {
      const v = raw.slice('--port='.length);
      const parsed = Number.parseInt(v, 10);
      if (!Number.isFinite(parsed) || String(parsed) !== v || parsed < 1 || parsed > 65535) {
        throw new Error(`Invalid --port=${v}: expected integer 1–65535.`);
      }
      flags.port = parsed;
      continue;
    }
    if (raw.startsWith('--ngrok-domain=')) {
      flags.ngrokDomain = raw.slice('--ngrok-domain='.length);
      continue;
    }
    if (raw.startsWith('--captures-dir=')) {
      flags.capturesDir = raw.slice('--captures-dir='.length);
      continue;
    }
    throw new Error(`Unknown flag: ${raw}. Run with --help for usage.`);
  }
  return flags;
}

const HELP_TEXT = `
fixture-capture — Passive webhook capture server for Meta payloads.

Boots an Express + ngrok server that mirrors production signature validation
but never dispatches to the conversation agent. Every inbound webhook is
parsed, decorated, and written as JSON to .captures/meta/{channel}/. Use this
to build a corpus of real-world payloads for testing.

Usage:
  npm run capture:fixtures [-- --flag ...]
  npx tsx scripts/capture/fixture-capture.ts [options]

Options:
  --port=<n>                      Local listener port. Default: config.port (3000).
  --ngrok-domain=<x>              Reserved ngrok subdomain (e.g. my-app.ngrok-free.app).
  --captures-dir=<path>           Output directory. Default: .captures/meta.
  --accept-invalid-signatures     Capture even when X-Hub-Signature-256 fails
                                  (default: strict — 401 + drop). Useful while
                                  iterating on app-secret config.
  --no-webhook-registration       Skip the Meta webhook subscription POST.
                                  Default: register on startup so Meta routes
                                  events to this tunnel.
  --help, -h                      Show this message.

Environment:
  Required:
    META_APP_ID, META_APP_SECRET, META_VERIFY_TOKEN, CHAT_ENDPOINT_URL,
    plus per-channel credentials for at least one of WhatsApp / Messenger /
    Instagram. See README.
  Required (unless --ngrok-domain implies a free public host):
    NGROK_AUTHTOKEN — your ngrok account token.

Output safety:
  Captures may contain phone numbers, names, message content, and tokens.
  Redact before promoting to tests/fixtures/captured/.
`.trim();

/* ────────────────────────────────────────────────────────────────────────── */
/* Filename derivation                                                        */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Compose the filename for a captured webhook.
 *
 * Layout: `{ISO-timestamp-with-millis}-{channelHint}-{type}.json` where
 * `type` is the FIRST message type, the FIRST status string, or
 * `'envelope'` when the body has neither. We use the first because Meta
 * batches events but rarely mixes types within a single delivery; the
 * filename is a navigational aid, not a manifest. The `_scenario` /
 * full-event detail lives inside the JSON.
 *
 * Exported so the unit tests assert it directly without booting a server.
 */
export function deriveFilename(cap: CapturedWebhook): string {
  const ts = new Date(cap.receivedAt).toISOString().replace(/[:.]/g, '-');
  const messageType = cap.parsed.messages[0]?.type;
  const statusType = cap.parsed.statuses[0]?.status;
  const suffix = messageType ?? statusType ?? 'envelope';
  return `${ts}-${sanitizeSegment(cap.channelHint)}-${sanitizeSegment(suffix)}.json`;
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-') || 'webhook';
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Main                                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  let flags: FixtureCaptureFlags;
  try {
    flags = parseFlags(process.argv.slice(2));
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    process.exitCode = 2;
    return;
  }

  if (flags.help) {
    process.stdout.write(`${HELP_TEXT}\n`);
    return;
  }

  divider('meta-ai-agent: fixture capture');

  // ── Load config with a friendly error path. `loadConfig` is strict and
  // throws on missing required vars / half-configured channels. ─────────────
  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(`Configuration error: ${msg}`);
    info(
      'Hint: ensure .env defines META_APP_ID, META_APP_SECRET, META_VERIFY_TOKEN, ' +
        'CHAT_ENDPOINT_URL, and credentials for at least one channel.'
    );
    process.exitCode = 1;
    return;
  }

  const port = flags.port ?? config.port;
  const capturesDir =
    flags.capturesDir !== undefined
      ? path.resolve(process.cwd(), flags.capturesDir)
      : path.resolve(process.cwd(), '.captures/meta');

  // Redaction warning at startup — prominent because every capture written
  // below MAY contain personal data and tokens.
  warn(
    '**Captures may contain phone numbers, names, message content, and tokens. ' +
      'Redact before promoting to `tests/fixtures/captured/`.**'
  );
  info(
    `Mode: ${flags.acceptInvalidSignatures ? 'lenient (invalid signatures captured + flagged)' : 'strict (invalid signatures → 401, body dropped)'}`
  );

  // ── Start the tunnel up-front so we can pass it to the capture server.
  // The capture server CAN start its own tunnel, but starting it here lets
  // us reuse the same URL for the optional webhook-registration step
  // without booting two tunnels (which @ngrok/ngrok rejects on the free tier).
  let tunnel: ActiveTunnel | undefined;
  let capture: CaptureServerHandle | undefined;
  try {
    tunnel = await startTunnel({
      port,
      // CLI `--ngrok-domain` overrides; otherwise fall back to the
      // load-bearing `config.ngrokDomain` (validated at config load).
      domain: flags.ngrokDomain ?? config.ngrokDomain
    });
    success(`ngrok tunnel: ${tunnel.url}`);

    capture = await startCaptureServer({
      config,
      port,
      capturesDir,
      acceptInvalidSignatures: flags.acceptInvalidSignatures,
      tunnelOverride: { url: tunnel.url, close: () => tunnel!.close() }
    });

    // ── Optional webhook registration. Default: attempt. Per-channel
    // failure surfaces in the summary; we don't abort the capture run on it.
    let webhookRegistered = false;
    if (!flags.noWebhookRegistration) {
      const logger = pino({ level: process.env['LOG_LEVEL'] ?? 'info' });
      try {
        const summary = await registerAllWebhooks({
          config,
          callbackUrl: `${tunnel.url}/webhook`,
          logger
        });
        for (const r of summary.results) {
          const tag = r.channel.toUpperCase();
          if (r.status === 'success') success(`${tag}: ${r.message}`);
          else if (r.status === 'skipped') info(`${tag} (skipped): ${r.message}`);
          else if (r.status === 'manual_required') {
            warn(`${tag}: ${r.message}`);
            if (r.remediation) warn(`        ${r.remediation}`);
          } else fail(`${tag}: ${r.message}`);
        }
        webhookRegistered = summary.allSucceeded;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warn(`Webhook registration threw: ${msg}. Continuing — capture server is still listening.`);
      }
    } else {
      info('Skipping webhook registration (--no-webhook-registration). Configure manually if needed.');
    }

    // ── Subscribe to captures: one file per delivery, one log line per file.
    capture.onWebhook((cap: CapturedWebhook) => {
      const filename = deriveFilename(cap);
      capture!
        .saveCapture(cap, { filename })
        .then((filePath: string) => {
          const sigTag = cap.signatureValid ? 'sig=valid' : 'sig=INVALID';
          const bodyBytes = capturedBodySize(cap);
          info(
            `captured: ${filePath} channel=${cap.channelHint} ${sigTag} body=${bodyBytes}B`
          );
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          fail(`Failed to save capture: ${msg}`);
        });
    });

    divider();
    info(`Capture server running. Public URL: ${tunnel.url}`);
    info(`Webhook subscribed: ${webhookRegistered}`);
    info(`Saving captures to: ${capturesDir}`);
    info('Press Ctrl-C to stop.');
    divider();

    // Keep the process alive until SIGINT/SIGTERM.
    await waitForShutdown();
  } finally {
    info('Shutting down…');
    if (capture) {
      try {
        await capture.close();
      } catch {
        /* swallowed — tunnel.close runs once via tunnelOverride */
      }
    } else if (tunnel) {
      try {
        await tunnel.close();
      } catch {
        /* no-op */
      }
    }
  }
}

/**
 * Approximate the captured request body size in bytes. We re-serialize
 * because the in-memory `cap.rawBody` is already JSON-parsed; the original
 * byte length is only available inside the capture-server middleware. This
 * is close enough for a log line.
 */
function capturedBodySize(cap: CapturedWebhook): number {
  try {
    return Buffer.byteLength(JSON.stringify(cap.rawBody ?? null), 'utf8');
  } catch {
    return 0;
  }
}

/**
 * Resolve when SIGINT or SIGTERM is received. Routes through
 * {@link registerShutdown} on `console.ts` so we share the single ordered
 * shutdown path with verify-shared / oauth-instagram (no competing
 * handlers). The hook runs in the central registry's parallel-with-timeout
 * pipeline; we resolve from inside the hook so the surrounding `finally`
 * cleanup in `main()` runs once the central handler has woken us up.
 */
function waitForShutdown(): Promise<void> {
  return new Promise((resolve) => {
    registerShutdown(() => {
      resolve();
    });
  });
}

/* ────────────────────────────────────────────────────────────────────────── */
/* CLI entry point                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Detect direct execution vs. library import. Node ESM has no
 * `require.main === module` analog; compare the resolved import-meta URL to
 * the process entry point.
 */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const entryUrl = new URL(`file://${entry}`).href;
    return import.meta.url === entryUrl || import.meta.url.endsWith(entry);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    fail(`Unexpected error: ${msg}`);
    process.exitCode = 1;
  });
}
