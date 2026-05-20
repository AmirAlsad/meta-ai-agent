/**
 * Stage 3 — interactive scenario-driven capture walker.
 *
 * Boots the same Express + ngrok capture surface as `fixture-capture.ts` but
 * adds a human-in-the-loop driver: prints a per-scenario prompt, waits for a
 * webhook matching that scenario's predicate, saves it with the scenario name
 * baked into the filename + payload wrapper, and moves on.
 *
 * The output of this script is the raw material for `tests/fixtures/captured/`:
 * a labeled corpus of real Meta payloads, one per documented user gesture.
 *
 * WHY mount our own capture server (via `startCaptureServer`) instead of
 * reusing the production `createApp`:
 *  - The production app dispatches to the conversation agent, which we do
 *    NOT want during capture (no chat calls, no outbound replies).
 *  - `startCaptureServer` exposes `onWebhook` subscriptions and a recent-
 *    captures buffer, both of which the scenario walker needs to wait for
 *    the next matching payload without polling Express internals.
 *  - We still get production-equivalent signature verification at the door,
 *    so an app-secret mismatch fails fast just like Stage 5 would.
 *
 * WHY the scenario annotation wrapper:
 *  Captures are written as `{ _scenario, _capturedAt, _channel,
 *  _signatureValid, rawBody }`. The `rawBody` field is BIT-FAITHFUL — it's
 *  what Meta posted, untouched, so promoting a capture into
 *  `tests/fixtures/captured/` is just "rename + redact the `rawBody`
 *  sub-object". The `_*` siblings make captures self-describing: at a
 *  glance you can tell which scenario produced a file without grepping the
 *  filename.
 *
 * WHY `skip` is offered per scenario:
 *  Meta's UI varies per app role / platform version. Reaction support, in
 *  particular, has historically been gated on individual accounts. If a
 *  developer can't reproduce a scenario in their test rig, blocking the
 *  whole walker would be hostile — `skip` lets them advance and capture
 *  the rest of the corpus.
 *
 * WHY `process.exitCode = N; return;` rather than `process.exit(N)`: same
 * reason as `fixture-capture.ts` — we hold tunnel + server handles and want
 * the `finally` cleanup to run.
 */
import 'dotenv/config';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import pino from 'pino';

import { loadConfig, type Config } from '../../src/config/loader.js';
import { startTunnel, type ActiveTunnel } from '../lib/tunnel.js';
import {
  startCaptureServer,
  type CaptureServerHandle,
  type CapturedWebhook
} from '../lib/capture-server.js';
import { registerAllWebhooks } from '../setup/register-webhooks.js';
import {
  getInstagramUser,
  type GraphConfig
} from '../lib/graph-api.js';
import {
  info,
  success,
  warn,
  fail,
  step,
  divider,
  ask,
  closePrompts,
  registerShutdown
} from '../lib/console.js';
import type { Channel } from '../../src/meta/types.js';

/* ────────────────────────────────────────────────────────────────────────── */
/* Scenario definitions                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

export interface CaptureScenario {
  name: string;
  /** Human-readable instruction shown when the scenario activates. */
  prompt: string;
  /** Predicate run against every incoming capture; first match wins. */
  predicate: (cap: CapturedWebhook) => boolean;
}

/**
 * WhatsApp scenarios. Order matters — the walker advances strictly in
 * sequence so the user knows which prompt is active. Predicates are kept
 * cheap (no async, no I/O) so the runner can score each new capture in O(1).
 */
export const WHATSAPP_SCENARIOS: readonly CaptureScenario[] = Object.freeze([
  {
    name: 'text',
    prompt: 'Send a text message to your WhatsApp business number from a personal account.',
    predicate: (cap: CapturedWebhook): boolean =>
      cap.channelHint === 'whatsapp' && cap.parsed.messages.some((m) => m.type === 'text')
  },
  {
    name: 'image',
    prompt: 'Send an image to your WhatsApp business number.',
    predicate: (cap: CapturedWebhook): boolean =>
      cap.channelHint === 'whatsapp' && cap.parsed.messages.some((m) => m.type === 'image')
  },
  {
    name: 'audio-voice',
    prompt: 'Send a voice message (hold the mic button) to your WhatsApp business number.',
    predicate: (cap: CapturedWebhook): boolean =>
      cap.channelHint === 'whatsapp' && cap.parsed.messages.some((m) => m.type === 'audio')
  },
  {
    name: 'reaction',
    prompt: 'React to ANY message in the WhatsApp thread with a 👍.',
    predicate: (cap: CapturedWebhook): boolean =>
      cap.channelHint === 'whatsapp' && cap.parsed.messages.some((m) => m.type === 'reaction')
  },
  {
    name: 'reply-to',
    prompt: 'Long-press a message in the WhatsApp thread and reply to it.',
    predicate: (cap: CapturedWebhook): boolean =>
      cap.channelHint === 'whatsapp' && cap.parsed.messages.some((m) => m.replyTo !== undefined)
  },
  {
    name: 'status-read',
    prompt: 'Open the WhatsApp thread and read any unread bot message (to trigger a read status).',
    predicate: (cap: CapturedWebhook): boolean =>
      cap.channelHint === 'whatsapp' && cap.parsed.statuses.some((s) => s.status === 'read')
  }
] as const);

/** Messenger scenarios — see {@link WHATSAPP_SCENARIOS} for rationale. */
export const MESSENGER_SCENARIOS: readonly CaptureScenario[] = Object.freeze([
  {
    name: 'text',
    prompt: 'Send a text message from a personal Facebook account to your Page.',
    predicate: (cap: CapturedWebhook): boolean =>
      cap.channelHint === 'messenger' && cap.parsed.messages.some((m) => m.type === 'text')
  },
  {
    name: 'image',
    prompt: 'Send an image (attachment) to your Page.',
    predicate: (cap: CapturedWebhook): boolean =>
      cap.channelHint === 'messenger' && cap.parsed.messages.some((m) => m.type === 'image')
  },
  {
    name: 'reaction',
    prompt: 'React to ANY message in the Messenger thread with a 👍.',
    predicate: (cap: CapturedWebhook): boolean =>
      cap.channelHint === 'messenger' && cap.parsed.messages.some((m) => m.type === 'reaction')
  },
  {
    name: 'read',
    prompt: 'Open the Messenger thread on the personal account; mark all as read.',
    predicate: (cap: CapturedWebhook): boolean =>
      cap.channelHint === 'messenger' && cap.parsed.statuses.some((s) => s.status === 'read')
  }
] as const);

/**
 * Instagram scenarios. The `text-dm` prompt is built dynamically at runtime
 * so we can inject the live `@username` resolved from `getInstagramUser`.
 * `{username}` placeholder in the static list is the post-template fallback.
 */
export const INSTAGRAM_SCENARIOS: readonly CaptureScenario[] = Object.freeze([
  {
    name: 'text-dm',
    prompt: 'Send a DM from a personal IG account to @{username}.',
    predicate: (cap: CapturedWebhook): boolean =>
      cap.channelHint === 'instagram' && cap.parsed.messages.some((m) => m.type === 'text')
  },
  {
    name: 'story-reply',
    prompt: 'Reply to a story posted by your business IG account (from a personal account).',
    predicate: (cap: CapturedWebhook): boolean =>
      cap.channelHint === 'instagram' && cap.parsed.messages.some((m) => m.storyReply !== undefined)
  },
  {
    name: 'image',
    prompt: 'Send an image DM.',
    predicate: (cap: CapturedWebhook): boolean =>
      cap.channelHint === 'instagram' && cap.parsed.messages.some((m) => m.type === 'image')
  },
  {
    name: 'reaction',
    prompt: 'React to ANY message in the IG DM thread.',
    predicate: (cap: CapturedWebhook): boolean =>
      cap.channelHint === 'instagram' && cap.parsed.messages.some((m) => m.type === 'reaction')
  }
] as const);

/** Channel-keyed scenario registry. Exported so tests can iterate it. */
export const SCENARIOS_BY_CHANNEL: Record<Channel, readonly CaptureScenario[]> = {
  whatsapp: WHATSAPP_SCENARIOS,
  messenger: MESSENGER_SCENARIOS,
  instagram: INSTAGRAM_SCENARIOS
};

/* ────────────────────────────────────────────────────────────────────────── */
/* Capture wrapper                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Self-describing wrapper around a captured payload. Designed so that
 * promoting a capture into `tests/fixtures/captured/` is a manual step of:
 *   1. Read the file. The `_*` annotations tell you what the scenario was.
 *   2. Redact `rawBody` (phone numbers, names, message content).
 *   3. Drop the file (or just the `rawBody`) into `tests/fixtures/captured/`.
 *
 * Keeping the annotations as SIBLINGS of `rawBody` — never folded into the
 * body — means the body remains a bit-faithful copy of what Meta posted.
 */
export interface ScenarioCaptureWrapper {
  _scenario: string;
  _capturedAt: string;
  _channel: 'whatsapp' | 'messenger' | 'instagram' | 'unknown';
  _signatureValid: boolean;
  rawBody: unknown;
}

/** Build the wrapped JSON written to disk for a scenario capture. */
export function wrapForScenario(cap: CapturedWebhook, scenario: string): ScenarioCaptureWrapper {
  return {
    _scenario: scenario,
    _capturedAt: new Date(cap.receivedAt).toISOString(),
    _channel: cap.channelHint,
    _signatureValid: cap.signatureValid,
    rawBody: cap.rawBody
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* CLI flags                                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

export type ChannelOrAll = Channel | 'all';

export interface GuidedCaptureFlags {
  help: boolean;
  channel: ChannelOrAll | undefined;
  scenarios: string[] | undefined;
  port: number | undefined;
  ngrokDomain: string | undefined;
  noWebhookRegistration: boolean;
}

export function parseFlags(argv: readonly string[]): GuidedCaptureFlags {
  const flags: GuidedCaptureFlags = {
    help: false,
    channel: undefined,
    scenarios: undefined,
    port: undefined,
    ngrokDomain: undefined,
    noWebhookRegistration: false
  };
  for (const raw of argv) {
    if (raw === '--help' || raw === '-h') {
      flags.help = true;
      continue;
    }
    if (raw === '--no-webhook-registration') {
      flags.noWebhookRegistration = true;
      continue;
    }
    if (raw.startsWith('--channel=')) {
      const v = raw.slice('--channel='.length);
      if (v !== 'whatsapp' && v !== 'messenger' && v !== 'instagram' && v !== 'all') {
        throw new Error(`Invalid --channel=${v}: expected whatsapp|messenger|instagram|all.`);
      }
      flags.channel = v;
      continue;
    }
    if (raw.startsWith('--scenarios=')) {
      const v = raw.slice('--scenarios='.length);
      flags.scenarios = v
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '');
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
    throw new Error(`Unknown flag: ${raw}. Run with --help for usage.`);
  }
  return flags;
}

const HELP_TEXT = `
guided-capture — Interactive scenario-driven Meta webhook capture.

Walks the user through a checklist of channel-specific user gestures
(send text, react, reply, etc.) and saves the matching webhook payload
under .captures/meta/{channel}/{ts}-{scenario}.json. Captures are
self-describing — see the _scenario / _capturedAt / _channel fields.

Usage:
  npm run capture:guided [-- --flag ...]
  npx tsx scripts/capture/guided-capture.ts [options]

Options:
  --channel=<x>                whatsapp | messenger | instagram | all.
                               If omitted, you'll be prompted.
  --scenarios=<a,b,c>          Run only these scenarios (by name). Default: all
                               scenarios for the chosen channel.
  --port=<n>                   Local listener port. Default: config.port (3000).
  --ngrok-domain=<x>           Reserved ngrok subdomain.
  --no-webhook-registration    Skip the Meta webhook subscription POST.
  --help, -h                   Show this message.

Environment:
  See README. Required at minimum: META_APP_ID, META_APP_SECRET,
  META_VERIFY_TOKEN, CHAT_ENDPOINT_URL, NGROK_AUTHTOKEN, and the per-channel
  credentials for the channels you intend to capture.

Output safety:
  Captures may contain phone numbers, names, message content, and tokens.
  Redact before promoting to tests/fixtures/captured/.
`.trim();

/* ────────────────────────────────────────────────────────────────────────── */
/* Scenario runner                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

interface RunChannelOptions {
  channel: Channel;
  scenarios: readonly CaptureScenario[];
  capture: CaptureServerHandle;
  capturesDir: string;
  /** Per-scenario wait timeout. Default 5 min. */
  timeoutMs?: number;
}

interface ScenarioResult {
  channel: Channel;
  scenario: string;
  outcome: 'captured' | 'skipped' | 'timed-out-skipped';
  filePath?: string;
}

/**
 * Walk one channel's scenarios. Pops captures off a queue fed by an
 * `onWebhook` subscriber. A side-channel readline prompt lets the user
 * `skip` while the spinner is waiting (we can't reuse `console.waitFor`
 * because it doesn't interleave with stdin).
 */
async function runChannel(opts: RunChannelOptions): Promise<ScenarioResult[]> {
  const { channel, scenarios, capture, capturesDir } = opts;
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
  const results: ScenarioResult[] = [];

  // Queue of incoming captures NOT YET MATCHED to a scenario. The walker
  // pulls from this in scenario order — see `popFirstMatching`.
  const queue: CapturedWebhook[] = [];
  let waiter: (() => void) | undefined;
  const unsubscribe = capture.onWebhook((cap) => {
    queue.push(cap);
    if (waiter) {
      const w = waiter;
      waiter = undefined;
      w();
    }
  });

  divider(`channel: ${channel}`);

  for (const [i, scenario] of scenarios.entries()) {
    step(i + 1, scenarios.length, `${scenario.name}`);
    info(scenario.prompt);
    info(`Type "skip" + Enter to skip this scenario.`);

    // Race: scenario-match wins, skip-input wins, or 5min timeout wins.
    const match = await waitForScenario({
      scenario,
      queue,
      register: (cb) => {
        waiter = cb;
        // Unregister hook so multiple races don't trip over each other.
        return () => {
          if (waiter === cb) waiter = undefined;
        };
      },
      timeoutMs
    });

    if (match.kind === 'matched') {
      const wrapped = wrapForScenario(match.cap, scenario.name);
      const ts = new Date(match.cap.receivedAt).toISOString().replace(/[:.]/g, '-');
      const filename = `${ts}-${sanitizeSegment(scenario.name)}.json`;
      // We hand-write the wrapped JSON instead of `capture.saveCapture(cap)`
      // because we want the `_scenario`/`_capturedAt`/`_channel` annotations
      // around the raw body — the server-side `saveCapture` would emit the
      // FULL `CapturedWebhook` shape (with parsed result, headers, etc.)
      // which is great for debugging but not what we want as a fixture.
      const filePath = await writeWrapped({
        capturesDir,
        channel,
        filename,
        wrapped
      });
      results.push({ channel, scenario: scenario.name, outcome: 'captured', filePath });
      success(`Captured: ${filePath}`);
    } else if (match.kind === 'skipped') {
      warn(`Skipped: ${scenario.name}`);
      results.push({ channel, scenario: scenario.name, outcome: 'skipped' });
    } else {
      // Timeout — offer one retry/skip choice rather than silently skipping.
      warn(`Timed out waiting for ${scenario.name}.`);
      const answer = (await ask('Type "retry" to try again or anything else to skip:')).toLowerCase();
      if (answer === 'retry' || answer === 'r') {
        // One retry — re-run this iteration. Simplest implementation: just
        // decrement i by reusing the loop body via recursion-of-one. We
        // implement it linearly by pushing the scenario back onto a
        // single-slot retry buffer.
        const retryResult = await retryOnce({
          scenario,
          queue,
          register: (cb) => {
            waiter = cb;
            return () => {
              if (waiter === cb) waiter = undefined;
            };
          },
          timeoutMs,
          capturesDir,
          channel
        });
        results.push(retryResult);
      } else {
        results.push({ channel, scenario: scenario.name, outcome: 'timed-out-skipped' });
      }
    }
  }

  unsubscribe();
  return results;
}

interface WaitForScenarioArgs {
  scenario: CaptureScenario;
  queue: CapturedWebhook[];
  /** Register a callback that fires once a new capture enters the queue. */
  register: (cb: () => void) => () => void;
  timeoutMs: number;
}

type WaitResult =
  | { kind: 'matched'; cap: CapturedWebhook }
  | { kind: 'skipped' }
  | { kind: 'timeout' };

async function waitForScenario(args: WaitForScenarioArgs): Promise<WaitResult> {
  // Drain the queue first — a previous scenario's wait may have left
  // unrelated captures buffered.
  const drainMatch = popFirstMatching(args.queue, args.scenario.predicate);
  if (drainMatch !== undefined) return { kind: 'matched', cap: drainMatch };

  // Race: scenario-match (poll queue on each `register` notification) vs.
  // skip-input vs. timeout.
  const skipPromise = readSkipInput();
  const deadlineMs = Date.now() + args.timeoutMs;

  for (;;) {
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) {
      // Best-effort: cancel the skip listener so it doesn't hold stdin.
      skipPromise.cancel();
      return { kind: 'timeout' };
    }

    const newDelivery = new Promise<'delivery'>((resolve) => {
      const unsub = args.register(() => {
        unsub();
        resolve('delivery');
      });
    });
    const timeout = new Promise<'timeout'>((resolve) => {
      const t = setTimeout(() => resolve('timeout'), remaining);
      t.unref();
    });

    const winner = await Promise.race([newDelivery, skipPromise.promise, timeout]);
    if (winner === 'skip') {
      return { kind: 'skipped' };
    }
    if (winner === 'timeout') {
      skipPromise.cancel();
      return { kind: 'timeout' };
    }
    // Otherwise: at least one new capture has arrived — try to match.
    const m = popFirstMatching(args.queue, args.scenario.predicate);
    if (m !== undefined) {
      skipPromise.cancel();
      return { kind: 'matched', cap: m };
    }
    // Not a match — keep waiting. The unmatched capture stays popped off
    // the queue (it doesn't belong to this scenario; future scenarios
    // wouldn't want it either since predicates are per-channel + per-type).
  }
}

interface RetryArgs extends Omit<WaitForScenarioArgs, 'scenario'> {
  scenario: CaptureScenario;
  capturesDir: string;
  channel: Channel;
}

async function retryOnce(args: RetryArgs): Promise<ScenarioResult> {
  info(`Retrying: ${args.scenario.name}`);
  info(args.scenario.prompt);
  info('Type "skip" + Enter to give up on this scenario.');
  const result = await waitForScenario({
    scenario: args.scenario,
    queue: args.queue,
    register: args.register,
    timeoutMs: args.timeoutMs
  });
  if (result.kind === 'matched') {
    const wrapped = wrapForScenario(result.cap, args.scenario.name);
    const ts = new Date(result.cap.receivedAt).toISOString().replace(/[:.]/g, '-');
    const filename = `${ts}-${sanitizeSegment(args.scenario.name)}.json`;
    const filePath = await writeWrapped({
      capturesDir: args.capturesDir,
      channel: args.channel,
      filename,
      wrapped
    });
    success(`Captured: ${filePath}`);
    return { channel: args.channel, scenario: args.scenario.name, outcome: 'captured', filePath };
  }
  if (result.kind === 'skipped') {
    warn(`Skipped: ${args.scenario.name}`);
    return { channel: args.channel, scenario: args.scenario.name, outcome: 'skipped' };
  }
  warn(`Timed out again on ${args.scenario.name}; moving on.`);
  return { channel: args.channel, scenario: args.scenario.name, outcome: 'timed-out-skipped' };
}

/**
 * Pop the first capture in the queue that matches the predicate. Mutates
 * the queue in place — the matched capture is `splice`d out and returned;
 * NON-MATCHING captures are RETAINED in the queue so a later scenario
 * (with a different predicate) can still consume them.
 *
 * Why retain unmatched: a single human-driven walker advances one scenario
 * at a time but the developer may perform gestures out of order (e.g. send
 * an image before being prompted, then go back and send the queued text).
 * The retained-buffer behavior lets us pick those up rather than silently
 * dropping them. The in-memory queue is small (we pull at human-scale
 * cadence) so unbounded growth isn't a concern in practice.
 */
function popFirstMatching(
  queue: CapturedWebhook[],
  predicate: (cap: CapturedWebhook) => boolean
): CapturedWebhook | undefined {
  for (let i = 0; i < queue.length; i++) {
    if (predicate(queue[i]!)) {
      const [match] = queue.splice(i, 1);
      return match;
    }
  }
  return undefined;
}

interface SkipPromise {
  promise: Promise<'skip'>;
  cancel(): void;
}

/**
 * Open a small readline reader to capture a `skip` keystroke without
 * blocking the spinner. We can't share the global `console.ts` readline
 * because that one is request-response shaped and would steal the user's
 * Enter when they're typing a regular `skip` mid-scenario.
 */
function readSkipInput(): SkipPromise {
  let cancelled = false;
  let rl: readline.Interface | undefined;
  const promise = new Promise<'skip'>((resolve) => {
    rl = readline.createInterface({ input, output });
    const onLine = (line: string): void => {
      if (cancelled) return;
      const trimmed = line.trim().toLowerCase();
      if (trimmed === 'skip' || trimmed === 's') {
        cancelled = true;
        rl?.close();
        resolve('skip');
      }
      // Any other input is ignored — keep listening.
    };
    rl.on('line', onLine);
  });
  return {
    promise,
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      try {
        rl?.close();
      } catch {
        /* no-op */
      }
    }
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* File writing                                                               */
/* ────────────────────────────────────────────────────────────────────────── */

interface WriteWrappedArgs {
  capturesDir: string;
  channel: Channel;
  filename: string;
  wrapped: ScenarioCaptureWrapper;
}

async function writeWrapped(args: WriteWrappedArgs): Promise<string> {
  const { mkdir, writeFile, access } = await import('node:fs/promises');
  const { constants: fsConstants } = await import('node:fs');
  const channelDir = path.resolve(args.capturesDir, args.channel);
  await mkdir(channelDir, { recursive: true });
  const filePath = await firstAvailablePath(channelDir, args.filename, access, fsConstants.F_OK);
  await writeFile(filePath, `${JSON.stringify(args.wrapped, null, 2)}\n`, { mode: 0o600 });
  return filePath;
}

/** Resolve `dir/name`, appending `-1`, `-2`, … if the candidate already exists. */
async function firstAvailablePath(
  dir: string,
  name: string,
  access: (p: string, mode: number) => Promise<void>,
  mode: number
): Promise<string> {
  const ext = path.extname(name);
  const stem = ext.length > 0 ? name.slice(0, -ext.length) : name;
  const fallbackExt = ext.length > 0 ? ext : '.json';
  let candidate = path.join(dir, `${stem}${fallbackExt}`);
  let attempt = 0;
  for (;;) {
    try {
      await access(candidate, mode);
    } catch {
      return candidate;
    }
    attempt += 1;
    candidate = path.join(dir, `${stem}-${attempt}${fallbackExt}`);
    if (attempt > 9999) {
      throw new Error(`Unable to find an unused filename under ${dir} for ${name}`);
    }
  }
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-') || 'webhook';
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Helpers                                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Build the scenario list for the chosen channel + filter, substituting the
 * Instagram `{username}` placeholder when we have a live IG username.
 */
function buildScenarios(
  channel: Channel,
  filter: string[] | undefined,
  igUsername: string | undefined
): readonly CaptureScenario[] {
  const all = SCENARIOS_BY_CHANNEL[channel].map((s) => {
    if (channel === 'instagram' && s.name === 'text-dm' && igUsername !== undefined) {
      return { ...s, prompt: s.prompt.replace('{username}', igUsername) };
    }
    return s;
  });
  if (filter === undefined) return all;
  const byName = new Map(all.map((s) => [s.name, s]));
  const out: CaptureScenario[] = [];
  for (const name of filter) {
    const found = byName.get(name);
    if (!found) {
      throw new Error(
        `Unknown scenario "${name}" for ${channel}. Available: ${all.map((s) => s.name).join(', ')}.`
      );
    }
    out.push(found);
  }
  return out;
}

function summarize(results: ScenarioResult[]): void {
  divider('summary');
  let captured = 0;
  let skipped = 0;
  for (const r of results) {
    const tag = r.channel.toUpperCase();
    if (r.outcome === 'captured') {
      captured += 1;
      info(`  ✓ ${tag} ${r.scenario} → ${r.filePath}`);
    } else {
      skipped += 1;
      info(`  · ${tag} ${r.scenario} → ${r.outcome}`);
    }
  }
  divider();
  if (captured > 0) success(`Captured ${captured} scenario${captured === 1 ? '' : 's'}.`);
  if (skipped > 0) warn(`Skipped ${skipped} scenario${skipped === 1 ? '' : 's'}.`);
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Main                                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  let flags: GuidedCaptureFlags;
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

  divider('meta-ai-agent: guided capture');

  // Load config first so we can validate channel choices against what's
  // actually configured.
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

  // Choose channel — flag wins, else prompt.
  let channel: ChannelOrAll;
  if (flags.channel !== undefined) {
    channel = flags.channel;
  } else {
    const configured: Channel[] = [];
    if (config.channels.whatsapp) configured.push('whatsapp');
    if (config.channels.messenger) configured.push('messenger');
    if (config.channels.instagram) configured.push('instagram');
    info(`Configured channels: ${configured.join(', ') || '(none)'}`);
    const answer = (
      await ask('Which channel? [whatsapp|messenger|instagram|all]', configured[0] ?? 'whatsapp')
    ).toLowerCase();
    if (answer !== 'whatsapp' && answer !== 'messenger' && answer !== 'instagram' && answer !== 'all') {
      fail(`Invalid channel "${answer}". Expected whatsapp|messenger|instagram|all.`);
      process.exitCode = 2;
      return;
    }
    channel = answer;
  }

  const channelsToRun: Channel[] =
    channel === 'all' ? (['whatsapp', 'messenger', 'instagram'] as const).slice() : [channel];

  // Confirm each requested channel is configured. Friendly remediation for
  // anything missing — "run npm run setup:<channel> first".
  for (const c of channelsToRun) {
    if (!config.channels[c]) {
      fail(`${c} is not configured. Run \`npm run setup:${c}\` first (or add ${envHintFor(c)} to .env).`);
      process.exitCode = 1;
      return;
    }
  }

  const port = flags.port ?? config.port;
  const capturesDir = path.resolve(process.cwd(), '.captures/meta');

  warn(
    '**Captures may contain phone numbers, names, message content, and tokens. ' +
      'Redact before promoting to `tests/fixtures/captured/`.**'
  );

  // ── Optionally resolve the live Instagram username so the text-dm prompt
  // tells the user the exact account to DM. Best-effort: if the lookup
  // fails (token expired, network), fall back to the `{username}` placeholder.
  let igUsername: string | undefined;
  if (channelsToRun.includes('instagram') && config.instagram) {
    try {
      const igConfig: GraphConfig = { apiVersion: config.meta.graphApiVersion };
      const user = await getInstagramUser(config.instagram.accessToken, igConfig);
      if (typeof user.username === 'string' && user.username.length > 0) {
        igUsername = user.username;
        info(`Resolved Instagram username: @${igUsername}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warn(`Could not resolve Instagram username: ${msg}. Prompt will show {username} placeholder.`);
    }
  }

  // ── Boot tunnel + capture server. Same pattern as fixture-capture: build
  // the tunnel here so the same URL can be reused for webhook registration.
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
      // Guided capture defaults to strict signature mode — the user is
      // mid-iteration on their app config and a 401 here helps them notice
      // a typo, vs. silently capturing garbage payloads.
      acceptInvalidSignatures: false,
      tunnelOverride: { url: tunnel.url, close: () => tunnel!.close() }
    });

    // Route Ctrl-C / SIGTERM through the central shutdown registry so the
    // capture handle is closed cleanly (ngrok tunnel released). The
    // `finally` block also closes the handle for the normal-exit path; the
    // registered hook is the safety net for signal-driven exits.
    registerShutdown(async () => {
      try {
        await capture?.close();
      } catch {
        /* tunnel.close runs via tunnelOverride; swallow */
      }
    });

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
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warn(`Webhook registration threw: ${msg}. Continuing — you can register manually later.`);
      }
    } else {
      info('Skipping webhook registration (--no-webhook-registration).');
    }

    info(`Public URL: ${tunnel.url}`);
    info(`Saving captures to: ${capturesDir}`);

    const allResults: ScenarioResult[] = [];
    for (const c of channelsToRun) {
      let scenarios: readonly CaptureScenario[];
      try {
        scenarios = buildScenarios(c, flags.scenarios, igUsername);
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
        process.exitCode = 2;
        return;
      }
      if (scenarios.length === 0) {
        warn(`No scenarios selected for ${c}. Skipping.`);
        continue;
      }
      const results = await runChannel({
        channel: c,
        scenarios,
        capture,
        capturesDir
      });
      allResults.push(...results);
    }

    summarize(allResults);
  } finally {
    closePrompts();
    info('Shutting down…');
    if (capture) {
      try {
        await capture.close();
      } catch {
        /* swallowed — tunnel.close runs via tunnelOverride */
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

function envHintFor(c: Channel): string {
  switch (c) {
    case 'whatsapp':
      return 'WHATSAPP_PHONE_NUMBER_ID + WHATSAPP_ACCESS_TOKEN';
    case 'messenger':
      return 'MESSENGER_PAGE_ID + MESSENGER_PAGE_ACCESS_TOKEN';
    case 'instagram':
      return 'INSTAGRAM_USER_ID + INSTAGRAM_ACCESS_TOKEN';
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* CLI entry point                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

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
