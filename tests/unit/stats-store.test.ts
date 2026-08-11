/**
 * Hardware-free coverage for the DM volume stores.
 *
 * The bulk of it is a SHARED CONTRACT suite run against both implementations —
 * the in-memory store and the Redis store driven by a minimal in-memory fake —
 * because the two only have value if they agree; a number read back from Redis
 * has to mean what the same number meant locally. The fake implements just the
 * ioredis surface the store calls (eval/smembers/mget), and its `eval` mirrors
 * BUMP_DAY_LUA rather than interpreting Lua; the real script is exercised
 * against a real server in the redis-gated integration test.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import {
  InMemoryStatsStore,
  MAX_RANGE_DAYS,
  encodeKeySegment,
  decodeKeySegment,
  enumerateDates,
  utcDateFromMillis,
  type StatsStore
} from '../../src/stats/store.js';
import { RedisStatsStore } from '../../src/stats/redis-store.js';

/** Minimal in-memory stand-in for the ioredis methods the stats store invokes. */
class FakeRedis {
  readonly counters = new Map<string, number>();
  readonly ttls = new Map<string, number>();
  readonly sets = new Map<string, Set<string>>();
  /** When set, every `eval` rejects with it — the Redis-is-down simulation. */
  failWith: Error | undefined;

  /**
   * Mirrors BUMP_DAY_LUA: INCR, PEXPIRE on the first increment, SADD the pair.
   *   eval(script, 2, counterKey, pairsKey, ttlMs, member)
   */
  async eval(_script: string, numKeys: number, ...args: unknown[]): Promise<number> {
    if (this.failWith) throw this.failWith;
    expect(numKeys).toBe(2);
    const [counterKey, pairsKey, ttlMs, member] = args as [string, string, string, string];
    const next = (this.counters.get(counterKey) ?? 0) + 1;
    this.counters.set(counterKey, next);
    if (next === 1) this.ttls.set(counterKey, Number(ttlMs));
    const set = this.sets.get(pairsKey) ?? new Set<string>();
    set.add(member);
    this.sets.set(pairsKey, set);
    return next;
  }

  async smembers(key: string): Promise<string[]> {
    return [...(this.sets.get(key) ?? [])];
  }

  async mget(...keys: string[]): Promise<Array<string | null>> {
    return keys.map((key) => {
      const value = this.counters.get(key);
      return value === undefined ? null : String(value);
    });
  }

  /** `range` must never enumerate the keyspace — these exist only to fail loudly if it does. */
  async keys(): Promise<string[]> {
    throw new Error('range must not use KEYS');
  }

  async scan(): Promise<never> {
    throw new Error('range must not use SCAN');
  }
}

function makeRedisStore(fake: FakeRedis, retentionDays = 400, logger?: Logger) {
  return new RedisStatsStore({
    redis: fake as unknown as Redis,
    retentionDays,
    ...(logger ? { logger } : {})
  });
}

const AUG_10 = Date.UTC(2026, 7, 10, 12, 0, 0);

/** Both implementations, behind one factory, for the shared contract below. */
const IMPLEMENTATIONS: Array<[string, (retentionDays?: number) => StatsStore]> = [
  ['InMemoryStatsStore', (retentionDays = 400) => new InMemoryStatsStore({ retentionDays })],
  ['RedisStatsStore (fake redis)', (retentionDays = 400) => makeRedisStore(new FakeRedis(), retentionDays)]
];

describe.each(IMPLEMENTATIONS)('%s — StatsStore contract', (_name, makeStore) => {
  it('counts one metric and reads it back with the others at zero', async () => {
    const store = makeStore();
    await store.increment('reed', 'instagram', 'messages_in', AUG_10);
    await store.increment('reed', 'instagram', 'messages_in', AUG_10);

    expect(await store.range('2026-08-10', '2026-08-10')).toEqual([
      {
        date: '2026-08-10',
        account: 'reed',
        channel: 'instagram',
        conversations_started: 0,
        messages_in: 2,
        messages_out: 0
      }
    ]);
  });

  it('keeps accounts, channels and metrics independent', async () => {
    const store = makeStore();
    await store.increment('reed', 'instagram', 'messages_in', AUG_10);
    await store.increment('reed', 'messenger', 'messages_in', AUG_10);
    await store.increment('iris', 'instagram', 'messages_out', AUG_10);
    await store.increment('iris', 'instagram', 'conversations_started', AUG_10);

    const rows = await store.range('2026-08-10', '2026-08-10');
    // Ascending by date, then account, then channel.
    expect(rows.map((r) => [r.account, r.channel])).toEqual([
      ['iris', 'instagram'],
      ['reed', 'instagram'],
      ['reed', 'messenger']
    ]);
    expect(rows[0]).toMatchObject({ conversations_started: 1, messages_out: 1, messages_in: 0 });
    expect(rows[1]).toMatchObject({ messages_in: 1 });
    expect(rows[2]).toMatchObject({ messages_in: 1 });
  });

  it('splits on the UTC day boundary (23:59 vs 00:01 are different dates)', async () => {
    const store = makeStore();
    const lateAug10 = Date.UTC(2026, 7, 10, 23, 59, 0);
    const earlyAug11 = Date.UTC(2026, 7, 11, 0, 1, 0);
    await store.increment('reed', 'instagram', 'messages_in', lateAug10);
    await store.increment('reed', 'instagram', 'messages_in', earlyAug11);

    const rows = await store.range('2026-08-10', '2026-08-11');
    expect(rows.map((r) => [r.date, r.messages_in])).toEqual([
      ['2026-08-10', 1],
      ['2026-08-11', 1]
    ]);
  });

  it('returns an empty array for a span with no data', async () => {
    const store = makeStore();
    expect(await store.range('2026-08-01', '2026-08-31')).toEqual([]);
  });

  it('returns an empty array for a span that misses the data it holds', async () => {
    const store = makeStore();
    await store.increment('reed', 'instagram', 'messages_in', AUG_10);
    expect(await store.range('2026-07-01', '2026-07-31')).toEqual([]);
    expect(await store.range('2026-08-11', '2026-08-20')).toEqual([]);
  });

  it('includes both ends of the span (inclusive)', async () => {
    const store = makeStore();
    await store.increment('reed', 'instagram', 'messages_in', Date.UTC(2026, 7, 1, 0, 0, 0));
    await store.increment('reed', 'instagram', 'messages_in', Date.UTC(2026, 7, 3, 0, 0, 0));
    const rows = await store.range('2026-08-01', '2026-08-03');
    expect(rows.map((r) => r.date)).toEqual(['2026-08-01', '2026-08-03']);
  });

  it('keeps an account containing a colon distinct, and returns it verbatim', async () => {
    const store = makeStore();
    // The escaped segment is what makes this structurally safe rather than
    // safe-by-argument; what a caller observes is that the two stay separate and
    // the account string survives the round trip unchanged.
    await store.increment('reed:instagram', 'messenger', 'messages_in', AUG_10);
    await store.increment('reed', 'instagram', 'messages_in', AUG_10);
    await store.increment('100%:pure', 'whatsapp', 'messages_out', AUG_10);

    const rows = await store.range('2026-08-10', '2026-08-10');
    expect(rows.map((r) => [r.account, r.channel, r.messages_in + r.messages_out])).toEqual([
      ['100%:pure', 'whatsapp', 1],
      ['reed', 'instagram', 1],
      ['reed:instagram', 'messenger', 1]
    ]);
  });

  it('never throws from increment on a malformed timestamp, and counts nothing', async () => {
    const store = makeStore();
    await expect(
      store.increment('reed', 'instagram', 'messages_in', Number.NaN)
    ).resolves.toBeUndefined();
    await expect(
      store.increment('reed', 'instagram', 'messages_in', Number.POSITIVE_INFINITY)
    ).resolves.toBeUndefined();
    expect(await store.range('2026-01-01', '2026-12-31')).toEqual([]);
  });

  it('rejects malformed range bounds instead of reading anything', async () => {
    const store = makeStore();
    await expect(store.range('yesterday', '2026-08-10')).rejects.toThrow(/YYYY-MM-DD/);
    await expect(store.range('2026-08-10', '10-08-2026')).rejects.toThrow(/YYYY-MM-DD/);
    // A real-looking date that is not a real day — Date.parse would roll this
    // into March, so the round-trip check is what catches it.
    await expect(store.range('2026-02-30', '2026-03-01')).rejects.toThrow(/not a real calendar date/);
    await expect(store.range('2026-08-11', '2026-08-10')).rejects.toThrow(/before sinceIso/);
    await expect(store.range('0001-01-01', '2026-08-10')).rejects.toThrow(/exceeds the/);
  });

  it('rejects a nonsense retention at construction', () => {
    expect(() => makeStore(0)).toThrow(/positive integer/);
    expect(() => makeStore(-1)).toThrow(/positive integer/);
    expect(() => makeStore(1.5)).toThrow(/positive integer/);
  });
});

describe('InMemoryStatsStore retention', () => {
  it('evicts days older than retentionDays once a newer day is written', async () => {
    const store = new InMemoryStatsStore({ retentionDays: 3 });
    await store.increment('reed', 'instagram', 'messages_in', Date.UTC(2026, 7, 1));
    expect(await store.range('2026-08-01', '2026-08-01')).toHaveLength(1);

    // A write four days later pushes 08-01 out of the window.
    await store.increment('reed', 'instagram', 'messages_in', Date.UTC(2026, 7, 5));
    const rows = await store.range('2026-08-01', '2026-08-05');
    expect(rows.map((r) => r.date)).toEqual(['2026-08-05']);
  });

  it('keeps days inside the window', async () => {
    const store = new InMemoryStatsStore({ retentionDays: 30 });
    await store.increment('reed', 'instagram', 'messages_in', Date.UTC(2026, 7, 1));
    await store.increment('reed', 'instagram', 'messages_in', Date.UTC(2026, 7, 5));
    const rows = await store.range('2026-08-01', '2026-08-05');
    expect(rows.map((r) => r.date)).toEqual(['2026-08-01', '2026-08-05']);
  });
});

describe('RedisStatsStore (fake redis)', () => {
  it('writes the pinned key shape with escaped segments', async () => {
    const fake = new FakeRedis();
    const store = makeRedisStore(fake);
    await store.increment('reed:x', 'instagram', 'messages_in', AUG_10);

    expect([...fake.counters.keys()]).toEqual([
      'meta-ai-agent:stats:day:reed%3Ax:instagram:messages_in:2026-08-10'
    ]);
    expect([...(fake.sets.get('meta-ai-agent:stats:pairs') ?? [])]).toEqual([
      'reed%3Ax:instagram'
    ]);
  });

  it('sets a TTL of retentionDays on the counter key, on the first increment only', async () => {
    const fake = new FakeRedis();
    const store = makeRedisStore(fake, 400);
    await store.increment('reed', 'instagram', 'messages_in', AUG_10);
    const key = 'meta-ai-agent:stats:day:reed:instagram:messages_in:2026-08-10';
    expect(fake.ttls.get(key)).toBe(400 * 86_400_000);

    // A second bump must not re-arm the TTL (PEXPIRE is guarded on v == 1), or a
    // continuously active account's oldest day would never expire.
    fake.ttls.set(key, -1);
    await store.increment('reed', 'instagram', 'messages_in', AUG_10);
    expect(fake.ttls.get(key)).toBe(-1);
    expect(fake.counters.get(key)).toBe(2);
  });

  it('SWALLOWS a store failure in increment and logs it (fail-open on the hot path)', async () => {
    const fake = new FakeRedis();
    fake.failWith = new Error('READONLY You cannot write against a read only replica');
    const logger = { warn: vi.fn() } as unknown as Logger;
    const store = makeRedisStore(fake, 400, logger);

    // The whole point: a Redis outage must not reject here, because the caller
    // is the message hot path and a lost count is cheaper than a lost reply.
    await expect(
      store.increment('reed', 'instagram', 'messages_in', AUG_10)
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.warn).mock.calls[0]?.[1]).toMatch(/fail-open/);
  });

  it('reads a span with MGET and never enumerates the keyspace', async () => {
    const fake = new FakeRedis();
    const keysSpy = vi.spyOn(fake, 'keys');
    const scanSpy = vi.spyOn(fake, 'scan');
    const mgetSpy = vi.spyOn(fake, 'mget');
    const store = makeRedisStore(fake);

    await store.increment('reed', 'instagram', 'messages_in', AUG_10);
    const rows = await store.range('2026-08-01', '2026-08-31');

    expect(rows).toHaveLength(1);
    expect(keysSpy).not.toHaveBeenCalled();
    expect(scanSpy).not.toHaveBeenCalled();
    // 31 days x 3 metrics x 1 pair = 93 keys, so exactly one chunked MGET.
    expect(mgetSpy).toHaveBeenCalledTimes(1);
    expect(mgetSpy.mock.calls[0]).toHaveLength(93);
  });

  it('chunks a wide read into several MGETs', async () => {
    const fake = new FakeRedis();
    const store = makeRedisStore(fake);
    const mgetSpy = vi.spyOn(fake, 'mget');
    await store.increment('reed', 'instagram', 'messages_in', AUG_10);
    // 200 days x 3 metrics = 600 keys > the 300-key chunk.
    await store.range('2026-01-01', '2026-07-19');
    expect(mgetSpy).toHaveBeenCalledTimes(2);
    for (const call of mgetSpy.mock.calls) expect(call.length).toBeLessThanOrEqual(300);
  });

  it('does not read Redis at all when nothing has ever been counted', async () => {
    const fake = new FakeRedis();
    const mgetSpy = vi.spyOn(fake, 'mget');
    const store = makeRedisStore(fake);
    expect(await store.range('2026-08-01', '2026-08-31')).toEqual([]);
    expect(mgetSpy).not.toHaveBeenCalled();
  });

  it('skips an index member whose channel this build does not know', async () => {
    const fake = new FakeRedis();
    const logger = { warn: vi.fn() } as unknown as Logger;
    const store = makeRedisStore(fake, 400, logger);
    await store.increment('reed', 'instagram', 'messages_in', AUG_10);
    // The index outlives a deploy, so it can name a channel that has since been
    // removed. StatsDay.channel is a closed union, so such a row is dropped.
    fake.sets.get('meta-ai-agent:stats:pairs')?.add('reed:telegram');

    const rows = await store.range('2026-08-10', '2026-08-10');
    expect(rows.map((r) => r.channel)).toEqual(['instagram']);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('reads a non-numeric stored value as 0 rather than NaN', async () => {
    const fake = new FakeRedis();
    const store = makeRedisStore(fake);
    await store.increment('reed', 'instagram', 'messages_in', AUG_10);
    await store.increment('reed', 'instagram', 'messages_out', AUG_10);
    fake.counters.set(
      'meta-ai-agent:stats:day:reed:instagram:messages_in:2026-08-10',
      'oops' as unknown as number
    );
    const rows = await store.range('2026-08-10', '2026-08-10');
    expect(rows[0]).toMatchObject({ messages_in: 0, messages_out: 1 });
  });

  it('is a no-op on close (the redis client is borrowed)', async () => {
    const fake = new FakeRedis();
    const store = makeRedisStore(fake);
    await expect(store.close()).resolves.toBeUndefined();
  });
});

describe('stats date helpers', () => {
  it('derives the UTC date from a timestamp', () => {
    expect(utcDateFromMillis(Date.UTC(2026, 7, 10, 23, 59, 59))).toBe('2026-08-10');
    expect(utcDateFromMillis(Date.UTC(2026, 7, 11, 0, 0, 0))).toBe('2026-08-11');
    expect(() => utcDateFromMillis(Number.NaN)).toThrow(/non-finite/);
  });

  it('enumerates an inclusive span, ascending, across a month and a leap day', () => {
    expect(enumerateDates('2026-08-10', '2026-08-10')).toEqual(['2026-08-10']);
    expect(enumerateDates('2026-08-30', '2026-09-01')).toEqual([
      '2026-08-30',
      '2026-08-31',
      '2026-09-01'
    ]);
    expect(enumerateDates('2028-02-28', '2028-03-01')).toEqual([
      '2028-02-28',
      '2028-02-29',
      '2028-03-01'
    ]);
  });

  it('caps the span at MAX_RANGE_DAYS', () => {
    const start = Date.UTC(2026, 0, 1);
    const lastOk = new Date(start + (MAX_RANGE_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
    const oneTooFar = new Date(start + MAX_RANGE_DAYS * 86_400_000).toISOString().slice(0, 10);
    expect(enumerateDates('2026-01-01', lastOk)).toHaveLength(MAX_RANGE_DAYS);
    expect(() => enumerateDates('2026-01-01', oneTooFar)).toThrow(/exceeds the/);
  });

  it('round-trips a key segment through escaping', () => {
    for (const segment of ['reed', 'reed:x', '100%', '%3A', 'a:b:c', '']) {
      expect(decodeKeySegment(encodeKeySegment(segment))).toBe(segment);
    }
    // The escape itself must be escaped, or `%3A` typed by a human would decode
    // into a colon it never contained.
    expect(encodeKeySegment('%3A')).toBe('%253A');
  });
});
