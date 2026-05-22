# Trusted Sources

Curated reference list for engineers working on `meta-ai-agent`. Prefer these sources over training-data recall, blog posts, or community Q&A unless the post is signed by a Meta platform engineer. Meta's webhook formats and product capabilities drift several times a year; check the changelog before assuming a behavior.

## Primary documentation entry points

- **Meta for Developers** — https://developers.facebook.com/docs/
  Top-level portal. Every product below has its own subtree.
- **Graph API reference** — https://developers.facebook.com/docs/graph-api/
  The base layer for every messaging product. Pin to a known version (`v25.0` is this package's default; configurable via `META_GRAPH_API_VERSION`).
- **Graph API changelog** — https://developers.facebook.com/docs/graph-api/changelog
  The canonical breaking-changes index. Every Graph API version has a dedicated page listing additions, deprecations, and behavior changes. Read the changelog for the version you target before shipping; Meta supports each version for ~24 months and gives ~6 months' notice on deprecations.

## WhatsApp Cloud API

- **Cloud API overview** — https://developers.facebook.com/docs/whatsapp/cloud-api
  Start here. Covers phone-number management, message types, webhooks, templates, media, and pricing.
- **Send messages** — https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
  `POST /{phone-number-id}/messages` reference. Text, media, template, interactive, reaction, location, contacts, typing indicator, mark-read endpoints. Note that typing indicators and mark-read both go through this endpoint with different `type`/`status` fields — not separate endpoints.
- **Webhooks for `whatsapp_business_account` object** — https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks
  Payload shapes for inbound `messages[]`, `statuses[]`, `errors[]` blocks inside `entry[].changes[].value`. Message ID format is `wamid.HBg...`; reactions are a `reaction` message type; reply-to lives on `context.message_id`.
- **Message templates** — https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates
  Template categories, approval flow, component structure. **Out-of-window messaging requires templates** and templates are paid since 2025-07-01.
- **Cloud API error codes** — https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
  The authoritative WhatsApp error-code reference. Backs the code sets in [`src/limits/error-codes.ts`](../src/limits/error-codes.ts): the window code `131047` ("Re-engagement message", the live 24h-window error), the rate-limit codes `80007` / `130429` / `131056`, the policy/quality throttles `131048` / `131049` / `368`, recipient codes `131026` / `131030` / `131045`, and server codes `131000`. Each membership decision in that module cites this reference; the Stage 10 `LimitTracker.classifyError` and `whatsappFailureCategory` consume them. Verify a code's meaning here before changing how a send failure is classified (transient vs. window-closed vs. permanent).
- **Rate limits (Graph API)** — https://developers.facebook.com/docs/graph-api/overview/rate-limiting
  App-level and BUC (business-use-case) rate-limiting model. Backs the rate-limit error codes `4` ("Application request limit reached") and `613` in `src/limits/error-codes.ts`, and the per-second pacing defaults in [Rate limiting](./features/rate-limiting.md). Note the general Graph baseline (~2/s) is NOT the messaging throughput limit — see the messaging-throughput note in the rate-limiting feature doc.
- **Messaging limits / messaging tiers** — https://developers.facebook.com/docs/whatsapp/cloud-api/overview/messaging-limits
  The conversation-based tier model (1K / 10K / 100K / unlimited unique recipients per rolling 24h, raised after business verification + quality). This is why the package's per-hour/per-day counters are **track-only advisory proxies**, not true gating caps — the real limit is conversation-based and enforced server-side by Meta. Backs the WhatsApp `1000/h` / `10000/d` advisory defaults in `config.limits`.
- **Conversation-based pricing / per-message pricing** — https://developers.facebook.com/docs/whatsapp/pricing
  The 2025 shift to per-message pricing (PMP) replacing the older 24h conversation-pricing window (effective 2025-07-01). Backs the `value.statuses[].pricing` block (`pricing_model: "PMP"`, `category`) documented in [META-PAYLOAD-STRUCTURES.md](./META-PAYLOAD-STRUCTURES.md) — relevant if a future cost-observability pass consumes `pricing.category`.

## Messenger Platform

- **Messenger Platform overview** — https://developers.facebook.com/docs/messenger-platform
  Entry point. Set up, page linkage, app review process, supported message types.
- **Send API reference** — https://developers.facebook.com/docs/messenger-platform/send-messages
  `POST /{page-id}/messages` reference. `messaging_type` values (`RESPONSE`, `UPDATE`, `MESSAGE_TAG`), tag values, `sender_action` (`typing_on`, `typing_off`, `mark_seen`) — note that `sender_action` must be a **separate POST** from any message body. Combined requests are rejected.
- **Webhooks for the `page` object** — https://developers.facebook.com/docs/messenger-platform/webhooks
  `entry[].messaging[]` shape with `sender.id` (PSID), `recipient.id` (Page ID), `message`, `postback`, `delivery`, `read`, `reaction`, `referral`, and the `is_echo: true` flag on echoes of business-sent messages.
- **Messenger Profile API** — https://developers.facebook.com/docs/messenger-platform/messenger-profile
  Get Started button, Persistent Menu, Ice Breakers, greeting text. Stage 8 of the implementation plan.
- **Messaging windows and policy** — https://developers.facebook.com/docs/messenger-platform/policy/policy-overview
  Standard Messaging Window (24h), `HUMAN_AGENT` 7-day window (human-only), Message Tags policy. Note 2026-04-27 deprecation of `CONFIRMED_EVENT_UPDATE`, `ACCOUNT_UPDATE`, `POST_PURCHASE_UPDATE`.
- **`POST /{page-id}/subscribed_apps` reference** — https://developers.facebook.com/docs/graph-api/reference/page/subscribed_apps/
  Documents the per-Page subscription attachment call. Critical for understanding token requirements: "A Page access token requested by a person who can perform CREATE_CONTENT, MANAGE, or MODERATE task on the Page." That phrasing is load-bearing — see [KNOWN-GAPS](./KNOWN-GAPS.md) for the System User token failure mode and why we steer developers to Dashboard-generated or FB-Login-for-Business-minted Page tokens instead.
- **Facebook Login for Business** — https://developers.facebook.com/docs/facebook-login/facebook-login-for-business
  The modern path for minting scope-controlled Page Access Tokens. Configurations live at App Dashboard → Facebook Login for Business → Configurations and save a scope-set blob with a `config_id`. The authorize URL is constructed (not provided by Meta) as `https://www.facebook.com/{version}/dialog/oauth?client_id=...&config_id=...&redirect_uri=...&response_type=code&state=...`. **Caveat**: Meta's main FB Login for Business doc page lists the product surface but does NOT spell out the OAuth URL pattern or the User Token → `/me/accounts` → Page Token derivation chain. The authoritative pattern is confirmed by following the legacy "Manually Build a Login Flow" guide plus community sources. Stage 3's `scripts/setup/oauth-messenger.ts` is the canonical reference implementation in this repo.
- **"Manually Build a Login Flow"** — https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow/
  The authoritative source for the `dialog/oauth` authorize URL parameters and the `graph.facebook.com/{version}/oauth/access_token` code-exchange shape (GET with query params, NOT POST form — distinct from Instagram's `api.instagram.com/oauth/access_token` POST flow).
- **Get long-lived User Access Tokens** — https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived
  The `grant_type=fb_exchange_token` swap. `setup:oauth:messenger` calls this defensively when the FB Login for Business config's `expires_in` indicates the issued User Token is short-lived; configurations set to "Never" expiry omit `expires_in` and the swap is skipped.
- **Pages API — `/me/accounts`** — https://developers.facebook.com/docs/pages-api/getting-started/
  The User Token → Page Token derivation step. `GET /me/accounts?fields=id,name,access_token,category,tasks` returns one entry per Page the authenticated user manages, each with its own Page Access Token. `setup:oauth:messenger` consumes this and matches against `MESSENGER_PAGE_ID` (or prompts when ambiguous).

## Instagram Platform (Business Login)

- **Instagram Platform overview** — https://developers.facebook.com/docs/instagram-platform
  Entry point. Distinguishes the **Business Login** flow (modern; uses `graph.instagram.com`) from the legacy Page-linked flow (uses `graph.facebook.com` through the Page).
- **Instagram messaging** — https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api
  Send API, supported message types, conversations endpoint. Instagram supports audio/video/image attachments but **not document attachments**. GIFs and stickers do not fire inbound webhooks.
- **Webhooks for the `instagram` object** — https://developers.facebook.com/docs/instagram-platform/webhooks
  `entry[].messaging[]` shape. Nearly identical to Messenger but distinct `object` value (`instagram`) and IGSID instead of PSID. Story replies populate `reply_to.story`; story mentions arrive as a distinct payload.
- **Business Login OAuth** — https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login
  The OAuth code → short-lived token → long-lived token exchange. Short-lived tokens last ~1 hour; long-lived tokens last ~60 days and must be refreshed before expiry. Stage 3 of the implementation plan automates this via `npm run setup:oauth:instagram`.
- **Private Replies** — https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/private-replies
  Comment-to-DM mechanism. 7-day window per comment. Stage 8.

## Webhook security

- **Webhooks security overview** — https://developers.facebook.com/docs/graph-api/webhooks/getting-started#payload
  Documents `X-Hub-Signature-256: sha256=<hex>` — HMAC-SHA256 of the raw request body keyed by the App Secret. The same scheme applies to all three products under the same app.
- **App Secret rotation** — https://developers.facebook.com/docs/development/build-and-test/app-secret
  How to roll the App Secret without taking webhooks offline (use temporary secondary secret).

## Versioning and lifecycle

- **Graph API versions index** — https://developers.facebook.com/docs/graph-api/changelog/versions
  Lists every supported version, release date, and end-of-life date. Pin a version in code and bump deliberately.
- **Platform deprecation policy** — https://developers.facebook.com/docs/graph-api/changelog
  Each version is supported for ~24 months with ~6 months' deprecation notice. The package defaults to `v25.0` (`META_GRAPH_API_VERSION`); check the live versions index for the current EOL dates and plan upgrades around them rather than relying on dates baked into this doc.

## Outdated / deprecated — avoid

- **Legacy Instagram Page-linked flow.** Older Meta documentation describes Instagram messaging as a sub-feature of a linked Facebook Page (use `graph.facebook.com/{page-id}/conversations`). **Use the Business Login flow instead** (`graph.instagram.com`, separate Instagram User Access Token). The legacy flow is being deprecated and webhook payloads differ from the modern path in ways that cause silent parser bugs.
- **"Use System User Access Tokens for Messenger" guidance** (including in older versions of this doc). Validated false during Stage 3 manual testing: System User tokens are rejected by `POST /{pageId}/subscribed_apps` with HTTP 403 / code 210 even when the System User has full Page asset control. Meta's [`subscribed_apps` reference](https://developers.facebook.com/docs/graph-api/reference/page/subscribed_apps/) explicitly requires "*A Page access token requested by a person*" — System User tokens are app-installed, not user-requested, and don't satisfy that. **Use a Dashboard-generated Page Access Token (`type: PAGE`)** from Messenger → Settings → Access Tokens (if your auth grants already cover the needed scopes), **or use Facebook Login for Business via `npm run setup:oauth:messenger`** (if you need scopes beyond what's been granted). System User permanence is **WhatsApp-specific** (Cloud API has no Dashboard "Generate Permanent Token" alternative). See [KNOWN-GAPS](./KNOWN-GAPS.md) for the full validation log.
- **Pre-Cloud-API WhatsApp on-premise Business API.** Different request shapes, different auth, different deployment model. The Cloud API (this package's target) replaces it; do not consult on-prem docs.
- **"Send Action" parameter combined with message body on Messenger.** Older code samples show `sender_action` in the same POST as `message`. Meta now rejects this — it must be a separate request.
- **"`localhost` is OK as an Instagram OAuth redirect URI" claims in older posts.** Meta's Instagram Business Login currently rejects `localhost` redirect URIs in most configurations. Use the ngrok HTTPS domain instead. `setup:oauth:instagram` no longer offers a CLI override for the redirect URI; the redirect URI is parsed directly from `INSTAGRAM_AUTHORIZE_URL`, which is itself copied verbatim from the Meta Dashboard. If you need a different redirect URI, regenerate the embed URL in the Dashboard against that pre-registered value.
- **Specific Graph API version references in tutorials.** Meta retires versions on a ~24-month cadence; tutorials older than 6 months frequently reference versions that no longer exist in the Dashboard. The implementation plan was authored against `v23.0` and Meta has since retired it; the Dashboard's current floor is `v25.0`. Re-check the version against the live changelog rather than copying from a tutorial.

## Status and outage tracking

- **Meta Platform Status** — https://metastatus.com
  Current status of Graph API, WhatsApp, Messenger, Instagram, and other Meta services.
- **Developer Community forum** — https://developers.facebook.com/community/
  Bug reports and unofficial behavior notes. Useful for "is this just me or is this broken everywhere" questions. Cross-reference with `metastatus.com` and the changelog before relying on a forum answer.
- **WhatsApp Business Platform changelog** — https://developers.facebook.com/docs/whatsapp/business-platform/changelog
  WhatsApp-specific changes (template pricing, region pauses, etc.) that don't always appear in the Graph API changelog.

## How to stay current

1. Bookmark the Graph API changelog and check it before bumping `META_GRAPH_API_VERSION`.
2. Subscribe to release notes for each product (WhatsApp / Messenger / Instagram subtrees each publish their own).
3. When `meta-ai-agent` ships a new minor version, scan the changelog for the supported Graph API version and update [META-PAYLOAD-STRUCTURES.md](./META-PAYLOAD-STRUCTURES.md) from fresh captures.
4. Treat any third-party article older than 6 months as suspect — verify against the live docs and recent captures.
