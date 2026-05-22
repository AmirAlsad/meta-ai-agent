/**
 * `LimitTracker` — the per-channel outbound pacing + transient-retry +
 * messaging-window classification surface the conversation agent layers on top
 * of a {@link LimitCounterStore}.
 *
 * Four jobs:
 *  1. PACING — `acquireSendSlot` reserves a virtual-clock slot for the line and
 *     sleeps any required delay before the agent sends. It is FAIL-OPEN: a
 *     pacing failure must never block a reply, so any error is logged and
 *     swallowed.
 *  2. ERROR ROUTING — `classifyError` (synchronous send-catch) and
 *     `classifyStatusErrorCode` (the async `failed`-status webhook) bucket a
 *     failure into transient / window_closed / permanent so the agent knows
 *     whether to retry, abandon, or surface a closed-window condition.
 *  3. RETRY MATH — `retryDelayMs` / `transientRetryMaxAttempts` expose the
 *     backoff schedule from config.
 *  4. TRACK-ONLY THROUGHPUT — `recordOutbound` bumps fixed per-hour / per-day
 *     window counters for the line and warn/error-logs as it nears the
 *     configured cap. It NEVER gates a send (advisory only) and is FAIL-OPEN.
 *
 * DOUBLE-SEND SAFETY drives the transient set. The transient set is limited to:
 * network failures (`httpStatus 0`, never reached Meta) and HTTP `429` / Meta
 * rate-limit error codes ({@link META_RATE_LIMIT_ERROR_CODES}) — cases where Meta
 * is KNOWN to have rejected the request before processing it. `5xx` is explicitly
 * EXCLUDED (classified `permanent`): a 5xx after a POST is ambiguous (Meta may have
 * already accepted and delivered), so re-sending risks a double-send, and Meta has
 * NO idempotency key for the messages endpoint. The runtime
 * {@link "../meta/shared/graph-client.js".GraphClient} applies the same rule; this
 * tracker mirrors it (the agent layer has no more information than the GraphClient
 * about whether the POST took effect, so it must not override it). See
 * `classifyError` for the exact code sets.
 */
import type pino from 'pino';
import type { LimitsConfig } from '../config/loader.js';
import { MetaApiError } from '../meta/shared/errors.js';
import type { Channel } from '../meta/types.js';
// Code SETS live in the leaf `error-codes` module so the synchronous
// `classifyError`, the async `classifyStatusErrorCode`, and the display
// `whatsappFailureCategory` mapper all share ONE definition and can never drift.
import { META_RATE_LIMIT_ERROR_CODES, WHATSAPP_WINDOW_ERROR_CODES } from './error-codes.js';
import { transientRetryDelayMs, type ErrorClassification } from './retry.js';
import type { LimitCounterStore } from './store.js';

export type { ErrorClassification } from './retry.js';

export interface LimitTracker {
  /**
   * Pre-send pacing gate. Resolves after any required delay so the caller can
   * send immediately afterward. FAIL-OPEN — never throws.
   */
  acquireSendSlot(channel: Channel, businessId: string): Promise<void>;
  /**
   * Classify a send error → `transient` (retry) | `window_closed` (WhatsApp
   * 24h re-engagement) | `permanent` (abandon).
   */
  classifyError(channel: Channel, error: unknown): ErrorClassification;
  /**
   * Classify a WhatsApp ASYNC `failed`-status webhook by its bare numeric
   * `errorCode` (status callbacks carry no `httpStatus`, so this can only key on
   * the code). Same three-way bucketing as {@link classifyError}, so the agent's
   * future async-failure path routes a `failed` status identically to a
   * synchronous send-catch. See the impl for the double-send rationale.
   */
  classifyStatusErrorCode(channel: Channel, errorCode: number | undefined): ErrorClassification;
  /**
   * TRACK-ONLY (never gating) per-hour / per-day outbound counter bump. Bumps the
   * fixed hour/day windows for the `${channel}:${businessId}` line and warn/error
   * logs as the line nears its configured cap, giving operators advance notice
   * before Meta starts server-side rejecting at the messaging-tier cap. FAIL-OPEN
   * — a counter failure must NEVER affect delivery, so it never throws.
   */
  recordOutbound(channel: Channel, businessId: string): Promise<void>;
  /** Backoff delay (ms) for a 1-based transient-retry attempt. */
  retryDelayMs(attempt: number): number;
  /** Max transient retries AFTER the first send. */
  transientRetryMaxAttempts(): number;
  /** Release any owned resources. Optional. */
  close?(): Promise<void>;
}

export interface LimitTrackerDeps {
  store: LimitCounterStore;
  config: LimitsConfig;
  logger: pino.Logger;
  /** Override the sleep impl (defaults to `setTimeout`) for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Override the clock (ms) for tests. */
  now?: () => number;
  /** Override the jitter RNG for tests. */
  random?: () => number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>(resolve => {
    if (ms <= 0) resolve();
    else setTimeout(resolve, ms);
  });
}

function perSecondForChannel(config: LimitsConfig, channel: Channel): number {
  switch (channel) {
    case 'whatsapp':
      return config.whatsappPerSecond;
    case 'messenger':
      return config.messengerPerSecond;
    case 'instagram':
      return config.instagramPerSecond;
    default:
      // Exhaustive over Channel today; an unknown channel is unpaced.
      return 0;
  }
}

function perHourForChannel(config: LimitsConfig, channel: Channel): number {
  switch (channel) {
    case 'whatsapp':
      return config.whatsappPerHour;
    case 'messenger':
      return config.messengerPerHour;
    case 'instagram':
      return config.instagramPerHour;
    default:
      // Unknown channel → 0 = window disabled (no logging).
      return 0;
  }
}

function perDayForChannel(config: LimitsConfig, channel: Channel): number {
  switch (channel) {
    case 'whatsapp':
      return config.whatsappPerDay;
    case 'messenger':
      return config.messengerPerDay;
    case 'instagram':
      return config.instagramPerDay;
    default:
      return 0;
  }
}

/**
 * Warn-then-error threshold logging for ONE fixed window (hour or day).
 *
 * TRACK-ONLY: this NEVER gates a send — it only surfaces pressure. A cap of
 * `<= 0` disables the window entirely (no logging). We log at the EXACT crossing
 * (`count === floor(cap * 0.8)` warn, `count === cap` error) rather than `>=` so
 * a steady stream over the cap emits ONE warn + ONE error per window, not a log
 * line on every send past the threshold. A metric could be wired here later;
 * the limits layer is deliberately decoupled from the metrics registry, so
 * log-only is the deliverable for this pass.
 */
function logWindowThreshold(
  logger: pino.Logger,
  channel: Channel,
  businessId: string,
  window: 'hour' | 'day',
  count: number,
  cap: number
): void {
  if (cap <= 0) return;
  const warnAt = Math.floor(cap * 0.8);
  if (count === warnAt) {
    logger.warn(
      { channel, businessId, window, count, cap },
      `outbound ${window} count reached 80% of the configured cap (track-only — sends are not gated)`
    );
  }
  if (count === cap) {
    logger.error(
      { channel, businessId, window, count, cap },
      `outbound ${window} count reached the configured cap (track-only — sends are not gated; Meta may begin server-side rejecting)`
    );
  }
}

export function createLimitTracker(deps: LimitTrackerDeps): LimitTracker {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const random = deps.random ?? Math.random;

  return {
    async acquireSendSlot(channel: Channel, businessId: string): Promise<void> {
      // FAIL-OPEN: a pacing failure (store throws, Redis down, etc.) must never
      // block a reply. Log and proceed as if the slot were free.
      try {
        const perSecond = perSecondForChannel(deps.config, channel);
        const line = `${channel}:${businessId}`;
        const delay = await deps.store.acquireOutboundSlot(line, now(), perSecond);
        if (delay > 0) await sleep(delay);
      } catch (err) {
        deps.logger.warn(
          { err, channel },
          'limit-tracker acquireSendSlot failed; proceeding without pacing (fail-open)'
        );
      }
    },

    classifyError(channel: Channel, error: unknown): ErrorClassification {
      if (error instanceof MetaApiError) {
        // WhatsApp out-of-window re-engagement: a plain re-send won't recover.
        if (
          channel === 'whatsapp' &&
          error.errorCode !== undefined &&
          WHATSAPP_WINDOW_ERROR_CODES.has(error.errorCode)
        ) {
          return 'window_closed';
        }
        // SAFE-TO-RE-SEND transient set ONLY. Every send is a POST, and Meta has
        // NO idempotency mechanism for the messages endpoint (biz_opaque_callback_data
        // is a tracking string echoed in webhooks, NOT a server-side dedup key), so
        // we may re-send ONLY when Meta is known NOT to have processed the request:
        //   - httpStatus 0  : pre-response network failure — never reached Meta
        //                     (or we never learned it did); GraphClient itself
        //                     treats this as retry-safe.
        //   - httpStatus 429: rate limited — rejected before processing.
        //   - rate-limit error CODE on a 4xx: same, rejected before processing.
        // DELIBERATELY EXCLUDES 5xx: a 5xx AFTER a send is ambiguous — Meta may have
        // already accepted and delivered the message, so re-sending could DOUBLE-SEND.
        // This mirrors the load-bearing GraphClient rule ("Outbound POST 5xx is NOT
        // retried — double-send safety"); the agent layer has no more information than
        // the GraphClient about whether the POST took effect, so it must not override it.
        if (
          error.httpStatus === 0 ||
          error.httpStatus === 429 ||
          (error.errorCode !== undefined && META_RATE_LIMIT_ERROR_CODES.has(error.errorCode))
        ) {
          return 'transient';
        }
        // Everything else — 5xx (double-send risk), deterministic 4xx (bad request,
        // auth), unknown codes — is not safe to blindly re-send. Skip + advance.
        return 'permanent';
      }
      // A non-MetaApiError reaching the send catch is NOT a known-safe transport
      // failure (GraphClient wraps every pre-response transport error into a
      // MetaApiError with httpStatus 0). An opaque error here could have surfaced
      // AFTER Meta accepted the POST, so re-sending risks a double-send — classify
      // it `permanent` (skip + advance) rather than retry.
      return 'permanent';
    },

    classifyStatusErrorCode(channel: Channel, errorCode: number | undefined): ErrorClassification {
      // WHY a `failed` status has NO double-send risk: a `failed` delivery-status
      // webhook means Meta explicitly did NOT deliver the message, so a retry
      // cannot double-send (unlike a synchronous 5xx, which is ambiguous about
      // whether the POST took effect). We could therefore retry more aggressively
      // here — but we KEEP THE SET NARROW AND SEMANTIC anyway, mirroring
      // `classifyError`: a window-closed condition still needs a template
      // re-prompt (not a plain re-send), and only rate-limit codes are worth a
      // backoff retry. Everything else (policy throttles, recipient problems,
      // auth, unsupported, server, AND `undefined`) is `permanent` — a blind
      // re-send would just fail again.
      if (
        channel === 'whatsapp' &&
        errorCode !== undefined &&
        WHATSAPP_WINDOW_ERROR_CODES.has(errorCode)
      ) {
        return 'window_closed';
      }
      if (errorCode !== undefined && META_RATE_LIMIT_ERROR_CODES.has(errorCode)) {
        return 'transient';
      }
      return 'permanent';
    },

    async recordOutbound(channel: Channel, businessId: string): Promise<void> {
      // FAIL-OPEN: track-only counters must NEVER affect delivery. A store/Redis
      // failure here is logged and swallowed — the send already happened.
      try {
        const line = `${channel}:${businessId}`;
        const { hourCount, dayCount } = await deps.store.incrementWindowCounters(line, now());
        logWindowThreshold(
          deps.logger,
          channel,
          businessId,
          'hour',
          hourCount,
          perHourForChannel(deps.config, channel)
        );
        logWindowThreshold(
          deps.logger,
          channel,
          businessId,
          'day',
          dayCount,
          perDayForChannel(deps.config, channel)
        );
      } catch (err) {
        deps.logger.warn(
          { err, channel },
          'limit-tracker recordOutbound failed; window counters skipped (fail-open)'
        );
      }
    },

    retryDelayMs(attempt: number): number {
      return transientRetryDelayMs(
        attempt,
        deps.config.transientRetryBaseMs,
        deps.config.transientRetryMaxMs,
        random
      );
    },

    transientRetryMaxAttempts(): number {
      return deps.config.transientRetryMaxAttempts;
    },

    async close(): Promise<void> {
      await deps.store.close?.();
    }
  };
}
