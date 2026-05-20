import type pino from 'pino';

export type LabelValues = Record<string, string>;

export type CounterOpts = { help?: string; labels?: readonly string[] };
export type GaugeOpts = { help?: string; labels?: readonly string[] };
export type HistogramOpts = {
  help?: string;
  labels?: readonly string[];
  buckets?: readonly number[];
};

export interface Counter {
  inc(labels?: LabelValues, value?: number): void;
}

export interface Gauge {
  set(labels: LabelValues | undefined, value: number): void;
  inc(labels?: LabelValues, value?: number): void;
  dec(labels?: LabelValues, value?: number): void;
}

export interface Histogram {
  observe(labels: LabelValues | undefined, value: number): void;
  startTimer(labels?: LabelValues): () => number;
}

export interface MetricsCollector {
  counter(name: string, opts?: CounterOpts): Counter;
  gauge(name: string, opts?: GaugeOpts): Gauge;
  histogram(name: string, opts?: HistogramOpts): Histogram;
  snapshot(): MetricsSnapshot;
}

export type SeriesSnapshot = { labels: LabelValues; value: number };
export type HistogramSeriesSnapshot = {
  labels: LabelValues;
  bucketCounts: number[];
  sum: number;
  count: number;
};

export type CounterSnapshot = {
  kind: 'counter';
  name: string;
  help?: string;
  labelKeys: readonly string[];
  series: SeriesSnapshot[];
};
export type GaugeSnapshot = {
  kind: 'gauge';
  name: string;
  help?: string;
  labelKeys: readonly string[];
  series: SeriesSnapshot[];
};
export type HistogramSnapshot = {
  kind: 'histogram';
  name: string;
  help?: string;
  labelKeys: readonly string[];
  buckets: readonly number[];
  series: HistogramSeriesSnapshot[];
};
export type MetricSnapshot = CounterSnapshot | GaugeSnapshot | HistogramSnapshot;
export type MetricsSnapshot = { metrics: MetricSnapshot[] };

export const DEFAULT_LATENCY_BUCKETS_SECONDS: readonly number[] = Object.freeze([
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30
]);

export const OVERFLOW_LABEL_VALUE = '__overflow__';
export const DEFAULT_LABEL_CARDINALITY_LIMIT = 1000;

/** No-op collector used as the default when metrics are not configured. */
export class NoopMetricsCollector implements MetricsCollector {
  counter(_name: string, _opts?: CounterOpts): Counter {
    return NOOP_COUNTER;
  }
  gauge(_name: string, _opts?: GaugeOpts): Gauge {
    return NOOP_GAUGE;
  }
  histogram(_name: string, _opts?: HistogramOpts): Histogram {
    return NOOP_HISTOGRAM;
  }
  snapshot(): MetricsSnapshot {
    return { metrics: [] };
  }
}

const NOOP_COUNTER: Counter = { inc: () => {} };
const NOOP_GAUGE: Gauge = { set: () => {}, inc: () => {}, dec: () => {} };
const NOOP_HISTOGRAM: Histogram = {
  observe: () => {},
  startTimer: () => () => 0
};

type RegisteredMetric = InMemoryCounter | InMemoryGauge | InMemoryHistogram;

export type InMemoryMetricsOptions = {
  /** Maximum distinct label combinations per metric. Overflow folds into a single sentinel series. */
  cardinalityLimit?: number;
  logger?: pino.Logger;
};

export class InMemoryMetricsCollector implements MetricsCollector {
  private readonly metrics = new Map<string, RegisteredMetric>();
  private readonly cardinalityLimit: number;
  private readonly logger?: pino.Logger;

  constructor(opts: InMemoryMetricsOptions = {}) {
    this.cardinalityLimit = opts.cardinalityLimit ?? DEFAULT_LABEL_CARDINALITY_LIMIT;
    this.logger = opts.logger;
  }

  counter(name: string, opts: CounterOpts = {}): Counter {
    const existing = this.metrics.get(name);
    if (existing) {
      if (existing.kind !== 'counter') {
        throw new Error(`Metric ${name} already registered as ${existing.kind}`);
      }
      return existing;
    }
    const metric = new InMemoryCounter(name, opts, this.cardinalityLimit, this.logger);
    this.metrics.set(name, metric);
    return metric;
  }

  gauge(name: string, opts: GaugeOpts = {}): Gauge {
    const existing = this.metrics.get(name);
    if (existing) {
      if (existing.kind !== 'gauge') {
        throw new Error(`Metric ${name} already registered as ${existing.kind}`);
      }
      return existing;
    }
    const metric = new InMemoryGauge(name, opts, this.cardinalityLimit, this.logger);
    this.metrics.set(name, metric);
    return metric;
  }

  histogram(name: string, opts: HistogramOpts = {}): Histogram {
    const existing = this.metrics.get(name);
    if (existing) {
      if (existing.kind !== 'histogram') {
        throw new Error(`Metric ${name} already registered as ${existing.kind}`);
      }
      return existing;
    }
    const metric = new InMemoryHistogram(name, opts, this.cardinalityLimit, this.logger);
    this.metrics.set(name, metric);
    return metric;
  }

  snapshot(): MetricsSnapshot {
    return { metrics: Array.from(this.metrics.values()).map(m => m.snapshot()) };
  }
}

abstract class InMemoryMetricBase {
  abstract readonly kind: 'counter' | 'gauge' | 'histogram';
  protected readonly labelKeys: readonly string[];
  protected overflowWarned = false;

  constructor(
    public readonly name: string,
    public readonly help: string | undefined,
    labels: readonly string[] | undefined,
    protected readonly cardinalityLimit: number,
    protected readonly logger?: pino.Logger
  ) {
    this.labelKeys = labels ? [...labels].sort() : [];
  }

  abstract snapshot(): MetricSnapshot;

  /**
   * Resolve a label-values input to a canonical key string and the normalized label-values
   * object stored in the snapshot. Unknown label keys are dropped silently; missing keys
   * become "". When the cardinality limit is reached, a sentinel overflow key/values is
   * returned so we never grow the map unbounded.
   *
   * WHY the cap: label values are frequently derived from external input (Meta error
   * codes, message types, channel identifiers). A buggy upstream or a hostile sender
   * could emit an unbounded stream of distinct values, and an unbounded per-series map
   * would grow without limit and eventually OOM the process. Folding everything past the
   * cap into a single `__overflow__` series keeps memory bounded while still surfacing
   * that overflow happened (the sentinel series and the one-shot warn log).
   */
  protected resolve(
    labels: LabelValues | undefined,
    seriesSize: number,
    hasKey: (key: string) => boolean
  ): { key: string; values: LabelValues; overflow: boolean } {
    const values: LabelValues = {};
    for (const k of this.labelKeys) {
      const v = labels?.[k];
      values[k] = typeof v === 'string' ? v : '';
    }
    const canonical = this.canonicalKey(values);
    // An ALREADY-registered series always resolves to itself — the cardinality
    // cap blocks only NEW label combinations. Without this short-circuit, once
    // the map reaches the cap EVERY subsequent call (including healthy,
    // pre-existing series) would fold into __overflow__, silently freezing those
    // metrics and making a cardinality explosion indistinguishable from a metric
    // simply going quiet.
    if (hasKey(canonical)) {
      return { key: canonical, values, overflow: false };
    }
    if (seriesSize >= this.cardinalityLimit) {
      const overflowValues: LabelValues = {};
      for (const k of this.labelKeys) overflowValues[k] = OVERFLOW_LABEL_VALUE;
      if (!this.overflowWarned) {
        this.overflowWarned = true;
        this.logger?.warn(
          { metric: this.name, cardinalityLimit: this.cardinalityLimit },
          'metric label cardinality cap reached; subsequent NEW series fold into __overflow__'
        );
      }
      return { key: this.canonicalKey(overflowValues), values: overflowValues, overflow: true };
    }
    return { key: canonical, values, overflow: false };
  }

  protected canonicalKey(values: LabelValues): string {
    return this.labelKeys.map(k => values[k] ?? '').join('\x1f');
  }
}

class InMemoryCounter extends InMemoryMetricBase implements Counter {
  readonly kind = 'counter' as const;
  private readonly series = new Map<string, { labels: LabelValues; value: number }>();

  constructor(name: string, opts: CounterOpts, cardinalityLimit: number, logger?: pino.Logger) {
    super(name, opts.help, opts.labels, cardinalityLimit, logger);
  }

  inc(labels?: LabelValues, value: number = 1): void {
    if (!Number.isFinite(value) || value < 0) return;
    const { key, values } = this.resolve(labels, this.series.size, k => this.series.has(k));
    const entry = this.series.get(key);
    if (entry) {
      entry.value += value;
    } else {
      this.series.set(key, { labels: values, value });
    }
  }

  snapshot(): CounterSnapshot {
    return {
      kind: 'counter',
      name: this.name,
      help: this.help,
      labelKeys: this.labelKeys,
      series: Array.from(this.series.values()).map(s => ({ labels: s.labels, value: s.value }))
    };
  }
}

class InMemoryGauge extends InMemoryMetricBase implements Gauge {
  readonly kind = 'gauge' as const;
  private readonly series = new Map<string, { labels: LabelValues; value: number }>();

  constructor(name: string, opts: GaugeOpts, cardinalityLimit: number, logger?: pino.Logger) {
    super(name, opts.help, opts.labels, cardinalityLimit, logger);
  }

  set(labels: LabelValues | undefined, value: number): void {
    if (!Number.isFinite(value)) return;
    const { key, values } = this.resolve(labels, this.series.size, k => this.series.has(k));
    const entry = this.series.get(key);
    if (entry) entry.value = value;
    else this.series.set(key, { labels: values, value });
  }

  inc(labels?: LabelValues, value: number = 1): void {
    if (!Number.isFinite(value)) return;
    const { key, values } = this.resolve(labels, this.series.size, k => this.series.has(k));
    const entry = this.series.get(key);
    if (entry) entry.value += value;
    else this.series.set(key, { labels: values, value });
  }

  dec(labels?: LabelValues, value: number = 1): void {
    this.inc(labels, -value);
  }

  snapshot(): GaugeSnapshot {
    return {
      kind: 'gauge',
      name: this.name,
      help: this.help,
      labelKeys: this.labelKeys,
      series: Array.from(this.series.values()).map(s => ({ labels: s.labels, value: s.value }))
    };
  }
}

class InMemoryHistogram extends InMemoryMetricBase implements Histogram {
  readonly kind = 'histogram' as const;
  private readonly series = new Map<
    string,
    { labels: LabelValues; bucketCounts: number[]; sum: number; count: number }
  >();
  private readonly buckets: readonly number[];

  constructor(name: string, opts: HistogramOpts, cardinalityLimit: number, logger?: pino.Logger) {
    super(name, opts.help, opts.labels, cardinalityLimit, logger);
    const buckets = opts.buckets ?? DEFAULT_LATENCY_BUCKETS_SECONDS;
    const sorted = [...buckets].sort((a, b) => a - b);
    if (sorted.length === 0) {
      throw new Error(`Histogram ${name} requires at least one bucket boundary`);
    }
    this.buckets = Object.freeze(sorted);
  }

  observe(labels: LabelValues | undefined, value: number): void {
    if (!Number.isFinite(value)) return;
    const { key, values } = this.resolve(labels, this.series.size, k => this.series.has(k));
    let entry = this.series.get(key);
    if (!entry) {
      entry = {
        labels: values,
        bucketCounts: new Array(this.buckets.length).fill(0),
        sum: 0,
        count: 0
      };
      this.series.set(key, entry);
    }
    let placed = false;
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]) {
        entry.bucketCounts[i] += 1;
        placed = true;
        break;
      }
    }
    // Values exceeding the largest finite bucket only show in the implicit +Inf bucket
    // (which we materialize from `count`). No-op when not placed.
    void placed;
    entry.sum += value;
    entry.count += 1;
  }

  startTimer(labels?: LabelValues): () => number {
    const start = process.hrtime.bigint();
    return () => {
      const end = process.hrtime.bigint();
      const seconds = Number(end - start) / 1e9;
      this.observe(labels, seconds);
      return seconds;
    };
  }

  snapshot(): HistogramSnapshot {
    return {
      kind: 'histogram',
      name: this.name,
      help: this.help,
      labelKeys: this.labelKeys,
      buckets: this.buckets,
      series: Array.from(this.series.values()).map(s => ({
        labels: s.labels,
        bucketCounts: [...s.bucketCounts],
        sum: s.sum,
        count: s.count
      }))
    };
  }
}
