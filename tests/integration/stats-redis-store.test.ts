import { Redis } from 'ioredis';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { RedisStatsStore } from '../../src/stats/redis-store.js';

/**
 * Real-Redis coverage for the day counters: the Lua INCR/PEXPIRE/SADD script
 * (the unit test's fake mirrors its semantics but does not run Lua), the real
 * MGET read path, and the TTL actually landing on the key. Gated on
 * TEST_REDIS_URL so the default `npm test` run (no Redis) SKIPS this file.
 *   TEST_REDIS_URL=redis://localhost:6379 npm run test:integration
 */
const describeRedis = process.env.TEST_REDIS_URL ? describe : describe.skip;

const AUG_10 = Date.UTC(2026, 7, 10, 12, 0, 0);

describeRedis('RedisStatsStore (real Redis)', () => {
  const redis = new Redis(process.env.TEST_REDIS_URL as string, { maxRetriesPerRequest: null });
  const store = new RedisStatsStore({ redis, retentionDays: 400 });

  beforeEach(async () => {
    await redis.flushdb();
  });

  afterAll(async () => {
    await redis.quit();
  });

  it('counts and reads back a day', async () => {
    await store.increment('reed', 'instagram', 'messages_in', AUG_10);
    await store.increment('reed', 'instagram', 'messages_in', AUG_10);
    await store.increment('reed', 'instagram', 'conversations_started', AUG_10);

    expect(await store.range('2026-08-10', '2026-08-10')).toEqual([
      {
        date: '2026-08-10',
        account: 'reed',
        channel: 'instagram',
        conversations_started: 1,
        messages_in: 2,
        messages_out: 0
      }
    ]);
  });

  it('serializes N concurrent increments without lost updates', async () => {
    await Promise.all(
      Array.from({ length: 25 }, () => store.increment('reed', 'instagram', 'messages_in', AUG_10))
    );
    const rows = await store.range('2026-08-10', '2026-08-10');
    expect(rows[0]?.messages_in).toBe(25);
  });

  it('writes the pinned key and registers the pair in the index', async () => {
    await store.increment('reed', 'instagram', 'messages_out', AUG_10);
    expect(
      await redis.get('meta-ai-agent:stats:day:reed:instagram:messages_out:2026-08-10')
    ).toBe('1');
    expect(await redis.smembers('meta-ai-agent:stats:pairs')).toEqual(['reed:instagram']);
  });

  it('sets the retention TTL on the counter key', async () => {
    await store.increment('reed', 'instagram', 'messages_in', AUG_10);
    const ttl = await redis.pttl('meta-ai-agent:stats:day:reed:instagram:messages_in:2026-08-10');
    // PTTL > 0 means an expiry is set (not -1 = no TTL, not -2 = missing), and it
    // must be within the retention window we asked for.
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(400 * 86_400_000);
  });

  it('splits on the UTC day boundary', async () => {
    await store.increment('reed', 'instagram', 'messages_in', Date.UTC(2026, 7, 10, 23, 59, 0));
    await store.increment('reed', 'instagram', 'messages_in', Date.UTC(2026, 7, 11, 0, 1, 0));
    const rows = await store.range('2026-08-10', '2026-08-11');
    expect(rows.map((r) => [r.date, r.messages_in])).toEqual([
      ['2026-08-10', 1],
      ['2026-08-11', 1]
    ]);
  });

  it('returns an empty array for a span with no data', async () => {
    expect(await store.range('2026-01-01', '2026-01-31')).toEqual([]);
    await store.increment('reed', 'instagram', 'messages_in', AUG_10);
    expect(await store.range('2026-01-01', '2026-01-31')).toEqual([]);
  });

  it('keeps an account containing a colon distinct from the pair it could shadow', async () => {
    await store.increment('reed:instagram', 'messenger', 'messages_in', AUG_10);
    await store.increment('reed', 'instagram', 'messages_in', AUG_10);
    const rows = await store.range('2026-08-10', '2026-08-10');
    expect(rows.map((r) => [r.account, r.channel])).toEqual([
      ['reed', 'instagram'],
      ['reed:instagram', 'messenger']
    ]);
  });

  it('reads a wide span with MGET only — no KEYS, no SCAN', async () => {
    await store.increment('reed', 'instagram', 'messages_in', AUG_10);
    // 200 days x 3 metrics crosses the MGET chunk size, exercising the chunking
    // against a real server.
    const rows = await store.range('2026-05-01', '2026-11-16');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.date).toBe('2026-08-10');
  });

  it('never throws from increment when the connection is gone (fail-open)', async () => {
    const dead = new Redis(process.env.TEST_REDIS_URL as string, { maxRetriesPerRequest: 1 });
    const deadStore = new RedisStatsStore({ redis: dead, retentionDays: 400 });
    await dead.quit();
    await expect(
      deadStore.increment('reed', 'instagram', 'messages_in', AUG_10)
    ).resolves.toBeUndefined();
    dead.disconnect();
  });
});
