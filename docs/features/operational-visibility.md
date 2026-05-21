# Operational visibility

## What it does

Stage 6 adds the operator-facing surface: health/readiness probes, Prometheus metrics, per-request trace correlation, and PII-redacted admin introspection. This is the reference for running and debugging the agent in production.

The whole surface is constructed in [`src/http/app.ts`](../../src/http/app.ts) (routes + guards) and wired in [`src/index.ts`](../../src/index.ts) (the in-memory collector, status tracker, contact cache, and `createAgentMetrics`).

## Route table

| Path | Auth | Mounted when |
| --- | --- | --- |
| `GET /health` | none | always |
| `GET /ready` | none | always |
| `GET /metrics` | token | `ADMIN_API_TOKEN` set **and** a metrics collector wired |
| `GET /admin/conversations/:key` | token | `ADMIN_API_TOKEN` set **and** a conversation store wired |
| `GET /admin/status/:messageId` | token | `ADMIN_API_TOKEN` set **and** a status tracker wired |

- `GET /health` (always, unauthenticated) returns `{ status: 'ok', uptimeSeconds, version, nodeVersion }`.
- `GET /ready` (always, unauthenticated) returns the readiness report (below). 503 when any check fails, 200 otherwise.
- `GET /metrics` returns Prometheus text exposition (token-gated).
- `GET /admin/conversations/:key` returns a PII-redacted `ConversationRecord` (token-gated; `?reveal=true` unmasks).
- `GET /admin/status/:messageId` returns a PII-redacted `StatusRecord` (token-gated; `?reveal=true` unmasks). See [Status tracking](./status-tracking.md).

### The registration guard: token unset → 404, not 401

`GET /metrics` and the two `/admin/*` routes are **guarded at registration**. When `ADMIN_API_TOKEN` is unset (or the backing dep isn't wired) the route handler is never registered with Express, so a request falls through to the catch-all and returns **404**, not 401:

```typescript
if (config.adminApiToken && metricsCollector) {
  app.get('/metrics', (req, res) => { /* validateAdminToken ... */ });
}
```

The rationale: a 401-on-an-always-mounted route would *advertise* that an admin surface exists on a deploy that hasn't configured a token. Returning 404 means an un-configured admin surface is indistinguishable from a route that doesn't exist. `/health` and `/ready` are the only always-on, unauthenticated routes.

When the token *is* set, the route is mounted and an absent/wrong token returns **401** (`{ error: 'unauthorized' }`).

### Constant-time auth

`validateAdminToken` ([`src/http/auth.ts`](../../src/http/auth.ts)) accepts either `Authorization: Bearer <token>` or `x-admin-api-token: <token>` and compares against the expected token with `crypto.timingSafeEqual`. The comparison is constant-time even on a length mismatch: `constantTimeStringEquals` allocates a padded buffer and still runs `timingSafeEqual` so a length-mismatched probe spends a comparison cost proportional to the provided length, narrowing the timing channel.

## The `/ready` check shape

`buildReadinessReport` ([`src/http/app.ts`](../../src/http/app.ts)) never throws — each check is wrapped so a thrown check degrades to `{ status: 'error' }` for that check (and fails overall readiness) rather than 500ing the route. Response shape:

```json
{
  "status": "ready",
  "checks": {
    "scheduler": { "status": "ok", "kind": "in_memory", "stats": { } },
    "redis": { "status": "not_configured" }
  }
}
```

- `checks.scheduler` — calls `scheduler.getStats()`; `ok` if it resolves (carrying the impl `kind` + stats), `error` if it throws (which fails readiness → 503), or `not_configured` when no scheduler is wired (still ready).
- `checks.redis` — `not_configured` when `REDIS_URL` is unset (ready); `configured` when set but no client was injected (ready, presence-only — nothing to ping); and, when the Redis-backed runtime injects the shared client (Stage 10), a **real timeout-bounded `ping()`** raced against `READY_REDIS_TIMEOUT_MS` (default 2000) → `ok` (ready) or `error` (a rejection/timeout fails readiness → 503). See [Persistence → the `/ready` Redis ping](./persistence.md#the-ready-redis-ping).

## Metrics

### Collector → registry → prometheus

The metrics layer is provider-agnostic and split into three pieces:

1. **Collector** ([`src/metrics/collector.ts`](../../src/metrics/collector.ts)) — the `MetricsCollector` interface (`counter` / `gauge` / `histogram` / `snapshot`). Two implementations: `InMemoryMetricsCollector` (the runtime default) and `NoopMetricsCollector` (when metrics are not configured). Re-registering the same metric name returns the existing handle (and throws on a kind mismatch).
2. **Registry** ([`src/metrics/registry.ts`](../../src/metrics/registry.ts)) — `createAgentMetrics(collector)` registers the full set of named handles once per `createApp`, defining each metric's label keys and bucket boundaries. This is the source of truth for cardinality and buckets.
3. **Prometheus** ([`src/metrics/prometheus.ts`](../../src/metrics/prometheus.ts)) — `renderPrometheus(snapshot)` emits the text exposition; `PROMETHEUS_CONTENT_TYPE` is `text/plain; version=0.0.4; charset=utf-8`. Label values are escaped (backslash, quote, newline, carriage return) so a stray `\r` can't break the line-oriented parser.

### The named handles

`AgentMetrics` ([`src/metrics/registry.ts`](../../src/metrics/registry.ts)):

| Metric | Type | Labels |
| --- | --- | --- |
| `webhook_received_total` | counter | `channel`, `result` |
| `webhook_parse_failures_total` | counter | `channel`, `reason` |
| `inbound_dedupe_total` | counter | `result` |
| `inbound_messages_total` | counter | `channel`, `type` |
| `chat_dispatch_duration_seconds` | histogram | `result` |
| `outbound_send_total` | counter | `channel`, `operation`, `result`, `error_code` |
| `outbound_send_duration_seconds` | histogram | `channel`, `operation` |
| `status_callback_total` | counter | `channel`, `status` |
| `delivery_timeout_fired_total` | counter | (none) |
| `identity_lookup_total` | counter | `result` |
| `buffer_flush_total` | counter | `result` |
| `agent_up` | gauge | (none) |
| `agent_build_info` | gauge | `version` |

`agent_up` (always 1 while serving) and `agent_build_info` (version in the label) are set at construction in [`src/index.ts`](../../src/index.ts), so a scrape right after boot already shows the process up with its version. The histograms use `DEFAULT_LATENCY_BUCKETS_SECONDS` (`0.005` … `30`).

### Bounded labels (the cardinality guard)

Label values are frequently derived from external input (Meta error codes, message types, channels). A buggy upstream or hostile sender could emit an unbounded stream of distinct values, OOMing the process. Two guards keep cardinality bounded:

- **Enum labels.** `channel`, `type`, `result`, `operation`, `status` are bounded enums, never raw user ids or message text. The `error_code` label is normalized through `normalizeErrorCodeLabel`, which folds any code outside a pinned known set into `other` (and a missing code into `none`).
- **Per-metric cardinality cap.** `InMemoryMetricsCollector` caps distinct label combinations per metric at `DEFAULT_LABEL_CARDINALITY_LIMIT` (1000). Once the cap is hit, further series fold into a single `__overflow__` sentinel series and a one-shot warn log fires. Memory stays bounded while the overflow is still visible.

This is load-bearing: metric labels must never carry raw ids or message text. See [CLAUDE.md](../../CLAUDE.md).

## Tracing

`traceMiddleware` ([`src/http/trace.ts`](../../src/http/trace.ts)) issues or accepts an `x-trace-id` per request:

- An inbound `x-trace-id` is **validated against `^[A-Za-z0-9._:-]{1,128}$`** before it is trusted. On any mismatch (including CR/LF / space / `<` injection payloads, or an oversized value) a fresh `randomUUID` is minted instead. This is the injection guard: the trace id is echoed back in a response header and stamped into structured log lines and the pino child's bindings, so reflecting untrusted bytes would enable header/log injection (log forging).
- The validated (or minted) id is echoed in the `x-trace-id` response header.
- A pino **child logger** (`logger.child({ traceId, route })`) is stored on `res.locals`; handlers pull both via `requestContextFromLocals(res)`.

The middleware is mounted **after** `express.json` (so the raw-body `verify` hook still captures `req.rawBody` for signature verification) and **before** every route. The webhook dispatcher threads `{ traceId, logger }` into the agent's `handle*` calls, so a conversation's log lines — and the `traceId` it persists on the record — chain back to the originating webhook. Because the agent persists the `traceId`, a delivery/read status that lands minutes later can be tied back to the conversation that produced it.

## Redaction (allow-list / fail-closed)

Admin output is redacted **by default** because a `ConversationRecord` is a goldmine of PII — the user's channel-scoped id (a `wa_id` is the user's phone number), the resolved contact (name, email), and the verbatim text of every buffered inbound and queued outbound. The redactors live in [`src/http/redaction.ts`](../../src/http/redaction.ts).

The policy is **allow-list / fail-closed**: the inbound/outbound/record/status redactors do **not** spread the source and mask a deny-list. They build a NEW object copying only explicitly allow-listed structural (non-PII) fields, mask the known content fields, and drop everything else. A field added to `IncomingMessage` / `OutboundItem` / `ConversationRecord` / `StatusRecord` later is therefore **omitted** from the masked view unless someone deliberately allow-lists it — new PII fails closed. (`redactContact` is the one intentional exception that spreads — see the note below.)

`?reveal=true` (authenticated only) is the escape hatch: it returns the source untouched.

### Coverage summary

| Disposition | Fields |
| --- | --- |
| **Masked** | `channelScopedUserId` (`maskId`, last-4 suffix); message `text` / `media.caption` / `postback.payload` / `flowResponse.bodyText` (`maskText`, length-only — no prefix); contact `firstName`/`lastName`/`displayName` (`maskName`), `email` (`maskEmail`); the user segment of the conversation `key`; `StatusRecord.recipientId` + `StatusRecord.conversationKey` user segment. |
| **Dropped to `[redacted]`** | `media.url` / `media.filename`; `storyReply.url`; `storyMention.url`; `referral.ctwaClid` / `sourceUrl` / `headline` / `body`; `flowResponse.responseJson`; the per-message `raw` payload; outbound `mediaUrl` / `templateComponents`. |
| **Kept verbatim (non-PII)** | `channel`, `type`, `timestamp`, our `channelMessageId`, `channelScopedBusinessId` (our side), `isEcho`, `replyTo`, `forwarded`, media `mimeType`/`id`/`sha256`/`voice`/`animated`, reaction `targetMessageId`/`emoji`/`action`, `postback.title`, `referral.source`/`type`/`ref`/`sourceId`, `flowResponse.name`; conversation `state` / indices / our send ids / timestamps / `traceId`; status `current` / `history` / `firstSeenAt` / `lastUpdatedAt`. |

`maskText` is length-only by default (`[redacted N chars]`) — even a 5-char body becomes `[redacted 5 chars]`, never the body — so an operator can correlate "the long one" / "the empty one" by length without reading the content.

> **`redactContact` exception.** Contact `tags`, `customVariables`, and `unifiedContactId` are developer-supplied operational metadata (e.g. `tier:gold`), not inherently Meta user PII, so `redactContact` spreads the contact and keeps them intact (it masks only name/email/user-id). A developer who puts PII into `customVariables` will see it in admin output — a recorded gap (see [Known gaps](../KNOWN-GAPS.md) and [Identity resolution](./identity-resolution.md)).

## Code files

| File | Role |
| --- | --- |
| [`src/http/app.ts`](../../src/http/app.ts) | All routes + the registration guards + `buildReadinessReport`. |
| [`src/http/trace.ts`](../../src/http/trace.ts) | `traceMiddleware`, the `x-trace-id` injection guard, the pino child logger. |
| [`src/http/auth.ts`](../../src/http/auth.ts) | `validateAdminToken` + constant-time `constantTimeStringEquals`. |
| [`src/http/redaction.ts`](../../src/http/redaction.ts) | Allow-list / fail-closed redactors + the `mask*` helpers. |
| [`src/metrics/collector.ts`](../../src/metrics/collector.ts) | `MetricsCollector` interface, `InMemoryMetricsCollector` (cardinality cap), `NoopMetricsCollector`. |
| [`src/metrics/registry.ts`](../../src/metrics/registry.ts) | `createAgentMetrics`, the named handles, `normalizeErrorCodeLabel`. |
| [`src/metrics/prometheus.ts`](../../src/metrics/prometheus.ts) | `renderPrometheus`, `PROMETHEUS_CONTENT_TYPE`. |
| [`src/index.ts`](../../src/index.ts) | Wires the in-memory collector/tracker/contact-store and passes the deps into `createApp`. |
| [`src/config/loader.ts`](../../src/config/loader.ts) | `ADMIN_API_TOKEN` (≥16 chars), `USER_LOOKUP_URL`, `USER_LOOKUP_TIMEOUT_MS`. |

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `ADMIN_API_TOKEN` | unset | Gates `/metrics` + `/admin/*` (constant-time bearer check). When unset, those routes are not mounted (404). When set, must be ≥16 chars (≥32 recommended). |
| `REDIS_URL` | unset | Selects the Stage 10 Redis persistence path; surfaced in `/ready` as `not_configured` / `configured` / a real `ping()` (`ok`/`error`) when the Redis runtime injects the client. See [Persistence](./persistence.md). |

See [Configuration](./configuration.md) for the full env reference (including the identity knobs).

## Known limitations

- **`/ready` Redis check does a real ping (Stage 10)** when the Redis-backed runtime injects a client; presence-only otherwise. See [Persistence](./persistence.md#the-ready-redis-ping).
- **Per-dispatch webhook logs still emit channel-scoped ids at `info`** — Stage 6 redacts only the admin-route *output*, not the dispatch logs. Gating dispatch-log PII is still deferred.
- **`contact.tags` / `customVariables` are not redacted** in admin output.
- **Webhook signature-rejection metric is not wired** — rejections appear in warn logs only; `webhook_received_total` counts only signature-valid requests (the verifier 401s before the counter).
- **Identity metric is coarse** (`resolved` / `none` / `disabled`).
- **In-memory metrics/status/contact stores are unbounded** (apart from the metric cardinality cap) — Stage 10 made the conversation store, buffer scheduler, and limit-counter store Redis-backed, but these three stores stay in-memory in both paths; their Redis swaps with TTL eviction are still deferred (see [Known gaps](../KNOWN-GAPS.md)).

See [Known gaps](../KNOWN-GAPS.md), [Status tracking](./status-tracking.md), [Read receipts](./read-receipts.md), [Identity resolution](./identity-resolution.md), and [Configuration](./configuration.md).
