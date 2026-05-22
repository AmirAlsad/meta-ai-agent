/**
 * Delivery-status tracker types — the per-outbound-message status history the
 * Stage 6 observability surface (`GET /admin/status/:messageId`) and metrics
 * read from.
 *
 * Adapted from the SendBlue repo's `src/status/tracker.ts`, but pared down to
 * Meta's four-value {@link DeliveryStatus} enum. Unlike SendBlue (8 callback
 * values, sticky downgrade, channel-aware terminality), Meta's status model is
 * a simple forward progression — `sent` → `delivered` → `read` — with `failed`
 * as a distinct terminal outcome. We reuse `DeliveryStatus` from the parser so
 * there is exactly one status vocabulary across the package.
 */

import type { Channel, DeliveryStatus } from '../meta/types.js';
import type { FailureCategory } from '../limits/error-codes.js';

/**
 * One observed status transition for an outbound message.
 *
 * `history` keeps these in arrival order (append-only), so the admin route can
 * render a full timeline even when Meta delivers events out of order (e.g. a
 * late `sent` after `delivered`) or redelivers them. `errorCode`/`errorTitle`
 * are WhatsApp-only and only populated on a `failed` entry. `errorCategory` is
 * the human-readable bucket the tracker derives from `errorCode` (e.g.
 * `window_closed`, `recipient`) so the admin surface shows a category, not a
 * bare int — populated only on a `failed` entry.
 */
export interface StatusHistoryEntry {
  status: DeliveryStatus;
  timestamp: number;
  errorCode?: number;
  errorTitle?: string;
  errorCategory?: FailureCategory;
}

/**
 * Accumulated delivery-status record for a single outbound message, keyed by
 * its channel-scoped id (`channelMessageId`).
 *
 * `current` is the MOST-ADVANCED status seen (by {@link STATUS_RANK}), not the
 * most-recent — see the tracker for why this can't regress. `history` is the
 * raw, ordered log of everything observed.
 */
export interface StatusRecord {
  /** Channel-scoped id: WhatsApp wamid, Messenger `m_*`, Instagram base64-ish id. */
  channelMessageId: string;
  channel: Channel;
  /** The conversation this outbound belongs to, when the caller supplies it. */
  conversationKey?: string;
  /** The user side (`wa_id` / PSID / IGSID), when the caller supplies it. */
  recipientId?: string;
  /** The most-advanced status seen (per {@link STATUS_RANK}). */
  current: DeliveryStatus;
  /** Chronological, append-only log of every status observed. */
  history: StatusHistoryEntry[];
  /** Unix ms of the first status seen for this message. */
  firstSeenAt: number;
  /** Unix ms of the most recent status applied. */
  lastUpdatedAt: number;
  /**
   * The failure bucket of the most recent `failed` status seen, mirrored from
   * the corresponding history entry so a dashboard can read it off the record
   * without scanning `history`. Only set once a `failed` status has been
   * applied (WhatsApp-only); absent otherwise.
   */
  errorCategory?: FailureCategory;
}

/**
 * Ordering for "most advanced" status resolution.
 *
 * WHY a rank rather than last-write-wins: Meta does not guarantee status events
 * arrive in lifecycle order, and it redelivers them. Ranking by progression
 * (`sent` < `delivered` < `read`) means a late, out-of-order `sent` arriving
 * after `delivered` cannot regress `current` — yet `history` still records it.
 *
 * `failed` is given the TOP rank so a terminal failure is never masked by a
 * lower-rank success. In practice a single message is either `failed` OR it
 * progresses; Meta does not emit a success after a `failed` for the same id, so
 * the highest-rank-wins rule yields the intuitive `current` in every real case.
 */
export const STATUS_RANK: Record<DeliveryStatus, number> = {
  sent: 0,
  delivered: 1,
  read: 2,
  failed: 3
};
