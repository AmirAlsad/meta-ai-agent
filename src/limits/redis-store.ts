/**
 * Redis-backed {@link LimitCounterStore} for multi-replica deploys.
 *
 * The whole point of the Redis variant is the slot reservation must be ATOMIC
 * across replicas. The in-memory store keeps a per-process slot clock, so with
 * N replicas the line is paced at roughly N/intervalMs — it overshoots Meta's
 * rate and risks 429s. A naive Redis port (GET the slot, compute the next slot
 * in JS, SET it back) has the same race in disguise: two replicas can both GET
 * the same `lastSlot`, both compute the same `nextSlot`, and both SET it — so
 * they hand out the SAME slot and send simultaneously. The compare-and-set must
 * happen inside Redis under a single-threaded execution.
 *
 * The fix is a Lua script run via `EVAL`. Redis executes a script atomically
 * (no other command interleaves), so the read-modify-write of the slot is
 * serialized server-side and every replica observes a strictly advancing slot
 * clock. That atomicity is load-bearing — do not split it into separate
 * GET/SET round-trips.
 */
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { DAY_MS, HOUR_MS, type LimitCounterStore } from './store.js';

/** Shared namespace so the limits keyspace can be flushed without clobbering
 *  conversation/dedupe state on a redeploy. */
const KEY_PREFIX = 'meta-ai-agent:limits';

/**
 * Atomic virtual-clock slot reservation.
 *   KEYS[1] = slot key for the line
 *   ARGV[1] = now (ms)
 *   ARGV[2] = intervalMs (1000 / perSecond)
 *   ARGV[3] = ttl (ms) for the slot key
 * Reads the last reserved slot (default `now - interval` so a fresh/idle line's
 * first acquire is free), advances it to `max(now, last + interval)`, persists
 * it with a PX TTL so idle lines self-expire, and returns the delay (clamped to
 * >= 0). The `now - interval` default mirrors the in-memory store's "first call
 * returns 0" semantics.
 */
const ACQUIRE_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local interval = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
local last = tonumber(redis.call('GET', key) or (now - interval))
local slot = last + interval
if now > slot then slot = now end
redis.call('SET', key, slot, 'PX', ttl)
local delay = slot - now
if delay < 0 then delay = 0 end
return delay
`.trim();

/**
 * Atomic INCR + EXPIRE-on-first for a fixed-window counter.
 *   KEYS[1] = the bucket key (`…:hour:{line}:{bucket}` or `…:day:{line}:{bucket}`)
 *   ARGV[1] = TTL (ms) for the bucket key
 * WHY a Lua EVAL and not a bare INCR + EXPIRE: the standalone two-call sequence
 * has a failure mode under Redis eviction — if the key is evicted between the
 * INCR (which recreates it WITHOUT a TTL) and the EXPIRE, the counter becomes
 * immortal and the bucket never rolls over. EVAL is atomic Redis-side, so the
 * EXPIRE always lands when INCR returns 1 (the first increment of a fresh
 * window). The fixed `{bucket}` segment in the key (the wall-clock window index)
 * means a new window naturally lands on a new key, so old windows expire on
 * their own.
 */
const BUMP_WINDOW_LUA = `
local v = redis.call('INCR', KEYS[1])
if v == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return v
`.trim();

export interface RedisLimitCounterStoreOptions {
  /**
   * Injected (BORROWED) ioredis client. The runtime owns its lifecycle, so
   * {@link RedisLimitCounterStore.close} is a no-op — it must not disconnect a
   * client shared with the conversation store / scheduler.
   */
  redis: Redis;
  logger?: Logger;
}

export class RedisLimitCounterStore implements LimitCounterStore {
  private readonly redis: Redis;

  constructor(opts: RedisLimitCounterStoreOptions) {
    this.redis = opts.redis;
  }

  async acquireOutboundSlot(line: string, now: number, perSecond: number): Promise<number> {
    // Disabled pacing never touches Redis — a no-op send-now.
    if (perSecond <= 0) return 0;
    const intervalMs = 1000 / perSecond;
    // TTL keeps idle slot keys from lingering forever, but must comfortably
    // outlast the slot we just reserved so a steady stream never expires the
    // clock mid-flight: max(4 intervals, 1s).
    const ttlMs = Math.max(Math.ceil(intervalMs * 4), 1000);
    const result = await this.redis.eval(
      ACQUIRE_LUA,
      1,
      `${KEY_PREFIX}:slot:${line}`,
      String(now),
      String(intervalMs),
      String(ttlMs)
    );
    const delay = typeof result === 'number' ? result : Number(result);
    return Number.isFinite(delay) ? Math.max(0, delay) : 0;
  }

  async incrementWindowCounters(
    line: string,
    now: number
  ): Promise<{ hourCount: number; dayCount: number }> {
    // Fixed wall-clock window indices so a new hour/day lands on a new key (the
    // key TTL then evicts the prior window). Buckets are computed identically to
    // the in-memory store via the shared HOUR_MS/DAY_MS constants.
    const hourBucket = Math.floor(now / HOUR_MS);
    const dayBucket = Math.floor(now / DAY_MS);
    // TTL each bucket slightly past its own window so a counter survives the full
    // window even if the first INCR lands late in the window, but still self-evicts.
    const [hourCount, dayCount] = await Promise.all([
      this.bumpWindow(`${KEY_PREFIX}:hour:${line}:${hourBucket}`, HOUR_MS * 2),
      this.bumpWindow(`${KEY_PREFIX}:day:${line}:${dayBucket}`, DAY_MS * 2)
    ]);
    return { hourCount, dayCount };
  }

  private async bumpWindow(key: string, ttlMs: number): Promise<number> {
    const result = await this.redis.eval(BUMP_WINDOW_LUA, 1, key, String(ttlMs));
    const count = typeof result === 'number' ? result : Number(result);
    return Number.isFinite(count) ? count : 0;
  }

  /** No-op: the redis client is borrowed; the runtime owns its lifecycle. */
  async close(): Promise<void> {
    // intentionally empty — see RedisLimitCounterStoreOptions.redis
  }
}
