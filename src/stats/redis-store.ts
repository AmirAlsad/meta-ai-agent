/**
 * Redis-backed {@link StatsStore} — the durable path, and the only one whose
 * numbers survive a deploy or span more than one replica.
 *
 * The write is the limits store's shape exactly: a Lua `INCR` + `PEXPIRE`-on-
 * first against a wall-clock-bucketed key. O(1) per message, atomic across
 * replicas, and self-evicting, so a year of history costs nothing to keep and
 * nothing to clean up. Two deliberate differences from
 * {@link "../limits/redis-store.js".RedisLimitCounterStore}:
 *
 *  1. The bucket is the UTC calendar DATE rather than `floor(now / DAY_MS)`,
 *     because these numbers are read as dates (see `./store.js`).
 *  2. The TTL is retention-length (a year-ish, a constructor parameter) rather
 *     than two windows, because the point here is history and not a live gauge.
 *
 * READS DO NOT USE `KEYS` (nor `SCAN`). `range` enumerates the dates in the
 * requested span itself and reads exactly those keys with chunked `MGET`, so a
 * read is bounded by the span the caller asked for rather than by the size of
 * the keyspace. What it cannot enumerate that way is which accounts and
 * channels exist, so every write also `SADD`s its (account, channel) pair into
 * one small index set, inside the same Lua script — a counter can therefore
 * never exist without an index entry pointing at it.
 */

import type { Redis } from 'ioredis';
import type pino from 'pino';
import type { Channel } from '../meta/types.js';
import {
  DAY_MS,
  STATS_METRICS,
  assertRetentionDays,
  compareStatsDays,
  decodeKeySegment,
  emptyStatsDay,
  encodeKeySegment,
  enumerateDates,
  utcDateFromMillis,
  type StatsDay,
  type StatsMetric,
  type StatsStore
} from './store.js';

/** Shared namespace so the stats keyspace can be reasoned about (and flushed)
 *  without touching conversation / limits state. */
const KEY_PREFIX = 'meta-ai-agent:stats';

/** The (account, channel) index — see the file header for why it exists. */
const PAIRS_KEY = `${KEY_PREFIX}:pairs`;

/**
 * How many keys to ask for in one `MGET`. A span of 400 days × 3 metrics ×
 * a handful of pairs is a few thousand keys; chunking keeps any single command's
 * argument list (and its reply) a predictable size instead of growing with the
 * caller's span.
 */
const MGET_CHUNK = 300;

/**
 * Atomic day-counter bump plus index registration.
 *   KEYS[1] = the counter key (`…:day:{account}:{channel}:{metric}:{date}`)
 *   KEYS[2] = the (account, channel) index set
 *   ARGV[1] = TTL (ms) for the counter key
 *   ARGV[2] = the index member (`{account}:{channel}`, segments escaped)
 * WHY Lua rather than a bare INCR + EXPIRE + SADD: the same eviction race the
 * limits store documents — if the key is evicted between the INCR (which
 * recreates it WITHOUT a TTL) and the EXPIRE, the counter becomes immortal and
 * a year-old day never goes away. EVAL is atomic Redis-side, so the PEXPIRE
 * always lands on the first increment of a fresh date. Folding the SADD in
 * keeps the index and the counters from ever disagreeing.
 */
const BUMP_DAY_LUA = `
local v = redis.call('INCR', KEYS[1])
if v == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
redis.call('SADD', KEYS[2], ARGV[2])
return v
`.trim();

export interface RedisStatsStoreOptions {
  /**
   * Injected (BORROWED) ioredis client. The runtime owns its lifecycle, so
   * {@link RedisStatsStore.close} is a no-op — it must not disconnect a client
   * shared with the conversation / limits stores.
   */
  redis: Redis;
  /**
   * How many days of history to keep, as the counter keys' TTL. The caller
   * supplies it; the default lives in config.
   */
  retentionDays: number;
  logger?: pino.Logger;
}

export class RedisStatsStore implements StatsStore {
  private readonly redis: Redis;
  private readonly ttlMs: number;
  private readonly logger: pino.Logger | undefined;

  constructor(opts: RedisStatsStoreOptions) {
    this.redis = opts.redis;
    this.ttlMs = assertRetentionDays(opts.retentionDays) * DAY_MS;
    this.logger = opts.logger;
  }

  async increment(
    account: string,
    channel: Channel,
    metric: StatsMetric,
    now: number
  ): Promise<void> {
    // FAIL-OPEN, and the try must wrap the key construction as well as the
    // round-trip: a malformed `now` throws in utcDateFromMillis, and this is the
    // message hot path. See StatsStore.increment.
    try {
      const date = utcDateFromMillis(now);
      await this.redis.eval(
        BUMP_DAY_LUA,
        2,
        counterKey(account, channel, metric, date),
        PAIRS_KEY,
        String(this.ttlMs),
        pairMember(account, channel)
      );
    } catch (err) {
      this.logger?.warn(
        { err, account, channel, metric },
        'stats-store: increment failed; count skipped (fail-open)'
      );
    }
  }

  async range(sinceIso: string, untilIso: string): Promise<StatsDay[]> {
    // Validate and enumerate FIRST: a malformed date must surface as an error
    // before any Redis command runs.
    const dates = enumerateDates(sinceIso, untilIso);
    const pairs = await this.pairs();
    if (pairs.length === 0) return [];

    // One key per (pair, date, metric), in a stable order, so the flat MGET
    // reply can be walked back into rows by index arithmetic.
    const rows: StatsDay[] = [];
    const keys: string[] = [];
    for (const { account, channel } of pairs) {
      for (const date of dates) {
        rows.push(emptyStatsDay(date, account, channel));
        for (const metric of STATS_METRICS) keys.push(counterKey(account, channel, metric, date));
      }
    }

    const values = await this.mgetChunked(keys);
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i]!;
      STATS_METRICS.forEach((metric, m) => {
        row[metric] = toCount(values[i * STATS_METRICS.length + m]);
      });
    }

    // Drop the (date, pair) combinations that counted nothing — most of the
    // enumerated cross-product, since a pair is rarely active every single day.
    return rows
      .filter((row) => STATS_METRICS.some((metric) => row[metric] > 0))
      .sort(compareStatsDays);
  }

  /**
   * The known (account, channel) pairs, decoded back from the index set. A
   * member whose channel segment is unrecognised is skipped rather than trusted:
   * the set outlives any single deploy, so it can hold a channel this build no
   * longer knows about, and `StatsDay.channel` is a closed union.
   */
  private async pairs(): Promise<Array<{ account: string; channel: Channel }>> {
    const members = await this.redis.smembers(PAIRS_KEY);
    const pairs: Array<{ account: string; channel: Channel }> = [];
    for (const member of members) {
      const sep = member.lastIndexOf(':');
      if (sep < 0) continue;
      const channel = decodeKeySegment(member.slice(sep + 1));
      if (!isChannel(channel)) {
        this.logger?.warn({ member }, 'stats-store: index member with unknown channel, skipped');
        continue;
      }
      pairs.push({ account: decodeKeySegment(member.slice(0, sep)), channel });
    }
    return pairs;
  }

  /** `MGET` in fixed-size chunks, concatenated back into one reply-order array. */
  private async mgetChunked(keys: string[]): Promise<Array<string | null>> {
    const values: Array<string | null> = [];
    for (let i = 0; i < keys.length; i += MGET_CHUNK) {
      const chunk = keys.slice(i, i + MGET_CHUNK);
      values.push(...(await this.redis.mget(...chunk)));
    }
    return values;
  }

  /** No-op: the redis client is borrowed; the runtime owns its lifecycle. */
  async close(): Promise<void> {
    // intentionally empty — see RedisStatsStoreOptions.redis
  }
}

/** `meta-ai-agent:stats:day:{account}:{channel}:{metric}:{YYYY-MM-DD}`, segments escaped. */
function counterKey(account: string, channel: Channel, metric: StatsMetric, date: string): string {
  return `${KEY_PREFIX}:day:${encodeKeySegment(account)}:${encodeKeySegment(channel)}:${metric}:${date}`;
}

/** Index member for a pair. The channel is escaped too, so the LAST `:` is always the separator. */
function pairMember(account: string, channel: Channel): string {
  return `${encodeKeySegment(account)}:${encodeKeySegment(channel)}`;
}

/** `Channel` is a type-only union with no runtime companion in `meta/types.ts`,
 *  so the guard carries its own list. Kept in sync by the compiler: a value not
 *  assignable to `Channel` fails the `satisfies` check below. */
const CHANNELS = ['whatsapp', 'messenger', 'instagram'] satisfies readonly Channel[];

function isChannel(value: string): value is Channel {
  return (CHANNELS as readonly string[]).includes(value);
}

/** A missing key reads as 0; so does anything non-numeric (a hand-edited value). */
function toCount(raw: string | null | undefined): number {
  if (raw === null || raw === undefined) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}
