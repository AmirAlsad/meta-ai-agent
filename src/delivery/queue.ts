/**
 * Pure delivery-queue logic.
 *
 * Turns normalized {@link ChatAction}s into an ordered {@link OutboundItem}
 * queue and decides, per channel, HOW that queue advances. Everything here is
 * side-effect-free: no I/O, no timers, no adapter calls. The actual sending
 * (calling the {@link ChannelAdapter}) and the wait/advance loop live in the
 * ConversationAgent — keeping this module pure makes it trivially testable and
 * lets the agent own all the effects.
 *
 * See `src/delivery/types.ts` for the shapes ({@link OutboundItem},
 * {@link AdvancementMode}, {@link QueueState}).
 */

import { randomUUID } from 'node:crypto';
import type { ChatAction } from '../chat/types.js';
import { resolveTargetRef } from '../chat/target-resolver.js';
import type { ChannelFeature, TemplateComponent } from '../meta/shared/adapter.js';
import type { Channel, DeliveryStatus, IncomingMessage } from '../meta/types.js';
import type { OutboundItem, AdvancementMode, QueueState } from './types.js';

/** Result of mapping a turn's actions into queueable items + skip notes. */
export interface BuildOutboundResult {
  /** The deliverable items, in order, each with a fresh local `id`. */
  items: OutboundItem[];
  /** Actions that produced no (or a downgraded) item, for observability/logging. */
  skipped: Array<{ kind: string; reason: string }>;
}

/**
 * Map normalized {@link ChatAction}s to {@link OutboundItem}s, filtering out
 * actions the channel's adapter does not support. `supports` is the
 * adapter.supports predicate. Each produced item gets a fresh local `id`
 * (`randomUUID`) used to correlate it across retries/persistence — distinct
 * from the `channelMessageId` Meta returns after a successful send.
 *
 * `options.inboundMessages` is the turn's buffered inbound {@link
 * IncomingMessage}[] (oldest first) — the candidate set against which a `reply`
 * / `reaction` symbolic {@link TargetRef} target is resolved into a concrete
 * `channelMessageId`. The param is OPTIONAL (defaults to `[]`) so the existing
 * two-arg call sites still compile; without it, symbolic targets that need
 * history simply fail to resolve and follow the unresolved-target paths below.
 *
 * Skipped actions (unsupported features, the reply→message downgrade note, the
 * unresolved-target downgrade/skip, and the silence no-op) are NOT thrown —
 * they are returned in `skipped` so the agent can log them. This mirrors the
 * contract's "unsupported actions are skipped, not errored" rule.
 */
export function buildOutboundItems(
  actions: ChatAction[],
  supports: (feature: ChannelFeature) => boolean,
  options?: { inboundMessages?: IncomingMessage[] }
): BuildOutboundResult {
  const items: OutboundItem[] = [];
  const skipped: Array<{ kind: string; reason: string }> = [];
  const inboundMessages = options?.inboundMessages ?? [];

  for (const action of actions) {
    switch (action.type) {
      case 'message':
        items.push({ id: randomUUID(), kind: 'message', text: action.text });
        break;

      case 'reply': {
        // Resolve the symbolic-or-literal target first so the supports() check
        // and the resolution check compose cleanly. A literal-string target
        // passes through unchanged (see resolveTargetRef); a TargetRef resolves
        // against the turn's inbound messages.
        const resolution = resolveTargetRef(action.targetMessageId, inboundMessages);
        if (!resolution.ok) {
          // WHY downgrade rather than skip: same reasoning as the reply_to
          // case below — the text still matters to the user even when we can't
          // thread it. We deliver the body as a plain `message` and note that
          // the target couldn't be resolved so the lost threading is
          // observable, instead of dropping content the developer asked us to
          // send.
          items.push({ id: randomUUID(), kind: 'message', text: action.text });
          skipped.push({ kind: 'reply', reason: `target unresolved: ${resolution.reason}; downgraded to message` });
          break;
        }
        if (supports('reply_to')) {
          items.push({
            id: randomUUID(),
            kind: 'reply',
            text: action.text,
            targetMessageId: resolution.messageId
          });
        } else {
          // WHY downgrade rather than skip: the text content still matters to
          // the user even when the channel can't thread the reply to a
          // specific message. We deliver the body as a plain `message` and
          // record a note so the loss of threading is observable, instead of
          // silently dropping content the developer asked us to send.
          items.push({ id: randomUUID(), kind: 'message', text: action.text });
          skipped.push({ kind: 'reply', reason: 'reply_to unsupported; downgraded to message' });
        }
        break;
      }

      case 'reaction': {
        if (!supports('reaction')) {
          skipped.push({ kind: 'reaction', reason: 'reaction unsupported on this channel' });
          break;
        }
        // A reaction carries no text, so an unresolved target leaves NOTHING to
        // deliver — there is no downgrade, we just skip with a note (unlike a
        // reply, which still has a body worth sending as a plain message).
        const resolution = resolveTargetRef(action.targetMessageId, inboundMessages);
        if (!resolution.ok) {
          skipped.push({ kind: 'reaction', reason: `target unresolved: ${resolution.reason}` });
          break;
        }
        items.push({
          id: randomUUID(),
          kind: 'reaction',
          emoji: action.emoji,
          targetMessageId: resolution.messageId
        });
        break;
      }

      case 'typing':
        if (supports('typing_indicator')) {
          items.push({ id: randomUUID(), kind: 'typing', durationMs: action.durationMs });
        } else {
          // Typing is best-effort: skipping it never loses user-visible
          // content, but we still record a reason for observability.
          skipped.push({ kind: 'typing', reason: 'typing_indicator unsupported on this channel' });
        }
        break;

      case 'media':
        // Media is sent (Stage 7) when the channel advertises `media_send`
        // (WhatsApp / Messenger / Instagram all do). The agent infers the
        // send-kind from `mediaMimeType` and routes via `adapter.sendMedia`. A
        // channel that does NOT support media (or, e.g., an Instagram document —
        // skipped at send time via the adapter's throw) is recorded here.
        if (supports('media_send')) {
          items.push({
            id: randomUUID(),
            kind: 'media',
            mediaUrl: action.url,
            mediaCaption: action.caption,
            mediaMimeType: action.mimeType,
            mediaFilename: action.filename
          });
        } else {
          skipped.push({ kind: 'media', reason: 'media_send unsupported on this channel' });
        }
        break;

      case 'template':
        if (supports('template')) {
          items.push({
            id: randomUUID(),
            kind: 'template',
            templateName: action.name,
            templateLanguage: action.language,
            // `TemplateComponent[]` is forwarded verbatim; `OutboundItem` types
            // it as `unknown` to keep `delivery` decoupled from the WA schema.
            templateComponents: action.components as TemplateComponent[] | undefined
          });
        } else {
          skipped.push({ kind: 'template', reason: 'template unsupported on this channel' });
        }
        break;

      case 'silence':
        // A `silence` action is a no-op signal (an explicit "send nothing"),
        // so it produces neither an item nor a skip note.
        break;
    }
  }

  return { items, skipped };
}

/**
 * Per-channel queue advancement policy.
 *
 * WHY the distinction: WhatsApp emits per-message `statuses[]` (sent /
 * delivered / read), so its queue can wait for a delivery/sent status callback
 * before advancing (`on_status`) — giving true ordered delivery. Messenger and
 * Instagram have no reliable per-message delivery webhook, so the only
 * confirmation available is the successful send API response; their queue must
 * advance as soon as the send returns (`on_send`).
 */
export function advancementMode(channel: Channel): AdvancementMode {
  return channel === 'whatsapp' ? 'on_status' : 'on_send';
}

/**
 * Whether an inbound {@link DeliveryStatus} should advance the queue for this
 * channel. Only meaningful for `on_status` channels (WhatsApp).
 *
 * For WhatsApp: `sent`/`delivered` mean the message left / arrived, so the
 * queue may advance; `read` is post-delivery (the queue already moved on) and
 * `failed` is handled separately by retry logic (Stage 10), so neither
 * advances here. For `on_send` channels (Messenger/Instagram) this is always
 * false — the queue already advanced at send time, so a (watermark-derived)
 * status must never double-advance it.
 */
export function statusAdvancesQueue(channel: Channel, status: DeliveryStatus): boolean {
  if (advancementMode(channel) !== 'on_status') return false;
  return status === 'sent' || status === 'delivered';
}

/** The item currently at the cursor, or `undefined` when the cursor is past the end. */
export function currentItem(state: QueueState): OutboundItem | undefined {
  return state.items[state.currentIndex];
}

/** True once the cursor has moved past the last item (nothing left to send). */
export function isQueueComplete(state: QueueState): boolean {
  return state.currentIndex >= state.items.length;
}

/**
 * Advance the cursor by one, returning a NEW {@link QueueState} (the input is
 * not mutated — the same `items` array is reused, only `currentIndex` changes).
 */
export function advanceCursor(state: QueueState): QueueState {
  return { items: state.items, currentIndex: state.currentIndex + 1 };
}
