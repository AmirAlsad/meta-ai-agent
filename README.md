# meta-ai-agent

Messaging infrastructure for deploying an AI agent over Meta's three messaging platforms — WhatsApp Cloud API, Facebook Messenger, and Instagram DMs — under a single Meta App.

This package is intentionally transport and orchestration focused. The developer brings a chat endpoint; this package handles webhook ingestion, signature verification, outbound delivery, status tracking, deduplication, conversation intelligence, and cross-channel identity normalization.

> **Status: Stage 9 of 10 — webhook ingestion + payload parsing + setup verification + payload capture + outbound send adapters + conversation agent + operational visibility + media send & WhatsApp templates + platform-specific surfaces + examples & a local REPL.** Configuration loading, `X-Hub-Signature-256` verification on the raw body, the Meta verification handshake, channel routing by the top-level `object` field, a non-throwing parser that normalizes WhatsApp / Messenger / Instagram payloads into a single `IncomingMessage` / `StatusUpdate` shape with per-payload dedupe and ms-normalized timestamps, an interactive setup-verification + capture toolkit (per-channel verify scripts, Instagram OAuth, programmatic webhook subscription, passive capture, scenario-driven guided capture), outbound send clients for all three channels (text, typing indicators, read receipts, reactions, WhatsApp templates, and media send) built on a shared runtime Graph API client with retry/backoff and a common `ChannelAdapter` interface, the conversation agent (inbound burst buffering, the chat-endpoint contract, ordered channel-aware outbound delivery, an in-memory conversation store with cross-payload dedupe, and per-conversation serialization), the Stage 6 operational surface (delivery-status tracking, optional fail-open identity enrichment, metrics, per-request tracing, and health/ready/metrics/admin routes with PII-redacted output), the Stage 8 platform-specific surfaces (the Messenger Profile API — Get Started, persistent menu, ice breakers, greeting; Instagram ice breakers; and Instagram private replies for the comment-to-DM funnel, plus a `setup:profile` config script), and the Stage 9 examples (an echo endpoint, a channel-aware multi-channel router, and an LLM-backed showcase bot) plus a local REPL that runs the full inbound→chat→outbound loop with no Meta account. Postbacks and referrals ride the generic inbound buffer to the chat endpoint with no special routing. Persistence (Redis/BullMQ), full rate limiting, and out-of-window template enforcement land in Stage 10. See [`meta-ai-agent-implementation-plan.md`](./meta-ai-agent-implementation-plan.md) for the full roadmap.

## Quick start

```bash
git clone <this-repo>
cd meta-ai-agent
npm install
cp .env.example .env
# Fill in META_APP_ID, META_APP_SECRET, META_VERIFY_TOKEN, CHAT_ENDPOINT_URL,
# and credentials for at least one channel (WhatsApp, Messenger, or Instagram).
# For Instagram, additionally set INSTAGRAM_AUTHORIZE_URL (the embed URL from the
# Meta App Dashboard) + INSTAGRAM_APP_SECRET, then run `npm run setup:oauth:instagram`
# to capture a long-lived (~60d) Instagram User Access Token.
# For Messenger, if you need scopes beyond what the Dashboard "Generate Token" button
# yields (pages_read_engagement, pages_manage_metadata), set MESSENGER_LOGIN_CONFIG_ID
# to a Facebook Login for Business configuration id, then run `npm run setup:oauth:messenger`.
npm run dev
```

The server listens on `PORT` (default `3000`) and exposes:

- `GET /webhook` — Meta verification handshake (`hub.mode`, `hub.verify_token`, `hub.challenge`).
- `POST /webhook` — Signed webhook intake. Verifies `X-Hub-Signature-256` against the raw body, ACKs `200 EVENT_RECEIVED`, then dispatches by `req.body.object` (`whatsapp_business_account` / `page` / `instagram`).
- `GET /health` — Liveness probe (uptime, package version, node version).
- `GET /ready` — Readiness probe (scheduler + Redis-presence checks; 503 on a failed check).
- `GET /metrics`, `GET /admin/conversations/:key`, `GET /admin/status/:messageId` — Stage 6 operational routes, token-gated and mounted only when `ADMIN_API_TOKEN` is set (see below).

Stage 3 setup + capture tooling (real Meta App + ngrok required):

```bash
npm run setup:oauth:instagram    # OAuth → long-lived (~60d) Instagram token
npm run setup:oauth:messenger    # FB Login for Business → scope-controlled Page Access Token
npm run setup:all                # End-to-end verify across every configured channel
npm run meta:webhooks            # Programmatic webhook subscription (or --inspect)
npm run setup:profile -- --config=<path>   # Apply Messenger Profile + IG ice breakers from a JSON config
npm run capture:guided           # Interactive scenario-driven payload capture
npm run capture:fixtures         # Passive capture server
```

See [Meta setup guide](./docs/META-SETUP-GUIDE.md) for end-to-end onboarding.

To run hardware-free tests (no Meta credentials needed):

```bash
npm test            # unit + integration
npm run typecheck   # tsc --noEmit
```

For live testing against real devices (dev-only tooling — needs real Meta credentials + ngrok), `npm run dev:loop` boots the test chat endpoint, the real conversation agent, a tunnel, and webhook registration in one process so you can exercise the full conversation loop, and `npm run probe:outbound` fires each outbound send method at real recipients to confirm what Meta accepts. See [Testing](./docs/TESTING.md) for details and the 2026-05-20 live-verification milestone.

### Try it locally (no Meta account)

The fastest way to see the whole inbound→chat→outbound loop is the local REPL — it boots one of the example chat endpoints together with the real conversation agent, wired to fake "console" channel adapters that print outbound instead of calling Meta, so it needs no Meta App, no ngrok, and no credentials:

```bash
npm install
npm run example:chat -- minimal-chat-endpoint   # type a line; watch the agent buffer, call the endpoint, and "send" the reply
```

Type messages at the prompt; `/help` lists the commands (`/channel`, `/media`, `/reaction`, `/status`, `/raw`, `/reset`). Swap in `multi-channel-router` to drive the channel-aware, capability-driven example. To run an example against a real device instead (real Graph API sends + ngrok + webhook registration), use `npm run example:dev -- <example>`. See [`examples/README.md`](./examples/README.md) for the three examples (including the LLM-backed showcase bot, a separate package) and both runners.

## Architecture overview

The runtime is a single Express app composed in `src/http/app.ts` by `createApp({ config, logger })`. A single `express.json({ verify })` middleware captures the raw body buffer on `req.rawBody` before JSON parsing — this is required because Meta signs the raw bytes and any whitespace/key-order change invalidates the digest. `createMetaSignatureVerifier(appSecret, logger)` (`src/http/security.ts`) runs that check with `crypto.timingSafeEqual` and returns 400 if `rawBody` is missing (server-config bug) or 401 if the signature is missing/invalid.

A single Meta App can host three messaging products simultaneously. All three deliver to the same callback URL and sign with the same App Secret, so one verifier and one route handle all of them. The `object` field on the top-level payload is the channel discriminator.

After signature verification and the 200 ACK, `dispatchWebhook` calls `parseMetaWebhook` (`src/meta/parser.ts`) to fold each channel's raw envelope into a unified `IncomingMessage` / `StatusUpdate` shape (`src/meta/types.ts`). The normalized type carries channel, channel-scoped user / business ids (always unflipped to user-side regardless of echo direction), Unix-millisecond timestamps (WhatsApp seconds are upscaled at the parser boundary), a `MessageType` discriminator, and content blocks (text, media, reaction, postback, referral, replyTo, storyReply, storyMention, flowResponse, forwarded). The parser is non-throwing and dedupes per-payload by `channelMessageId`; cross-payload dedupe is the conversation agent's job (Stage 5). See [Message parsing](./docs/features/message-parsing.md) for the field-by-field semantics.

On the outbound side, each channel has a send client — `src/meta/{whatsapp,messenger,instagram}/client.ts` — that implements one common `ChannelAdapter` interface (`sendText`, `sendTypingIndicator`, `markRead`, `sendReaction`, `sendMedia`, plus WhatsApp `sendTemplate`). All three sit on a shared runtime `GraphClient` (`src/meta/shared/graph-client.ts`) that owns versioned URL building, `Authorization: Bearer` auth, and retry/backoff (429 and pre-response network failures are retried on any method; a 5xx is not retried for non-idempotent POST sends, to avoid double-sending). Channel capability differences are surfaced at runtime via `supports(feature)` — e.g. `supports('template')` is `true` only for WhatsApp — so the conversation agent dispatches uniformly and skips unsupported features cleanly instead of erroring. Stage 7 adds **media send** across all three channels behind the uniform `sendMedia` (image / audio / video / document; the agent infers the kind from the action's MIME), WhatsApp media upload/download utilities, and a WhatsApp **template-component builder** — so `supports('media_send')` is now `true` everywhere. Stage 8 adds the **setup-time platform surfaces**, configured out-of-band of the per-message hot path: the Messenger Profile API (`MessengerProfileClient` — Get Started, persistent menu, ice breakers, greeting), Instagram ice breakers (`InstagramIceBreakers`, requiring the `platform:'instagram'` field on `graph.instagram.com`), and Instagram private replies (`InstagramClient.sendPrivateReply` — the comment-to-DM funnel via `recipient: { comment_id }`), all applyable from a JSON config via `npm run setup:profile`. The send clients' `supports()` matrices now advertise these (Messenger `get_started`/`persistent_menu`/`ice_breakers`; Instagram `ice_breakers`). See [Outbound clients](./docs/features/outbound-clients.md), [Media send](./docs/features/media.md), [WhatsApp templates](./docs/features/templates.md), [Messenger profile](./docs/features/messenger-profile.md), and [Instagram platform](./docs/features/instagram-platform.md).

The conversation agent (Stage 5) ties these together. `dispatchWebhook` routes each parsed message into `ConversationAgent.handleInbound` (`src/conversation/agent.ts`), which runs a state machine — `idle → buffering → processing → sending → idle`. It keys one record per (channel, business, user) triple, filters echoes and dedupes redeliveries (a SETNX claim), then **buffers** a rapid burst into a single call so three quick lines become one chat request rather than three. On flush it POSTs a `ChatRequest` to the developer's `CHAT_ENDPOINT_URL`; the **chat contract** accepts both the legacy `message` / `messages` / `silence` form and a rich `actions[]` array (message, reply, reaction, typing, media, template, silence), collapsed into one ordered action list. Replies are then sent through an **ordered, channel-aware delivery** queue: WhatsApp advances only when a `sent`/`delivered` status webhook arrives (with a delivery-timeout fallback), while Messenger and Instagram advance on the successful send response, because they have no reliable per-message delivery callback. Concurrent flows for one conversation are serialized by a per-key async lock so they can't clobber the in-memory store. State, dedupe, and the buffer scheduler are in-memory for now (the Redis store + BullMQ scheduler land in Stage 10), and full rate limiting plus out-of-window template enforcement are still planned — see [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

Stage 6 adds the operational surface. The agent records per-outbound-message delivery-status history (the [status tracker](./docs/features/status-tracking.md): WhatsApp per-message; Messenger/Instagram translate a [read watermark](./docs/features/read-receipts.md) into the set of message ids it covers — observability only, no queue effect), optionally enriches the sender with an [identity lookup](./docs/features/identity-resolution.md) over `USER_LOOKUP_URL` (fail-open — any failure proceeds without a contact), and instruments every path with provider-agnostic metrics. The HTTP layer issues a per-request `x-trace-id` (injection-guarded) and a child logger threaded into the agent. Operators get `GET /health` + `GET /ready` (always on, unauthenticated), `GET /metrics` (Prometheus), and `GET /admin/conversations/:key` + `GET /admin/status/:messageId`. The admin/metrics routes are **token-gated** (`ADMIN_API_TOKEN`, ≥16 chars) and **guarded at registration** — when no token is set they are not mounted at all (404, not 401) — and admin output is **PII-redacted by default** via an allow-list/fail-closed redactor (`?reveal=true` unmasks for an authenticated operator). See [Operational visibility](./docs/features/operational-visibility.md).

## Documentation

- [Architecture](./docs/ARCHITECTURE.md) — current shape and planned modules.
- [Examples](./examples/README.md) — the example chat endpoints (echo, multi-channel router, LLM showcase bot), the local REPL, and the live-device runner.
- [Testing](./docs/TESTING.md) — unit/integration layout, fixtures, signature-test pattern.
- [Meta setup guide](./docs/META-SETUP-GUIDE.md) — end-to-end Meta App configuration.
- [Meta payload structures](./docs/META-PAYLOAD-STRUCTURES.md) — observed payload shapes (populated as captures land).
- [Trusted sources](./docs/TRUSTED-SOURCES.md) — curated Meta documentation references.
- [Configuration](./docs/features/configuration.md)
- [Webhook security](./docs/features/webhook-security.md)
- [Inbound webhooks](./docs/features/inbound-webhooks.md)
- [Message parsing](./docs/features/message-parsing.md)
- [Outbound clients](./docs/features/outbound-clients.md) — Stage 4 send adapters, the shared `GraphClient`, and the `supports()` capability matrix.
- [Media send](./docs/features/media.md) — Stage 7 uniform `sendMedia`, per-channel media bodies, WhatsApp upload, and the download utilities.
- [WhatsApp templates](./docs/features/templates.md) — Stage 7 `sendTemplate` + the `buildTemplateComponents` builder.
- [Messenger profile](./docs/features/messenger-profile.md) — Stage 8 Messenger Profile API (Get Started, persistent menu, ice breakers, greeting) + the `setup:profile` config script.
- [Instagram platform](./docs/features/instagram-platform.md) — Stage 8 Instagram ice breakers + private replies (comment-to-DM).
- [Conversation state](./docs/features/conversation-state.md) — Stage 5 agent state machine, conversation keying, dedupe, the 24h window, and the per-conversation serialization lock.
- [Message buffering](./docs/features/message-buffering.md) — Stage 5 burst aggregation, the timeout curve, and the buffer scheduler.
- [Ordered delivery](./docs/features/ordered-delivery.md) — Stage 5 channel-aware outbound queue and the delivery-timeout fallback.
- [Rich chat actions](./docs/features/rich-chat-actions.md) — Stage 5 chat request/response contract and the `ChatAction` union.
- [Status tracking](./docs/features/status-tracking.md) — Stage 6 delivery-status history, the rank-based `current`, and the watermark translation.
- [Read receipts](./docs/features/read-receipts.md) — Stage 6 WhatsApp `read` vs Messenger/Instagram watermark, and the `READ_RECEIPTS_ENABLED` knob.
- [Identity resolution](./docs/features/identity-resolution.md) — Stage 6 optional fail-open enrichment over `USER_LOOKUP_URL`.
- [Operational visibility](./docs/features/operational-visibility.md) — Stage 6 health/ready/metrics/admin routes, redaction, tracing, and the metrics model.
- [Setup verification](./docs/features/setup-verification.md) — `npm run setup:*` walkthrough.
- [Payload capture](./docs/features/payload-capture.md) — `npm run capture:*` workflow.
- [Known gaps](./docs/KNOWN-GAPS.md)

## Roadmap

See [`meta-ai-agent-implementation-plan.md`](./meta-ai-agent-implementation-plan.md) for the ten-stage build plan. Stages 1–5 (this scaffolding through the conversation agent) are the critical path; Stage 6 (operational visibility), Stage 7 (media send + WhatsApp templates), Stage 8 (platform-specific surfaces), and Stage 9 (examples and the local REPL) are complete; Stage 10 (production hardening) remains.

## License

MIT
