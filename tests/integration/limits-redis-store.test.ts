import { Redis } from 'ioredis';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { RedisLimitCounterStore } from '../../src/limits/redis-store.js';
import { DAY_MS, HOUR_MS } from '../../src/limits/store.js';

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

describeRedis('RedisLimitCounterStore.incrementWindowCounters (real Redis)', () => {
  const redis = new Redis(process.env.TEST_REDIS_URL as string, { maxRetriesPerRequest: null });
  const store = new RedisLimitCounterStore({ redis });

  beforeEach(async () => {
    await redis.flushdb();
  });

  afterAll(async () => {
    await redis.quit();
  });

  it('returns 1/1 on the first bump for a fresh line', async () => {
    const r = await store.incrementWindowCounters('whatsapp:biz', 0);
    expect(r).toEqual({ hourCount: 1, dayCount: 1 });
  });

  it('accumulates within the same hour/day window (atomic INCR)', async () => {
    await store.incrementWindowCounters('line', 0);
    await store.incrementWindowCounters('line', 60_000);
    const r = await store.incrementWindowCounters('line', 120_000);
    expect(r).toEqual({ hourCount: 3, dayCount: 3 });
  });

  it('serializes N concurrent bumps without lost updates', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => store.incrementWindowCounters('line', 0))
    );
    const hourCounts = results.map((r) => r.hourCount).sort((a, b) => a - b);
    expect(hourCounts).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('rolls the hour window over while the day keeps counting', async () => {
    await store.incrementWindowCounters('line', 0);
    const r = await store.incrementWindowCounters('line', HOUR_MS + 1);
    expect(r.hourCount).toBe(1);
    expect(r.dayCount).toBe(2);
  });

  it('rolls the day window over on a new day', async () => {
    await store.incrementWindowCounters('line', 0);
    const r = await store.incrementWindowCounters('line', DAY_MS + 1);
    expect(r).toEqual({ hourCount: 1, dayCount: 1 });
  });

  it('sets a TTL on the bucket keys so old windows self-evict', async () => {
    await store.incrementWindowCounters('line', 0);
    const hourTtl = await redis.pttl('meta-ai-agent:limits:hour:line:0');
    const dayTtl = await redis.pttl('meta-ai-agent:limits:day:line:0');
    // PTTL > 0 means an expiry is set (not -1 = no TTL, not -2 = missing).
    expect(hourTtl).toBeGreaterThan(0);
    expect(dayTtl).toBeGreaterThan(0);
  });
});
