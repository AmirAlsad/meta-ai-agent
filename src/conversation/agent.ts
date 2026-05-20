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
import { calculateBufferTimeout } from './buffering.js';
import type { BufferScheduler } from './scheduler.js';
import type { ConversationStore } from './store.js';
import {
  conversationKeyFor,
  createIdleConversation,
  isWindowOpen,
  MESSAGING_WINDOW_MS
} from './types.js';

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
  async handleInbound(message: IncomingMessage, opts?: { traceId?: string }): Promise<void> {
    await this.runExclusive(conversationKeyFor(message), () => this.handleInboundImpl(message, opts));
  }

  /** Lock-free body of {@link handleInbound}. Assumes the per-key lock is held. */
  private async handleInboundImpl(message: IncomingMessage, opts?: { traceId?: string }): Promise<void> {
    const traceId = opts?.traceId;
    const logger = this.childLogger(traceId);
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
      if (!(await this.store.claimInboundHandle(message.channelMessageId))) {
        logger.debug(
          { channel: message.channel, channelMessageId: message.channelMessageId },
          'skipping duplicate inbound (already claimed)'
        );
        return;
      }

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
  async handleReaction(message: IncomingMessage, opts?: { traceId?: string }): Promise<void> {
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
      try {
        resp = await this.chatClient.complete(request);
      } catch (error) {
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

      // An explicit silence (or an empty action list) means "send nothing".
      if (resp.silence === true || resp.actions.length === 0) {
        logger.debug({ conversationKey: key, silence: resp.silence === true }, 'chat response produced no outbound');
        await this.transitionToIdle(key);
        return;
      }

      const { items, skipped } = buildOutboundItems(resp.actions, f => adapter.supports(f));
      if (skipped.length > 0) {
        logger.debug({ conversationKey: key, skipped }, 'some chat actions were skipped/downgraded');
      }
      if (items.length === 0) {
        // Every action was unsupported and skipped (no downgrade produced an item).
        logger.debug({ conversationKey: key }, 'no deliverable items after capability filtering');
        await this.transitionToIdle(key);
        return;
      }

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
    } catch (error) {
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
   * pre-lookup is only to find the key). An unmapped status has no conversation
   * to serialize on, so it runs unlocked straight to the benign no-op path.
   */
  async handleStatus(status: StatusUpdate, opts?: { traceId?: string }): Promise<void> {
    const preMapping = await this.store.getOutboundHandleMapping(status.channelMessageId);
    if (!preMapping) {
      await this.handleStatusImpl(status, opts);
      return;
    }
    await this.runExclusive(preMapping.conversationKey, () => this.handleStatusImpl(status, opts));
  }

  /** Lock-free body of {@link handleStatus}. Assumes the per-key lock is held. */
  private async handleStatusImpl(status: StatusUpdate, opts?: { traceId?: string }): Promise<void> {
    const traceId = opts?.traceId;
    const logger = this.childLogger(traceId);
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
