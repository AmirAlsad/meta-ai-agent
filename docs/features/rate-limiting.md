# Rate limiting, transient retry, and window enforcement

Stage 10 adds the `LimitTracker` — the per-channel outbound layer the conversation
agent leans on for three things: **pre-send pacing** (stay under Meta's per-channel
rate), **transient-retry routing** (re-send a send that failed for a known-safe
reason, with backoff), and **WhatsApp out-of-window handling** (re-prompt the chat
endpoint for a template when the 24h customer-service window has closed). A boot-time
`recoverPendingRetries` re-arms retries that were in flight across a restart.

The single most load-bearing decision in this subsystem is the error
classification: which send failures are safe to re-send. Because every send is a POST
and Meta has **no idempotency key** for the messages endpoint, re-sending a request
Meta might already have processed risks a double-send. The classifier is conservative
by design — it mirrors the `GraphClient`'s existing "5xx-on-POST is not retried"
rule.

Source: [`src/limits/tracker.ts`](../../src/limits/tracker.ts) (`LimitTracker`,
`createLimitTracker`, `classifyError`),
[`src/limits/store.ts`](../../src/limits/store.ts) (`LimitCounterStore`,
`InMemoryLimitCounterStore`),
[`src/limits/redis-store.ts`](../../src/limits/redis-store.ts)
(`RedisLimitCounterStore`),
[`src/limits/retry.ts`](../../src/limits/retry.ts) (`transientRetryDelayMs`,
`ErrorClassification`),
[`src/conversation/agent.ts`](../../src/conversation/agent.ts) (`sendNext` pacing,
`scheduleTransientRetry` / `armTransientRetryTimer` / `runTransientRetryImpl`,
`handleWindowClosed`, `recoverPendingRetries`).

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
- **Boot recovery.** Transient retries persisted before a restart are re-armed at
  boot — but only against a durable (Redis) store.

It is always wired (the tracker is fail-open on a pacing error, so it is safe in both
the in-memory and Redis paths). Without it (a bare Stage-5 agent), every send error
is treated as `permanent` — the original skip-and-advance behavior.

## Pre-send pacing

`sendNext` calls `limitTracker.acquireSendSlot(channel, businessId)` before every
outbound-MESSAGE send — that is `message`, `reply`, `template`, and `media`. It is
deliberately NOT applied to `reaction` / `typing` (fire-and-forget side effects, not
user-facing messages — pacing them would only delay the queue).

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

**Per-channel defaults:** WhatsApp 80/s, Messenger 40/s, Instagram 2/s — all
configurable; `0` disables pacing for that channel (and never touches the store).

**Fail-open (load-bearing):** `acquireSendSlot` never throws. A store failure
(Redis down, etc.) is logged and the send proceeds as if the slot were free — a
pacing problem must never block a reply. The pacing sleep runs UNDER the per-key lock,
which delays only that one conversation (the lock is per-key), exactly like the typing
delay.

> Note: the Instagram client retains its own coarse ~100ms in-process pacer
> ([`src/meta/instagram/client.ts`](../../src/meta/instagram/client.ts)) in *addition*
> to the `LimitTracker`. Both are conservative floors; an IG line is effectively
> double-paced. See [Known gaps](../KNOWN-GAPS.md).

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

**It does real work only against a durable (Redis) store.** The in-memory store wipes
all state on restart, so `listConversationKeys()` yields nothing and the call returns
`{ transientRetriesResumed: 0 }`. Recovery covers transient retries only — not in-flight
window re-prompts (the `pendingRequests` map is in-memory and lost on restart) and not
buffer-flush timers (those are durable in their own right via the BullMQ scheduler — see
[Persistence](./persistence.md#the-bullmq-buffer-scheduler)).

## Configuration

`config.limits` ([`src/config/loader.ts`](../../src/config/loader.ts)). Pacing values
are non-negative (`0` disables); the retry knobs are positive ints with a
`base <= max` cross-field check.

| Env var | Default | Used for |
| --- | --- | --- |
| `WHATSAPP_RATE_LIMIT_PER_SECOND` | `80` | WhatsApp outbound pacing (msgs/sec; `0` disables). |
| `MESSENGER_RATE_LIMIT_PER_SECOND` | `40` | Messenger outbound pacing. |
| `INSTAGRAM_RATE_LIMIT_PER_SECOND` | `2` | Instagram outbound pacing. |
| `TRANSIENT_RETRY_MAX_ATTEMPTS` | `3` | Max transient-retry attempts after the first send. |
| `TRANSIENT_RETRY_BASE_MS` | `1000` | Base backoff for transient retry (must be `<=` max). |
| `TRANSIENT_RETRY_MAX_MS` | `60000` | Max backoff for transient retry (must be `>=` base). |

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

- Pacing is **per-second only.** There are no per-hour / per-day hard caps — Meta's
  daily tier limits (and the IG hourly throughput model) are tracked by Meta, not
  enforced here. See [Known gaps](../KNOWN-GAPS.md).
- The Instagram client's own ~100ms in-process pacer still runs alongside the
  `LimitTracker` (double-paced; both conservative).
- Window enforcement is WhatsApp-only — Messenger/Instagram have no reliable
  out-of-window mechanism for an automated bot, so there is nothing to enforce.
- Boot recovery covers transient retries only (against a durable store) — not in-flight
  window re-prompts.

See [Known gaps](../KNOWN-GAPS.md) for the full deferral list and
[Architecture](../ARCHITECTURE.md) for where this layer sits in the runtime.
