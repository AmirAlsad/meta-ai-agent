# Inbound Webhooks

## What it does

Receives Meta webhooks for all three products on a single endpoint, answers the verification handshake, verifies the signature against the raw body, ACKs 200 immediately, parses the payload into a normalized `IncomingMessage[]` / `StatusUpdate[]` via [Message parsing](./message-parsing.md), and emits structured per-event logs. Dedupe, buffering, the chat call, and outbound delivery land in Stages 4–5.

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
3. Route handler — responds `200 EVENT_RECEIVED` **first**, then calls `dispatchWebhook(req.body, logger, config)`. The return value is currently discarded on the route path; Stage 5 will hand it to the conversation agent.

The ACK-then-dispatch ordering is non-negotiable. Meta retries any non-2xx response with exponential backoff for up to 7 days, then permanently drops the event. There is no replay API. Slow processing inside the handler would queue thousands of duplicate deliveries; processing asynchronously after the 200 keeps Meta's retry loop quiet.

### Current dispatcher behavior

`dispatchWebhook(body, logger, config)` performs five steps in order:

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

5. **Emit the per-channel summary log** as the final entry. This is the same `traceMarker: 'inbound.{channel}'` shape Stage 1 emitted, kept stable for downstream log-driven assertions:

   ```
   { channel, entryCount, messageCount, statusCount, traceMarker: 'inbound.whatsapp' }
   ```

   Unknown channels log at `warn` with `traceMarker: 'inbound.unknown'` and an `objectField` for debugging; known channels log at `info`.

The integration tests assert these `traceMarker` values — preserve them when extending the dispatcher in Stage 5 (conversation agent).

### Stages 1–2 behavior summary

| Step | Stages 1–2 | Stages 3+ |
| --- | --- | --- |
| Receive POST | yes | yes |
| Verify signature | yes | yes |
| ACK 200 | yes | yes |
| Capture raw body | yes | yes |
| Identify channel | yes | yes |
| Parse channel payload | yes — [Message parsing](./message-parsing.md) | yes |
| Per-payload dedupe | yes — by `channelMessageId` | yes |
| Cross-payload dedupe | no | yes (Stage 5) |
| Buffer rapid bursts | no | yes (Stage 5) |
| Call chat endpoint | no | yes (Stage 5) |
| Send outbound reply | no | yes (Stages 4 + 5) |
| Track delivery status | no | yes (Stages 5 + 6) |

## Code files

| File | Role |
| --- | --- |
| [`src/http/app.ts`](../../src/http/app.ts) | Express composition. Mounts `express.json({ verify })`, GET `/health`, GET `/webhook`, POST `/webhook` (with signature verifier). Defines `objectToChannel` and `dispatchWebhook`. |
| [`src/http/security.ts`](../../src/http/security.ts) | `createMetaSignatureVerifier` Express middleware. |
| [`src/meta/parser.ts`](../../src/meta/parser.ts) | `parseMetaWebhook` plus per-channel parsers. See [Message parsing](./message-parsing.md) for the normalized shape. |
| [`src/meta/types.ts`](../../src/meta/types.ts) | Raw + normalized type declarations. |
| [`src/config/loader.ts`](../../src/config/loader.ts) | `Config` shape consumed by `createApp`. Provides `verifyToken` and `appSecret`. |
| [`tests/integration/webhook-routing.test.ts`](../../tests/integration/webhook-routing.test.ts) | Channel-dispatch routing tests, handshake tests, signature-rejection paths, `/health` liveness, dispatcher defensive-catch coverage. |

## Planned next steps

- **Stage 5** introduces `ConversationAgent` (`src/conversation/agent.ts`). The route handler will replace the `void dispatchWebhook(...)` line with a handoff that dedupes by `channelMessageId` across payloads, resolves the conversation key, buffers rapid bursts, calls the chat endpoint, and enqueues outbound responses through channel-aware ordered delivery.

See [Architecture](../ARCHITECTURE.md) for the planned module map and [`meta-ai-agent-implementation-plan.md`](../../meta-ai-agent-implementation-plan.md) for the staged roadmap.

## Configuration

- `META_APP_SECRET` — used by the signature verifier to validate WhatsApp + Messenger POSTs.
- `INSTAGRAM_APP_SECRET` — used by the signature verifier to validate Instagram POSTs (Instagram signs with its own secret; the verifier tries all configured secrets). Optional, but inbound IG webhooks `401` without it.
- `META_VERIFY_TOKEN` — echoed during the GET handshake; must be at least 16 chars.
- Channel pairs (`WHATSAPP_*`, `MESSENGER_*`, `INSTAGRAM_*`) — determine the `channels` flags on `Config`. Routing does not gate on channel-enabled today (an unknown `object` is logged but still ACKed); Stage 4+ will short-circuit unconfigured channels before outbound.

See [Configuration](./configuration.md) for the full list.

## Known limitations (Stages 1–2)

- The dispatcher still discards the parsed result on the route path. Stage 5 will hand it to the conversation agent.
- Unknown `object` values are logged but still ACKed. This is correct behavior — Meta could introduce new products under the same App in the future, and we should not retry-loop those into our queue.
- There is no per-request trace ID middleware yet (planned for Stage 6). Logs include stable `traceMarker` fields for grep-ability instead.
- Cross-payload dedupe (across Meta redeliveries) is the conversation agent's responsibility — the parser only dedupes within a single delivery.
- Fixtures driving the integration tests remain documentation-derived. Stage 3's `npm run capture:guided` will replace them with redacted live captures.
