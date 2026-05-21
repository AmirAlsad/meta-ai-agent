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
  /** Print usage and exit. */
  help: boolean;
}

const VALID_CHANNELS: ReadonlySet<Channel> = new Set(ALL_CHANNELS);

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
  text: string
): Promise<OperationOutcome[]> {
  const { channel, recipientId } = resolved;
  const explicitTarget = resolved.targetMessageId;
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

  return outcomes;
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
): Promise<OperationOutcome[]> {
  const explicitTarget = explicitTargetFor(sel.channel, args);
  const resolved: ResolvedChannel = {
    channel: sel.channel,
    recipientId: sel.recipient,
    ...(explicitTarget !== undefined ? { targetMessageId: explicitTarget } : {})
  };
  return runResolvedChannel(resolved, clients, args.text);
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
  for (const sel of selected) {
    divider(`channel: ${sel.channel}`);
    const outcomes = await runChannel(sel, clients, args);
    if (!args.dryRun) {
      for (const o of outcomes) reportOutcome(o);
    } else {
      // In dry-run, accepted means "body built + captured" (no real result);
      // skips are still meaningful. Report them so the plan is visible.
      for (const o of outcomes) reportOutcome(o);
    }
    perChannel.push({ channel: sel.channel, outcomes });
  }

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

    divider('waiting for inbound');
    info(
      `Message the bot now from each channel you want to test: ${targets.join(', ')}. ` +
        `Each channel is answered AS SOON AS its message arrives (not batched). ` +
        `Safety-net timeout ${CAPTURE_TIMEOUT_MS / 60000} min. Ctrl-C to stop.`
    );

    // Drive the on-arrival flow: subscribe, run each channel's matrix on arrival
    // through a serialized queue, finish when all targets are handled (or the
    // safety-net timeout fires). Returns the per-channel outcomes that ran.
    const { perChannel, handled } = await captureOnArrival({
      capture,
      targets,
      clients,
      text: args.text
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

interface CaptureOnArrivalArgs {
  capture: CaptureServerHandle;
  targets: readonly Channel[];
  clients: ChannelClients;
  text: string;
}

interface CaptureOnArrivalResult {
  /** Per-channel outcomes, in the order the channels were handled. */
  perChannel: Array<{ channel: Channel; outcomes: OperationOutcome[] }>;
  /** The set of channels that were handled (an inbound arrived + matrix ran). */
  handled: Set<Channel>;
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
  const { capture, targets, clients, text } = args;
  return new Promise((resolve) => {
    const handled = new Set<Channel>();
    const perChannel: Array<{ channel: Channel; outcomes: OperationOutcome[] }> = [];

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
      void Promise.resolve(worker).then(() => resolve({ perChannel, handled }));
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
        const outcomes = await runResolvedChannel(resolved, clients, text);
        for (const o of outcomes) reportOutcome(o);
        perChannel.push({ channel: inbound.channel, outcomes });
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
