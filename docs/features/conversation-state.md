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
   ▲                       ▲   ▲                            │
   │                       │   └─ late inbound aborts the   │
   │                       │      in-flight chat → rebatch  │
   │           interruptSending  (processing → buffering)   │
   │           (new inbound mid-send)             chat endpoint returns
   │                       │                                │
   │                       │                                ▼
   └──queue complete / silence / chat error / no adapter── sending
            (via finalizeTurn — may instead spawn a
             follow-up buffering turn from lateArrivals)
```

| Transition | Where it happens | Trigger |
| --- | --- | --- |
| `idle → buffering` | `handleInboundImpl` (`idle`/`buffering` branch) appends to `inboundBuffer`, sets `record.state = 'buffering'`, and (re)arms the flush timer | First inbound message (and every subsequent inbound while buffering — each resets the timer) |
| `buffering → processing` | `flushImpl` locked segment 1 snapshots the buffer, clears `inboundBuffer` and `lateArrivals`, sets `record.state = 'processing'`, registers an `AbortController` (unless committed), then calls `chatClient.complete` outside the lock | The buffer scheduler fires after the burst window elapses |
| `processing → buffering` | `flushImpl` locked segment 2: an inbound arrived during the chat call and aborted it (or the reprocess cap was hit) → fold `[...batch, ...inboundBuffer, ...lateArrivals]` back into `inboundBuffer`, increment `reprocessCount` (unless at cap), and reschedule a flush | A late arrival aborted the in-flight chat (rebatch), or the abort happened at `MAX_REPROCESS` (cap overflow — the next flush is committed) |
| `processing → sending` | `flushImpl` locked segment 2 builds the outbound queue from the chat response, resets `reprocessCount = 0`, and sets `record.state = 'sending'` | Chat endpoint returned deliverable actions |
| `processing → idle` | `flushImpl` calls `transitionToIdle` | Chat error (not an abort), or no adapter at segment 1 |
| `processing → idle` / `processing → buffering` | `flushImpl` segment 2 silence / no-deliverable branches call `finalizeTurn` | Explicit `silence`, empty action list, or no deliverable items after capability filtering — `finalizeTurn` goes `idle` unless `lateArrivals` is non-empty, in which case it spawns a follow-up `buffering` turn |
| `sending → buffering` | `handleInboundImpl` (`sending` branch) calls `interruptSending` | A new inbound arrives mid-delivery — the turn is rolled back and rebatched |
| `sending → idle` / `sending → buffering` | `sendNext` finds the queue complete and calls `finalizeTurn` | The outbound cursor advances past the last item — `finalizeTurn` goes `idle`, or spawns a follow-up `buffering` turn if `lateArrivals` is non-empty |
| `sending → idle` | `transitionToIdle` | No adapter mid-send, or an unexpected error in the flush body |

`finalizeTurn` is the single completion path for a turn that resolved (sent its
outbound, went silent, or had nothing deliverable). It clears the delivery
timeout, resets `reprocessCount` to 0, then either:

- **Follow-up turn:** if `lateArrivals` is non-empty (messages arrived during a
  *committed* flush that could not be interrupted — see the locking section
  below), it moves them into `inboundBuffer`, resets the outbound queue/cursor,
  drops back to `buffering`, and schedules a fresh flush — a brand-new logical
  turn that produces its own response, so nothing is dropped.
- **Idle:** otherwise it sets `record.state = 'idle'` and stamps `lastActivity`.

`sendNext` is the only place that completes the queue: when
`isQueueComplete(state)` is true it calls `finalizeTurn` (which replaced the old
inline transition-to-idle). Ordered advancement within `sending` (WhatsApp waiting
on a delivery status vs. Messenger/Instagram advancing on send) and the
`interruptSending` rollback are covered in
[Ordered delivery](./ordered-delivery.md). The interrupt/rebatch behavior on the
inbound side is covered in [Message buffering](./message-buffering.md).

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
| `inboundBuffer` | Inbound messages awaiting flush to the chat endpoint. Snapshotted and cleared at the start of a flush. |
| `lateArrivals` | Inbound messages that arrived while a flush's chat call was in flight (state `processing`). Folded back into `inboundBuffer` on rebatch, or turned into a follow-up turn by `finalizeTurn`. Cleared on each flush start. |
| `reprocessCount` | How many times the current turn has been deferred + rebatched because a late arrival aborted its in-flight chat call. Bounded by `MAX_REPROCESS` (5); reset to 0 on a clean turn completion. |
| `outboundQueue` | Ordered `OutboundItem`s produced from the chat response. |
| `currentOutboundIndex` | Cursor into `outboundQueue` for the in-flight item. |
| `currentOutboundMessageId` | Channel message id of the in-flight outbound, for status correlation (set only while WhatsApp waits on a status). |
| `deliveredMessageIds` | Channel message ids confirmed sent/delivered (observability; the full per-message status history lives in the [status tracker](./status-tracking.md)). |
| `lastInboundMessageId` | Channel message id of the MOST RECENT inbound. WhatsApp's typing indicator is anchored to an inbound `wamid` (typing is coupled with mark-read), so the agent threads outbound typing back to it. |
| `lastInboundAt`, `lastOutboundAt`, `lastActivity` | Activity timestamps (Unix ms). |
| `windowExpiresAt` | Unix ms the 24h messaging window closes (`lastInboundAt + 24h`). |
| `contact` | Resolved identity, when available. Populated by the [identity resolver](./identity-resolution.md) when `USER_LOOKUP_URL` is configured; otherwise undefined. |
| `traceId` | Request-scoped trace id captured at the inbound webhook entry. |

`createIdleConversation(...)` builds a fresh record with empty buffers/queues
(`inboundBuffer: []`, `lateArrivals: []`, `reprocessCount: 0`) and `state: 'idle'`.
It only attaches `contact` when supplied so the field stays absent rather than
`undefined`.

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
`ChatRequest` (see [Rich chat actions](./rich-chat-actions.md)). The agent both
*tracks and reports* the window AND, on WhatsApp, **enforces** it: a send that
fails with the 24h re-engagement error re-prompts the chat endpoint once for a
template (Stage 10). See [Rate limiting → WhatsApp out-of-window
re-prompt](./rate-limiting.md#whatsapp-out-of-window-re-prompt). (Messenger/Instagram
have no reliable out-of-window mechanism for an automated bot, so there is nothing
to enforce there.)

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
  `handleInbound`, `handleStatus`, and the delivery-timeout callback.
  `handleReaction` does NOT acquire — it delegates to `handleInbound`, which
  acquires, so it inherits the lock; acquiring again would deadlock (a holder
  calling a same-key acquirer).
- **Do not acquire** (internal; only ever reached from within a holder):
  `sendNext`, `advanceAndContinue`, `markSkippedAndAdvance`, `transitionToIdle`,
  `finalizeTurn`, `interruptSending`, `onDeliveryTimeoutImpl`,
  `handleInboundImpl`, `handleStatusImpl`.
- **Segmented (the batching fix):** `flushImpl` is fired by the scheduler outside
  any held lock and acquires the lock *itself*, but only around its record
  read-modify-write segments — see below.

The no-deadlock invariant: no lock-holding path ever calls another
lock-acquiring method for the same key. Acquiring methods (and `flushImpl`'s
locked segment bodies) call only the `*Impl` / lock-free helpers, and none of
those calls `handleInbound` / `handleStatus` / `onDeliveryTimeout`. The chain is
therefore strictly linear per key.

`handleStatus` is a special case: the conversation key isn't known until the
outbound-handle mapping is resolved, so it does a lock-free pre-lookup to find
the key, then runs its body under that key's lock (re-reading the mapping inside
the lock). An unmapped status has no conversation to serialize on and runs
unlocked straight to the benign no-op path.

The regression test `concurrent same-key inbound: BOTH messages survive` in
[`tests/unit/conversation-agent.test.ts`](../../tests/unit/conversation-agent.test.ts)
proves the fix: without the lock the second buffer-append clobbers the first; with
it, both survive.

### Segmented locking: the batching fix

The original model wrapped the *entire* flush — including the slow
`chatClient.complete` call — in a single `runExclusive`, so the per-key lock was
held across the whole turn. That blocked every concurrent `handleInbound` for the
key: a message arriving mid-flush could not interrupt the in-flight turn, so it
queued for a *second* flush and the user got **two separate replies** for two
messages sent close together.

The rewrite narrows the lock to **segments** and releases it during the chat call.
`flushImpl` is no longer wrapped by the scheduler handler; instead it acquires the
lock only around its record read-modify-write segments
([`src/conversation/agent.ts`](../../src/conversation/agent.ts)):

```
[lock]  segment 1: load record; snapshot + clear inboundBuffer AND lateArrivals;
        set `processing`; decide committed = reprocessCount >= MAX_REPROCESS;
        register an AbortController (UNLESS committed); build the request   [unlock]
   →    run the media hydrator, then AWAIT chatClient.complete(request, signal)
        ← NO LOCK HELD HERE (only the network call, on a private snapshot)
[lock]  segment 2: re-read record; if aborted under cap → rebatch
        [...batch, ...inboundBuffer, ...lateArrivals] into inboundBuffer,
        reprocessCount += 1, → `buffering`, reschedule; if aborted at cap → warn,
        rebatch, reschedule (next flush is committed); else attach the outbound
        queue, reset reprocessCount = 0, → `sending`                       [unlock]
[lock]  segment 3: sendNext (drives ordered delivery)                      [unlock]
```

**The interrupt / rebatch flow.** When an inbound arrives during `processing`,
`handleInboundImpl` pushes it onto `lateArrivals` and aborts the in-flight chat
call *if* an `AbortController` is registered for the key
(`inFlightChatAborts`). The aborted call rejects; `flushImpl` distinguishes the
abort from a real endpoint error via `signal.aborted` and routes to segment 2's
rebatch path — folding the original batch plus the late arrivals back into one
combined turn. Net effect: the two messages become **one** combined reply, not
two. The abort handle is always cleared in a `finally`, so a settled call can
never be aborted by a later inbound.

**The `MAX_REPROCESS` cap (forward progress).** A user typing a never-ending
stream could abort the turn forever and starve. `MAX_REPROCESS` (5) bounds how
many times one logical turn may be deferred + rebatched. Once `reprocessCount`
reaches the cap, the next flush is **committed**: segment 1 registers *no*
`AbortController`, so `handleInboundImpl` cannot abort it (a late arrival just
queues to `lateArrivals` instead), and the chat call runs to completion and sends.
Messages that arrived during a committed flush are not lost — `finalizeTurn` turns
them into a fresh follow-up turn.

**Why this is still race-free.** The Stage-5 clobber-prevention is preserved:
every record mutation here is a *complete* locked read-modify-write — load,
mutate, save, all inside one `runExclusive` segment — so two flows for the same
key can never both read the same clone and clobber each other. The only thing
moved outside the lock is the chat call (plus media hydration), which mutates no
record — it just produces a response into a local variable and operates on the
flush's private `batch` snapshot. A concurrent `handleInbound` that lands during
the unlocked window runs a full, isolated read-modify-write of its own (appending
to `lateArrivals` + aborting the chat), and segment 2's re-read observes that and
rebatches. The lock guards record mutations, not chat I/O. The new transitions
this introduces — `processing → buffering` (rebatch / cap overflow) and
`sending → buffering` (`interruptSending`) — are documented in
[the state machine](#the-state-machine).

**Shutdown.** `close()` aborts every in-flight chat call (via
`inFlightChatAborts`) and clears the map, so a slow chat endpoint can't leave an
open socket dangling past shutdown; each abort just rejects the awaiting flush,
which handles it as an abort. It also clears all delivery timers and closes the
scheduler.

The regression tests in
[`tests/unit/conversation-agent.test.ts`](../../tests/unit/conversation-agent.test.ts)
cover this: `message B during processing aborts the in-flight chat and produces
ONE combined response`, `reprocess cap: a steady stream stops deferring after
MAX_REPROCESS and still produces a response`, `cap-reached committed flush ALWAYS
sends + overflow becomes a follow-up turn`, and `close aborts an in-flight chat
call` prove the rebatch, the cap, the committed-flush + follow-up behavior, and
the shutdown abort respectively.

## Fail-soft

Every `handle*` method is fail-soft: it never throws out. The HTTP layer has
already ACKed the webhook 200 (Meta retries non-2xx for 7 days), so a thrown
error would either crash the route after the ACK or get swallowed and lose data.
`handleInboundImpl`, `handleStatusImpl`, and `flushImpl` wrap their bodies in a
`try`/`catch` that logs and returns. Chat-endpoint errors and adapter send errors
are logged; on a chat error the turn ends quietly (the user gets no reply). On a
single bad send, the error is classified (Stage 10): a known-safe transient failure
is retried with backoff, a WhatsApp closed-window failure re-prompts for a template,
and everything else is marked skipped and the queue advances (see
[Ordered delivery](./ordered-delivery.md) and [Rate limiting](./rate-limiting.md)).

## In-memory or Redis (dual-path)

The store and scheduler are dual-path, selected on `REDIS_URL`
([`src/index.ts`](../../src/index.ts) `buildRuntime`). The in-memory pair —
`InMemoryConversationStore`
([`src/conversation/store.ts`](../../src/conversation/store.ts)) and
`InMemoryBufferScheduler` — keeps state in plain `Map`s: per-process, lost on
restart, diverging across replicas (fine for tests, local runs, and single-replica
deploys). The production path (`REDIS_URL` set) is `RedisConversationStore` (real
`SET NX` for atomic cross-replica dedupe, `SCAN` for `listConversationKeys`, TTL
eviction) plus the BullMQ-backed buffer scheduler. The `ConversationStore` and
`BufferScheduler` interfaces are the contract both implementations honor. See
[Persistence](./persistence.md) for the Redis key schema, the BullMQ scheduler, and
the shared-client lifecycle. (The in-memory dedupe map is never swept — it relies on
the Redis TTL on the production path; see [Known gaps](../KNOWN-GAPS.md).)

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

- Persistence is dual-path (in-memory or Redis); the Stage 6 metrics/status/contact
  stores stay in-memory in both paths (Redis swaps deferred — see
  [Persistence](./persistence.md) and [Known gaps](../KNOWN-GAPS.md)).
- Rate limiting and WhatsApp out-of-window enforcement landed in Stage 10, but
  pacing is per-second only (no per-hour/per-day caps) — see
  [Rate limiting](./rate-limiting.md).
- The scheduler's own `setTimeout` failure catch is still uncounted at the
  scheduler level (the flush itself is instrumented via
  `buffer_flush_total{result:'error'}` at the agent level — see
  [Message buffering](./message-buffering.md)).

See [Known gaps](../KNOWN-GAPS.md) for the full deferral list and
[Architecture](../ARCHITECTURE.md) for where this layer sits in the runtime.
