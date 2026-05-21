/**
 * Transient-retry backoff math and the error-classification enum shared by the
 * {@link "./tracker.js".LimitTracker}.
 */

/**
 * Three-way classification of a send error for retry routing. The exact code
 * sets live in {@link "./tracker.js".LimitTracker.classifyError} (authoritative):
 *  - `transient` — SAFE-to-re-send only: a pre-response network failure
 *    (httpStatus 0), HTTP 429, or a Meta rate-limit error CODE. The caller retries
 *    with exponential backoff up to `transientRetryMaxAttempts`. NOTE: 5xx is NOT
 *    transient — a 5xx after a POST may have already delivered and Meta has no
 *    idempotency key, so re-sending could double-send (double-send safety).
 *  - `permanent` — a deterministic 4xx, a 5xx (double-send risk), or a generic
 *    non-Meta error. Retrying changes nothing / is unsafe; the caller drops the
 *    send and advances the queue.
 *  - `window_closed` — the WhatsApp 24h customer-service window has lapsed and
 *    only a template can re-engage. Not retryable as a plain re-send.
 */
export type ErrorClassification = 'transient' | 'permanent' | 'window_closed';

/**
 * Exponential backoff with full ±20% jitter.
 *
 * Schedule (baseMs=1000, maxMs=60000, no jitter):
 *   attempt 1 → 1s,  attempt 2 → 2s,  attempt 3 → 4s,  attempt 4 → 8s … capped at 60s.
 *
 * Jitter is multiplicative in `[0.8, 1.2)` to avoid a thundering herd when many
 * conversations hit a 429 boundary at once. `attempt` is 1-based; `attempt < 1`
 * returns 0. The jittered result is re-clamped to `maxMs`.
 */
export function transientRetryDelayMs(
  attempt: number,
  baseMs: number,
  maxMs: number,
  random: () => number = Math.random
): number {
  if (attempt < 1) return 0;
  const raw = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  const jitter = 0.8 + random() * 0.4;
  return Math.min(maxMs, Math.round(raw * jitter));
}
