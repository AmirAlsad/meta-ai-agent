import { Redis } from 'ioredis';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { RedisLimitCounterStore } from '../../src/limits/redis-store.js';

/**
 * Real-Redis integration coverage for the Lua-atomic slot acquire. Gated on
 * TEST_REDIS_URL so the default `npm test` run (no Redis) SKIPS this file.
 *   TEST_REDIS_URL=redis://localhost:6379 npm run test:integration
 */
const describeRedis = process.env.TEST_REDIS_URL ? describe : describe.skip;

describeRedis('RedisLimitCounterStore.acquireOutboundSlot (real Redis)', () => {
  const redis = new Redis(process.env.TEST_REDIS_URL as string, { maxRetriesPerRequest: null });
  const store = new RedisLimitCounterStore({ redis });

  beforeEach(async () => {
    await redis.flushdb();
  });

  afterAll(async () => {
    await redis.quit();
  });

  it('returns 0 for the first acquire on a fresh line', async () => {
    const delay = await store.acquireOutboundSlot('whatsapp:biz', Date.now(), 10);
    expect(delay).toBe(0);
  });

  it('serializes N concurrent acquires into strictly increasing delays', async () => {
    const now = Date.now();
    const perSecond = 4; // intervalMs = 250
    // Fire 5 acquires concurrently at the same virtual `now`. The Lua atomicity
    // guarantees each observes the prior reservation, so the slots are spaced
    // intervalMs apart and no two share a delay.
    const delays = await Promise.all(
      Array.from({ length: 5 }, () => store.acquireOutboundSlot('whatsapp:biz', now, perSecond))
    );
    delays.sort((a, b) => a - b);
    expect(delays).toEqual([0, 250, 500, 750, 1000]);
  });

  it('does not accumulate burst credit across an idle gap', async () => {
    const perSecond = 2; // intervalMs = 500
    await store.acquireOutboundSlot('line', 1000, perSecond);
    const afterGap = await store.acquireOutboundSlot('line', 1_000_000, perSecond);
    expect(afterGap).toBe(0);
  });

  it('disables pacing when perSecond <= 0 without touching Redis', async () => {
    expect(await store.acquireOutboundSlot('line', Date.now(), 0)).toBe(0);
    const keys = await redis.keys('meta-ai-agent:limits:slot:*');
    expect(keys).toEqual([]);
  });

  it('keeps lines independent', async () => {
    const now = Date.now();
    await store.acquireOutboundSlot('whatsapp:a', now, 4);
    const other = await store.acquireOutboundSlot('whatsapp:b', now, 4);
    expect(other).toBe(0);
  });
});
