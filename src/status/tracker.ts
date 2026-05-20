/**
 * Delivery-status tracker — accumulates per-outbound-message status history for
 * observability (`GET /admin/status/:messageId`) and metrics, across all three
 * channels.
 *
 * Adapted from the SendBlue repo's `src/status/tracker.ts`. The model differs
 * per channel because Meta's webhooks differ:
 *  - WhatsApp emits per-message `statuses[]` (`sent`/`delivered`/`read`/`failed`)
 *    keyed by the real wamid → {@link StatusTracker.applyStatusUpdate}, 1:1.
 *  - Messenger (`message_reads`) and Instagram (`messaging_seen`) emit a READ
 *    WATERMARK, not a per-message id: every message sent at/before the watermark
 *    is read. The agent computes which outbound ids qualify (from the
 *    conversation record's outbound items with `sentAt <= watermark`) and passes
 *    them to {@link StatusTracker.applyReadWatermark}.
 *
 * The Redis-backed tracker (with TTL eviction) is Stage 10. This in-memory
 * implementation is the local/test path.
 */

import type { Channel, DeliveryStatus } from '../meta/types.js';
import { STATUS_RANK, type StatusHistoryEntry, type StatusRecord } from './types.js';

export interface StatusTracker {
  /** Record a per-message status (WhatsApp: real wamid). Idempotent on (messageId,status). */
  applyStatusUpdate(input: {
    channelMessageId: string;
    channel: Channel;
    status: DeliveryStatus;
    timestamp: number;
    conversationKey?: string;
    recipientId?: string;
    errorCode?: number;
    errorTitle?: string;
  }): StatusRecord;
  /** Messenger/IG read-watermark: mark a set of already-known message ids as read at the watermark time. The caller (agent) computes which ids were sent at/before the watermark. Returns the affected records. */
  applyReadWatermark(input: {
    messageIds: string[];
    channel: Channel;
    watermark: number;
    conversationKey?: string;
  }): StatusRecord[];
  getStatus(channelMessageId: string): StatusRecord | undefined;
  /** Optional: list recent records for a conversation (admin introspection). */
  listByConversation?(conversationKey: string, limit?: number): StatusRecord[];
}

/**
 * Deep-clone via JSON round-trip.
 *
 * WHY clone-on-read is load-bearing: the tracker hands {@link StatusRecord}s to
 * the admin route and the agent. {@link StatusRecord} shapes are JSON-safe
 * (primitives + a `history` array of plain objects), so a JSON round-trip is a
 * sufficient, dependency-free deep copy. Returning a copy means a caller that
 * mutates the result (sorts/truncates `history`, flips `current`) can't corrupt
 * the tracker's stored state — matching the conversation store's discipline.
 */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * In-memory {@link StatusTracker} backed by a `Map<channelMessageId, StatusRecord>`.
 *
 * For tests and local smoke runs only. The map is UNBOUNDED here — acceptable
 * for Stage 6 because the production path is the Redis-backed tracker (Stage 10)
 * where a TTL evicts records. We deliberately do NOT add a sweeper; an in-memory
 * sweeper would be per-process state that the Redis TTL supersedes.
 */
export class InMemoryStatusTracker implements StatusTracker {
  private readonly records = new Map<string, StatusRecord>();

  applyStatusUpdate(input: {
    channelMessageId: string;
    channel: Channel;
    status: DeliveryStatus;
    timestamp: number;
    conversationKey?: string;
    recipientId?: string;
    errorCode?: number;
    errorTitle?: string;
  }): StatusRecord {
    const existing = this.records.get(input.channelMessageId);

    const entry: StatusHistoryEntry = { status: input.status, timestamp: input.timestamp };
    // Only attach error fields when present so the entry stays clean for
    // non-failure statuses (and `failed` carries the WhatsApp diagnostics).
    if (input.errorCode !== undefined) entry.errorCode = input.errorCode;
    if (input.errorTitle !== undefined) entry.errorTitle = input.errorTitle;

    const record: StatusRecord =
      existing ??
      ({
        channelMessageId: input.channelMessageId,
        channel: input.channel,
        current: input.status,
        history: [],
        firstSeenAt: input.timestamp,
        lastUpdatedAt: input.timestamp
      } satisfies StatusRecord);

    // Carry the optional correlation fields when supplied; never clobber an
    // already-known value with `undefined` (the watermark path omits them).
    if (input.conversationKey !== undefined) record.conversationKey = input.conversationKey;
    if (input.recipientId !== undefined) record.recipientId = input.recipientId;

    // Idempotency under Meta redeliveries: skip an exact (status,timestamp)
    // duplicate so a redelivered webhook doesn't double-append to `history`.
    const isDuplicate = record.history.some(
      (h) => h.status === entry.status && h.timestamp === entry.timestamp
    );
    if (!isDuplicate) {
      record.history.push(entry);
    }

    // `current` = highest-rank status ever seen (NOT last-write). A late,
    // out-of-order `sent` after `delivered` therefore cannot regress `current`,
    // while `history` still preserves both. See STATUS_RANK for the rationale.
    if (STATUS_RANK[input.status] >= STATUS_RANK[record.current]) {
      record.current = input.status;
    }

    if (input.timestamp < record.firstSeenAt) record.firstSeenAt = input.timestamp;
    if (input.timestamp > record.lastUpdatedAt) record.lastUpdatedAt = input.timestamp;

    this.records.set(record.channelMessageId, record);
    // Clone on read so callers can't mutate internal state.
    return clone(record);
  }

  applyReadWatermark(input: {
    messageIds: string[];
    channel: Channel;
    watermark: number;
    conversationKey?: string;
  }): StatusRecord[] {
    const affected: StatusRecord[] = [];
    for (const messageId of input.messageIds) {
      // The agent only passes ids it knows; skip any that aren't tracked yet
      // (e.g. a send whose `sent` status hasn't been recorded). We never invent
      // a record from a watermark — the watermark only ADVANCES known messages.
      if (!this.records.has(messageId)) continue;

      // Reuse applyStatusUpdate so the rank/idempotency/timestamp logic stays in
      // one place. `read` is the top success rank, so this advances `current`
      // unless the message already failed.
      const updateInput: Parameters<StatusTracker['applyStatusUpdate']>[0] = {
        channelMessageId: messageId,
        channel: input.channel,
        status: 'read',
        timestamp: input.watermark
      };
      if (input.conversationKey !== undefined) updateInput.conversationKey = input.conversationKey;
      affected.push(this.applyStatusUpdate(updateInput));
    }
    return affected;
  }

  getStatus(channelMessageId: string): StatusRecord | undefined {
    const record = this.records.get(channelMessageId);
    // Clone on read so a caller mutating the result can't change stored state.
    return record ? clone(record) : undefined;
  }

  listByConversation(conversationKey: string, limit?: number): StatusRecord[] {
    const matches: StatusRecord[] = [];
    for (const record of this.records.values()) {
      if (record.conversationKey === conversationKey) matches.push(record);
    }
    // Most-recently-updated first — the useful order for admin introspection.
    matches.sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt);
    const sliced = limit !== undefined ? matches.slice(0, limit) : matches;
    return sliced.map((record) => clone(record));
  }
}
