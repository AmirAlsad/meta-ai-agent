/**
 * Single source of truth for the WhatsApp / Meta Cloud API error-code sets and
 * the human-readable failure-category mapper.
 *
 * WHY a dedicated leaf module: the same code numbers drive THREE consumers —
 * {@link "./tracker.js".LimitTracker.classifyError} (synchronous send-catch
 * routing), {@link "./tracker.js".LimitTracker.classifyStatusErrorCode} (the
 * ASYNC `failed`-status webhook path), and {@link whatsappFailureCategory} (the
 * `/admin/status` + failure-dashboard display bucket). Duplicating the literal
 * code numbers across files would let them drift; centralizing them here means
 * the classifier and the category mapper can never disagree about, say, whether
 * 131047 is a window error. This module has NO imports of its own (leaf), so it
 * is safe for both the limits and status layers to depend on it.
 *
 * Codes are verified against Meta's WhatsApp Cloud API + Graph API error-code
 * references. Comments justify each membership decision; do not add a code
 * without a documented rationale.
 */

/**
 * WhatsApp re-engagement / out-of-window error codes. A send (or a `failed`
 * status) carrying one of these on the `whatsapp` channel means the 24h
 * customer-service window has lapsed and only a pre-approved template can
 * re-engage — a plain text re-send keeps failing, so it is classified
 * `window_closed` rather than retried.
 *   - 131047 "Re-engagement message" — the live Cloud API error for
 *     "more than 24h since the user last replied". This is the one that fires.
 *   - 470    legacy/On-Premises + message-status webhook "failed: >24h since the
 *     customer last replied". Kept as belt-and-suspenders for the status-path /
 *     legacy surfaces; harmless on Cloud API where 131047 is authoritative.
 * NOTE: 131051 ("Unsupported message type") is a malformed-payload bug, NOT a
 * window condition — deliberately EXCLUDED so it falls through to `permanent`
 * (a template re-prompt would not fix it and would keep failing).
 */
export const WHATSAPP_WINDOW_ERROR_CODES = new Set<number>([131047, 470]);

/**
 * Meta/WhatsApp RATE-LIMIT error codes that are safe to retry: Meta rejected the
 * request BEFORE processing it (so a re-send cannot double-deliver — unlike a
 * 5xx, which is ambiguous; see {@link "./tracker.js".LimitTracker.classifyError}).
 * These surface as a 4xx with a specific error CODE, NOT as HTTP 429, so they
 * must be matched by code, not status. Verified against Meta's rate-limiting +
 * WhatsApp error references:
 *   - 4      "Application request limit reached" (app-level Graph throttle)
 *   - 80007  "Rate limit issues" (WABA reached its rate limit)
 *   - 130429 "Rate limit hit" (Cloud API throughput)
 *   - 131056 "(Business, Consumer) pair rate limit hit"
 *   - 613    "Calls to this API have exceeded the rate limit"
 * Policy/quality throttles (131048 "Spam rate limit", 131049, 368) are NOT here —
 * they are permanent; retrying won't recover and can worsen account standing.
 */
export const META_RATE_LIMIT_ERROR_CODES = new Set<number>([4, 80007, 130429, 131056, 613]);

/**
 * Human-readable failure bucket for a WhatsApp Cloud API error code, surfaced
 * on `GET /admin/status/:id` and failure dashboards so an operator sees a
 * category instead of a bare int. Bounded enum (NOT free text), so it is safe
 * to surface unmasked in the PII-redacted admin output.
 */
export type FailureCategory =
  | 'rate_limit'
  | 'window_closed'
  | 'policy'
  | 'unsupported'
  | 'recipient'
  | 'auth'
  | 'server'
  | 'unknown';

/**
 * Policy / spam / quality throttles. Distinct from `rate_limit`: these are NOT
 * safe to retry (they reflect account standing, not a transient throughput cap)
 * and are classified `permanent` by the tracker. Surfaced as `policy` so an
 * operator can tell "we're being throttled for quality" apart from a plain rate
 * limit.
 *   - 131048 "Spam rate limit hit"
 *   - 131049 "Meta chose not to deliver to maintain healthy ecosystem engagement"
 *   - 368    "Temporarily blocked for policies violations"
 */
const WHATSAPP_POLICY_ERROR_CODES = new Set<number>([131048, 131049, 368]);

/**
 * Recipient-side problems: the message could not be delivered because of who /
 * what the recipient is, not because of our request shape or rate.
 *   - 131026 "Message undeliverable" (recipient cannot receive — e.g. not on
 *     WhatsApp, an incompatible version, or a recipient-side block)
 *   - 131030 "Recipient phone number not in allowed list" (dev/test number gating)
 *   - 131045 "Misconfigured phone number / registration error for the recipient"
 */
const WHATSAPP_RECIPIENT_ERROR_CODES = new Set<number>([131026, 131030, 131045]);

/**
 * Token / permission / authorization failures — a misconfigured or expired
 * access token, or a missing capability. These are operator-actionable (rotate
 * the token / grant the scope), so they get their own bucket.
 *   - 190 "Access token has expired / is invalid"
 *   - 10  "Permission denied / application does not have permission for this action"
 *   - 200 "Permissions error" (missing a required permission/scope)
 */
const WHATSAPP_AUTH_ERROR_CODES = new Set<number>([190, 10, 200]);

/**
 * "Unsupported message type" — a malformed-payload / capability bug on OUR side,
 * not a window or rate condition. Bucketed separately from validation so an
 * operator can spot "the bot is emitting a message shape WhatsApp won't accept".
 *   - 131051 "Unsupported message type"
 */
const WHATSAPP_UNSUPPORTED_ERROR_CODES = new Set<number>([131051]);

/**
 * Generic Cloud API / Graph server-side failures: an internal error on Meta's
 * side rather than a problem with our request. Distinct from `unknown` so a
 * transient platform outage is visible as such.
 *   - 131000 "Something went wrong" (generic Cloud API failure)
 *   - 1      "An unknown error occurred" (generic Graph API server error)
 *   - 2      "Service temporarily unavailable"
 */
const WHATSAPP_SERVER_ERROR_CODES = new Set<number>([131000, 1, 2]);

/**
 * Map a WhatsApp Cloud API error code to a display {@link FailureCategory}.
 *
 * The window and rate-limit sets are imported (not re-listed) so this mapper can
 * never drift from the retry classifier — they are the SAME constants. The
 * remaining buckets (policy / recipient / auth / unsupported / server) are
 * display-only and have no retry semantics, so they live here. `undefined` and
 * any unrecognized code → `unknown` (we never throw — Meta can emit codes the
 * package does not yet enumerate, and a display bucket must tolerate that).
 */
export function whatsappFailureCategory(errorCode: number | undefined): FailureCategory {
  if (errorCode === undefined) return 'unknown';
  // Order is not significant — the code sets are disjoint by construction — but
  // window/rate-limit come first because they are the shared, retry-relevant
  // buckets and the most common in practice.
  if (WHATSAPP_WINDOW_ERROR_CODES.has(errorCode)) return 'window_closed';
  if (META_RATE_LIMIT_ERROR_CODES.has(errorCode)) return 'rate_limit';
  if (WHATSAPP_POLICY_ERROR_CODES.has(errorCode)) return 'policy';
  if (WHATSAPP_UNSUPPORTED_ERROR_CODES.has(errorCode)) return 'unsupported';
  if (WHATSAPP_RECIPIENT_ERROR_CODES.has(errorCode)) return 'recipient';
  if (WHATSAPP_AUTH_ERROR_CODES.has(errorCode)) return 'auth';
  if (WHATSAPP_SERVER_ERROR_CODES.has(errorCode)) return 'server';
  return 'unknown';
}
