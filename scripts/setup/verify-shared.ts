/**
 * Shared helpers for the per-channel verify scripts
 * (`verify-whatsapp.ts`, `verify-messenger.ts`, `verify-instagram.ts`,
 * `verify-all.ts`).
 *
 * Every verify script walks the developer through:
 *  - phase 0  bootstrap: load config, spin up ngrok tunnel + capture server,
 *             optionally register webhooks.
 *  - phase 1+ channel-specific checks (token validity, send test, receive test,
 *             etc.) culminating in a {@link ChannelVerifyResult}.
 *
 * The boring parts (arg parsing, tunnel + capture lifecycle, capture-polling
 * helper, summary formatter) live here so each script reads as a list of
 * domain steps and not a re-implementation of the harness.
 *
 * WHY no inquirer / commander: keep dev-deps tight. The argument grammar is
 * a half-dozen flags; a hand-rolled parser is well within reach and avoids
 * an extra dep that would only be used by a setup script.
 */

import pino from 'pino';

import { loadConfig, type Config } from '../../src/config/loader.js';
import {
  startCaptureServer,
  type CaptureServerHandle,
  type CapturedWebhook
} from '../lib/capture-server.js';
import {
  registerAllWebhooks,
  type RegistrationContext,
  type RegistrationSummary
} from './register-webhooks.js';
import {
  info,
  success,
  warn,
  fail,
  divider,
  waitFor,
  registerShutdown
} from '../lib/console.js';

/* ────────────────────────────────────────────────────────────────────────── */
/* Public types                                                               */
/* ────────────────────────────────────────────────────────────────────────── */

export type VerifyChannel = 'whatsapp' | 'messenger' | 'instagram';
export type VerifyTarget = VerifyChannel | 'all';

export interface ParsedArgs {
  /** Channels to verify. Defaults to all configured channels. */
  channels: VerifyChannel[];
  /** Skip the `registerAllWebhooks` call in `bootstrapVerifyContext`. */
  skipWebhookRegistration: boolean;
  /** Skip the channel-specific outbound (template/reply) test. */
  skipOutbound: boolean;
  /** Optional reserved ngrok domain (e.g. `my-stable.ngrok-free.app`). */
  ngrokDomain?: string;
  /** Local capture-server port. Defaults to `PORT` env / 3000. */
  port: number;
  /** Pass through to {@link startCaptureServer} — capture even when signature mismatches. */
  acceptInvalidSignatures: boolean;
  help: boolean;
}

export interface VerifyContext {
  /** Loaded via {@link loadConfig}. */
  config: Config;
  /** Public HTTPS webhook URL — `${tunnel.url}/webhook`. */
  callbackUrl: string;
  /** Capture-server handle. Owns the tunnel + Express server. */
  capture: CaptureServerHandle;
  /** Pino logger seeded by the script (defaults to silent for library use). */
  logger: pino.Logger;
  /** Parsed CLI args (passed through for downstream `--skip-outbound` decisions). */
  cli: ParsedArgs;
  /** Outcome of the webhook-registration step (or `undefined` when skipped). */
  registration?: RegistrationSummary;
}

export interface ChannelVerifyStep {
  /** Short human-readable step name (printed in the summary table). */
  name: string;
  status: 'pass' | 'fail' | 'skip';
  /** Optional detail surfaced under the step in the summary. */
  detail?: string;
}

export interface ChannelVerifyResult {
  channel: VerifyChannel;
  steps: ChannelVerifyStep[];
  /** True iff every step is `pass` or `skip` (no `fail`). */
  ok: boolean;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* CLI parsing                                                                */
/* ────────────────────────────────────────────────────────────────────────── */

const VALID_CHANNELS: ReadonlySet<VerifyChannel> = new Set([
  'whatsapp',
  'messenger',
  'instagram'
]);

/**
 * Pure helper exported for testability. Throws on unknown flags / invalid
 * values so the script can format a clean remediation instead of half-parsing
 * `argv` and proceeding with corrupted defaults.
 *
 * Supported flags (all optional):
 *   --channels=a,b,c            Comma-separated channels to verify.
 *   --skip-webhook-registration Don't call `registerAllWebhooks`.
 *   --skip-outbound             Don't run the outbound send-test step.
 *   --ngrok-domain=foo.app      Reserved ngrok subdomain.
 *   --port=3001                 Local port for the capture server.
 *   --accept-invalid-signatures Capture even when X-Hub-Signature-256 mismatches.
 *   --help, -h                  Print usage and exit.
 */
export function parseVerifyArgs(argv: readonly string[]): ParsedArgs {
  const flags: ParsedArgs = {
    channels: [],
    skipWebhookRegistration: false,
    skipOutbound: false,
    port: parsePortEnv(process.env['PORT']),
    acceptInvalidSignatures: false,
    help: false
  };

  for (const raw of argv) {
    if (raw === '--help' || raw === '-h') {
      flags.help = true;
      continue;
    }
    if (raw === '--skip-webhook-registration') {
      flags.skipWebhookRegistration = true;
      continue;
    }
    if (raw === '--skip-outbound') {
      flags.skipOutbound = true;
      continue;
    }
    if (raw === '--accept-invalid-signatures') {
      flags.acceptInvalidSignatures = true;
      continue;
    }
    if (raw.startsWith('--channels=')) {
      const value = raw.slice('--channels='.length).trim();
      if (value === '') {
        throw new Error('--channels requires at least one value: --channels=whatsapp[,messenger,instagram]');
      }
      const parts = value.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
      const channels: VerifyChannel[] = [];
      for (const part of parts) {
        if (!VALID_CHANNELS.has(part as VerifyChannel)) {
          throw new Error(
            `--channels: unknown channel "${part}". Valid values: whatsapp, messenger, instagram.`
          );
        }
        // De-duplicate without changing order — `--channels=whatsapp,whatsapp` is
        // almost certainly a typo, not an explicit retry-twice request.
        if (!channels.includes(part as VerifyChannel)) channels.push(part as VerifyChannel);
      }
      flags.channels = channels;
      continue;
    }
    if (raw.startsWith('--ngrok-domain=')) {
      const value = raw.slice('--ngrok-domain='.length).trim();
      if (value === '') {
        throw new Error('--ngrok-domain requires a value, e.g. --ngrok-domain=foo.ngrok-free.app');
      }
      flags.ngrokDomain = value;
      continue;
    }
    if (raw.startsWith('--port=')) {
      const value = raw.slice('--port='.length).trim();
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || String(parsed) !== value || parsed < 1 || parsed > 65535) {
        throw new Error(`--port: expected integer 1–65535 (got "${value}").`);
      }
      flags.port = parsed;
      continue;
    }
    // Refuse to silently ignore unknown flags — they're almost always typos.
    // The previous OAuth script set the same precedent.
    throw new Error(`Unknown flag: ${raw}. Run with --help for usage.`);
  }
  return flags;
}

function parsePortEnv(raw: string | undefined): number {
  if (!raw) return 3000;
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n) || n < 1 || n > 65535) return 3000;
  return n;
}

/**
 * Help text used by every verify script. The script name (e.g.
 * `verify-whatsapp`) is interpolated so the example commands print the
 * caller's actual name without each script re-defining the help body.
 */
export function printVerifyHelp(scriptName: string): void {
  process.stdout.write(
    [
      `${scriptName} — interactive end-to-end verification.`,
      '',
      'Usage:',
      `  npm run setup:${shortFromScript(scriptName)} [-- --flag ...]`,
      `  npx tsx scripts/setup/${scriptName}.ts [options]`,
      '',
      'Options:',
      '  --channels=<list>             Comma-separated channels to verify',
      '                                (whatsapp,messenger,instagram).',
      '  --skip-webhook-registration   Skip programmatic webhook subscription;',
      '                                assume it has already been done.',
      '  --skip-outbound               Skip the outbound send-test (template/reply).',
      '  --ngrok-domain=<domain>       Reserved ngrok subdomain (stable URL).',
      '  --port=<n>                    Local capture-server port. Default: $PORT or 3000.',
      '  --accept-invalid-signatures   Capture webhooks even when X-Hub-Signature-256',
      '                                does not verify. Useful when iterating on',
      '                                META_APP_SECRET config.',
      '  --help, -h                    Show this message.',
      '',
      'Environment:',
      '  META_APP_ID, META_APP_SECRET, META_VERIFY_TOKEN  — required.',
      '  NGROK_AUTHTOKEN                                  — required (free signup).',
      '  Per-channel: WHATSAPP_*, MESSENGER_*, INSTAGRAM_*.',
      '  Test endpoints: E2E_TEST_WHATSAPP_NUMBER, E2E_TEST_FACEBOOK_PSID,',
      '                  E2E_TEST_INSTAGRAM_IGSID (optional outbound smoke tests).',
      ''
    ].join('\n')
  );
}

function shortFromScript(scriptName: string): string {
  // verify-whatsapp -> whatsapp, verify-all -> all. We can't import this from
  // package.json without a fs read, and the names are stable.
  if (scriptName.startsWith('verify-')) return scriptName.slice('verify-'.length);
  return scriptName;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Bootstrap                                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Phase 0 — boot the harness:
 *  1. `loadConfig()` (with try/catch so we surface a friendly error).
 *  2. Start the capture server (which starts the ngrok tunnel internally).
 *  3. Optionally `registerAllWebhooks` with the tunnel URL.
 *  4. Install a SIGINT handler that closes capture + tunnel cleanly.
 *
 * Returns a {@link VerifyContext} the channel-specific verify functions
 * consume. On any failure the partially-initialized resources are torn down
 * before the error propagates.
 */
export async function bootstrapVerifyContext(opts: {
  channel: VerifyTarget;
  cli: ParsedArgs;
  logger?: pino.Logger;
}): Promise<VerifyContext> {
  const logger = opts.logger ?? silentLogger();

  // Step 1: config. loadConfig is strict — missing required vars throw with
  // an actionable message; we re-emit it through `fail` so the developer sees
  // a clean console line and not a stack trace.
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
    throw new VerifyBootstrapError(`Failed to load config: ${msg}`);
  }

  // Step 2: tunnel + capture server. The capture server owns the ngrok lifecycle
  // for us; one start, one close — the SIGINT handler below closes both via
  // `capture.close()`.
  let capture: CaptureServerHandle;
  try {
    capture = await startCaptureServer({
      config,
      port: opts.cli.port,
      // CLI `--ngrok-domain` overrides; otherwise `config.ngrokDomain`
      // (loaded + validated upstream) is the default. Either way a static
      // domain is always passed — see WHY-comment on `Config.ngrokDomain`.
      tunnel: { domain: opts.cli.ngrokDomain ?? config.ngrokDomain },
      acceptInvalidSignatures: opts.cli.acceptInvalidSignatures,
      logger
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(`Failed to start capture server: ${msg}`);
    info(
      'Hint: ensure NGROK_AUTHTOKEN is set (https://dashboard.ngrok.com/get-started/your-authtoken) ' +
        'and the local port is not in use.'
    );
    throw new VerifyBootstrapError(`Capture server bootstrap failed: ${msg}`);
  }
  const callbackUrl = `${capture.url}/webhook`;
  success(`Tunnel: ${capture.url}`);
  info(`Webhook callback URL: ${callbackUrl}`);

  // Register a cleanup hook with the shared shutdown registry so Ctrl-C
  // during webhook registration still tears down the tunnel cleanly. The
  // central handler in `console.ts` runs all registered hooks in parallel
  // with a hard 5s budget, then lets the event loop drain. We swallow
  // close() errors here — we'd rather exit promptly than block.
  registerShutdown(async () => {
    warn('Received shutdown signal — closing capture server + tunnel.');
    await capture.close().catch(() => undefined);
  });

  // Step 3: webhook registration. We do this BEFORE handing the context to the
  // channel-specific verifiers so the very first request the verifier triggers
  // (e.g. a test send → outbound-status webhook) is delivered to the right URL.
  let registration: RegistrationSummary | undefined;
  if (opts.cli.skipWebhookRegistration) {
    info('Skipping webhook registration (--skip-webhook-registration).');
  } else {
    divider('webhook registration');
    const regCtx: RegistrationContext = {
      config,
      callbackUrl,
      logger
    };
    try {
      registration = await registerAllWebhooks(regCtx);
      for (const r of registration.results) {
        switch (r.status) {
          case 'success':
            success(`${r.channel}: ${r.message}`);
            break;
          case 'skipped':
            info(`${r.channel} (skipped): ${r.message}`);
            break;
          case 'manual_required':
            warn(`${r.channel}: ${r.message}`);
            if (r.remediation) warn(`        ${r.remediation}`);
            break;
          case 'failed':
            fail(`${r.channel}: ${r.message}`);
            break;
        }
      }
    } catch (err) {
      // Non-fatal: a failure here usually means a wrong appId / appSecret. We
      // print the error and continue so the developer can still inspect the
      // capture server, but flag it via registration === undefined so the
      // per-channel runner can skip token-dependent checks.
      const msg = err instanceof Error ? err.message : String(err);
      fail(`Webhook registration threw: ${msg}`);
      warn('Continuing without programmatic webhook subscription. Some checks may fail.');
    }
  }

  return {
    config,
    callbackUrl,
    capture,
    logger,
    cli: opts.cli,
    ...(registration !== undefined ? { registration } : {})
  };
}

/** Thrown by `bootstrapVerifyContext` so the caller can distinguish from random errors. */
export class VerifyBootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VerifyBootstrapError';
  }
}

function silentLogger(): pino.Logger {
  return pino({ level: 'silent' });
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Capture polling helper                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

export interface CaptureExpectedOptions {
  capture: CaptureServerHandle;
  /** Channel hint used for `saveCapture` directory routing. */
  channel: VerifyChannel;
  /**
   * Predicate that classifies a {@link CapturedWebhook} as the expected event.
   * Should be cheap — it runs once per captured webhook.
   */
  expect: (cap: CapturedWebhook) => boolean;
  /** Human-readable instruction printed before polling starts. */
  prompt: string;
  /** Optional override for the spinner description. Defaults to `prompt`. */
  description?: string;
  /** Hard timeout; defaults to 5 minutes. */
  timeoutMs?: number;
  /** Optional filename for the capture written under `.captures/meta/{channel}/`. */
  saveAs?: string;
}

/**
 * Print `prompt` and block until a captured webhook matches `expect`.
 *
 * Implementation note: we subscribe to NEW captures via `onWebhook` AND scan
 * the recent buffer up front. The buffer scan covers the case where a verify
 * step's webhook is delivered before the developer reads the next prompt
 * (e.g. WhatsApp template `sent` status arrives within ~200ms of POST).
 *
 * Returns the matching capture, or `undefined` on timeout. The script's
 * caller decides whether timeout is a `fail` or a `skip` (timing depends on
 * whether the user actually performed the action).
 */
export async function captureExpectedWebhook(
  opts: CaptureExpectedOptions
): Promise<CapturedWebhook | undefined> {
  info(opts.prompt);

  // Buffer scan: catch a capture that landed BEFORE we subscribed. Without
  // this, a fast-arriving outbound `sent` event slips through.
  const existing = opts.capture.getRecentCaptures().find(opts.expect);
  if (existing) {
    return finalizeCapture(opts, existing);
  }

  let found: CapturedWebhook | undefined;
  const unsubscribe = opts.capture.onWebhook((cap) => {
    if (found !== undefined) return;
    try {
      if (opts.expect(cap)) found = cap;
    } catch {
      // A buggy predicate shouldn't crash the verify loop. Treat throws as
      // "not a match" and keep polling.
    }
  });

  try {
    const description = opts.description ?? `waiting for ${opts.channel} webhook`;
    const result = await waitFor<CapturedWebhook | undefined>(
      description,
      async () => (found !== undefined ? found : undefined),
      { timeoutMs: opts.timeoutMs ?? 5 * 60 * 1000 }
    ).catch(() => undefined);
    if (result) return finalizeCapture(opts, result);
    return undefined;
  } finally {
    unsubscribe();
  }
}

async function finalizeCapture(
  opts: CaptureExpectedOptions,
  cap: CapturedWebhook
): Promise<CapturedWebhook> {
  if (opts.saveAs) {
    try {
      const filePath = await opts.capture.saveCapture(cap, { filename: opts.saveAs });
      success(`Captured ${opts.channel} webhook → ${filePath}`);
    } catch (err) {
      // Save failures (disk full, perms) should not block the verify flow —
      // the capture is still in memory and the developer can re-save manually.
      const msg = err instanceof Error ? err.message : String(err);
      warn(`Captured webhook but failed to write file: ${msg}`);
    }
  } else {
    success(`Captured ${opts.channel} webhook (${cap.parsed.messages.length} msg, ${cap.parsed.statuses.length} status).`);
  }
  return cap;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Predicates                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * True if `cap` contains an inbound text message from the given channel and the
 * outer envelope's `object` field matches the channel hint. The predicates
 * live here (exported) so unit tests can verify them against the fixture corpus
 * without booting a capture server.
 *
 * "Inbound" here means `type === 'text'` and `isEcho` is not true — an echo
 * is the business side's own outbound being mirrored back, which is NOT what
 * the verify scripts are waiting for during the "send a message" step.
 */
export function isInboundTextMessage(cap: CapturedWebhook, channel: VerifyChannel): boolean {
  if (cap.channelHint !== channel) return false;
  for (const msg of cap.parsed.messages) {
    if (msg.channel !== channel) continue;
    if (msg.type !== 'text') continue;
    if (msg.isEcho === true) continue;
    if (typeof msg.text === 'string' && msg.text.length > 0) return true;
  }
  return false;
}

/**
 * True if `cap` contains an inbound reaction event. WhatsApp emits `reaction`
 * as a top-level message type; Messenger/IG emit it via `messaging[].reaction`.
 * The parser normalizes both into `IncomingMessage.type === 'reaction'`.
 */
export function isInboundReaction(cap: CapturedWebhook, channel: VerifyChannel): boolean {
  if (cap.channelHint !== channel) return false;
  for (const msg of cap.parsed.messages) {
    if (msg.channel !== channel) continue;
    if (msg.type === 'reaction' && msg.isEcho !== true) return true;
  }
  return false;
}

/**
 * True if `cap` contains an outbound delivery-status update — i.e. confirmation
 * that the business's just-sent message reached Meta's edge. Used by the
 * "send test template / send test reply" step to confirm round-trip wiring.
 *
 * WhatsApp produces `sent`, `delivered`, `read` for outbound; Messenger/IG
 * produce `delivered` / `read` via watermark. We treat any of those as success.
 */
export function isOutboundStatus(cap: CapturedWebhook, channel: VerifyChannel): boolean {
  if (cap.channelHint !== channel) return false;
  for (const status of cap.parsed.statuses) {
    if (status.channel !== channel) continue;
    if (status.status === 'sent' || status.status === 'delivered' || status.status === 'read') {
      return true;
    }
  }
  return false;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Summary                                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

const ANSI = {
  reset: '[0m',
  bold: '[1m',
  dim: '[2m',
  green: '[32m',
  yellow: '[33m',
  red: '[31m',
  cyan: '[36m'
} as const;

function isTTY(): boolean {
  return process.stdout.isTTY === true;
}

function colorize(code: string, text: string): string {
  if (!isTTY()) return text;
  return `${code}${text}${ANSI.reset}`;
}

/**
 * Render a sequence of {@link ChannelVerifyResult} as a human-readable
 * status table. Exported for testability — tests can capture stdout and
 * assert the summary contains the expected step labels regardless of
 * ANSI coloring (TTY detection is mocked off in unit tests).
 */
export function printVerifySummary(results: readonly ChannelVerifyResult[]): void {
  divider('verification summary');
  for (const result of results) {
    const headerLabel = result.channel.toUpperCase();
    const verdict = result.ok ? colorize(ANSI.green, 'PASS') : colorize(ANSI.red, 'FAIL');
    process.stdout.write(`${colorize(ANSI.bold, headerLabel)}  ${verdict}\n`);
    for (const step of result.steps) {
      const icon = stepIcon(step.status);
      const detail = step.detail ? `  ${colorize(ANSI.dim, '— ' + step.detail)}` : '';
      process.stdout.write(`  ${icon} ${step.name}${detail}\n`);
    }
    process.stdout.write('\n');
  }
  const overall = results.every((r) => r.ok);
  if (overall) {
    process.stdout.write(`${colorize(ANSI.green, '✓')} All channels verified.\n`);
  } else {
    process.stdout.write(`${colorize(ANSI.red, '✗')} One or more channels failed. See details above.\n`);
  }
}

function stepIcon(status: ChannelVerifyStep['status']): string {
  switch (status) {
    case 'pass':
      return colorize(ANSI.green, '✓');
    case 'fail':
      return colorize(ANSI.red, '✗');
    case 'skip':
      return colorize(ANSI.yellow, '○');
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Step recording                                                             */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Tiny builder used by the verify scripts to accumulate steps. We don't want
 * each script to repeat the `result.steps.push({ name, status, detail })`
 * incantation — and the builder makes it natural to chain a `step.pass()` /
 * `step.fail(detail)` call inside the per-step try/catch.
 */
export class VerifyResultBuilder {
  readonly channel: VerifyChannel;
  private readonly steps: ChannelVerifyStep[] = [];

  constructor(channel: VerifyChannel) {
    this.channel = channel;
  }

  pass(name: string, detail?: string): void {
    this.steps.push({ name, status: 'pass', ...(detail !== undefined ? { detail } : {}) });
  }

  fail(name: string, detail?: string): void {
    this.steps.push({ name, status: 'fail', ...(detail !== undefined ? { detail } : {}) });
  }

  skip(name: string, detail?: string): void {
    this.steps.push({ name, status: 'skip', ...(detail !== undefined ? { detail } : {}) });
  }

  build(): ChannelVerifyResult {
    return {
      channel: this.channel,
      steps: this.steps.slice(),
      ok: this.steps.every((s) => s.status !== 'fail')
    };
  }
}
