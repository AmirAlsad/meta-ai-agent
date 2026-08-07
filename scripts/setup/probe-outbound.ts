/**
 * One-shot OUTBOUND PROBE diagnostic.
 *
 * Fires each Stage-4 outbound send method (WhatsApp / Messenger / Instagram)
 * against the founder's E2E test recipients and reports EXACTLY what the live
 * Meta Graph API accepts or rejects — so the developer can confirm the send
 * request bodies are correct before building more on top of them. Several
 * bodies were doc-verified but not live-verified (the WhatsApp combined
 * typing+read call, the `sender_action:"react"/"unreact"` reaction shape, IG
 * `mark_seen` / `reply_to.mid`); this probe is how you live-verify them.
 *
 * It deliberately REUSES the real per-channel clients ({@link WhatsAppClient} /
 * {@link MessengerClient} / {@link InstagramClient}) over the shared
 * {@link GraphClient} so it exercises the EXACT body-building code path that
 * production uses — it does not reimplement any send logic.
 *
 * THE 24-HOUR WINDOW CAVEAT (read this before interpreting results):
 *   Free-form sends — `sendText`, reactions, typing/read on Messenger/IG, and
 *   WhatsApp free-form text — require an OPEN 24-hour messaging window, i.e. the
 *   user must have messaged the bot within the last 24h. If the founder has NOT
 *   messaged the bot recently, expect window-closed REJECTIONS. That is a REAL
 *   API result, not a code bug. The WhatsApp `hello_world` TEMPLATE is the one
 *   window-INDEPENDENT baseline — it proves the token + phone-number id are good
 *   even when the window is closed, which is why it always runs first.
 *
 * Modes:
 *   - real (default): sends REAL messages to the founder's devices after a
 *     confirm prompt (skippable with --yes). This is expected — the prompt and
 *     --dry-run guard against accidents.
 *   - --dry-run: builds + prints every request body WITHOUT touching the
 *     network, via a CAPTURING `fetchImpl` injected into the GraphClient. Ideal
 *     for inspecting the wire format with zero real sends.
 *   - --capture (round-trip): IGNORES the E2E_TEST_* recipient env vars and the
 *     --*-target flags entirely, captures a REAL inbound per channel off a live
 *     tunnel, and fires the full matrix back at that conversation. WHY no env /
 *     target ids in this mode: the captured inbound SUPPLIES both the recipient
 *     (its `channelScopedUserId`) and the reaction/reply/typing/markRead target
 *     (its `channelMessageId`) — there is nothing to wrangle by hand. And
 *     because the inbound JUST arrived, the 24h window is GUARANTEED open, so
 *     the free-form sends that would normally risk window-closed rejections are
 *     expected to be accepted — that is the whole value of this mode. It also
 *     unblocks the WhatsApp typing + markRead ops, which require a real INBOUND
 *     wamid the flag-driven mode could only get via manual copy/paste.
 *
 * Shared runner: both the flag-driven mode and the capture mode resolve a
 * per-channel `{ recipientId, targetMessageId }` and then call ONE shared
 * function ({@link runResolvedChannel}) to execute + report the operation
 * matrix. Capture mode's only difference is WHERE the two ids come from (a live
 * inbound vs. env/flags) — the send logic, ordering, and reporting are
 * identical, so they must not diverge.
 *
 * Token hygiene: the GraphClient sends the access token in the Authorization
 * header (never the URL), and we never print `config.*.accessToken`. In
 * dry-run, the captured `authorization` header is redacted before printing. In
 * capture mode the founder's own captured user ids are redacted to `…<last 4>`
 * in console output for tidiness.
 */

import 'dotenv/config';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import pino from 'pino';

import { loadConfig, type Config } from '../../src/config/loader.js';
import { GraphClient } from '../../src/meta/shared/graph-client.js';
import { MetaApiError } from '../../src/meta/shared/errors.js';
import { WhatsAppClient } from '../../src/meta/whatsapp/client.js';
import { MessengerClient } from '../../src/meta/messenger/client.js';
import { InstagramClient } from '../../src/meta/instagram/client.js';
import type { Channel } from '../../src/meta/types.js';
import { startTunnel } from '../lib/tunnel.js';
import { startCaptureServer, type CapturedWebhook, type CaptureServerHandle } from '../lib/capture-server.js';
import { registerAllWebhooks } from './register-webhooks.js';
import {
  parseSweepList,
  runReactionSweep,
  runBatchSweep,
  applyBatchAnswers,
  parseBatchAnswers,
  formatBatchWorksheet,
  formatSweepMarkdown,
  summarizeSweep,
  isDeliverable,
  SWEEP_PRESETS,
  type ChannelSweep,
  type ReactionSender,
  type SweepOutcome
} from './reaction-sweep.js';
import {
  info,
  success,
  warn,
  fail,
  divider,
  confirm,
  closePrompts,
  registerShutdown
} from '../lib/console.js';

const SCRIPT_NAME = 'probe-outbound';

/** The three channels this probe can exercise (matches {@link Channel}). */
const ALL_CHANNELS: readonly Channel[] = ['whatsapp', 'messenger', 'instagram'];

/* ────────────────────────────────────────────────────────────────────────── */
/* Arg parsing (pure helper — unit-tested)                                    */
/* ────────────────────────────────────────────────────────────────────────── */

export interface ProbeArgs {
  /** Channels to probe; empty = all configured. */
  only: Channel[];
  /** Real INBOUND wamid for WhatsApp reaction/reply + REQUIRED for WA typing/markRead. */
  waTarget?: string;
  /** Real INBOUND mid for Messenger reaction/reply targets. */
  fbTarget?: string;
  /** Real INBOUND mid for Instagram reaction/reply targets. */
  igTarget?: string;
  /** Probe message text. */
  text: string;
  /** Build + print bodies WITHOUT hitting Meta. */
  dryRun: boolean;
  /** Skip the confirm prompt in real mode. */
  yes: boolean;
  /**
   * Round-trip mode: capture a REAL inbound per channel off a live tunnel and
   * fire the full matrix back at that conversation. Ignores the E2E_TEST_*
   * recipient env vars and the --*-target flags (capture supplies real ids).
   */
  capture: boolean;
  /**
   * Capture mode only: pass-through to the capture server so signature-failed
   * inbounds are still captured (e.g. while debugging Instagram's separate app
   * secret). Defaults to false (strict) — the verifier already tries all
   * configured secrets, so real inbounds should verify.
   */
  acceptInvalidSignatures: boolean;
  /**
   * Reaction-emoji sweep mode: REPLACE the operation matrix with a
   * one-emoji-at-a-time reaction sweep against the resolved target. Present =
   * on; the value is the resolved candidate list. See `reaction-sweep.ts` for
   * why this is its own mode rather than a longer matrix.
   */
  emojiSweep?: string[];
  /** Sweep mode: skip the per-emoji operator confirmation (API results only). */
  sweepNoPrompt: boolean;
  /**
   * BATCH sweep: put one emoji on each of N captured messages so every
   * reaction stays on screen at once, and collect the operator's readings
   * afterwards instead of in the send loop. Needs no TTY.
   */
  sweepBatch: boolean;
  /** Apply operator answers to a saved batch worksheet (path to its .json). No network. */
  sweepApply?: string;
  /** Answer spec for --sweep-apply, e.g. `1=y,2=n,3=a thumbs up`. */
  answers?: string;
  /** Sweep mode: milliseconds between sends. */
  sweepPacingMs: number;
  /** Print usage and exit. */
  help: boolean;
}

const VALID_CHANNELS: ReadonlySet<Channel> = new Set(ALL_CHANNELS);

/**
 * Default gap between sweep sends. Sized for two things at once: staying well
 * clear of the per-second send ceiling (Instagram's is the tightest), and
 * giving the device time to actually PAINT the new reaction before the operator
 * is asked what they see — a prompt that arrives before the render would
 * collect a wrong answer, which is worse than a slow probe.
 */
const DEFAULT_SWEEP_PACING_MS = 1200;

/**
 * Parse `argv` into {@link ProbeArgs}. Throws on unknown flags / empty values
 * so the script can format a clean remediation rather than half-parsing and
 * proceeding with corrupted defaults (same precedent as `parseVerifyArgs`).
 *
 * The default text embeds an ISO timestamp so each run's message is visibly
 * distinct on the device (easier to confirm "this exact send arrived").
 */
export function parseProbeArgs(argv: readonly string[]): ProbeArgs {
  const flags: ProbeArgs = {
    only: [],
    text: `meta-ai-agent outbound probe ${new Date().toISOString()}`,
    dryRun: false,
    yes: false,
    capture: false,
    acceptInvalidSignatures: false,
    sweepNoPrompt: false,
    sweepBatch: false,
    sweepPacingMs: DEFAULT_SWEEP_PACING_MS,
    help: false
  };

  for (const raw of argv) {
    if (raw === '--help' || raw === '-h') {
      flags.help = true;
      continue;
    }
    if (raw === '--dry-run') {
      flags.dryRun = true;
      continue;
    }
    if (raw === '--yes' || raw === '-y') {
      flags.yes = true;
      continue;
    }
    if (raw === '--capture') {
      flags.capture = true;
      continue;
    }
    if (raw === '--accept-invalid-signatures') {
      flags.acceptInvalidSignatures = true;
      continue;
    }
    if (raw === '--emoji-sweep') {
      flags.emojiSweep = parseSweepList(undefined);
      continue;
    }
    if (raw.startsWith('--emoji-sweep=')) {
      flags.emojiSweep = parseSweepList(raw.slice('--emoji-sweep='.length));
      continue;
    }
    if (raw === '--sweep-no-prompt') {
      flags.sweepNoPrompt = true;
      continue;
    }
    if (raw === '--sweep-batch') {
      flags.sweepBatch = true;
      continue;
    }
    if (raw.startsWith('--sweep-apply=')) {
      flags.sweepApply = requireValue(raw, '--sweep-apply', 'a batch worksheet .json path');
      continue;
    }
    if (raw.startsWith('--answers=')) {
      const value = raw.slice('--answers='.length).trim();
      if (value === '') {
        throw new Error('--answers requires a value, e.g. --answers="1=y,2=n,3=a thumbs up".');
      }
      flags.answers = value;
      continue;
    }
    if (raw.startsWith('--sweep-pacing=')) {
      const value = Number(raw.slice('--sweep-pacing='.length).trim());
      if (!Number.isFinite(value) || value < 0) {
        throw new Error('--sweep-pacing requires a non-negative number of milliseconds, e.g. --sweep-pacing=1500.');
      }
      flags.sweepPacingMs = value;
      continue;
    }
    if (raw.startsWith('--only=')) {
      const value = raw.slice('--only='.length).trim();
      if (value === '') {
        throw new Error('--only requires at least one channel: --only=whatsapp[,messenger,instagram]');
      }
      const parts = value
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const only: Channel[] = [];
      for (const part of parts) {
        if (!VALID_CHANNELS.has(part as Channel)) {
          throw new Error(
            `--only: unknown channel "${part}". Valid values: whatsapp, messenger, instagram.`
          );
        }
        // De-duplicate without reordering — `--only=whatsapp,whatsapp` is a typo.
        if (!only.includes(part as Channel)) only.push(part as Channel);
      }
      flags.only = only;
      continue;
    }
    if (raw.startsWith('--wa-target=')) {
      flags.waTarget = requireValue(raw, '--wa-target', 'an inbound wamid');
      continue;
    }
    if (raw.startsWith('--fb-target=')) {
      flags.fbTarget = requireValue(raw, '--fb-target', 'an inbound mid');
      continue;
    }
    if (raw.startsWith('--ig-target=')) {
      flags.igTarget = requireValue(raw, '--ig-target', 'an inbound mid');
      continue;
    }
    if (raw.startsWith('--text=')) {
      const value = raw.slice('--text='.length);
      if (value.trim() === '') {
        throw new Error('--text requires a non-empty value, e.g. --text="hello from the probe".');
      }
      flags.text = value;
      continue;
    }
    // Refuse to silently ignore unknown flags — almost always a typo.
    throw new Error(`Unknown flag: ${raw}. Run with --help for usage.`);
  }

  return flags;
}

function requireValue(raw: string, flag: string, what: string): string {
  const value = raw.slice(`${flag}=`.length).trim();
  if (value === '') {
    throw new Error(`${flag} requires a value (${what}), e.g. ${flag}=<id>.`);
  }
  return value;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Operation plan (pure helper — unit-tested)                                 */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * One planned operation. Either `run` is set (the op will execute / dry-run) or
 * `skip` is set (the op is reported as skipped with this reason). Exactly one of
 * the two is present — the planner decides, so the executor stays dumb.
 */
export interface PlannedOperation {
  /** Operation label, e.g. `sendText` / `sendReaction`. */
  name: string;
  /** When present, the op is skipped and this is the human-readable reason. */
  skip?: string;
}

export interface PlanContext {
  /** Resolved reaction/reply target id for this channel (an explicit --*-target). */
  target?: string;
  /** Whether an explicit --*-target was supplied. */
  hasTarget: boolean;
}

/**
 * Skip reason for WhatsApp typing / markRead when no `--wa-target` is given.
 *
 * WHY these need a REAL INBOUND wamid: WhatsApp's Cloud API has no standalone
 * "typing on" call. The only way to surface a typing bubble is to mark a
 * specific INBOUND message read AND attach a `typing_indicator` to that same
 * `status:"read"` request. markRead is likewise anchored to an inbound wamid.
 * A self/outbound wamid (the one we just captured from our own sendText) is NOT
 * an inbound message, so Meta rejects it. Hence these two ops require a wamid
 * captured from a message the founder actually SENT the bot.
 */
const WA_NEEDS_INBOUND_TARGET =
  'needs --wa-target=<inbound wamid from a message you sent the bot>';

/**
 * Skip reason for a dependent op when the prior sendText was rejected (so no id
 * was captured) and no explicit target was provided.
 */
function noTargetReason(flag: string): string {
  return `no target message id (sendText failed and no ${flag} provided)`;
}

/**
 * Build the ordered list of operations for a channel. Pure + deterministic so
 * the plan (names + skip semantics) is unit-testable WITHOUT any side effects.
 *
 * `hasTarget` reflects whether an explicit `--*-target` was supplied. For
 * dependent ops (reply / reaction) that can fall back to a captured-at-runtime
 * id, the plan still lists them as runnable here; the EXECUTOR downgrades them
 * to skipped at runtime if the prior sendText failed AND no explicit target was
 * given (it cannot know the capture outcome ahead of time).
 */
export function planChannelOperations(channel: Channel, ctx: PlanContext): PlannedOperation[] {
  if (channel === 'whatsapp') {
    return [
      // Window-INDEPENDENT baseline: proves token + phone-number id are good
      // even if the 24h window is closed. Always first.
      { name: 'sendTemplate(hello_world)' },
      { name: 'sendText' },
      { name: 'sendText(reply)' },
      { name: 'sendReaction' },
      // typing + markRead operate on an INBOUND wamid — skip without --wa-target.
      ctx.hasTarget ? { name: 'sendTypingIndicator' } : { name: 'sendTypingIndicator', skip: WA_NEEDS_INBOUND_TARGET },
      ctx.hasTarget ? { name: 'markRead' } : { name: 'markRead', skip: WA_NEEDS_INBOUND_TARGET }
    ];
  }
  // Messenger and Instagram share the same five-op surface.
  return [
    { name: 'sendText' },
    { name: 'sendTypingOn' },
    { name: 'markSeen' },
    { name: 'sendText(reply)' },
    { name: 'sendReaction' }
  ];
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Dry-run capturing fetch (factored out for testing)                         */
/* ────────────────────────────────────────────────────────────────────────── */

/** A request recorded by the dry-run capturing fetch. */
export interface CapturedRequest {
  url: string;
  method: string;
  /** Header map with the `authorization` value already redacted. */
  headers: Record<string, string>;
  /** Parsed JSON body when present, else the raw string / undefined. */
  body: unknown;
}

/**
 * Build a capturing `fetchImpl` for dry-run mode.
 *
 * WHY this exists: it lets us exercise the EXACT body-building path in each
 * client (so we see the real wire format) while making ZERO network calls. It
 * records every request into `sink`, then returns a FAKE 200 `Response` whose
 * body matches what each client's `toSendResult` expects to parse — otherwise
 * the client would throw on a missing message id. We pick the fake shape by
 * URL: WhatsApp/Messenger POST to `graph.facebook.com`, Instagram to
 * `graph.instagram.com`; WhatsApp's `/messages` response is
 * `{ messages: [{ id }] }`, Messenger/IG is `{ message_id, recipient_id }`.
 *
 * The `to`/recipient id is echoed back from the request body when present so
 * the fake `recipient_id` is plausible.
 */
export function makeCapturingFetch(sink: CapturedRequest[]): typeof fetch {
  // Match the global fetch parameter types without relying on DOM lib globals
  // (`RequestInfo` is not in this project's `lib`); `typeof fetch`'s params are.
  const capturing = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1]
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = redactHeaders(init?.headers);
    const bodyText = typeof init?.body === 'string' ? init.body : undefined;
    const body = bodyText !== undefined ? safeParseJson(bodyText) : undefined;
    sink.push({ url, method, headers, body });

    const fakeBody = fakeResponseBodyFor(url, body);
    return new Response(JSON.stringify(fakeBody), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };
  // The GraphClient only ever calls fetch(url, init); the cast is safe.
  return capturing as unknown as typeof fetch;
}

/**
 * Choose a fake 200 body matching the client that issued the request, so the
 * client's response parser succeeds in dry-run. WhatsApp lives on
 * `graph.facebook.com/{phoneNumberId}/messages` and reads `messages[0].id`;
 * Messenger lives on `graph.facebook.com/{pageId}/messages` and reads
 * `message_id`; Instagram lives on `graph.instagram.com/...` and reads
 * `message_id`. We distinguish WhatsApp from Messenger by body shape: WhatsApp
 * bodies carry `messaging_product: 'whatsapp'`.
 */
function fakeResponseBodyFor(_url: string, body: unknown): unknown {
  const recipient = extractRecipient(body);
  const isWhatsApp =
    typeof body === 'object' &&
    body !== null &&
    (body as { messaging_product?: unknown }).messaging_product === 'whatsapp';
  if (isWhatsApp) {
    return { messages: [{ id: 'wamid.DRYRUN' }] };
  }
  // Messenger + Instagram share the Send API response shape.
  return { message_id: 'm_DRYRUN', recipient_id: recipient ?? 'DRYRUN_RECIPIENT' };
}

/** Pull the recipient id out of a send body (WA `to` or FB/IG `recipient.id`). */
function extractRecipient(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const to = (body as { to?: unknown }).to;
  if (typeof to === 'string') return to;
  const recipient = (body as { recipient?: unknown }).recipient;
  if (typeof recipient === 'object' && recipient !== null) {
    const id = (recipient as { id?: unknown }).id;
    if (typeof id === 'string') return id;
  }
  return undefined;
}

/** Header init type, derived from the global fetch signature (no DOM lib). */
type FetchHeaders = NonNullable<NonNullable<Parameters<typeof fetch>[1]>['headers']>;

/**
 * Normalize a `HeadersInit` to a plain object and redact the bearer token. We
 * never want the access token in printed output even in dry-run.
 */
function redactHeaders(init: FetchHeaders | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (init === undefined) return out;
  const entries: Array<[string, string]> = Array.isArray(init)
    ? (init as Array<[string, string]>)
    : init instanceof Headers
      ? [...init.entries()]
      : Object.entries(init as Record<string, string>);
  for (const [key, value] of entries) {
    out[key] = key.toLowerCase() === 'authorization' ? 'Bearer <redacted>' : value;
  }
  return out;
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Channel selection                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

/** Env var holding each channel's E2E test recipient (read from process.env). */
const RECIPIENT_ENV: Record<Channel, string> = {
  whatsapp: 'E2E_TEST_WHATSAPP_NUMBER',
  messenger: 'E2E_TEST_FACEBOOK_PSID',
  instagram: 'E2E_TEST_INSTAGRAM_IGSID'
};

interface ChannelSelection {
  channel: Channel;
  recipient: string;
}

interface ChannelSkip {
  channel: Channel;
  reason: string;
}

/**
 * Decide which channels to probe. A channel is selected iff it is configured
 * (`config.channels[x]`), its recipient env var is set, AND it passes the
 * `--only` filter. Everything else is reported as a skip with a clear reason.
 */
export function selectChannels(
  config: Config,
  only: readonly Channel[],
  env: NodeJS.ProcessEnv
): { selected: ChannelSelection[]; skipped: ChannelSkip[] } {
  const selected: ChannelSelection[] = [];
  const skipped: ChannelSkip[] = [];
  for (const channel of ALL_CHANNELS) {
    if (only.length > 0 && !only.includes(channel)) {
      skipped.push({ channel, reason: 'excluded by --only filter' });
      continue;
    }
    if (!config.channels[channel]) {
      skipped.push({ channel, reason: 'not configured' });
      continue;
    }
    const envName = RECIPIENT_ENV[channel];
    const recipient = trimEnv(env[envName]);
    if (recipient === undefined) {
      skipped.push({ channel, reason: `configured but ${envName} not set` });
      continue;
    }
    selected.push({ channel, recipient });
  }
  return { selected, skipped };
}

function trimEnv(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Capture-mode helpers (pure — unit-tested)                                  */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * The minimal capture shape these helpers need — a subset of the capture
 * server's `CapturedWebhook`. Declared structurally (not by importing the full
 * type) so the predicate stays trivially unit-testable with a hand-built
 * object and zero capture-server / network machinery.
 */
export interface UsableInboundInput {
  parsed: {
    messages: Array<{
      channel: Channel;
      channelScopedUserId?: string;
      channelMessageId?: string;
      type?: string;
      isEcho?: boolean;
      text?: string;
    }>;
  };
}

/** A usable inbound: a recipient id + a message id we can target a round-trip at. */
export interface UsableInbound {
  channel: Channel;
  /** The OTHER party — the recipient we'll send the round-trip back to. */
  recipientId: string;
  /** The inbound message id — the reaction/reply/typing/markRead target. */
  targetMessageId: string;
}

/**
 * Pick the FIRST usable inbound message for one of the `targets` channels out
 * of a captured webhook.
 *
 * "Usable" = a parsed message whose `channel` is a target, is NOT an echo
 * (`isEcho` falsy — we must not round-trip at our own outbound), and carries
 * BOTH a non-empty `channelScopedUserId` (the recipient) AND a non-empty
 * `channelMessageId` (the target). We only need those two ids, so ANY message
 * type qualifies — but we PREFER a `type:'text'` message when one is present in
 * the same delivery (cleaner to reason about than a reaction/sticker).
 *
 * Returns the resolved `{ channel, recipientId, targetMessageId }` or
 * `undefined` if nothing in this delivery qualifies for a target channel.
 */
export function pickUsableInbound(
  cap: UsableInboundInput,
  targets: readonly Channel[]
): UsableInbound | undefined {
  const targetSet = new Set(targets);
  let firstAny: UsableInbound | undefined;
  for (const msg of cap.parsed.messages) {
    if (!targetSet.has(msg.channel)) continue;
    // Skip echoes of our OWN outbound — round-tripping at those is meaningless
    // and the "recipient" on an echo is flipped to our business id anyway.
    if (msg.isEcho) continue;
    const recipientId = nonEmpty(msg.channelScopedUserId);
    const targetMessageId = nonEmpty(msg.channelMessageId);
    if (recipientId === undefined || targetMessageId === undefined) continue;
    const usable: UsableInbound = { channel: msg.channel, recipientId, targetMessageId };
    // Prefer a text inbound; return immediately when we find one.
    if (msg.type === 'text') return usable;
    // Otherwise remember the first usable non-text and keep scanning for a text.
    if (firstAny === undefined) firstAny = usable;
  }
  return firstAny;
}

/** One collected inbound in batch mode: the ids plus the text, so the operator can map bubble → emoji. */
export interface CollectedInbound extends UsableInbound {
  /** The message body as the person typed it — how they identify the bubble on screen. */
  text: string;
}

/**
 * Collect EVERY usable inbound for the target channels out of one captured
 * webhook, in delivery order.
 *
 * The single-pick sibling {@link pickUsableInbound} exists for round-trip mode,
 * which needs exactly one target. Batch mode needs them all: Meta commonly
 * bundles several messages into ONE webhook delivery when they're sent in quick
 * succession, so picking one per delivery would silently discard most of a
 * twelve-message burst and the sweep would come up short with no explanation.
 *
 * Same "usable" test as the sibling (not an echo, has both ids), but WITHOUT
 * the prefer-text shortcut — a caller wanting all of them cannot also want an
 * early return. Non-text inbounds are kept; a reaction inbound is filtered by
 * the caller, which knows a reaction's id is synthetic and unreactable.
 */
export function collectUsableInbounds(
  cap: UsableInboundInput,
  targets: readonly Channel[]
): CollectedInbound[] {
  const targetSet = new Set(targets);
  const out: CollectedInbound[] = [];
  for (const msg of cap.parsed.messages) {
    if (!targetSet.has(msg.channel)) continue;
    if (msg.isEcho) continue;
    // A reaction's channelMessageId is a synthetic `sender-target-action`
    // string Meta will not accept as a react target — reacting to one would
    // produce a rejection that says nothing about the emoji under test.
    if (msg.type === 'reaction') continue;
    const recipientId = nonEmpty(msg.channelScopedUserId);
    const targetMessageId = nonEmpty(msg.channelMessageId);
    if (recipientId === undefined || targetMessageId === undefined) continue;
    out.push({
      channel: msg.channel,
      recipientId,
      targetMessageId,
      text: typeof msg.text === 'string' ? msg.text : ''
    });
  }
  return out;
}

/**
 * Merge freshly-collected inbounds into a per-channel accumulator, dropping
 * ids already held.
 *
 * WHY the dedupe is load-bearing: Meta re-delivers a webhook it believes we
 * failed to ack, and the capture server acks generously. Without this, one
 * re-delivered burst would fill the whole quota with duplicate ids and the
 * sweep would put twelve different emoji on the SAME message — each replacing
 * the last, so the operator would see one reaction and eleven emoji would be
 * silently unmeasured while the report claimed twelve results.
 */
export function mergeCollected(
  existing: readonly CollectedInbound[],
  incoming: readonly CollectedInbound[],
  limit: number
): CollectedInbound[] {
  const seen = new Set(existing.map((c) => c.targetMessageId));
  const merged = [...existing];
  for (const c of incoming) {
    if (merged.length >= limit) break;
    if (seen.has(c.targetMessageId)) continue;
    seen.add(c.targetMessageId);
    merged.push(c);
  }
  return merged;
}

function nonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Compute the target channels NOT yet handled, preserving `targets` order.
 *
 * Used by the on-arrival capture flow on EVERY webhook: we only try to match an
 * inbound against channels we still owe a response to, so a second inbound on an
 * already-handled channel is ignored (it won't re-trigger that channel's
 * matrix). Pure + order-preserving so it is trivially unit-testable and the
 * "message the bot now" instruction lists channels in a stable order.
 */
export function remainingTargets(
  targets: readonly Channel[],
  handled: ReadonlySet<Channel>
): Channel[] {
  return targets.filter((c) => !handled.has(c));
}

/**
 * Redact a captured user id for tidy console output: keep only the last 4
 * characters (`…1234`). These are the founder's own ids, but we keep output
 * clean and avoid splattering full PSIDs/IGSIDs across the terminal.
 */
export function redactId(id: string): string {
  if (id.length <= 4) return `…${id}`;
  return `…${id.slice(-4)}`;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Execution + reporting                                                      */
/* ────────────────────────────────────────────────────────────────────────── */

type OutcomeStatus = 'accepted' | 'rejected' | 'skipped';

interface OperationOutcome {
  name: string;
  status: OutcomeStatus;
  /** Returned message id on accept. */
  messageId?: string;
  /** Skip reason on skip. */
  reason?: string;
  /** Error detail on reject. */
  error?: MetaApiError | Error;
}

/**
 * WhatsApp error codes that almost always mean the 24h customer-service window
 * is closed (re-engagement required). We annotate these so the developer
 * doesn't mistake an expected window-closed rejection for a body bug.
 *   131047 — re-engagement message (more than 24h since last user message)
 *   131026 — message undeliverable (often window / capability related)
 *   131051 — unsupported message type in this context (window-adjacent)
 */
const WA_WINDOW_CLOSED_CODES = new Set([131047, 131026, 131051]);

/** Bundle of the live clients used to run the operations for one channel. */
interface ChannelClients {
  whatsapp?: WhatsAppClient;
  messenger?: MessengerClient;
  instagram?: InstagramClient;
}

/**
 * A fully-resolved per-channel run context — the SHARED currency between the
 * flag-driven mode and the capture mode. Both modes resolve a recipient and
 * (optionally) a target message id, then hand this to {@link runResolvedChannel}.
 *
 * WHY this exists (the shared-runner refactor): the operation matrix, its
 * ordering, the dependent-op fallback, and the per-op try/catch are identical
 * across modes — only the SOURCE of `recipientId` / `targetMessageId` differs
 * (env + flags vs. a live captured inbound). Collapsing both onto this one
 * struct guarantees the two modes can never drift in what they actually send.
 *
 * `targetMessageId` plays the exact role the flag-driven mode's
 * `explicitTarget` did: when present it is the reaction/reply target AND (for
 * WhatsApp) the inbound wamid that unblocks typing + markRead. In capture mode
 * it is ALWAYS present (the captured inbound's `channelMessageId`).
 */
export interface ResolvedChannel {
  channel: Channel;
  /** The OTHER party to send to — `wa_id` / PSID / IGSID. */
  recipientId: string;
  /**
   * Explicit reaction/reply/typing/markRead target message id, when known
   * ahead of time (an explicit --*-target, or the captured inbound id in
   * capture mode). Absent in flag-driven mode when no --*-target was passed —
   * then dependent ops fall back to the id captured from the first sendText.
   */
  targetMessageId?: string;
}

/**
 * What one channel's run produced. `outcomes` is the matrix vocabulary every
 * reporting path already speaks; `sweep` is the richer per-emoji record that
 * only reaction-sweep mode produces and only the sweep report reads.
 */
interface RunChannelResult {
  outcomes: OperationOutcome[];
  sweep?: SweepOutcome[];
}

/**
 * Run the planned operations for a single RESOLVED channel, wrapping each in
 * its own try/catch and recording an outcome. Dependent ops (reply / reaction)
 * reuse a captured message id from the first sendText when no explicit target
 * was given; if that capture failed they are downgraded to skipped here (the
 * plan could not know the capture outcome ahead of time).
 *
 * This is the ONE per-channel runner both modes call (see {@link ResolvedChannel}).
 */
async function runResolvedChannel(
  resolved: ResolvedChannel,
  clients: ChannelClients,
  args: ProbeArgs
): Promise<RunChannelResult> {
  const { channel, recipientId } = resolved;
  const explicitTarget = resolved.targetMessageId;
  const text = args.text;

  // Sweep mode REPLACES the matrix (see reaction-sweep.ts): the matrix's other
  // ops would each consume a send slot and add nothing to the question being
  // asked, and its single hardcoded 👍 is the very thing being generalized.
  if (args.emojiSweep) {
    return runSweepForChannel(resolved, clients, args);
  }
  const plan = planChannelOperations(channel, {
    ...(explicitTarget !== undefined ? { target: explicitTarget } : {}),
    hasTarget: explicitTarget !== undefined
  });

  const outcomes: OperationOutcome[] = [];
  // Captured id from this channel's first sendText — the default reply/reaction
  // target when no explicit target was supplied.
  let capturedId: string | undefined;

  for (const op of plan) {
    if (op.skip !== undefined) {
      outcomes.push({ name: op.name, status: 'skipped', reason: op.skip });
      continue;
    }

    // The reply/reaction target: an explicit target wins; otherwise the
    // captured sendText id. For dependent ops with neither, downgrade to a skip.
    const dependsOnTarget = op.name === 'sendText(reply)' || op.name === 'sendReaction';
    const target = explicitTarget ?? capturedId;
    if (dependsOnTarget && target === undefined) {
      outcomes.push({
        name: op.name,
        status: 'skipped',
        reason: noTargetReason(targetFlagFor(channel))
      });
      continue;
    }

    try {
      const messageId = await runOperation({
        channel,
        op: op.name,
        recipient: recipientId,
        text,
        target,
        explicitTarget,
        clients
      });
      // The first plain sendText seeds the default target for later ops.
      if (op.name === 'sendText' && messageId !== undefined) capturedId = messageId;
      outcomes.push(
        messageId !== undefined
          ? { name: op.name, status: 'accepted', messageId }
          : { name: op.name, status: 'accepted' }
      );
    } catch (err) {
      outcomes.push({
        name: op.name,
        status: 'rejected',
        error: err instanceof Error ? err : new Error(String(err))
      });
    }
  }

  return { outcomes };
}

/**
 * Sweep one channel: resolve its client, refuse cleanly without a target, then
 * hand off to the pure-ish sweep runner.
 *
 * WHY the no-target case is a SKIP rather than a throw: in capture mode every
 * channel always has a target, so this only fires in flag-driven mode, where
 * one channel lacking a `--*-target` must not abort the channels that have one.
 */
async function runSweepForChannel(
  resolved: ResolvedChannel,
  clients: ChannelClients,
  args: ProbeArgs
): Promise<RunChannelResult> {
  const { channel, recipientId } = resolved;
  const target = resolved.targetMessageId;
  const emojis = args.emojiSweep ?? [];

  if (target === undefined) {
    return {
      outcomes: [
        {
          name: 'emojiSweep',
          status: 'skipped',
          // A sweep reacts to an INBOUND message; there is no sendText to
          // borrow an id from, because reacting to our own outbound is a
          // different (and unsupported) act.
          reason: `needs a real inbound message id — pass ${targetFlagFor(channel)} or use --capture`
        }
      ]
    };
  }

  const client = clients[channel] as ReactionSender | undefined;
  if (!client) {
    return { outcomes: [{ name: 'emojiSweep', status: 'skipped', reason: 'channel not configured' }] };
  }

  const sweep = await runReactionSweep({
    channel,
    client,
    recipientId,
    targetMessageId: target,
    emojis,
    // Dry-run FORCES no-prompt: the capturing fetch means nothing reached a
    // phone, so asking "what do you see?" would collect an answer about the
    // previous run's leftovers and record it as this run's evidence.
    noPrompt: args.sweepNoPrompt || args.dryRun,
    pacingMs: args.sweepPacingMs
  });

  // In dry-run every row is a SKIP, not a pass or a failure. Projecting them as
  // accepted would report delivery for a reaction that never left the machine;
  // projecting them as rejected would cry wolf. Neither is true — nothing was
  // tested.
  if (args.dryRun) {
    return {
      outcomes: sweep.map((o) => ({
        name: `react ${o.emoji}`,
        status: 'skipped' as const,
        reason: 'dry-run: body built, nothing sent'
      })),
      sweep
    };
  }

  // Project the sweep onto the matrix's outcome vocabulary so the existing
  // per-channel summary keeps working. `accepted` here means DELIVERED, not
  // merely 200 — an API accept that rendered nothing is reported as rejected,
  // because for this probe's purpose it failed.
  const outcomes: OperationOutcome[] = sweep.map((o) =>
    isDeliverable(o)
      ? { name: `react ${o.emoji}`, status: 'accepted' as const }
      : {
          name: `react ${o.emoji}`,
          status: 'rejected' as const,
          error: new Error(
            o.apiAccepted
              ? `API accepted but rendered "${o.rendered}"${o.note ? ` (${o.note})` : ''}`
              : (o.errorMessage ?? 'rejected')
          )
        }
  );

  return { outcomes, sweep };
}

/**
 * Flag-driven adapter: map a {@link ChannelSelection} (channel + env recipient)
 * + parsed args onto a {@link ResolvedChannel} and run the shared runner. The
 * explicit --*-target (if any) becomes `targetMessageId`.
 */
async function runChannel(
  sel: ChannelSelection,
  clients: ChannelClients,
  args: ProbeArgs
): Promise<RunChannelResult> {
  const explicitTarget = explicitTargetFor(sel.channel, args);
  const resolved: ResolvedChannel = {
    channel: sel.channel,
    recipientId: sel.recipient,
    ...(explicitTarget !== undefined ? { targetMessageId: explicitTarget } : {})
  };
  return runResolvedChannel(resolved, clients, args);
}

interface RunOperationArgs {
  channel: Channel;
  op: string;
  recipient: string;
  text: string;
  /** Resolved reply/reaction target (explicit flag or captured id). */
  target: string | undefined;
  /** Explicit --*-target, when provided (required for WA typing/markRead). */
  explicitTarget: string | undefined;
  clients: ChannelClients;
}

/**
 * Dispatch a single named operation to the appropriate live client. Returns the
 * returned message id for ops that produce one (the sendText / template family)
 * or `undefined` for fire-and-forget ops (typing / read / reaction). Throws on
 * a Meta rejection — the caller records it.
 */
async function runOperation(a: RunOperationArgs): Promise<string | undefined> {
  if (a.channel === 'whatsapp') {
    const wa = a.clients.whatsapp;
    if (!wa) throw new Error('internal: WhatsApp client not constructed');
    switch (a.op) {
      case 'sendTemplate(hello_world)': {
        // hello_world is a Meta-approved global template — works without custom
        // approval and OUTSIDE the 24h window (the baseline send).
        const res = await wa.sendTemplate(a.recipient, 'hello_world', 'en_US');
        return res.messageId;
      }
      case 'sendText': {
        const res = await wa.sendText(a.recipient, a.text);
        return res.messageId;
      }
      case 'sendText(reply)': {
        const res = await wa.sendText(a.recipient, `${a.text} (reply)`, { replyTo: a.target });
        return res.messageId;
      }
      case 'sendReaction':
        await wa.sendReaction(a.recipient, a.target as string, '👍');
        return undefined;
      case 'sendTypingIndicator':
        // Anchored to an INBOUND wamid (see WA_NEEDS_INBOUND_TARGET).
        await wa.sendTypingIndicator(a.recipient, a.explicitTarget);
        return undefined;
      case 'markRead':
        await wa.markRead(a.recipient, a.explicitTarget as string);
        return undefined;
      default:
        throw new Error(`internal: unknown whatsapp op ${a.op}`);
    }
  }

  // Messenger + Instagram share the same adapter surface; pick the client.
  const client = a.channel === 'messenger' ? a.clients.messenger : a.clients.instagram;
  if (!client) throw new Error(`internal: ${a.channel} client not constructed`);
  switch (a.op) {
    case 'sendText': {
      const res = await client.sendText(a.recipient, a.text);
      return res.messageId;
    }
    case 'sendTypingOn':
      await client.sendTypingOn(a.recipient);
      return undefined;
    case 'markSeen':
      await client.markSeen(a.recipient);
      return undefined;
    case 'sendText(reply)': {
      const res = await client.sendText(a.recipient, `${a.text} (reply)`, { replyTo: a.target });
      return res.messageId;
    }
    case 'sendReaction':
      await client.sendReaction(a.recipient, a.target as string, '👍');
      return undefined;
    default:
      throw new Error(`internal: unknown ${a.channel} op ${a.op}`);
  }
}

function explicitTargetFor(channel: Channel, args: ProbeArgs): string | undefined {
  if (channel === 'whatsapp') return args.waTarget;
  if (channel === 'messenger') return args.fbTarget;
  return args.igTarget;
}

function targetFlagFor(channel: Channel): string {
  if (channel === 'whatsapp') return '--wa-target';
  if (channel === 'messenger') return '--fb-target';
  return '--ig-target';
}

/** Print a single operation outcome line (colored by status). */
function reportOutcome(outcome: OperationOutcome): void {
  if (outcome.status === 'accepted') {
    const id = outcome.messageId ? ` (id: ${outcome.messageId})` : '';
    success(`${outcome.name}: accepted${id}`);
    return;
  }
  if (outcome.status === 'skipped') {
    warn(`${outcome.name}: skipped — ${outcome.reason ?? 'no reason'}`);
    return;
  }
  // rejected
  fail(`${outcome.name}: rejected — ${formatError(outcome.error)}`);
  const annotation = windowAnnotation(outcome.error);
  if (annotation) warn(`    ↳ ${annotation}`);
}

/** Format a MetaApiError (or plain Error) into a single diagnostic line. */
function formatError(err: MetaApiError | Error | undefined): string {
  if (err instanceof MetaApiError) {
    const parts: string[] = [`HTTP ${err.httpStatus}`];
    if (err.errorCode !== undefined) parts.push(`code ${err.errorCode}`);
    if (err.errorSubCode !== undefined) parts.push(`subcode ${err.errorSubCode}`);
    if (err.fbtraceId) parts.push(`fbtrace_id ${err.fbtraceId}`);
    const server = extractServerMessage(err.responseBody);
    const detail = server ?? err.message;
    return `${parts.join(', ')} — ${detail}`;
  }
  return err?.message ?? 'unknown error';
}

/** Best-effort pull of `error.message` from a Meta error envelope. */
function extractServerMessage(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const err = (body as { error?: unknown }).error;
  if (typeof err !== 'object' || err === null) return undefined;
  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' ? message : undefined;
}

/** Annotate known window-closed WhatsApp rejections with a remediation hint. */
function windowAnnotation(err: MetaApiError | Error | undefined): string | undefined {
  if (err instanceof MetaApiError && err.errorCode !== undefined && WA_WINDOW_CLOSED_CODES.has(err.errorCode)) {
    return '24h window likely closed — message the bot first, then re-run.';
  }
  return undefined;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Main                                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  let args: ProbeArgs;
  try {
    args = parseProbeArgs(process.argv.slice(2));
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    process.exitCode = 2;
    return;
  }

  if (args.help) {
    printHelp();
    return;
  }

  divider('meta-ai-agent: outbound probe');

  // A prompting sweep on a non-interactive stdin would read every question as
  // an empty line and score the whole run "as-sent" — a report full of
  // confirmations nobody made. Refuse up front rather than downgrade, because
  // the operator asked for the confirmed variant and should get it or nothing.
  // Apply mode is offline bookkeeping — no config, no clients, no network.
  if (args.sweepApply !== undefined) {
    await runApplyMode(args);
    return;
  }

  // --sweep-batch only has a code path inside capture mode, and it is inert
  // without a candidate list. Both would otherwise fail SILENTLY — the probe
  // would run its ordinary matrix and report success, and the operator would
  // read that as a completed sweep.
  if (args.sweepBatch && !args.emojiSweep) {
    fail('--sweep-batch needs --emoji-sweep (it is a mode OF the sweep, not a sweep of its own).');
    process.exitCode = 2;
    return;
  }
  if (args.sweepBatch && !args.capture) {
    fail('--sweep-batch requires --capture: it collects the messages it reacts to off a live tunnel.');
    process.exitCode = 2;
    return;
  }

  // Batch mode is exempt: it never asks a question mid-run, collecting the
  // operator's readings afterwards via --sweep-apply instead.
  if (args.emojiSweep && !args.sweepBatch && !args.sweepNoPrompt && !args.dryRun && !process.stdin.isTTY) {
    fail(
      'Reaction sweep needs an interactive terminal to ask what rendered on your device. ' +
        'Run it directly (not piped), or pass --sweep-no-prompt for an API-only sweep ' +
        '(which cannot detect a silent drop).'
    );
    process.exitCode = 2;
    return;
  }

  // Load config with a friendly error (loadConfig is strict and throws).
  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    fail(`Configuration error: ${err instanceof Error ? err.message : String(err)}`);
    info(
      'Hint: ensure .env defines META_APP_SECRET, META_VERIFY_TOKEN, CHAT_ENDPOINT_URL, ' +
        'NGROK_DOMAIN, and credentials for at least one channel.'
    );
    process.exitCode = 1;
    return;
  }

  // Capture (round-trip) mode is a different orchestration entirely: it stands
  // up a tunnel + capture server, waits for a live inbound per channel, and
  // fires the matrix back. It IGNORES the E2E_TEST_* env recipients and the
  // --*-target flags — the captured inbound supplies both ids — so it branches
  // BEFORE the env-driven `selectChannels`.
  if (args.capture) {
    await runCaptureMode(config, args);
    return;
  }

  const { selected, skipped } = selectChannels(config, args.only, process.env);

  for (const s of skipped) {
    info(`${s.channel}: skipped — ${s.reason}`);
  }

  if (selected.length === 0) {
    warn('No channels to probe. Configure a channel and set its E2E_TEST_* recipient, or relax --only.');
    // Not an error: a clean "nothing to do" exit (0) is the right outcome.
    return;
  }

  // Build the GraphClient: real transport, or a capturing fetch for dry-run.
  const logger = makeLogger();
  const captured: CapturedRequest[] = [];
  const graph = buildGraphClient(config, logger, args.dryRun ? captured : undefined);

  const clients = buildClients(config, graph, logger);

  // Confirmation (real mode only). Free-form sends need an OPEN 24h window, so
  // remind the developer before any real message goes out.
  if (!args.dryRun) {
    divider('about to send REAL messages');
    const realCount = countRealOperations(selected, args);
    for (const s of selected) {
      info(`${s.channel} → ${s.recipient}`);
    }
    info(`Approx. ${realCount} real send(s) will be attempted across ${selected.length} channel(s).`);
    warn(
      'Free-form sends (text / reaction / typing / read) need an OPEN 24h window — ' +
        'if you have not messaged the bot in the last 24h, expect window-closed rejections. ' +
        'The WhatsApp hello_world template is the window-independent baseline.'
    );
    if (!args.yes) {
      let proceed = false;
      try {
        proceed = await confirm('Send these real messages to your test devices?', false);
      } catch {
        proceed = false;
      }
      if (!proceed) {
        info('Aborted — no messages sent.');
        return;
      }
    }
  } else {
    info('Dry-run: building + printing request bodies WITHOUT hitting Meta.');
  }

  // Run each selected channel's plan.
  const perChannel: Array<{ channel: Channel; outcomes: OperationOutcome[] }> = [];
  const sweeps: ChannelSweep[] = [];
  for (const sel of selected) {
    divider(`channel: ${sel.channel}`);
    const { outcomes, sweep } = await runChannel(sel, clients, args);
    if (!args.dryRun) {
      for (const o of outcomes) reportOutcome(o);
    } else {
      // In dry-run, accepted means "body built + captured" (no real result);
      // skips are still meaningful. Report them so the plan is visible.
      for (const o of outcomes) reportOutcome(o);
    }
    perChannel.push({ channel: sel.channel, outcomes });
    if (sweep) sweeps.push({ channel: sel.channel, outcomes: sweep });
  }
  if (sweeps.length > 0) await reportSweep(sweeps, args.dryRun);

  // Dry-run: pretty-print every captured request grouped by channel.
  if (args.dryRun) {
    printCapturedRequests(captured);
  }

  // Summary table + verdict (shared with capture mode).
  reportSummary(perChannel, args.dryRun);
}

/**
 * Build the GraphClient used by every client. When `captureSink` is provided
 * (dry-run, in either mode) the transport is the capturing fetch — records
 * bodies, NEVER touches the network, returns a fake 200 so each client's
 * response parser succeeds. Otherwise it's the real network transport.
 */
function buildGraphClient(
  config: Config,
  logger: pino.Logger,
  captureSink?: CapturedRequest[]
): GraphClient {
  if (captureSink !== undefined) {
    return new GraphClient({
      apiVersion: config.meta.graphApiVersion,
      fetchImpl: makeCapturingFetch(captureSink),
      logger
    });
  }
  return new GraphClient({ apiVersion: config.meta.graphApiVersion, logger });
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Capture (round-trip) mode                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * SAFETY-NET budget for the whole capture session. In the on-arrival flow this
 * is NOT the normal completion path — each channel is answered the instant its
 * inbound lands and the run finishes as soon as ALL target channels are handled.
 * The timeout only fires when some channel never messages: it stops waiting,
 * reports those channels as "no inbound (timed out)", and exits with whatever
 * WAS handled. A channel handled earlier never waits for this.
 */
const CAPTURE_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Round-trip mode. Stand up a tunnel + capture server, register webhooks, then
 * answer EACH target channel independently the moment its inbound arrives:
 * capture WhatsApp → run the WhatsApp matrix; capture Messenger → run the
 * Messenger matrix; etc. Each channel's full matrix runs via the SHARED runner.
 *
 * WHY on-arrival (not "collect all, then run all"): the founder messages the
 * channels back-to-back, often seconds apart; making the first channel wait for
 * the last one to arrive wasted the open 24h window and the developer's time.
 * Now the first inbound triggers its matrix immediately while the receiver keeps
 * listening for the others.
 *
 * WHY a serialized send queue: two inbounds can land within the same tick (e.g.
 * a single delivery carrying messages for two channels, or the founder firing
 * both fast). Running their matrices concurrently would INTERLEAVE their console
 * output (dividers + per-op lines) into an unreadable mess. So arrivals are
 * ENQUEUED and a single worker drains them one channel at a time, in arrival
 * order — immediate response per channel, but clean non-interleaved output.
 * Crucially the worker runs OFF the onWebhook callback, so capturing the next
 * channel is never blocked while a matrix is mid-run.
 *
 * WHY no env / target ids here: see the file header. The captured inbound is
 * the single source of both the recipient and the target message id, and its
 * arrival GUARANTEES the 24h window is open — so the free-form sends that the
 * flag-driven mode warns may be window-rejected are expected to be accepted.
 */
async function runCaptureMode(config: Config, args: ProbeArgs): Promise<void> {
  const logger = makeLogger();

  // Target channels = configured channels intersected with --only (if given).
  const targets = ALL_CHANNELS.filter(
    (c) => config.channels[c] && (args.only.length === 0 || args.only.includes(c))
  );
  if (targets.length === 0) {
    warn('No target channels for capture. Configure a channel (and relax --only if set).');
    return;
  }
  divider('capture (round-trip) mode');
  info(`Target channels: ${targets.join(', ')}`);
  if (args.dryRun) {
    info('Dry-run + capture: a REAL inbound is captured, but sends go through the capturing fetch (no real sends).');
  }

  // 1) Tunnel. 2) Capture server reusing that exact tunnel (so we don't open a
  // second one). Track started handles so the shutdown hook can close them
  // even if a later step throws.
  let tunnel: { url: string; close(): Promise<void> } | undefined;
  let capture: CaptureServerHandle | undefined;
  // Register a shutdown hook up front (closes whatever is started). We never
  // hard process.exit mid-async — set process.exitCode and let the loop drain.
  const unregister = registerShutdown(async () => {
    await closeCaptureResources(capture, tunnel);
  });

  try {
    tunnel = await startTunnel({
      port: config.port,
      domain: config.ngrokDomain,
      ...(process.env.NGROK_AUTHTOKEN !== undefined ? { authtoken: process.env.NGROK_AUTHTOKEN } : {})
    });
    info(`Tunnel: ${tunnel.url}`);

    capture = await startCaptureServer({
      config,
      port: config.port,
      // Reuse the tunnel we just started instead of opening a second one.
      tunnelOverride: { url: tunnel.url, close: tunnel.close },
      logger,
      acceptInvalidSignatures: args.acceptInvalidSignatures
    });

    // Register webhooks so inbound flows to our callback. WhatsApp may report
    // manual_required (per the registration helper) — that is NOT fatal here:
    // subscriptions were configured in Stage 3, so inbound should still arrive.
    const callbackUrl = `${tunnel.url}/webhook`;
    divider('registering webhooks');
    const summary = await registerAllWebhooks({ config, callbackUrl, logger });
    for (const r of summary.results) {
      const label = r.channel.padEnd(10);
      if (r.status === 'success') success(`${label} ${r.status}: ${r.message}`);
      else if (r.status === 'manual_required') warn(`${label} ${r.status}: ${r.message} (inbound should still flow)`);
      else if (r.status === 'skipped') info(`${label} ${r.status}: ${r.message}`);
      else fail(`${label} ${r.status}: ${r.message}`);
    }

    // Build clients once over a (real or capturing) GraphClient. In capture mode
    // `targetMessageId` is ALWAYS present, so NOTHING skips for lack of a target.
    const sink: CapturedRequest[] = [];
    const graph = buildGraphClient(config, logger, args.dryRun ? sink : undefined);
    const clients = buildClients(config, graph, logger);

    // BATCH sweep is a different capture shape: it collects MANY inbounds per
    // channel before sending anything, so it cannot share the answer-on-arrival
    // queue below (which fires the moment the first message lands).
    if (args.sweepBatch && args.emojiSweep) {
      await runBatchMode(capture, targets, clients, args);
      return;
    }

    divider('waiting for inbound');
    info(
      `Message the bot now from each channel you want to test: ${targets.join(', ')}. ` +
        `Each channel is answered AS SOON AS its message arrives (not batched). ` +
        `Safety-net timeout ${CAPTURE_TIMEOUT_MS / 60000} min. Ctrl-C to stop.`
    );

    // Drive the on-arrival flow: subscribe, run each channel's matrix on arrival
    // through a serialized queue, finish when all targets are handled (or the
    // safety-net timeout fires). Returns the per-channel outcomes that ran.
    const { perChannel, handled, sweeps } = await captureOnArrival({
      capture,
      targets,
      clients,
      args
    });

    // Report which channels never messaged before we settled.
    const missed = remainingTargets(targets, handled);
    if (handled.size > 0) success(`Handled: ${[...handled].join(', ')}.`);
    if (missed.length > 0) {
      warn(`No inbound captured (timed out): ${missed.join(', ')}.`);
    }
    if (perChannel.length === 0) {
      warn('No inbound captured for any target channel — nothing was sent. Exiting.');
      return;
    }

    if (args.dryRun) printCapturedRequests(sink);

    // Summary + verdict (same format as flag-driven mode).
    reportSummary(perChannel, args.dryRun);
    if (sweeps.length > 0) await reportSweep(sweeps, args.dryRun);
  } catch (err) {
    fail(`Capture mode error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = process.exitCode ?? 1;
  } finally {
    // Manual cleanup (the shutdown hook stays registered for Ctrl-C until now).
    // This runs exactly once on the normal path; the hook covers Ctrl-C before
    // we get here. closeCaptureResources is idempotent against double-close.
    unregister();
    await closeCaptureResources(capture, tunnel);
  }
}

/**
 * How long the batch collector waits after the LAST new inbound before
 * deciding the operator is done sending.
 *
 * Sized above a slow thumb-typed message but well below the patience of
 * someone watching a terminal. It only matters when fewer messages arrive than
 * emoji to test — a full quota settles immediately.
 */
const BATCH_QUIET_MS = 25 * 1000;

interface BatchCaptureResult {
  /** Collected inbounds per channel, capped at the emoji count. */
  perChannel: Map<Channel, CollectedInbound[]>;
}

/**
 * Batch mode's collector: gather up to `quota` DISTINCT inbound messages per
 * target channel, then settle.
 *
 * Settles on the first of: every target channel at full quota; a quiet period
 * with at least one message collected somewhere; or the safety-net timeout.
 * The quiet-period exit is what makes "send as many as you feel like" work —
 * the operator never has to hit exactly twelve, and a short run is reported as
 * a short run rather than hanging.
 */
function captureBatch(
  capture: CaptureServerHandle,
  targets: readonly Channel[],
  quota: number
): Promise<BatchCaptureResult> {
  return new Promise((resolve) => {
    const perChannel = new Map<Channel, CollectedInbound[]>();
    for (const c of targets) perChannel.set(c, []);

    let unsubscribe: (() => void) | undefined;
    let quietTimer: NodeJS.Timeout | undefined;
    let settled = false;

    const settle = (): void => {
      if (settled) return;
      settled = true;
      if (quietTimer) clearTimeout(quietTimer);
      clearTimeout(safety);
      unsubscribe?.();
      resolve({ perChannel });
    };

    const safety = setTimeout(settle, CAPTURE_TIMEOUT_MS);

    const armQuiet = (): void => {
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(() => {
        info(`No new messages for ${BATCH_QUIET_MS / 1000}s — proceeding with what arrived.`);
        settle();
      }, BATCH_QUIET_MS);
    };

    unsubscribe = capture.onWebhook((cap: CapturedWebhook) => {
      const collected = collectUsableInbounds(cap, targets);
      if (collected.length === 0) return;

      let anyNew = false;
      for (const channel of targets) {
        const incoming = collected.filter((c) => c.channel === channel);
        if (incoming.length === 0) continue;
        const before = perChannel.get(channel) ?? [];
        const after = mergeCollected(before, incoming, quota);
        if (after.length > before.length) {
          anyNew = true;
          perChannel.set(channel, after);
          info(`${channel}: ${after.length}/${quota} messages collected (latest: "${after[after.length - 1]!.text}")`);
        }
      }
      if (!anyNew) return;

      // Full quota everywhere is the clean exit — no need to wait out the quiet
      // window when there is nothing left to collect.
      const complete = targets.every((c) => (perChannel.get(c) ?? []).length >= quota);
      if (complete) {
        success('Every channel reached its message quota.');
        settle();
        return;
      }
      armQuiet();
    });
  });
}

interface CaptureOnArrivalArgs {
  capture: CaptureServerHandle;
  targets: readonly Channel[];
  clients: ChannelClients;
  args: ProbeArgs;
}

interface CaptureOnArrivalResult {
  /** Per-channel outcomes, in the order the channels were handled. */
  perChannel: Array<{ channel: Channel; outcomes: OperationOutcome[] }>;
  /** The set of channels that were handled (an inbound arrived + matrix ran). */
  handled: Set<Channel>;
  /** Per-emoji sweep records — populated only in `--emoji-sweep` mode. */
  sweeps: ChannelSweep[];
}

/**
 * The on-arrival receiver + serialized send queue.
 *
 * Each captured webhook is matched (via {@link pickUsableInbound}) against the
 * target channels we have NOT yet handled. On a match we mark the channel
 * handled (so a SECOND inbound on the same channel can't re-trigger it) and
 * ENQUEUE that channel's matrix run. A single worker (`drain`) executes queued
 * channels one at a time, in arrival order, so their console output never
 * interleaves. The onWebhook callback returns immediately after enqueuing — it
 * never awaits a matrix run — so the receiver keeps capturing while a matrix is
 * in flight.
 *
 * Completion: the returned promise resolves once EVERY target channel has been
 * handled AND the queue has fully drained (so the last channel's output is
 * printed before we settle). The {@link CAPTURE_TIMEOUT_MS} safety-net resolves
 * early if some channel never messages — we still drain whatever is queued so
 * no half-printed matrix is lost, then return what ran. We always unsubscribe
 * before resolving so no stray webhook is processed after settle.
 */
function captureOnArrival(args: CaptureOnArrivalArgs): Promise<CaptureOnArrivalResult> {
  const { capture, targets, clients, args: probeArgs } = args;
  return new Promise((resolve) => {
    const handled = new Set<Channel>();
    const perChannel: Array<{ channel: Channel; outcomes: OperationOutcome[] }> = [];
    const sweeps: ChannelSweep[] = [];

    // Serialized send queue: arrivals are pushed here; `drain` empties it one
    // channel at a time. `worker` is the single in-flight drain promise (or
    // undefined when idle) — we await it before settling so nothing is cut off.
    const queue: UsableInbound[] = [];
    let worker: Promise<void> | undefined;
    let settled = false;
    let unsubscribe: (() => void) | undefined;

    const settle = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Stop receiving FIRST so no late webhook enqueues after we decide to
      // finish, then wait for any in-flight matrix to finish printing.
      unsubscribe?.();
      void Promise.resolve(worker).then(() => resolve({ perChannel, handled, sweeps }));
    };

    const drain = async (): Promise<void> => {
      // Single worker: process queued channels strictly in arrival order so
      // their dividers + per-op lines never interleave on the console.
      while (queue.length > 0) {
        const inbound = queue.shift()!;
        divider(`channel: ${inbound.channel} (inbound arrived)`);
        const resolved: ResolvedChannel = {
          channel: inbound.channel,
          recipientId: inbound.recipientId,
          targetMessageId: inbound.targetMessageId
        };
        const { outcomes, sweep } = await runResolvedChannel(resolved, clients, probeArgs);
        for (const o of outcomes) reportOutcome(o);
        perChannel.push({ channel: inbound.channel, outcomes });
        if (sweep) sweeps.push({ channel: inbound.channel, outcomes: sweep });
      }
    };

    // Kick (or re-kick) the worker. If a drain is already running it will pick
    // up the freshly-enqueued item; otherwise start one. Each completed worker
    // checks whether all targets are now handled and settles if so.
    const kick = (): void => {
      if (worker !== undefined) return;
      worker = drain()
        .catch((err) => {
          // A matrix run should swallow its own per-op errors; this guards the
          // queue machinery itself so one failure can't wedge the worker.
          fail(`capture matrix run error: ${err instanceof Error ? err.message : String(err)}`);
        })
        .finally(() => {
          worker = undefined;
          // More may have arrived while we were draining — keep going.
          if (queue.length > 0) {
            kick();
            return;
          }
          if (targets.every((c) => handled.has(c))) settle();
        });
    };

    // Safety net only — see CAPTURE_TIMEOUT_MS. unref() so a pending timer can't
    // pin the event loop once everything else has drained.
    const timer = setTimeout(settle, CAPTURE_TIMEOUT_MS);
    timer.unref();

    unsubscribe = capture.onWebhook((cap: CapturedWebhook) => {
      if (settled) return;
      // Only match against channels we still owe a response to — a second
      // inbound on an already-handled channel is ignored here.
      const remaining = remainingTargets(targets, handled);
      if (remaining.length === 0) return;
      const usable = pickUsableInbound(cap, remaining);
      if (!usable) return;
      // Mark handled BEFORE enqueuing so a near-simultaneous duplicate inbound
      // for the same channel can't double-enqueue it.
      handled.add(usable.channel);
      info(
        `captured ${usable.channel} inbound from ${redactId(usable.recipientId)} (msg ${usable.targetMessageId})`
      );
      queue.push(usable);
      kick();
    });
  });
}

/** Close capture server + tunnel, tolerating either being absent / already closed. */
async function closeCaptureResources(
  capture: CaptureServerHandle | undefined,
  tunnel: { close(): Promise<void> } | undefined
): Promise<void> {
  // The capture server's close() also closes the tunnel it was handed; only
  // close the tunnel directly if the capture server never started.
  if (capture) {
    await capture.close().catch(() => undefined);
  } else if (tunnel) {
    await tunnel.close().catch(() => undefined);
  }
}

/** Print the per-channel summary table + verdict (shared by both modes). */
function reportSummary(
  perChannel: ReadonlyArray<{ channel: Channel; outcomes: OperationOutcome[] }>,
  dryRun: boolean
): void {
  divider('summary');
  let anyRejected = false;
  for (const { channel, outcomes } of perChannel) {
    const accepted = outcomes.filter((o) => o.status === 'accepted').length;
    const rejected = outcomes.filter((o) => o.status === 'rejected').length;
    const skippedCount = outcomes.filter((o) => o.status === 'skipped').length;
    if (rejected > 0) anyRejected = true;
    const line = `${channel.padEnd(10)} accepted=${accepted}  rejected=${rejected}  skipped=${skippedCount}`;
    if (rejected > 0) fail(line);
    else success(line);
  }

  if (dryRun) {
    success('Dry-run complete — no real sends were made. Exit 0.');
    return;
  }
  if (anyRejected) {
    fail('Verdict: at least one operation was REJECTED by Meta (see above). Exit 1.');
    process.exitCode = 1;
  } else {
    success('Verdict: no operations were rejected. Exit 0.');
  }
}

/**
 * Batch sweep orchestration: collect messages, place one emoji on each, then
 * hand the operator a worksheet and STOP.
 *
 * It deliberately does not try to reach a verdict. A batch run produces half a
 * result — the API half — and the other half arrives later via `--sweep-apply`.
 * Printing a summary here would invite reading "12 accepted" as "12 delivered",
 * which is precisely the conflation this probe exists to break.
 */
async function runBatchMode(
  capture: CaptureServerHandle,
  targets: readonly Channel[],
  clients: ChannelClients,
  args: ProbeArgs
): Promise<void> {
  const emojis = args.emojiSweep ?? [];
  divider('batch sweep — send your messages');
  info(
    `Send ${emojis.length} short, DISTINCT messages to the bot on each of: ${targets.join(', ')} — ` +
      `"1", "2", "3" … is ideal, since you will read the results off them.`
  );
  info(
    `Each gets ONE emoji, so all ${emojis.length} reactions stay on screen at once. ` +
      `I settle when every channel has ${emojis.length}, or ${BATCH_QUIET_MS / 1000}s after your last message.`
  );

  const { perChannel } = await captureBatch(capture, targets, emojis.length);

  const sweeps: ChannelSweep[] = [];
  for (const channel of targets) {
    const collected = perChannel.get(channel) ?? [];
    if (collected.length === 0) {
      warn(`${channel}: no messages captured — nothing swept.`);
      continue;
    }
    divider(`channel: ${channel}`);
    const client = clients[channel] as ReactionSender | undefined;
    if (!client) {
      warn(`${channel}: not configured — skipped.`);
      continue;
    }
    const outcomes = await runBatchSweep({
      channel,
      client,
      // Every collected inbound on a channel is from the same person (the
      // operator), so the first one's recipient id is the conversation's.
      recipientId: collected[0]!.recipientId,
      targets: collected.map((c) => ({ targetMessageId: c.targetMessageId, text: c.text })),
      emojis,
      pacingMs: args.sweepPacingMs
    });
    sweeps.push({ channel, outcomes });
  }

  if (sweeps.length === 0) {
    warn('No channel produced a sweep. Nothing to report.');
    return;
  }

  divider('now look at your phone');
  process.stdout.write(`${formatBatchWorksheet(sweeps)}\n`);

  const sessionId = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.resolve(process.cwd(), '.captures', 'reaction-sweep');
  const jsonPath = path.join(dir, `${sessionId}-worksheet.json`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(jsonPath, JSON.stringify({ sessionId, sweeps }, null, 2), 'utf8');
    success(`Worksheet saved: ${jsonPath}`);
    info('When you have read the thread, finish it with:');
    info(`  npm run probe:outbound -- --sweep-apply=${jsonPath} --answers="1=y,2=y,3=n,…"`);
  } catch (err) {
    warn(`Could not save the worksheet (${err instanceof Error ? err.message : String(err)}).`);
    warn('Copy the table above before closing this terminal — it is the only record.');
  }
}

/**
 * Apply operator answers to a saved batch worksheet and emit the final report.
 * Pure with respect to the network — no client is constructed and no config is
 * loaded, so it works long after the sweep, on any machine.
 */
async function runApplyMode(args: ProbeArgs): Promise<void> {
  const worksheetPath = args.sweepApply as string;
  if (args.answers === undefined) {
    fail('--sweep-apply needs --answers="1=y,2=n,3=a thumbs up".');
    process.exitCode = 2;
    return;
  }

  let parsed: { sessionId?: string; sweeps?: ChannelSweep[] };
  try {
    parsed = JSON.parse(await readFile(worksheetPath, 'utf8')) as typeof parsed;
  } catch (err) {
    fail(`Could not read the worksheet: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  const sweeps = parsed.sweeps;
  if (!Array.isArray(sweeps) || sweeps.length === 0) {
    fail('That worksheet holds no sweeps.');
    process.exitCode = 1;
    return;
  }

  let answers: Map<number, string>;
  try {
    answers = parseBatchAnswers(args.answers);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    process.exitCode = 2;
    return;
  }

  // Rows are numbered PER CHANNEL in the worksheet, so answers apply per
  // channel too. Reject an answer beyond a channel's row count rather than
  // dropping it — a mis-keyed row would otherwise leave a real row unverified
  // while the operator believed it answered.
  const applied: ChannelSweep[] = [];
  for (const { channel, outcomes } of sweeps) {
    const overflow = [...answers.keys()].filter((row) => row > outcomes.length);
    if (overflow.length > 0) {
      fail(`${channel} has ${outcomes.length} rows, but answers reference row(s) ${overflow.join(', ')}.`);
      process.exitCode = 2;
      return;
    }
    applied.push({ channel, outcomes: applyBatchAnswers(outcomes, answers) });
  }

  const unanswered = applied.flatMap(({ channel, outcomes }) =>
    outcomes
      .map((o, i) => ({ o, row: i + 1, channel }))
      .filter(({ o }) => o.apiAccepted && o.rendered === 'unverified')
  );
  if (unanswered.length > 0) {
    // Loud, because an unanswered row reads as "not deliverable" in the verdict
    // and could be mistaken for a finding.
    warn(
      `${unanswered.length} row(s) went unanswered and stay "unverified" (NOT counted as delivered): ` +
        unanswered.map(({ channel, row }) => `${channel}#${row}`).join(', ')
    );
  }

  await reportSweep(applied, false);
}

/**
 * Report the reaction sweep: the verdict on the console, the full table to a
 * file.
 *
 * WHY it writes a file: the sweep's whole output is a table someone has to read
 * days later while deciding what vocabulary to give a coach, and terminal
 * scrollback is not a record. `.captures/` is already gitignored (it can hold
 * real user ids), which is why the report lands there rather than in `docs/`.
 */
async function reportSweep(sweeps: readonly ChannelSweep[], dryRun: boolean): Promise<void> {
  divider('reaction emoji sweep');

  for (const { channel, outcomes } of sweeps) {
    const delivered = outcomes.filter(isDeliverable).length;
    const line = `${channel.padEnd(10)} delivered=${delivered}/${outcomes.length}`;
    if (delivered === outcomes.length) success(line);
    else fail(line);
  }

  const summary = summarizeSweep(sweeps);
  info(`Deliverable everywhere: ${summary.deliverableEverywhere.join(' ') || '(none)'}`);
  if (summary.partial.length > 0) info(`Deliverable on some channels only: ${summary.partial.join(' ')}`);
  if (summary.neverDeliverable.length > 0) fail(`Never deliverable: ${summary.neverDeliverable.join(' ')}`);
  if (summary.silentDrops.length > 0) {
    // The headline finding. An API accept that rendered nothing is invisible in
    // production — no error, no metric, no log line — so it is the one result
    // that must not scroll past unremarked.
    fail(
      `SILENT DROPS (200 from Meta, nothing on screen): ${summary.silentDrops
        .map((d) => `${d.emoji} on ${d.channel}`)
        .join(', ')}`
    );
  }

  if (dryRun) {
    warn('Dry-run: no reaction actually left this machine, so every verdict above is meaningless.');
    return;
  }

  const sessionId = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.resolve(process.cwd(), '.captures', 'reaction-sweep');
  const file = path.join(dir, `${sessionId}.md`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(file, formatSweepMarkdown(sweeps, sessionId), 'utf8');
    success(`Sweep report: ${file}`);
  } catch (err) {
    warn(`Could not write the sweep report (${err instanceof Error ? err.message : String(err)}). Table above is the record.`);
  }
}

/** Construct only the clients for configured channels (over the shared graph). */
function buildClients(config: Config, graph: GraphClient, logger: pino.Logger): ChannelClients {
  const clients: ChannelClients = {};
  if (config.whatsapp)
    clients.whatsapp = new WhatsAppClient({
      config: config.whatsapp,
      graph,
      apiVersion: config.meta.graphApiVersion,
      logger
    });
  if (config.messenger) clients.messenger = new MessengerClient({ config: config.messenger, graph, logger });
  if (config.instagram) clients.instagram = new InstagramClient({ config: config.instagram, graph, logger });
  return clients;
}

/**
 * Count the operations that will actually attempt a real send (i.e. those NOT
 * pre-skipped by the plan). Dependent ops that may downgrade to skip at runtime
 * are still counted — this is an upper-bound estimate for the confirm prompt.
 */
function countRealOperations(selected: readonly ChannelSelection[], args: ProbeArgs): number {
  // Sweep mode replaces the matrix, so the matrix plan would badly understate
  // it: each emoji is TWO calls (the clear, then the react), plus one final
  // clear per channel. The confirm prompt has to name the real number — it is
  // the operator's only chance to notice they asked for 76 live sends.
  if (args.emojiSweep) {
    const perChannel = args.emojiSweep.length * 2 + 1;
    return selected.filter((sel) => explicitTargetFor(sel.channel, args) !== undefined).length * perChannel;
  }
  let count = 0;
  for (const sel of selected) {
    const explicitTarget = explicitTargetFor(sel.channel, args);
    const plan = planChannelOperations(sel.channel, { hasTarget: explicitTarget !== undefined });
    count += plan.filter((op) => op.skip === undefined).length;
  }
  return count;
}

/** Pretty-print captured dry-run requests grouped by channel (token redacted). */
function printCapturedRequests(captured: readonly CapturedRequest[]): void {
  divider('captured requests (dry-run)');
  if (captured.length === 0) {
    warn('No requests were captured.');
    return;
  }
  for (const req of captured) {
    const channel = channelFromUrl(req.url, req.body);
    info(`[${channel}] ${req.method} ${req.url}`);
    process.stdout.write(`${JSON.stringify({ headers: req.headers, body: req.body }, null, 2)}\n`);
  }
}

/** Label a captured request by channel for grouped printing. */
function channelFromUrl(url: string, body: unknown): string {
  if (url.includes('graph.instagram.com')) return 'instagram';
  if (
    typeof body === 'object' &&
    body !== null &&
    (body as { messaging_product?: unknown }).messaging_product === 'whatsapp'
  ) {
    return 'whatsapp';
  }
  return 'messenger';
}

function makeLogger(): pino.Logger {
  return pino({
    level: process.env['LOG_LEVEL'] ?? 'warn',
    transport: process.stdout.isTTY
      ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' } }
      : undefined
  });
}

function printHelp(): void {
  process.stdout.write(
    [
      `${SCRIPT_NAME} — fire each Stage-4 outbound send method and report exactly`,
      'what the live Meta API accepts or rejects. Two ways to supply the target:',
      'flag/env recipients (default), or --capture (round-trip off a live inbound).',
      '',
      'Usage:',
      '  npm run probe:outbound -- [options]',
      `  npx tsx scripts/setup/${SCRIPT_NAME}.ts [options]`,
      `  npx tsx scripts/setup/${SCRIPT_NAME}.ts --capture        # round-trip mode`,
      '',
      'Options:',
      '  --only=<list>        Restrict channels (whatsapp,messenger,instagram).',
      '                       Default: all configured channels.',
      '  --wa-target=<wamid>  Real INBOUND wamid (a message YOU sent the bot).',
      '                       Used as the WhatsApp reaction/reply target and',
      '                       REQUIRED for WhatsApp typing + markRead (those',
      '                       operate on an inbound message id).',
      '  --fb-target=<mid>    Real INBOUND Messenger mid (reaction/reply target).',
      '  --ig-target=<mid>    Real INBOUND Instagram mid (reaction/reply target).',
      '  --text=<string>      Probe message text. Default includes a timestamp.',
      '  --emoji-sweep[=<v>]  REACTION EMOJI SWEEP. Replaces the operation matrix',
      '                       with a one-emoji-at-a-time reaction sweep against a',
      '                       single inbound message, asking you after each what',
      '                       actually appeared on your device. Answers the one',
      '                       question the API cannot: does a 200 mean the person',
      '                       received it? <v> is a preset',
      `                       (${Object.keys(SWEEP_PRESETS).join(' | ')}; default standard)`,
      '                       or a comma-separated emoji list (--emoji-sweep=🔥,💪).',
      '                       Needs a real inbound target: pair with --capture, or',
      '                       pass --fb-target / --ig-target / --wa-target.',
      '  --sweep-batch        BATCH sweep (needs --capture). Collects N messages',
      '                       from you and puts ONE emoji on EACH, so all the',
      '                       reactions stay on screen at once — you look once,',
      '                       from a screenshot, instead of answering after every',
      '                       send. Needs no interactive terminal. Emits a',
      '                       worksheet; finish it with --sweep-apply.',
      '  --sweep-apply=<f>    Apply your readings to a saved batch worksheet .json',
      '                       and print the final verdict. Offline — no config, no',
      '                       network. Pair with --answers.',
      '  --answers=<spec>     Readings for --sweep-apply, as <row>=<answer> pairs:',
      '                       --answers="1=y,2=n,3=a thumbs up". y = exactly that',
      '                       emoji, n = nothing rendered, anything else = what you',
      '                       actually saw. An unanswered row stays "unverified".',
      '  --sweep-no-prompt    Sweep without the per-emoji device confirmation.',
      '                       API results only — cannot detect a silent drop, and',
      '                       every row is reported "unverified", not "as-sent".',
      '  --sweep-pacing=<ms>  Gap between sweep sends. Default 1200.',
      '  --dry-run            Build + print each request body WITHOUT hitting',
      '                       Meta (uses a capturing fetch — zero real sends).',
      '                       Composes with --capture (real inbound, fake sends).',
      '  --capture            ROUND-TRIP mode: capture a REAL inbound per channel',
      '                       off a live tunnel and fire the full matrix back at',
      '                       that conversation. Each channel is answered AS SOON',
      '                       AS its inbound arrives (not batched): message from',
      '                       WhatsApp and its matrix runs immediately while the',
      '                       others are still awaited. Finishes when every target',
      '                       channel has been handled; a 15-min timeout is only a',
      '                       safety net for channels that never message. IGNORES',
      '                       the E2E_TEST_* recipients and the --*-target flags',
      '                       (the captured inbound supplies both the recipient and',
      '                       the target id). The inbound just arrived, so the 24h',
      '                       window is GUARANTEED open — free-form sends should be',
      '                       accepted, and the WhatsApp typing + markRead ops',
      '                       (which need a real inbound wamid) now RUN. Requires',
      '                       NGROK_AUTHTOKEN.',
      '  --accept-invalid-signatures',
      '                       Capture mode only: still capture inbounds whose',
      '                       X-Hub-Signature-256 fails (e.g. while debugging the',
      '                       Instagram app secret). Default: strict.',
      '  --yes, -y            Skip the confirmation prompt (real mode). Capture',
      '                       mode never prompts — messaging the bot IS the opt-in.',
      '  --help, -h           Show this message.',
      '',
      'IMPORTANT — the 24-hour window:',
      '  Free-form sends (text / reaction / typing / read on Messenger & IG, and',
      '  WhatsApp free-form text) require an OPEN 24h messaging window: the user',
      '  must have messaged the bot within the last 24h. If not, expect',
      '  window-closed REJECTIONS — that is a real API result, not a code bug.',
      '  The WhatsApp hello_world TEMPLATE is the window-independent baseline and',
      '  always runs first. --capture sidesteps this entirely: it captures a live',
      '  inbound first, so the window is guaranteed open for the round-trip.',
      '',
      'Environment (read directly from process.env):',
      '  E2E_TEST_WHATSAPP_NUMBER   E.164 without "+" (WhatsApp recipient).',
      '  E2E_TEST_FACEBOOK_PSID     Messenger recipient PSID.',
      '  E2E_TEST_INSTAGRAM_IGSID   Instagram recipient IGSID.',
      '  (--capture ignores the three E2E_TEST_* vars above.)',
      '  NGROK_AUTHTOKEN            Required for --capture (the tunnel).',
      '  Plus the usual channel credentials (WHATSAPP_*, MESSENGER_*, INSTAGRAM_*).',
      '',
      'Exit code: 0 if nothing was rejected (skips are fine); 1 if any op was',
      'rejected. Dry-run always exits 0.',
      ''
    ].join('\n')
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Script entry point                                                         */
/* ────────────────────────────────────────────────────────────────────────── */

// Ensure the readline reader is cleaned up on Ctrl-C / normal exit. We never
// hard `process.exit()` mid-async — the signal handler sets exitCode and the
// event loop drains (see console.ts).
registerShutdown(() => {
  closePrompts();
});

// Detect "run as script" — same convention as verify-whatsapp.ts: resolve both
// argv[1] and import.meta.url to absolute paths so the match holds regardless
// of relative-path quirks.
const invokedAsScript = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    const thisFile = new URL(import.meta.url).pathname;
    return path.resolve(entry) === path.resolve(thisFile);
  } catch {
    return false;
  }
})();

if (invokedAsScript) {
  main()
    .catch((err) => {
      fail(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = process.exitCode ?? 1;
    })
    .finally(() => {
      closePrompts();
    });
}
