/**
 * Ordered-delivery types.
 *
 * The chat endpoint returns one or more response items; each is normalized
 * into an {@link OutboundItem} and appended to a per-conversation queue. The
 * queue sends the head item, waits for confirmation, then advances. Confirmation
 * is channel-aware (see {@link AdvancementMode}). The queue logic itself lands
 * later in Stage 5 (`src/delivery/queue.ts`); this file is the shared shape.
 */

import type { Channel } from '../meta/types.js';

/** The kinds of outbound action the delivery queue can carry. */
export type OutboundItemKind =
  | 'message'
  | 'reply'
  | 'reaction'
  | 'typing'
  | 'media'
  | 'template'
  | 'silence';

/**
 * A single queued outbound action plus its delivery bookkeeping.
 *
 * `id` is a LOCAL identifier (e.g. `crypto.randomUUID()`) used to correlate the
 * item across retries/persistence; it is distinct from `channelMessageId`,
 * which is the channel-scoped id Meta returns AFTER the send succeeds. Fields
 * are a flat superset across kinds — only the ones relevant to `kind` are set.
 */
export interface OutboundItem {
  /** Local id (e.g. `crypto.randomUUID()`) — stable across retries/persistence. */
  id: string;
  kind: OutboundItemKind;
  /** Body text for `message` / `reply`; caption is `mediaCaption` for `media`. */
  text?: string;
  /** Reply target / reaction target — a channel-scoped inbound message id. */
  targetMessageId?: string;
  /** Reaction emoji (empty string is a valid WhatsApp un-react). */
  emoji?: string;
  /** Typing duration hint in milliseconds. */
  durationMs?: number;
  mediaUrl?: string;
  mediaCaption?: string;
  mediaMimeType?: string;
  /** Document filename hint (used by `kind: 'media'` when the kind is a document). */
  mediaFilename?: string;
  templateName?: string;
  templateLanguage?: string;
  /**
   * Template components forwarded verbatim to the WhatsApp client. Typed as
   * `unknown` here to keep `delivery` decoupled from the WhatsApp template
   * schema; the queue narrows/casts at the send boundary. The structured shape
   * is `TemplateComponent[]` (see `src/meta/shared/adapter.ts`).
   */
  templateComponents?: unknown;
  // delivery bookkeeping (set as the item moves through the queue):
  /** Channel-scoped id returned by the send API — set after a successful send. */
  channelMessageId?: string;
  /** Unix milliseconds the send succeeded. */
  sentAt?: number;
  /** Unix milliseconds the item was skipped (unsupported feature, silence, etc.). */
  skippedAt?: number;
  /** Human-readable reason the item was skipped. */
  skipReason?: string;
}

/**
 * Whether a channel's queue advances when the send API returns (`on_send`) or
 * only when a delivery/sent status webhook arrives (`on_status`).
 *
 * WHY this matters: WhatsApp emits per-message `statuses[]` (sent/delivered/
 * read), so its queue can advance on a delivery status callback (`on_status`).
 * Messenger and Instagram have no per-message delivery callback, so their only
 * confirmation is the successful send API response (`on_send`).
 */
export type AdvancementMode = 'on_send' | 'on_status';

/** Minimal per-conversation queue cursor: the items plus the in-flight index. */
export interface QueueState {
  items: OutboundItem[];
  currentIndex: number;
}

// Referenced in doc comments above; re-stated here so `Channel` stays an
// explicit import even if the doc tooling does not count JSDoc references.
export type { Channel };
