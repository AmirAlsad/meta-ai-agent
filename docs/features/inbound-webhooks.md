# Inbound Webhooks

## What it does

Receives Meta webhooks for all three products on a single endpoint, answers the verification handshake, verifies the signature against the raw body, ACKs 200 immediately, parses the payload into a normalized `IncomingMessage[]` / `StatusUpdate[]` via [Message parsing](./message-parsing.md), and emits structured per-event logs (with trace context + webhook metrics). When a [`ConversationAgent`](./conversation-state.md) is wired (which the runtime bootstrap does), the dispatcher then routes each parsed message/status into it — the agent dedupes across redeliveries, buffers rapid bursts, calls the developer's chat endpoint, and delivers the reply through channel-aware ordered delivery.

## How it works

The Express app exposes these routes today (mounted in `createApp` in [`src/http/app.ts`](../../src/http/app.ts)):

- `GET /health` — liveness (status, uptime in seconds, package version from `package.json`, node version).
- `GET /webhook` — Meta verification handshake.
- `POST /webhook` — Signed inbound delivery for all three channels.
- (Anything else returns `404 not_found`.)

### GET /webhook — verification handshake

When the webhook URL is saved in the Meta App Dashboard (or programmatically via `POST /{META_APP_ID}/subscriptions`), Meta sends:

```
GET /webhook?hub.mode=subscribe&hub.verify_token=<your_token>&hub.challenge=<random>
```

The handler accepts the request iff `hub.mode === 'subscribe'` **and** `hub.verify_token === config.meta.verifyToken`. On match it responds `200 text/plain` with the challenge value echoed in the body. Any other mode (e.g. `unsubscribe`) or a mismatched token returns `403`.

The same handshake is used by each product configured against the same callback URL — Meta sends one handshake per product subscription.

### POST /webhook — signed inbound delivery

The route stack is:

1. `express.json({ limit: '5mb', verify })` — captures the raw bytes onto `req.rawBody` before parsing. See [Webhook security](./webhook-security.md) for why this is required.
2. `createMetaSignatureVerifier(secrets, logger)` — verifies `X-Hub-Signature-256` against `req.rawBody` with constant-time HMAC comparison. `secrets` is the candidate set `[META_APP_SECRET, ...(INSTAGRAM_APP_SECRET if set)]`; the verifier accepts a match against any of them, because Instagram signs with `INSTAGRAM_APP_SECRET` rather than `META_APP_SECRET` (see [Webhook security](./webhook-security.md)). Returns `400 raw_body_unavailable` (server-config bug) or `401 invalid_signature` on failure, before the route handler runs.
3. Route handler — pulls the request-scoped trace context off `res.locals` (set by `traceMiddleware`), responds `200 EVENT_RECEIVED` **first**, then `void`s `dispatchWebhook(req.body, logger, config, agent, { metrics, traceId, requestLogger })`. The promised return value is discarded on the route path (it stays unit-testable via `dispatchWebhook` directly); the trailing `.catch` is belt-and-suspenders so a fire-and-forget rejection can never become an unhandled rejection. The agent is supplied here by the runtime bootstrap ([`src/index.ts`](../../src/index.ts)), so each parsed `IncomingMessage` reaches `agent.handleInbound` and each `StatusUpdate` reaches `agent.handleStatus`.

The ACK-then-dispatch ordering is non-negotiable. Meta retries any non-2xx response with exponential backoff for up to 7 days, then permanently drops the event. There is no replay API. Slow processing inside the handler would queue thousands of duplicate deliveries; processing asynchronously after the 200 keeps Meta's retry loop quiet.

### Current dispatcher behavior

`dispatchWebhook(body, logger, config, agent?, opts?)` performs these steps in order. The signature is async (it awaits the agent calls — see the routing step); `agent` and `opts` (`{ metrics?, traceId?, requestLogger? }`) are optional, so parse+log-only callers (e.g. the webhook-routing tests, which construct the app without an agent) get identical parse/log behavior:

1. **Identify the channel** from `body.object` via `objectToChannel`:

   | `object` value | Channel |
   | --- | --- |
   | `whatsapp_business_account` | `whatsapp` |
   | `page` | `messenger` |
   | `instagram` | `instagram` |
   | anything else / missing / wrong type | `unknown` |

2. **Parse** the body with `parseMetaWebhook(body)` from [`src/meta/parser.ts`](../../src/meta/parser.ts). The parser is documented as non-throwing; the dispatcher wraps the call in a defensive `try`/`catch` as a safety net. If it ever fires, the dispatcher logs at `error`:

   ```
   { err, channel, msg: 'dispatcher parse failed unexpectedly' }
   ```

   and falls back to an empty `ParseResult`. The 200 ACK has already been sent at this point, so the catch is non-fatal.

3. **Emit per-message logs**, one per `IncomingMessage` returned by the parser. Fields:

   ```
   {
     channel, traceMarker: 'inbound.message', messageType, channelMessageId,
     channelScopedUserId, channelScopedBusinessId, timestamp,
     isEcho, hasMedia, hasReplyTo
   }
   ```

   Messages with `type === 'unknown'` log at `warn`; everything else logs at `info`. The dedicated `warn` level is the only signal that an unmodeled inbound landed — keep it for observability.

4. **Emit per-status logs**, one per `StatusUpdate`. Always `info`. Fields include `channel`, `traceMarker: 'inbound.status'`, `channelMessageId`, `status`, `timestamp`, and (when present) `errorCode` / `errorTitle`.

5. **Emit the per-channel summary log** as the final log entry (before the agent routing). This `traceMarker: 'inbound.{channel}'` shape is stable and asserted by the integration tests, kept stable for downstream log-driven assertions:

   ```
   { channel, entryCount, messageCount, statusCount, traceMarker: 'inbound.whatsapp' }
   ```

   Unknown channels log at `warn` with `traceMarker: 'inbound.unknown'` and an `objectField` for debugging; known channels log at `info`.

6. **Route into the conversation agent** when one is supplied. After the logs (so the asserted log shapes are unchanged), the dispatcher awaits each parsed message into `agent.handleInbound` and each status into `agent.handleStatus` in a **sequential** loop — the route already ACKed 200 and dispatched this via `void`, so awaiting here doesn't affect the response; it only preserves intra-webhook **order** (a single webhook routinely batches several messages for one conversation). The agent's per-key serialization lock independently prevents the read-modify-write clobber, and every `handle*` is fail-soft (it logs and swallows internally, never throwing out), so the loop cannot reject. The trace context (`traceId` + request-scoped child `logger`) is threaded into each call so the agent's log lines — and the `traceId` it persists on the conversation record — chain back to the originating webhook. With no agent wired the loop is skipped entirely.

Throughout, when a `metrics` handle is supplied the dispatcher increments `webhook_received_total{channel,result}` (`accepted`, or `parse_error` on the defensive catch, plus `webhook_parse_failures_total`). The `traceMarker` log values are stable and asserted by the integration tests — preserve them.

> The parser-emitted `media` shape carries only `id` / `url` / `mimeType` / etc. — it does **not** include the base64 `MediaInfo.dataUrl`. That field is populated later (and only when enabled) by the agent's optional inbound media-hydration step on the flush path; see [Inbound media hydration](./media-hydration.md).

### Postbacks and referrals

Postbacks (button taps — including Get Started, persistent-menu items, and
[ice-breaker](./instagram-platform.md#ice-breakers) taps) and referrals (`m.me` /
`ig.me` link clicks carrying a `ref` parameter, plus ad clicks) are **ordinary
inbound events with no special routing path.** The Stage 2 parser normalizes them
into [`IncomingMessage`](./message-parsing.md):

- a postback → `type: 'postback'` with a `postback: { title?, payload }` field
  (`PostbackInfo`);
- a referral → `type: 'referral'` with a `referral: { source, type, ref?, … }` field
  (`ReferralInfo`).

From there they ride the **generic inbound buffer** in the conversation agent
exactly like any text/media/reaction message: `handleInbound` claims, dedupes,
appends to the per-conversation buffer, and on flush they reach the developer's chat
endpoint inside [`ChatRequest.messages[]`](./rich-chat-actions.md) with their
structured fields intact. There is **no** postback/referral-specific dispatch.

A **text-less postback still flushes** — the buffer flush is not gated on a message
having text, so a postback (which often carries no `text`, only a `payload`) is never
silently dropped. The chat endpoint sees it in `messages[]` and decides what to do
(e.g. route on `postback.payload` to a canned reply). This is proven end-to-end by
[`tests/integration/postback-referral.test.ts`](../../tests/integration/postback-referral.test.ts),
which POSTs real signed Messenger-postback / Messenger-referral / Instagram-referral
fixtures and asserts the structured payload survives the full
parse → buffer → flush path into `ChatRequest.messages[]`.

See [Rich chat actions](./rich-chat-actions.md) for the chat request/response
contract and [Message parsing](./message-parsing.md) for how postback/referral
events are normalized (and the note on their synthetic dedupe ids).

### End-to-end behavior summary

The full inbound → agent → outbound pipeline runs today. The webhook route handles receipt/verification/ACK/parse; the [conversation agent](./conversation-state.md) handles everything from cross-payload dedupe onward.

| Step | Owner | Status |
| --- | --- | --- |
| Receive POST | route | done |
| Verify signature | route ([Webhook security](./webhook-security.md)) | done — multi-secret (incl. `INSTAGRAM_APP_SECRET`) |
| ACK 200 | route | done — before parse |
| Capture raw body | route (`express.json({ verify })`) | done |
| Identify channel | dispatcher (`objectToChannel`) | done |
| Parse channel payload | dispatcher ([Message parsing](./message-parsing.md)) | done |
| Per-payload dedupe | parser — by `channelMessageId` | done |
| Cross-payload dedupe | agent — atomic `claimInboundHandle` (SETNX-with-TTL) | done |
| Buffer rapid bursts | agent ([Message buffering](./message-buffering.md)) | done |
| Call chat endpoint | agent ([Rich chat actions](./rich-chat-actions.md)) | done |
| Send outbound reply | agent → channel adapter ([Ordered delivery](./ordered-delivery.md)) | done |
| Track delivery status | agent → status tracker ([Status tracking](./status-tracking.md)) | done |

## Code files

| File | Role |
| --- | --- |
| [`src/http/app.ts`](../../src/http/app.ts) | Express composition. Mounts `express.json({ verify })`, `traceMiddleware`, GET `/health`, GET `/ready`, GET `/webhook`, POST `/webhook` (with signature verifier), and the token-gated `/metrics` + `/admin/*` routes. Defines `objectToChannel` and `dispatchWebhook` (which routes into the agent when one is wired). |
| [`src/http/security.ts`](../../src/http/security.ts) | `createMetaSignatureVerifier` Express middleware. |
| [`src/http/trace.ts`](../../src/http/trace.ts) | `traceMiddleware` (validates/echoes `x-trace-id`, puts a pino child on `res.locals`) + `requestContextFromLocals`. |
| [`src/conversation/agent.ts`](../../src/conversation/agent.ts) | `ConversationAgent` — `handleInbound` / `handleStatus` consume the dispatcher's parsed output (dedupe, buffer, chat call, ordered outbound). See [Conversation state](./conversation-state.md). |
| [`src/meta/parser.ts`](../../src/meta/parser.ts) | `parseMetaWebhook` plus per-channel parsers. See [Message parsing](./message-parsing.md) for the normalized shape. |
| [`src/meta/types.ts`](../../src/meta/types.ts) | Raw + normalized type declarations. |
| [`src/config/loader.ts`](../../src/config/loader.ts) | `Config` shape consumed by `createApp`. Provides `verifyToken` and `appSecret`. |
| [`tests/integration/webhook-routing.test.ts`](../../tests/integration/webhook-routing.test.ts) | Channel-dispatch routing tests, handshake tests, signature-rejection paths, `/health` liveness, dispatcher defensive-catch coverage. |
| [`tests/integration/end-to-end-flow.test.ts`](../../tests/integration/end-to-end-flow.test.ts) | Full inbound path with a real store/scheduler/queue/agent (only the chat endpoint + adapters faked): webhook → signature → parse → buffer flush → chat → ordered send. |

## Persistence and durability

The inbound route and its agent routing are complete, and the Stage 10 hardening that touches this path has landed: the dedupe/store and buffer scheduler are now **dual-path** — selected on `REDIS_URL`. With Redis configured, `RedisConversationStore` provides atomic cross-replica `SET NX`-with-TTL dedupe, `BullMqBufferScheduler` replaces the in-memory buffer scheduler, and `recoverPendingRetries()` re-arms persisted transient retries at boot (fire-and-forget in `buildRuntime`). Without `REDIS_URL`, the in-memory store + scheduler run (per-process, lost on restart). The route shape itself does not change either way. See [Persistence](./persistence.md) and [Rate limiting](./rate-limiting.md).

See [Architecture](../ARCHITECTURE.md) for the full module map and [`meta-ai-agent-implementation-plan.md`](../../meta-ai-agent-implementation-plan.md) for the staged roadmap.

## Configuration

- `META_APP_SECRET` — used by the signature verifier to validate WhatsApp + Messenger POSTs.
- `INSTAGRAM_APP_SECRET` — used by the signature verifier to validate Instagram POSTs (Instagram signs with its own secret; the verifier tries all configured secrets). Optional, but inbound IG webhooks `401` without it.
- `META_VERIFY_TOKEN` — echoed during the GET handshake; must be at least 16 chars.
- Channel pairs (`WHATSAPP_*`, `MESSENGER_*`, `INSTAGRAM_*`) — determine the `channels` flags on `Config`. Inbound routing does not gate on channel-enabled (an unknown or unconfigured `object` is logged but still ACKed); the agent short-circuits an unconfigured channel before outbound — at flush, a missing adapter drops the turn (logged `no adapter for channel`) rather than attempting a send.

See [Configuration](./configuration.md) for the full list.

## Known limitations

- Unknown `object` values are logged but still ACKed. This is correct behavior — Meta could introduce new products under the same App in the future, and we should not retry-loop those into our queue.
- Cross-payload dedupe (across Meta redeliveries) is the conversation agent's responsibility (`claimInboundHandle`) — the parser only dedupes within a single delivery. The in-memory claim store is per-process; the Redis-backed `RedisConversationStore` (Stage 10, selected on `REDIS_URL`) makes that dedupe cross-replica-safe via atomic `SET NX` with native TTL eviction. See [Persistence](./persistence.md).
- The per-request `traceId` is in the logs but the per-dispatch webhook logs still emit channel-scoped user ids at `info` (debuggability over redaction on the hot path); gating that PII remains an accepted gap. The admin-route output is already PII-redacted.
- Fixtures driving the integration tests remain documentation-derived. The `npm run capture:guided` tooling promotes redacted live captures into `tests/fixtures/meta/captured/`.
