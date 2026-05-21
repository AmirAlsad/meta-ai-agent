# Message buffering

People send messages in bursts — three quick lines instead of one paragraph.
Calling the chat endpoint once per line produces three disjointed replies and
triples the cost. The buffering mechanism waits a short, growing window after each
inbound and aggregates a rapid burst into a single chat call.

Source: [`src/conversation/buffering.ts`](../../src/conversation/buffering.ts),
[`src/conversation/scheduler.ts`](../../src/conversation/scheduler.ts), and the
inbound path in [`src/conversation/agent.ts`](../../src/conversation/agent.ts).
For the surrounding state machine see
[Conversation state](./conversation-state.md).

## The timeout curve

`calculateBufferTimeout(messageCount, config, random)`
([`src/conversation/buffering.ts`](../../src/conversation/buffering.ts)) is a
pure, deterministic-given-`random` function. It grows the flush window as a burst
continues (so a chatty user gets a slightly longer pause before the agent
responds), caps it, then applies optional jitter:

```
calculated = bufferBaseTimeoutMs × bufferGrowthFactor^(messageCount - 1)
capped     = min(calculated, bufferMaxTimeoutMs)

if bufferNoiseMaxDeviation == 0 or capped == 0:
    return round(capped)

noiseRange = capped × bufferNoiseMaxDeviation
noise      = (random() × 2 - 1) × noiseRange      # random ∈ [0,1) → noise ∈ [-noiseRange, +noiseRange)
return round( clamp(capped + noise, min, max) )
   where min = bufferBaseTimeoutMs × 0.5
         max = bufferMaxTimeoutMs  × 1.5
```

`messageCount` is the number of messages already buffered (1 for the first). So
the first inbound waits `bufferBaseTimeoutMs`; the second waits
`base × growth`; and so on, capped at `bufferMaxTimeoutMs`.

The jitter clamp is deliberate: on the low side it never collapses the window
below half the base delay (which would defeat burst aggregation), and on the high
side it may overshoot the hard max by up to 50% — the cap bounds the growth
*curve*, not the jitter, so flushes near the ceiling still de-synchronize instead
of all firing at exactly `max`.

The math is ported verbatim from the SendBlue reference; the only adaptation is
reading the knobs from the nested `ConversationConfig` section.

### Configuration

All knobs live under `config.conversation`
([`src/config/loader.ts`](../../src/config/loader.ts)):

| Env var | Field | Default | Meaning |
| --- | --- | --- | --- |
| `BUFFER_BASE_TIMEOUT_MS` | `bufferBaseTimeoutMs` | `2000` | Window after the first inbound (ms). Positive integer. |
| `BUFFER_GROWTH_FACTOR` | `bufferGrowthFactor` | `1.25` | Multiplier per additional buffered message (`>= 1`). |
| `BUFFER_MAX_TIMEOUT_MS` | `bufferMaxTimeoutMs` | `8000` | Hard ceiling on the curve (ms). Must be `>= base`. |
| `BUFFER_NOISE_MAX_DEVIATION` | `bufferNoiseMaxDeviation` | `0.3` | Fractional jitter `[0, 1]`. `0` disables jitter. |

The loader cross-validates that `BUFFER_MAX_TIMEOUT_MS >= BUFFER_BASE_TIMEOUT_MS`
and throws (naming the offending var) on a malformed value — a max below the base
would let the growth math produce a window shorter than the first flush, which is
always a misconfiguration.

## How a burst aggregates into one flush

Each inbound, in `handleInboundImpl`, pushes the message onto
`record.inboundBuffer`, then computes
`calculateBufferTimeout(record.inboundBuffer.length, config.conversation, random)`
and calls `scheduler.schedule(key, delayMs, ...)`. Scheduling **replaces** any
in-flight timer for that key (see below), so a fresh inbound resets the window.
The flush only fires once the user pauses for a full window.

When the timer finally fires, `flushImpl` snapshots the entire buffer, clears it,
and makes a single `chatClient.complete` call carrying the whole batch — so N
rapid messages produce one chat call, not N. Snapshot-and-clear happens up front
(before the async chat call) so any inbound that arrives mid-flight is captured by
the interrupt/rebatch flow below rather than being re-sent or lost.

## Interrupt and rebatch: a message that arrives mid-flush

The buffer is snapshotted and cleared the moment a flush starts (state
`processing`), so a message that arrives *during* the chat call can't land in the
already-snapshotted batch. Instead `handleInboundImpl`'s `processing` branch
pushes it onto `record.lateArrivals` and aborts the in-flight chat call (the flush
registered an `AbortController` for the key). The flush, on re-acquiring the lock,
sees the abort, folds `[...batch, ...inboundBuffer, ...lateArrivals]` back into
`inboundBuffer`, increments `reprocessCount`, returns to `buffering`, and arms a
fresh flush. The combined input then produces **one** chat call and **one**
response — the late inbound no longer produces a second flush.

This relies on releasing the per-key lock during the chat call (the *segmented
locking* model). The full mechanism, the race-free argument, and the state
transitions it introduces (`processing → buffering`, `sending → buffering`) are
documented in
[Conversation state](./conversation-state.md#segmented-locking-the-batching-fix).

### The reprocess cap (`MAX_REPROCESS`)

A user typing a relentless stream could abort the turn on every chat call and
starve it forever. `MAX_REPROCESS` (5) bounds how many times one logical turn may
be deferred + rebatched. Once `reprocessCount` reaches the cap, the next flush is
**committed**: it registers no `AbortController`, so a late arrival can't interrupt
it — it queues to `lateArrivals` instead, and the committed flush runs to
completion and sends. Messages that arrived during a committed flush become a
fresh follow-up turn (via `finalizeTurn`), so nothing is dropped. `reprocessCount`
resets to 0 on every clean turn completion. A message arriving while the
conversation is `sending` (mid-delivery) is handled differently — see
[Ordered delivery](./ordered-delivery.md#interrupting-an-in-flight-send).

The interrupt/rebatch, the cap, and the committed-flush behavior are proven by the
`interrupt / rebatch (narrowed lock)` tests in
[`tests/unit/conversation-agent.test.ts`](../../tests/unit/conversation-agent.test.ts).

### `message` string vs `messages[]` array

The flush builds a `ChatRequest` carrying the buffered turn in two forms
([`src/conversation/agent.ts`](../../src/conversation/agent.ts)):

- `message` — a backward-compat aggregated string: each buffered message's `text`
  (skipping entries with no text), newline-joined.
- `messages` — the structured `IncomingMessage[]`, in arrival order, so the
  endpoint can inspect media, reactions, reply targets, and per-message metadata.

The end-to-end test `multi-message webhook: BOTH messages in one body reach the
chat call` asserts both forms: `messages` holds both entries in order and
`message` is `"first of two\nsecond of two"`. See
[Rich chat actions](./rich-chat-actions.md) for the full request shape.

## The buffer scheduler

`BufferScheduler`
([`src/conversation/scheduler.ts`](../../src/conversation/scheduler.ts)) is the
interface that arms the per-conversation flush timer. The runtime ships
`InMemoryBufferScheduler` (setTimeout-based, single-process). The Redis-backed
`'bullmq'` implementation is Stage 10; `kind` (`'in_memory' | 'bullmq'`) and
`getStats()` are wired into the `/ready` route now so it and the BullMQ impl
share one shape.

Behavior of the in-memory scheduler:

- **One timer per key.** `schedule` first calls `cancel` to clear any in-flight
  timer for the key, so re-scheduling extends the burst window rather than
  queuing a second flush. There is never more than one outstanding flush per
  conversation.
- **Trace propagation.** The trace id captured when the flush was last scheduled
  is stored per key and passed to the handler when it fires, so the flush
  correlates back to the originating inbound. The trace middleware stamps that id
  at the webhook boundary and the agent threads it through, so a flush's log lines
  chain back to the triggering inbound.
- **Swallowed rejections.** A timer-fired handler that rejects is caught and
  dropped so an unhandled rejection can't crash the process. The flush itself is
  instrumented at the agent level (`buffer_flush_total{result:'error'}`); the
  scheduler's own `setTimeout` catch remains uncounted at the scheduler level (a
  minor recorded gap).
- **Clean shutdown.** `close()` clears every pending timer so no dangling handle
  keeps the event loop (and the process) alive.

## Load-bearing invariant: the timeout must stay positive

`InMemoryBufferScheduler.schedule` treats `delayMs <= 0` as "fire the handler
**inline** (synchronously, awaited)" rather than via `setTimeout`. That path is a
foot-gun for the conversation lock.

`handleInboundImpl` (and `flushImpl`'s locked segments and `finalizeTurn`) call
`scheduler.schedule` **while holding that same key's lock.** The scheduler's flush
handler runs `flushImpl`, which re-acquires that key's lock for its segments. If
`schedule` fired the handler inline, the handler would immediately try to acquire
a lock the current call already holds — a self-deadlock that wedges the
conversation.

The safety net is that `calculateBufferTimeout` never returns `<= 0` for a valid
config: `bufferBaseTimeoutMs` is a positive integer, and the jitter clamp floors
the result at `bufferBaseTimeoutMs × 0.5 > 0`. So `schedule` always takes the
`setTimeout` branch and the handler fires later, outside the held lock.

**This invariant is load-bearing — keep it if the buffer math changes.** The
reasoning is documented inline in both `handleInboundImpl` (the
`LOCK SAFETY` comment) and `calculateBufferTimeout`, and recorded in
[Known gaps](../KNOWN-GAPS.md). See
[Conversation state](./conversation-state.md#per-conversation-serialization-load-bearing)
for the lock itself.

## Testing

[`tests/unit/conversation-buffering.test.ts`](../../tests/unit/conversation-buffering.test.ts)
drives `calculateBufferTimeout` with an injected `random` so the
growth curve, the cap, the zero-noise short-circuit, and the jitter clamp bounds
are all deterministic.
[`tests/unit/conversation-scheduler.test.ts`](../../tests/unit/conversation-scheduler.test.ts)
covers reschedule-replaces-timer, trace propagation, the
`delayMs <= 0` inline path, and `close()` cleanup. The aggregation behavior is
proven end-to-end with `vi.useFakeTimers()` in
[`tests/integration/end-to-end-flow.test.ts`](../../tests/integration/end-to-end-flow.test.ts).

## Known limitations

- In-memory scheduler only; timers are per-process and lost on restart. BullMQ is
  Stage 10.
- The scheduler's own `setTimeout` failure catch is uncounted at the scheduler
  level (the flush is instrumented at the agent level via `buffer_flush_total`).

See [Known gaps](../KNOWN-GAPS.md) and [Architecture](../ARCHITECTURE.md).
