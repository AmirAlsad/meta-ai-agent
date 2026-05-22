/**
 * Per-line outbound pacing counters for the {@link "./tracker.js".LimitTracker}.
 *
 * A "line" here is a `${channel}:${businessId}` key — the smallest unit Meta
 * rate-limits independently (e.g. each WhatsApp phone number id, each Page, each
 * IG user). The store implements a virtual-clock token bucket: every call to
 * {@link LimitCounterStore.acquireOutboundSlot} reserves the NEXT free slot on
 * the line and returns how long the caller must wait before it can send. The
 * caller is responsible for actually waiting (the store never blocks).
 *
 * Two implementations honor this interface:
 *  - {@link InMemoryLimitCounterStore} — a per-line `Map<line, lastSlotMs>`.
 *    Single-process only (the per-line pacer overshoots Meta's rate in a
 *    multi-replica deploy, since each replica keeps its own slot clock).
 *    Used for tests, local runs, and single-replica deploys without Redis.
 *  - {@link "./redis-store.js".RedisLimitCounterStore} — a Lua-atomic slot in
 *    Redis so N replicas share one virtual clock per line. Required for
 *    multi-replica deploys. Selected when `REDIS_URL` is configured.
 */

export interface LimitCounterStore {
  /**
   * Atomically reserve the next outbound pacing slot for `line` (a
   * `${channel}:${businessId}` key) and return the number of milliseconds the
   * caller must wait before sending (`0` = send now).
   *
   * Virtual-clock token bucket: `intervalMs = 1000 / perSecond`, and the next
   * slot is `max(now, lastSlot + intervalMs)`. The reserved slot is persisted
   * as the new `lastSlot`, so a burst of N back-to-back calls is spread out at
   * `intervalMs` apart, while a long idle gap does NOT accumulate burst credit
   * (the `max(now, ...)` clamp resets the clock to "now").
   *
   * `perSecond <= 0` disables pacing for the line and always returns `0`
   * without touching any persistent state.
   */
  acquireOutboundSlot(line: string, now: number, perSecond: number): Promise<number>;

  /**
   * Bump the fixed per-hour and per-day outbound counters for `line` and return
   * the post-increment totals. TRACK-ONLY: the {@link "./tracker.js".LimitTracker}
   * uses these for advisory warn/error logging as a line nears its messaging-tier
   * cap; nothing here ever gates a send.
   *
   * Windows are FIXED calendar-ish buckets keyed off the wall clock —
   * `floor(now / 3600000)` for the hour, `floor(now / 86400000)` for the day —
   * not sliding windows. WHY fixed buckets: an O(1) `INCR + EXPIRE` per send
   * (vs. an O(N) sorted-set sliding window) is the right cost for a coarse
   * "how many this hour/day" signal, and it matches the production Redis store's
   * Lua `INCR`/`EXPIRE` shape. A bucket self-expires after its window so the
   * keyspace stays bounded.
   */
  incrementWindowCounters(
    line: string,
    now: number
  ): Promise<{ hourCount: number; dayCount: number }>;

  /** Release any owned resources (Redis connection, etc.). Optional. */
  close?(): Promise<void>;
}

/** Window-bucket math shared by the in-memory and Redis stores (one definition
 *  so the two impls bucket identically). */
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/**
 * In-memory token-bucket pacer. Holds one `lastSlotMs` per line in a `Map`.
 * Lazy by design: a line's entry is created on first use and never swept (the
 * keyspace is bounded by the number of distinct `${channel}:${businessId}`
 * lines, which is small; the production Redis store relies on a slot TTL
 * instead).
 */
export class InMemoryLimitCounterStore implements LimitCounterStore {
  private readonly lastSlotMs = new Map<string, number>();
  /**
   * Fixed-window counters keyed by `${line}:${bucket}`. Lazy entries created on
   * first use; an entry whose bucket no longer matches the current `now` window
   * is treated as expired and re-seeded at 1 (so memory is bounded by the small
   * number of active lines × at most 2 live buckets each — old buckets are
   * overwritten, never accumulated). The Redis store relies on a key TTL instead.
   */
  private readonly hourCounters = new Map<string, { bucket: number; count: number }>();
  private readonly dayCounters = new Map<string, { bucket: number; count: number }>();

  async acquireOutboundSlot(line: string, now: number, perSecond: number): Promise<number> {
    if (perSecond <= 0) return 0;
    const intervalMs = 1000 / perSecond;
    const lastSlot = this.lastSlotMs.get(line) ?? 0;
    const slot = Math.max(now, lastSlot + intervalMs);
    this.lastSlotMs.set(line, slot);
    return Math.max(0, slot - now);
  }

  async incrementWindowCounters(
    line: string,
    now: number
  ): Promise<{ hourCount: number; dayCount: number }> {
    return {
      hourCount: bump(this.hourCounters, line, Math.floor(now / HOUR_MS)),
      dayCount: bump(this.dayCounters, line, Math.floor(now / DAY_MS))
    };
  }
}

/**
 * Increment the counter for `line` in `bucket`. A different bucket than the
 * stored one means the window rolled over, so we RESET to 1 rather than carry
 * the prior window's total — the entry for a line holds exactly one live bucket.
 */
function bump(map: Map<string, { bucket: number; count: number }>, line: string, bucket: number): number {
  const existing = map.get(line);
  if (!existing || existing.bucket !== bucket) {
    map.set(line, { bucket, count: 1 });
    return 1;
  }
  existing.count += 1;
  return existing.count;
}
