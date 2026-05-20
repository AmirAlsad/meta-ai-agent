# meta-ai-agent — Implementation Plan

## What This Is

`meta-ai-agent` is a standalone, open-source transport and orchestration package for deploying an AI agent over Meta's three messaging platforms — WhatsApp Cloud API, Facebook Messenger, and Instagram DMs — under a single Meta App. The developer brings a chat endpoint; this package handles webhook ingestion, signature verification, outbound delivery, status tracking, deduplication, conversation intelligence, and cross-channel identity normalization.

Modeled after [`sendblue-ai-agent`](https://github.com/AmirAlsad/sendblue-ai-agent) in structure, conventions, and philosophy: TypeScript ESM, Vitest, transport-focused with no model-provider coupling, dependency-injected `createApp(deps)`, `CLAUDE.md` for agent context, `docs/features/*.md` per feature, fixture-based testing, guided setup and capture tooling.

---

## Platform Context for the Implementing Engineer

This section distills the research findings that directly affect implementation decisions. Read it before writing code.

### Single Meta App, three products, one webhook URL

A single Meta App hosts three messaging "products." Each delivers POST requests to the same callback URL, signed with the same App Secret, distinguishable by the top-level `object` field:

| `object` value | Product | User ID type | Business ID type | Token type |
|---|---|---|---|---|
| `whatsapp_business_account` | WhatsApp Cloud API | `wa_id` (E.164 phone) | `phone_number_id` | System User Access Token |
| `page` | Messenger Platform | PSID (Page-Scoped) | Page ID | Page Access Token |
| `instagram` | Instagram (Business Login) | IGSID (Instagram-Scoped) | IG User ID | Instagram User Access Token |

All three sign the body with `X-Hub-Signature-256 = sha256=HMAC_SHA256(appSecret, rawBody)`. One verifier serves all channels.

### Webhook payload shapes

WhatsApp uses `entry[].changes[].value.messages[]` with a `metadata` block containing `phone_number_id` and `display_phone_number`. Messenger and Instagram both use `entry[].messaging[]` with `sender.id` / `recipient.id`. Despite the structural similarity between Messenger and Instagram payloads, they arrive as different `object` values when using the Instagram Business Login path (not the legacy Page-linked flow).

Key differences that affect parser design:

- **WhatsApp**: message ID format is `wamid.HBg...`. Status updates arrive as `statuses[]` within the same `changes[].value` block. Read receipts are `status: "read"` in `statuses[]`. Reactions are a `reaction` message type. Reply-to uses `context.message_id`. Typing indicators are sent as `type: "typing_indicator"` with the inbound `message_id`.
- **Messenger**: message ID format is `m_xxxxx`. Read receipts arrive as separate `message_reads` webhook events. Reactions arrive as `message_reactions` events. Reply-to uses `message.reply_to.mid`. Typing indicators use a separate `sender_action: "typing_on"` request. Business-sent message echoes have `is_echo: true`.
- **Instagram**: nearly identical to Messenger in shape, but GIFs and stickers do **not** fire inbound webhooks (Meta's docs are explicit: "Messages with gifs and stickers are not supported. If a person sends a message with a gif or sticker a webhook will not be triggered."). Story replies include `reply_to.story`. No Get Started button (uses Ice Breakers instead).

### Messaging windows and proactive outreach

This is the single most important product constraint. Each channel has a different model:

- **WhatsApp**: 24-hour Customer Service Window opens on each inbound. Inside: free-form messages, free. Outside: pre-approved templates only (paid per-message since July 1, 2025). Marketing templates to US numbers are paused as of April 1, 2025. Click-to-WhatsApp ads open a 72-hour free window.
- **Messenger**: 24-hour Standard Messaging Window. `HUMAN_AGENT` tag extends to 7 days but is human-only (bots cannot use it). Legacy Message Tags (`CONFIRMED_EVENT_UPDATE`, `ACCOUNT_UPDATE`, `POST_PURCHASE_UPDATE`) return error code 100 as of April 27, 2026. Marketing Messages on Messenger is in regional beta, not available in EU.
- **Instagram**: 24-hour window. `HUMAN_AGENT` tag (7 days, human-only). Private Replies to comments give a separate 7-day single-message window. For an automated bot, there is **no reliable out-of-window mechanism** in 2026.

The send adapter must expose messaging-window awareness as a first-class concept — not hidden behind a uniform `send()` interface. Template/tag parameters must be explicit.

### Identity — Meta does not link users across channels

`wa_id`, PSID, and IGSID are three unrelated identifiers. There is no Meta API to bridge them. PSIDs are Page-scoped (same person, different Page = different PSID). The package must model identity as `(channel, channelScopedId)` tuples with optional app-level merge via explicit user linking.

### Rate limits

- **WhatsApp**: phone-number tier starts at 1K unique recipients/24h, auto-scales to unlimited. ~80 msg/sec default API throughput.
- **Messenger**: standard Graph API rate limits per app/page. No documented per-second hard cap for normal messaging.
- **Instagram**: 2 calls/sec per IG Professional account for messaging endpoints. Hourly outbound rate = 200 × number of active conversations.

### Graph API versioning

Pin to `v23.0` (matches Meta's current WhatsApp samples). Store version in a single env var (`META_GRAPH_API_VERSION`). Meta supports each version for ~24 months. v19 expires May 21, 2026; v20 expires Sept 24, 2026.

### Retry behavior

Meta retries webhook deliveries on non-2xx for up to 7 days with exponential backoff. After 7 days, events are permanently dropped. There is no replay API or dead-letter queue. The package must ACK 200 immediately and process asynchronously — the handler is the dead-letter queue.

### Token lifecycle

- **WhatsApp System User Token**: permanent, non-expiring. Generated once in Business Settings.
- **Page Access Token** (Messenger): long-lived when generated from the App Dashboard or via System User. User-derived tokens expire ~60 days.
- **Instagram User Access Token** (Business Login): short-lived (~1 hour from OAuth). Must be exchanged for a long-lived token (~60 days). Requires refresh before expiry.

---

## Repo Structure

```
meta-ai-agent/
├── CLAUDE.md                        # Agent context for Claude Code
├── README.md
├── package.json                     # TypeScript ESM, type: "module"
├── tsconfig.json
├── tsconfig.build.json
├── vitest.config.ts
├── vitest.e2e.config.ts
├── .env.example
├── .gitignore
│
├── src/
│   ├── index.ts                     # Server bootstrap, autostart gate
│   │
│   ├── config/
│   │   └── loader.ts                # loadConfig — env parsing, validation, fail-fast
│   │
│   ├── http/
│   │   ├── app.ts                   # createApp(deps) — Express composition
│   │   ├── security.ts              # X-Hub-Signature-256 verification
│   │   ├── trace.ts                 # Per-request traceId middleware
│   │   ├── auth.ts                  # Admin token validation
│   │   └── redaction.ts             # PII redaction for admin endpoints
│   │
│   ├── meta/
│   │   ├── types.ts                 # Raw Meta webhook payload types (WA, Messenger, IG)
│   │   ├── parser.ts                # Per-channel webhook parsers → IncomingMessage
│   │   ├── whatsapp/
│   │   │   ├── client.ts            # WhatsApp Send API wrapper
│   │   │   ├── templates.ts         # Template message construction
│   │   │   └── types.ts             # WhatsApp-specific types
│   │   ├── messenger/
│   │   │   ├── client.ts            # Messenger Send API wrapper
│   │   │   ├── profile.ts           # Messenger Profile API (Get Started, Ice Breakers, Persistent Menu)
│   │   │   └── types.ts
│   │   ├── instagram/
│   │   │   ├── client.ts            # Instagram Send API wrapper
│   │   │   ├── ice-breakers.ts      # Ice Breaker management
│   │   │   └── types.ts
│   │   └── shared/
│   │       ├── graph-client.ts      # Base Graph API HTTP client (versioned URL builder, error handling)
│   │       ├── media.ts             # Media upload/download (shared across channels)
│   │       └── errors.ts            # MetaApiError with operation, httpStatus, errorCode, subCode
│   │
│   ├── conversation/
│   │   ├── agent.ts                 # ConversationAgent — central state machine
│   │   ├── buffering.ts             # Inbound burst buffering (timer math)
│   │   ├── store.ts                 # In-memory ConversationStore
│   │   ├── redis-store.ts           # Redis-backed ConversationStore
│   │   └── types.ts                 # ConversationRecord, ConversationKey
│   │
│   ├── identity/
│   │   ├── resolver.ts              # Optional USER_LOOKUP_URL enrichment
│   │   ├── contact-store.ts         # (channel, channelScopedId) → unified contact
│   │   └── types.ts                 # ChannelIdentity, Contact
│   │
│   ├── chat/
│   │   ├── client.ts                # HTTP POST to CHAT_ENDPOINT_URL
│   │   ├── contract.ts              # Response normalization (message, messages, actions)
│   │   └── types.ts                 # ChatRequest, ChatResponse, ChatAction
│   │
│   ├── status/
│   │   ├── tracker.ts               # Status history accumulation
│   │   └── types.ts                 # DeliveryStatus enum
│   │
│   ├── delivery/
│   │   ├── queue.ts                 # Per-conversation ordered outbound queue
│   │   └── types.ts                 # OutboundItem, QueueState
│   │
│   ├── limits/
│   │   ├── tracker.ts               # Rate limiting, window tracking
│   │   └── types.ts
│   │
│   └── metrics/
│       ├── collector.ts             # InMemoryMetricsCollector, NoopMetricsCollector
│       └── prometheus.ts            # renderPrometheus text exposition
│
├── scripts/
│   ├── setup/
│   │   ├── verify-whatsapp.ts       # Verify WhatsApp config + send test message
│   │   ├── verify-messenger.ts      # Verify Messenger config + send test message
│   │   ├── verify-instagram.ts      # Verify Instagram config + send test message
│   │   ├── verify-all.ts            # Run all three in sequence
│   │   ├── oauth-instagram.ts       # Minimal OAuth server for IG token capture
│   │   └── register-webhooks.ts     # Programmatic webhook subscription via Graph API
│   ├── capture/
│   │   ├── fixture-capture.ts       # Passive capture server → .captures/meta/
│   │   └── guided-capture.ts        # Interactive guided capture per channel
│   └── tunnel.ts                    # ngrok tunnel management (shared utility)
│
├── tests/
│   ├── unit/
│   │   ├── parser.test.ts
│   │   ├── security.test.ts
│   │   ├── whatsapp-client.test.ts
│   │   ├── messenger-client.test.ts
│   │   ├── instagram-client.test.ts
│   │   ├── conversation-agent.test.ts
│   │   └── buffering.test.ts
│   ├── integration/
│   │   ├── webhook-routing.test.ts
│   │   ├── end-to-end-flow.test.ts
│   │   └── identity-resolution.test.ts
│   ├── fixtures/
│   │   ├── meta/
│   │   │   ├── whatsapp/
│   │   │   │   ├── text-inbound.json
│   │   │   │   ├── image-inbound.json
│   │   │   │   ├── status-delivered.json
│   │   │   │   ├── status-read.json
│   │   │   │   └── reaction.json
│   │   │   ├── messenger/
│   │   │   │   ├── text-message.json
│   │   │   │   ├── postback.json
│   │   │   │   ├── message-read.json
│   │   │   │   └── reaction.json
│   │   │   └── instagram/
│   │   │       ├── text-dm.json
│   │   │       ├── story-reply.json
│   │   │       ├── story-mention.json
│   │   │       └── reaction.json
│   │   └── captured/                # Promoted from .captures/ after redaction
│   └── e2e/
│       └── smoke.test.ts
│
├── examples/
│   ├── README.md
│   ├── minimal-chat-endpoint/       # Simplest echo bot
│   │   └── index.ts
│   ├── multi-channel-router/        # Shows channel-aware response logic
│   │   └── index.ts
│   └── showcase-bot/                # LLM-backed reference (own package.json)
│       ├── package.json
│       └── index.ts
│
└── docs/
    ├── ARCHITECTURE.md
    ├── TESTING.md
    ├── META-SETUP-GUIDE.md          # Step-by-step Meta App Dashboard setup
    ├── META-PAYLOAD-STRUCTURES.md   # Observed webhook payloads per channel
    ├── TRUSTED-SOURCES.md           # Curated Meta documentation references
    └── features/
        ├── configuration.md
        ├── inbound-webhooks.md
        ├── outbound-clients.md
        ├── webhook-security.md
        ├── message-buffering.md
        ├── ordered-delivery.md
        ├── status-tracking.md
        ├── typing-indicators.md
        ├── read-receipts.md
        ├── reactions.md
        ├── reply-to.md
        ├── media.md
        ├── templates.md
        ├── identity-resolution.md
        ├── conversation-state.md
        ├── messaging-windows.md
        ├── rich-chat-actions.md
        ├── operational-visibility.md
        ├── persistence.md
        └── setup-verification.md
```

---

## Stages

### Stage 1 — Scaffold, Security, and Webhook Routing

**Goal**: a running Express server that receives Meta webhooks on a single endpoint, verifies signatures, routes by `object` field, and logs raw payloads. No outbound. No conversation logic.

**Files to create:**

`package.json` — TypeScript ESM (`"type": "module"`), Node `>=20`. Dependencies: `express`, `pino`, `pino-pretty` (dev), `dotenv`. Dev dependencies: `vitest`, `@types/express`, `@types/node`, `typescript`, `tsx`, `node-mocks-http`.

`tsconfig.json` — `target: "ES2022"`, `module: "NodeNext"`, `moduleResolution: "NodeNext"`, strict. Internal imports use `.js` specifiers per Node ESM resolution.

`tsconfig.build.json` — extends base, `outDir: "dist"`, excludes tests.

`.env.example`:
```
# Meta App credentials
META_APP_ID=
META_APP_SECRET=
META_VERIFY_TOKEN=           # Any random string ≥16 chars, used for webhook verification handshake
META_GRAPH_API_VERSION=v23.0

# WhatsApp
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_ACCESS_TOKEN=       # System User token

# Messenger
MESSENGER_PAGE_ID=
MESSENGER_PAGE_ACCESS_TOKEN=

# Instagram (Business Login)
INSTAGRAM_USER_ID=
INSTAGRAM_ACCESS_TOKEN=      # Long-lived Instagram User token

# Chat endpoint (developer-provided)
CHAT_ENDPOINT_URL=

# Optional
REDIS_URL=
ADMIN_API_TOKEN=
PUBLIC_BASE_URL=             # For webhook registration; typically ngrok URL
AGENT_AUTOSTART=1            # Set to 0 to prevent autostart on import
PORT=3000

# E2E
E2E_TEST_WHATSAPP_NUMBER=   # Personal WhatsApp number (E.164)
E2E_TEST_FACEBOOK_PSID=     # Founder's PSID for Messenger testing
E2E_TEST_INSTAGRAM_IGSID=   # Founder's IGSID for Instagram testing
NGROK_AUTHTOKEN=
NGROK_DOMAIN=                # Optional stable domain
```

`src/config/loader.ts` — `loadConfig()` reads from `process.env`, validates required fields per channel (allow partial config — if only WhatsApp tokens are set, only WhatsApp is enabled), throws on invalid combinations. Returns a typed `Config` object with a `channels: { whatsapp: boolean, messenger: boolean, instagram: boolean }` map.

`src/http/security.ts` — `verifyMetaSignature(rawBody: Buffer, signature: string, appSecret: string): boolean`. Uses `crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex')` and `crypto.timingSafeEqual` for constant-time comparison. The signature header value has the format `sha256=<hex>`.

`src/http/app.ts` — `createApp(deps)` wires Express. Critical middleware: `express.json()` with a `verify` callback that captures `req.rawBody = buf` before parsing. Mounts:
- `GET /webhook` — Meta verification handshake. Echoes `hub.challenge` if `hub.verify_token` matches `META_VERIFY_TOKEN`.
- `POST /webhook` — Verify signature → ACK 200 → dispatch by `req.body.object`. Initially just logs the raw body per channel.
- `GET /health` — Liveness probe.

`src/index.ts` — Autostart gate (`AGENT_AUTOSTART !== '0'` and `NODE_ENV !== 'test'`). Calls `loadConfig()`, `createApp(deps)`, `app.listen()`.

**Tests:**

`tests/unit/security.test.ts` — Valid signature passes. Invalid signature rejects. Missing header rejects. Timing-safe (no early exit on mismatch).

`tests/integration/webhook-routing.test.ts` — POST with `object: "whatsapp_business_account"` routes to WhatsApp handler. POST with `object: "page"` routes to Messenger handler. POST with `object: "instagram"` routes to Instagram handler. Invalid signature returns 401. GET with correct verify token echoes challenge. GET with wrong verify token returns 403.

Create initial fixture files with placeholder payloads from Meta's documentation (the exact shapes are documented in the "Platform Context" section above). These are starter fixtures; the guided capture tooling (Stage 3) will replace them with real payloads.

**npm scripts:**
```json
"dev": "tsx src/index.ts",
"build": "tsc -p tsconfig.build.json",
"test": "vitest run --config vitest.config.ts",
"test:unit": "vitest run --config vitest.config.ts tests/unit",
"test:integration": "vitest run --config vitest.config.ts tests/integration",
"typecheck": "tsc --noEmit"
```

---

### Stage 2 — Webhook Parsing and Normalized Message Types

**Goal**: parse raw Meta webhook payloads from all three channels into a unified `IncomingMessage` type. No outbound yet.

**Files to create:**

`src/meta/types.ts` — Raw TypeScript types for each channel's webhook payload. Three separate type families: `WhatsAppWebhookPayload`, `MessengerWebhookPayload`, `InstagramWebhookPayload`. These are the raw shapes — not normalized.

`src/meta/parser.ts` — Three parser functions:
- `parseWhatsAppWebhook(payload: WhatsAppWebhookPayload): IncomingMessage[]`
- `parseMessengerWebhook(payload: MessengerWebhookPayload): IncomingMessage[]`
- `parseInstagramWebhook(payload: InstagramWebhookPayload): IncomingMessage[]`

Each returns an array because a single webhook payload can contain multiple messages across multiple `entry[]` items.

The normalized `IncomingMessage` type (defined in `src/meta/types.ts` alongside the raw types):

```typescript
type Channel = 'whatsapp' | 'messenger' | 'instagram';

type MessageType = 'text' | 'image' | 'audio' | 'video' | 'document'
  | 'sticker' | 'location' | 'reaction' | 'interactive'
  | 'postback' | 'referral' | 'read' | 'echo' | 'unknown';

interface IncomingMessage {
  channel: Channel;
  channelMessageId: string;        // wamid.* | mid.*
  channelScopedUserId: string;     // wa_id | PSID | IGSID
  channelScopedBusinessId: string; // phone_number_id | page_id | ig_id
  timestamp: number;               // ms since epoch (WhatsApp sends seconds — multiply)
  type: MessageType;
  text?: string;
  media?: { id: string; mimeType?: string; sha256?: string; caption?: string; url?: string };
  reaction?: { emoji: string; targetMessageId: string };
  replyTo?: string;                // referenced channelMessageId
  storyReply?: { url: string; id: string }; // Instagram story reply
  postback?: { title: string; payload: string }; // Messenger/IG postback
  referral?: { source: string; type: string; ref?: string }; // m.me / ig.me ref params
  isEcho?: boolean;                // business-sent message echoed back
  raw: unknown;                    // original payload block for debugging
}
```

**Parser edge cases to handle:**

- WhatsApp `statuses[]` events (delivered, read, failed) — parse into a separate `StatusUpdate` type, not `IncomingMessage`. Keep both types in `parser.ts` output.
- Messenger `is_echo: true` messages — set `isEcho: true` so the conversation agent can filter them (do not process your own outbound as inbound).
- Instagram `reply_to.story` — populate `storyReply` field.
- Instagram: tolerate missing webhooks for GIF/sticker messages (the webhook simply doesn't fire — there's nothing to parse).
- WhatsApp timestamps are Unix seconds; Messenger/Instagram are Unix milliseconds. Normalize to milliseconds.
- Dedupe at the parser level: if the same `channelMessageId` appears in multiple `entry[]` blocks (Meta can batch), deduplicate.

**Update `src/http/app.ts`**: replace raw logging with parser calls. Queue parsed messages (initially just log the normalized `IncomingMessage`).

**Tests:**

`tests/unit/parser.test.ts` — For each channel: text message parses correctly, media message parses correctly, reaction parses correctly, reply-to parses correctly, echo is flagged, timestamp normalization is correct, unknown type doesn't throw (returns `type: 'unknown'`). WhatsApp status events parse to `StatusUpdate`. Instagram story reply populates `storyReply`. Multiple messages in one payload all parse. Dedupe across batched entries.

Use the fixture files from Stage 1 as test inputs; add more granular fixtures per message type.

---

### Stage 3 — Setup Verification and Guided Capture Tooling

**Goal**: interactive CLI tooling that (a) verifies Meta App configuration per channel, (b) automatically manages ngrok tunnels and webhook registration, (c) walks the user through sending real messages to capture payload fixtures.

**Files to create:**

`scripts/tunnel.ts` — Shared ngrok tunnel utility. Uses `@ngrok/ngrok` npm package. `startTunnel(port: number, domain?: string): Promise<string>` returns the public HTTPS URL. Reads `NGROK_AUTHTOKEN` and optional `NGROK_DOMAIN` from env.

`scripts/setup/register-webhooks.ts` — Programmatic webhook subscription via Graph API. For each enabled channel:
- **WhatsApp**: `POST /{WHATSAPP_PHONE_NUMBER_ID}/subscribed_apps` with `access_token` — but WhatsApp webhook subscription is typically done in the App Dashboard. This script verifies the subscription exists by calling `GET /{META_APP_ID}/subscriptions` and checking for `whatsapp_business_account` with the expected callback URL, then updates if needed.
- **Messenger**: `POST /{MESSENGER_PAGE_ID}/subscribed_apps?subscribed_fields=messages,messaging_postbacks,message_deliveries,message_reads,messaging_optins,messaging_referrals,message_reactions&access_token={PAGE_ACCESS_TOKEN}`.
- **Instagram**: `POST /{INSTAGRAM_USER_ID}/subscribed_apps?subscribed_fields=messages,messaging_postbacks,messaging_seen,messaging_reactions,messaging_referrals&access_token={INSTAGRAM_ACCESS_TOKEN}`.
- Webhook callback URL and verify token are set via `POST /{META_APP_ID}/subscriptions` for each product type, with `callback_url`, `verify_token`, and `object` (`page` for Messenger, `instagram` for IG). WhatsApp webhook config is set in the App Dashboard product settings (cannot be fully automated via API — the script should detect this and instruct the user).

`scripts/setup/oauth-instagram.ts` — Minimal Express server on a configurable port that:
1. Prints the Instagram OAuth URL for the user to open in a browser: `https://www.instagram.com/oauth/authorize?client_id={META_APP_ID}&redirect_uri=https://localhost:{port}/auth/instagram/callback&scope=instagram_business_basic,instagram_business_manage_messages&response_type=code`.
2. Handles the callback: exchanges the `code` for a short-lived token via `POST https://api.instagram.com/oauth/access_token`, then exchanges for a long-lived token via `GET https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret={META_APP_SECRET}&access_token={short_lived_token}`.
3. Prints the long-lived token and Instagram User ID to stdout. Optionally appends to `.env`.
4. Shuts down.

Note: the redirect URI must be registered in the Meta App Dashboard under Instagram Business Login settings. The script should check and instruct if not configured. For local dev, use the ngrok tunnel URL as the redirect URI (the script can auto-register it if the tunnel is running).

`scripts/setup/verify-whatsapp.ts` — Interactive verification script:
1. Check: `WHATSAPP_PHONE_NUMBER_ID` and `WHATSAPP_ACCESS_TOKEN` are set.
2. Check: call `GET https://graph.facebook.com/{META_GRAPH_API_VERSION}/{WHATSAPP_PHONE_NUMBER_ID}?access_token={token}` — confirms the token is valid and the phone number exists. Print the display phone number.
3. Check: start the Express server + ngrok tunnel. Register/verify the webhook subscription. Send a test webhook from the App Dashboard (instruct the user to click "Send test" in WhatsApp → Configuration, or programmatically trigger one if possible). Wait for the webhook to arrive. Confirm signature verification passes.
4. Action: send the `hello_world` template message to `E2E_TEST_WHATSAPP_NUMBER` via `POST /{WHATSAPP_PHONE_NUMBER_ID}/messages`. Confirm delivery status webhook arrives.
5. Instruct: "Send a text message from your personal WhatsApp to {display_phone_number}." Wait for inbound webhook. Parse and display the normalized `IncomingMessage`. Save raw payload to `.captures/meta/whatsapp/`.
6. Print summary: ✅ Token valid, ✅ Webhook receiving, ✅ Outbound works, ✅ Inbound works.

`scripts/setup/verify-messenger.ts` — Same pattern:
1. Check: `MESSENGER_PAGE_ID` and `MESSENGER_PAGE_ACCESS_TOKEN` are set.
2. Check: call `GET https://graph.facebook.com/{META_GRAPH_API_VERSION}/{MESSENGER_PAGE_ID}?fields=name,id&access_token={token}` — confirms the Page exists and token is valid.
3. Check: register webhook subscription for the Page. Wait for verification handshake.
4. Check: confirm the user's personal Facebook account has a Tester/Admin/Developer role on the app. (Cannot fully automate this — instruct the user to verify in App Dashboard → App Roles → Roles.)
5. Instruct: "Open Messenger and send a message to your Page '{page_name}'." Wait for inbound webhook with `object: "page"`. Parse and display. Save to `.captures/meta/messenger/`.
6. Action: send a reply via `POST /{MESSENGER_PAGE_ID}/messages` with `recipient: { id: sender.id }`. Confirm the reply appears in the user's Messenger.
7. Print summary.

`scripts/setup/verify-instagram.ts` — Same pattern:
1. Check: `INSTAGRAM_USER_ID` and `INSTAGRAM_ACCESS_TOKEN` are set. If not, offer to run the OAuth flow (`oauth-instagram.ts`).
2. Check: call `GET https://graph.instagram.com/{META_GRAPH_API_VERSION}/me?fields=user_id,username&access_token={token}` — confirms the IG account and token.
3. Check: register webhook subscription. Wait for verification.
4. Instruct: "On the official IG account's mobile app, go to Settings → Messages and story replies → Message controls → verify 'Allow access to messages' is ON." (This is the silent killer — no webhook fires if it's off, and there's no error.)
5. Instruct: "Send a DM from your personal/unofficial Instagram account to @{username}." Wait for inbound webhook with `object: "instagram"`. Parse and display. Save to `.captures/meta/instagram/`.
6. Action: send a reply via `POST https://graph.instagram.com/{META_GRAPH_API_VERSION}/{INSTAGRAM_USER_ID}/messages`. Confirm.
7. Print summary.

`scripts/setup/verify-all.ts` — Runs all three in sequence with a combined summary.

`scripts/capture/fixture-capture.ts` — Passive capture server (like SendBlue's `capture:fixtures`). Starts Express + ngrok, registers webhooks, logs every incoming request body + headers to `.captures/meta/{channel}/{timestamp}-{type}.json`. No processing, no responses beyond 200 ACK. For building up a corpus of real payloads.

`scripts/capture/guided-capture.ts` — Interactive guided capture (like SendBlue's `capture:guided`). Channel-specific scenarios:

**WhatsApp scenarios:**
1. "Send a text message" → wait for `text` webhook
2. "Send an image" → wait for `image` webhook
3. "Send a voice message" → wait for `audio` webhook
4. "React to the last bot message with 👍" → wait for `reaction` webhook
5. "Reply to the last bot message by long-pressing and selecting Reply" → wait for message with `context.message_id`
6. "Read the last message" → wait for `status: "read"` in `statuses[]`

**Messenger scenarios:**
1. "Send a text message to the Page" → wait for `text` webhook
2. "Send an image" → wait for `attachments` webhook
3. "React to the bot's message" → wait for `message_reactions` webhook
4. "Read the bot's message" → wait for `message_reads` webhook

**Instagram scenarios:**
1. "Send a text DM to @{username}" → wait for `text` webhook
2. "Reply to a story posted by @{username}" → wait for webhook with `reply_to.story`
3. "Send an image" → wait for `attachments` webhook
4. "React to the bot's message" → wait for `message_reactions` webhook

Each scenario: send instruction to console, wait for matching webhook, save raw payload to `.captures/meta/{channel}/`, advance. Reply `skip` to skip a scenario. Annotate each capture with the active scenario name. On completion, print a summary of captured vs. skipped scenarios.

**npm scripts:**
```json
"setup:whatsapp": "tsx scripts/setup/verify-whatsapp.ts",
"setup:messenger": "tsx scripts/setup/verify-messenger.ts",
"setup:instagram": "tsx scripts/setup/verify-instagram.ts",
"setup:all": "tsx scripts/setup/verify-all.ts",
"setup:oauth:instagram": "tsx scripts/setup/oauth-instagram.ts",
"meta:webhooks": "tsx scripts/setup/register-webhooks.ts",
"capture:fixtures": "tsx scripts/capture/fixture-capture.ts",
"capture:guided": "tsx scripts/capture/guided-capture.ts"
```

**Tests:**

No automated tests for setup scripts themselves (they require real Meta credentials). But the webhook registration logic should have unit tests for URL construction and Graph API response parsing.

---

### Stage 4 — Outbound Send Adapters

**Goal**: send text messages, typing indicators, and read receipts on all three channels via a common adapter interface.

**Files to create:**

`src/meta/shared/graph-client.ts` — Base HTTP client for Graph API calls. Builds versioned URLs (`https://graph.facebook.com/{META_GRAPH_API_VERSION}/{endpoint}`), handles error responses (parse Meta's error JSON: `error.message`, `error.code`, `error.error_subcode`, `error.fbtrace_id`), wraps in `MetaApiError`. Retry logic for transient 5xx/429 with exponential backoff.

`src/meta/shared/errors.ts` — `MetaApiError extends Error` with `operation`, `httpStatus`, `errorCode`, `errorSubCode`, `fbtraceId`, `responseBody`. Allows callers to branch on error codes without regex.

`src/meta/whatsapp/client.ts` — `WhatsAppClient`:
- `sendText(to: string, text: string, replyTo?: string): Promise<SendResult>` — `POST /{PHONE_NUMBER_ID}/messages` with `{ messaging_product: "whatsapp", to, type: "text", text: { body } }`. Include `context: { message_id }` if `replyTo` is set.
- `sendTypingIndicator(to: string, messageId: string): Promise<void>` — `POST /{PHONE_NUMBER_ID}/messages` with `type: "typing_indicator"` and the inbound `message_id`.
- `markRead(messageId: string): Promise<void>` — `POST /{PHONE_NUMBER_ID}/messages` with `{ messaging_product: "whatsapp", status: "read", message_id }`.
- `sendReaction(messageId: string, emoji: string): Promise<void>` — `POST /{PHONE_NUMBER_ID}/messages` with `type: "reaction"`.
- `sendTemplate(to: string, templateName: string, languageCode: string, components?: TemplateComponent[]): Promise<SendResult>` — for out-of-window messaging.

`src/meta/messenger/client.ts` — `MessengerClient`:
- `sendText(recipientId: string, text: string, replyTo?: string, messagingType?: string, tag?: string): Promise<SendResult>` — `POST /{PAGE_ID}/messages` with `{ recipient: { id }, messaging_type: "RESPONSE" | "MESSAGE_TAG", message: { text }, tag? }`. Include `message.reply_to.mid` if `replyTo` is set.
- `sendTypingOn(recipientId: string): Promise<void>` — `POST /{PAGE_ID}/messages` with `{ recipient: { id }, sender_action: "typing_on" }`. Must be a separate request from the message (Meta throws error if combined).
- `markSeen(recipientId: string): Promise<void>` — `POST /{PAGE_ID}/messages` with `{ recipient: { id }, sender_action: "mark_seen" }`.
- `sendReaction(messageId: string, emoji: string): Promise<void>`.

`src/meta/instagram/client.ts` — `InstagramClient`:
- Same interface as `MessengerClient` but hits `https://graph.instagram.com/{version}/{IG_USER_ID}/messages` (or `https://graph.facebook.com/{version}/{IG_USER_ID}/messages` — both work, verify in testing).
- Rate-limit awareness: 2 calls/sec per IG Professional account. The client should implement a per-account rate limiter or at minimum expose the constraint to the caller.

All three clients return a common `SendResult`:
```typescript
interface SendResult {
  channel: Channel;
  messageId: string;      // wamid.* | mid.*
  recipientId: string;
  timestamp: number;
}
```

**Adapter interface** (for the conversation agent to call without knowing the channel):
```typescript
interface ChannelAdapter {
  channel: Channel;
  sendText(recipientId: string, text: string, opts?: SendOptions): Promise<SendResult>;
  sendTypingIndicator(recipientId: string, messageId?: string): Promise<void>;
  markRead(recipientId: string, messageId: string): Promise<void>;
  sendReaction(messageId: string, emoji: string): Promise<void>;
  supports(feature: ChannelFeature): boolean;
}

type ChannelFeature = 'typing_indicator' | 'read_receipt' | 'reaction'
  | 'reply_to' | 'template' | 'persistent_menu' | 'get_started'
  | 'ice_breakers' | 'story_reply' | 'media_send';
```

The `supports()` method lets the conversation agent check capabilities at runtime rather than failing. For example, `instagramAdapter.supports('template')` returns `false`.

**Tests:**

`tests/unit/whatsapp-client.test.ts`, `messenger-client.test.ts`, `instagram-client.test.ts` — Mock the Graph API HTTP calls. Verify correct URL construction, request body shape, error handling for known error codes, and `SendResult` parsing. Test that `sendTypingOn` for Messenger is a separate request from `sendText` (the SendBlue repo has a similar "typing is a separate call" constraint).

---

### Stage 5 — Conversation Agent, Buffering, and Ordered Delivery

**Goal**: the central state machine that bridges inbound webhooks to the chat endpoint and manages outbound delivery. Mirrors `sendblue-ai-agent`'s `ConversationAgent` architecture.

**Conversation keying:**

- WhatsApp: `whatsapp:{phoneNumberId}:{wa_id}`
- Messenger: `messenger:{pageId}:{psid}`
- Instagram: `instagram:{igUserId}:{igsid}`

One record per (channel, user) pair. No cross-channel merging at this layer — that's the identity resolver's job.

**`src/conversation/agent.ts` — `ConversationAgent`:**

The central orchestrator. Injected dependencies: `ConversationStore`, `ChatClient`, channel adapters (keyed by `Channel`), `IdentityResolver` (optional), `MetricsCollector`, `LimitTracker`, config, logger.

Core flow:
1. `handleInbound(message: IncomingMessage)` — deduplicate by `channelMessageId`, resolve conversation key, check `isEcho` (skip own echoes), buffer rapid bursts (see below), call chat endpoint with buffered payload, enqueue outbound responses.
2. `handleStatus(status: StatusUpdate)` — update status tracker, advance outbound queue on `delivered` / `sent` / `read` (channel-aware: WhatsApp advances on `delivered`, Messenger/Instagram lack per-message delivery callbacks — advance on send confirmation).
3. `handleReaction(reaction: IncomingMessage)` — forward to chat endpoint as a reaction event.

**`src/conversation/buffering.ts`:**

Same timer math as the SendBlue repo: base timeout, growth factor, max timeout, noise deviation. When a message arrives within the buffer window of the previous message for the same conversation, extend the timer and aggregate. On flush: call the chat endpoint with both a top-level `message` string (concatenated) and structured `messages[]` array.

**`src/delivery/queue.ts`:**

Per-conversation ordered outbound queue. The chat endpoint returns one or more response items (text messages, typing indicators, etc.). Each is enqueued. The queue sends the first item, waits for confirmation (WhatsApp: delivery status callback; Messenger/Instagram: successful API response — these platforms don't have a status callback webhook like WhatsApp's `statuses[]` for delivery confirmation, so advance-on-send is the right model), then sends the next.

Typing indicators are injected before text messages with configurable delay.

**`src/conversation/store.ts` / `redis-store.ts`:**

Same dual-store pattern as the SendBlue repo. `ConversationStore` interface with `get(key)`, `set(key, record)`, `delete(key)`, `listConversationKeys()`. In-memory for tests/local; Redis-backed for production.

`ConversationRecord`:
```typescript
interface ConversationRecord {
  key: string;
  channel: Channel;
  channelScopedUserId: string;
  channelScopedBusinessId: string;
  state: 'idle' | 'buffering' | 'processing' | 'sending';
  outboundQueue: OutboundItem[];
  lastInboundAt: number;
  lastOutboundAt: number;
  windowExpiresAt?: number;         // 24-hour messaging window tracking
  traceId?: string;
  contact?: Contact;                // resolved identity
}
```

**`src/chat/client.ts` — `ChatClient`:**

HTTP POST to `CHAT_ENDPOINT_URL`. Request shape:

```typescript
interface ChatRequest {
  channel: Channel;
  conversationKey: string;
  message: string;                   // backward-compat aggregated text
  messages: IncomingMessage[];       // structured array
  contact?: Contact;                 // resolved identity
  capabilities: ChannelFeature[];    // what the responding adapter supports
  context: {
    windowOpen: boolean;             // whether the 24h window is active
    windowExpiresAt?: number;
  };
}
```

Response shape follows the SendBlue pattern — support both legacy `message`/`messages`/`silence` and rich `actions[]`:

```typescript
interface ChatResponse {
  message?: string;
  messages?: string[];
  silence?: boolean;
  actions?: ChatAction[];
}

type ChatAction =
  | { type: 'message'; text: string }
  | { type: 'typing'; durationMs?: number }
  | { type: 'reaction'; emoji: string; targetMessageId: string }
  | { type: 'reply'; text: string; targetMessageId: string }
  | { type: 'media'; url: string; caption?: string; mimeType?: string }
  | { type: 'template'; name: string; language: string; components?: TemplateComponent[] }
  | { type: 'silence' };
```

`src/chat/contract.ts` — `normalizeChatResponse(raw: ChatResponse): ChatAction[]` — collapses all response forms into a single `ChatAction[]` array.

**Tests:**

`tests/unit/conversation-agent.test.ts` — Full state machine: inbound → buffer → flush → chat call → outbound queue → delivery. Deduplicate by `channelMessageId`. Echo filtering. Cross-channel conversation isolation. Window tracking.

`tests/unit/buffering.test.ts` — Timer math: single message flushes after base timeout, rapid burst extends, max timeout caps, noise adds jitter.

`tests/integration/end-to-end-flow.test.ts` — Injected fakes for all dependencies. Full flow: webhook POST → parsing → agent → chat client (mocked) → outbound queue → send adapter (mocked). Verify the correct adapter is selected based on channel.

---

### Stage 6 — Status Tracking, Identity Resolution, and Operational Visibility

**Goal**: delivery status tracking, optional identity enrichment, and the observability surface (health, ready, metrics, admin introspection).

**`src/status/tracker.ts`:**

Same pattern as the SendBlue repo. `applyStatusUpdate(messageId, status, timestamp)` accumulates status history per outbound message. Statuses: `sent`, `delivered`, `read`, `failed`. WhatsApp provides all four via `statuses[]` webhooks. Messenger provides `message_reads` but not per-message delivery. Instagram provides `messaging_seen`.

Map channel-specific status events to the common enum:
- WhatsApp `statuses[].status`: `sent` → `sent`, `delivered` → `delivered`, `read` → `read`, `failed` → `failed`.
- Messenger `message_reads` webhook: marks all messages with `watermark` ≤ the read timestamp as `read`.
- Instagram `messaging_seen` webhook: same watermark model as Messenger.

**`src/identity/resolver.ts`:**

Optional enrichment via `USER_LOOKUP_URL`. Same pattern as the SendBlue repo. `POST` with `{ channel, channelScopedUserId, channelScopedBusinessId }` → response with `firstName`, `lastName`, `email`, `tags`, `customVariables`. Fail-open: if the lookup fails, the conversation proceeds without enrichment.

**`src/identity/contact-store.ts`:**

Maps `(channel, channelScopedId)` → `Contact`. Optionally stores a `unifiedContactId` for cross-channel linking (set by the developer's identity resolver, not by this package).

**Operational visibility** (mirrors the SendBlue repo's structure):

`src/metrics/collector.ts` — `InMemoryMetricsCollector` and `NoopMetricsCollector`. Counters, histograms, gauges for: webhooks received (by channel), webhooks parsed, chat dispatch latency, outbound sends (by channel, by result), status callbacks, retries, errors.

`src/http/trace.ts` — Per-request `traceId` middleware. `x-trace-id` response header. TraceId persisted on `ConversationRecord`.

Routes (all gated by `ADMIN_API_TOKEN`):
- `GET /health` — Liveness (uptime, version, node version). Always mounted.
- `GET /ready` — Readiness with Redis ping. Returns 503 when unhealthy. Always mounted.
- `GET /metrics` — Prometheus text exposition. Token-gated.
- `GET /admin/conversations/:key` — Conversation state introspection. Token-gated, PII-redacted by default.
- `GET /admin/status/:messageId` — Status history for a specific outbound message.

---

### Stage 7 — Rich Features: Media, Reactions, Reply-To, Templates

**Goal**: extend the send adapters to support the full feature matrix.

**Media send** — extend each channel client:

- `WhatsAppClient.sendImage(to, mediaIdOrUrl, caption?)`, `sendAudio(to, mediaIdOrUrl)`, `sendVideo(to, mediaIdOrUrl, caption?)`, `sendDocument(to, mediaIdOrUrl, filename, caption?)`. WhatsApp requires uploading media first (`POST /{PHONE_NUMBER_ID}/media`) to get a `media_id`, or providing a public URL.
- `MessengerClient.sendImage(recipientId, url)`, `sendAudio`, `sendVideo`, `sendFile`. Uses `message.attachment` with `type` and `payload.url`.
- `InstagramClient.sendImage(recipientId, url)`, `sendAudio`, `sendVideo`. Instagram supports audio/video/image attachments via the Send API. Documents are not generally supported.

**Media download** — `src/meta/shared/media.ts`: `downloadMedia(mediaId, channel)` for retrieving user-sent media. WhatsApp requires `GET /{media_id}` to get a URL, then `GET {url}` with the auth header. Messenger/Instagram include the URL directly in the webhook payload (or require a `GET /{attachment_id}` call).

**Templates** (WhatsApp-only at this stage):

`src/meta/whatsapp/templates.ts` — Helper for constructing template message payloads with header, body, and button components. Includes language parameter. The conversation agent should check `windowOpen` and automatically suggest/require template usage when the window is closed.

**Update `ChannelAdapter` interface** with `sendImage`, `sendAudio`, `sendVideo`, `sendDocument` methods. Each returns `SendResult`. The `supports()` method gates per-channel availability.

**Update `ChatAction` type** to include media and template actions (already spec'd in Stage 5).

---

### Stage 8 — Messenger and Instagram Platform Features

**Goal**: channel-specific features that don't exist on WhatsApp.

**Messenger Profile API** — `src/meta/messenger/profile.ts`:
- `setGetStartedButton(payload: string)` — `POST /{PAGE_ID}/messenger_profile` with `{ get_started: { payload } }`.
- `setPersistentMenu(menu: MenuItem[])` — localizable menu with URL and postback items.
- `setIceBreakers(iceBreakers: IceBreaker[])` — up to 4 conversation starters with question and payload.
- `setGreetingText(greetings: Greeting[])` — localizable welcome message.

**Instagram Ice Breakers** — `src/meta/instagram/ice-breakers.ts`:
- `setIceBreakers(iceBreakers: IceBreaker[])` — up to 4, localizable (Meta added multi-locale support per IG changelog). No Get Started button on Instagram.

**Private Replies** (Instagram-only) — `InstagramClient.sendPrivateReply(commentId: string, text: string)` — `POST /{IG_USER_ID}/messages` with `recipient: { comment_id }`. Must be within 7 days of the comment. This is the comment-to-DM funnel mechanism (the same one Upload-Post wraps).

**Webhook-handling additions:**
- Messenger `messaging_postbacks` — parsed in Stage 2, but now the conversation agent should route postback payloads to the chat endpoint as a `postback` action.
- Messenger `messaging_referrals` — `m.me` link clicks with `ref` parameter. Forward to chat endpoint.
- Instagram `messaging_referrals` — `ig.me` link clicks with `ref` parameter.

---

### Stage 9 — Examples

**Goal**: working examples that demonstrate the package without requiring a Meta account (local REPL) and with one (live device testing).

`examples/minimal-chat-endpoint/index.ts` — Smallest possible echo bot. Implements `CHAT_ENDPOINT_URL` contract: receives `ChatRequest`, returns `{ message: request.message }`. Demonstrates that the package works end-to-end with a trivial chat implementation.

`examples/multi-channel-router/index.ts` — Shows channel-aware response logic. Different greeting per channel, demonstrates checking `capabilities` to decide whether to send a template (WhatsApp) vs. a plain message (Messenger/Instagram).

`examples/showcase-bot/` — LLM-backed reference architecture (own `package.json` with Anthropic/Vercel AI SDK). Multi-turn conversation, tool use to build `actions[]`, demonstrates media, reactions, reply-to.

**Local REPL mode** — `scripts/repl.ts`: boots an example in-process, drops into a readline REPL where the user types messages as if they were a specific channel user. The REPL constructs a properly-shaped webhook payload, POSTs it to the local server (computing a valid `X-Hub-Signature-256`), and pretty-prints the outbound response. Commands:
- `/channel whatsapp|messenger|instagram` — switch simulated channel
- `/media <url>` — simulate media inbound
- `/reaction <emoji>` — simulate reaction
- `/status delivered|read` — simulate status callback
- `/raw` — show raw request/response JSON
- `/reset` — clear conversation state

```json
"example:chat": "tsx scripts/repl.ts --",
"example:dev": "tsx scripts/example-dev.ts --"
```

`npm run example:chat -- minimal-chat-endpoint` runs locally. `npm run example:dev -- showcase-bot` starts the full stack (agent + ngrok + webhook registration) for live-device testing.

---

### Stage 10 — Persistence, Limits, and Production Hardening

**Goal**: Redis-backed production durability, rate limiting, and boot-time recovery.

**Redis persistence** (same dual-path as SendBlue):

With `REDIS_URL`: conversation state, deduplicate (`SET NX` with TTL), outbound-handle → conversation-key map, BullMQ-delayed buffer processing. Without: in-memory maps and timers for tests/local.

**`src/limits/tracker.ts`:**

- Per-channel rate limiting respecting Meta's limits (WhatsApp tier-based, Instagram 2/sec/account, Messenger standard Graph API limits).
- Pre-send slot acquisition with pacing.
- Transient error retry (5xx, 429, rate limit errors) with exponential backoff.
- WhatsApp messaging window tracking: when a message is sent outside the 24h window without a template, the error is caught and the conversation agent is notified (it can then prompt the chat endpoint to respond with a template action).

**Boot-time recovery** — `ConversationAgent.recoverPendingRetries()`: on startup, scan Redis for conversations in `'sending'` state with pending retries. Re-arm timers. Same pattern as the SendBlue repo's `recoverPendingRetries`.

**Config validation hardening** — `loadConfig` throws on:
- Missing `META_APP_SECRET` (always required for signature verification).
- No channels enabled (at least one channel's tokens must be configured).
- Invalid token format (WhatsApp System User tokens are long alphanumeric strings; Page Access Tokens start with `EAA`; Instagram tokens start with `IGQ`).
- `META_GRAPH_API_VERSION` not matching `v\d+\.\d+` pattern.

---

## Documentation

### `CLAUDE.md`

Follows the structure of the SendBlue repo's `CLAUDE.md`: project scope, commands, architecture (single Express app, `createApp(deps)`, per-channel parsers/clients/adapters, conversation agent, chat contract, persistence, operational visibility), conversation state rules (keying, buffering, ordered delivery, channel-aware advancement, messaging window rules), conventions (TypeScript ESM, `.js` specifiers, Vitest, pino, capture artifacts gitignored, feature docs pattern).

Must include the platform-specific constraints that are load-bearing:
- Meta does not link users across channels. `(channel, channelScopedId)` is the primary key.
- Messenger/Instagram echo messages with `is_echo: true` — always filter.
- Instagram GIFs/stickers do not fire webhooks — tolerate silently.
- WhatsApp timestamps are seconds; Messenger/Instagram are milliseconds.
- Messenger `sender_action` (typing, mark_seen) must be a separate request from the message.
- WhatsApp typing indicators require the inbound `message_id`.
- Messaging window constraints per channel (see "Platform Context" section of this document — summarize in CLAUDE.md).
- `X-Hub-Signature-256` verification must happen on the raw body buffer before any JSON parsing middleware mutates it.
- ACK 200 immediately; process async. Meta retries for 7 days on non-2xx, then permanently drops.

### `docs/META-SETUP-GUIDE.md`

Step-by-step guide for configuring a Meta App from scratch: creating a Facebook Page, adding Messenger/Instagram/WhatsApp products, switching IG to Professional, generating tokens, adding test users, configuring webhook subscriptions. Written as a checklist the developer follows once, then never touches again. Reference the "Pre-testing setup checklist" from the research.

### `docs/TRUSTED-SOURCES.md`

Curated reference doc of authoritative Meta documentation URLs, known-outdated pages to avoid, community resources ranked by reliability, and methods to stay current (changelog bookmarks, version index, RSS). Content is already written in the research — extract into this file.

### `docs/META-PAYLOAD-STRUCTURES.md`

Documented webhook payload shapes per channel per message type, populated from real captures during the guided capture process. Initially empty; filled as the engineer runs `capture:guided`.

### `docs/features/*.md`

One file per feature, following the SendBlue repo's pattern: what it does, how it works, code files involved, configuration knobs, known limitations. The list of features files is in the repo structure above.

---

## Environment Variables

The full list, organized by category, with defaults and validation rules. Reference `.env.example` in Stage 1 for the template. All optional variables should have sensible defaults. Channel-specific variables should be skippable (if no WhatsApp tokens are set, WhatsApp is disabled — not an error).

### Required
- `META_APP_SECRET` — always required (signature verification)
- `META_VERIFY_TOKEN` — always required (webhook handshake)
- `CHAT_ENDPOINT_URL` — always required (where to send inbound messages)
- At least one channel's credentials must be configured

### Per-channel (all optional, enable/disable per channel)
- `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`
- `MESSENGER_PAGE_ID`, `MESSENGER_PAGE_ACCESS_TOKEN`
- `INSTAGRAM_USER_ID`, `INSTAGRAM_ACCESS_TOKEN`

### Optional runtime
- `META_GRAPH_API_VERSION` (default `v23.0`)
- `PORT` (default `3000`)
- `PUBLIC_BASE_URL` (for webhook registration scripts)
- `REDIS_URL` (enables Redis persistence)
- `ADMIN_API_TOKEN` (enables metrics + admin routes)
- `AGENT_AUTOSTART` (default `1`)
- `USER_LOOKUP_URL` (optional identity enrichment)
- Buffer tuning: `BUFFER_BASE_TIMEOUT_MS` (2000), `BUFFER_GROWTH_FACTOR` (1.25), `BUFFER_MAX_TIMEOUT_MS` (8000), `BUFFER_NOISE_MAX_DEVIATION` (0.3)
- Typing: `OUTBOUND_TYPING_INDICATORS_ENABLED` (true), `TYPING_REFRESH_INTERVAL_MS` (5000), `TYPING_REFRESH_MAX_MS` (120000)
- Read receipts: `READ_RECEIPTS_ENABLED` (false)
- Delivery: `OUTBOUND_DELIVERY_TIMEOUT_MS` (30000)

### E2E only
- `E2E_TEST_WHATSAPP_NUMBER`, `E2E_TEST_FACEBOOK_PSID`, `E2E_TEST_INSTAGRAM_IGSID`
- `NGROK_AUTHTOKEN`, `NGROK_DOMAIN`

---

## Execution Order

For the engineer executing this plan, the recommended build order is:

1. **Stage 1** — Get a server running that receives and verifies Meta webhooks. Tests pass.
2. **Stage 2** — Parse all three webhook formats into normalized types. Tests pass.
3. **Stage 3** — Build the setup verification and capture tooling. Run `setup:all` against real Meta accounts to confirm everything works. Capture real payloads. Promote captures to test fixtures.
4. **Stage 4** — Send messages back. Verify outbound works on all three channels via the setup scripts.
5. **Stage 5** — Wire up the conversation agent. Full inbound → chat → outbound flow working.
6. **Stage 6** — Status tracking, identity, operational visibility.
7. **Stage 7** — Rich features (media, reactions, reply-to, templates).
8. **Stage 8** — Platform-specific features (Messenger profile, IG ice breakers, private replies).
9. **Stage 9** — Examples and REPL.
10. **Stage 10** — Production hardening (Redis, limits, recovery).

Stages 1–5 are the critical path. Stages 6–10 can be parallelized or reordered based on priorities. Stage 3 should be run as early as possible to get real payloads — the fixture files from Stages 1–2 are documentation-derived placeholders; real payloads always differ in subtle ways.
