# DM volume stats

Durable, per-account, per-channel, per-UTC-day counters for the three volumes worth
knowing about a DM surface: **`conversations_started`**, **`messages_in`**,
**`messages_out`**. Written by three hooks in the conversation agent, read back through
the token-gated `GET /stats/daily`, and consumed by a marketing repo that pulls them
once a day and joins them against its own content record.

Source: [`src/stats/store.ts`](../../src/stats/store.ts) (`StatsStore`,
`InMemoryStatsStore`, the date/key helpers), [`src/stats/redis-store.ts`](../../src/stats/redis-store.ts)
(`RedisStatsStore`), the `countStat` hooks in
[`src/conversation/agent.ts`](../../src/conversation/agent.ts), the route in
[`src/http/app.ts`](../../src/http/app.ts), and the selection in
[`src/index.ts`](../../src/index.ts).

## Why this is not the Prometheus counters

`src/metrics` already counts inbound and outbound messages, and is the wrong instrument
for this. Those counters are labelled by **channel only** (an account label would be
unbounded cardinality — see [Operational visibility](./operational-visibility.md#bounded-labels-the-cardinality-guard)),
they live in an in-process collector, and they **reset on every deploy**. DM volume is a
marketing number read weeks later, keyed by date, and attributed to a specific coach
account. It has to outlive the process.

The other half of the reason is external: **Meta serves no Instagram DM metric at all**,
and the Facebook Page counters that do exist attribute nothing — not the account within a
Page's inbox, not the piece that prompted the message. So the transport is not a
convenient second source; it is the only one.

## What each counter means

| Metric | Incremented | Hook site |
| --- | --- | --- |
| `messages_in` | one per accepted inbound message | after the dedupe claim in `handleInboundImpl`, so Meta's 7-day redelivery of the same id cannot double-count, and past the echo filter, so the agent's own output is never counted as audience traffic |
| `conversations_started` | one per `getConversation` **miss** | the `??` was split into an explicit `existing === undefined` branch, because that miss is the only point in the transport where a new conversation is distinguishable from a continuing one — a line later the record exists and the distinction is gone |
| `messages_out` | one per outbound item that makes a real Graph send | beside `limitTracker.recordOutbound`, behind the same `makesGraphSend` gate, so the two accounting side-effects stay in lock-step on exactly the same items. A typing bubble is not a message; a retried send that eventually succeeds passes here exactly once |

**`conversations_started` counts fresh threads, not unique people.** Conversation records
expire on `CONVERSATION_TTL_SECONDS`, so a user returning after the TTL counts again. That
matches the reading the number is for, and no cheaper signal exists — the transport keeps
no identity beyond the record it just failed to find.

## The account is the key, and an unresolved one is skipped

Counters are keyed on the **account name** (`reed`, `iris`, …), not the business id: the
account name is what the consumer joins on, and it is already the identity the agent puts
on every `ChatRequest`. Resolution goes through the same `AdapterRegistry.resolve` call the
outbound path uses, so there is exactly one mapping from a record to an account in the
class.

**When it does not resolve, the count is skipped and warned — never filed under a
placeholder.** `resolve` returns undefined only on a genuinely multi-account channel
receiving traffic for an identity this deploy does not serve, which is the same condition
under which the flush path drops the turn as unanswerable; the skipped count is a message
this transport never handled. A sentinel account (`unknown`) is worse than a gap: it is
indistinguishable from a real account of that name, and a wrong number read weeks later is
unrecoverable where a missing one is visible.

## Fail-open, and the one guard that looks redundant

`StatsStore.increment` **never throws** — the same rule the limits tracker states for its
own window counters. A store failure (Redis down, a malformed clock) is logged and
swallowed, and the message goes out anyway: a lost count is cheaper than a lost reply.

`countStat` nevertheless wraps the call in its own `try`/`catch`, and **that is not
belt-and-braces**. The `messages_out` hook sits inside `sendNext`'s `try`, whose `catch`
classifies the error and may schedule a **retry of a send that already succeeded**. A
store that broke its contract would therefore not merely lose a count — it would send a
second copy of a DM to a real person. The contract is a promise made by a module the agent
does not own, and a counter must not be able to cause a double-send. The inbound hooks
carry the same guard for the same reason at lower stakes: a throw there lands in
`handleInboundImpl`'s catch and would drop the message instead of buffering it.

The full argument lives in the doc comment on `countStat` in
[`src/conversation/agent.ts`](../../src/conversation/agent.ts). Do not simplify either
layer away without reading it.

## Storage

Both implementations are selected on the same branch as the conversation and limits
stores, over the **same shared Redis client** — one more keyspace on a connection that is
already open, never a second connection. `RedisStatsStore.close()` is deliberately a no-op
because the client is borrowed and the runtime owns its lifecycle.

**`RedisStatsStore` (durable).** One Lua script per increment:

```lua
local v = redis.call('INCR', KEYS[1])
if v == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
redis.call('SADD', KEYS[2], ARGV[2])
```

- Keys are `meta-ai-agent:stats:day:{account}:{channel}:{metric}:{YYYY-MM-DD}`, TTL =
  `STATS_RETENTION_DAYS`, so history self-evicts and costs nothing to clean up.
- **Lua rather than a bare `INCR` + `EXPIRE`**: if the key were evicted between the two,
  `INCR` recreates it *without* a TTL and that day becomes immortal. `EVAL` is atomic
  Redis-side, so the `PEXPIRE` always lands on the first increment of a fresh date.
- **The bucket is the UTC calendar date**, not `floor(now / DAY_MS)` the way the limits
  windows are. These numbers are read as dates; a bucket index that has to be converted
  back on every read is the wrong shape.
- **Reads never use `KEYS` or `SCAN`.** `range` enumerates the dates in the requested span
  itself and reads exactly those keys with chunked `MGET`, so a read is bounded by the span
  the caller asked for rather than by the size of the keyspace. What it cannot enumerate
  that way is which (account, channel) pairs exist, so the `SADD` folded into the same
  script maintains a small index set — a counter can never exist without an index entry
  pointing at it. An index member naming a channel this build does not know is skipped
  rather than trusted, because the set outlives any single deploy.
- **Key segments are percent-escaped** (`:` → `%3A`, `%` → `%25`, reversibly). Without it
  an account literally named `a:b` and an account `a` on a channel `b` would produce the
  same key — two accounts silently sharing a counter, a corrupted number nobody would ever
  notice. Escaping rather than rejecting, because `increment` must neither throw nor drop.

**`InMemoryStatsStore`.** A `Map` per (date, account, channel), per-process and lost on
restart, for tests, local runs and single-replica deploys without Redis. Unlike the limits
in-memory store — whose keyspace is small and fixed — this one grows by a row per active
day forever, so it applies `retentionDays` itself, sweeping only when the written date
**changes** (once per UTC day in a steady process).

Both stores return the same rows in the same order (date, then account, then channel, by
code point rather than locale), omit any (date, account, channel) that counted nothing, and
report `0` for the other metrics on a row that counted one.

## Reading it: `GET /stats/daily`

```
GET /stats/daily?since=2026-08-01&until=2026-08-10
Authorization: Bearer <STATS_API_TOKEN>        # or: x-stats-api-token: <token>
```

```json
{ "days": [
  { "date": "2026-08-10", "account": "iris", "channel": "messenger",
    "conversations_started": 0, "messages_in": 1, "messages_out": 0 },
  { "date": "2026-08-10", "account": "reed", "channel": "instagram",
    "conversations_started": 1, "messages_in": 2, "messages_out": 1 }
] }
```

`since` is required; `until` defaults to today (UTC), which is also how the store buckets.
A span that counted nothing is `{ "days": [] }` and a 200, not a 404.

Route mechanics, the registration guard, and the **two-token separation** (this route
takes `STATS_API_TOKEN` and rejects the admin token; `/admin/*` and `/metrics` reject
this one; `loadConfig` refuses a config where the two are equal) are documented in
[Operational visibility](./operational-visibility.md#two-tokens-and-why-the-stats-reader-does-not-get-the-admin-one).

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `STATS_API_TOKEN` | unset | Gates `/stats/daily`. Unset ⇒ the route is not mounted (404). ≥16 chars, and **must differ from `ADMIN_API_TOKEN`** or the process refuses to boot. |
| `STATS_RETENTION_DAYS` | `400` | Days of history kept. A bit over a year, so a read can always compare this month against the same month last year. Capped at `MAX_RANGE_DAYS` (1000): retaining more than one `range()` call can enumerate would store days that are paid for and unreadable through the route that exists to read them. |

No store-specific enable flag exists: the store is always constructed, and the counters
are simply not reachable until a token mounts the route.

## Known limits

- **No backfill, ever.** Counters start at zero when the feature deploys and Redis holds
  no message history to reconstruct from. The series begins on deploy day.
- **No attribution to a piece of content.** Nothing maps an inbound DM to the post that
  prompted it. The join is *available* — [`src/comments/ig-poller.ts`](../../src/comments/ig-poller.ts)
  already carries `postId` — but it needs the comment path live, which it is not.
- **No unique-people count and no response latency.** Both were considered and left out;
  the first would need identity retention the counters deliberately do not have.
- **`whatsapp` is counted here and dropped downstream.** The store counts every channel;
  the marketing consumer files `messenger` under Facebook, `instagram` under Instagram, and
  drops WhatsApp because no account there publishes to it.
- **The (account, channel) index set has no TTL.** It is one small set holding a member per
  pair ever seen, so a pair that goes quiet keeps costing a handful of missing-key reads in
  `range` (they read as `0` and the row is dropped). Bounded by the number of accounts, not
  by traffic or time.
