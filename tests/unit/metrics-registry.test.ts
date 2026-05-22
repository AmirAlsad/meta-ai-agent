import { describe, expect, it } from 'vitest';
import { InMemoryMetricsCollector, DEFAULT_LATENCY_BUCKETS_SECONDS } from '../../src/metrics/collector.js';
import { createAgentMetrics } from '../../src/metrics/registry.js';

/**
 * Registry tests. Stage 10 added three handles to `createAgentMetrics`:
 *  - transient_retry_total          (counter, labels channel/outcome)  — EMITTED by the agent (Wave 2)
 *  - acquire_send_slot_delay_seconds (histogram, labels channel)        — EMITTED by the agent (Wave 2)
 *  - webhook_secret_rejections_total (counter, labels reason)           — EMITTED by the HTTP layer
 *
 * These assert the metrics are REGISTERED against the collector with the exact
 * names, kinds, label keys, and (for the histogram) bucket boundaries Wave 2 and
 * the prometheus exposition rely on. A snapshot only lists metrics that have been
 * registered, so we touch each handle once to force a series into the snapshot.
 */
describe('createAgentMetrics — Stage 10 hardening handles', () => {
  it('registers transient_retry_total as a counter with [channel, outcome] labels', () => {
    const collector = new InMemoryMetricsCollector();
    const metrics = createAgentMetrics(collector);
    metrics.transientRetryTotal.inc({ channel: 'whatsapp', outcome: 'scheduled' });
    metrics.transientRetryTotal.inc({ channel: 'whatsapp', outcome: 'exhausted' });

    const snap = collector.snapshot().metrics.find(m => m.name === 'transient_retry_total');
    expect(snap).toBeDefined();
    expect(snap?.kind).toBe('counter');
    expect(snap?.labelKeys).toEqual(['channel', 'outcome']);
    const scheduled = snap?.series.find(
      s => s.labels.channel === 'whatsapp' && s.labels.outcome === 'scheduled'
    );
    expect((scheduled as { value: number }).value).toBe(1);
  });

  it('registers acquire_send_slot_delay_seconds as a histogram with [channel] + default buckets', () => {
    const collector = new InMemoryMetricsCollector();
    const metrics = createAgentMetrics(collector);
    metrics.acquireSendSlotDelaySeconds.observe({ channel: 'instagram' }, 0.42);

    const snap = collector
      .snapshot()
      .metrics.find(m => m.name === 'acquire_send_slot_delay_seconds');
    expect(snap).toBeDefined();
    expect(snap?.kind).toBe('histogram');
    expect(snap?.labelKeys).toEqual(['channel']);
    // Histogram snapshots carry the configured bucket boundaries.
    expect((snap as { buckets: readonly number[] }).buckets).toEqual(
      DEFAULT_LATENCY_BUCKETS_SECONDS
    );
  });

  it('registers webhook_secret_rejections_total as a counter with [reason] labels', () => {
    const collector = new InMemoryMetricsCollector();
    const metrics = createAgentMetrics(collector);
    metrics.webhookSecretRejectionsTotal.inc({ reason: 'mismatch' });
    metrics.webhookSecretRejectionsTotal.inc({ reason: 'missing_signature' });
    metrics.webhookSecretRejectionsTotal.inc({ reason: 'no_raw_body' });

    const snap = collector
      .snapshot()
      .metrics.find(m => m.name === 'webhook_secret_rejections_total');
    expect(snap).toBeDefined();
    expect(snap?.kind).toBe('counter');
    expect(snap?.labelKeys).toEqual(['reason']);
    const reasons = snap?.series.map(s => s.labels.reason).sort();
    expect(reasons).toEqual(['mismatch', 'missing_signature', 'no_raw_body']);
  });

  it('exposes the three new handles on the AgentMetrics object', () => {
    const metrics = createAgentMetrics(new InMemoryMetricsCollector());
    // Wave 2 pulls transientRetryTotal + acquireSendSlotDelaySeconds verbatim.
    expect(typeof metrics.transientRetryTotal.inc).toBe('function');
    expect(typeof metrics.acquireSendSlotDelaySeconds.observe).toBe('function');
    expect(typeof metrics.webhookSecretRejectionsTotal.inc).toBe('function');
  });
});
