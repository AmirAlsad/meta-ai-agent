import type {
  HistogramSeriesSnapshot,
  HistogramSnapshot,
  LabelValues,
  MetricsSnapshot,
  SeriesSnapshot
} from './collector.js';

/** Prometheus text exposition format version 0.0.4 content type. */
export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

export function renderPrometheus(snapshot: MetricsSnapshot): string {
  const lines: string[] = [];
  for (const metric of snapshot.metrics) {
    if (metric.help) {
      lines.push(`# HELP ${metric.name} ${escapeHelp(metric.help)}`);
    }
    lines.push(`# TYPE ${metric.name} ${metric.kind}`);

    if (metric.kind === 'counter' || metric.kind === 'gauge') {
      for (const s of metric.series) {
        lines.push(formatSimple(metric.name, metric.labelKeys, s));
      }
    } else {
      for (const s of metric.series) {
        appendHistogramSeries(lines, metric, s);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

function formatSimple(name: string, labelKeys: readonly string[], s: SeriesSnapshot): string {
  return `${name}${renderLabels(labelKeys, s.labels)} ${formatValue(s.value)}`;
}

function appendHistogramSeries(
  lines: string[],
  metric: HistogramSnapshot,
  s: HistogramSeriesSnapshot
): void {
  let cumulative = 0;
  for (let i = 0; i < metric.buckets.length; i++) {
    cumulative += s.bucketCounts[i] ?? 0;
    const bucketLabels = renderLabels(metric.labelKeys, s.labels, {
      key: 'le',
      value: formatBucketBoundary(metric.buckets[i])
    });
    lines.push(`${metric.name}_bucket${bucketLabels} ${formatValue(cumulative)}`);
  }
  const infLabels = renderLabels(metric.labelKeys, s.labels, { key: 'le', value: '+Inf' });
  lines.push(`${metric.name}_bucket${infLabels} ${formatValue(s.count)}`);
  lines.push(`${metric.name}_sum${renderLabels(metric.labelKeys, s.labels)} ${formatValue(s.sum)}`);
  lines.push(`${metric.name}_count${renderLabels(metric.labelKeys, s.labels)} ${formatValue(s.count)}`);
}

function renderLabels(
  keys: readonly string[],
  values: LabelValues,
  extra?: { key: string; value: string }
): string {
  const parts: string[] = [];
  for (const k of keys) {
    const v = values[k] ?? '';
    parts.push(`${k}="${escapeLabelValue(v)}"`);
  }
  if (extra) {
    parts.push(`${extra.key}="${escapeLabelValue(extra.value)}"`);
  }
  return parts.length === 0 ? '' : `{${parts.join(',')}}`;
}

function escapeLabelValue(v: string): string {
  // Carriage returns are stripped: a literal "\r" inside a label value would
  // otherwise be emitted verbatim and break the line-oriented Prometheus text
  // parser. Backslash must be escaped before quote/newline so the secondary
  // replacements don't double-escape introduced backslashes.
  return v
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

function escapeHelp(v: string): string {
  return v
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

function formatBucketBoundary(b: number): string {
  if (!Number.isFinite(b)) return '+Inf';
  return formatValue(b);
}

function formatValue(v: number): string {
  if (!Number.isFinite(v)) {
    if (v === Number.POSITIVE_INFINITY) return '+Inf';
    if (v === Number.NEGATIVE_INFINITY) return '-Inf';
    return 'NaN';
  }
  // Prometheus accepts plain integer and decimal forms equally, so a single
  // toString() covers both (no separate integer branch needed).
  return v.toString();
}
