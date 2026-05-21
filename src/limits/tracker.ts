/**
 * `LimitTracker` — the per-channel outbound pacing + transient-retry +
 * messaging-window classification surface the conversation agent layers on top
 * of a {@link LimitCounterStore}.
 *
 * Three jobs:
 *  1. PACING — `acquireSendSlot` reserves a virtual-clock slot for the line and
 *     sleeps any required delay before the agent sends. It is FAIL-OPEN: a
 *     pacing failure must never block a reply, so any error is logged and
 *     swallowed.
 *  2. ERROR ROUTING — `classifyError` buckets a send error into
 *     transient / window_closed / permanent so the agent knows whether to
 *     retry, abandon, or surface a closed-window condition.
 *  3. RETRY MATH — `retryDelayMs` / `transientRetryMaxAttempts` expose the
 *     backoff schedule from config.
 *
 * The transient set mirrors the runtime {@link "../meta/shared/graph-client.js".GraphClient}
 * (429 + network `httpStatus 0` always retryable, 5xx ambiguous-but-retried at
 * this layer). The GraphClient declines to retry a 5xx POST itself to avoid
 * double-sends; this tracker classifies 5xx as transient so the AGENT can make
 * the bounded-retry decision with full conversation context.
 */
import type pino from 'pino';
import type { LimitsConfig } from '../config/loader.js';
import { MetaApiError } from '../meta/shared/errors.js';
import type { Channel } from '../meta/types.js';
import { transientRetryDelayMs, type ErrorClassification } from './retry.js';
import type { LimitCounterStore } from './store.js';

export type { ErrorClassification } from './retry.js';

/**
 * WhatsApp re-engagement / out-of-window error codes. When a send fails with
 * one of these on the `whatsapp` channel, the 24h customer-service window has
 * lapsed and only a pre-approved template can re-engage — a plain text re-send
 * will keep failing, so it is classified `window_closed` (NOT transient).
 *   - 131047 "Re-engagement message" — the live Cloud API send-call error for
 *     "more than 24h since the user last replied". This is the one that fires.
 *   - 470    legacy/On-Premises + message-status webhook "failed: >24h since the
 *     customer last replied". Kept as belt-and-suspenders for status-path/legacy
 *     surfaces; harmless on Cloud API where 131047 is authoritative.
 * NOTE: 131051 is "Unsupported message type" (a malformed-payload bug), NOT a
 * window condition — deliberately EXCLUDED so it falls through to `permanent`
 * (a template re-prompt would not fix it and would keep failing). Verified
 * against Meta's WhatsApp Cloud API error-code reference.
 */
const WHATSAPP_WINDOW_ERROR_CODES = new Set<number>([131047, 470]);

/**
 * Meta/WhatsApp RATE-LIMIT error codes that are safe to retry: Meta rejected the
 * request BEFORE processing it (so a re-send cannot double-deliver — unlike a
 * 5xx, which is ambiguous; see {@link LimitTracker.classifyError}). These surface
 * as a 4xx with a specific error CODE, NOT as HTTP 429, so they must be matched
 * by code, not status. Verified against Meta's rate-limiting + WhatsApp error
 * references:
 *   - 4      "Application request limit reached" (app-level Graph throttle)
 *   - 80007  "Rate limit issues" (WABA reached its rate limit)
 *   - 130429 "Rate limit hit" (Cloud API throughput)
 *   - 131056 "(Business, Consumer) pair rate limit hit"
 *   - 613    "Calls to this API have exceeded the rate limit"
 * Policy/quality throttles (131048 "Spam rate limit", 131049, 368) are NOT here —
 * they are permanent; retrying won't recover and can worsen account standing.
 */
const META_RATE_LIMIT_ERROR_CODES = new Set<number>([4, 80007, 130429, 131056, 613]);

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
