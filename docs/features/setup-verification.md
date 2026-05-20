# Setup verification

## Purpose

The verify scripts walk a developer through configuration validation, webhook subscription, and send/receive testing against a real Meta App without leaving the terminal. Each per-channel script confirms a single channel end-to-end; `verify-all` orchestrates the three under one shared tunnel. The goal is to turn "is my Meta App actually wired up?" from a multi-hour debugging exercise into a guided checklist that surfaces the silent killers (Instagram message-access toggle, tester-role gates, callback URL drift, missing WABA subscription).

## Commands

```bash
npm run setup:whatsapp           # Verify WhatsApp Cloud API end-to-end
npm run setup:messenger          # Verify Messenger (Page) end-to-end
npm run setup:instagram          # Verify Instagram Business DM end-to-end
npm run setup:all                # Verify every configured channel in one session

npm run setup:oauth:instagram    # OAuth flow → long-lived (~60d) IG token (run first)
npm run setup:oauth:messenger    # FB Login for Business → scope-controlled Messenger Page token
npm run meta:webhooks            # Standalone programmatic webhook registration
```

Each script accepts `--help` (or `-h`) for a flag reference. Run order for a fresh app: `setup:oauth:instagram` (if using Instagram) → `setup:oauth:messenger` (if you need scopes beyond what the Dashboard "Generate Token" button can mint, e.g. `pages_read_engagement` / `pages_manage_metadata`) → `setup:all`.

## Pre-flight

Confirm the following before running any verify script. Most "the script timed out" or "the handshake failed" reports trace back to one of these.

- **`.env` is populated** with `META_APP_ID`, `META_APP_SECRET`, `META_VERIFY_TOKEN` (≥ 16 chars, no surrounding whitespace or quotes), `META_GRAPH_API_VERSION` (matches `^v\d+\.\d+$`), `CHAT_ENDPOINT_URL`, `NGROK_DOMAIN` (bare hostname — no scheme, no path), `NGROK_AUTHTOKEN`, and at least one channel block. **For Instagram**, also set `INSTAGRAM_AUTHORIZE_URL` (the embed authorize URL pasted from the Meta App Dashboard) and `INSTAGRAM_APP_SECRET` (the Instagram product's own secret, distinct from `META_APP_SECRET`) — both are read by `setup:oauth:instagram` before it will start. See [Meta App setup guide](../META-SETUP-GUIDE.md) section 3.
- **The three Dashboard webhook callback URLs are configured and "Verify and Save" was clicked while a capture server was listening** on your ngrok domain. If you have not yet done this, do `npm run capture:fixtures -- --no-webhook-registration` in another terminal first and click Verify in the Dashboard while it's running — see the top-of-doc callout in the setup guide.
- **`META_VERIFY_TOKEN` is byte-for-byte identical** between `.env` and each of the three Dashboard webhook configs. A trailing space or wrapping quote will break the handshake silently.
- **No other ngrok tunnel is running.** Free-tier ngrok permits only one active tunnel; a stray `capture:fixtures` will fight `setup:{channel}` for the reserved domain.
- **Roles configured.** The personal Facebook / Instagram accounts you'll use to send inbound test messages must have Tester / Admin / Developer role on the Meta App (Settings → App Roles). Otherwise the messages compose but never deliver, with no error surface.
- **Instagram only**: "Allow access to messages" toggle is ON in the IG mobile app (Settings → Messages and story replies → Message controls). When OFF, the verify script's inbound step times out with zero error signal — this is the #1 silent killer.
- **WhatsApp only**: if you want real inbound webhooks, the app must be published (Live mode). In Development mode, only the Dashboard "Send Test" button delivers WhatsApp webhooks. See [Known gaps](../KNOWN-GAPS.md).

## Architecture

```
        ┌────────────── verify-all.ts ──────────────┐
        │                                            │
        │  bootstrapVerifyContext (verify-shared.ts) │
        │       │                                    │
        │       ├─ loadConfig()                      │
        │       ├─ startCaptureServer  ─────┐        │
        │       │     ├─ express app        │        │
        │       │     ├─ verifyMetaSignature│        │
        │       │     └─ startTunnel(ngrok) │        │
        │       └─ registerAllWebhooks ─────┤        │
        │             │                     │        │
        │   ┌─────────┼────────────┬────────┘        │
        │   │         │            │                 │
        │   ▼         ▼            ▼                 │
        │ runWhatsApp runMessenger runInstagram      │
        │   Verify    Verify       Verify            │
        │   │         │            │                 │
        │   └─ each runs: config → token → webhook   │
        │       audit → outbound test → inbound      │
        │       capture → optional reaction          │
        │                                            │
        └────── printVerifySummary(results) ─────────┘
                            │
                            ▼
                    capture.close() (tunnel + server)
```

`verify-all` uses **one** ngrok tunnel and **one** capture server across all three channels; the free-tier ngrok account is limited to 1 simultaneous tunnel, so running multiple per-channel verify scripts in parallel will fail.

Source: [`scripts/setup/verify-shared.ts`](../../scripts/setup/verify-shared.ts) (bootstrap), [`scripts/lib/capture-server.ts`](../../scripts/lib/capture-server.ts) (Express + tunnel), [`scripts/lib/tunnel.ts`](../../scripts/lib/tunnel.ts) (ngrok), [`scripts/setup/register-webhooks.ts`](../../scripts/setup/register-webhooks.ts) (subscription).

## Per-channel verification flow

### WhatsApp (`scripts/setup/verify-whatsapp.ts`)

**Prerequisites:**

- `META_APP_ID`, `META_APP_SECRET`, `META_VERIFY_TOKEN` set.
- `WHATSAPP_PHONE_NUMBER_ID` + `WHATSAPP_ACCESS_TOKEN` (System User token recommended — never expires).
- `WHATSAPP_BUSINESS_ACCOUNT_ID` (optional but required for programmatic per-WABA subscription — see "Channel-specific gotchas" below).
- `NGROK_AUTHTOKEN` set.
- Dashboard: WhatsApp product added; test phone number provisioned.
- Optional: `E2E_TEST_WHATSAPP_NUMBER` (E.164 without `+`) to enable the outbound smoke test.

**Steps the script runs:**

1. **Config check** — confirms credentials present and `channels.whatsapp = true`.
2. **Token validity** — `GET /{phoneNumberId}?fields=display_phone_number,verified_name,quality_rating` against `graph.facebook.com`. Surfaces the resolved display number for the inbound prompt.
3. **Webhook subscription audit** — `inspectExistingSubscriptions` lists app-level subscriptions and looks for `object: whatsapp_business_account` pointing at the current tunnel URL. Drift between the dashboard URL and the live tunnel is flagged with remediation instructions.
4. **Outbound test** (skippable via `--skip-outbound`) — sends the `hello_world` template (the Meta-approved global template) to `E2E_TEST_WHATSAPP_NUMBER` via `POST /{phoneNumberId}/messages` with `Authorization: Bearer {token}`. Waits up to 2 minutes for an outbound status webhook (`sent` / `delivered` / `read`).
5. **Inbound test** — prompts you to send a real text from a personal WhatsApp to the business number. Waits up to 5 minutes for an inbound text webhook.
6. **Optional reaction capture** — opt-in prompt to react to a message and capture the reaction webhook.

**Captured files (in `.captures/meta/whatsapp/`):**

- `outbound-test-template.json` — outbound status from step 4.
- `inbound-test-text.json` — inbound text from step 5.
- `inbound-reaction.json` — reaction from step 6 (if performed).

**Common failure modes:**

- *Token validity fails with HTTP 401* — token expired or wrong scope. System User tokens with `whatsapp_business_messaging` + `whatsapp_business_management` scopes are required.
- *Webhook audit reports "No `whatsapp_business_account` subscription found"* — initial setup needs Dashboard interaction (see file-level WHY comment in `verify-whatsapp.ts`). Open App Dashboard → WhatsApp → Configuration → Webhook, paste the callback URL and verify token shown in the script output, subscribe to `messages`.
- *Outbound POST returns 100 / 131009* — recipient number is not opted in or the test number can only send to numbers explicitly added in the Dashboard's allow list.
- *Outbound succeeds but no status webhook arrives* — `WHATSAPP_BUSINESS_ACCOUNT_ID` is unset; the per-WABA subscription was never made.

### Messenger (`scripts/setup/verify-messenger.ts`)

**Prerequisites:**

- `MESSENGER_PAGE_ID` + `MESSENGER_PAGE_ACCESS_TOKEN`.
- A Facebook Page that the developer admins, linked to the app via Messenger → Access Tokens.
- Personal Facebook account that will DM the Page **must have Tester / Admin / Developer role on the Meta App** until the app is Live.
- `NGROK_AUTHTOKEN` set.

**Steps the script runs:**

1. **Config check.**
2. **Token validity** — `GET /{pageId}?fields=name,id`.
3. **Webhook subscription audit** — confirms an `object: page` subscription exists with the current tunnel as its `callback_url`; the per-Page `subscribed_apps` POST is handled by `registerAllWebhooks` during bootstrap.
4. **Tester role reminder** — manual confirmation prompt; the script cannot introspect app roles via Graph API.
5. **Inbound test** — prompts you to DM the Page from your personal account; waits up to 5 minutes.
6. **Outbound reply** (skippable) — `POST /{pageId}/messages` with `messaging_type=RESPONSE` echoing back to `sender.id`. Meta's 200 + `message_id` is the authoritative success signal (no human-confirm prompt). The script then best-effort waits up to 30 seconds for a `message_echoes` webhook mirroring the outbound back; a timeout is logged informationally and never fails the step (echo subscription propagation can lag fresh `subscribed_apps` calls).
7. **Optional reaction capture** — opt-in prompt to react to a recent business message; the parser surfaces Messenger reactions as `MessageType: 'reaction'` via the `messaging[].reaction` event shape.
8. **Summary marker.**

**Captured files (in `.captures/meta/messenger/`):**

- `inbound-test-text.json` — inbound text from step 5.
- `inbound-reaction.json` — reaction from step 7 (if performed).

**Common failure modes:**

- *Inbound test times out and tester role was not confirmed* — the most common cause. App in Development mode silently drops messages from non-tester accounts.
- *Outbound POST returns 200 with no `message_id`* — unusual; the step downgrades to `skip` with a warning. Re-run after refreshing the Page Access Token.
- *Outbound passes but no echo webhook arrives within 30s* — informational only. `message_echoes` subscription can take a few minutes to propagate after a fresh `subscribed_apps` call; the outbound itself is API-confirmed.
- *Webhook audit reports callback URL drift* — `--ngrok-domain=<stable>` to pin a reserved domain, or update the Dashboard URL.

### Instagram (`scripts/setup/verify-instagram.ts`)

**Prerequisites:**

- `INSTAGRAM_USER_ID` + `INSTAGRAM_ACCESS_TOKEN` (long-lived). Run `npm run setup:oauth:instagram` first if these are not yet captured — that script additionally requires `INSTAGRAM_AUTHORIZE_URL` and `INSTAGRAM_APP_SECRET` (see the OAuth section below).
- Instagram account in **Professional → Business or Creator** mode.
- On the official IG mobile app: Settings → Messages and story replies → Message controls → **Allow access to messages = ON**.
- Personal IG account (separate from the business one) for sending the test DM.
- `NGROK_AUTHTOKEN` set.

**Steps the script runs:**

1. **Config check** — directs you to `setup:oauth:instagram` if creds missing.
2. **Token validity** — `GET https://graph.instagram.com/{version}/me?fields=user_id,username`. Note: Instagram Business Login lives on `graph.instagram.com`, NOT `graph.facebook.com`.
3. **Webhook subscription audit** — checks the app-level `/{appId}/subscriptions` list. **Known limitation**: this never surfaces Instagram's *per-user* subscription (created via `graph.instagram.com/{userId}/subscribed_apps`), so it always warns "No `instagram` subscription found" even when registration succeeded. Trust the registration block at the top of the run, not this audit. See [Known gaps](../KNOWN-GAPS.md).
4. **"Allow access to messages" reminder** — interactive confirmation. Silent killer #1: when this is OFF, Meta accepts the subscription and ACKs 200 on every setup call but no webhook ever fires, and there is no API to read the setting's state.
5. **Instagram Tester registration reminder** — interactive confirmation. Silent killer #2 (Development mode): Instagram only delivers webhooks for DMs from accounts registered as **Instagram Testers** (App Dashboard → App Roles → Roles → Instagram Testers — a list separate from the Facebook app roles). BOTH the business account and the personal account you DM from must be accepted testers. The invite can only be **accepted on the web** (instagram.com → Settings → Apps and websites → Tester invites); the mobile app does not show the acceptance screen. See [Meta App setup guide](../META-SETUP-GUIDE.md) and [Known gaps](../KNOWN-GAPS.md).
6. **Inbound test** — prompts you to DM the business account from a personal (tester) IG account. A first DM from a non-connection lands in "message requests" — that's fine; the Send API replies without needing manual acceptance.
7. **Outbound reply** (skippable) — `POST graph.instagram.com/{userId}/messages` echoing back to `sender.id`. Meta's 200 + `message_id` is the authoritative success signal (no human-confirm prompt). Unlike Messenger, Instagram has **no `message_echoes` webhook field**, so there is no echo to wait for — the Send API response is the only outbound confirmation available on IG.
8. **Optional reaction capture** — opt-in prompt to react to a recent business DM; the parser surfaces Instagram reactions as `MessageType: 'reaction'` via the `messaging[].reaction` event shape.
9. **Summary marker.**

**Captured files (in `.captures/meta/instagram/`):**

- `inbound-test-dm.json` — inbound DM from step 6.
- `inbound-reaction.json` — reaction from step 8 (if performed).

**Common failure modes:**

- *Token validity fails with 401* — long-lived token expired (~60d lifetime). Re-run `setup:oauth:instagram`.
- *Inbound times out* — in order of likelihood: (1) the sending account isn't an accepted **Instagram Tester** (Development-mode gate — silent killer #2; remember the invite is web-accept-only); (2) **"Allow access to messages"** is OFF on the business IG app (silent killer #1); (3) IG OAuth scopes misconfigured — revisit `instagram_business_basic` + `instagram_business_manage_messages` in the configuration.
- *`subscribe_instagram_app` fails with HTTP 400 / code 100* — an invalid field in `SUBSCRIBED_FIELDS.instagram`. `message_echoes` is the classic culprit (Messenger-only; not valid for IG). The accepted IG set is `messages, messaging_postbacks, messaging_seen, message_reactions, messaging_referral`.
- *Outbound POST returns 200 with no `message_id`* — unusual; the step downgrades to `skip` with a warning. Re-run after refreshing the long-lived token.
- *Inbound arrives but the message was a "request"* — expected for a first DM from a non-connection. The Send API still replies within the 24h window without manual acceptance; not a failure.

## Channel-specific gotchas

### WhatsApp

- **WABA subscription is the load-bearing call.** Configuring the callback URL + verify token in App Dashboard → WhatsApp → Configuration → Webhook gives you a working verification handshake but **zero actual deliveries** until `POST /{WABA_ID}/subscribed_apps` runs. Without `WHATSAPP_BUSINESS_ACCOUNT_ID` set in `.env`, `registerAllWebhooks` reports `manual_required` and skips the per-WABA step. With it set, the script attempts `subscribeWhatsAppBusinessAccount` automatically — see [`scripts/lib/graph-api.ts:subscribeWhatsAppBusinessAccount`](../../scripts/lib/graph-api.ts).
- **The initial product setup must happen in the Dashboard.** Meta's `/{appId}/subscriptions` POST for `object: whatsapp_business_account` is only documented for `user`, `page`, `permissions`, and `payments`. The script intentionally skips this call and falls back to coaching the developer through the Dashboard step.

### Messenger

- **Tester role is the silent gate.** Until the app is Live (requires App Review), only personal Facebook accounts with a Tester / Admin / Developer role on the Meta App can DM the Page. There is no Graph API to read these roles, so `verify-messenger` surfaces this as a manual confirmation prompt.
- **`subscribed_fields` includes `message_echoes`** so the script receives a webhook for its own outbound reply (useful for round-trip confirmation). See `SUBSCRIBED_FIELDS.messenger` in [`scripts/setup/register-webhooks.ts`](../../scripts/setup/register-webhooks.ts).
- **`sender_action` (typing / read) must be a separate request from the message.** Combining is rejected. Stage 4 concern, but it shapes the messenger reply step's "two-call" cadence.

### Instagram

- **Business Login, not Page-linked.** The script targets the Instagram Business Login flow (`object: 'instagram'`). The legacy Page-linked IG flow surfaces under `object: 'page'` and is not supported — its webhook payloads differ subtly and the OAuth lifecycle is different. The IG account must be linked to a Facebook Page in Business Manager for Business Login to work, but the webhooks still arrive as `object: 'instagram'`.
- **Meta App credentials are NOT Instagram credentials.** `META_APP_ID` / `META_APP_SECRET` (App Settings → Basic) sign webhooks and authorize app-level Graph API calls. The Instagram OAuth flow uses a separate `client_id` (parsed from `INSTAGRAM_AUTHORIZE_URL`) and `INSTAGRAM_APP_SECRET` — both found in Meta App Dashboard → Instagram → API setup with Instagram Business Login. Confusing them yields opaque "Invalid platform app" / "redirect_uri mismatch" errors from `api.instagram.com/oauth/access_token`. The OAuth script refuses to fall back from one to the other.
- **`INSTAGRAM_AUTHORIZE_URL` is the single source of truth for the redirect URI.** `oauth-instagram.ts` no longer constructs an authorize URL itself in the live flow — it parses `client_id`, `redirect_uri`, and (when present) `state` directly from the embed URL Meta provides in the Dashboard, and validates that the tunnel host matches `redirect_uri` before opening the browser. When the embed URL omits `state` (Meta's Dashboard embed always does), the script generates a fresh CSRF nonce and appends it. There is no CLI override for the redirect URI — the embed URL is the only input.
- **Tokens are short-lived from OAuth.** The OAuth flow returns a 1-hour short-lived token; `setup:oauth:instagram` automatically swaps it for a ~60-day long-lived token via the unversioned `https://graph.instagram.com/access_token` endpoint. No refresh automation yet — see [Known gaps](../KNOWN-GAPS.md).
- **"Allow access to messages" is the silent killer.** No API to detect it; the verify script asks the developer to confirm. When OFF, Meta returns 200 on every setup call and zero webhooks ever fire.
- **Subscribed-field name is singular: `messaging_referral`.** Messenger uses the plural `messaging_referrals`. The constant `SUBSCRIBED_FIELDS.instagram` in [`scripts/setup/register-webhooks.ts`](../../scripts/setup/register-webhooks.ts) reflects this.

## CLI flags reference

### `setup:whatsapp` / `setup:messenger` / `setup:instagram` / `setup:all`

Defined in [`scripts/setup/verify-shared.ts`](../../scripts/setup/verify-shared.ts).

| Flag | Effect |
| --- | --- |
| `--channels=a,b,c` | Comma-separated channels to verify. Only meaningful for `setup:all`. Defaults to every channel configured in `.env`. Values: `whatsapp`, `messenger`, `instagram`. |
| `--skip-webhook-registration` | Skip the `registerAllWebhooks` call during bootstrap. Use when you've already subscribed and just want to confirm send/receive. |
| `--skip-outbound` | Skip the outbound smoke test (template / reply). The inbound capture still runs. |
| `--ngrok-domain=<domain>` | Reserved ngrok subdomain (e.g. `my-app.ngrok-free.dev` on free tier). Lets you pin a stable callback URL between runs. |
| `--port=<n>` | Local capture-server port. Defaults to `$PORT` or `3000`. |
| `--accept-invalid-signatures` | Capture webhooks even when `X-Hub-Signature-256` fails. Useful while iterating on `META_APP_SECRET`. |
| `--help`, `-h` | Print usage. |

### `meta:webhooks`

Defined in [`scripts/setup/register-webhooks.ts`](../../scripts/setup/register-webhooks.ts).

| Flag | Effect |
| --- | --- |
| `--callback-url=<url>` | Public HTTPS webhook URL. If omitted, falls back to `PUBLIC_BASE_URL` env var with `/webhook` appended. |
| `--inspect`, `-i` | Print current subscriptions and exit without modifying anything. |
| `--help`, `-h` | Print usage. |

### `setup:oauth:instagram`

Defined in [`scripts/setup/oauth-instagram.ts`](../../scripts/setup/oauth-instagram.ts).

**Required env vars** (validated at startup; the script refuses to start without them):

| Env var | Source | Used for |
| --- | --- | --- |
| `INSTAGRAM_AUTHORIZE_URL` | Meta App Dashboard → Instagram → API setup with Instagram Business Login → "Authorize this app for Instagram business" (copy the entire embed URL verbatim) | The script parses `client_id`, `redirect_uri`, and (when present) `state` out of this URL via `parseAuthorizeUrl`; it never constructs an authorize URL itself. Meta's embed omits `state`, so the script generates a fresh CSRF nonce and appends it via `withState`. |
| `INSTAGRAM_APP_SECRET` | Same Dashboard section, labeled "Instagram app secret" | Both the short-lived (`POST api.instagram.com/oauth/access_token`) and long-lived (`GET graph.instagram.com/access_token`) token exchanges. **Distinct from `META_APP_SECRET`** — the Instagram product inside a Meta App has its own credential pair. |
| `NGROK_AUTHTOKEN` / `NGROK_DOMAIN` | ngrok dashboard | The OAuth script spins its own tunnel and sanity-checks that the tunnel host matches `redirect_uri`. |

The script's startup validation deliberately does NOT consume `META_APP_ID` or `META_APP_SECRET` — those govern webhook signing and app-level Graph API calls, not Instagram OAuth.

**CLI flags:**

| Flag | Effect |
| --- | --- |
| `--reveal` | Print the long-lived token unmasked. Default masks the token (first 10 + last 4 chars). |
| `--help`, `-h` | Print usage. |

There is no CLI override for the redirect URI — earlier versions of the script accepted one, but `INSTAGRAM_AUTHORIZE_URL` is now the only input. If you need a different redirect URI, regenerate the embed URL in the Dashboard against the new value — the script will pick it up from the env var.

### `setup:oauth:messenger`

Defined in [`scripts/setup/oauth-messenger.ts`](../../scripts/setup/oauth-messenger.ts).

Runs the Facebook Login for Business OAuth flow to mint a Page Access Token with full scope control — the canonical alternative when the Messenger Dashboard "Generate Token" button can't include scopes the user hasn't already granted to the app.

**Required env vars** (validated at startup):

| Env var | Source | Used for |
| --- | --- | --- |
| `META_APP_ID` / `META_APP_SECRET` | App Settings → Basic | Authenticate the OAuth flow as the Meta App itself. Unlike Instagram OAuth, the Messenger flow uses the parent Meta App's credential pair (the Messenger product does NOT have its own client_id/secret). |
| `MESSENGER_LOGIN_CONFIG_ID` | App Dashboard → Facebook Login for Business → Configurations | The configuration id whose scope set the OAuth flow consents to. Create one bundling at least `pages_show_list`, `pages_messaging`, `pages_manage_metadata`, `pages_read_engagement`. `config_id` replaces the legacy `scope=` parameter on the authorize URL — don't try to pass both. |
| `NGROK_AUTHTOKEN` / `NGROK_DOMAIN` | ngrok dashboard | The script spins its own tunnel. The redirect URI is `https://<NGROK_DOMAIN>/auth/messenger/callback` — register that URL byte-for-byte under Facebook Login for Business → Settings → Valid OAuth Redirect URIs before running the script. |

**Optional env vars:**

| Env var | Effect |
| --- | --- |
| `MESSENGER_PAGE_ID` | If set and matches a Page returned by `/me/accounts`, the script auto-picks that Page. Otherwise the script prompts among all managed Pages. A non-matching value falls through to a prompt (defensive — avoids silently capturing the wrong Page). |
| `META_GRAPH_API_VERSION` | Graph API version (default `v25.0`). |
| `PORT` | Local listener port (default `3000`). |

**CLI flags:**

| Flag | Effect |
| --- | --- |
| `--reveal` | Print the Page Access Token unmasked. Default masks (first 10 + last 4 chars). |
| `--help`, `-h` | Print usage. |

**Flow:**

1. Validates env, spins ngrok tunnel.
2. Builds the FB Login for Business authorize URL `https://www.facebook.com/v{N}/dialog/oauth?client_id=&config_id=&redirect_uri=&response_type=code&state=` with a freshly-generated CSRF state.
3. Listens on `/auth/messenger/callback`. On callback, validates state, extracts `code`.
4. Exchanges `code` for a User Access Token via `GET https://graph.facebook.com/v{N}/oauth/access_token` (NOT a POST — this differs from Instagram's code exchange).
5. Defensively swaps the User Token to long-lived via the `fb_exchange_token` grant if its `expires_in` is short (< ~58 days). Skips this when the configuration is "Permanent" (expires_in omitted/0).
6. `GET /me/accounts?fields=id,name,access_token,category,tasks` returns one entry per managed Page; each `access_token` is a Page-scoped token derived from the User Token.
7. Selects the target Page (auto-picks when `MESSENGER_PAGE_ID` matches or only one Page is returned; prompts otherwise).
8. Offers to append `MESSENGER_PAGE_ACCESS_TOKEN` (and `MESSENGER_PAGE_ID` if not already set) to `.env`. Refuses to clobber an existing non-empty token line; empty placeholders from `.env.example` are skipped.

## What's intentionally NOT in scope (Stage 3)

- **Outbound message sending beyond a single test message per channel.** The verify scripts call `POST /{phoneNumberId}/messages` (WhatsApp template), `POST /{pageId}/messages` (Messenger reply), and `POST graph.instagram.com/{userId}/messages` (Instagram reply) once each to confirm round-trip wiring. The full `ChannelAdapter` send surface (text, media, typing indicators, reactions, capability gates) lands in **Stage 4**.
- **Conversation buffering or chat-endpoint integration.** Captures are written to disk; nothing is dispatched to a chat endpoint or buffered for proactive outreach. **Stage 5** wires `ConversationAgent` and `ChatClient`.
- **Status tracking beyond a single delivery confirmation.** The outbound smoke test waits for any `sent` / `delivered` / `read` status to confirm the loop. The persistent `StatusTracker` with cross-payload dedupe arrives in **Stage 6**.

## Related documents

- [Meta App setup guide](../META-SETUP-GUIDE.md) — go from zero to a populated `.env`.
- [Payload capture](./payload-capture.md) — passive + guided capture tooling.
- [Webhook security](./webhook-security.md) — the signature verifier the capture server reuses.
- [Configuration](./configuration.md) — env var reference.
- [Known gaps](../KNOWN-GAPS.md) — items the setup-verification surface defers.
