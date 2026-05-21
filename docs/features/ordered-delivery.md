# Ordered delivery

When the chat endpoint returns several actions for one turn — say a reaction, then
a reply, then a follow-up message — they must reach the user in order. The
delivery layer turns the normalized chat actions into an ordered queue and sends
one item at a time, advancing only when the current item is confirmed. How
"confirmed" is defined is **channel-aware**, because the three Meta channels give
different delivery signals.

Source: [`src/delivery/queue.ts`](../../src/delivery/queue.ts) (pure queue logic),
[`src/delivery/types.ts`](../../src/delivery/types.ts) (shapes), and the
`sendNext` / `handleStatus` / delivery-timeout machinery in
[`src/conversation/agent.ts`](../../src/conversation/agent.ts). For the
surrounding state machine see [Conversation state](./conversation-state.md); for
how actions become items see [Rich chat actions](./rich-chat-actions.md).

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
`failed` is left to Stage 10 retry, so neither advances. For `on_send` channels it
always returns false — the queue already advanced at send time, so a
watermark-derived status must never double-advance it.

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

A send that throws (`MetaApiError` or anything else) does not wedge the queue:
`sendNext` calls `markSkippedAndAdvance`, which stamps `skippedAt`/`skipReason` on
the item and advances past it. One bad send never blocks the rest of the queue.
Proper retry of a failed send is Stage 10. The capability filtering that decides
which actions become items (e.g. template WhatsApp-only, reply→message downgrade,
media gated on `media_send`) happens earlier in `buildOutboundItems` —
see [Rich chat actions](./rich-chat-actions.md).

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

- No retry on a failed send — the item is skipped and the queue advances
  (Stage 10).
- Out-of-window enforcement / WhatsApp template fallback is Stage 10.

See [Known gaps](../KNOWN-GAPS.md) and [Architecture](../ARCHITECTURE.md).
