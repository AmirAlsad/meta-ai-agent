# Persistence (Redis + BullMQ)

The Stage 10 production persistence path swaps the per-process in-memory
conversation store and buffer scheduler for Redis-backed implementations that
survive restarts and coordinate across replicas. It is opt-in: the entire path is
selected on `REDIS_URL`. With the URL unset, the runtime keeps the in-memory trio
(fine for tests, local runs, and single-replica deploys); with it set, the runtime
wires a `RedisConversationStore`, a `BullMqBufferScheduler`, and a
`RedisLimitCounterStore` (the rate-limiter's counter store —
see [Rate limiting](./rate-limiting.md)) over **one shared** ioredis client.

This document covers the dual-path selection, the Redis key schema and TTLs, the
BullMQ scheduler (and its load-bearing job-id constraint), the shared-client
lifecycle, and the real `/ready` Redis ping.

Source: [`src/conversation/redis-store.ts`](../../src/conversation/redis-store.ts),
[`src/conversation/scheduler.ts`](../../src/conversation/scheduler.ts)
(`BullMqBufferScheduler`),
[`src/conversation/store.ts`](../../src/conversation/store.ts) (the interface),
[`src/index.ts`](../../src/index.ts) (`buildRuntime` selection),
[`src/http/app.ts`](../../src/http/app.ts) (the `/ready` ping),
[`src/config/loader.ts`](../../src/config/loader.ts) (`PersistenceConfig`,
`loadRedisUrl`).

Cross-links: [Conversation state](./conversation-state.md),
[Message buffering](./message-buffering.md),
[Operational visibility](./operational-visibility.md).

## What it does

- **Durable, shared conversation state.** `RedisConversationStore` holds the same
  three things `InMemoryConversationStore` does — conversation records, the inbound
  dedupe set, and the outbound-handle map — but in Redis, so state survives a
  restart and is shared across replicas. Crucially, the inbound dedupe claim becomes
  a real atomic `SET ... NX` (the in-memory map is per-process, so a webhook
  redelivered to a *different* replica would be reprocessed), and
  `listConversationKeys` is a non-blocking `SCAN` (used by Stage 10 boot recovery —
  see [Rate limiting → boot recovery](./rate-limiting.md#boot-recovery)).
- **Durable buffer flush timers.** `BullMqBufferScheduler` schedules each
  conversation's buffer-flush as a delayed BullMQ job, so a pending flush is not
  lost on restart and is processed by exactly one worker across the fleet.
- **Real readiness signal.** `GET /ready` PINGs the shared Redis client (bounded by
  a timeout) instead of merely reporting "configured".

## Dual-path selection

`buildRuntime(config, logger)` in [`src/index.ts`](../../src/index.ts) builds the
persistence trio (conversation store + buffer scheduler + the rate-limiter's
counter store) by branching on `config.redisUrl`:

| `REDIS_URL` | Conversation store | Buffer scheduler | Limit counter store | `redis` client |
| --- | --- | --- | --- | --- |
| set | `RedisConversationStore` | `BullMqBufferScheduler` | `RedisLimitCounterStore` | one shared ioredis client |
| unset | `InMemoryConversationStore` | `InMemoryBufferScheduler` | `InMemoryLimitCounterStore` | `undefined` |

On the Redis path, ONE ioredis client (`new Redis(config.redisUrl, {
maxRetriesPerRequest: null })`) backs both the conversation store and the
limit-counter store. `maxRetriesPerRequest: null` is required because the same
client class is reused with BullMQ-style long-lived-connection semantics; a finite
retry budget would let long-lived blocking calls error out. The BullMQ scheduler is
the exception — it owns its **own** connections (it needs a blocking one for the
worker), so it takes the URL, not this client.

The Stage 6 metrics collector, status tracker, and contact-store cache stay
in-memory in **both** paths — their Redis-backed swaps with TTL eviction are tracked
separately (see [Known gaps](../KNOWN-GAPS.md)).

`buildRuntime` returns `{ app, agent, close }`. The aggregate `close()` closes the
agent first (which clears the scheduler's timers, closes the BullMQ scheduler's own
connections, and runs the store / limit-tracker no-op closes) and then disconnects
the shared client exactly once.

## Redis key schema and TTLs

All keys are namespaced under the prefix `meta-ai-agent:`
([`src/conversation/redis-store.ts`](../../src/conversation/redis-store.ts)):

| Key | Value | Write op | TTL |
| --- | --- | --- | --- |
| `conversation:{key}` | the `ConversationRecord` as JSON | `SET ... EX conversationTtlSeconds` | `conversationTtlSeconds` (default 86400) |
| `dedupe:inbound:{channelMessageId}` | `'1'` | `SET ... EX dedupeTtlSeconds NX` (atomic claim) | `dedupeTtlSeconds` (default 86400) |
| `outbound:{channelMessageId}` | the `OutboundHandleMapping` as JSON | `SET ... EX conversationTtlSeconds` | `conversationTtlSeconds` |

`{key}` is the `{channel}:{businessId}:{userId}` conversation key
(see [Conversation state → keying](./conversation-state.md#conversation-keying)).

A few load-bearing details:

- **Atomic dedupe.** `claimInboundHandle` is a single `SET ... NX` — the first caller
  within the TTL gets `'OK'` (process it), any redelivery (on any replica) gets
  `null` (skip). This is the real cross-replica version of the in-memory map's
  presence-with-expiry simulation.
- **`peekInboundHandle` issues `TTL` alone** (no `EXISTS`-then-`TTL`): ioredis returns
  `-2` for an absent key and `-1` for a present key with no expiry, which avoids the
  `EXISTS → TTL` TOCTOU window.
- **Clone-on-read/write is implicit.** Every value crosses the wire via a fresh
  `JSON.stringify` / `JSON.parse`, so a returned record is already a detached copy —
  the in-memory store's explicit deep-clone discipline is satisfied for free.
- **Corrupt JSON is treated as absent.** A value that fails to parse (manual edit,
  partial write, schema drift) logs a warn and resolves to `undefined` rather than
  throwing — a throw here would crash the inbound handler *after* the 200 ACK (no
  Meta retry), losing the event. The agent then rebuilds a fresh record.
- **`listConversationKeys` uses `SCAN`** (`MATCH conversation:*`, `COUNT 200`) and
  yields the BARE key with the prefix stripped, matching the in-memory impl's output
  so boot recovery is identical across stores.

## The BullMQ buffer scheduler

`BullMqBufferScheduler` (`kind: 'bullmq'`) in
[`src/conversation/scheduler.ts`](../../src/conversation/scheduler.ts) implements the
same `BufferScheduler` interface as `InMemoryBufferScheduler` — one outstanding
flush per conversation, re-scheduling replaces the prior timer — but as a BullMQ
delayed job. Five load-bearing design choices:

1. **Two SEPARATE connections.** The Worker uses blocking Redis commands
   (`BRPOPLPUSH` etc.) to wait for jobs and so monopolizes its connection; it cannot
   share the Queue's connection. The scheduler constructs both as explicit `Redis`
   instances it owns (so `close()` can disconnect them deterministically), each with
   `maxRetriesPerRequest: null` (required by BullMQ). The Worker's connection is
   created lazily in `setHandler`.
2. **`attempts: 1` — the AGENT owns retry.** The flush handler
   (`ConversationAgent`'s buffer flush) is fail-soft and owns its own
   retry/rebatch/interrupt logic at the application layer; letting BullMQ *also* retry
   a failed job would double-process. The buffer job is "fire once".
3. **`removeOnComplete: true`** (succeeded jobs are dropped; `removeOnFail: 100`
   keeps the last few failures for debugging).
4. **The job id is colon-free (load-bearing).** The job id is
   `buffer-<base64url(conversationKey)>`. BullMQ FORBIDS `:` in a custom job id (it
   reserves `:` as its own Redis key delimiter and throws `Custom Id cannot contain
   :`) — and conversation keys are `{channel}:{businessId}:{userId}`, *all colons*.
   Base64url-encoding the key yields a colon-free, collision-free, stable id, so a
   re-schedule REPLACES the prior job (one outstanding flush per conversation). The
   human-readable conversation key rides in `job.data`. **Do not** switch the id back
   to the raw `buffer:{key}` form — it will throw on the first schedule.
5. **Worker `concurrency` defaults to 10 (NOT 1).** The flush handler `await`s the
   slow chat-endpoint call, so `concurrency: 1` would serialize EVERY conversation's
   flush behind one in-flight chat call — losing the parity with the in-memory
   scheduler, whose independent `setTimeout`s interleave flushes across conversations.
   Parallel flushes are safe because each acquires only its per-conversation key lock.
   Tunable via `BUFFER_WORKER_CONCURRENCY` (`config.persistence.bufferWorkerConcurrency`).
   `cancel()` also tolerates BullMQ throwing when a job has just gone ACTIVE (a
   worker picked it up in the gap before re-schedule) — the remove failure is
   swallowed; the flush proceeds on the existing schedule and the message is already
   buffered, so the conversation still makes forward progress.

`getStats()` reports `delayed` (the count of scheduled-with-future-delay jobs) for
the `/ready` introspection. A worker-level error or a failed job is logged, never
allowed to become an unhandled rejection. `close()` closes the worker and queue and
disconnects both owned connections.

## Shared-client lifecycle: borrowed, not owned

The Redis conversation store and the rate-limiter's Redis counter store are handed
the **shared** client; they do not construct or own it. Both implement `close()` as
an intentional **no-op** — disconnecting the shared client there would tear the
connection out from under the other consumer (and the `/ready` ping). The runtime is
the single owner: `buildRuntime`'s returned `close()` disconnects the client once,
after closing the agent. The BullMQ scheduler is the exception — it owns its own
connections and disconnects them in *its* `close()` (invoked by `agent.close()`).

## The `/ready` Redis ping

With the Redis-backed store available, `buildRuntime` also hands the shared client to
`createApp` (as `redisClient`), so `GET /ready` can issue a real ping. The redis
check in `buildReadinessReport`
([`src/http/app.ts`](../../src/http/app.ts)) has three outcomes:

| Condition | `checks.redis.status` | Readiness |
| --- | --- | --- |
| `config.redisUrl` unset | `not_configured` | ready |
| set, but no `redisClient` injected | `configured` (presence-only — nothing to ping) | ready |
| set, WITH a `redisClient` | `ping()` raced against `readyRedisTimeoutMs` (default 2000): resolved → `ok`; rejection or timeout → `error` | `ok` ready / `error` fails readiness (503) |

The ping is raced against a cleared-on-settle timeout so neither a hung Redis nor a
dangling timer can wedge the probe, and the whole check sits in a defensive
try/catch so it degrades that one check rather than 500ing the route. (This replaces
the Stage 6 presence-only check — see [Operational
visibility → the `/ready` check shape](./operational-visibility.md#the-ready-check-shape).)

The scheduler check in the same report carries the impl `kind`
(`in_memory` / `bullmq`) and its stats, so a scrape of `/ready` shows which scheduler
backs the deploy.

## Configuration

`config.persistence` ([`src/config/loader.ts`](../../src/config/loader.ts)) plus the
`REDIS_URL` toggle. Every field has a default and is range-validated at load
(fail-fast, naming the offending env var).

| Env var | Default | Used for |
| --- | --- | --- |
| `REDIS_URL` | unset | Selects the Redis path. When set, `loadRedisUrl` validates it parses as a `redis:` / `rediss:` URL and throws otherwise (a typo'd or wrong-scheme paste fails at boot, not deep in the client). |
| `CONVERSATION_TTL_SECONDS` | `86400` | TTL for Redis conversation records + outbound-handle mappings. |
| `BUFFER_QUEUE_NAME` | `meta-ai-buffer-timers` | BullMQ queue name for the buffer-flush scheduler. |
| `READY_REDIS_TIMEOUT_MS` | `2000` | Timeout for the `GET /ready` Redis ping. |
| `DEDUPE_TTL_SECONDS` | `86400` | TTL for the inbound dedupe claim (shared with the in-memory store; lives in `config.conversation`). |

## Testing

Redis-backed tests are gated on the `TEST_REDIS_URL` env var so the default
`npm test` run stays hardware-free (CI never needs a Redis): every Redis test file
uses `const describeRedis = process.env.TEST_REDIS_URL ? describe : describe.skip`,
so without the var the suite SKIPS those tests. To run them locally against a real
Redis:

```bash
TEST_REDIS_URL=redis://127.0.0.1:6399 npm run test:integration
```

- `tests/unit/redis-store.test.ts` — drives `RedisConversationStore` against a real
  Redis: the key schema/TTLs, the atomic `SET NX` dedupe, the `TTL`-only peek, the
  outbound-handle round-trip, the corrupt-JSON-as-absent path, and `SCAN`-based
  `listConversationKeys`.
- `tests/integration/redis-store.test.ts` — the store **and** the
  `BullMqBufferScheduler` end-to-end against Redis (the base64url job id, the
  replace-on-reschedule behavior, `getStats().delayed`).
- `tests/integration/persistence-selection.test.ts` — proves `buildRuntime` selects
  the in-memory trio with `REDIS_URL` unset and the Redis trio when it is set (the
  Redis branch gated on `TEST_REDIS_URL`).
- `tests/integration/ready-redis.test.ts` — the `/ready` check matrix
  (`not_configured` / `configured` / `ok` / `error` + timeout), runnable without a real
  Redis (the ping client is a fake).

See [Testing](../TESTING.md) for the full suite and totals.

## Known limitations

- The metrics collector, status tracker, and contact-store cache stay in-memory in
  the Redis path too — only the conversation store, buffer scheduler, and
  rate-limit counter store are Redis-backed. Their Redis swaps with TTL eviction are
  deferred. See [Known gaps](../KNOWN-GAPS.md).
- Boot recovery (re-arming pending transient retries from durable state) runs only
  against a durable store; against the in-memory store it is a no-op. See
  [Rate limiting → boot recovery](./rate-limiting.md#boot-recovery).

See [Known gaps](../KNOWN-GAPS.md) for the full deferral list and
[Architecture](../ARCHITECTURE.md) for where this layer sits in the runtime.
