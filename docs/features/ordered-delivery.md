# Ordered delivery

When the chat endpoint returns several actions for one turn — say a reaction, then
a reply, then a follow-up message — they must reach the user in order. The
delivery layer turns the normalized chat actions into an ordered queue and sends
one item at a time, advancing only when the current item is confirmed. How
"confirmed" is defined is **channel-aware**, because the three Meta channels give
different delivery signals.

Source: [`src/delivery/queue.ts`](../../src/delivery/queue.ts) (pure queue logic),
[`src/delivery/types.ts`](../../src/delivery/types.ts) (shapes incl. `retryCount` /
`asyncFailRetryCount`), and the `sendNext` / `handleStatus` / `handleStatusImpl`
(async-`failed` routing) / delivery-timeout machinery in
[`src/conversation/agent.ts`](../../src/conversation/agent.ts), with error
classification in [`src/limits/tracker.ts`](../../src/limits/tracker.ts)
(`classifyStatusErrorCode`). For the surrounding state machine see
[Conversation state](./conversation-state.md); for how actions become items see
[Rich chat actions](./rich-chat-actions.md).

## Queue and cursor

The queue is just `OutboundItem[]` plus an integer cursor
(`QueueState = { items, currentIndex }`). The pure helpers in
[`src/delivery/queue.ts`](../../src/delivery/queue.ts) are side-effect-free — no
I/O, no timers, no adapter calls — which keeps them trivially testable; the agent
owns all the effects:

- `currentItem(state)` — the item at the cursor, or `undefined` past the end.
- `isQueueComplete(state)` — `currentIndex >= items.length`.
- `advanceCursor(state)` — returns a new state with `currentIndex + 1` (the
  `items` array is reused, not mutated).

On the record, the queue is `outboundQueue` and the cursor is
`currentOutboundIndex`. `flushImpl` attaches the queue and sets
`currentOutboundIndex = 0`, then calls `sendNext`, which drives the loop: send the
item at the cursor, then either advance immediately or wait for a status, and
recurse to the next item after each advance. When `isQueueComplete` is true,
`sendNext` calls `finalizeTurn`, which returns the conversation to `idle` — or, if
messages arrived during the turn (`lateArrivals`), spawns a follow-up `buffering`
turn instead of going idle (see [Completing the queue](#completing-the-queue)).

## Advancement mode per channel

`advancementMode(channel)`
([`src/delivery/queue.ts`](../../src/delivery/queue.ts)) decides when the queue
advances past a message-bearing item:

| Channel | Advancement mode | Advances on |
| --- | --- | --- |
| WhatsApp | `on_status` | A `sent` or `delivered` status webhook (`handleStatus`), with a delivery-timeout fallback |
| Messenger | `on_send` | A successful send API response (`sendNext`) |
| Instagram | `on_send` | A successful send API response (`sendNext`) |

**Why the split.** WhatsApp emits per-message `statuses[]` (sent / delivered /
read), so its queue can wait for a delivery/sent status callback before advancing
— giving true ordered delivery confirmed by Meta. Messenger and Instagram have no
reliable per-message delivery webhook, so the only confirmation available is the
successful send API response; their queue must advance as soon as the send
returns. (Instagram has no echo-webhook field at all; outbound tracking relies on
the Send API response — see [Known gaps](../KNOWN-GAPS.md).)

`statusAdvancesQueue(channel, status)` encodes the WhatsApp rule: only `sent` /
`delivered` advance. `read` is post-delivery (the queue already moved on) and
`failed` does not advance the queue here — instead a `failed` status for the
in-flight item is routed into async retry / window re-prompt / skip (see
[Async failure from a `failed` delivery status](#async-failure-from-a-failed-delivery-status)).
For `on_send` channels it always returns false — the queue already advanced at
send time, so a watermark-derived status must never double-advance it.

## Reaction and typing always advance on send

Regardless of channel, `reaction` and `typing` items are fire-and-forget: no
channel — not even WhatsApp — emits a delivery status for them, so waiting
`on_status` would wedge the queue. `sendNext` treats them as
`fireAndForget = item.kind === 'reaction' || item.kind === 'typing'` and advances
immediately after the send. Items that return no send result at all (a skipped
template, or a media/silence item that should never appear) also advance
immediately rather than wait.

## Outbound-handle mapping for status correlation

A WhatsApp status webhook carries only the channel message id — it has no idea
which conversation or queue slot it belongs to. So after a successful send,
`sendNext` records the mapping via
`store.mapOutboundHandle(messageId, { conversationKey, messageIndex, traceId? })`
([`src/conversation/types.ts`](../../src/conversation/types.ts) defines
`OutboundHandleMapping`). When a status arrives, `handleStatus` looks the id up,
resolves the conversation key, takes that key's lock, and advances only if the
status both advances the queue for the channel AND refers to the currently
in-flight index (`record.currentOutboundIndex === mapping.messageIndex`). A stale
status (the queue already moved past that index) is ignored. The mapping is
deleted in `advanceAndContinue` once the queue moves past it, so it doesn't
linger.

## Delivery-timeout fallback

If a WhatsApp `sent`/`delivered` status is dropped or delayed, the queue would sit
in `sending` forever. To prevent that, after a WhatsApp send `sendNext` arms a
fallback timer via `startDeliveryTimeout(key, messageIndex, ...)`. If no advancing
status arrives within `OUTBOUND_DELIVERY_TIMEOUT_MS` (default 30000) while the
cursor is still on that index, `onDeliveryTimeoutImpl` advances anyway.

Two guards make the fallback safe from double-advancing:

- **Clear-before-arm.** `startDeliveryTimeout` cancels any prior timer for the key
  before arming the new one, so there is only ever one outstanding delivery timer
  per conversation — a previous item's timer can't survive and fire against a
  later index.
- **Index guard.** `onDeliveryTimeoutImpl` only acts if
  `record.currentOutboundIndex === messageIndex`, i.e. the queue is still waiting
  on the same item. If a status (or another path) already advanced the cursor, the
  timer is stale and does nothing.

The timer fires outside any held lock, so it is a true entry point: it acquires
the per-key lock before running its body, serializing against
`handleStatus`/`sendNext`/`handleInbound`. With the lock the race is fully closed;
the guards stay as defense-in-depth. The regression test `handleStatus concurrent
with an in-flight send does not double-advance (exactly-once)` in
[`tests/unit/conversation-agent.test.ts`](../../tests/unit/conversation-agent.test.ts)
covers this.

## Async failure from a `failed` delivery status

This is the headline behaviour of the limits wave. On WhatsApp the real
rate-limit / closed-window failures usually surface **asynchronously** — the
synchronous send POST returns `200`/queued, and Meta later emits a `failed`
delivery-status webhook carrying `status.errorCode`. Before this wave a `failed`
status fell through to the "stale or non-advancing" debug log and was effectively
ignored, so those failures were never retried and never triggered a template
re-prompt. Now `handleStatusImpl` routes a `failed` status for the
**currently in-flight item** (`record.currentOutboundIndex === mapping.messageIndex`)
through `LimitTracker.classifyStatusErrorCode(channel, status.errorCode)`:

| Classification | Action |
| --- | --- |
| `window_closed` (WhatsApp `131047` / `470`) | one template re-prompt via `handleWindowClosed` (see [Rate limiting → WhatsApp out-of-window re-prompt](./rate-limiting.md#whatsapp-out-of-window-re-prompt)) |
| `transient` (a Meta rate-limit code) | backoff retry via `scheduleTransientRetry`, bounded by `asyncFailRetryCount` |
| `permanent` (or retries exhausted) | `skipReason`/`skippedAt` stamped, then `advanceAndContinue` skips + advances |

A `failed` status for a **non-current** (already-advanced) item is a stale
failure for a slot the queue has long since moved past — it stays a no-op (the
existing debug log), so the queue is never re-processed or double-advanced. (The
status is still recorded in history regardless, observable on
`GET /admin/status/:messageId` — see [Status tracking](./status-tracking.md).)

### The double-send-safety rule is INVERTED on this path (load-bearing)

The synchronous-send rule — "a 5xx after a POST may have already delivered, so do
NOT retry" (`classifyError` treats 5xx as `permanent`; see [Rate limiting →
classification](./rate-limiting.md#the-classification-table-double-send-safety))
— does **not** apply to a `failed` *delivery status*. A `failed` status is Meta's
**definitive statement that the message did NOT reach the user**, so retrying a
transient-classified async failure is **safe** (no double-send). This is the exact
opposite of the sync 5xx rule, and it is intentional. **Do not "fix" it back** to
skip-on-failed by analogy with the synchronous path — the two situations are not
the same. (The classifier `classifyStatusErrorCode` still keeps the retryable set
narrow and semantic anyway: a window-closed condition needs a template re-prompt,
not a plain re-send, and only rate-limit codes are worth a backoff retry;
everything else is `permanent`.)

### `asyncFailRetryCount` bounds the async loop (separate from `retryCount`)

The async retry path counts attempts on a **dedicated** `asyncFailRetryCount`
field on `OutboundItem`, separate from the synchronous `retryCount`. The reason is
load-bearing: the async path fires only **after a send SUCCEEDED** (then failed via
the status webhook), and `sendNext`'s success tail **deletes** `item.retryCount`
for double-send safety. So `retryCount` is always absent on this path and would
reset the attempt to 1 on every cycle — a re-send that keeps async-failing (e.g. a
recurring `130429` rate-limit) would loop **forever**, never tripping the cap. The
success tail does NOT clear `asyncFailRetryCount`, so it survives success→async-fail
cycles and the `transientRetryMaxAttempts()` cap actually trips. (The synchronous
transient path is unaffected: there the send THROWS and never reaches the
`retryCount`-clearing tail, so its `retryCount` accumulates correctly.)

### Dead-handle reset before a transient re-send

The in-flight item carries the `channelMessageId`/`sentAt` of the **failed** send
— a dead handle, since the message never reached the user. The failed path:

- clears the WhatsApp delivery-timeout fallback up front (it was armed by the
  earlier successful send and must not double-fire and advance the queue out from
  under the retry/re-prompt);
- before a transient re-send, clears `item.channelMessageId` / `item.sentAt` /
  `record.currentOutboundMessageId` and deletes the dead id's outbound-handle
  mapping. This lets `sendNext` re-send the cursor item cleanly, and makes the
  boot-recovery "pending transient retry" guard (which re-arms only for an item
  with `channelMessageId === undefined`) recognize it as pending rather than
  treating the dead handle as a successful send.

Throughout, this path is fail-soft: any unexpected error ends in skip + advance so
the queue keeps moving.

## Typing injection before text

When `OUTBOUND_TYPING_INDICATORS_ENABLED` is true and the adapter
`supports('typing_indicator')`, `sendNext` sends a typing indicator before a
`message` or `reply` item, then sleeps a short delay (derived from
`TYPING_REFRESH_INTERVAL_MS`, capped low so a long interval can't stall the send)
before the actual send. WhatsApp's typing indicator is anchored to an inbound
`wamid` (typing is coupled with mark-read), so it uses `record.lastInboundMessageId`
— the stored id of the most recent inbound (see
[Conversation state](./conversation-state.md#the-conversationrecord)). Typing
injection is best-effort: a failure here is logged and never aborts the real send.

## Interrupting an in-flight send

A message can arrive while the conversation is still draining a previous turn's
outbound queue (state `sending`). Continuing to send the rest of a now-stale reply
and then sending a second reply produces an incoherent exchange, so
`handleInboundImpl`'s `sending` branch calls `interruptSending` to roll the turn
back and rebatch ([`src/conversation/agent.ts`](../../src/conversation/agent.ts)).
Under the per-key lock it:

- clears the delivery-timeout fallback for the key (the abandoned queue's timer
  must not fire against a stale index);
- deletes the in-flight outbound-handle mapping (`currentOutboundMessageId`), so a
  late status for the abandoned item can't advance the new turn;
- resets the outbound queue and cursor (`outboundQueue = []`,
  `currentOutboundIndex = 0`, clears `currentOutboundMessageId`) — **unsent queue
  items are dropped**; the chat endpoint re-decides the whole reply from the
  combined buffer on the next flush;
- resets `reprocessCount`, folds any stashed `lateArrivals` plus the new message
  into `inboundBuffer` (preserving order), returns to `buffering`, and arms a fresh
  flush.

This is a full interrupt rather than a deferral because once we are `sending` the
old turn's chat call has already returned — there is no in-flight chat to abort,
and continuing to drain the queue would only deliver stale replies. (The
`processing`-state interrupt, where there *is* an in-flight chat to abort and
rebatch, is covered in [Message buffering](./message-buffering.md) and
[Conversation state](./conversation-state.md#segmented-locking-the-batching-fix).)

## Completing the queue

When `isQueueComplete(state)` is true, `sendNext` calls `finalizeTurn` — which
replaced the old inline transition-to-idle. `finalizeTurn` clears the delivery
timeout, resets `reprocessCount` to 0, and then either returns the conversation to
`idle`, or — if messages arrived during the turn (`lateArrivals`, e.g. during a
committed flush that couldn't be interrupted) — moves them into `inboundBuffer`,
drops back to `buffering`, and schedules a follow-up flush so they get their own
response. See
[Conversation state](./conversation-state.md#the-state-machine) for the full
transition table.

## Fail-soft sends

A send that throws (`MetaApiError` or anything else) does not wedge the queue. When
a `LimitTracker` is wired (Stage 10), `sendNext` first classifies the error: a
known-safe transient failure (network / 429 / Meta rate-limit code) is retried with
exponential backoff up to a cap (the item stays in place), a WhatsApp closed-window
failure re-prompts the chat endpoint once for a template, and everything else (any
5xx — double-send safety — deterministic 4xx, or an exhausted retry) falls through
to `markSkippedAndAdvance`, which stamps `skippedAt`/`skipReason` on the item and
advances past it. Without a tracker every error is `permanent` (the original
skip-and-advance). One bad send never blocks the rest of the queue. See
[Rate limiting](./rate-limiting.md). The capability filtering that decides which
actions become items (e.g. template WhatsApp-only, reply→message downgrade, media
gated on `media_send`) happens earlier in `buildOutboundItems` — see
[Rich chat actions](./rich-chat-actions.md).

## Testing

[`tests/unit/delivery-queue.test.ts`](../../tests/unit/delivery-queue.test.ts)
covers the pure logic: `buildOutboundItems` capability gating,
`advancementMode` / `statusAdvancesQueue` per channel, and cursor advancement. The
agent's send loop, `on_status` vs `on_send` advancement, the delivery-timeout
fallback, the handle-mapping correlation, and typing injection are covered in
[`tests/unit/conversation-agent.test.ts`](../../tests/unit/conversation-agent.test.ts),
and the WhatsApp send path is proven end-to-end in
[`tests/integration/end-to-end-flow.test.ts`](../../tests/integration/end-to-end-flow.test.ts).

## Known limitations

- Transient-failure retry + WhatsApp out-of-window template re-prompt landed in
  Stage 10 (see [Rate limiting](./rate-limiting.md)); a `permanent` failure (incl.
  any 5xx on the SYNCHRONOUS path — double-send safety) is still skipped + advanced,
  and Messenger/Instagram have no out-of-window mechanism to enforce.
- Pre-send pacing is per-second only; the per-hour/per-day counters are track-only
  (warn/error logging), not a gating cap — see [Rate limiting](./rate-limiting.md).
- **WhatsApp `sent`-then-`failed` ordering edge.** If a `sent` status advances the
  queue (deleting the outbound-handle mapping) before a later `failed` for the same
  wamid arrives, the late `failed` finds no mapping and is NOT routed to
  retry/reprompt — the failure is still recorded in status history (observable on
  `GET /admin/status/:messageId`), just not retried. The common WhatsApp failure is
  a bare `failed` with no preceding `sent`, so this is an edge case. See
  [Known gaps](../KNOWN-GAPS.md).

See [Known gaps](../KNOWN-GAPS.md) and [Architecture](../ARCHITECTURE.md).
