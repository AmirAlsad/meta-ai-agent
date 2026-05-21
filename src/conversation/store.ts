/**
 * Conversation persistence: the {@link ConversationStore} interface plus an
 * in-memory implementation used for tests and local smoke runs.
 *
 * The store holds three things: conversation records (one per
 * channel/business/user triple), an inbound dedupe set (SETNX-with-TTL so a
 * redelivered webhook is processed exactly once), and an outbound-handle map
 * (channel message id -> the conversation + queue slot that produced it, so a
 * later status callback — which only carries the channel message id — can find
 * and advance the right queue item).
 *
 * WHY in-memory only here: state lives in plain `Map`s, is per-process, and
 * disappears on restart, so the per-replica view diverges in a multi-replica
 * deploy. The PRODUCTION path is the Redis-backed store (real `SET NX` for
 * atomic dedupe, `SCAN` for {@link ConversationStore.listConversationKeys}, and
 * a BullMQ-backed outbound-handle map) which lands in Stage 10. The interface
 * below is the contract both implementations honor.
 */

import type { ConversationConfig } from '../config/loader.js';
import type { ConversationRecord, OutboundHandleMapping } from './types.js';

export interface ConversationStore {
  getConversation(key: string): Promise<ConversationRecord | undefined>;
  setConversation(record: ConversationRecord): Promise<void>;
  deleteConversation(key: string): Promise<void>;
  /**
   * SETNX-with-TTL inbound dedupe. Returns true the FIRST time a
   * `channelMessageId` is seen within the TTL (caller should process), false on
   * a duplicate/redelivery.
   */
  claimInboundHandle(channelMessageId: string): Promise<boolean>;
  /** Non-destructive peek of the dedupe set (for future admin introspection). */
  peekInboundHandle(channelMessageId: string): Promise<{ present: boolean; ttlSeconds?: number }>;
  /**
   * Map an outbound channel message id -> the conversation + queue index that
   * produced it, so status callbacks can advance the right queue.
   */
  mapOutboundHandle(channelMessageId: string, mapping: OutboundHandleMapping): Promise<void>;
  getOutboundHandleMapping(channelMessageId: string): Promise<OutboundHandleMapping | undefined>;
  deleteOutboundHandleMapping(channelMessageId: string): Promise<void>;
  /**
   * Enumerate all conversation keys (Stage 10 boot recovery uses this; the
   * Redis impl will SCAN, the in-memory impl iterates the Map).
   */
  listConversationKeys(): AsyncIterable<string>;
  /**
   * Atomically claim the boot-recovery slot for ONE specific pending retry
   * (`claimToken` is `{conversationKey}:{itemId}:{retryCount}`). Returns true
   * only for the FIRST caller. WHY load-bearing: in a multi-replica deploy on a
   * SHARED Redis, every replica runs `recoverPendingRetries()` at boot and would
   * otherwise each re-arm the SAME overdue retry and re-send the in-flight item
   * (the per-process `runExclusive` lock is NOT distributed) — an N-replica
   * double-send. This atomic SET NX lets exactly one replica recover each retry.
   * Optional so a future store can opt out; the in-memory store is single-process
   * and always returns true (no cross-replica race exists).
   */
  claimRecovery?(claimToken: string, ttlSeconds: number): Promise<boolean>;
  close?(): Promise<void>;
}

/**
 * Deep-clone via JSON round-trip.
 *
 * WHY this is load-bearing: the {@link ConversationStore} contract is
 * pass-by-value, not pass-by-reference. The ConversationAgent reads a record,
 * MUTATES it (pushes to buffers/queues, flips state), then writes it back. If
 * the store handed out the same object reference it holds, those mutations would
 * silently corrupt stored state BEFORE the write — and a failed/abandoned turn
 * could leak partial mutations. Cloning on both read and write isolates the
 * caller's working copy from the stored copy. The record/mapping shapes are
 * JSON-safe (primitives, arrays, plain objects), so a structuredClone-style
 * deep copy via JSON is sufficient and dependency-free.
 */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * In-memory {@link ConversationStore} backed by plain `Map`s. For tests and
 * local smoke runs only — see the file header for the production (Redis) path.
 */
export class InMemoryConversationStore implements ConversationStore {
  private readonly conversations = new Map<string, ConversationRecord>();
  /** channelMessageId -> expiry Unix ms. Presence with a future expiry == claimed. */
  private readonly inboundHandles = new Map<string, number>();
  private readonly outboundHandles = new Map<string, OutboundHandleMapping>();

  constructor(private readonly config: Pick<ConversationConfig, 'dedupeTtlSeconds'>) {}

  async getConversation(key: string): Promise<ConversationRecord | undefined> {
    const record = this.conversations.get(key);
    // Clone on read so the caller can mutate freely without touching stored state.
    return record ? clone(record) : undefined;
  }

  async setConversation(record: ConversationRecord): Promise<void> {
    // Clone on write so a later caller-side mutation of `record` can't reach in.
    this.conversations.set(record.key, clone(record));
  }

  async deleteConversation(key: string): Promise<void> {
    this.conversations.delete(key);
  }

  async claimInboundHandle(channelMessageId: string): Promise<boolean> {
    const now = Date.now();
    const expiresAt = this.inboundHandles.get(channelMessageId);
    // A non-expired entry means we've already claimed this id within the TTL.
    if (expiresAt && expiresAt > now) return false;

    this.inboundHandles.set(channelMessageId, now + this.config.dedupeTtlSeconds * 1000);
    return true;
  }

  async peekInboundHandle(channelMessageId: string): Promise<{ present: boolean; ttlSeconds?: number }> {
    const now = Date.now();
    const expiresAt = this.inboundHandles.get(channelMessageId);
    if (!expiresAt || expiresAt <= now) return { present: false };
    return { present: true, ttlSeconds: Math.max(0, Math.floor((expiresAt - now) / 1000)) };
  }

  async mapOutboundHandle(channelMessageId: string, mapping: OutboundHandleMapping): Promise<void> {
    this.outboundHandles.set(channelMessageId, clone(mapping));
  }

  async getOutboundHandleMapping(channelMessageId: string): Promise<OutboundHandleMapping | undefined> {
    const mapping = this.outboundHandles.get(channelMessageId);
    return mapping ? clone(mapping) : undefined;
  }

  async deleteOutboundHandleMapping(channelMessageId: string): Promise<void> {
    this.outboundHandles.delete(channelMessageId);
  }

  async *listConversationKeys(): AsyncIterable<string> {
    for (const key of this.conversations.keys()) yield key;
  }

  async claimRecovery(_claimToken: string, _ttlSeconds: number): Promise<boolean> {
    // Single-process: there is no cross-replica boot race to guard against, so the
    // sole process always wins the recovery claim. (In practice this store also
    // loses all state on restart, so recoverPendingRetries finds nothing to claim.)
    return true;
  }
}
