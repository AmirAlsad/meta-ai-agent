/**
 * Redis-backed {@link ConversationStore} — the Stage 10 PRODUCTION persistence
 * path (the in-memory store in `store.ts` is for tests / local smoke runs only).
 *
 * Holds the same three things the in-memory store does, but durably and shared
 * across replicas:
 *   - conversation records  (`meta-ai-agent:conversation:{key}`)
 *   - the inbound dedupe set (`meta-ai-agent:dedupe:inbound:{channelMessageId}`)
 *   - the outbound-handle map (`meta-ai-agent:outbound:{channelMessageId}`)
 *
 * WHY Redis vs. the in-memory Maps: real `SET ... NX` gives atomic
 * cross-replica inbound dedupe (the in-memory map is per-process and a
 * redelivered webhook to a different replica would be reprocessed), `SCAN`
 * powers {@link ConversationStore.listConversationKeys}, and TTLs evict stale
 * state automatically (the in-memory dedupe map is never swept).
 *
 * Clone-on-read/write discipline: the in-memory store deep-clones on both read
 * and write so a caller's mutation can't reach the stored object. Here that
 * isolation is IMPLICIT — every value crosses the wire as a fresh
 * `JSON.stringify`/`JSON.parse` round-trip, so the returned record is already a
 * detached copy and a write serializes a snapshot.
 *
 * Client lifecycle: the `Redis` client is INJECTED, not constructed here. The
 * runtime shares one client across the store + scheduler, so this store does NOT
 * own it — {@link RedisConversationStore.close} is intentionally a no-op and must
 * NOT disconnect the injected client (the runtime owns that lifecycle).
 */

import type { Redis } from 'ioredis';
import type pino from 'pino';
import type { ConversationStore } from './store.js';
import type { ConversationRecord, OutboundHandleMapping } from './types.js';

const KEY_PREFIX = 'meta-ai-agent:';
const CONVERSATION_PREFIX = `${KEY_PREFIX}conversation:`;
const DEDUPE_INBOUND_PREFIX = `${KEY_PREFIX}dedupe:inbound:`;
const OUTBOUND_PREFIX = `${KEY_PREFIX}outbound:`;

function conversationKey(key: string): string {
  return `${CONVERSATION_PREFIX}${key}`;
}

function inboundDedupeKey(channelMessageId: string): string {
  return `${DEDUPE_INBOUND_PREFIX}${channelMessageId}`;
}

function outboundMappingKey(channelMessageId: string): string {
  return `${OUTBOUND_PREFIX}${channelMessageId}`;
}

export interface RedisConversationStoreOptions {
  /** Shared, runtime-owned ioredis client. NOT disconnected by this store. */
  redis: Redis;
  /** TTL (seconds) for the inbound dedupe set entries. */
  dedupeTtlSeconds: number;
  /** TTL (seconds) for conversation records + outbound-handle mappings. */
  conversationTtlSeconds: number;
  logger?: pino.Logger;
}

export class RedisConversationStore implements ConversationStore {
  private readonly redis: Redis;
  private readonly dedupeTtlSeconds: number;
  private readonly conversationTtlSeconds: number;
  private readonly logger: pino.Logger | undefined;

  constructor(opts: RedisConversationStoreOptions) {
    this.redis = opts.redis;
    this.dedupeTtlSeconds = opts.dedupeTtlSeconds;
    this.conversationTtlSeconds = opts.conversationTtlSeconds;
    this.logger = opts.logger;
  }

  /**
   * Defensive JSON parse: a corrupt value (manual edit, partial write, schema
   * drift) logs a warn and resolves to `undefined` rather than throwing — a
   * thrown parse here would crash the inbound webhook handler AFTER the 200 ACK
   * (no Meta retry), losing the event. Treating it as "absent" lets the agent
   * rebuild a fresh record.
   */
  private parse<T>(raw: string | null, kind: string, key: string): T | undefined {
    if (raw === null) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch (err) {
      this.logger?.warn({ err, kind, key }, 'redis-store: corrupt JSON value, treating as absent');
      return undefined;
    }
  }

  async getConversation(key: string): Promise<ConversationRecord | undefined> {
    const raw = await this.redis.get(conversationKey(key));
    return this.parse<ConversationRecord>(raw, 'conversation', key);
  }

  async setConversation(record: ConversationRecord): Promise<void> {
    await this.redis.set(
      conversationKey(record.key),
      JSON.stringify(record),
      'EX',
      this.conversationTtlSeconds
    );
  }

  async deleteConversation(key: string): Promise<void> {
    await this.redis.del(conversationKey(key));
  }

  async claimInboundHandle(channelMessageId: string): Promise<boolean> {
    // Atomic SET NX with TTL: the FIRST caller within the TTL wins ('OK'); a
    // redelivery (any replica) gets null and is skipped.
    const result = await this.redis.set(
      inboundDedupeKey(channelMessageId),
      '1',
      'EX',
      this.dedupeTtlSeconds,
      'NX'
    );
    return result === 'OK';
  }

  async peekInboundHandle(
    channelMessageId: string
  ): Promise<{ present: boolean; ttlSeconds?: number }> {
    // Single TTL command (no EXISTS first): ioredis returns -2 when the key is
    // absent and -1 when present without an expiry. Issuing TTL alone avoids the
    // EXISTS->TTL TOCTOU window that could report a stale presence.
    const ttl = await this.redis.ttl(inboundDedupeKey(channelMessageId));
    if (ttl === -2) return { present: false };
    return { present: true, ttlSeconds: ttl >= 0 ? ttl : undefined };
  }

  async mapOutboundHandle(channelMessageId: string, mapping: OutboundHandleMapping): Promise<void> {
    await this.redis.set(
      outboundMappingKey(channelMessageId),
      JSON.stringify(mapping),
      'EX',
      this.conversationTtlSeconds
    );
  }

  async getOutboundHandleMapping(
    channelMessageId: string
  ): Promise<OutboundHandleMapping | undefined> {
    const raw = await this.redis.get(outboundMappingKey(channelMessageId));
    return this.parse<OutboundHandleMapping>(raw, 'outbound', channelMessageId);
  }

  async deleteOutboundHandleMapping(channelMessageId: string): Promise<void> {
    await this.redis.del(outboundMappingKey(channelMessageId));
  }

  async *listConversationKeys(): AsyncIterable<string> {
    // SCAN (not KEYS) so enumeration is non-blocking on a large keyspace. Yield
    // the BARE conversation key (prefix stripped) to match the in-memory impl.
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(
        cursor,
        'MATCH',
        `${CONVERSATION_PREFIX}*`,
        'COUNT',
        200
      );
      cursor = next;
      for (const key of keys) yield key.slice(CONVERSATION_PREFIX.length);
    } while (cursor !== '0');
  }

  /**
   * No-op: the `Redis` client is injected and owned by the runtime, which shares
   * it across the store + scheduler. Disconnecting it here would tear down the
   * shared connection out from under the scheduler. The runtime closes the
   * client during shutdown.
   */
  async close(): Promise<void> {
    /* intentionally empty — see method doc */
  }
}
