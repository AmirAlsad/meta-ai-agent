# Architecture

## Overview

`meta-ai-agent` receives Meta webhooks for WhatsApp Cloud API, Facebook Messenger, and Instagram DMs on a single endpoint, verifies signatures against the raw request body, routes by channel, and (in later stages) parses each channel's payload into a normalized message, calls a developer-provided chat endpoint, and delivers replies through the appropriate channel adapter using channel-aware ordered delivery.

The package stays transport/orchestration focused: the developer owns the chat endpoint and any model, prompt, account, or product logic behind it.

## Single Meta App, three products, one webhook URL

A single Meta App can host all three messaging products at once. All three deliver to the same callback URL and use the same `X-Hub-Signature-256` HMAC scheme — but they do **not** all sign with the same secret: WhatsApp and Messenger sign with `META_APP_SECRET`, while Instagram signs with the Instagram product's own `INSTAGRAM_APP_SECRET` (verified against the live API 2026-05-20). The verifier tries all configured secrets — see [Webhook security](./features/webhook-security.md). They are distinguished by the top-level `object` field on the webhook body:

| `object` value | Product | User ID | Business ID | Token type |
| --- | --- | --- | --- | --- |
| `whatsapp_business_account` | WhatsApp Cloud API | `wa_id` (E.164) | `phone_number_id` | System User Access Token |
| `page` | Messenger Platform | PSID | Page ID | Page Access Token |
| `instagram` | Instagram (Business Login) | IGSID | IG User ID | Instagram User Access Token |

`objectToChannel(req.body.object)` in `src/http/app.ts` maps each value to a `Channel` (`'whatsapp' | 'messenger' | 'instagram' | 'unknown'`). The `dispatchWebhook` function uses that to log/route. Anything else returns `unknown` and is warn-logged but still ACKed with 200.

## Data flow

```
Meta POST /webhook (any channel)
   |
   v
express.json({ verify }) -- captures req.rawBody before parse
   |
   v
createMetaSignatureVerifier -- HMAC-SHA256 over rawBody, constant-time compare
   |           \
   | 401 invalid_signature / 400 raw_body_unavailable
   v
ACK 200 EVENT_RECEIVED  (sent first; processing is async, fire-and-forget)
   |
   v
dispatchWebhook(req.body)
   |       \-- objectToChannel(req.body.object) -> whatsapp | messenger | instagram | unknown
   v
parseMetaWebhook(req.body) -> ParseResult { messages, statuses }
   |  (non-throwing; dispatcher catches any unexpected throw and logs at error)
   v
per-message log (inbound.message; warn iff type==='unknown')
per-status  log (inbound.status)
summary     log (inbound.{channel}; warn for unknown)
   |
   v
[Stage 5+: ConversationAgent (cross-payload dedupe, buffer, chat dispatch, ordered outbound)]
[Stage 4+: ChannelAdapter.sendText / sendTypingIndicator / markRead / sendReaction]
[Stage 6+: StatusTracker, IdentityResolver, MetricsCollector]
```

Meta retries any non-2xx response with exponential backoff for up to 7 days, then permanently drops the event. There is no replay API. The handler is the dead-letter queue. The POST route sends the 200 before invoking the dispatcher.

## Currently implemented (Stages 1–3)

| Module | Source | Role |
| --- | --- | --- |
| Config loader | [`src/config/loader.ts`](../src/config/loader.ts) | Reads env, validates per-channel pairs, throws on partial config or missing required fields. Defaults `META_GRAPH_API_VERSION` to `v25.0`. Requires `NGROK_DOMAIN` (bare hostname; validated against scheme/path/dot). Exposes optional `WhatsAppConfig.businessAccountId` for the per-WABA subscribe step. |
| Signature verifier | [`src/http/security.ts`](../src/http/security.ts) | `verifyMetaSignature(rawBody, header, appSecret)` and the Express middleware factory `createMetaSignatureVerifier`. Constant-time compare; rejects malformed/short hex without throwing on `timingSafeEqual`. |
| Express app | [`src/http/app.ts`](../src/http/app.ts) | `createApp({ config, logger })`. Mounts `GET /health`, `GET /webhook`, `POST /webhook`. Captures raw body via `express.json({ verify })`. Defines `objectToChannel` and `dispatchWebhook` for channel routing, parsing, and structured per-event logging. |
| Webhook types | [`src/meta/types.ts`](../src/meta/types.ts) | Raw per-channel envelopes (`WhatsAppWebhookPayload`, `MessengerWebhookPayload`, `InstagramWebhookPayload`) plus normalized cross-channel shapes (`IncomingMessage`, `StatusUpdate`, `ParseResult`, `MessageType`, supporting info types). |
| Webhook parser | [`src/meta/parser.ts`](../src/meta/parser.ts) | `parseMetaWebhook` dispatcher + `parseWhatsAppWebhook` / `parseMessengerWebhook` / `parseInstagramWebhook`. Non-throwing; normalizes timestamps to ms, unflips echoes, per-payload dedupe by `channelMessageId`, CTWA / Flow / forwarded / story-mention / story-reply surfacing. See [Message parsing](./features/message-parsing.md). |
| Bootstrap | [`src/index.ts`](../src/index.ts) | Loads `.env`, builds a pino logger (pretty in non-prod), calls `createApp`, and `app.listen()` unless `AGENT_AUTOSTART=0` or `NODE_ENV=test`. Wires SIGINT/SIGTERM. |
| Setup library | [`scripts/lib/`](../scripts/lib/) | `tunnel.ts` (ngrok via `@ngrok/ngrok`), `graph-api.ts` (`buildGraphUrl`, `buildInstagramGraphUrl`, `MetaApiError`, `graphFetch`, `subscribeMessengerPageApp`, `subscribeInstagramApp`, `subscribeWhatsAppBusinessAccount`, `setWebhookSubscriptionConfig`, `listWebhookSubscriptions`), `console.ts` (status helpers, `ask` / `confirm` / `pause` / `waitFor`, `registerShutdown` registry), `capture-server.ts` (Express + tunnel + in-memory ring with the same signature middleware as production). |
| Setup scripts | [`scripts/setup/`](../scripts/setup/) | `register-webhooks.ts` (`registerAllWebhooks`, `inspectExistingSubscriptions`, `SUBSCRIBED_FIELDS`), `oauth-instagram.ts` (Business Login OAuth → ~60d long-lived token), `oauth-messenger.ts` (Facebook Login for Business OAuth → User Token → `/me/accounts` → scope-controlled Page Access Token), `verify-shared.ts` (bootstrap + predicates + summary), `verify-{whatsapp,messenger,instagram,all}.ts` (per-channel guided verification). |
| Capture scripts | [`scripts/capture/`](../scripts/capture/) | `fixture-capture.ts` (passive capture, one file per delivery), `guided-capture.ts` (scenario walker emitting self-describing wrappers under `.captures/meta/{channel}/`). |
| Unit tests | [`tests/unit/`](../tests/unit/) | Config loader (11), security middleware (18), parser (63), graph-api helpers (35), register-webhooks (17), oauth-instagram pure helpers (27 — includes `parseAuthorizeUrl` / `withState` / `hasExistingInstagramValue` helpers added when the script was refactored to read the embed URL from env), oauth-messenger pure helpers (24 — URL builders, `parseFlags`, `hasExistingMessengerPageToken`, `selectPage`), verify-shared CLI + predicates + summary (36), capture-server (10), fixture-capture pure helpers (10), guided-capture scenarios + flag parser (26). |
| Integration test | [`tests/integration/webhook-routing.test.ts`](../tests/integration/webhook-routing.test.ts) | Full Express pipeline via supertest. Asserts dispatcher routing, per-channel summary logs, per-message / per-status logs, signature rejection, handshake, `/health` liveness, and the dispatcher's defensive catch (15 tests). |
| Fixtures | [`tests/fixtures/meta/{whatsapp,messenger,instagram}/`](../tests/fixtures/meta/) | Documentation-derived payloads exercising every parser branch. See [Testing](./TESTING.md) for the inventory. |

`scripts/lib/capture-server.ts` is a **separate Express app** from `src/http/app.ts`. The runtime path needs to dispatch to the conversation agent (Stage 5+); the capture path needs to record bit-faithful payloads without side effects. Both apply the same signature middleware so app-secret typos still fail at the door, but they diverge after the verification step — the capture path emits an in-memory event + an on-disk file rather than calling the dispatcher. See [Payload capture](./features/payload-capture.md) for the rationale.

## Planned (Stages 4–10)

The implementation plan ([`meta-ai-agent-implementation-plan.md`](../meta-ai-agent-implementation-plan.md)) defines the staged rollout. None of the following exists in `src/` yet.

- **Stage 4 — Outbound send adapters.** `src/meta/shared/graph-client.ts` (versioned URL builder, retries, error envelope), `src/meta/shared/errors.ts` (`MetaApiError`), `src/meta/{whatsapp,messenger,instagram}/client.ts`. Common `ChannelAdapter` interface with `sendText`, `sendTypingIndicator`, `markRead`, `sendReaction`, and a `supports(feature)` capability check.
- **Stage 5 — Conversation agent.** `src/conversation/agent.ts` (`ConversationAgent`), `src/conversation/buffering.ts`, `src/conversation/{store,redis-store}.ts`, `src/chat/{client,contract,types}.ts`, `src/delivery/queue.ts`. Conversation keys: `whatsapp:{phoneNumberId}:{wa_id}`, `messenger:{pageId}:{psid}`, `instagram:{igUserId}:{igsid}`. Channel-aware queue advancement (WhatsApp advances on `delivered`; Messenger/Instagram advance on successful API response because they lack per-message delivery callbacks).
- **Stage 6 — Status tracking, identity, operational visibility.** `src/status/tracker.ts`, `src/identity/{resolver,contact-store}.ts`, `src/metrics/{collector,prometheus}.ts`, `src/http/{trace,auth,redaction}.ts`. New routes: `GET /ready`, `GET /metrics` (token-gated), `GET /admin/conversations/:key`, `GET /admin/status/:messageId`.
- **Stage 7 — Rich features.** Media send/download (`src/meta/shared/media.ts`), templates (`src/meta/whatsapp/templates.ts`), reactions, reply-to. `ChannelAdapter` gains `sendImage`, `sendAudio`, `sendVideo`, `sendDocument`.
- **Stage 8 — Platform-specific surfaces.** Messenger Profile API (Get Started button, Persistent Menu, Ice Breakers, greeting text), Instagram Ice Breakers, Instagram Private Replies (comment → DM with `recipient: { comment_id }`).
- **Stage 9 — Examples and REPL.** `examples/{minimal-chat-endpoint,multi-channel-router,showcase-bot}/`, `scripts/repl.ts`.
- **Stage 10 — Production hardening.** Redis persistence (conversation state, dedupe via `SET NX`, BullMQ for delayed buffer processing), per-channel rate limiting, WhatsApp messaging-window awareness, boot-time `recoverPendingRetries`, additional `loadConfig` validation (token format, version regex).

## Key design decisions

- **Single endpoint for three products.** Routing by `object` is simpler and matches Meta's design (one App, one webhook URL, one secret). It also keeps signature verification uniform across channels.
- **Raw-body capture before parsing.** `express.json({ verify })` is the only safe place to copy the bytes Meta signed — by the time the JSON body lands on `req.body`, whitespace and key order are gone. Any future middleware that needs to read the body must respect `req.rawBody`.
- **ACK before dispatch.** The POST handler sends `200 EVENT_RECEIVED` before calling `dispatchWebhook`. Meta's retry behavior (7 days of exponential backoff) means slow processing would queue thousands of duplicate deliveries. This is non-negotiable.
- **Identity is a tuple, not a unified user.** Meta does not link `wa_id`, PSID, and IGSID. The package will model identity as `(channel, channelScopedId)` and leave cross-channel merging to the developer's identity resolver (Stage 6).
- **Adapters expose capabilities, not a uniform interface.** Stage 4's `ChannelAdapter.supports('template')` returns `false` for Instagram. The conversation agent must branch on capability rather than assume features are uniformly available.

## Known limitations (Stages 1–3)

- The parsed `ParseResult` is discarded on the route path after logging. Stage 5 will hand it to the `ConversationAgent`.
- No outbound for production runtime: the only outbound code today is the per-channel verify-script smoke tests (`hello_world` template, Messenger reply, Instagram reply) — those are setup-time tools, not runtime adapters. Stage 4 builds the full `ChannelAdapter` surface.
- No cross-payload dedupe, persistence, identity resolution, or rate limiting yet.
- Fixtures under `tests/fixtures/meta/` are documentation-derived. Real Meta payloads always differ in subtle ways; the Stage 3 `npm run capture:guided` tooling exists for this exact purpose — promoted captures land under `tests/fixtures/meta/captured/` after manual redaction.
- See [Known gaps](./KNOWN-GAPS.md) for items intentionally deferred (CTWA pricing/conversation blocks, order/contact attachments, IG `story_mention.id` semantics, Dashboard programmatic config gaps, token refresh automation).
