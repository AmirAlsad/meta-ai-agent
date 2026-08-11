/**
 * Durable per-account, per-day DM volume counters.
 *
 * WHY this exists next to the Stage 6 metrics collector rather than inside it:
 * the Prometheus counters in `src/metrics` are labelled by `channel` only (no
 * account) and live in an {@link "../metrics/collector.js".InMemoryMetricsCollector},
 * so they reset on every deploy. DM volume is a marketing signal read weeks
 * later and joined against a date-keyed store downstream, and Meta's own API
 * serves no Instagram DM metric at all — the transport is the only source of
 * truth, so its counters have to outlive the process.
 *
 * Two implementations honor this interface, mirroring the limits stores:
 *  - {@link InMemoryStatsStore} — a `Map` per (date, account, channel).
 *    Single-process and lost on restart; for tests, local runs, and
 *    single-replica deploys without Redis.
 *  - {@link "./redis-store.js".RedisStatsStore} — one Lua-atomic `INCR` +
 *    `PEXPIRE` per counter, so N replicas accumulate into the same day.
 *    Selected when `REDIS_URL` is configured.
 *
 * The counter is keyed on the UTC CALENDAR DATE, not on `floor(now / DAY_MS)`
 * the way the limits window buckets are. These numbers are read as dates and
 * joined against a date-keyed store downstream, so a bucket index that has to
 * be converted back to a date on every read is the wrong shape — the date
 * itself is the key.
 */

import type { Channel } from '../meta/types.js';

/** The three volumes worth counting. One Redis key per (account, channel, metric, date). */
export type StatsMetric = 'conversations_started' | 'messages_in' | 'messages_out';

/** Iteration order for the metrics — also the read order in {@link StatsStore.range}. */
export const STATS_METRICS: readonly StatsMetric[] = [
  'conversations_started',
  'messages_in',
  'messages_out'
];

export const DAY_MS = 86_400_000;

/**
 * Upper bound on the number of days {@link StatsStore.range} will enumerate in
 * one call. This is a guard against an unbounded multi-key read (a caller
 * passing `0001-01-01` would otherwise fan out to ~700k keys), NOT a retention
 * policy — retention is the store's constructor parameter. The bound sits
 * comfortably past a year so the intended "last N months" reads never hit it.
 */
export const MAX_RANGE_DAYS = 1_000;

export interface StatsDay {
  /** UTC calendar date, `YYYY-MM-DD`. */
  date: string;
  account: string;
  channel: Channel;
  conversations_started: number;
  messages_in: number;
  messages_out: number;
}

export interface StatsStore {
  /**
   * Bump one counter for (account, channel, metric) on the UTC date of `now`.
   *
   * NEVER THROWS. This is called on the message hot path, and the same rule the
   * {@link "../limits/tracker.js".LimitTracker} states for its own window
   * counters applies here: a track-only counter must never affect delivery. A
   * store failure (Redis down, malformed `now`) is logged and swallowed, and the
   * message goes out anyway — a lost count is cheaper than a lost reply.
   */
  increment(account: string, channel: Channel, metric: StatsMetric, now: number): Promise<void>;

  /**
   * Read every (date, account, channel) that counted anything in the INCLUSIVE
   * span `[sinceIso, untilIso]`, ascending by date then account then channel.
   * A day/account/channel with no counts at all is omitted, so an untouched
   * span returns `[]`; a row that counted one metric reports `0` for the others.
   *
   * MAY THROW, unlike {@link StatsStore.increment} — this is only reached from
   * an HTTP route, where a malformed date is better surfaced as an error than
   * silently answered with the wrong span.
   */
  range(sinceIso: string, untilIso: string): Promise<StatsDay[]>;

  /** Release any owned resources (Redis connection, etc.). Optional. */
  close?(): Promise<void>;
}

/**
 * Percent-escape `:` (and `%`, so the escape is reversible) in a key segment.
 *
 * WHY: the key is colon-delimited and `account` is an operator-supplied config
 * string. An account literally named `a:b` would otherwise produce the same key
 * as an account `a` on a channel `b` — two different accounts silently sharing
 * a counter, which is a corrupted number nobody would ever notice. Escaping is
 * chosen over rejecting because {@link StatsStore.increment} must not throw and
 * must not drop a count either; the segment survives intact and
 * {@link decodeKeySegment} recovers the original for {@link StatsStore.range}.
 * Both stores use this so their composite keys agree exactly.
 */
export function encodeKeySegment(segment: string): string {
  return segment.replace(/%/g, '%25').replace(/:/g, '%3A');
}

/** Inverse of {@link encodeKeySegment}. */
export function decodeKeySegment(segment: string): string {
  return segment.replace(/%3A/g, ':').replace(/%25/g, '%');
}

/**
 * The UTC calendar date (`YYYY-MM-DD`) containing `now`.
 * Throws on a non-finite / out-of-range `now`; callers on the hot path swallow.
 */
export function utcDateFromMillis(now: number): string {
  if (!Number.isFinite(now)) throw new Error(`stats: non-finite timestamp ${now}`);
  return new Date(now).toISOString().slice(0, 10);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse a `YYYY-MM-DD` date into UTC midnight millis, rejecting anything that
 * is not exactly that shape AND a real calendar date. The round-trip check is
 * what rejects `2026-02-30`, which `Date.parse` would happily roll into March.
 */
export function parseIsoDate(dateIso: string, label: string): number {
  if (typeof dateIso !== 'string' || !ISO_DATE.test(dateIso)) {
    throw new Error(`stats: ${label} must be a YYYY-MM-DD date, got ${JSON.stringify(dateIso)}`);
  }
  const ms = Date.parse(`${dateIso}T00:00:00.000Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== dateIso) {
    throw new Error(`stats: ${label} is not a real calendar date: ${dateIso}`);
  }
  return ms;
}

/**
 * Every UTC date in the inclusive span, ascending. Validates both ends and the
 * span itself, so a caller that got the order backwards or asked for a decade
 * gets a clear error instead of a very large read.
 */
export function enumerateDates(sinceIso: string, untilIso: string): string[] {
  const sinceMs = parseIsoDate(sinceIso, 'sinceIso');
  const untilMs = parseIsoDate(untilIso, 'untilIso');
  if (untilMs < sinceMs) {
    throw new Error(`stats: untilIso (${untilIso}) is before sinceIso (${sinceIso})`);
  }
  const days = Math.round((untilMs - sinceMs) / DAY_MS) + 1;
  if (days > MAX_RANGE_DAYS) {
    throw new Error(`stats: range of ${days} days exceeds the ${MAX_RANGE_DAYS}-day maximum`);
  }
  const dates: string[] = [];
  for (let ms = sinceMs; ms <= untilMs; ms += DAY_MS) {
    dates.push(new Date(ms).toISOString().slice(0, 10));
  }
  return dates;
}

/** A zeroed row, so a partially-counted (date, account, channel) still reports every metric. */
export function emptyStatsDay(date: string, account: string, channel: Channel): StatsDay {
  return {
    date,
    account,
    channel,
    conversations_started: 0,
    messages_in: 0,
    messages_out: 0
  };
}

/**
 * Ascending by date, then account, then channel — the order both stores return.
 * Plain code-point comparison rather than `localeCompare`, so two replicas in
 * different locales cannot order the same rows differently.
 */
export function compareStatsDays(a: StatsDay, b: StatsDay): number {
  return (
    compareStrings(a.date, b.date) ||
    compareStrings(a.account, b.account) ||
    compareStrings(a.channel, b.channel)
  );
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Reject a nonsense retention at construction (boot time), where throwing is fine. */
export function assertRetentionDays(retentionDays: number): number {
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    throw new Error(`stats: retentionDays must be a positive integer, got ${retentionDays}`);
  }
  return retentionDays;
}

export interface InMemoryStatsStoreOptions {
  /**
   * How many days of history to keep. Matches the Redis store's key TTL so the
   * two agree on what is still readable; the default lives in config, not here.
   */
  retentionDays: number;
}

/**
 * In-memory day counters: one row per (date, account, channel) in a `Map`.
 *
 * Unlike the limits in-memory store — whose keyspace is bounded by the small,
 * fixed number of lines and so is never swept — this one's keyspace grows by a
 * row per active day forever, so it applies `retentionDays` itself. The sweep
 * runs only when the written date CHANGES (once per UTC day in a steady
 * process), not on every increment.
 */
export class InMemoryStatsStore implements StatsStore {
  private readonly retentionDays: number;
  /** Keyed `${date}:${encodeKeySegment(account)}:${channel}` — encoded for the same
   *  reason the Redis key is, so an account containing `:` cannot collide here either. */
  private readonly days = new Map<string, StatsDay>();
  /** The date of the last write, so the retention sweep runs on a date roll only. */
  private lastWrittenDate: string | undefined;

  constructor(opts: InMemoryStatsStoreOptions) {
    this.retentionDays = assertRetentionDays(opts.retentionDays);
  }

  async increment(
    account: string,
    channel: Channel,
    metric: StatsMetric,
    now: number
  ): Promise<void> {
    // Fail-open like the Redis store: nothing about a counter is worth failing a
    // send for. The only reachable throw here is a malformed `now`.
    try {
      const date = utcDateFromMillis(now);
      const key = `${date}:${encodeKeySegment(account)}:${channel}`;
      const row = this.days.get(key) ?? emptyStatsDay(date, account, channel);
      row[metric] += 1;
      this.days.set(key, row);
      if (date !== this.lastWrittenDate) {
        this.lastWrittenDate = date;
        this.evictBefore(date);
      }
    } catch {
      // swallowed by contract — see StatsStore.increment
    }
  }

  async range(sinceIso: string, untilIso: string): Promise<StatsDay[]> {
    const dates = new Set(enumerateDates(sinceIso, untilIso));
    const rows: StatsDay[] = [];
    for (const row of this.days.values()) {
      if (!dates.has(row.date)) continue;
      // Defensive: a row only exists because something incremented, but keep the
      // "nothing counted is omitted" guarantee identical to the Redis store's.
      if (!STATS_METRICS.some((metric) => row[metric] > 0)) continue;
      rows.push({ ...row });
    }
    return rows.sort(compareStatsDays);
  }

  /** Drop every row older than `retentionDays` before `date`, mirroring the Redis key TTL. */
  private evictBefore(date: string): void {
    const cutoffMs = parseIsoDate(date, 'date') - this.retentionDays * DAY_MS;
    const cutoff = new Date(cutoffMs).toISOString().slice(0, 10);
    for (const [key, row] of this.days) {
      if (row.date < cutoff) this.days.delete(key);
    }
  }
}
