# Conversation state

The conversation layer is the orchestrator that sits between the inbound parser
and the outbound send clients. It owns one record per (channel, business, user)
triple, buffers inbound bursts, calls the developer's chat endpoint, and drives
ordered outbound delivery. This document covers the state machine, the
conversation key, the `ConversationRecord` shape, dedupe and echo filtering, the
24-hour messaging-window tracking, the per-conversation serialization lock, and
the in-memory store.

The mechanisms that own one slice each are documented separately and cross-linked
below:

- [Message buffering](./message-buffering.md) — burst aggregation and the buffer
  scheduler.
- [Ordered delivery](./ordered-delivery.md) — the channel-aware outbound queue.
- [Rich chat actions](./rich-chat-actions.md) — the chat request/response
  contract.

Source: [`src/conversation/agent.ts`](../../src/conversation/agent.ts),
[`src/conversation/store.ts`](../../src/conversation/store.ts),
[`src/conversation/types.ts`](../../src/conversation/types.ts).

## The state machine

A conversation moves through four phases. `ConversationStateName` is
`'idle' | 'buffering' | 'processing' | 'sending'`
([`src/conversation/types.ts`](../../src/conversation/types.ts)).

```
idle ──first inbound──▶ buffering ──flush timer fires──▶ processing
                                                              │
                                                  chat endpoint returns
                                                              │
                                                              ▼
idle ◀──queue complete / silence / chat error / no adapter── sending
```

| Transition | Where it happens | Trigger |
| --- | --- | --- |
| `idle → buffering` | `handleInboundImpl` sets `record.state = 'buffering'` and (re)arms the flush timer | First inbound message (and every subsequent inbound while buffering — each resets the timer) |
| `buffering → processing` | `flushImpl` snapshots the buffer, clears it, sets `record.state = 'processing'`, then calls `chatClient.complete` | The buffer scheduler fires after the burst window elapses |
| `processing → sending` | `flushImpl` builds the outbound queue from the chat response and sets `record.state = 'sending'` | Chat endpoint returned deliverable actions |
| `processing → idle` | `flushImpl` calls `transitionToIdle` | Chat error, explicit `silence`, empty action list, no deliverable items after capability filtering, or no adapter for the channel |
| `sending → idle` | `sendNext` finds the queue complete and sets `record.state = 'idle'` | The outbound cursor advances past the last item |
| `sending → idle` | `transitionToIdle` | No adapter mid-send, or an unexpected error in the flush body |

`sendNext` is the only place that completes the queue: when
`isQueueComplete(state)` is true it clears `currentOutboundMessageId`, sets state
back to `idle`, and stamps `lastActivity`. Ordered advancement within `sending`
(WhatsApp waiting on a delivery status vs. Messenger/Instagram advancing on send)
is covered in [Ordered delivery](./ordered-delivery.md).

## Conversation keying

One `ConversationRecord` exists per (channel, business, user) triple. The key is
built by `conversationKeyFor(message)` as `{channel}:{business}:{user}`, where the
business side is the parser-normalized `channelScopedBusinessId` and the user side
is `channelScopedUserId`
([`src/conversation/types.ts`](../../src/conversation/types.ts)):

| Channel | Key format | Business side | User side |
| --- | --- | --- | --- |
| WhatsApp | `whatsapp:{phoneNumberId}:{waId}` | `phone_number_id` | `wa_id` (E.164) |
| Messenger | `messenger:{pageId}:{psid}` | Page ID | PSID |
| Instagram | `instagram:{igUserId}:{igsid}` | IG User ID | IGSID |

There is **no cross-channel merge at this layer.** Meta does not link `wa_id`,
PSID, and IGSID, so the same human reaching the business on WhatsApp and on
Instagram is two separate records. Joining them is an explicit app decision left
to the [identity resolver](./identity-resolution.md) (via the
`unifiedContactId` its `USER_LOOKUP_URL` returns). Because
the user side is always normalized to the user (echoes are unflipped at the
parser boundary), the key is stable regardless of message direction.

## The `ConversationRecord`

The record is the unit the store persists and the agent mutates
([`src/conversation/types.ts`](../../src/conversation/types.ts)). Key fields:

| Field | Purpose |
| --- | --- |
| `key`, `channel`, `channelScopedUserId`, `channelScopedBusinessId` | Identity of the conversation. |
| `state` | Current `ConversationStateName`. |
| `inboundBuffer` | Inbound messages awaiting flush to the chat endpoint. Cleared on flush. |
| `outboundQueue` | Ordered `OutboundItem`s produced from the chat response. |
| `currentOutboundIndex` | Cursor into `outboundQueue` for the in-flight item. |
| `currentOutboundMessageId` | Channel message id of the in-flight outbound, for status correlation (set only while WhatsApp waits on a status). |
| `deliveredMessageIds` | Channel message ids confirmed sent/delivered (observability; the full per-message status history lives in the [status tracker](./status-tracking.md)). |
| `lastInboundMessageId` | Channel message id of the MOST RECENT inbound. WhatsApp's typing indicator is anchored to an inbound `wamid` (typing is coupled with mark-read), so the agent threads outbound typing back to it. |
| `lastInboundAt`, `lastOutboundAt`, `lastActivity` | Activity timestamps (Unix ms). |
| `windowExpiresAt` | Unix ms the 24h messaging window closes (`lastInboundAt + 24h`). |
| `contact` | Resolved identity, when available. Populated by the [identity resolver](./identity-resolution.md) when `USER_LOOKUP_URL` is configured; otherwise undefined. |
| `traceId` | Request-scoped trace id captured at the inbound webhook entry. |

`createIdleConversation(...)` builds a fresh record with empty buffers/queues and
`state: 'idle'`. It only attaches `contact` when supplied so the field stays
absent rather than `undefined`.

## Dedupe and echo filtering

Two distinct dedupe layers exist; this one is the cross-payload layer. (The
parser already dedupes per-payload by `channelMessageId` within a single
delivery — see [Message parsing](./message-parsing.md).)

`handleInboundImpl` processes an inbound in this order
([`src/conversation/agent.ts`](../../src/conversation/agent.ts)):

1. **Echo filter first.** If `message.isEcho` is true, the message is dropped
   before dedupe. Meta echoes business-sent messages back on the same webhook
   (Messenger/Instagram `is_echo`); treating an echo as inbound would loop the
   agent's own output back into the chat endpoint. The order matters — filtering
   echoes before the dedupe claim means an echo never consumes a dedupe slot.
2. **Dedupe via SETNX.** `store.claimInboundHandle(channelMessageId)` is an
   atomic claim-with-TTL. It returns `true` the first time a `channelMessageId`
   is seen within the TTL (process it) and `false` on a redelivery (drop it).
   Meta retries a webhook until it sees a 200, so the same inbound can arrive
   many times; the claim makes a single inbound process exactly once. The TTL is
   `DEDUPE_TTL_SECONDS` (default 86400). The end-to-end test
   `dedupes the same inbound across two webhook deliveries` proves the claim
   holds across separate HTTP requests.

The store also exposes `peekInboundHandle` (a non-destructive presence check, for
future admin introspection).

## 24-hour messaging window

Meta only lets a business send free-form messages within 24 hours of the user's
last inbound. The agent tracks this on every inbound: `handleInboundImpl` sets
`record.windowExpiresAt = now + MESSAGING_WINDOW_MS` (24h), so the window restarts
from each inbound. `isWindowOpen(record, now)` is true when `windowExpiresAt` is
set and strictly in the future (an unset value — no inbound seen yet — is treated
as CLOSED).

The flag is surfaced to the chat endpoint as `context.windowOpen` in the
`ChatRequest` (see [Rich chat actions](./rich-chat-actions.md)). The agent
*tracks and reports* the window; full enforcement (blocking out-of-window sends
or forcing a WhatsApp template fallback) is Stage 10 — see
[Known gaps](../KNOWN-GAPS.md).

## Per-conversation serialization (load-bearing)

The agent runs read-modify-write flows on the store: it reads a record, mutates
it (pushes to the buffer/queue, flips state), and writes it back. The
`ConversationStore` contract is **pass-by-value with last-write-wins** — it has no
atomic read-modify-write. The in-memory store clones on both read and write
([`src/conversation/store.ts`](../../src/conversation/store.ts)), which isolates a
caller's working copy from the stored copy but does **not** prevent a lost update:
two concurrent flows for one key both read the same clone, both mutate, both
write, and the second write clobbers the first — silently dropping a user message
or a queue advance.

This race is routine, not theoretical: the HTTP dispatcher fires inbounds and
statuses concurrently, and a single webhook can batch many messages for one
conversation. A confirmed message-dropping race was closed by serializing per
key.

### How it works

`runExclusive(key, fn)` chains `fn` onto a per-key promise tail (`keyTails`), so a
new exclusive op for a key starts only after the prior op for that key settles,
then becomes the new tail. The design is deliberate
([`src/conversation/agent.ts`](../../src/conversation/agent.ts)):

- `fn` runs whether the prior op resolved or rejected — one flow's failure must
  not skip a queued flow.
- The tail stored in the map is a swallowed (`.then(noop, noop)`) view so a
  rejecting op never poisons the chain into an unhandled rejection, yet the
  caller still receives the real result/rejection.
- The map entry is deleted once the op settles, unless a newer op already took
  over the tail, so the map cannot grow unbounded.

Different keys still run concurrently — `keyTails` is keyed, never a global lock.

### Entry-point vs internal split

The lock has one rule that future edits must preserve: **entry points acquire,
internal helpers stay lock-free.**

- **Acquire** (true entry points, each fired OUTSIDE any held lock):
  `handleInbound`, `handleStatus`, the scheduler flush handler (registered in the
  constructor), and the delivery-timeout callback. `handleReaction` does NOT
  acquire — it delegates to `handleInbound`, which acquires, so it inherits the
  lock; acquiring again would deadlock (a holder calling a same-key acquirer).
- **Do not acquire** (internal; only ever reached from within a holder):
  `flushImpl`, `sendNext`, `advanceAndContinue`, `markSkippedAndAdvance`,
  `transitionToIdle`, `onDeliveryTimeoutImpl`, `handleInboundImpl`,
  `handleStatusImpl`.

The no-deadlock invariant: no lock-holding path ever calls another
lock-acquiring method for the same key. Acquiring methods call only the `*Impl`
bodies, and no `*Impl` body calls `handleInbound` / `handleStatus` /
`onDeliveryTimeout`. The chain is therefore strictly linear per key.

`handleStatus` is a special case: the conversation key isn't known until the
outbound-handle mapping is resolved, so it does a lock-free pre-lookup to find
the key, then runs its body under that key's lock (re-reading the mapping inside
the lock). An unmapped status has no conversation to serialize on and runs
unlocked straight to the benign no-op path.

The regression test `concurrent same-key inbound: BOTH messages survive` in
[`tests/unit/conversation-agent.test.ts`](../../tests/unit/conversation-agent.test.ts)
proves the fix: without the lock the second buffer-append clobbers the first; with
it, both survive.

## Fail-soft

Every `handle*` method is fail-soft: it never throws out. The HTTP layer has
already ACKed the webhook 200 (Meta retries non-2xx for 7 days), so a thrown
error would either crash the route after the ACK or get swallowed and lose data.
`handleInboundImpl`, `handleStatusImpl`, and `flushImpl` wrap their bodies in a
`try`/`catch` that logs and returns. Chat-endpoint errors and adapter send errors
are logged; on a chat error the turn ends quietly (the user gets no reply — retry
is Stage 10) and on a single bad send the item is marked skipped and the queue
advances (see [Ordered delivery](./ordered-delivery.md)).

## In-memory now, Redis in Stage 10

Stage 5 ships only `InMemoryConversationStore`
([`src/conversation/store.ts`](../../src/conversation/store.ts)) and
`InMemoryBufferScheduler`. State lives in plain `Map`s, is per-process, and
disappears on restart, so the per-replica view diverges in a multi-replica
deploy. The store holds three things: conversation records, an inbound dedupe set
(presence-with-expiry simulating SETNX), and an outbound-handle map. The
production path is the Redis-backed store (real `SET NX` for atomic dedupe, `SCAN`
for `listConversationKeys`) plus a BullMQ-backed buffer scheduler, selected on
`REDIS_URL`, which lands in Stage 10. The `ConversationStore` and
`BufferScheduler` interfaces are the contract both implementations honor (the
in-memory dedupe map is never swept — it relies on the later Redis TTL; see
[Known gaps](../KNOWN-GAPS.md)).

## Configuration

The agent reads its knobs from `config.conversation`
([`src/config/loader.ts`](../../src/config/loader.ts)). The dedupe and
delivery-relevant ones:

| Env var | Default | Used for |
| --- | --- | --- |
| `DEDUPE_TTL_SECONDS` | `86400` | TTL of an inbound dedupe claim. |
| `OUTBOUND_DELIVERY_TIMEOUT_MS` | `30000` | Fallback before advancing a WhatsApp item with no delivery status (see [Ordered delivery](./ordered-delivery.md)). |
| `OUTBOUND_TYPING_INDICATORS_ENABLED` | `true` | Whether to send a typing indicator before a text item. |
| `CHAT_ENDPOINT_TIMEOUT_MS` | `30000` | Hard timeout on the chat endpoint call. |

Buffer-timing knobs are documented in [Message buffering](./message-buffering.md).

## Known limitations

- No persistence — in-memory store/scheduler only (Stage 10).
- No rate limiting and no out-of-window enforcement (Stage 10).
- The scheduler's own `setTimeout` failure catch is still uncounted at the
  scheduler level (the flush itself is instrumented via
  `buffer_flush_total{result:'error'}` at the agent level — see
  [Message buffering](./message-buffering.md)).

See [Known gaps](../KNOWN-GAPS.md) for the full deferral list and
[Architecture](../ARCHITECTURE.md) for where this layer sits in the runtime.
