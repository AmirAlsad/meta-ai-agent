import { describe, expect, it } from 'vitest';
import { InMemoryMetricsCollector, NoopMetricsCollector } from '../../src/metrics/collector.js';
import { PROMETHEUS_CONTENT_TYPE, renderPrometheus } from '../../src/metrics/prometheus.js';
import { createAgentMetrics, normalizeErrorCodeLabel } from '../../src/metrics/registry.js';

describe('renderPrometheus', () => {
  it('emits HELP and TYPE lines per metric', () => {
    const c = new InMemoryMetricsCollector();
    const counter = c.counter('foo_total', { help: 'count of foos', labels: ['kind'] });
    counter.inc({ kind: 'a' });

    const out = renderPrometheus(c.snapshot());
    expect(out).toContain('# HELP foo_total count of foos');
    expect(out).toContain('# TYPE foo_total counter');
    expect(out).toContain('foo_total{kind="a"} 1');
  });

  it('renders gauges with labels', () => {
    const c = new InMemoryMetricsCollector();
    const g = c.gauge('temp', { help: 'temperature', labels: ['region'] });
    g.set({ region: 'us' }, 73);

    const out = renderPrometheus(c.snapshot());
    expect(out).toContain('# TYPE temp gauge');
    expect(out).toContain('temp{region="us"} 73');
  });

  it('renders histograms with cumulative bucket counts and sum/count', () => {
    const c = new InMemoryMetricsCollector();
    const h = c.histogram('latency_seconds', { buckets: [0.1, 0.5, 1] });
    h.observe(undefined, 0.05); // bucket 0
    h.observe(undefined, 0.2); // bucket 1
    h.observe(undefined, 0.6); // bucket 2
    h.observe(undefined, 2); // overflow (counts only)

    const out = renderPrometheus(c.snapshot());
    expect(out).toContain('# TYPE latency_seconds histogram');
    // cumulative bucket counts:
    expect(out).toContain('latency_seconds_bucket{le="0.1"} 1');
    expect(out).toContain('latency_seconds_bucket{le="0.5"} 2');
    expect(out).toContain('latency_seconds_bucket{le="1"} 3');
    expect(out).toContain('latency_seconds_bucket{le="+Inf"} 4');
    expect(out).toContain('latency_seconds_count 4');
    expect(out).toMatch(/latency_seconds_sum 2\.85/);
  });

  it('renders an exact text block for a counter, gauge, and labeled histogram', () => {
    const c = new InMemoryMetricsCollector();
    c.counter('requests_total', { help: 'total requests', labels: ['code'] }).inc({ code: '200' }, 5);
    c.gauge('up', { help: 'liveness' }).set(undefined, 1);
    const h = c.histogram('dur_seconds', {
      help: 'durations',
      labels: ['op'],
      buckets: [0.1, 1]
    });
    h.observe({ op: 'send' }, 0.05); // bucket 0
    h.observe({ op: 'send' }, 0.5); // bucket 1
    h.observe({ op: 'send' }, 3); // overflow

    const out = renderPrometheus(c.snapshot());
    const expected = [
      '# HELP requests_total total requests',
      '# TYPE requests_total counter',
      'requests_total{code="200"} 5',
      '',
      '# HELP up liveness',
      '# TYPE up gauge',
      'up 1',
      '',
      '# HELP dur_seconds durations',
      '# TYPE dur_seconds histogram',
      'dur_seconds_bucket{op="send",le="0.1"} 1',
      'dur_seconds_bucket{op="send",le="1"} 2',
      'dur_seconds_bucket{op="send",le="+Inf"} 3',
      'dur_seconds_sum{op="send"} 3.55',
      'dur_seconds_count{op="send"} 3',
      ''
    ].join('\n');
    expect(out).toBe(expected);
  });

  it('escapes label values per exposition format', () => {
    const c = new InMemoryMetricsCollector();
    const counter = c.counter('foo_total', { labels: ['msg'] });
    counter.inc({ msg: 'a"b\\c\nd' });

    const out = renderPrometheus(c.snapshot());
    expect(out).toContain('foo_total{msg="a\\"b\\\\c\\nd"} 1');
  });

  it('escapes carriage returns in label values and help text', () => {
    const c = new InMemoryMetricsCollector();
    const counter = c.counter('with_help', {
      help: 'a help text\rwith carriage return',
      labels: ['v']
    });
    counter.inc({ v: 'value\rwith\rCR' });

    const out = renderPrometheus(c.snapshot());
    // No raw \r should leak into the rendered output — that would split the
    // line and corrupt the Prometheus text exposition format.
    expect(out).not.toMatch(/\r/);
    expect(out).toContain('# HELP with_help a help text\\rwith carriage return');
    expect(out).toContain('with_help{v="value\\rwith\\rCR"} 1');
  });

  it('renders nothing for an empty snapshot', () => {
    expect(renderPrometheus(new NoopMetricsCollector().snapshot())).toBe('');
  });

  it('emits a defined content-type constant', () => {
    expect(PROMETHEUS_CONTENT_TYPE).toMatch(/text\/plain/);
    expect(PROMETHEUS_CONTENT_TYPE).toMatch(/version=0\.0\.4/);
  });
});

describe('createAgentMetrics', () => {
  it('registers all named handles against the collector', () => {
    const c = new InMemoryMetricsCollector();
    const m = createAgentMetrics(c);

    // Every declared handle is present and usable.
    expect(typeof m.webhookReceived.inc).toBe('function');
    expect(typeof m.webhookParseFailures.inc).toBe('function');
    expect(typeof m.inboundDedupe.inc).toBe('function');
    expect(typeof m.inboundMessages.inc).toBe('function');
    expect(typeof m.chatDispatchDuration.observe).toBe('function');
    expect(typeof m.outboundSendTotal.inc).toBe('function');
    expect(typeof m.outboundSendDuration.observe).toBe('function');
    expect(typeof m.statusCallbackTotal.inc).toBe('function');
    expect(typeof m.deliveryTimeoutFired.inc).toBe('function');
    expect(typeof m.identityLookupTotal.inc).toBe('function');
    expect(typeof m.bufferFlushTotal.inc).toBe('function');
    expect(typeof m.agentUp.set).toBe('function');
    expect(typeof m.agentBuildInfo.set).toBe('function');

    // The expected named series show up in the snapshot once written to.
    m.webhookReceived.inc({ channel: 'whatsapp', result: 'accepted' });
    m.outboundSendTotal.inc({
      channel: 'messenger',
      operation: 'sendText',
      result: 'ok',
      error_code: 'none'
    });
    m.agentUp.set(undefined, 1);

    const names = new Set(c.snapshot().metrics.map(metric => metric.name));
    expect(names).toContain('webhook_received_total');
    expect(names).toContain('webhook_parse_failures_total');
    expect(names).toContain('inbound_dedupe_total');
    expect(names).toContain('inbound_messages_total');
    expect(names).toContain('chat_dispatch_duration_seconds');
    expect(names).toContain('outbound_send_total');
    expect(names).toContain('outbound_send_duration_seconds');
    expect(names).toContain('status_callback_total');
    expect(names).toContain('delivery_timeout_fired_total');
    expect(names).toContain('identity_lookup_total');
    expect(names).toContain('buffer_flush_total');
    expect(names).toContain('agent_up');
    expect(names).toContain('agent_build_info');
  });

  it('declares the documented label keys (sorted) on key metrics', () => {
    const c = new InMemoryMetricsCollector();
    createAgentMetrics(c);
    const byName = new Map(c.snapshot().metrics.map(metric => [metric.name, metric]));
    expect(byName.get('webhook_received_total')?.labelKeys).toEqual(['channel', 'result']);
    expect(byName.get('outbound_send_total')?.labelKeys).toEqual([
      'channel',
      'error_code',
      'operation',
      'result'
    ]);
    expect(byName.get('delivery_timeout_fired_total')?.labelKeys).toEqual([]);
  });
});

describe('normalizeErrorCodeLabel', () => {
  it('passes through known Meta error codes (numeric and string)', () => {
    expect(normalizeErrorCodeLabel(100)).toBe('100');
    expect(normalizeErrorCodeLabel('131047')).toBe('131047');
    expect(normalizeErrorCodeLabel(190)).toBe('190');
  });

  it('bounds unknown codes to "other"', () => {
    expect(normalizeErrorCodeLabel(999999)).toBe('other');
    expect(normalizeErrorCodeLabel('not-a-real-code')).toBe('other');
  });

  it('maps a missing/empty code to "none"', () => {
    expect(normalizeErrorCodeLabel(undefined)).toBe('none');
    expect(normalizeErrorCodeLabel('')).toBe('none');
  });
});
