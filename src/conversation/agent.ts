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

import type pino from 'pino';
import type { ChatClient } from '../chat/client.js';
import { ChatEndpointError } from '../chat/errors.js';
import type { ChatRequest } from '../chat/types.js';
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
import type { Channel, IncomingMessage, StatusUpdate } from '../meta/types.js';
import type { WhatsAppClient } from '../meta/whatsapp/client.js';
import type { AgentMetrics } from '../metrics/registry.js';
import { normalizeErrorCodeLabel } from '../metrics/registry.js';
import type { IdentityResolver } from '../identity/resolver.js';
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

  /**
   * Per-conversation delivery-timeout fallback timers, keyed by conversation
   * key. Only WhatsApp (`on_status`) arms these — if a delivery/sent status
   * never arrives, the timer advances the queue so it cannot wedge forever.
   */
  private readonly deliveryTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

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

    // Register the buffer-flush handler exactly once. The scheduler fires this
    // after a conversation's burst window elapses (see calculateBufferTimeout).
    // The scheduler timer fires OUTSIDE any held lock, so this is a true entry
    // point: it ACQUIRES the per-key lock before running the (lock-free)
    // flush body, serializing flush against handleInbound/handleStatus/timeout
    // for the same key.
    this.scheduler.setHandler(async (conversationKey, options) => {
      await this.runExclusive(conversationKey, () => this.flushImpl(conversationKey, options));
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
  /*    • the scheduler flush handler            (constructor; fired by a      */
  /*      buffer timer)                                                        */
  /*    • the delivery-timeout callback          (startDeliveryTimeout's       */
  /*      setTimeout; fired by a delivery timer)                               */
  /*    • handleReaction DOES NOT acquire — it delegates to handleInbound,     */
  /*      which acquires, so it inherits the lock (acquiring here too would    */
  /*      deadlock the chain: a holder calling a same-key acquirer).           */
  /*                                                                          */
  /*  DO NOT acquire (internal; ONLY ever reached from within a holder, so    */
  /*  they assume the lock is already held):                                   */
  /*    • flushImpl, sendNext, advanceAndContinue, markSkippedAndAdvance,      */
  /*      transitionToIdle, onDeliveryTimeoutImpl, handleInboundImpl,          */
  /*      handleStatusImpl                                                     */
  /*                                                                          */
  /*  NO-DEADLOCK INVARIANT: no lock-holding (acquired) path ever calls        */
  /*  another lock-acquiring method for the SAME key. The acquiring methods    */
  /*  call ONLY the *Impl bodies, and no *Impl body calls handleInbound /      */
  /*  handleStatus / onDeliveryTimeout (verified against the call graph). The  */
  /*  promise chain is therefore strictly linear per key and cannot wait on    */
  /*  itself.                                                                  */
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

      // Append to the buffer and refresh the activity/window bookkeeping. The
      // 24h messaging window restarts from every inbound (`lastInboundAt + 24h`).
      record.inboundBuffer.push(message);
      record.lastInboundAt = now;
      record.windowExpiresAt = now + MESSAGING_WINDOW_MS;
      record.lastActivity = now;
      record.lastInboundMessageId = message.channelMessageId;
      if (traceId !== undefined) record.traceId = traceId;
      record.state = 'buffering';
      await this.store.setConversation(record);

      // (Re)arm the flush timer. A fresh inbound resets the per-key timer, so a
      // rapid burst aggregates into ONE flush rather than N chat calls.
      //
      // LOCK SAFETY: we're holding the per-key lock here. `scheduler.schedule`
      // with `delayMs > 0` only registers a setTimeout and returns — the flush
      // handler (which re-acquires the SAME key's lock) fires LATER, outside
      // this lock, so there is no self-deadlock. A `delayMs <= 0` would make the
      // scheduler fire the handler INLINE (synchronously), which WOULD deadlock
      // the chain. `calculateBufferTimeout` never returns <= 0 for a valid
      // config (bufferBaseTimeoutMs is a positive int, clamped to >= base*0.5),
      // so this stays safe — keep that invariant if the buffer math changes.
      const delayMs = calculateBufferTimeout(
        record.inboundBuffer.length,
        this.config.conversation,
        this.random
      );
      await this.scheduler.schedule(key, delayMs, traceId !== undefined ? { traceId } : undefined);
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

  /* ──────────────────────────────────────────────────────────────────────── */
  /* Flush (buffering → processing → sending)                                 */
  /* ──────────────────────────────────────────────────────────────────────── */

  /**
   * Buffer-flush body. Snapshots the buffered turn, calls the chat endpoint, and
   * starts ordered delivery of the resulting actions.
   *
   * INTERNAL / lock-free: invoked ONLY by the scheduler handler (constructor),
   * which wraps it in {@link runExclusive}, so it runs with the per-key lock
   * already held. It must NOT re-acquire (it calls sendNext/transitionToIdle,
   * which are likewise lock-free).
   */
  private async flushImpl(key: string, opts?: { traceId?: string }): Promise<void> {
    const traceId = opts?.traceId;
    const logger = this.childLogger(traceId);
    try {
      const record = await this.store.getConversation(key);
      if (!record || record.inboundBuffer.length === 0) {
        // Nothing to flush (already drained by a prior flush, or no record).
        return;
      }

      // WHY snapshot-and-clear up front: the chat call is async and a new
      // inbound may arrive mid-flight. Clearing the buffer NOW (and persisting)
      // means those new messages accumulate cleanly for the NEXT flush instead
      // of being re-sent in this turn or lost when we overwrite the record.
      const batch = record.inboundBuffer;
      record.inboundBuffer = [];
      record.state = 'processing';
      await this.store.setConversation(record);

      const adapter = this.adapters[record.channel];
      if (!adapter) {
        // Channel not configured (no adapter wired) — cannot send a reply.
        logger.warn({ conversationKey: key, channel: record.channel }, 'no adapter for channel; dropping turn');
        await this.transitionToIdle(key);
        return;
      }

      // Read receipt for this turn — fired BEFORE the chat call so a silent,
      // reaction-only, or even chat-error turn still marks the user's message
      // read. Decoupled from the typing indicator (which only marks read as a
      // WhatsApp side effect when a text reply is sent). Best-effort.
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

      let resp;
      // Time only the chat dispatch (the developer's endpoint round-trip), using
      // the injectable clock so tests stay deterministic.
      const t0 = this.now();
      try {
        resp = await this.chatClient.complete(request);
      } catch (error) {
        this.metrics?.chatDispatchDuration.observe({ result: 'error' }, (this.now() - t0) / 1000);
        this.metrics?.bufferFlushTotal.inc({ result: 'error' });
        // Fail soft: Stage 10 adds retry. For now a chat-endpoint failure ends
        // the turn quietly (the user simply gets no reply).
        if (error instanceof ChatEndpointError) {
          logger.error({ err: error, conversationKey: key }, 'chat endpoint failed; ending turn');
        } else {
          logger.error({ err: error, conversationKey: key }, 'unexpected error calling chat endpoint');
        }
        await this.transitionToIdle(key);
        return;
      }
      this.metrics?.chatDispatchDuration.observe({ result: 'success' }, (this.now() - t0) / 1000);

      // An explicit silence (or an empty action list) means "send nothing".
      if (resp.silence === true || resp.actions.length === 0) {
        this.metrics?.bufferFlushTotal.inc({ result: 'silence' });
        logger.debug({ conversationKey: key, silence: resp.silence === true }, 'chat response produced no outbound');
        await this.transitionToIdle(key);
        return;
      }

      const { items, skipped } = buildOutboundItems(resp.actions, f => adapter.supports(f));
      if (skipped.length > 0) {
        logger.debug({ conversationKey: key, skipped }, 'some chat actions were skipped/downgraded');
      }
      if (items.length === 0) {
        // Every action was unsupported and skipped (no downgrade produced an
        // item). No outbound is dispatched, so count it as a silent flush.
        this.metrics?.bufferFlushTotal.inc({ result: 'silence' });
        logger.debug({ conversationKey: key }, 'no deliverable items after capability filtering');
        await this.transitionToIdle(key);
        return;
      }

      // We have at least one deliverable item — the flush dispatched outbound work.
      this.metrics?.bufferFlushTotal.inc({ result: 'dispatched' });

      // Reload to pick up any record mutations (e.g. lastInboundMessageId from a
      // concurrent inbound) before we attach the queue, then enter `sending`.
      const sendRecord = (await this.store.getConversation(key)) ?? record;
      sendRecord.outboundQueue = items;
      sendRecord.currentOutboundIndex = 0;
      delete sendRecord.currentOutboundMessageId;
      sendRecord.state = 'sending';
      await this.store.setConversation(sendRecord);

      await this.sendNext(key, traceId);
    } catch (error) {
      logger.error({ err: error, conversationKey: key }, 'flush failed');
      await this.transitionToIdle(key).catch(() => {
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
      delete record.currentOutboundMessageId;
      record.state = 'idle';
      record.lastActivity = this.now();
      await this.store.setConversation(record);
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
    // Time each adapter (Meta Graph API) call; injectable clock keeps it
    // deterministic in tests. `operation` is the item kind so the histogram
    // distinguishes text vs. reaction vs. template latency.
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
        case 'media':
        case 'silence':
        default:
          // media is filtered until Stage 7; silence never produces an item.
          // Either appearing here is unexpected — skip rather than crash.
          logger.warn({ conversationKey: key, kind: item.kind }, 'unexpected outbound item kind; skipping');
          break;
      }
      // The send returned (or was a benign no-op skip). Record success — for the
      // no-op skip kinds (media/silence/unhandled) the adapter call didn't run,
      // but counting them as a zero-latency success keeps the metric simple and
      // these kinds don't reach here in normal Stage 6 flows anyway.
      this.metrics?.outboundSendTotal.inc({
        channel: record.channel,
        operation: item.kind,
        result: 'success',
        error_code: 'none'
      });
      this.metrics?.outboundSendDuration.observe(
        { channel: record.channel, operation: item.kind },
        (this.now() - sendT0) / 1000
      );
    } catch (error) {
      // On a Meta API failure, bound the error_code label to the known set.
      const errorCode = error instanceof MetaApiError ? normalizeErrorCodeLabel(error.errorCode) : 'other';
      this.metrics?.outboundSendTotal.inc({
        channel: record.channel,
        operation: item.kind,
        result: 'error',
        error_code: errorCode
      });
      if (error instanceof MetaApiError) {
        logger.error({ err: error, conversationKey: key, kind: item.kind }, 'outbound send failed; skipping item');
      } else {
        logger.error({ err: error, conversationKey: key, kind: item.kind }, 'unexpected outbound send error; skipping item');
      }
      // Stage 5 fail-soft: mark the item skipped and advance so one bad send
      // never wedges the rest of the queue. Stage 10 adds proper retry.
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
      // sentMessageId === undefined => media/silence/skipped-template (no result).
      await this.advanceAndContinue(key, undefined, traceId);
      return;
    }

    // message / reply / template with a real send result:
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
    const logger = opts?.logger ?? this.childLogger(traceId);
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

      // Stage 6 per-message status history (WhatsApp wamid 1:1). Recorded BEFORE
      // the advancement branch (which returns early) so the tracker captures the
      // status whether or not it advances the queue. Fail-soft: a tracker error
      // must not break delivery, so it's inside this method's try/catch.
      this.statusTracker?.applyStatusUpdate({
        channelMessageId: status.channelMessageId,
        channel: status.channel,
        status: status.status,
        timestamp: status.timestamp,
        conversationKey: mapping.conversationKey,
        ...(status.channelScopedUserId !== undefined ? { recipientId: status.channelScopedUserId } : {}),
        ...(status.errorCode !== undefined ? { errorCode: status.errorCode } : {}),
        ...(status.errorTitle !== undefined ? { errorTitle: status.errorTitle } : {})
      });

      // Only advance when this status both advances the queue for this channel
      // (WhatsApp sent/delivered) AND refers to the CURRENTLY in-flight item.
      if (statusAdvancesQueue(record.channel, status.status) && record.currentOutboundIndex === mapping.messageIndex) {
        await this.advanceAndContinue(key, status.channelMessageId, mapping.traceId ?? traceId);
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
    const logger = opts?.logger ?? this.childLogger(opts?.traceId);
    // Count the read callback even when there's nothing to mark (no record / no
    // qualifying ids) — we still observed the webhook.
    this.metrics?.statusCallbackTotal.inc({ channel: status.channel, status: 'read' });
    try {
      const record = await this.store.getConversation(key);
      if (!record) {
        logger.debug({ conversationKey: key, watermark: status.timestamp }, 'read watermark for unknown conversation');
        return;
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

  /** Reset a conversation to `idle`, clearing any in-flight delivery timer. */
  private async transitionToIdle(key: string): Promise<void> {
    this.clearDeliveryTimeout(key);
    const record = await this.store.getConversation(key);
    if (!record) return;
    record.state = 'idle';
    delete record.currentOutboundMessageId;
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

  /** Clear all delivery timers and close the buffer scheduler. */
  async close(): Promise<void> {
    for (const handle of this.deliveryTimeouts.values()) clearTimeout(handle);
    this.deliveryTimeouts.clear();
    await this.scheduler.close();
  }
}
