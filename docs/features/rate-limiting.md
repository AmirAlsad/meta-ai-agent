# Rate limiting, transient retry, and window enforcement

Stage 10 adds the `LimitTracker` — the per-channel outbound layer the conversation
agent leans on for: **pre-send pacing** (stay under Meta's per-channel rate),
**transient-retry routing** (re-send a send that failed for a known-safe reason,
with backoff — on BOTH the synchronous send-catch path and the asynchronous
WhatsApp `failed`-delivery-status path), **WhatsApp out-of-window handling**
(re-prompt the chat endpoint for a template when the 24h customer-service window has
closed), and **track-only per-hour / per-day throughput counters** (advisory
warn/error logging as a line nears its configured cap — never gating a send). A
boot-time `recoverPendingRetries` re-arms retries that were in flight across a
restart.

The single most load-bearing decision in this subsystem is the error
classification: which send failures are safe to re-send. Because every send is a POST
and Meta has **no idempotency key** for the messages endpoint, re-sending a request
Meta might already have processed risks a double-send. The classifier is conservative
by design — it mirrors the `GraphClient`'s existing "5xx-on-POST is not retried"
rule.

Source: [`src/limits/tracker.ts`](../../src/limits/tracker.ts) (`LimitTracker`,
`createLimitTracker`, `classifyError`, `classifyStatusErrorCode`, `recordOutbound`),
[`src/limits/error-codes.ts`](../../src/limits/error-codes.ts) (the shared
WhatsApp/Meta error-code sets + `whatsappFailureCategory`),
[`src/limits/store.ts`](../../src/limits/store.ts) (`LimitCounterStore`,
`InMemoryLimitCounterStore`, `incrementWindowCounters`),
[`src/limits/redis-store.ts`](../../src/limits/redis-store.ts)
(`RedisLimitCounterStore`),
[`src/limits/retry.ts`](../../src/limits/retry.ts) (`transientRetryDelayMs`,
`ErrorClassification`),
[`src/conversation/agent.ts`](../../src/conversation/agent.ts) (`sendNext` pacing +
`recordOutbound`, `scheduleTransientRetry` / `armTransientRetryTimer` /
`runTransientRetryImpl`, `handleWindowClosed`, the async-`failed`-status routing in
`handleStatusImpl`, `recoverPendingRetries`).

Cross-links: [Ordered delivery](./ordered-delivery.md),
[Outbound clients](./outbound-clients.md),
[Conversation state](./conversation-state.md),
[Persistence](./persistence.md).

## What it does

- **Pacing.** Before every outbound *message* send, the agent reserves a virtual-clock
  token-bucket slot for the conversation's `{channel}:{businessId}` line and sleeps
  any required delay, so a fast-draining queue stays under the per-channel rate.
- **Transient retry.** A send that fails for a known-safe reason (network failure,
  429, or a Meta rate-limit error code) is re-sent with exponential backoff up to a
  cap; the queue item is held in place, not skipped.
- **WhatsApp out-of-window re-prompt.** A WhatsApp send that fails with the 24h
  re-engagement error re-prompts the chat endpoint *once* per turn with
  `requiresTemplate: true`, then sends whatever it returns (ideally a template).
- **Async `failed`-status routing.** A WhatsApp `failed` *delivery-status* webhook
  for the in-flight item is classified by `classifyStatusErrorCode` and routed to
  retry / re-prompt / skip — the same three-way bucketing as a synchronous send
  catch, but driven by the bare `errorCode`. See [Ordered delivery → async
  failure](./ordered-delivery.md#async-failure-from-a-failed-delivery-status) for
  the agent-side flow and the inverted double-send rule.
- **Track-only per-hour / per-day counters.** After each successful outbound,
  `recordOutbound` bumps fixed hour/day window counters for the line and warn/error
  logs as it nears the configured cap — advisory only, never gating a send.
- **Boot recovery.** Transient retries persisted before a restart are re-armed at
  boot — but only against a durable (Redis) store.

It is always wired (the tracker is fail-open on a pacing error, so it is safe in both
the in-memory and Redis paths). Without it (a bare Stage-5 agent), every send error
is treated as `permanent` — the original skip-and-advance behavior.

## Pre-send pacing

`sendNext` calls `limitTracker.acquireSendSlot(channel, businessId)` before every item
that makes a real Graph API send — `message`, `reply`, `template`, `media`, AND
`reaction`. A reaction is a Graph call too (it counts toward Meta's per-channel rate),
so a reaction-heavy turn left unpaced could contribute to app-level 429s; it is paced
like any other send. Pacing is deliberately NOT applied to `typing` (a best-effort UX
side-effect, already spaced by its own pre-message delay — pacing it would only push
back the real message) or `silence` (no send).

`acquireSendSlot` reserves a slot on a **virtual-clock token bucket** keyed by the
`{channel}:{businessId}` line (the smallest unit Meta rate-limits independently — each
WhatsApp phone number id, each Page, each IG user) and resolves after any required
delay. The bucket math (`intervalMs = 1000 / perSecond`; next slot =
`max(now, lastSlot + intervalMs)`) spreads a burst of N back-to-back sends `intervalMs`
apart, while a long idle gap does NOT accumulate burst credit (the `max(now, …)` clamp
resets the clock to "now").

The slot reservation must be **atomic across replicas**, which is why there are two
counter-store implementations:

- `InMemoryLimitCounterStore` — a per-process `Map<line, lastSlotMs>`. With N replicas
  the line is paced at roughly N/intervalMs (each replica keeps its own clock), so it
  overshoots Meta's rate. Fine for tests, local runs, and single-replica deploys.
- `RedisLimitCounterStore` — a Lua script (`EVAL`) does the read-modify-write of the
  slot atomically server-side, so N replicas share one virtual clock per line. A naive
  GET-compute-SET port has the same race in disguise (two replicas both read the same
  `lastSlot`, both compute the same next slot); the Lua atomicity is load-bearing — do
  not split it into separate GET/SET round-trips. Idle slot keys carry a PX TTL so they
  self-expire. The injected client is borrowed (no-op `close()`); the runtime owns the
  lifecycle (see [Persistence](./persistence.md#shared-client-lifecycle-borrowed-not-owned)).

**Per-channel defaults:** WhatsApp 80/s, Messenger 40/s, Instagram 10/s — all
configurable; `0` disables pacing for that channel (and never touches the store).
These sit well under Meta's documented per-channel send caps (WhatsApp default
throughput 80 mps, upgradable to 1000; Messenger 300/s for text; Instagram 100/s
text and 10/s media). The Instagram default of `10/s` matches the IG media cap and
the `InstagramClient`'s own ~10/s in-process pacer floor so the two layers stay
aligned — `2/s` (the *general* Graph API baseline, not the messaging limit) would
over-throttle. WhatsApp tier-based daily caps (250/1K/10K/100K/unlimited
business-initiated conversations) are NOT enforced client-side: Meta tracks and
rejects those server-side, and the rejection rides the normal `classifyError` →
skip/permanent path.

**Fail-open (load-bearing):** `acquireSendSlot` never throws. A store failure
(Redis down, etc.) is logged and the send proceeds as if the slot were free — a
pacing problem must never block a reply. The pacing sleep runs UNDER the per-key lock,
which delays only that one conversation (the lock is per-key), exactly like the typing
delay.

> Note: the Instagram client retains its own coarse ~100ms in-process pacer
> ([`src/meta/instagram/client.ts`](../../src/meta/instagram/client.ts)) in *addition*
> to the `LimitTracker`. Both are conservative floors; an IG line is effectively
> double-paced. See [Known gaps](../KNOWN-GAPS.md).

## Track-only per-hour / per-day counters

Separate from the per-second pacing, the tracker keeps **advisory** per-hour and
per-day outbound counters per `{channel}:{businessId}` line. After each successful
outbound the agent calls `limitTracker.recordOutbound(channel, businessId)`, which
bumps the line's fixed hour/day window counters via
`LimitCounterStore.incrementWindowCounters` (in-memory, or a Redis Lua `INCR` +
`PEXPIRE` on hour/day buckets) and logs as the count crosses a threshold:

- **warn** at exactly 80% of the configured cap (`count === floor(cap * 0.8)`),
- **error** at exactly the cap (`count === cap`).

The exact-crossing match (`===`, not `>=`) means a steady stream over the cap emits
ONE warn + ONE error per window, not a log line on every send past the threshold.

This is **track-only — it NEVER gates a send.** It exists so an operator gets advance
notice before Meta starts server-side rejecting at the messaging-tier cap, not to
enforce a limit locally. It is **fail-open**: a counter-store failure is logged and
swallowed (the send already happened). A cap of `0` disables that window entirely
(no counting, no logging).

> **No Prometheus metric is emitted for a threshold crossing.** The limits layer is
> deliberately decoupled from the metrics registry, so a crossing surfaces in warn/
> error LOGS only — there is no `*_total` counter for it. Wiring a metric here is
> deferred (see [Known gaps](../KNOWN-GAPS.md)).

**Defaults (Meta-aware, deliberately conservative):** WhatsApp `1000/h`, `10000/d`;
Messenger and Instagram `0/0` (disabled). WhatsApp's real caps are
conversation-based (tiered: 1K/10K/100K/unlimited unique recipients in 24h after
business verification) rather than a flat message count, so a single per-hour/per-day
MESSAGE count is only an advisory proxy — the defaults give an unverified or Tier-1
number an early warning. Messenger/Instagram have no comparable published per-day
MESSAGE cap (their constraint is the 24h window + per-second throughput), so they
default to disabled; set them only for a custom advisory ceiling. `loadConfig`
enforces `perHour <= perDay` per channel **when both are > 0** (an hourly cap above
the daily cap is always a misconfiguration). This is NOT the same as a true gating
cap with WhatsApp conversation-unit accounting, which is still deferred.

## Transient retry

On a send error, `sendNext` calls `limitTracker.classifyError(channel, error)` and
routes by the verdict. The classification is the load-bearing part.

### The classification table (double-send safety)

`classifyError` ([`src/limits/tracker.ts`](../../src/limits/tracker.ts)) returns one of
three verdicts:

| Verdict | What triggers it | Agent action |
| --- | --- | --- |
| `transient` | `MetaApiError` with `httpStatus === 0` (pre-response network failure — never reached Meta), OR `httpStatus === 429`, OR a Meta rate-limit error **code** in `{4, 80007, 130429, 131056, 613}` (Meta returns these as a 4xx-with-code, not HTTP 429) | retry with backoff up to the cap, then skip+advance |
| `window_closed` | `whatsapp` channel + error **code** `131047` ("Re-engagement message" — the live Cloud API 24h-window error) or `470` (legacy/status-path) | re-prompt the chat endpoint once for a template (see below) |
| `permanent` | everything else: any **5xx**, deterministic 4xx (bad request, auth), unknown codes, AND any non-`MetaApiError` (opaque) error | skip the item, advance the queue (Stage-5 fail-soft) |

The **transient set is intentionally narrow.** It is ONLY the failures where Meta is
known NOT to have processed the request, so a re-send cannot double-deliver:

- **5xx is `permanent`, not transient.** A 5xx *after* a POST is ambiguous — Meta may
  have already accepted and delivered the message. With no idempotency key
  (`biz_opaque_callback_data` is a tracking string echoed in webhooks, not a
  server-side dedupe key), re-sending could double-send. This mirrors the load-bearing
  GraphClient rule ("Outbound POST 5xx is NOT retried — double-send safety"); the agent
  layer has no more information than the GraphClient about whether the POST took effect,
  so it must not override it. See [Outbound clients → retry/backoff
  matrix](./outbound-clients.md#retry--backoff-matrix).
- **A non-`MetaApiError` is `permanent`.** The GraphClient wraps every pre-response
  transport error into a `MetaApiError` with `httpStatus 0`, so an opaque error reaching
  the send catch is not a known-safe transport failure and could have surfaced *after*
  Meta accepted the POST.
- **Policy/quality throttles are NOT transient.** WhatsApp codes `131048` ("Spam rate
  limit"), `131049`, and `368` are deliberately excluded — they are permanent; retrying
  won't recover and can worsen account standing.
- **`131051` is NOT a window code.** It is "Unsupported message type" (a
  malformed-payload bug), deliberately excluded from the window set so it falls through
  to `permanent` — a template re-prompt would not fix it and would keep failing.

The code sets (`WHATSAPP_WINDOW_ERROR_CODES`, `META_RATE_LIMIT_ERROR_CODES`, and the
display-only policy/recipient/auth/server groups) live in one leaf module,
[`src/limits/error-codes.ts`](../../src/limits/error-codes.ts), so `classifyError`,
`classifyStatusErrorCode`, and the `whatsappFailureCategory` display mapper (see
[Status tracking](./status-tracking.md)) all share ONE definition and can never
disagree about, say, whether `131047` is a window error.

> **`131056` is transient but a 72-hour window — a documented tradeoff.** It is the
> "(Business, Consumer) pair rate limit" and is classified `transient`, so it
> retries. But it is a 72-HOUR moving per-recipient window, so retries are bounded
> by `transientRetryMaxAttempts()` yet will exhaust uselessly against it (SAFE — no
> double-send — but wasteful). It is kept in the transient set for consistency with
> the rest of the rate-limit codes; see [Known gaps](../KNOWN-GAPS.md).

### The async `failed`-status classifier

`classifyStatusErrorCode(channel, errorCode)` is the async sibling of
`classifyError`, used by the WhatsApp `failed`-delivery-status path. A status
callback carries no `httpStatus`, so this can only key on the bare numeric
`errorCode`: WhatsApp window codes → `window_closed`, a Meta rate-limit code →
`transient`, everything else (including `undefined`) → `permanent`. It deliberately
keeps the **same narrow, semantic set** as `classifyError` even though a `failed`
status has **no** double-send risk (it could safely retry more aggressively — see
[Ordered delivery → the inverted double-send
rule](./ordered-delivery.md#the-double-send-safety-rule-is-inverted-on-this-path-load-bearing))
— because a window-closed condition still needs a template re-prompt (not a plain
re-send) and a blind re-send of a policy/recipient/auth failure would just fail
again.

### The retry loop

When `classifyError` returns `transient`, `sendNext` computes the next attempt
(`(item.retryCount ?? 0) + 1`) and, if it is within `transientRetryMaxAttempts`, calls
`scheduleTransientRetry`:

1. `scheduleTransientRetry` stamps the in-flight item with `retryCount = attempt` and
   `nextRetryAt = now + delay`, persists the record (so a restart can recover it), and
   arms a backoff timer via `armTransientRetryTimer`. It does NOT advance the cursor —
   the turn stays `sending` on the same item.
2. The backoff delay comes from `transientRetryDelayMs`
   ([`src/limits/retry.ts`](../../src/limits/retry.ts)): exponential
   (`base × 2^(attempt-1)`, capped at `transientRetryMaxMs`) with multiplicative ±20%
   jitter to avoid a thundering herd at a 429 boundary.
3. The timer is a true entry point (it fires outside any held lock), so it ACQUIRES the
   per-key lock and runs the lock-free `runTransientRetryImpl`, which **re-validates**
   that the world hasn't moved on (the turn is still `sending`, the in-flight item is
   the SAME one by id, and its `retryCount` matches what was armed). If any of those
   changed (an interrupt/advance happened), the timer is STALE and does nothing.
   Otherwise it re-sends via `sendNext` — which on success advances and on another
   transient failure may reschedule, up to the cap.
4. When retries are exhausted (`attempt > transientRetryMaxAttempts`), `sendNext` falls
   through to `markSkippedAndAdvance` — the item is skipped and the queue advances, so
   one persistently-failing send never wedges the rest.

The stale-guard (item id + `retryCount` + `state === 'sending'`) is what keeps a
lingering timer from re-sending the wrong item after an interrupt/rebatch rolled the
turn back (see [Conversation state → segmented
locking](./conversation-state.md#segmented-locking-the-batching-fix)).

## WhatsApp out-of-window re-prompt

When `classifyError` returns `window_closed`, `sendNext` calls `handleWindowClosed`
([`src/conversation/agent.ts`](../../src/conversation/agent.ts)). The 24h
customer-service window has lapsed, so a plain text re-send would just fail again — only
a pre-approved template can re-engage. The flow, fail-soft throughout:

1. Guard: only on `whatsapp`, and only ONCE per turn (the `record.windowReprompted`
   flag). A second `window_closed` after already re-prompting just skips, so it never
   loops.
2. Recover the original `ChatRequest` from the in-memory `pendingRequests` map (stashed
   at flush time, keyed by conversation, cleared at every turn-end). If it's gone (e.g.
   lost on restart), skip+advance.
3. Set `windowReprompted = true`, then re-prompt the chat endpoint with the original
   request plus `context: { …, windowOpen: false, requiresTemplate: true }` — signalling
   the endpoint to reply with a template. (This one chat call runs *under* the held
   per-key lock — it is a rare bounded edge path; the chat client has its own timeout.)
4. If the endpoint returns silence / no deliverable actions, finalize the turn.
   Otherwise REPLACE the outbound queue with the re-prompt's items (the failed item is
   dropped), reset the cursor, and re-drive `sendNext` — ideally now sending a template.

Any unexpected error in this path ends in `markSkippedAndAdvance` so the queue can
still make progress. This is the enforcement side of the previously-tracked-but-not-
enforced 24h window (the Stage 5/7 gap): the window is still surfaced to every chat
request as `context.windowOpen`, but now a closed-window send actively re-prompts for a
template rather than silently failing. See [Conversation state → 24-hour messaging
window](./conversation-state.md#24-hour-messaging-window).

## Boot recovery

`ConversationAgent.recoverPendingRetries()` is called fire-and-forget in `buildRuntime`
at startup (logged, never awaited — a recovery failure must not block the listener). It
scans `store.listConversationKeys()` and, for any conversation in state `sending` whose
in-flight item carries `nextRetryAt` and `retryCount > 0`, re-arms the transient-retry
timer with the *remaining* delay (`max(0, nextRetryAt - now)`, so an overdue retry fires
promptly). Each per-key scan runs under `runExclusive` and is fail-soft so one bad
record can't sink recovery. It returns `{ transientRetriesResumed }`.

**Multi-replica double-send guard (load-bearing).** On a shared Redis, EVERY replica
runs `recoverPendingRetries()` at boot (a rolling redeploy restarts them near-simultaneously),
and the per-process `runExclusive` lock is NOT distributed — so without a guard each
replica would re-arm and re-send the SAME overdue item (an N-replica double-send, since
Meta has no idempotency key). Before re-arming, recovery makes an atomic
`store.claimRecovery(claimToken, ttl)` call (`claimToken = {key}:{itemId}:{retryCount}`):
the `RedisConversationStore` implements it as `SET NX EX` so exactly ONE replica wins and
re-arms; the rest skip. The token is attempt-unique, so a *later* restart with a new retry
attempt claims a fresh key. The in-memory store is single-process and always wins. The
claim TTL is deliberately SHORT — sized to the remaining retry delay plus a grace period
(min 120 s), NOT the 24 h conversation lifetime — so that if the *winning* replica crashes
before its retry fires, the claim expires quickly and a subsequent restart can re-recover,
rather than the conversation staying wedged in `sending` for the full TTL.

**WhatsApp first-send crashes are recovered too.** A WhatsApp (`on_status`) `sending`
item that was SENT but whose in-memory delivery-timeout fallback died with the process
(no `retryCount`/`nextRetryAt` yet — the "first-send crash") would otherwise sit in
`sending` until the next inbound. Recovery re-arms that delivery timeout (claim-guarded);
when it fires, `onDeliveryTimeoutImpl` ADVANCES past the already-sent item (it does NOT
re-send it — no double-send) and drives the rest of the queue. Messenger/Instagram
(`on_send`) have no per-message timer, and re-driving their queue could double-send (no
idempotency), so such a first-send crash there self-heals on the next inbound via
`interruptSending` instead — see [Known gaps](../KNOWN-GAPS.md).

**Stranded `processing` conversations are un-wedged too.** A conversation whose chat
call was in flight when the process died sits in Redis as `state: 'processing'`. Nothing
would ever flush it again (`handleInbound`'s `processing` branch only stashes to
`lateArrivals` and aborts a now-absent controller), so without recovery it would WEDGE
until its TTL. Recovery (claim-guarded, so one replica acts) folds any persisted
`lateArrivals` back into the buffer and reschedules a flush, or — if there are none —
resets the record to `idle` so the next inbound starts fresh. The recovery is claim-guarded
with a token carrying a per-turn `processingNonce` (stamped on the record when it enters
`processing`), so concurrent recoveries of the SAME crash dedupe to one replica while a
LATER processing turn (new nonce) is never blocked by a stale claim. It returns
`{ transientRetriesResumed, processingReset }`. **Inherent limitation:** the original
in-flight batch (snapshotted into a local var in `flushImpl` segment 1, never persisted)
is lost on a hard crash mid-chat-call — an at-least-once tradeoff of the
snapshot-clears-buffer design; see [Known gaps](../KNOWN-GAPS.md).

**It does real work only against a durable (Redis) store.** The in-memory store wipes
all state on restart, so `listConversationKeys()` yields nothing and the call returns
all-zero counts. Recovery covers transient retries + stranded `processing` records — not
in-flight window re-prompts (the `pendingRequests` map is in-memory and lost on restart)
and not buffer-flush timers (those are durable in their own right via the BullMQ
scheduler — see [Persistence](./persistence.md#the-bullmq-buffer-scheduler)).

## Configuration

`config.limits` ([`src/config/loader.ts`](../../src/config/loader.ts)). Pacing values
are non-negative (`0` disables); the retry knobs are positive ints with a
`base <= max` cross-field check.

| Env var | Default | Used for |
| --- | --- | --- |
| `WHATSAPP_RATE_LIMIT_PER_SECOND` | `80` | WhatsApp outbound pacing (msgs/sec; `0` disables). |
| `MESSENGER_RATE_LIMIT_PER_SECOND` | `40` | Messenger outbound pacing. |
| `INSTAGRAM_RATE_LIMIT_PER_SECOND` | `10` | Instagram outbound pacing (`10` matches the IG media cap + the client's in-process floor; `2/s` is the general Graph baseline, not the messaging limit). |
| `WHATSAPP_RATE_LIMIT_PER_HOUR` | `1000` | Track-only WhatsApp per-hour MESSAGE-count cap (advisory warn/error logging; `0` disables). |
| `WHATSAPP_RATE_LIMIT_PER_DAY` | `10000` | Track-only WhatsApp per-day MESSAGE-count cap (advisory; `0` disables; per-hour must be `<=` per-day when both `> 0`). |
| `MESSENGER_RATE_LIMIT_PER_HOUR` | `0` | Track-only Messenger per-hour cap (disabled by default). |
| `MESSENGER_RATE_LIMIT_PER_DAY` | `0` | Track-only Messenger per-day cap (disabled by default). |
| `INSTAGRAM_RATE_LIMIT_PER_HOUR` | `0` | Track-only Instagram per-hour cap (disabled by default). |
| `INSTAGRAM_RATE_LIMIT_PER_DAY` | `0` | Track-only Instagram per-day cap (disabled by default). |
| `TRANSIENT_RETRY_MAX_ATTEMPTS` | `3` | Max transient-retry attempts after the first send. |
| `TRANSIENT_RETRY_BASE_MS` | `1000` | Base backoff for transient retry (must be `<=` max). |
| `TRANSIENT_RETRY_MAX_MS` | `60000` | Max backoff for transient retry (must be `>=` base). |

The per-hour/per-day values are non-negative ints (`0` disables that window); the
per-second values are non-negative floats (`0` disables pacing); the retry knobs are
positive ints with the `base <= max` cross-field check.

The Redis path for the counter store is selected on `REDIS_URL` — see
[Persistence](./persistence.md).

## Testing

- `tests/unit/limits-store.test.ts` — `InMemoryLimitCounterStore` token-bucket math
  (first-call-free, burst spread at `intervalMs`, no idle burst credit, `perSecond <= 0`
  short-circuit).
- `tests/unit/limits-retry.test.ts` — `transientRetryDelayMs` backoff schedule, the cap,
  the ±20% jitter bounds, and `attempt < 1 → 0`.
- `tests/unit/limits-tracker.test.ts` — `classifyError` over the full code matrix
  (network/429/rate-limit-codes → transient; 5xx/non-Meta → permanent; WhatsApp
  131047/470 → window_closed; the 131051 / policy-throttle exclusions), the fail-open
  pacing path, and the retry-delay/max-attempts passthrough.
- `tests/integration/limits-redis-store.test.ts` — `RedisLimitCounterStore`'s Lua-atomic
  slot reservation against a real Redis (gated on `TEST_REDIS_URL`).
- The agent's pacing call, classification-driven routing, transient-retry loop,
  window re-prompt, and `recoverPendingRetries` are covered in
  `tests/unit/conversation-agent.test.ts`.

Redis tests skip without `TEST_REDIS_URL`; see [Persistence →
testing](./persistence.md#testing) and [Testing](../TESTING.md).

## Known limitations

- **Gating is per-second only.** The per-hour/per-day counters are **track-only**
  (warn/error logging) — there is no true GATING cap, and no WhatsApp
  conversation-unit accounting (the per-message count is an advisory proxy for
  WhatsApp's conversation-based tiers). A true gating cap is still deferred. See
  [Known gaps](../KNOWN-GAPS.md).
- **No metric for a threshold crossing.** A per-hour/per-day crossing is log-only;
  no Prometheus counter is emitted for it.
- The Instagram client's own ~100ms in-process pacer still runs alongside the
  `LimitTracker` (double-paced; both conservative).
- Window enforcement is WhatsApp-only — Messenger/Instagram have no reliable
  out-of-window mechanism for an automated bot, so there is nothing to enforce.
- Boot recovery covers transient retries only (against a durable store) — not in-flight
  window re-prompts.
- `131056` is retried (transient) even though it is a 72-hour per-recipient window,
  so its retries exhaust uselessly (safe but wasteful — see above).

See [Known gaps](../KNOWN-GAPS.md) for the full deferral list and
[Architecture](../ARCHITECTURE.md) for where this layer sits in the runtime.
