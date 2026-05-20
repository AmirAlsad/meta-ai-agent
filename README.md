# meta-ai-agent

Messaging infrastructure for deploying an AI agent over Meta's three messaging platforms — WhatsApp Cloud API, Facebook Messenger, and Instagram DMs — under a single Meta App.

This package is intentionally transport and orchestration focused. The developer brings a chat endpoint; this package handles webhook ingestion, signature verification, outbound delivery, status tracking, deduplication, conversation intelligence, and cross-channel identity normalization.

> **Status: Stage 3 of 10 — webhook ingestion + payload parsing + setup verification + payload capture.** Configuration loading, `X-Hub-Signature-256` verification on the raw body, the Meta verification handshake, channel routing by the top-level `object` field, a non-throwing parser that normalizes WhatsApp / Messenger / Instagram payloads into a single `IncomingMessage` / `StatusUpdate` shape with per-payload dedupe and ms-normalized timestamps, plus an interactive setup-verification + capture toolkit (per-channel verify scripts, Instagram OAuth, programmatic webhook subscription, passive capture, scenario-driven guided capture). Outbound send adapters, the conversation agent, and rich features land in later stages. See [`meta-ai-agent-implementation-plan.md`](./meta-ai-agent-implementation-plan.md) for the full roadmap.

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

Stage 3 setup + capture tooling (real Meta App + ngrok required):

```bash
npm run setup:oauth:instagram    # OAuth → long-lived (~60d) Instagram token
npm run setup:oauth:messenger    # FB Login for Business → scope-controlled Page Access Token
npm run setup:all                # End-to-end verify across every configured channel
npm run meta:webhooks            # Programmatic webhook subscription (or --inspect)
npm run capture:guided           # Interactive scenario-driven payload capture
npm run capture:fixtures         # Passive capture server
```

See [Meta setup guide](./docs/META-SETUP-GUIDE.md) for end-to-end onboarding.

To run hardware-free tests (no Meta credentials needed):

```bash
npm test            # unit + integration
npm run typecheck   # tsc --noEmit
```

## Architecture overview

The runtime is a single Express app composed in `src/http/app.ts` by `createApp({ config, logger })`. A single `express.json({ verify })` middleware captures the raw body buffer on `req.rawBody` before JSON parsing — this is required because Meta signs the raw bytes and any whitespace/key-order change invalidates the digest. `createMetaSignatureVerifier(appSecret, logger)` (`src/http/security.ts`) runs that check with `crypto.timingSafeEqual` and returns 400 if `rawBody` is missing (server-config bug) or 401 if the signature is missing/invalid.

A single Meta App can host three messaging products simultaneously. All three deliver to the same callback URL and sign with the same App Secret, so one verifier and one route handle all of them. The `object` field on the top-level payload is the channel discriminator.

After signature verification and the 200 ACK, `dispatchWebhook` calls `parseMetaWebhook` (`src/meta/parser.ts`) to fold each channel's raw envelope into a unified `IncomingMessage` / `StatusUpdate` shape (`src/meta/types.ts`). The normalized type carries channel, channel-scoped user / business ids (always unflipped to user-side regardless of echo direction), Unix-millisecond timestamps (WhatsApp seconds are upscaled at the parser boundary), a `MessageType` discriminator, and content blocks (text, media, reaction, postback, referral, replyTo, storyReply, storyMention, flowResponse, forwarded). The parser is non-throwing and dedupes per-payload by `channelMessageId`; cross-payload dedupe is the conversation agent's job (Stage 5). See [Message parsing](./docs/features/message-parsing.md) for the field-by-field semantics. Outbound clients, the conversation agent, identity resolver, status tracker, metrics, and persistence layers are still planned — see [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the planned shape.

## Documentation

- [Architecture](./docs/ARCHITECTURE.md) — current shape and planned modules.
- [Testing](./docs/TESTING.md) — unit/integration layout, fixtures, signature-test pattern.
- [Meta setup guide](./docs/META-SETUP-GUIDE.md) — end-to-end Meta App configuration.
- [Meta payload structures](./docs/META-PAYLOAD-STRUCTURES.md) — observed payload shapes (populated as captures land).
- [Trusted sources](./docs/TRUSTED-SOURCES.md) — curated Meta documentation references.
- [Configuration](./docs/features/configuration.md)
- [Webhook security](./docs/features/webhook-security.md)
- [Inbound webhooks](./docs/features/inbound-webhooks.md)
- [Message parsing](./docs/features/message-parsing.md)
- [Setup verification](./docs/features/setup-verification.md) — `npm run setup:*` walkthrough.
- [Payload capture](./docs/features/payload-capture.md) — `npm run capture:*` workflow.
- [Known gaps](./docs/KNOWN-GAPS.md)

## Roadmap

See [`meta-ai-agent-implementation-plan.md`](./meta-ai-agent-implementation-plan.md) for the ten-stage build plan. Stages 1–5 (this scaffolding through the conversation agent) are the critical path; Stages 6–10 (operational visibility, rich features, platform-specific surfaces, examples, production hardening) can be parallelized.

## License

MIT
