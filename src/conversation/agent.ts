/**
 * The central conversation state machine.
 *
 * `ConversationAgent` bridges parsed inbound webhooks to the developer's chat
 * endpoint and manages ordered outbound delivery across all three Meta channels
 * (WhatsApp / Messenger / Instagram). It owns the per-conversation lifecycle:
 *
 *   idle → buffering → processing → sending → idle
 *
 * - `handleInbound` claims the message (dedupe), appends it to the conversation
 *   buffer, and (re)arms a flush timer (state: `buffering`).
 * - the scheduler-driven `flush` snapshots the buffer, calls the chat endpoint
 *   (state: `processing`), builds the outbound queue from the response, and
 *   kicks off delivery (state: `sending`).
 * - `sendNext` drives ordered delivery one item at a time. Advancement is
 *   CHANNEL-AWARE: Messenger/Instagram advance the moment a send returns
 *   (`on_send`); WhatsApp waits for a delivery/sent status webbook
 *   (`on_status`), with a delivery-timeout fallback so a missing status never
 *   wedges the queue.
 * - `handleStatus` correlates an inbound status callback back to the in-flight
 *   queue item and advances WhatsApp's queue.
 *
 * Stage 5 scope deliberately EXCLUDES limits/retries, group routing, SMS, and
 * contact upsert (those are Stages 6/10). Everything here FAILS SOFT: the HTTP
 * layer has already ACKed the webhook with 200, so chat-endpoint errors and
 * adapter send errors are logged and swallowed — never thrown out of a
 * `handle*` method.
 */

import { randomUUID } from 'node:crypto';
import type pino from 'pino';
import type { ChatClient } from '../chat/client.js';
import { ChatEndpointError } from '../chat/errors.js';
import type { ChatRequest, NormalizedChatResponse } from '../chat/types.js';
import type { Config } from '../config/loader.js';
import {
  advanceCursor,
  advancementMode,
  buildOutboundItems,
  currentItem,
  isQueueComplete,
  statusAdvancesQueue
} from '../delivery/queue.js';
import type { QueueState } from '../delivery/types.js';
import { MetaApiError } from '../meta/shared/errors.js';
import type {
  ChannelAdapter,
  ChannelFeature,
  TemplateComponent
} from '../meta/shared/adapter.js';
import { inferMediaKind } from '../meta/shared/media.js';
import type { InboundMediaHydrator } from '../meta/shared/media-hydrator.js';
import type { Channel, IncomingMessage, StatusUpdate } from '../meta/types.js';
import type { WhatsAppClient } from '../meta/whatsapp/client.js';
import type { AgentMetrics } from '../metrics/registry.js';
import { normalizeErrorCodeLabel } from '../metrics/registry.js';
import type { IdentityResolver } from '../identity/resolver.js';
import type { LimitTracker } from '../limits/tracker.js';
import type { StatusTracker } from '../status/tracker.js';
import { calculateBufferTimeout } from './buffering.js';
import type { BufferScheduler } from './scheduler.js';
import type { ConversationStore } from './store.js';
import type { ConversationRecord } from './types.js';
import {
  conversationKeyFor,
  createIdleConversation,
  isWindowOpen,
  MESSAGING_WINDOW_MS
} from './types.js';

/**
 * Request-scoped options threaded through every public handler. `traceId` is
 * persisted on the conversation record (as in Stage 5); `logger` is an OPTIONAL
 * request-scoped child (carrying that traceId) that, when present, is preferred
 * over the agent's base logger for THAT operation's logging — so a log line
 * emitted while handling one webhook carries the same trace id the HTTP layer
 * already stamped, without re-deriving it.
 */
export interface HandleOptions {
  traceId?: string;
  logger?: pino.Logger;
}

/**
 * Every {@link ChannelFeature} value, enumerated once so {@link
 * ConversationAgent.capabilitiesOf} can build the chat request's `capabilities`
 * truth set by filtering this list through `adapter.supports`. A union type has
 * no runtime form, so the agent needs this concrete list to iterate.
 */
const ALL_CHANNEL_FEATURES: readonly ChannelFeature[] = [
  'typing_indicator',
  'read_receipt',
  'reaction',
  'reply_to',
  'template',
  'persistent_menu',
  'get_started',
  'ice_breakers',
  'story_reply',
  'media_send'
];

/** Default delay between a typing indicator and the text it precedes (ms). */
const DEFAULT_TYPING_DELAY_MS = 800;
/** Cap on the derived typing delay so a long refresh interval can't stall sends. */
const MAX_TYPING_DELAY_MS = 1500;
/**
 * Hard ceiling for an EXPLICIT `{ type: 'typing', durationMs }` chat action.
 * The duration is honored (the bubble is held before the queue advances) but
 * bounded — `sendNext` holds the per-key lock while it waits, so an unbounded
 * duration from the chat endpoint would stall every other inbound for that
 * conversation. 10s is generous for a deliberate "show typing" beat.
 */
const MAX_EXPLICIT_TYPING_DURATION_MS = 10_000;

/**
 * Maximum number of times a single turn may be deferred + rebatched because a
 * late message interrupted its in-flight chat call (the interrupt/rebatch flow
 * in {@link ConversationAgent.handleInboundImpl} / {@link
 * ConversationAgent.flushImpl}). Once a turn has reprocessed this many times, the
 * NEXT flush processes whatever it has WITHOUT deferring again (logging a warn) —
 * so a user typing a steady, never-ending stream of messages eventually gets a
 * response instead of starving forever. Reset to 0 on every clean turn.
 */
const MAX_REPROCESS = 5;

/**
 * Floor for the boot-recovery claim TTL (seconds) — covers the simultaneous-boot
 * race window across replicas plus the quick un-wedge action. Kept SHORT (not the
 * conversation lifetime) so a claimer that crashes before completing recovery
 * doesn't block every other replica from re-recovering for hours; see
 * {@link ConversationAgent.recoverPendingRetries}.
 */
const RECOVERY_CLAIM_MIN_TTL_SECONDS = 120;

/** Grace added past a transient retry's remaining delay when sizing its claim TTL. */
const RECOVERY_CLAIM_GRACE_SECONDS = 60;

export interface ConversationAgentDeps {
  store: ConversationStore;
  scheduler: BufferScheduler;
  chatClient: ChatClient;
  /** Configured channel adapters, keyed by channel. Only present channels are wired. */
  adapters: Partial<Record<Channel, ChannelAdapter>>;
  config: Config;
  logger: pino.Logger;
  /** Injectable [0,1) source for buffer jitter; defaults to `Math.random`. */
  random?: () => number;
  /** Injectable clock (ms) for timestamps/window checks; defaults to `Date.now`. */
  now?: () => number;
  /** Injectable sleep so tests don't really wait; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * OPTIONAL Stage 6 observability. ALL THREE are additive: when absent the agent
   * behaves exactly as in Stage 5 (metric calls are skipped via optional-chain,
   * identity enrichment is treated as `disabled`, status history is not tracked).
   */
  metrics?: AgentMetrics;
  /** Optional identity enrichment, fail-open. Absent ⇒ never resolve a contact. */
  identityResolver?: IdentityResolver;
  /** Optional delivery-status history sink. Absent ⇒ no status tracking. */
  statusTracker?: StatusTracker;
  /**
   * OPTIONAL inbound media hydrator (opt-in, additive). When present, the flush
   * path downloads each buffered message's media and attaches a base64 data URL
   * to `message.media.dataUrl` before the chat call, so the endpoint can see
   * WhatsApp media it can't fetch itself. Absent ⇒ no hydration, exactly today's
   * behavior. `buildRuntime` only constructs one when
   * `config.conversation.inboundMediaDownload` is true. Fail-open: never throws.
   */
  mediaHydrator?: InboundMediaHydrator;
  /**
   * OPTIONAL Stage 10 limits surface — additive. Absent ⇒ no outbound pacing, no
   * transient retry (a failed send is skipped immediately, exactly as Stage 5),
   * and no WhatsApp out-of-window re-prompt (a closed-window error is also just
   * skipped). When present, `sendNext` acquires a pacing slot before each
   * outbound MESSAGE send, classifies send errors (transient / window_closed /
   * permanent), retries transient failures up to the configured cap, and
   * re-prompts ONCE on a WhatsApp closed window. `buildRuntime` constructs one
   * unconditionally (it fail-opens), so this is wired in production.
   */
  limitTracker?: LimitTracker;
}

export class ConversationAgent {
  private readonly store: ConversationStore;
  private readonly scheduler: BufferScheduler;
  private readonly chatClient: ChatClient;
  private readonly adapters: Partial<Record<Channel, ChannelAdapter>>;
  private readonly config: Config;
  private readonly logger: pino.Logger;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** OPTIONAL Stage 6 deps — undefined ⇒ that observability facet is inert. */
  private readonly metrics?: AgentMetrics;
  private readonly identityResolver?: IdentityResolver;
  private readonly statusTracker?: StatusTracker;
  private readonly mediaHydrator?: InboundMediaHydrator;
  /** OPTIONAL Stage 10 limits surface — undefined ⇒ no pacing/retry/window re-prompt. */
  private readonly limitTracker?: LimitTracker;

  /**
   * Per-conversation delivery-timeout fallback timers, keyed by conversation
   * key. Only WhatsApp (`on_status`) arms these — if a delivery/sent status
   * never arrives, the timer advances the queue so it cannot wedge forever.
   */
  private readonly deliveryTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Per-conversation transient-retry timers, keyed by conversation key (Stage 10).
   * Armed by {@link scheduleTransientRetry} when a transient send error leaves the
   * in-flight item to be re-sent after a backoff delay. Clear-before-arm (one per
   * key, mirroring {@link startDeliveryTimeout}) so a key never has two outstanding
   * retry timers. The timer is a true ENTRY POINT (fires outside any held lock), so
   * it re-acquires the per-key lock before running {@link runTransientRetryImpl}.
   */
  private readonly transientRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * The original {@link ChatRequest} for the turn currently `sending`, kept so a
   * WhatsApp out-of-window failure can re-prompt the chat endpoint with the SAME
   * input (asking it to reply with a template). In-memory ONLY — lost on restart,
   * which is fine: the re-prompt is a same-turn best-effort recovery, not durable
   * state. Set in {@link flushImpl} when a turn commits to sending; cleared at
   * every turn boundary ({@link finalizeTurn} / {@link transitionToIdle} /
   * {@link interruptSending} / {@link close}).
   */
  private readonly pendingRequests = new Map<string, ChatRequest>();

  /**
   * Per-conversation-key {@link AbortController} for the chat call currently in
   * flight (state `processing`). Set by {@link flushImpl} just before it AWAITs
   * the chat call (outside the lock) and cleared right after. When an inbound
   * arrives for a key whose chat call is in flight, {@link handleInboundImpl}
   * aborts it here so the wasted call is cancelled and the turn is rebatched with
   * the late message — producing ONE combined response instead of two.
   */
  private readonly inFlightChatAborts = new Map<string, AbortController>();

  /**
   * Per-conversation-key serialization tails. Each value is the promise that
   * settles when the LAST-enqueued exclusive op for that key finishes. A new op
   * chains onto the existing tail so no two read-modify-write flows for the SAME
   * key interleave across an `await`. See {@link runExclusive}.
   *
   * WHY this is load-bearing: the store is pass-by-value with last-write-wins
   * (no atomic read-modify-write). Two concurrent flows for one key both read
   * the same clone, both mutate, both write — the second write clobbers the
   * first and a user message (or a queue advance) is silently lost. The
   * dispatcher fires inbounds/statuses concurrently and a single webhook can
   * batch many messages for one conversation, so this race is routine, not
   * theoretical. Serializing per key closes it; different keys still run
   * concurrently (the map is keyed, never a global lock).
   */
  private readonly keyTails = new Map<string, Promise<unknown>>();

  constructor(deps: ConversationAgentDeps) {
    this.store = deps.store;
    this.scheduler = deps.scheduler;
    this.chatClient = deps.chatClient;
    this.adapters = deps.adapters;
    this.config = deps.config;
    this.logger = deps.logger;
    this.random = deps.random ?? Math.random;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
    this.metrics = deps.metrics;
    this.identityResolver = deps.identityResolver;
    this.statusTracker = deps.statusTracker;
    this.mediaHydrator = deps.mediaHydrator;
    this.limitTracker = deps.limitTracker;

    // Register the buffer-flush handler exactly once. The scheduler fires this
    // after a conversation's burst window elapses (see calculateBufferTimeout).
    // The scheduler timer fires OUTSIDE any held lock, so this is a true entry
    // point.
    //
    // NOTE (changed for the batching fix): flushImpl is NO LONGER wrapped in a
    // single runExclusive that spans the whole flush. The chat call is slow, and
    // holding the per-key lock across it blocked every concurrent handleInbound
    // for that key — so a second message couldn't interrupt/rebatch the in-flight
    // turn and produced a SECOND response. flushImpl now acquires the lock only
    // around its record read-modify-write SEGMENTS and RELEASES it during the
    // awaited chat call (see flushImpl's doc + the locking comments inside it).
    this.scheduler.setHandler(async (conversationKey, options) => {
      await this.flushImpl(conversationKey, options);
    });
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /* Per-key serialization (the concurrency lock)                             */
  /*                                                                          */
  /* ENTRY-POINT vs INTERNAL split — read before editing any handle* method:  */
  /*                                                                          */
  /*  ACQUIRE the lock (true entry points, each fired OUTSIDE any held lock): */
  /*    • handleInbound, handleStatus            (public; called by the HTTP   */
  /*      dispatcher concurrently per webhook)                                 */
  /*    • recoverPendingRetries                  (public; called once at boot) */
  /*    • the delivery-timeout callback          (startDeliveryTimeout's       */
  /*      setTimeout; fired by a delivery timer)                               */
  /*    • the transient-retry callback           (scheduleTransientRetry's     */
  /*      setTimeout; fired by a retry timer — Stage 10)                       */
  /*    • handleReaction DOES NOT acquire — it delegates to handleInbound,     */
  /*      which acquires, so it inherits the lock (acquiring here too would    */
  /*      deadlock the chain: a holder calling a same-key acquirer).           */
  /*                                                                          */
  /*  SEGMENTED locking (the batching fix):                                    */
  /*    • flushImpl is fired by the scheduler OUTSIDE any held lock and        */
  /*      acquires the lock ITSELF, but only around its record read-modify-    */
  /*      write SEGMENTS — it RELEASES the lock for the slow chat call so a     */
  /*      concurrent handleInbound can interrupt/rebatch the in-flight turn.    */
  /*      See flushImpl's doc for the full model + race-free argument.          */
  /*                                                                          */
  /*  DO NOT acquire (internal; ONLY ever reached from within a holder, so    */
  /*  they assume the lock is already held):                                   */
  /*    • sendNext, advanceAndContinue, markSkippedAndAdvance,                 */
  /*      transitionToIdle, onDeliveryTimeoutImpl, handleInboundImpl,          */
  /*      handleStatusImpl, interruptSending, finalizeTurn,                    */
  /*      scheduleTransientRetry, runTransientRetryImpl, handleWindowClosed    */
  /*      (the last three are Stage 10: each is called from sendNext or a      */
  /*      timer's runExclusive, so the lock is already held)                   */
  /*                                                                          */
  /*  NO-DEADLOCK INVARIANT: no lock-holding (acquired) path ever calls        */
  /*  another lock-acquiring method for the SAME key. The acquiring methods    */
  /*  call ONLY the *Impl bodies (and flushImpl's lock-free segment bodies),   */
  /*  and none of those calls a lock acquirer for the same key. The promise    */
  /*  chain is therefore strictly linear per key and cannot wait on itself.    */
  /* ──────────────────────────────────────────────────────────────────────── */

  /**
   * Run `fn` exclusively with respect to all other exclusive ops for `key`:
   * chain it onto the key's existing tail so it starts only after the prior op
   * for that key has settled, then make IT the new tail.
   *
   * Design notes (all load-bearing):
   *  - `fn` runs regardless of whether the PRIOR op resolved or rejected (we
   *    chain off a swallowed `.then(noop, noop)` view of the tail). One flow's
   *    failure must not skip a queued flow.
   *  - The tail stored in the map is a SWALLOWED promise (`.then(noop, noop)`),
   *    so a rejecting op never poisons the chain into an unhandled rejection —
   *    yet the CALLER still receives the real result/rejection via `result`.
   *  - Map cleanup: when this op is still the current tail after it settles, we
   *    delete the entry so the map can't grow unbounded across many keys. If a
   *    newer op already replaced the tail, we leave it for that op to clean up.
   */
  private runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.keyTails.get(key) ?? Promise.resolve();
    // Start `fn` only after the prior op settles (success OR failure).
    const result = prior.then(() => fn(), () => fn());
    // The tail is a SWALLOWED view so a rejection here is never unhandled and
    // never propagates to the next op as a rejection.
    const tail = result.then(
      () => {},
      () => {}
    );
    this.keyTails.set(key, tail);
    // Best-effort cleanup once this op's tail settles, but only if no newer op
    // has since taken over the tail for this key.
    void tail.finally(() => {
      if (this.keyTails.get(key) === tail) this.keyTails.delete(key);
    });
    return result;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /* Inbound                                                                  */
  /* ──────────────────────────────────────────────────────────────────────── */

  /**
   * Ingest one parsed inbound message: filter echoes, dedupe, append to the
   * conversation buffer, and (re)arm the flush timer. Fails soft — the webhook
   * is already ACKed, so any error here is logged, never thrown.
   *
   * PUBLIC ENTRY POINT: acquires the per-key lock so concurrent inbounds for the
   * SAME conversation can't clobber each other's buffer append (see the
   * entry-point/internal comment block above {@link runExclusive}).
   */
  async handleInbound(message: IncomingMessage, opts?: HandleOptions): Promise<void> {
    await this.runExclusive(conversationKeyFor(message), () => this.handleInboundImpl(message, opts));
  }

  /** Lock-free body of {@link handleInbound}. Assumes the per-key lock is held. */
  private async handleInboundImpl(message: IncomingMessage, opts?: HandleOptions): Promise<void> {
    const traceId = opts?.traceId;
    // WHY prefer opts.logger: when the HTTP layer supplies a request-scoped child
    // (already carrying this request's traceId + route), reusing it keeps THIS
    // operation's log lines correlated to the originating webhook. Absent one we
    // fall back to a child built from traceId (or the base logger).
    const logger = opts?.logger ?? this.childLogger(traceId);
    try {
      // WHY filter echoes: Meta echoes business-sent messages back on the same
      // webhook (Messenger/IG `is_echo`). Treating an echo as inbound would loop
      // the agent's own output back into the chat endpoint, so drop it here.
      if (message.isEcho) {
        logger.debug(
          { channel: message.channel, channelMessageId: message.channelMessageId },
          'skipping own echo'
        );
        return;
      }

      // PRIMARY dedupe: an atomic SETNX-with-TTL claim. A redelivered webhook
      // (Meta retries until it sees a 200) returns false here and is dropped so
      // a single inbound is processed exactly once.
      const claimed = await this.store.claimInboundHandle(message.channelMessageId);
      this.metrics?.inboundDedupe.inc({ result: claimed ? 'claimed' : 'duplicate' });
      if (!claimed) {
        logger.debug(
          { channel: message.channel, channelMessageId: message.channelMessageId },
          'skipping duplicate inbound (already claimed)'
        );
        return;
      }
      // A genuinely-new (claimed) message accepted for processing.
      this.metrics?.inboundMessages.inc({ channel: message.channel, type: message.type });

      const key = conversationKeyFor(message);
      const now = this.now();
      const record =
        (await this.store.getConversation(key)) ??
        createIdleConversation({
          key,
          channel: message.channel,
          channelScopedUserId: message.channelScopedUserId,
          channelScopedBusinessId: message.channelScopedBusinessId,
          now
        });

      // Identity enrichment (Stage 6, OPTIONAL + fail-open). Runs UNDER the per-key
      // lock (handleInboundImpl already holds it) so the awaited resolve serializes
      // with other ops for this key, then rides on the chat request via
      // `record.contact`. Enrich only when not already set, so the lookup endpoint
      // is hit at most once per conversation.
      //
      // WHY a coarse `resolved | none | disabled` metric split: the resolver
      // contract returns `undefined` INDISTINGUISHABLY for a cache miss, an HTTP
      // miss, a non-2xx, a timeout, or a parse failure (fail-open swallows the
      // reason). We therefore cannot honestly emit the registry's finer labels
      // (cached/error/...) from here — the only facts we can observe are "we had a
      // resolver and it produced a contact" (resolved), "we had a resolver and it
      // produced nothing" (none), and "no resolver wired" (disabled).
      if (record.contact !== undefined) {
        // Already enriched on a prior inbound — skip the lookup entirely (no
        // re-resolve). Not counted: there was no lookup outcome to record.
      } else if (this.identityResolver) {
        try {
          const contact = await this.identityResolver.resolve({
            channel: message.channel,
            channelScopedUserId: message.channelScopedUserId,
            channelScopedBusinessId: message.channelScopedBusinessId
          });
          if (contact) {
            record.contact = contact;
            this.metrics?.identityLookupTotal.inc({ result: 'resolved' });
          } else {
            this.metrics?.identityLookupTotal.inc({ result: 'none' });
          }
        } catch (error) {
          // resolve() is contractually fail-open and never throws, but stay
          // defensive: a misbehaving resolver must not break message delivery.
          this.metrics?.identityLookupTotal.inc({ result: 'none' });
          logger.warn({ err: error, channel: message.channel }, 'identity resolve threw; proceeding without enrichment');
        }
      } else {
        // No resolver wired (or a Noop) — enrichment is disabled for this deploy.
        this.metrics?.identityLookupTotal.inc({ result: 'disabled' });
      }

      // Refresh activity/window bookkeeping for EVERY accepted inbound. The 24h
      // messaging window restarts from every inbound (`lastInboundAt + 24h`).
      record.lastInboundAt = now;
      record.windowExpiresAt = now + MESSAGING_WINDOW_MS;
      record.lastActivity = now;
      record.lastInboundMessageId = message.channelMessageId;
      if (traceId !== undefined) record.traceId = traceId;

      // STATE-BRANCH on the conversation's lifecycle phase. This is the crux of
      // the batching fix: where the message lands (and whether we (re)arm a flush
      // or interrupt one) depends on what the turn is currently doing.
      switch (record.state) {
        case 'idle':
        case 'buffering': {
          // Normal accumulation: append to the buffer, (re)arm the flush timer so
          // a rapid burst aggregates into ONE flush rather than N chat calls.
          record.inboundBuffer.push(message);
          record.state = 'buffering';
          await this.store.setConversation(record);

          // LOCK SAFETY: we're holding the per-key lock here. `scheduler.schedule`
          // with `delayMs > 0` only registers a setTimeout and returns — the flush
          // handler (which re-acquires the SAME key's lock) fires LATER, outside
          // this lock, so there is no self-deadlock. A `delayMs <= 0` would make
          // the scheduler fire the handler INLINE (synchronously), which WOULD
          // deadlock the chain. `calculateBufferTimeout` never returns <= 0 for a
          // valid config (bufferBaseTimeoutMs is a positive int, clamped to >=
          // base*0.5), so this stays safe — keep that invariant if the buffer math
          // changes.
          const delayMs = calculateBufferTimeout(
            record.inboundBuffer.length,
            this.config.conversation,
            this.random
          );
          await this.scheduler.schedule(key, delayMs, traceId !== undefined ? { traceId } : undefined);
          break;
        }
        case 'processing': {
          // A message arrived WHILE the flush's chat call is in flight. The buffer
          // was already snapshotted + cleared by flushImpl, so appending here
          // would be re-sent in THIS turn (or lost). Instead stash it in
          // `lateArrivals` and ABORT the in-flight chat call so the (now stale)
          // request is cancelled — don't waste it. We do NOT schedule a new flush:
          // flushImpl's post-chat reprocess check sees `lateArrivals.length > 0`,
          // folds `[...batch, ...lateArrivals]` back into the buffer, and arms a
          // fresh flush. Net effect: the two messages become ONE combined
          // response instead of two.
          record.lateArrivals.push(message);
          await this.store.setConversation(record);
          // ABORT-ONLY-IF-A-CONTROLLER-IS-PRESENT: a flush that is at the reprocess
          // cap is COMMITTED — flushImpl registers NO AbortController for it (see
          // flushImpl's "committed flush" segment), so it must run to completion and
          // SEND its response. Finding no controller here means "don't interrupt";
          // the late arrival still sits in `lateArrivals`, where flushImpl's
          // finalization turns it into a fresh FOLLOW-UP turn. For a normal
          // (interruptible) flush a controller IS present and we abort it to rebatch.
          const inFlight = this.inFlightChatAborts.get(key);
          if (inFlight) inFlight.abort();
          break;
        }
        case 'sending': {
          // Mid-delivery interrupt: a new message arrived while we were sending a
          // previous turn's outbound queue. Roll the turn back to `buffering` with
          // the new message so the user gets ONE coherent follow-up that accounts
          // for what they just said, rather than the rest of a now-stale reply
          // followed by a second reply. Mirrors the reference's interruptSending.
          //
          // SCOPE — mid-delivery rebatch is observable only on `on_status` channels:
          // WhatsApp (on_status) AWAITS a per-message delivery-status callback
          // between queue items (sendNext returns after each send and resumes via
          // handleStatus), so the per-key lock is RELEASED between items. A new
          // inbound landing in that gap can therefore acquire the lock, observe the
          // `sending` state, and reach this branch to interrupt + rebatch.
          //
          // `on_send` channels (Messenger/Instagram) have no per-message delivery
          // webhook, so segment 3 drains the WHOLE queue synchronously under ONE
          // runExclusive (sendNext → advanceAndContinue → sendNext, no external
          // awaits that yield the lock — the send loop is fast). An inbound arriving
          // mid-delivery cannot acquire the lock; it queues BEHIND segment 3 and runs
          // only after the queue drains and finalizeTurn has moved the record to
          // `idle` (or `buffering` if `lateArrivals` existed). By then state is no
          // longer `sending`, so this branch is not hit — the message is buffered as
          // a normal NEXT turn (the `idle`/`buffering` case above) and gets its own
          // response. That is correct and lossless: an on_send message is never
          // dropped, it is simply delivered as a subsequent turn rather than rebatched
          // into the in-flight one. See the on_send no-drop regression test in
          // `tests/unit/conversation-agent.test.ts`.
          await this.interruptSending(record, message, traceId);
          break;
        }
      }
    } catch (error) {
      logger.error(
        { err: error, channel: message.channel, channelMessageId: message.channelMessageId },
        'handleInbound failed'
      );
    }
  }

  /**
   * Ingest a reaction. A reaction IS an {@link IncomingMessage} (`type:
   * 'reaction'`) with a populated `.reaction`, so it flows through the SAME
   * buffer as any other message and reaches the chat endpoint inside
   * `messages[]` with `.reaction` intact.
   *
   * WHY delegate rather than take a separate path: a parallel reaction pipeline
   * would race the buffer/flush of normal messages for the same conversation
   * (two concurrent writers to one record). Funnelling reactions through
   * `handleInbound` keeps a single ordered writer and lets the endpoint see the
   * reaction in the structured array alongside the surrounding turn.
   *
   * LOCK: this does NOT acquire the per-key lock — it delegates to
   * `handleInbound`, which acquires. Acquiring here too would deadlock (a
   * lock-holder calling a same-key acquirer). See the runExclusive comment block.
   */
  async handleReaction(message: IncomingMessage, opts?: HandleOptions): Promise<void> {
    await this.handleInbound(message, opts);
  }

  /**
   * Interrupt an in-flight `sending` turn so a message that arrived mid-delivery
   * is folded into a fresh, combined turn. Mirrors the reference's
   * `interruptSending`, adapted to our queue/lock model.
   *
   * Called ONLY from {@link handleInboundImpl} (the `sending` branch), so the
   * per-key lock is already held — every record read-modify-write below is part
   * of that one critical section. We:
   *   - clear the delivery-timeout fallback for this key (the old turn's queue is
   *     being abandoned, so its timer must not fire against a stale index);
   *   - drop the in-flight outbound-handle mapping (a late status for the
   *     abandoned item must not advance the new turn);
   *   - reset the outbound queue + cursor, stash the new message in the buffer,
   *     reset `reprocessCount`, and return to `buffering`;
   *   - (re)arm a flush so the rebatched input produces one combined response.
   *
   * WHY full interrupt (not just defer): once we are `sending`, the chat call for
   * the old turn already returned, so there is no in-flight chat to abort and
   * deferring to a reprocess can't help — the queue would keep draining stale
   * replies. Rolling back to `buffering` with the new message is what gives the
   * user a single coherent follow-up. Unsent queue items are simply dropped
   * (Stage 5 has no "cancelled message" surface; the chat endpoint re-decides the
   * whole reply from the combined buffer on the next flush).
   */
  private async interruptSending(
    record: ConversationRecord,
    message: IncomingMessage,
    traceId?: string
  ): Promise<void> {
    const key = record.key;
    this.clearDeliveryTimeout(key);
    // Stage 10: the old turn is being abandoned — cancel any pending retry timer
    // and drop its stashed re-prompt request so a fresh rebatched turn starts clean.
    this.clearTransientRetryTimer(key);
    this.pendingRequests.delete(key);
    if (record.currentOutboundMessageId !== undefined) {
      await this.store.deleteOutboundHandleMapping(record.currentOutboundMessageId);
    }

    // FINDING 1 (message-drop fix): fold any STASHED `lateArrivals` into the
    // buffer BEFORE clearing them, in order. A committed flush registers no
    // AbortController, so inbounds that land while its chat call is in flight sit
    // in `lateArrivals` (not aborting). Segment 2 then preserves those on the
    // record and transitions to `sending`; between segments 2 and 3 a NEW inbound
    // can see `sending` and call `interruptSending`. Clearing `lateArrivals`
    // unconditionally here would permanently drop those stashed messages,
    // violating the "nothing dropped during a committed flush" guarantee. Order:
    // existing buffer, then the stashed late arrivals, then the new message.
    record.inboundBuffer = [...record.inboundBuffer, ...record.lateArrivals, message];
    record.lateArrivals = [];
    record.outboundQueue = [];
    record.currentOutboundIndex = 0;
    delete record.currentOutboundMessageId;
    record.reprocessCount = 0;
    record.state = 'buffering';
    record.lastActivity = this.now();
    await this.store.setConversation(record);

    const delayMs = calculateBufferTimeout(record.inboundBuffer.length, this.config.conversation, this.random);
    await this.scheduler.schedule(key, delayMs, traceId !== undefined ? { traceId } : undefined);
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /* Flush (buffering → processing → sending)                                 */
  /* ──────────────────────────────────────────────────────────────────────── */

  /**
   * Buffer-flush body. Snapshots the buffered turn, calls the chat endpoint, and
   * starts ordered delivery of the resulting actions.
   *
   * THE LOCKING MODEL (changed for the batching fix — read before editing):
   * unlike the other handlers, flushImpl is NOT wrapped in a single
   * {@link runExclusive} by its caller (the scheduler handler). The chat call is
   * slow, and holding the per-key lock across it blocked every concurrent
   * handleInbound for that key, which is exactly what produced TWO responses for
   * two messages sent close together. So flushImpl ACQUIRES the lock only around
   * its record read-modify-write SEGMENTS and RELEASES it while it awaits the
   * chat call:
   *
   *   [lock] load record, snapshot+clear buffer, set `processing`, store an
   *          AbortController, save                                  [unlock]
   *      → AWAIT chatClient.complete(request, signal)  ← NO LOCK HELD HERE
   *   [lock] re-read record; if late arrivals → rebatch + reschedule + return,
   *          else attach the outbound queue + set `sending`, save   [unlock]
   *      → run the send loop (sendNext) under one more locked segment.
   *
   * WHY THIS IS STILL RACE-FREE (the Stage 5 clobber-prevention is preserved):
   * every record mutation here is a COMPLETE locked read-modify-write — load,
   * mutate, save, all inside one runExclusive — so two flows for the same key can
   * never both read the same clone and clobber each other. The only thing moved
   * OUTSIDE the lock is the chat call, which mutates NOTHING (it just produces a
   * response into a local var) until it re-acquires the lock to apply its result.
   * A concurrent handleInbound that lands during the unlocked chat call therefore
   * runs a full, isolated read-modify-write of its own (appending to lateArrivals
   * + aborting the chat) — and the post-chat re-read segment observes that and
   * rebatches. Lock guards record mutations, not chat I/O.
   *
   * INTERNAL: only the scheduler handler calls this. It must NOT itself be called
   * from inside a held lock for `key` (it acquires the lock), and it never calls
   * a lock-acquiring handler for `key` (only the lock-free *Impl helpers, each
   * inside its own runExclusive segment) — so the no-deadlock invariant holds.
   */
  private async flushImpl(key: string, opts?: { traceId?: string }): Promise<void> {
    const traceId = opts?.traceId;
    const logger = this.childLogger(traceId);
    try {
      // ── Locked segment 1: snapshot the buffer, enter `processing`, arm abort ──
      const prep = await this.runExclusive(key, async () => {
        const record = await this.store.getConversation(key);
        if (!record || record.inboundBuffer.length === 0) {
          // Nothing to flush (already drained by a prior flush, or no record).
          return undefined;
        }
        const adapter = this.adapters[record.channel];
        if (!adapter) {
          // Channel not configured (no adapter wired) — cannot send a reply.
          logger.warn({ conversationKey: key, channel: record.channel }, 'no adapter for channel; dropping turn');
          record.state = 'idle';
          delete record.currentOutboundMessageId;
          record.lastActivity = this.now();
          await this.store.setConversation(record);
          return undefined;
        }

        // WHY snapshot-and-clear up front: the chat call is async and a new
        // inbound may arrive mid-flight. Clearing the buffer NOW (and persisting)
        // means a late inbound lands in `lateArrivals` (handleInbound's
        // `processing` branch) instead of this turn's already-snapshotted batch.
        const batch = record.inboundBuffer;
        record.inboundBuffer = [];
        record.lateArrivals = [];
        record.state = 'processing';
        // Stamp a fresh per-turn nonce so boot recovery's `processing` claim token
        // is UNIQUE to THIS processing entry. Two replicas recovering the SAME
        // crash read the same nonce (so exactly one wins); a LATER processing turn
        // gets a new nonce, so its recovery is never blocked by a stale claim from
        // an earlier turn (see recoverPendingRetries).
        record.processingNonce = randomUUID();
        await this.store.setConversation(record);

        // COMMITTED FLUSH: once a turn has hit the reprocess cap, this flush MUST
        // produce + SEND a response — it can no longer be interrupted/rebatched, or
        // a relentless message stream would let the user be aborted forever and get
        // NO reply at the cap (the lost-turn bug). We mark it committed by NOT
        // registering an AbortController: with no controller in the map,
        // handleInbound's `processing` branch can't abort it (it queues the late
        // message to `lateArrivals` instead), so the chat call runs to completion.
        // Any messages that arrive during a committed flush become a fresh FOLLOW-UP
        // turn (see flushImpl's finalization), never lost.
        const committed = record.reprocessCount >= MAX_REPROCESS;
        let signal: AbortSignal | undefined;
        if (!committed) {
          // Normal (interruptible) flush: arm the abort handle BEFORE leaving the
          // lock so a late inbound that lands during the (unlocked) chat call can
          // cancel the now-stale request and trigger a rebatch.
          const abort = new AbortController();
          this.inFlightChatAborts.set(key, abort);
          signal = abort.signal;
        }

        // Read receipt for this turn — fired BEFORE the chat call so a silent,
        // reaction-only, or even chat-error turn still marks the user's message
        // read. Best-effort.
        await this.maybeMarkRead(record, adapter, logger);

        const capabilities = this.capabilitiesOf(adapter);
        const now = this.now();
        const request: ChatRequest = {
          channel: record.channel,
          conversationKey: key,
          // Backward-compat aggregated text: the buffered bodies, newline-joined.
          message: batch
            .map(m => m.text)
            .filter((t): t is string => t !== undefined)
            .join('\n'),
          messages: batch,
          capabilities,
          context: {
            windowOpen: isWindowOpen(record, now),
            ...(record.windowExpiresAt !== undefined ? { windowExpiresAt: record.windowExpiresAt } : {})
          },
          ...(record.contact !== undefined ? { contact: record.contact } : {})
        };
        return { batch, request, signal, committed };
      });
      if (!prep) return; // nothing to flush / no adapter (already handled under lock).

      // ── Unlocked: inbound media hydration on the LOCAL snapshot. ──
      // WHY here: this is opt-in transport-side download (it holds the access
      // token the chat endpoint lacks), so the media rides INTO the request as a
      // base64 data URL. It runs OUTSIDE the lock — it is pure I/O on the local
      // `prep.batch` (whose message objects ARE `request.messages`), mutates no
      // record, and must precede the chat call so the data is present in the
      // request. Each hydrate is independently FAIL-OPEN (never throws), so one
      // bad attachment can't sink the turn; idempotent on reprocess via the
      // dataUrl check. Absent hydrator ⇒ skipped entirely (today's behavior).
      if (this.mediaHydrator) {
        const hydrator = this.mediaHydrator;
        await Promise.all(
          prep.batch.map(async message => {
            if (!message.media || message.media.dataUrl !== undefined) return;
            const dataUrl = await hydrator.hydrate(message);
            if (dataUrl && message.media) message.media.dataUrl = dataUrl;
          })
        );
      }

      // ── Unlocked: the slow chat call. Lock is RELEASED here so a concurrent ──
      // handleInbound can append to lateArrivals + abort this call (rebatch).
      let resp;
      let aborted = false;
      const t0 = this.now();
      try {
        // A committed flush passes NO signal (no AbortController was registered), so
        // it cannot be aborted — it always runs to completion.
        resp = await this.chatClient.complete(prep.request, prep.signal);
      } catch (error) {
        // The abort signal firing surfaces here (the client rejects when the
        // external signal aborts). Distinguish it from a real endpoint error so we
        // route to the reprocess path rather than ending the turn. A committed flush
        // has no signal, so `aborted` stays false and a thrown error is a real one.
        if (prep.signal?.aborted) {
          aborted = true;
        } else {
          this.metrics?.chatDispatchDuration.observe({ result: 'error' }, (this.now() - t0) / 1000);
          this.metrics?.bufferFlushTotal.inc({ result: 'error' });
          // Fail soft: Stage 10 adds retry. For now a chat-endpoint failure ends
          // the turn quietly (the user simply gets no reply).
          if (error instanceof ChatEndpointError) {
            logger.error({ err: error, conversationKey: key }, 'chat endpoint failed; ending turn');
          } else {
            logger.error({ err: error, conversationKey: key }, 'unexpected error calling chat endpoint');
          }
          this.inFlightChatAborts.delete(key);
          // FINDING (message-drop fix): the FAILED batch is dropped (fail-soft —
          // no retry until Stage 10), but any `lateArrivals` that landed WHILE
          // this chat call was in flight are NEW unprocessed inbound, not part of
          // the failed turn. A plain `transitionToIdle` only sets `state = 'idle'`
          // and never touches `lateArrivals`, leaving them orphaned on an idle
          // record with NO flush scheduled — and segment 1's unconditional
          // `record.lateArrivals = []` on the next flush would silently discard
          // them. So mirror `interruptSending`/`finalizeTurn`: under the per-key
          // lock, fold any `lateArrivals` back into `inboundBuffer` (preserving
          // order: existing buffer, then late arrivals), clear them, drop to
          // `buffering`, and reschedule a flush so they still reach the chat
          // endpoint. With no `lateArrivals`, keep the existing idle behavior.
          // Done inside the lock that owns the record write so a concurrent
          // inbound can't interleave and re-orphan the queue.
          await this.runExclusive(key, async () => {
            const record = await this.store.getConversation(key);
            if (record && record.lateArrivals.length > 0) {
              this.clearDeliveryTimeout(key);
              record.inboundBuffer = [...record.inboundBuffer, ...record.lateArrivals];
              record.lateArrivals = [];
              delete record.currentOutboundMessageId;
              // Reset the reprocess counter: this is a FRESH follow-up turn, not a
              // continuation of the failed (possibly committed-cap) one. Without
              // this, a failure at `reprocessCount === MAX_REPROCESS` would make the
              // rescued follow-up turn's first flush "committed" (no AbortController),
              // so a message arriving during it couldn't abort+rebatch — losing the
              // rebatch optimization for that turn (no messages dropped either way).
              record.reprocessCount = 0;
              // Invariant: never `idle` with a non-empty `inboundBuffer`. We are
              // re-buffering unprocessed inbound, so `buffering` + a scheduled
              // flush is the correct resting state.
              record.state = 'buffering';
              record.lastActivity = this.now();
              await this.store.setConversation(record);
              const delayMs = calculateBufferTimeout(
                record.inboundBuffer.length,
                this.config.conversation,
                this.random
              );
              await this.scheduler.schedule(key, delayMs, traceId !== undefined ? { traceId } : undefined);
              return;
            }
            await this.transitionToIdle(key);
          });
          return;
        }
      } finally {
        // The chat call is done (resolved, errored, or aborted) — the abort handle
        // is no longer needed and a future inbound must not abort a settled call.
        this.inFlightChatAborts.delete(key);
      }
      if (!aborted) {
        this.metrics?.chatDispatchDuration.observe({ result: 'success' }, (this.now() - t0) / 1000);
      }

      // ── Locked segment 2: decide reprocess-or-proceed, then attach the queue ──
      const proceed = await this.runExclusive(key, async () => {
        const record = await this.store.getConversation(key);
        if (!record) return undefined;

        // REPROCESS: a late message arrived during the chat call AND it aborted the
        // (interruptible) call. Only an interruptible flush reaches here with
        // `aborted` true — a committed flush has no signal and never aborts. Fold
        // `[...batch, ...lateArrivals]` back into the buffer (the batch was cleared
        // in segment 1, so re-add it from the local snapshot) and reschedule a fresh
        // flush so the COMBINED input becomes ONE response. The just-computed `resp`
        // is stale/aborted, so discard it and RETURN.
        //
        // WHY the `< MAX_REPROCESS` guard is the ONLY abort case that can run here:
        // `aborted` is true only when segment 1 armed a signal, which it does only
        // when `committed === false`, i.e. `reprocessCount < MAX_REPROCESS` at the
        // start of this flush. The sole writer that INCREMENTS `reprocessCount` is
        // this very line below (`+= 1`), which runs strictly AFTER this guard; every
        // other writer (interruptSending, normal-completion, finalizeTurn) only ever
        // RESETS it to 0, and none of them can run for this key while we hold no lock
        // here (they touch the record under their own locked segments and this key is
        // in `processing`/`sending`, not a state that re-enters segment 2). So the
        // re-read at the top of this segment still sees the same `reprocessCount`
        // segment 1 saw — which was `< MAX_REPROCESS`. There is therefore NO reachable
        // "aborted AT the cap" case to handle here: the cap is enforced entirely by
        // segment 1, which marks the NEXT flush committed (un-abortable) once this
        // line pushes the count to MAX_REPROCESS. That committed flush runs to
        // completion and SENDS — that is the lost-turn fix, and it lives in segment 1,
        // not here. (A prior `if (aborted)` cap-branch sat below this block; it was
        // provably unreachable for the reason above and has been removed.)
        if (aborted && record.reprocessCount < MAX_REPROCESS) {
          record.inboundBuffer = [...prep.batch, ...record.inboundBuffer, ...record.lateArrivals];
          record.lateArrivals = [];
          record.reprocessCount += 1;
          record.state = 'buffering';
          record.lastActivity = this.now();
          await this.store.setConversation(record);
          const delayMs = calculateBufferTimeout(record.inboundBuffer.length, this.config.conversation, this.random);
          await this.scheduler.schedule(key, delayMs, traceId !== undefined ? { traceId } : undefined);
          return undefined;
        }

        // From here the chat call COMPLETED normally (or is a committed flush that
        // ran to completion). Any messages that arrived during it sit in
        // `lateArrivals` and become a fresh FOLLOW-UP turn once this turn finishes
        // sending / goes silent — see `finalizeTurn`, which every completion path
        // below funnels through so nothing is dropped.

        // NORMAL completion: build + attach the outbound queue.
        const r = resp!;
        if (r.silence === true || r.actions.length === 0) {
          this.metrics?.bufferFlushTotal.inc({ result: 'silence' });
          logger.debug({ conversationKey: key, silence: r.silence === true }, 'chat response produced no outbound');
          await this.finalizeTurn(record, traceId);
          return undefined;
        }

        const adapter = this.adapters[record.channel];
        if (!adapter) {
          logger.warn({ conversationKey: key, channel: record.channel }, 'no adapter for channel; dropping turn');
          await this.finalizeTurn(record, traceId);
          return undefined;
        }

        // Pass the turn's buffered inbound messages (the SAME array sent to the
        // chat endpoint as `request.messages`) so symbolic reply/reaction
        // `TargetRef`s (e.g. `{ alias: 'last' }`) resolve against what the user
        // actually said this turn.
        const { items, skipped } = buildOutboundItems(r.actions, f => adapter.supports(f), {
          inboundMessages: prep.batch
        });
        if (skipped.length > 0) {
          logger.debug({ conversationKey: key, skipped }, 'some chat actions were skipped/downgraded');
        }
        if (items.length === 0) {
          // Every action was unsupported and skipped (no downgrade produced an
          // item). No outbound is dispatched, so count it as a silent flush.
          this.metrics?.bufferFlushTotal.inc({ result: 'silence' });
          logger.debug({ conversationKey: key }, 'no deliverable items after capability filtering');
          await this.finalizeTurn(record, traceId);
          return undefined;
        }

        // We have at least one deliverable item — the flush dispatched outbound work.
        this.metrics?.bufferFlushTotal.inc({ result: 'dispatched' });
        record.outboundQueue = items;
        record.currentOutboundIndex = 0;
        delete record.currentOutboundMessageId;
        // Stage 10: a fresh turn may re-prompt on a closed window again — reset the
        // single-re-prompt guard. Stash the original request so handleWindowClosed
        // can re-prompt with the same input if a send hits a closed window.
        record.windowReprompted = false;
        this.pendingRequests.set(key, prep.request);
        // The chat call produced deliverable output — reset the reprocess counter
        // (the cap counts only consecutive aborts within one turn). Any `lateArrivals`
        // are deliberately LEFT on the record: `finalizeTurn` (run when the queue
        // drains in sendNext) folds them into a fresh follow-up turn so a message
        // that arrived during a committed flush still gets its own response.
        record.reprocessCount = 0;
        record.state = 'sending';
        await this.store.setConversation(record);
        return true;
      });
      if (!proceed) return;

      // ── Locked segment 3: drive ordered delivery (sendNext + its helpers are ──
      // lock-free, so wrap the whole send loop in one runExclusive segment).
      await this.runExclusive(key, () => this.sendNext(key, traceId));
    } catch (error) {
      logger.error({ err: error, conversationKey: key }, 'flush failed');
      this.inFlightChatAborts.delete(key);
      await this.runExclusive(key, () => this.transitionToIdle(key)).catch(() => {
        /* best-effort cleanup; original error already logged. */
      });
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /* Ordered outbound delivery (sending → idle)                               */
  /* ──────────────────────────────────────────────────────────────────────── */

  /**
   * Drive ordered delivery: send the item at the cursor, then either advance
   * immediately (on_send / fire-and-forget items) or wait for a status callback
   * (on_status). Recurses to the next item after each advance; returns when the
   * queue is complete or when waiting on a WhatsApp delivery status.
   */
  private async sendNext(key: string, traceId?: string): Promise<void> {
    const logger = this.childLogger(traceId);

    const record = await this.store.getConversation(key);
    if (!record) return;

    const state: QueueState = {
      items: record.outboundQueue,
      currentIndex: record.currentOutboundIndex
    };
    if (isQueueComplete(state)) {
      // Queue drained — finalize. If messages arrived DURING this turn (a committed
      // flush can't be interrupted, so they queued in `lateArrivals`), finalizeTurn
      // turns them into a fresh follow-up turn instead of going idle, so nothing is
      // dropped. It also resets reprocessCount now that the turn fully completed.
      await this.finalizeTurn(record, traceId);
      return;
    }

    const item = currentItem(state);
    if (!item) return; // defensive; isQueueComplete already guarded this.

    const adapter = this.adapters[record.channel];
    if (!adapter) {
      logger.warn({ conversationKey: key, channel: record.channel }, 'no adapter for channel mid-send; aborting');
      await this.transitionToIdle(key);
      return;
    }

    const userId = record.channelScopedUserId;

    // Optional typing indicator before a text-bearing item. Best-effort: a
    // failure here must never abort the actual send.
    if (
      (item.kind === 'message' || item.kind === 'reply') &&
      this.config.conversation.outboundTypingIndicatorsEnabled &&
      adapter.supports('typing_indicator')
    ) {
      try {
        await adapter.sendTypingIndicator(userId, record.lastInboundMessageId);
        await this.sleep(this.typingDelayMs());
      } catch (error) {
        logger.warn({ err: error, conversationKey: key }, 'typing indicator before send failed; continuing');
      }
    }

    let sendResult: { messageId: string } | undefined;
    // The histogram/counter `operation` label distinguishes text vs. reaction vs.
    // template vs. media latency. For media we refine it to `media:<kind>`
    // (e.g. `media:image`) so the per-kind send is visible; everything else uses
    // the bare item kind.
    let operation: string = item.kind;
    // Whether this item makes a REAL Graph API send — `message`/`reply`/`template`/
    // `media` AND `reaction` (a reaction is a Graph call too: it counts toward
    // Meta's per-channel rate). EXCLUDED: `typing` (a best-effort UX side-effect)
    // and `silence` (no send). This single flag gates BOTH pre-send pacing
    // (acquireSendSlot) and post-send throughput accounting (recordOutbound), so
    // the two stay in lock-step on exactly the items that hit the Graph API.
    const makesGraphSend =
      item.kind === 'message' ||
      item.kind === 'reply' ||
      item.kind === 'template' ||
      item.kind === 'media' ||
      item.kind === 'reaction';

    // PRE-SEND PACING (Stage 10): reserve a per-line pacing slot before any item
    // that makes a real Graph API send.
    // The lock is HELD while acquireSendSlot awaits its internal pacing sleep —
    // that delays ONLY this conversation (the lock is per-key), exactly like the
    // typing-delay sleep above. acquireSendSlot is contractually fail-open (never
    // throws), so no try/catch is needed here. We measure the wall-clock spent at
    // the slot (the tracker sleeps internally to pace) and observe it as the
    // pacing-delay histogram — 0 == the slot was free.
    if (this.limitTracker && makesGraphSend) {
      const acquireT0 = this.now();
      await this.limitTracker.acquireSendSlot(record.channel, record.channelScopedBusinessId);
      this.metrics?.acquireSendSlotDelaySeconds.observe(
        { channel: record.channel },
        (this.now() - acquireT0) / 1000
      );
    }

    // Time each adapter (Meta Graph API) call; injectable clock keeps it
    // deterministic in tests.
    const sendT0 = this.now();
    try {
      switch (item.kind) {
        case 'message':
          sendResult = await adapter.sendText(userId, item.text ?? '');
          break;
        case 'reply':
          sendResult = await adapter.sendText(
            userId,
            item.text ?? '',
            item.targetMessageId !== undefined ? { replyTo: item.targetMessageId } : undefined
          );
          break;
        case 'reaction':
          await adapter.sendReaction(userId, item.targetMessageId ?? '', item.emoji ?? '');
          break;
        case 'typing':
          await adapter.sendTypingIndicator(userId, record.lastInboundMessageId);
          // Honor an explicit typing action's requested duration: hold the
          // typing bubble for that long before advancing to the next item.
          // Bounded by MAX_EXPLICIT_TYPING_DURATION_MS (the wait happens under
          // the per-key lock). The injectable `sleep` makes this a no-op in tests.
          if (item.durationMs !== undefined && item.durationMs > 0) {
            await this.sleep(Math.min(item.durationMs, MAX_EXPLICIT_TYPING_DURATION_MS));
          }
          break;
        case 'template': {
          // Templates are WhatsApp-only (the only channel whose adapter exposes
          // sendTemplate). buildOutboundItems already gates on supports('template'),
          // but guard the channel + method here too before the cast.
          if (record.channel === 'whatsapp' && typeof (adapter as Partial<WhatsAppClient>).sendTemplate === 'function') {
            sendResult = await (adapter as WhatsAppClient).sendTemplate(
              userId,
              item.templateName ?? '',
              item.templateLanguage ?? '',
              item.templateComponents as TemplateComponent[] | undefined
            );
          } else {
            logger.warn({ conversationKey: key, channel: record.channel }, 'template item on non-template channel; skipping');
          }
          break;
        }
        case 'media': {
          // Defensive: buildOutboundItems always sets mediaUrl from the action's
          // url (a non-empty string), but guard against a malformed item rather
          // than sending an empty reference.
          if (item.mediaUrl === undefined) {
            logger.warn({ conversationKey: key, kind: item.kind }, 'media item missing mediaUrl; skipping');
            break;
          }
          // Infer the send-kind from the MIME (image/audio/video/document; a
          // missing/unknown MIME → document). The uniform adapter.sendMedia routes
          // it to the right per-channel method WITHOUT any channel branching here.
          const kind = inferMediaKind(item.mediaMimeType);
          operation = `media:${kind}`;
          // WHY no channel/kind guard before this call: every channel implements
          // sendMedia for all kinds (Instagram now sends documents as a `file`
          // attachment too), so the agent stays channel-agnostic. If a particular
          // send is rejected by Meta (e.g. an IG `file` that isn't a PDF, or an
          // oversized asset), adapter.sendMedia throws and the per-item catch
          // below turns it into a skip+advance (fail-soft) — the same path as any
          // other send error, so a bad item never crashes or wedges the queue.
          sendResult = await adapter.sendMedia(userId, {
            kind,
            mediaIdOrUrl: item.mediaUrl,
            ...(item.mediaCaption !== undefined ? { caption: item.mediaCaption } : {}),
            ...(item.mediaFilename !== undefined ? { filename: item.mediaFilename } : {})
          });
          break;
        }
        case 'silence':
        default:
          // silence never produces an item; an unknown kind is unexpected — skip
          // rather than crash.
          logger.warn({ conversationKey: key, kind: item.kind }, 'unexpected outbound item kind; skipping');
          break;
      }
      // The send returned (or was a benign no-op skip). Record success — for the
      // no-op skip kinds (silence/unhandled, or a defensive media skip) the
      // adapter call didn't run, but counting them as a zero-latency success keeps
      // the metric simple and those kinds don't reach here in normal flows.
      this.metrics?.outboundSendTotal.inc({
        channel: record.channel,
        operation,
        result: 'success',
        error_code: 'none'
      });
      this.metrics?.outboundSendDuration.observe(
        { channel: record.channel, operation },
        (this.now() - sendT0) / 1000
      );

      // TRACK-ONLY THROUGHPUT (Stage 10): bump the per-hour/day counters for this
      // line ONLY for items that actually hit the Graph API (mirrors the
      // acquireSendSlot gate via the shared `makesGraphSend` flag — typing/silence
      // are excluded). recordOutbound is contractually FAIL-OPEN (never throws,
      // never gates), so awaiting it here cannot break delivery; it is purely an
      // accounting side-effect of a confirmed send.
      if (this.limitTracker && makesGraphSend) {
        await this.limitTracker.recordOutbound(record.channel, record.channelScopedBusinessId);
      }
    } catch (error) {
      // On a Meta API failure, bound the error_code label to the known set.
      const errorCode = error instanceof MetaApiError ? normalizeErrorCodeLabel(error.errorCode) : 'other';
      this.metrics?.outboundSendTotal.inc({
        channel: record.channel,
        operation,
        result: 'error',
        error_code: errorCode
      });
      if (error instanceof MetaApiError) {
        logger.error({ err: error, conversationKey: key, kind: item.kind }, 'outbound send failed');
      } else {
        logger.error({ err: error, conversationKey: key, kind: item.kind }, 'unexpected outbound send error');
      }

      // CLASSIFICATION-DRIVEN ROUTING (Stage 10). Without a limit tracker every
      // error is treated as `permanent` (Stage 5 behavior: skip + advance). With
      // one, route by the tracker's verdict: a closed WhatsApp window re-prompts
      // for a template, a transient failure retries with backoff up to the cap,
      // and anything else (or an exhausted retry) falls through to the skip.
      const classification = this.limitTracker ? this.limitTracker.classifyError(record.channel, error) : 'permanent';
      if (classification === 'window_closed') {
        await this.handleWindowClosed(key, traceId);
        return;
      }
      if (classification === 'transient') {
        const attempt = (item.retryCount ?? 0) + 1;
        if (attempt <= this.limitTracker!.transientRetryMaxAttempts()) {
          this.metrics?.transientRetryTotal.inc({ channel: record.channel, outcome: 'scheduled' });
          await this.scheduleTransientRetry(key, attempt, item.id, traceId);
          return;
        }
        // retries exhausted → record the exhaustion before falling through to skip.
        this.metrics?.transientRetryTotal.inc({ channel: record.channel, outcome: 'exhausted' });
      }
      // Permanent error, or a transient error whose retries are exhausted:
      // Stage 5 fail-soft — mark the item skipped and advance so one bad send
      // never wedges the rest of the queue.
      await this.markSkippedAndAdvance(key, error instanceof Error ? error.message : 'send failed', traceId);
      return;
    }

    // Capture into a const so narrowing survives the awaits below.
    const sentMessageId = sendResult?.messageId;

    // Persist the outbound handle + bookkeeping for items that returned a result.
    if (sentMessageId !== undefined) {
      const after = await this.store.getConversation(key);
      if (after) {
        const sentItem = after.outboundQueue[after.currentOutboundIndex];
        if (sentItem) {
          sentItem.channelMessageId = sentMessageId;
          sentItem.sentAt = this.now();
          // ROOT-CAUSE clear (double-send safety): once an item has SENT, drop its
          // transient-retry bookkeeping so a later boot recovery can never mistake a
          // successfully-sent item (e.g. a WhatsApp item awaiting its status) for a
          // pending retry and re-send it. Pairs with the `channelMessageId === undefined`
          // guard in recoverPendingRetries (B1) as defense-in-depth.
          delete sentItem.retryCount;
          delete sentItem.nextRetryAt;
        }
        await this.store.setConversation(after);
      }
      await this.store.mapOutboundHandle(sentMessageId, {
        conversationKey: key,
        messageIndex: record.currentOutboundIndex,
        ...(traceId !== undefined ? { traceId } : {})
      });

      // Seed a 'sent' status record at send time for on_send channels
      // (Messenger/Instagram). They emit NO per-message status webhook, so
      // without this the tracker would never hold a record for them:
      // GET /admin/status/:messageId would 404, and a read watermark's
      // applyReadWatermark would find nothing to mark. WhatsApp (on_status) is
      // seeded by its own 'sent' status webhook in handleStatusImpl, so it is
      // skipped here to avoid a duplicate history entry.
      if (advancementMode(record.channel) === 'on_send') {
        this.statusTracker?.applyStatusUpdate({
          channelMessageId: sentMessageId,
          channel: record.channel,
          status: 'sent',
          timestamp: this.now(),
          conversationKey: key,
          recipientId: userId
        });
      }
    }

    // WHY reaction/typing always advance-on-send: they are fire-and-forget — no
    // channel (not even WhatsApp) emits a delivery status for them, so waiting
    // on_status would wedge the queue. Advance immediately regardless of channel.
    const fireAndForget = item.kind === 'reaction' || item.kind === 'typing';

    if (fireAndForget || sentMessageId === undefined) {
      // sentMessageId === undefined => silence/skipped-template/defensive-media-skip
      // (no send result). A media item that DID send has a real id and falls
      // through to the message/reply/template path below.
      await this.advanceAndContinue(key, undefined, traceId);
      return;
    }

    // message / reply / template / media with a real send result:
    if (advancementMode(record.channel) === 'on_send') {
      // Messenger/Instagram: no per-message delivery webhook, so the send API
      // response is the only confirmation — advance now.
      await this.advanceAndContinue(key, sentMessageId, traceId);
      return;
    }

    // WhatsApp (on_status): DO NOT advance yet. Record the in-flight handle and
    // wait for handleStatus(sent|delivered). Arm a delivery-timeout fallback so
    // a missing/late status can't wedge the queue forever.
    const waiting = await this.store.getConversation(key);
    if (waiting) {
      waiting.currentOutboundMessageId = sentMessageId;
      await this.store.setConversation(waiting);
    }
    this.startDeliveryTimeout(key, record.currentOutboundIndex, traceId);
  }

  /**
   * Advance the cursor past the current item and continue with the next.
   * `messageId` (when given) is the just-confirmed handle whose timeout/mapping
   * we clean up before advancing.
   */
  private async advanceAndContinue(key: string, messageId: string | undefined, traceId?: string): Promise<void> {
    this.clearDeliveryTimeout(key);
    if (messageId !== undefined) {
      // The handle → conversation mapping is no longer needed once the queue has
      // moved past it; delete eagerly so it doesn't linger.
      await this.store.deleteOutboundHandleMapping(messageId);
    }

    const record = await this.store.getConversation(key);
    if (!record) return;

    const delivered = record.outboundQueue[record.currentOutboundIndex];
    if (delivered?.channelMessageId) record.deliveredMessageIds.push(delivered.channelMessageId);

    const advanced = advanceCursor({ items: record.outboundQueue, currentIndex: record.currentOutboundIndex });
    record.currentOutboundIndex = advanced.currentIndex;
    record.lastOutboundAt = this.now();
    record.lastActivity = this.now();
    delete record.currentOutboundMessageId;
    await this.store.setConversation(record);

    await this.sendNext(key, traceId);
  }

  /** Mark the in-flight item skipped (with a reason) and advance past it. */
  private async markSkippedAndAdvance(key: string, reason: string, traceId?: string): Promise<void> {
    const record = await this.store.getConversation(key);
    if (record) {
      const item = record.outboundQueue[record.currentOutboundIndex];
      if (item) {
        item.skippedAt = this.now();
        item.skipReason = reason;
      }
      await this.store.setConversation(record);
    }
    await this.advanceAndContinue(key, undefined, traceId);
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /* Transient retry (Stage 10)                                                */
  /* ──────────────────────────────────────────────────────────────────────── */

  /**
   * Stamp the in-flight item with its retry bookkeeping and arm a backoff timer
   * to re-send it. LOCK-FREE: only ever called from {@link sendNext}'s catch with
   * the per-key lock held. Does NOT advance the cursor — the turn stays `sending`
   * on the same item, which the timer re-sends via {@link runTransientRetryImpl}.
   */
  private async scheduleTransientRetry(key: string, attempt: number, itemId: string, traceId?: string): Promise<void> {
    const logger = this.childLogger(traceId);
    const record = await this.store.getConversation(key);
    if (!record) return;
    const item = record.outboundQueue[record.currentOutboundIndex];
    // STALE guard: the queue moved past this item between the failed send and
    // here (e.g. an interrupt rolled the turn back). Don't re-arm against it.
    if (!item || item.id !== itemId) return;

    const delay = this.limitTracker!.retryDelayMs(attempt);
    item.retryCount = attempt;
    item.nextRetryAt = this.now() + delay;
    await this.store.setConversation(record);

    logger.warn(
      { conversationKey: key, attempt, delayMs: delay, itemId },
      'scheduling transient retry'
    );

    // A failed send never armed a delivery-timeout (that timer is armed only
    // AFTER a successful WhatsApp send), but clear defensively so the retry timer
    // is the sole outstanding timer for this item.
    this.clearDeliveryTimeout(key);
    this.armTransientRetryTimer(key, itemId, attempt, delay, traceId);
  }

  /**
   * Arm (clear-before-arm, one per key) the transient-retry timer. Factored out
   * of {@link scheduleTransientRetry} so {@link recoverPendingRetries} can re-arm
   * with an explicit remaining delay after a restart. The timer is a true ENTRY
   * POINT (fires outside any held lock), so it ACQUIRES the per-key lock before
   * running the lock-free {@link runTransientRetryImpl}.
   */
  private armTransientRetryTimer(
    key: string,
    itemId: string,
    attempt: number,
    delayMs: number,
    traceId?: string
  ): void {
    this.clearTransientRetryTimer(key);
    const handle = setTimeout(() => {
      this.transientRetryTimers.delete(key);
      this.runExclusive(key, () => this.runTransientRetryImpl(key, itemId, attempt, traceId)).catch(error =>
        this.logger.warn({ err: error, conversationKey: key }, 'transient-retry handling failed')
      );
    }, delayMs);
    this.transientRetryTimers.set(key, handle);
  }

  private clearTransientRetryTimer(key: string): void {
    const handle = this.transientRetryTimers.get(key);
    if (handle) clearTimeout(handle);
    this.transientRetryTimers.delete(key);
  }

  /**
   * Fired when a transient-retry backoff elapses; re-sends the item at the cursor.
   * LOCK-FREE / INTERNAL: only ever reached via the setTimeout in
   * {@link armTransientRetryTimer}, which wraps it in {@link runExclusive}.
   *
   * Re-validates that the world has not moved on (the turn is still `sending`, the
   * in-flight item is the SAME one, and its `retryCount` matches what we armed). If
   * any of those changed (an interrupt/advance happened), the timer is STALE — do
   * nothing. Otherwise re-send via {@link sendNext}, which on success advances and,
   * on another transient failure, re-enters the catch and may reschedule up to the
   * cap.
   */
  private async runTransientRetryImpl(key: string, itemId: string, attempt: number, traceId?: string): Promise<void> {
    const record = await this.store.getConversation(key);
    if (!record || record.state !== 'sending') return;
    const item = record.outboundQueue[record.currentOutboundIndex];
    if (!item || item.id !== itemId || (item.retryCount ?? 0) !== attempt) return;
    await this.sendNext(key, traceId);
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /* WhatsApp out-of-window re-prompt (Stage 10)                              */
  /* ──────────────────────────────────────────────────────────────────────── */

  /**
   * Handle a WhatsApp `window_closed` send failure: re-prompt the chat endpoint
   * ONCE for the same turn (signalling it to reply with a template, since a
   * free-form text would fail again), then deliver whatever it returns. Bounded
   * and fail-soft — anything unexpected ends in a skip+advance so the queue never
   * wedges. LOCK-FREE: called from {@link sendNext}'s catch with the per-key lock
   * held; every record read-modify-write below is part of that critical section.
   */
  private async handleWindowClosed(key: string, traceId?: string): Promise<void> {
    const logger = this.childLogger(traceId);
    try {
      let record = await this.store.getConversation(key);
      // Re-prompt ONLY on WhatsApp, ONLY once per turn. A non-WhatsApp channel
      // shouldn't reach here (classifyError only returns window_closed for
      // whatsapp), but guard anyway. A second window_closed (already reprompted)
      // just skips so we never loop.
      if (!record || record.channel !== 'whatsapp' || record.windowReprompted === true) {
        await this.markSkippedAndAdvance(key, 'whatsapp messaging window closed', traceId);
        return;
      }
      const original = this.pendingRequests.get(key);
      if (!original) {
        // Can't re-prompt without the original request (e.g. lost on restart).
        await this.markSkippedAndAdvance(key, 'whatsapp messaging window closed', traceId);
        return;
      }

      record.windowReprompted = true;
      await this.store.setConversation(record);

      const repromptRequest: ChatRequest = {
        ...original,
        context: { ...original.context, windowOpen: false, requiresTemplate: true }
      };

      logger.warn({ conversationKey: key }, 'whatsapp window closed; re-prompting chat endpoint for a template');

      // NB: this chat call runs UNDER the held per-key lock (no abort signal — it
      // is a bounded follow-on; the chat client has its own timeout). That is
      // acceptable because this is a rare edge path, mirroring how on_send
      // channels already drain their whole queue under one held lock.
      let resp: NormalizedChatResponse;
      try {
        resp = await this.chatClient.complete(repromptRequest);
      } catch (err) {
        logger.warn({ err, conversationKey: key }, 'window re-prompt chat call failed; skipping item');
        await this.markSkippedAndAdvance(key, 'whatsapp messaging window closed', traceId);
        return;
      }

      // Reload after the (lock-held but awaited) chat call so we mutate fresh state.
      record = await this.store.getConversation(key);
      if (!record) return;

      if (resp.silence === true || resp.actions.length === 0) {
        await this.finalizeTurn(record, traceId);
        return;
      }
      const adapter = this.adapters[record.channel];
      if (!adapter) {
        await this.finalizeTurn(record, traceId);
        return;
      }
      // Resolve symbolic targets against the SAME turn's buffered inbound
      // messages (stashed on the original ChatRequest), so a re-prompt that
      // reacts/replies to the user's message still resolves correctly.
      const { items } = buildOutboundItems(resp.actions, f => adapter.supports(f), {
        inboundMessages: original.messages
      });
      if (items.length === 0) {
        await this.finalizeTurn(record, traceId);
        return;
      }

      // REPLACE the queue with the re-prompt's items and re-drive delivery. The
      // failed item is dropped; the new queue (ideally a template) takes over.
      record.outboundQueue = items;
      record.currentOutboundIndex = 0;
      delete record.currentOutboundMessageId;
      await this.store.setConversation(record);
      await this.sendNext(key, traceId);
    } catch (error) {
      // Fail-soft: never throw out of the send path. On an unexpected error,
      // skip+advance so the queue can make progress.
      logger.error({ err: error, conversationKey: key }, 'window-closed handling failed; skipping item');
      await this.markSkippedAndAdvance(key, 'whatsapp messaging window closed', traceId).catch(() => {
        /* best-effort cleanup; original error already logged. */
      });
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /* Boot recovery (Stage 10)                                                  */
  /* ──────────────────────────────────────────────────────────────────────── */

  /**
   * Boot recovery for conversations stranded by a process restart. PUBLIC ENTRY
   * POINT — the runtime calls this once at boot. Each per-key scan runs under
   * {@link runExclusive} (it is an entry point) and is fail-soft so one bad record
   * cannot sink recovery. Three cases:
   *
   *  - `sending` mid-retry (B1): an in-flight item with `nextRetryAt` + `retryCount > 0`
   *    whose backoff timer (in-process) died with the old process. Re-arm it with
   *    the remaining delay.
   *  - `sending` awaiting a WhatsApp delivery status (B2, the "first-send crash" gap):
   *    an on_status item that was SENT (`currentOutboundMessageId` set) but whose
   *    in-memory delivery-timeout fallback died with the process — the queue would sit
   *    in `sending` until the next inbound. Re-arm the delivery timeout so it ADVANCES
   *    past the already-sent item (no re-send → no double-send). Messenger/Instagram
   *    (on_send) have no such timer and self-heal on the next inbound via
   *    `interruptSending` — see KNOWN-GAPS.
   *  - `processing` stranded: the chat call was in flight when the process died, so
   *    the local batch snapshot is gone AND nothing will ever flush this record —
   *    `handleInbound`'s `processing` branch only stashes to `lateArrivals` and
   *    aborts a now-absent controller, so the conversation would WEDGE until TTL.
   *    Un-wedge it: fold any `lateArrivals` (messages that arrived during the dead
   *    chat call and WERE persisted) back into the buffer and reschedule a flush;
   *    if there are none, reset to `idle` so the next inbound starts fresh. The
   *    original (snapshotted, never-persisted) chat-call batch is lost — an inherent
   *    at-least-once limitation of the snapshot-clears-buffer design; see KNOWN-GAPS.
   *
   * MULTI-REPLICA DOUBLE-SEND/DOUBLE-RECOVERY GUARD: on a shared Redis every replica
   * runs this at boot and the per-process `runExclusive` lock is NOT distributed, so
   * each recovery action is gated behind an atomic `store.claimRecovery(token, ttl)`
   * — exactly one replica acts. The in-memory store is single-process and always
   * wins (and wipes state on restart anyway, so it yields nothing to recover and
   * returns all-zero counts). A store without `claimRecovery` falls back to true.
   */
  async recoverPendingRetries(): Promise<{
    transientRetriesResumed: number;
    processingReset: number;
    deliveryTimeoutsRearmed: number;
  }> {
    let transientRetriesResumed = 0;
    let processingReset = 0;
    let deliveryTimeoutsRearmed = 0;
    // CLAIM TTL is deliberately SHORT (not conversationTtlSeconds): the claim only
    // needs to survive the simultaneous-boot race window AND until the recovered
    // action (retry fire / un-wedge) completes. If the WINNING replica crashes
    // before then, a long TTL would block every other replica from re-recovering
    // for 24h — re-wedging the conversation. A short TTL bounds that orphan window
    // so a later restart can re-claim. RECOVERY_CLAIM_MIN_TTL_SECONDS covers the
    // boot race; the `sending` branch extends it to cover the remaining retry delay.
    const claim = (token: string, ttlSeconds: number): Promise<boolean> =>
      this.store.claimRecovery ? this.store.claimRecovery(token, ttlSeconds) : Promise.resolve(true);
    for await (const key of this.store.listConversationKeys()) {
      try {
        const outcome = await this.runExclusive(key, async (): Promise<'sending' | 'processing' | 'delivery' | 'none'> => {
          const record = await this.store.getConversation(key);
          if (!record) return 'none';

          // (A) `processing` stranded by a restart — un-wedge it (claim-guarded).
          // The un-wedge action is quick, so the min TTL (boot-race grace) suffices.
          // The claim token carries the per-turn `processingNonce` so it is UNIQUE
          // to this processing entry: concurrent recoveries of the same crash share
          // the nonce (one wins), while a LATER processing turn gets a fresh nonce
          // and is never blocked by a stale claim from an earlier turn. (A record
          // written before this field existed has no nonce — fall back to a constant;
          // such a record predates this code path and won't recur.)
          if (record.state === 'processing') {
            const procToken = `${key}:processing:${record.processingNonce ?? 'legacy'}`;
            if (!(await claim(procToken, RECOVERY_CLAIM_MIN_TTL_SECONDS))) return 'none';
            this.clearDeliveryTimeout(key);
            this.clearTransientRetryTimer(key);
            this.pendingRequests.delete(key);
            delete record.currentOutboundMessageId;
            record.reprocessCount = 0;
            record.outboundQueue = [];
            record.currentOutboundIndex = 0;
            if (record.lateArrivals.length > 0) {
              record.inboundBuffer = [...record.inboundBuffer, ...record.lateArrivals];
              record.lateArrivals = [];
              record.state = 'buffering';
              record.lastActivity = this.now();
              await this.store.setConversation(record);
              const delayMs = calculateBufferTimeout(record.inboundBuffer.length, this.config.conversation, this.random);
              await this.scheduler.schedule(key, delayMs, record.traceId !== undefined ? { traceId: record.traceId } : undefined);
            } else {
              record.state = 'idle';
              record.lastActivity = this.now();
              await this.store.setConversation(record);
            }
            return 'processing';
          }

          if (record.state !== 'sending') return 'none';
          const item = record.outboundQueue[record.currentOutboundIndex];
          if (!item) return 'none';

          // (B1) `sending` mid-retry — re-arm the transient-retry timer (claim-guarded,
          // scoped to THIS attempt {key}:{itemId}:{retryCount} so a later restart with
          // a new attempt claims a fresh token).
          //
          // LOAD-BEARING `channelMessageId === undefined` guard (double-send safety):
          // re-arm a transient retry (which RE-SENDS) ONLY for an item that was NOT yet
          // sent. `channelMessageId` is set only AFTER a successful send. A retry whose
          // send already SUCCEEDED — then sat awaiting a WhatsApp status when the process
          // died — still carries `retryCount`/`nextRetryAt` (sendNext clears them on
          // success, but a record persisted by an older build, or any gap, could retain
          // them). Without this guard B1 would match and re-send it (DOUBLE-SEND), and
          // B2 (the safe delivery-timeout re-arm) would never be reached. With it, an
          // already-sent item falls through to B2 instead.
          if (item.nextRetryAt !== undefined && (item.retryCount ?? 0) > 0 && item.channelMessageId === undefined) {
            // Compute remainingMs BEFORE the claim so it drives the claim TTL too:
            // expire the claim shortly after the retry would have fired (+grace), so a
            // crashed claimer doesn't block re-recovery for the conversation lifetime.
            const remainingMs = Math.max(0, item.nextRetryAt - this.now());
            const claimTtlSeconds = Math.max(
              Math.ceil(remainingMs / 1000) + RECOVERY_CLAIM_GRACE_SECONDS,
              RECOVERY_CLAIM_MIN_TTL_SECONDS
            );
            if (!(await claim(`${key}:${item.id}:${item.retryCount ?? 0}`, claimTtlSeconds))) return 'none';
            // Re-arm with the remaining delay (clamped to >= 0 so an overdue retry fires promptly).
            this.armTransientRetryTimer(key, item.id, item.retryCount ?? 0, remainingMs, record.traceId);
            return 'sending';
          }

          // (B2) `sending` awaiting a WhatsApp (on_status) delivery status whose
          // in-memory fallback timer DIED with the process — the "first-send crash"
          // gap. Without the timer the queue would sit in `sending` until the next
          // inbound triggers interruptSending. Re-arm the delivery-timeout fallback so
          // the queue self-heals: when it fires, `onDeliveryTimeoutImpl` ADVANCES past
          // the already-sent item (it does NOT re-send it — so no double-send) and
          // drives the rest of the queue. Guarded by the current-index check + claim.
          // Only meaningful when the item was actually sent (currentOutboundMessageId
          // set) and the channel waits on a status. The durable outbound-handle mapping
          // means a freshly-arriving status can still advance it too — both paths are
          // idempotent via the index guard. Messenger/Instagram (on_send) have no such
          // timer and self-heal on the next inbound (interruptSending) — see KNOWN-GAPS.
          if (
            advancementMode(record.channel) === 'on_status' &&
            record.currentOutboundMessageId !== undefined
          ) {
            if (!(await claim(`${key}:delivery:${record.currentOutboundMessageId}`, RECOVERY_CLAIM_MIN_TTL_SECONDS))) {
              return 'none';
            }
            this.startDeliveryTimeout(key, record.currentOutboundIndex, record.traceId);
            return 'delivery';
          }
          return 'none';
        });
        if (outcome === 'sending') transientRetriesResumed += 1;
        else if (outcome === 'processing') processingReset += 1;
        else if (outcome === 'delivery') deliveryTimeoutsRearmed += 1;
      } catch (error) {
        this.logger.warn({ err: error, conversationKey: key }, 'recoverPendingRetries: skipping bad record');
      }
    }
    return { transientRetriesResumed, processingReset, deliveryTimeoutsRearmed };
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /* Status callbacks (WhatsApp on_status advancement)                        */
  /* ──────────────────────────────────────────────────────────────────────── */

  /**
   * Correlate a delivery-status callback back to its conversation + queue slot
   * and advance the WhatsApp queue when the in-flight item is confirmed.
   * Fails soft.
   *
   * PUBLIC ENTRY POINT: the conversation key isn't known until we resolve the
   * outbound-handle mapping, so we do a LOCK-FREE pre-lookup to discover the key,
   * then run the (lock-free) body under that key's lock — serializing it against
   * sendNext/flush/handleInbound so a status can't double-advance or clobber an
   * in-flight send. The body re-reads the mapping under the lock (the cheap
   * pre-lookup is only to find the key).
   *
   * MESSENGER/INSTAGRAM READ WATERMARK (Stage 6): a `read` event on those
   * channels carries NO per-message id — `channelMessageId` is a WATERMARK
   * timestamp, not a wamid, so the pre-lookup finds no mapping. Rather than fall
   * through to the benign no-op path (Stage 5 behaviour), we derive the
   * conversation key from the status's user/business ids and run a SEPARATE,
   * observability-only impl under THAT key's lock. An unmapped status that is
   * NOT such a read still runs unlocked straight to the benign no-op.
   */
  async handleStatus(status: StatusUpdate, opts?: HandleOptions): Promise<void> {
    // Record per-message status history FIRST, decoupled from the outbound-handle
    // mapping and the per-key lock. WhatsApp emits sent → delivered → read for one
    // message, but the first advancing status (`sent`) deletes the mapping in
    // advanceAndContinue — so a delivered/read callback arriving afterward would
    // hit the "unmapped" early-return and be dropped from the tracker, leaving the
    // history stuck at the first status. The status tracker is its own store (a
    // synchronous map, separate from the ConversationStore), so recording here
    // needs no lock. Watermark reads (Messenger/IG `read`) carry a watermark, not a
    // real message id, and are recorded via applyReadWatermark instead — skip them.
    const isWatermarkRead = status.status === 'read' && status.channel !== 'whatsapp';
    if (this.statusTracker && !isWatermarkRead) {
      try {
        const conversationKey =
          status.channelScopedUserId !== undefined && status.channelScopedBusinessId !== undefined
            ? conversationKeyFor({
                channel: status.channel,
                channelScopedBusinessId: status.channelScopedBusinessId,
                channelScopedUserId: status.channelScopedUserId
              })
            : undefined;
        this.statusTracker.applyStatusUpdate({
          channelMessageId: status.channelMessageId,
          channel: status.channel,
          status: status.status,
          timestamp: status.timestamp,
          ...(conversationKey !== undefined ? { conversationKey } : {}),
          ...(status.channelScopedUserId !== undefined ? { recipientId: status.channelScopedUserId } : {}),
          ...(status.errorCode !== undefined ? { errorCode: status.errorCode } : {}),
          ...(status.errorTitle !== undefined ? { errorTitle: status.errorTitle } : {})
        });
      } catch (error) {
        (opts?.logger ?? this.logger).warn(
          { err: error, channelMessageId: status.channelMessageId },
          'status tracker record failed (non-fatal)'
        );
      }
    }

    const preMapping = await this.store.getOutboundHandleMapping(status.channelMessageId);
    if (preMapping) {
      await this.runExclusive(preMapping.conversationKey, () => this.handleStatusImpl(status, opts));
      return;
    }

    // No outbound mapping. If this is a Messenger/IG read watermark with enough
    // ids to derive the conversation key, take the watermark path under that
    // key's lock (acquired ONCE here; the impl is lock-free, mirroring the
    // mapping path — no nested acquisition, no deadlock).
    if (
      status.status === 'read' &&
      status.channel !== 'whatsapp' &&
      status.channelScopedUserId !== undefined &&
      status.channelScopedBusinessId !== undefined
    ) {
      const watermarkKey = conversationKeyFor({
        channel: status.channel,
        channelScopedBusinessId: status.channelScopedBusinessId,
        channelScopedUserId: status.channelScopedUserId
      });
      await this.runExclusive(watermarkKey, () =>
        this.handleReadWatermarkImpl(watermarkKey, status, opts)
      );
      return;
    }

    // Unmapped, non-watermark status: no conversation to serialize on — straight
    // to the benign no-op path, unlocked.
    await this.handleStatusImpl(status, opts);
  }

  /** Lock-free body of {@link handleStatus}. Assumes the per-key lock is held. */
  private async handleStatusImpl(status: StatusUpdate, opts?: HandleOptions): Promise<void> {
    const traceId = opts?.traceId;
    let logger = opts?.logger ?? this.childLogger(traceId);
    // Count every status callback we observe (mapped or not), labelled by
    // channel + status, before any advance/no-op decision.
    this.metrics?.statusCallbackTotal.inc({ channel: status.channel, status: status.status });
    try {
      const mapping = await this.store.getOutboundHandleMapping(status.channelMessageId);
      if (!mapping) {
        // Status for a message we never sent (or already cleaned up). Common and
        // benign — e.g. a `read` status arriving after the queue advanced.
        logger.debug({ channelMessageId: status.channelMessageId, status: status.status }, 'status for unmapped message');
        return;
      }

      // Stage-6/Wave-2 (#6): bind the originating inbound's trace id (persisted on
      // the outbound-handle mapping at send time) onto a child logger so a LATE
      // delivery/failed status — which arrives long after the inbound webhook that
      // produced this outbound — correlates back to that turn in the logs. Prefer
      // the mapping's traceId; fall back to this call's traceId when absent.
      if (mapping.traceId !== undefined) {
        logger = logger.child({ conversationTraceId: mapping.traceId });
      }

      const key = mapping.conversationKey;
      const record = await this.store.getConversation(key);
      if (!record) {
        logger.debug({ conversationKey: key, channelMessageId: status.channelMessageId }, 'status for unknown conversation');
        return;
      }

      // Record a delivered handle for observability (full history is Stage 6).
      if (status.status === 'delivered' && !record.deliveredMessageIds.includes(status.channelMessageId)) {
        record.deliveredMessageIds.push(status.channelMessageId);
        record.lastActivity = this.now();
        await this.store.setConversation(record);
      }

      // (Per-message status history is recorded up-front in handleStatus, before
      // the mapping lookup, so delivered/read aren't lost once `sent` deletes the
      // mapping. Here we only handle queue advancement.)

      // Only advance when this status both advances the queue for this channel
      // (WhatsApp sent/delivered) AND refers to the CURRENTLY in-flight item.
      if (statusAdvancesQueue(record.channel, status.status) && record.currentOutboundIndex === mapping.messageIndex) {
        await this.advanceAndContinue(key, status.channelMessageId, mapping.traceId ?? traceId);
        return;
      }

      // ── ASYNC `failed` STATUS (Wave-2 #1): the PRIMARY FIX ──────────────────
      // On WhatsApp the real rate-limit / closed-window failures usually surface
      // ASYNCHRONOUSLY here as a `failed` delivery status (carrying status.errorCode),
      // NOT on the synchronous send POST (which had returned 200/queued). Before this
      // branch a `failed` status fell through to the "stale or non-advancing" debug
      // log and was effectively ignored — so those failures were never retried and
      // never triggered a template re-prompt. Mirror the synchronous catch's
      // classification routing, but classify via `classifyStatusErrorCode`.
      //
      // FIRES ONLY for the CURRENTLY in-flight item (`currentOutboundIndex ===
      // mapping.messageIndex`). A `failed` for an already-advanced index is a stale
      // failure for a slot the queue has long since moved past — keep the existing
      // no-op/debug behavior for it (falling through below) so we never re-process or
      // double-advance the queue.
      if (
        status.status === 'failed' &&
        record.currentOutboundIndex === mapping.messageIndex
      ) {
        // DOUBLE-SEND SAFETY IS INVERTED HERE — and that inversion is the whole
        // point. The load-bearing "a 5xx after a POST may have already delivered, so
        // don't retry" rule governs the SYNCHRONOUS send path, where a server error
        // is ambiguous about whether Meta accepted the message. A `failed` DELIVERY
        // STATUS is the OPPOSITE: it is Meta's DEFINITIVE statement that the message
        // did NOT reach the user. Retrying a transient-classified async failure is
        // therefore SAFE and correct (no double-send). Do NOT "fix" this back to
        // skip-on-failed by analogy with the sync 5xx rule — the two situations are
        // not the same.
        const failedTraceId = mapping.traceId ?? traceId;
        // The delivery-timeout fallback was ARMED for this item by the earlier
        // successful send (sendNext's on_status tail). It MUST be cleared before we
        // re-process or it could double-fire and advance the queue out from under
        // the retry/re-prompt. (handleWindowClosed → markSkippedAndAdvance and
        // scheduleTransientRetry both also clear it, but clear it HERE up front so
        // the permanent/exhausted skip path below — markSkippedAndAdvance via
        // advanceAndContinue — and any future edit are covered unconditionally.)
        this.clearDeliveryTimeout(key);

        const classification = this.limitTracker
          ? this.limitTracker.classifyStatusErrorCode(record.channel, status.errorCode)
          : 'permanent';

        if (classification === 'window_closed') {
          logger.warn(
            { conversationKey: key, errorCode: status.errorCode },
            'whatsapp failed status: window closed; re-prompting for template'
          );
          await this.handleWindowClosed(key, failedTraceId);
          return;
        }

        if (classification === 'transient' && this.limitTracker) {
          const item = record.outboundQueue[record.currentOutboundIndex];
          // CAP COUNTER MUST SURVIVE A SUCCESSFUL SEND. This async path fires only
          // AFTER a send SUCCEEDED (then failed via a status webhook), and the
          // success tail in sendNext DELETES `item.retryCount` for double-send
          // safety. So `retryCount` is always absent here and would reset the attempt
          // to 1 on every cycle — a re-send that keeps async-failing (e.g. a
          // recurring 130429 rate-limit) would loop FOREVER, never tripping the cap.
          // We therefore count async-failure retries on a DEDICATED
          // `asyncFailRetryCount` that the success tail does NOT clear, so the cap
          // actually trips. (The synchronous transient path is unaffected: there the
          // send THROWS and never reaches the retryCount-clearing tail, so its
          // `retryCount` accumulates correctly — see the sync catch above.)
          const attempt = (item?.asyncFailRetryCount ?? 0) + 1;
          if (item && attempt <= this.limitTracker.transientRetryMaxAttempts()) {
            // Persist the surviving async-retry count BEFORE scheduling.
            item.asyncFailRetryCount = attempt;
            // DEAD-HANDLE RESET (load-bearing): the in-flight item carries the
            // channelMessageId/sentAt of the FAILED send. That handle is dead — the
            // message never reached the user. Clear it so (a) scheduleTransientRetry
            // re-sends cleanly (sendNext re-sends the cursor item) and (b) the boot-
            // recovery B1 guard — which re-arms a transient retry ONLY for an item
            // with `channelMessageId === undefined` — recognizes this as a pending
            // retry rather than treating the dead handle as a successful send. Also
            // drop the outbound-handle mapping for the dead id (the retry mints a new
            // id; the stale mapping would otherwise linger). scheduleTransientRetry
            // then stamps retryCount/nextRetryAt and arms the backoff timer.
            delete item.channelMessageId;
            delete item.sentAt;
            delete record.currentOutboundMessageId;
            await this.store.setConversation(record);
            await this.store.deleteOutboundHandleMapping(status.channelMessageId);
            logger.warn(
              { conversationKey: key, errorCode: status.errorCode, attempt },
              'whatsapp failed status: transient; scheduling retry'
            );
            this.metrics?.transientRetryTotal.inc({ channel: record.channel, outcome: 'scheduled' });
            await this.scheduleTransientRetry(key, attempt, item.id, failedTraceId);
            return;
          }
          // Retries exhausted (or no item) → record exhaustion, fall through to skip.
          this.metrics?.transientRetryTotal.inc({ channel: record.channel, outcome: 'exhausted' });
        }

        // `permanent`, or an exhausted transient: fail-soft skip + advance so one
        // failed send never wedges the rest of the queue. (The dead outbound-handle
        // mapping is cleaned up by advanceAndContinue, which is passed the failed id.)
        logger.warn(
          { conversationKey: key, errorCode: status.errorCode, errorTitle: status.errorTitle },
          'whatsapp failed status: permanent (or retries exhausted); skipping item'
        );
        const item = record.outboundQueue[record.currentOutboundIndex];
        if (item) {
          item.skippedAt = this.now();
          item.skipReason = status.errorTitle ?? `failed (code ${status.errorCode ?? 'unknown'})`;
          await this.store.setConversation(record);
        }
        await this.advanceAndContinue(key, status.channelMessageId, failedTraceId);
        return;
      }

      // Stale status (the queue already advanced past this index) — ignore.
      logger.debug(
        { conversationKey: key, statusIndex: mapping.messageIndex, currentIndex: record.currentOutboundIndex, status: status.status },
        'status does not advance queue (stale or non-advancing)'
      );
    } catch (error) {
      logger.error({ err: error, channelMessageId: status.channelMessageId }, 'handleStatus failed');
    }
  }

  /**
   * Messenger/Instagram read-watermark handler (Stage 6, OBSERVABILITY ONLY).
   * Lock-free body — {@link handleStatus} runs it under the derived key's lock.
   *
   * WHY a watermark→messageId translation: unlike WhatsApp (a per-message `read`
   * keyed by the real wamid), Messenger/IG emit a single READ WATERMARK meaning
   * "everything sent at/before this timestamp has been read" — there is no id to
   * look up. We translate by scanning the conversation's own outbound queue for
   * items that were actually SENT (`channelMessageId` set, `sentAt` known) at or
   * before the watermark, and hand those concrete ids to the tracker. The
   * tracker only ADVANCES ids it already knows (it never invents records from a
   * watermark), so an id we send but whose `sent` the tracker hasn't recorded is
   * simply skipped there.
   *
   * WHY it does NOT touch the queue: Messenger/IG are advance-on-send
   * (`statusAdvancesQueue` returns false for them), so by the time a read arrives
   * the queue has long since advanced on each send's API response. A read is
   * therefore PURELY informational here — it must not advance, skip, or re-open
   * any queue item. We only update status history + the callback metric.
   */
  private async handleReadWatermarkImpl(
    key: string,
    status: StatusUpdate,
    opts?: HandleOptions
  ): Promise<void> {
    let logger = opts?.logger ?? this.childLogger(opts?.traceId);
    // Count the read callback even when there's nothing to mark (no record / no
    // qualifying ids) — we still observed the webhook.
    this.metrics?.statusCallbackTotal.inc({ channel: status.channel, status: 'read' });
    try {
      const record = await this.store.getConversation(key);
      if (!record) {
        logger.debug({ conversationKey: key, watermark: status.timestamp }, 'read watermark for unknown conversation');
        return;
      }

      // Wave-2 (#6): a read watermark has no per-message mapping, but the record
      // carries the originating turn's trace id — bind it so this late read log
      // line correlates back to the inbound webhook that produced the outbound.
      if (record.traceId !== undefined) {
        logger = logger.child({ conversationTraceId: record.traceId });
      }

      // Concrete outbound ids sent at/before the watermark — the translation.
      const messageIds = record.outboundQueue
        .filter(item => item.channelMessageId && item.sentAt !== undefined && item.sentAt <= status.timestamp)
        .map(item => item.channelMessageId!);

      if (messageIds.length === 0) {
        logger.debug({ conversationKey: key, watermark: status.timestamp }, 'read watermark matched no sent outbound');
        return;
      }

      // Observability only: mark those ids read in the tracker. Does NOT advance
      // the queue (advance-on-send already moved past every sent item).
      this.statusTracker?.applyReadWatermark({
        messageIds,
        channel: status.channel,
        watermark: status.timestamp,
        conversationKey: key
      });
    } catch (error) {
      logger.error({ err: error, conversationKey: key, watermark: status.timestamp }, 'read watermark handling failed');
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /* Delivery-timeout fallback                                                 */
  /* ──────────────────────────────────────────────────────────────────────── */

  /**
   * Arm a fallback timer for an on_status (WhatsApp) send. If no advancing
   * status arrives within `outboundDeliveryTimeoutMs` while the queue is STILL
   * on this index, advance anyway so a dropped status webhook can't wedge the
   * conversation in `sending` forever.
   */
  private startDeliveryTimeout(key: string, messageIndex: number, traceId?: string): void {
    // LOAD-BEARING clear-before-arm: cancel any prior timer for this key BEFORE
    // arming the new one so there is only ever ONE outstanding delivery timer
    // per conversation. Without this, a previous item's timer could survive and
    // fire against a later index. Combined with the `currentOutboundIndex ===
    // messageIndex` guard in onDeliveryTimeoutImpl, this is what makes the
    // fallback safe from double-advancing the queue. Do not reorder.
    this.clearDeliveryTimeout(key);
    const handle = setTimeout(() => {
      this.deliveryTimeouts.delete(key);
      // The timer fires OUTSIDE any held lock, so it's a true entry point: it
      // ACQUIRES the per-key lock before running the (lock-free) timeout body,
      // serializing it against handleStatus/sendNext/handleInbound for this key.
      this.runExclusive(key, () => this.onDeliveryTimeoutImpl(key, messageIndex, traceId)).catch(error =>
        this.logger.warn({ err: error, conversationKey: key }, 'delivery-timeout handling failed')
      );
    }, this.config.conversation.outboundDeliveryTimeoutMs);
    this.deliveryTimeouts.set(key, handle);
  }

  /**
   * Fired when a WhatsApp delivery status never arrived; advances if still stuck.
   * INTERNAL / lock-free: only ever reached via the setTimeout in
   * {@link startDeliveryTimeout}, which wraps it in {@link runExclusive}.
   */
  private async onDeliveryTimeoutImpl(key: string, messageIndex: number, traceId?: string): Promise<void> {
    const logger = this.childLogger(traceId);
    const record = await this.store.getConversation(key);
    // LOAD-BEARING guard: only act if we're STILL waiting on the SAME item. A
    // status (or another path) may have advanced the cursor between this timer
    // arming and firing, in which case this timer is stale and advancing again
    // would double-advance and skip an unsent item. With the per-key lock this
    // race is fully closed, but the guard stays as defense-in-depth — do not
    // remove it (it pairs with the clear-before-arm in startDeliveryTimeout).
    if (!record || record.currentOutboundIndex !== messageIndex) return;
    // The timeout actually fired against a STILL-in-flight item (no terminal
    // status arrived in time) — count it before advancing the fallback.
    this.metrics?.deliveryTimeoutFired.inc();
    logger.warn({ conversationKey: key, messageIndex }, 'delivery status timeout; advancing');
    const messageId = record.currentOutboundMessageId;
    await this.advanceAndContinue(key, messageId, traceId);
  }

  private clearDeliveryTimeout(key: string): void {
    const handle = this.deliveryTimeouts.get(key);
    if (handle) clearTimeout(handle);
    this.deliveryTimeouts.delete(key);
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /* Helpers + lifecycle                                                       */
  /* ──────────────────────────────────────────────────────────────────────── */

  /** Reset a conversation to `idle`, clearing any in-flight delivery/retry timer. */
  private async transitionToIdle(key: string): Promise<void> {
    this.clearDeliveryTimeout(key);
    // Stage 10: this is a turn boundary — clear the retry timer + the stashed
    // request so a settled turn leaves no dangling retry or re-prompt state.
    this.clearTransientRetryTimer(key);
    this.pendingRequests.delete(key);
    const record = await this.store.getConversation(key);
    if (!record) return;
    record.state = 'idle';
    delete record.currentOutboundMessageId;
    record.lastActivity = this.now();
    await this.store.setConversation(record);
  }

  /**
   * Finalize a turn that COMPLETED (sent its outbound, went silent, or had nothing
   * deliverable). Two outcomes, both of which RESET `reprocessCount` to 0 — the cap
   * counts only consecutive aborts WITHIN one logical turn, so a turn that actually
   * resolved starts the next turn fresh:
   *
   *  - OVERFLOW FOLLOW-UP: if messages arrived during this turn (`lateArrivals`,
   *    e.g. during a COMMITTED flush that couldn't be interrupted), they are NOT
   *    lost. Move them into `inboundBuffer`, drop back to `buffering`, and schedule
   *    a fresh flush — a brand-new logical turn that produces its OWN response.
   *  - OTHERWISE: go fully idle (clearing any delivery timer), exactly as before.
   *
   * Called from the lock-held completion paths (segment 2 silence/no-deliverable
   * branches and `sendNext`'s queue-complete branch), so it assumes the per-key
   * lock is held and the caller passes the freshly-loaded `record`.
   */
  private async finalizeTurn(record: ConversationRecord, traceId?: string): Promise<void> {
    const key = record.key;
    this.clearDeliveryTimeout(key);
    // Stage 10: the current turn's SENDING is over (whatever follows is a fresh
    // turn), so clear its retry timer + stashed re-prompt request here.
    this.clearTransientRetryTimer(key);
    this.pendingRequests.delete(key);
    record.reprocessCount = 0;
    delete record.currentOutboundMessageId;
    if (record.lateArrivals.length > 0) {
      record.inboundBuffer = [...record.inboundBuffer, ...record.lateArrivals];
      record.lateArrivals = [];
      record.outboundQueue = [];
      record.currentOutboundIndex = 0;
      record.state = 'buffering';
      record.lastActivity = this.now();
      await this.store.setConversation(record);
      const delayMs = calculateBufferTimeout(record.inboundBuffer.length, this.config.conversation, this.random);
      await this.scheduler.schedule(key, delayMs, traceId !== undefined ? { traceId } : undefined);
      return;
    }

    // FINDING 2 (interrupt-between-segments race): an `interruptSending` can run
    // BETWEEN segment 2 (which set `sending`) and segment 3's `sendNext` — it
    // re-buffers the record (`state = 'buffering'`, appends to `inboundBuffer`,
    // resets the queue) and schedules a fresh flush. Segment 3 then loads that
    // re-buffered record, finds an empty queue, and reaches `finalizeTurn` with
    // no `lateArrivals`. Forcing `idle` here would clobber the in-progress
    // `buffering` turn, leaving the invalid `idle + non-empty inboundBuffer`
    // state (with a flush already scheduled). So: if the record has already been
    // re-buffered (it is `buffering` with a non-empty `inboundBuffer`, i.e. a
    // flush is pending), leave it untouched — the scheduled flush owns the turn.
    if (record.state === 'buffering' && record.inboundBuffer.length > 0) {
      return;
    }
    record.state = 'idle';
    record.lastActivity = this.now();
    await this.store.setConversation(record);
  }

  /** The adapter's `supports()` truth set, as the array the chat request wants. */
  private capabilitiesOf(adapter: ChannelAdapter): ChannelFeature[] {
    return ALL_CHANNEL_FEATURES.filter(feature => adapter.supports(feature));
  }

  /**
   * Delay between a typing indicator and the text it precedes. Derived from the
   * configured refresh interval but capped low so a long interval can't stall
   * the send; injectable indirectly via the `sleep` dep (no-op in tests).
   */
  private typingDelayMs(): number {
    const refresh = this.config.conversation.typingRefreshIntervalMs;
    return Math.min(refresh > 0 ? refresh : DEFAULT_TYPING_DELAY_MS, MAX_TYPING_DELAY_MS);
  }

  /** A child logger carrying the request trace id when one is available. */
  /**
   * Mark the user's most recent inbound message read for this turn.
   *
   * Fires once per flush, BEFORE the chat call, gated on `READ_RECEIPTS_ENABLED`
   * and `supports('read_receipt')` — so a silent, reaction-only, or chat-error
   * turn still marks the message read. Deliberately decoupled from the typing
   * indicator: WhatsApp's typing call only marks read as a side effect when a
   * text reply is sent, and Messenger/Instagram typing never marks read at all.
   * WhatsApp marks the most recent inbound wamid; Messenger/Instagram mark the
   * whole thread seen (their adapters ignore the message id). Best-effort: a
   * failure is logged and swallowed, never blocking the turn.
   */
  private async maybeMarkRead(
    record: ConversationRecord,
    adapter: ChannelAdapter,
    logger: pino.Logger
  ): Promise<void> {
    if (!this.config.conversation.readReceiptsEnabled) return;
    if (!adapter.supports('read_receipt')) return;
    // The uniform adapter signature requires a message id (WhatsApp needs the
    // inbound wamid). At flush there is always a buffered message that set this,
    // so the guard is defensive; Messenger/Instagram ignore the id but the call
    // stays uniform.
    const messageId = record.lastInboundMessageId;
    if (messageId === undefined) return;
    try {
      await adapter.markRead(record.channelScopedUserId, messageId);
      this.metrics?.outboundSendTotal.inc({
        channel: record.channel,
        operation: 'mark_read',
        result: 'success',
        error_code: 'none'
      });
      logger.debug({ conversationKey: record.key, channel: record.channel }, 'marked inbound read');
    } catch (error) {
      const errorCode = error instanceof MetaApiError ? normalizeErrorCodeLabel(error.errorCode) : 'other';
      this.metrics?.outboundSendTotal.inc({
        channel: record.channel,
        operation: 'mark_read',
        result: 'error',
        error_code: errorCode
      });
      logger.warn(
        { err: error, conversationKey: record.key, channel: record.channel },
        'read receipt failed (non-fatal)'
      );
    }
  }

  private childLogger(traceId?: string): pino.Logger {
    return traceId !== undefined ? this.logger.child({ traceId }) : this.logger;
  }

  /**
   * Clear all delivery + transient-retry timers, abort in-flight chats, drop
   * stashed requests, and close the scheduler / store / limit tracker.
   */
  async close(): Promise<void> {
    for (const handle of this.deliveryTimeouts.values()) clearTimeout(handle);
    this.deliveryTimeouts.clear();
    // Stage 10: cancel every outstanding transient-retry timer + drop the stashed
    // re-prompt requests so shutdown leaves no dangling timer or in-memory state.
    for (const handle of this.transientRetryTimers.values()) clearTimeout(handle);
    this.transientRetryTimers.clear();
    this.pendingRequests.clear();
    // RESOURCE: abort every in-flight chat call so shutdown cancels the underlying
    // HTTP request rather than leaving an open socket to a slow chat endpoint
    // dangling past close(). Each abort just rejects the awaiting flush (handled as
    // an abort); swallow per-controller failures so one bad abort can't block the
    // rest. Clear the map so a late inbound after close() finds no stale handle.
    for (const controller of this.inFlightChatAborts.values()) {
      try {
        controller.abort();
      } catch {
        /* best-effort: a controller that fails to abort must not block shutdown. */
      }
    }
    this.inFlightChatAborts.clear();
    await this.scheduler.close();
    // Stage 10: release durable resources where present (both may be no-ops /
    // absent). Guard each so one failing close can't block the rest of shutdown.
    await this.store.close?.();
    await this.limitTracker?.close?.();
  }
}
