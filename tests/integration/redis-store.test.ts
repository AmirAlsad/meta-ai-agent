/**
 * Integration coverage for {@link RedisConversationStore} and
 * {@link BullMqBufferScheduler} against a REAL Redis.
 *
 * Gated on `TEST_REDIS_URL`: without it every test in this file SKIPS, keeping CI
 * hardware-free (the Stage 10 plan: never run real Redis in CI). To run locally:
 *   TEST_REDIS_URL=redis://localhost:6379/15 npm run test:integration
 * Use a throwaway DB index — `beforeEach` runs `FLUSHDB`.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Redis } from 'ioredis';
import { RedisConversationStore } from '../../src/conversation/redis-store.js';
import { BullMqBufferScheduler } from '../../src/conversation/scheduler.js';
import { createIdleConversation } from '../../src/conversation/types.js';
import type { OutboundHandleMapping } from '../../src/conversation/types.js';

const TEST_REDIS_URL = process.env.TEST_REDIS_URL;
const describeRedis = TEST_REDIS_URL ? describe : describe.skip;

describeRedis('RedisConversationStore (real redis)', () => {
  let redis: Redis;
  let store: RedisConversationStore;

  beforeAll(() => {
    redis = new Redis(TEST_REDIS_URL!, { maxRetriesPerRequest: null });
  });

  beforeEach(async () => {
    await redis.flushdb();
    store = new RedisConversationStore({
      redis,
      dedupeTtlSeconds: 60,
      conversationTtlSeconds: 3600
    });
  });

  afterAll(() => {
    redis.disconnect();
  });

  it('conversation record round-trips with a TTL set', async () => {
    const record = createIdleConversation({
      key: 'whatsapp:biz:user',
      channel: 'whatsapp',
      channelScopedUserId: 'user',
      channelScopedBusinessId: 'biz'
    });
    await store.setConversation(record);

    expect(await store.getConversation('whatsapp:biz:user')).toEqual(record);
    const ttl = await redis.ttl('meta-ai-agent:conversation:whatsapp:biz:user');
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(3600);

    await store.deleteConversation('whatsapp:biz:user');
    expect(await store.getConversation('whatsapp:biz:user')).toBeUndefined();
  });

  it('getConversation returns undefined for an absent key', async () => {
    expect(await store.getConversation('absent')).toBeUndefined();
  });

  it('claimInboundHandle is atomic SET NX: first true, redelivery false', async () => {
    expect(await store.claimInboundHandle('wamid.1')).toBe(true);
    expect(await store.claimInboundHandle('wamid.1')).toBe(false);
    expect(await store.claimInboundHandle('wamid.2')).toBe(true);
  });

  it('peekInboundHandle TTL semantics: absent / present-with-ttl / present-no-ttl', async () => {
    expect(await store.peekInboundHandle('absent')).toEqual({ present: false });

    await store.claimInboundHandle('claimed');
    const peeked = await store.peekInboundHandle('claimed');
    expect(peeked.present).toBe(true);
    expect(peeked.ttlSeconds).toBeGreaterThan(0);
    expect(peeked.ttlSeconds).toBeLessThanOrEqual(60);

    // A key with no expiry (-1) -> present:true, ttlSeconds undefined.
    await redis.set('meta-ai-agent:dedupe:inbound:noexp', '1');
    expect(await store.peekInboundHandle('noexp')).toEqual({
      present: true,
      ttlSeconds: undefined
    });
  });

  it('outbound-handle map round-trips and deletes', async () => {
    const mapping: OutboundHandleMapping = {
      conversationKey: 'whatsapp:biz:user',
      messageIndex: 3,
      traceId: 'trace-xyz'
    };
    await store.mapOutboundHandle('wamid.out', mapping);
    expect(await store.getOutboundHandleMapping('wamid.out')).toEqual(mapping);
    expect(await store.getOutboundHandleMapping('missing')).toBeUndefined();

    await store.deleteOutboundHandleMapping('wamid.out');
    expect(await store.getOutboundHandleMapping('wamid.out')).toBeUndefined();
  });

  it('listConversationKeys SCANs and yields BARE keys, ignoring dedupe/outbound keys', async () => {
    const keys = ['whatsapp:b:u1', 'messenger:p:u2', 'instagram:i:u3'];
    for (const key of keys) {
      await store.setConversation(
        createIdleConversation({
          key,
          channel: 'whatsapp',
          channelScopedUserId: 'u',
          channelScopedBusinessId: 'b'
        })
      );
    }
    await store.claimInboundHandle('dedupe-decoy');
    await store.mapOutboundHandle('outbound-decoy', { conversationKey: 'x', messageIndex: 0 });

    const collected: string[] = [];
    for await (const key of store.listConversationKeys()) collected.push(key);

    expect(collected.sort()).toEqual([...keys].sort());
  });

  it('close() does NOT disconnect the injected client', async () => {
    await store.close();
    // Client still usable after store.close().
    expect(await redis.ping()).toBe('PONG');
  });
});

describeRedis('BullMqBufferScheduler (real redis)', () => {
  let scheduler: BullMqBufferScheduler;
  let cleanupRedis: Redis;
  const queueName = `test-buffer-${process.pid}-${Date.now()}`;

  beforeAll(async () => {
    cleanupRedis = new Redis(TEST_REDIS_URL!, { maxRetriesPerRequest: null });
    await cleanupRedis.flushdb();
  });

  beforeEach(() => {
    scheduler = new BullMqBufferScheduler({ redisUrl: TEST_REDIS_URL!, queueName });
  });

  afterAll(async () => {
    cleanupRedis.disconnect();
  });

  it('fires the handler with the conversation key + traceId after the delay', async () => {
    let resolveFired!: (value: { key: string; traceId?: string }) => void;
    const fired = new Promise<{ key: string; traceId?: string }>((resolve) => {
      resolveFired = resolve;
    });
    scheduler.setHandler(async (key, options) => {
      resolveFired({ key, traceId: options?.traceId });
    });

    await scheduler.schedule('whatsapp:biz:user', 50, { traceId: 'trace-1' });
    const result = await fired;
    expect(result).toEqual({ key: 'whatsapp:biz:user', traceId: 'trace-1' });

    await scheduler.close();
  }, 20000);

  it('re-scheduling the same key REPLACES the prior job (one delayed job)', async () => {
    scheduler.setHandler(async () => {
      /* never fires within the test window — long delay */
    });

    // Long delays so the jobs stay in the `delayed` state for the assertion.
    await scheduler.schedule('whatsapp:biz:user', 60000);
    await scheduler.schedule('whatsapp:biz:user', 60000);

    const stats = await scheduler.getStats();
    expect(stats.delayed).toBe(1);

    await scheduler.cancel('whatsapp:biz:user');
    const afterCancel = await scheduler.getStats();
    expect(afterCancel.delayed).toBe(0);

    await scheduler.close();
  }, 20000);
});
