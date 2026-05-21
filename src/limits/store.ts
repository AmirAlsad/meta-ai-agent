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

  /** Release any owned resources (Redis connection, etc.). Optional. */
  close?(): Promise<void>;
}

/**
 * In-memory token-bucket pacer. Holds one `lastSlotMs` per line in a `Map`.
 * Lazy by design: a line's entry is created on first use and never swept (the
 * keyspace is bounded by the number of distinct `${channel}:${businessId}`
 * lines, which is small; the production Redis store relies on a slot TTL
 * instead).
 */
export class InMemoryLimitCounterStore implements LimitCounterStore {
  private readonly lastSlotMs = new Map<string, number>();

  async acquireOutboundSlot(line: string, now: number, perSecond: number): Promise<number> {
    if (perSecond <= 0) return 0;
    const intervalMs = 1000 / perSecond;
    const lastSlot = this.lastSlotMs.get(line) ?? 0;
    const slot = Math.max(now, lastSlot + intervalMs);
    this.lastSlotMs.set(line, slot);
    return Math.max(0, slot - now);
  }
}
