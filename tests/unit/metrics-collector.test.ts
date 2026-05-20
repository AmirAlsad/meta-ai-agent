import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LATENCY_BUCKETS_SECONDS,
  InMemoryMetricsCollector,
  NoopMetricsCollector,
  OVERFLOW_LABEL_VALUE
} from '../../src/metrics/collector.js';

describe('InMemoryMetricsCollector', () => {
  describe('counter', () => {
    it('accumulates values per label combination', () => {
      const c = new InMemoryMetricsCollector();
      const counter = c.counter('foo_total', { labels: ['a', 'b'] });
      counter.inc({ a: '1', b: 'x' });
      counter.inc({ a: '1', b: 'x' }, 3);
      counter.inc({ a: '2', b: 'x' });

      const snap = c.snapshot();
      expect(snap.metrics).toHaveLength(1);
      const metric = snap.metrics[0];
      expect(metric.kind).toBe('counter');
      expect(metric.series).toHaveLength(2);
      const ax1 = metric.series.find(s => s.labels.a === '1');
      expect(ax1).toBeDefined();
      // counter snapshot series have a `value` field
      expect((ax1 as { value: number }).value).toBe(4);
    });

    it('inc with no labels yields a single unlabeled series', () => {
      const c = new InMemoryMetricsCollector();
      const counter = c.counter('plain_total');
      counter.inc();
      counter.inc(undefined, 2);
      const snap = c.snapshot().metrics[0];
      expect(snap.labelKeys).toEqual([]);
      expect(snap.series).toHaveLength(1);
      expect(snap.series[0].labels).toEqual({});
      expect((snap.series[0] as { value: number }).value).toBe(3);
    });

    it('ignores negative and non-finite deltas', () => {
      const c = new InMemoryMetricsCollector();
      const counter = c.counter('foo_total');
      counter.inc(undefined, 5);
      counter.inc(undefined, -3);
      counter.inc(undefined, Number.NaN);
      counter.inc(undefined, Number.POSITIVE_INFINITY);
      const snap = c.snapshot().metrics[0];
      expect((snap.series[0] as { value: number }).value).toBe(5);
    });

    it('drops unknown label keys and defaults missing keys to ""', () => {
      const c = new InMemoryMetricsCollector();
      const counter = c.counter('foo_total', { labels: ['known'] });
      counter.inc({ known: 'v', surprise: 'dropped' });
      counter.inc({});
      const snap = c.snapshot().metrics[0];
      expect(snap.labelKeys).toEqual(['known']);
      const labelSets = snap.series.map(s => s.labels);
      expect(labelSets).toContainEqual({ known: 'v' });
      expect(labelSets).toContainEqual({ known: '' });
      // surprise key never appears
      for (const set of labelSets) expect('surprise' in set).toBe(false);
    });

    it('returns the same instance on re-registration', () => {
      const c = new InMemoryMetricsCollector();
      const a = c.counter('foo_total');
      const b = c.counter('foo_total');
      expect(a).toBe(b);
    });

    it('throws on type mismatch with same name', () => {
      const c = new InMemoryMetricsCollector();
      c.counter('shared_metric');
      expect(() => c.gauge('shared_metric')).toThrow(/already registered as counter/);
    });
  });

  describe('gauge', () => {
    it('set replaces value, inc/dec are deltas', () => {
      const c = new InMemoryMetricsCollector();
      const g = c.gauge('temp', { labels: ['region'] });
      g.set({ region: 'us' }, 70);
      g.inc({ region: 'us' }, 5);
      g.dec({ region: 'us' }, 2);
      const snap = c.snapshot().metrics[0];
      expect(snap.kind).toBe('gauge');
      expect((snap.series[0] as { value: number }).value).toBe(73);
    });

    it('set tolerates a missing/undefined label argument', () => {
      const c = new InMemoryMetricsCollector();
      const g = c.gauge('up');
      g.set(undefined, 1);
      const snap = c.snapshot().metrics[0];
      expect((snap.series[0] as { value: number }).value).toBe(1);
    });
  });

  describe('histogram', () => {
    it('places observations into the smallest bucket >= value', () => {
      const c = new InMemoryMetricsCollector();
      const h = c.histogram('latency_seconds', { buckets: [0.1, 0.5, 1] });
      h.observe(undefined, 0.05); // bucket[0]
      h.observe(undefined, 0.2); // bucket[1]
      h.observe(undefined, 0.6); // bucket[2]
      h.observe(undefined, 5); // overflow → only count

      const snap = c.snapshot().metrics[0];
      expect(snap.kind).toBe('histogram');
      const series = (snap.series as Array<{
        bucketCounts: number[];
        sum: number;
        count: number;
      }>)[0];
      expect(series.bucketCounts).toEqual([1, 1, 1]);
      expect(series.count).toBe(4);
      expect(series.sum).toBeCloseTo(0.05 + 0.2 + 0.6 + 5, 5);
    });

    it('sorts unsorted bucket boundaries and exposes them on the snapshot', () => {
      const c = new InMemoryMetricsCollector();
      const h = c.histogram('sortme_seconds', { buckets: [1, 0.1, 0.5] });
      h.observe(undefined, 0.2);
      const snap = c.snapshot().metrics[0] as {
        buckets: readonly number[];
        series: Array<{ bucketCounts: number[] }>;
      };
      expect(snap.buckets).toEqual([0.1, 0.5, 1]);
      // 0.2 lands in the (now sorted) 0.5 bucket
      expect(snap.series[0].bucketCounts).toEqual([0, 1, 0]);
    });

    it('startTimer records elapsed seconds when invoked', async () => {
      const c = new InMemoryMetricsCollector();
      const h = c.histogram('elapsed_seconds', { buckets: [0.001, 0.05, 1] });
      const stop = h.startTimer({});
      await new Promise(resolve => setTimeout(resolve, 5));
      const elapsed = stop();
      expect(elapsed).toBeGreaterThan(0);
      const snap = c.snapshot().metrics[0];
      const series = (snap.series as Array<{ count: number; sum: number }>)[0];
      expect(series.count).toBe(1);
      expect(series.sum).toBeGreaterThan(0);
    });

    it('defaults to DEFAULT_LATENCY_BUCKETS_SECONDS when no buckets given', () => {
      const c = new InMemoryMetricsCollector();
      c.histogram('default_buckets_seconds', {});
      const snap = c.snapshot().metrics[0] as { buckets: readonly number[] };
      expect(snap.buckets).toEqual([...DEFAULT_LATENCY_BUCKETS_SECONDS]);
    });

    it('rejects empty bucket sets', () => {
      const c = new InMemoryMetricsCollector();
      expect(() => c.histogram('empty', { buckets: [] })).toThrow(/at least one bucket/);
    });
  });

  describe('cardinality cap', () => {
    it('folds excess label combinations into a sentinel overflow series', () => {
      const c = new InMemoryMetricsCollector({ cardinalityLimit: 2 });
      const counter = c.counter('foo_total', { labels: ['key'] });
      counter.inc({ key: 'a' });
      counter.inc({ key: 'b' });
      counter.inc({ key: 'c' });
      counter.inc({ key: 'd' });

      const snap = c.snapshot().metrics[0];
      const labels = snap.series.map(s => s.labels.key);
      expect(labels).toContain('a');
      expect(labels).toContain('b');
      expect(labels).toContain(OVERFLOW_LABEL_VALUE);
      const overflow = snap.series.find(s => s.labels.key === OVERFLOW_LABEL_VALUE);
      expect((overflow as { value: number }).value).toBe(2);
    });

    it('does not grow the series map past the cap under a runaway label stream', () => {
      const limit = 8;
      const c = new InMemoryMetricsCollector({ cardinalityLimit: limit });
      const counter = c.counter('runaway_total', { labels: ['id'] });
      // Simulate a hostile/buggy source emitting thousands of distinct values.
      for (let i = 0; i < 5000; i++) {
        counter.inc({ id: `id-${i}` });
      }
      const snap = c.snapshot().metrics[0];
      // At most `limit` distinct kept series + the single overflow sentinel.
      expect(snap.series.length).toBeLessThanOrEqual(limit + 1);
      const overflow = snap.series.find(s => s.labels.id === OVERFLOW_LABEL_VALUE);
      expect(overflow).toBeDefined();
      // Everything past the cap accumulated into the one sentinel series.
      expect((overflow as { value: number }).value).toBe(5000 - limit);
    });

    it('caps histogram series independently and folds overflow', () => {
      const c = new InMemoryMetricsCollector({ cardinalityLimit: 1 });
      const h = c.histogram('h_seconds', { labels: ['k'], buckets: [1] });
      h.observe({ k: 'first' }, 0.5);
      h.observe({ k: 'second' }, 0.5);
      h.observe({ k: 'third' }, 0.5);
      const snap = c.snapshot().metrics[0];
      const series = snap.series as unknown as Array<{
        labels: Record<string, string>;
        count: number;
      }>;
      expect(series.length).toBeLessThanOrEqual(2);
      const overflow = series.find(s => s.labels.k === OVERFLOW_LABEL_VALUE);
      expect(overflow).toBeDefined();
      expect((overflow as { count: number }).count).toBe(2);
    });
  });

  describe('snapshot shape', () => {
    it('reports kind, name, help, labelKeys (sorted), and per-series labels', () => {
      const c = new InMemoryMetricsCollector();
      c.counter('shaped_total', { help: 'a help', labels: ['b', 'a'] }).inc({ a: '1', b: '2' });
      const snap = c.snapshot();
      expect(snap).toEqual({
        metrics: [
          {
            kind: 'counter',
            name: 'shaped_total',
            help: 'a help',
            labelKeys: ['a', 'b'], // sorted
            series: [{ labels: { a: '1', b: '2' }, value: 1 }]
          }
        ]
      });
    });
  });
});

describe('NoopMetricsCollector', () => {
  it('exposes no-op handles whose calls are silent and snapshot is empty', () => {
    const c = new NoopMetricsCollector();
    const counter = c.counter('foo');
    counter.inc({ a: 'x' }, 5);
    const gauge = c.gauge('bar');
    gauge.set({}, 1);
    gauge.inc({}, 1);
    gauge.dec({}, 1);
    const histogram = c.histogram('baz');
    histogram.observe({}, 0.5);
    expect(histogram.startTimer()()).toBe(0);
    expect(c.snapshot().metrics).toHaveLength(0);
  });
});
