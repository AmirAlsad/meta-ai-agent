# Meta App Setup Guide

The authoritative end-to-end procedure for going from "I just cloned this repo" to a populated `.env` and a verified live messaging loop across WhatsApp, Messenger, and Instagram under a single Meta App. Stage 3 of the implementation plan landed the verify + capture tooling that automates most of this — the steps below are the Dashboard work that still requires a human, plus the one-time decisions only the developer can make.

Read [TRUSTED-SOURCES.md](./TRUSTED-SOURCES.md) alongside this guide. It tracks which Meta doc pages are authoritative and which (e.g. the legacy Page-linked Instagram flow) to skip.

> **Read this before clicking "Verify and Save" in any Dashboard webhook config.** When you paste a callback URL into App Dashboard → (WhatsApp | Messenger | Instagram) → Webhook and click Verify, Meta synchronously sends `GET /webhook?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...` to that URL **and waits for the response**. If nothing is listening on your ngrok domain at that moment, Meta returns a misleading error: *"The callback URL or verify token couldn't be validated. Please verify the provided information or try again later. (#N/A:WBxP-...)"* The verify token is rarely the cause — the cause is almost always "the Express server + ngrok tunnel were not running."
>
> **Order of operations** (for each of the three product webhook configs):
>
> 1. In one terminal, run `npm run capture:fixtures -- --no-webhook-registration`.
> 2. Wait for the line `Capture server running. Public URL: https://<NGROK_DOMAIN>/webhook`.
> 3. Only then paste that URL + your `META_VERIFY_TOKEN` into the Dashboard and click **Verify and Save**.
> 4. Repeat steps 2–3 for each product. Leave the capture server running while you toggle between Dashboard tabs.
>
> See [Payload capture](./features/payload-capture.md) for the capture-server flags. The same handshake rule applies if you later switch back to `setup:all` or `setup:{channel}` — the tunnel must be running before any "Verify" click.

## Prerequisites

- A personal Facebook account with developer access (visit <https://developers.facebook.com> once to enable).
- A Facebook Page that the developer admins. Required for Messenger and for the Business Manager link Instagram Business Login wants.
- A Business Manager account at <https://business.facebook.com>.
- An Instagram Professional account (Business or Creator). Personal IG accounts cannot use the Messaging API.
- A WhatsApp Business display name + a phone number not already registered with WhatsApp. (Meta's test phone number works for development.)
- An ngrok account (free tier is sufficient) — sign up at <https://dashboard.ngrok.com/signup> and copy your authtoken.

## 1. Create a Meta App

1. <https://developers.facebook.com> → My Apps → Create App.
2. Use case: **Other** → Type: **Business**. (The "Business" type unlocks all three messaging products.)
3. Provide an app name and contact email. Tie it to a Business Manager account.
4. From App Dashboard → Settings → Basic, record the **App ID** and **App Secret**.
5. While in Settings → Basic, also populate **App Domains** with your ngrok hostname (bare — no `https://`, no path). This is a coarse-grained allowlist of hostnames the app can talk to and is a separate field from per-product OAuth redirect URIs. Both must include your ngrok domain for OAuth to work end-to-end.

> **App Domains vs OAuth Redirect URI — two different fields, both required.**
>
> - **App Domains** (Settings → Basic) is a comma-separated allowlist of *hostnames* (bare, no scheme): e.g. `foo-bar-baz.ngrok-free.dev`.
> - **OAuth Redirect URIs** (per-product, e.g. Instagram → Business Login → Settings) are the specific *full URLs* (scheme + path) Meta will redirect to after OAuth: e.g. `https://foo-bar-baz.ngrok-free.dev/auth/instagram/callback`.
>
> If OAuth fails with "Invalid platform app", "URL Blocked", or "redirect_uri mismatch", check both fields.

App Mode defaults to **Development**. Live mode requires Meta App Review. While in Development:

- Only people with explicit roles on the app (Admin / Developer / Tester) can DM the configured channels.
- The WhatsApp test phone number can only send to recipients explicitly added in the WhatsApp → API Setup → Allow List panel.

`META_APP_ID=<id>` and `META_APP_SECRET=<secret>` go into `.env`. The App Secret signs every webhook from every product — do not commit it.

## 2. Configure products

Each product is added independently from App Dashboard → Add Product.

### WhatsApp

1. Add Product → WhatsApp → Set up.
2. WhatsApp → API Setup. Meta provisions a sandbox phone number automatically. Record the **`Phone number ID`** displayed next to it.
3. To switch to a real number, link it via Business Manager → WhatsApp Accounts → Add. Record the resulting **`Phone number ID`** and **`WhatsApp Business Account (WABA) ID`** (the parent container under Business Settings → Accounts → WhatsApp Accounts).
4. Generate a **System User Access Token** with scopes `whatsapp_business_messaging` and `whatsapp_business_management`:
   - Business Settings → Users → System Users → Add → role: Admin (or Employee with the WABA assigned).
   - Generate New Token → select the app → check both scopes → never expires.
5. Optional but recommended: also assign the System User to the WABA (Business Settings → WhatsApp Accounts → Add People → System User → Manage assets).

`.env`:

```
WHATSAPP_PHONE_NUMBER_ID=...
WHATSAPP_ACCESS_TOKEN=...          # System User token, never expires
WHATSAPP_BUSINESS_ACCOUNT_ID=...   # Required for programmatic per-WABA webhook subscription
```

`WHATSAPP_BUSINESS_ACCOUNT_ID` is optional from the package's perspective (runtime messaging works without it) but **required for programmatic webhook delivery** — see step 6 below.

> **WhatsApp inbound webhooks require the app to be Live.** Meta's WhatsApp product page states: "Apps will only be able to receive test webhooks sent from the app dashboard while the app is unpublished. No production data, including from app admins, developers or testers, will be delivered unless the app has been published." This is specific to WhatsApp — Messenger and Instagram deliver webhooks to roled users (Admin / Developer / Tester) while the app is still in Development mode. Until you publish, the only way to exercise WhatsApp inbound is the **Send Test** button in App Dashboard → WhatsApp → Configuration → Webhook, or test sends from the API Setup tab. Plan a publish step (or use the Dashboard "Send Test" surface) before relying on real inbound traffic. The `setup:whatsapp` script will time out waiting for inbound under Development mode. See "Going Live" below and the corresponding entry in [Known gaps](./KNOWN-GAPS.md).

The WhatsApp webhook subscription Dashboard panel shows a warning about test-only delivery in Development mode. It is real, and it is WhatsApp-specific — Messenger and Instagram do not have the same restriction.

The per-WABA `POST /{WABA_ID}/subscribed_apps` step is **load-bearing**. The app-level configuration in App Dashboard → WhatsApp → Configuration → Webhook gives you a working `GET /webhook` handshake but delivers zero actual webhooks. `setup:whatsapp` (and `setup:all`) call `subscribeWhatsAppBusinessAccount` when `WHATSAPP_BUSINESS_ACCOUNT_ID` is set; without it, the script reports `manual_required` and skips the call.

### Messenger

1. Add Product → Messenger → Set up.
2. Messenger → Settings → Access Tokens → Add or Remove Pages → choose the Page to link.
3. Mint the Page Access Token. There are two paths; pick based on your scope needs.

   **Path A — Dashboard "Generate Token" (simplest, scope-limited).** Click the **Generate Token** button on the same Page row in Messenger → Settings → Access Tokens. This mints a `type: PAGE` token bound to the Page id from your currently logged-in admin's existing scope grant. Long-lived (effectively permanent so long as you remain Page admin). **Use this when your current grant already covers every scope you need** — typically `pages_messaging`, and whatever else you've previously approved in a regular Facebook Login session against the app.

   **Path B — `npm run setup:oauth:messenger` (canonical, full scope control).** The Dashboard "Generate Token" button cannot mint a token with scopes the user has NOT previously granted to the app. If you need `pages_read_engagement` or `pages_manage_metadata` (load-bearing for `POST /{pageId}/subscribed_apps`, see the System User callout below) and the user has only granted `pages_messaging`, the Dashboard hands you a token missing those scopes — which then 200s the token-validity check in `verify-messenger` but 403s `subscribe_messenger_page_app` with the opaque "Subject not visible" error.

   `setup:oauth:messenger` runs the Facebook Login for Business OAuth flow against a `config_id` you create in App Dashboard → Facebook Login for Business → Configurations. The config bundles the EXACT scope set server-side; the OAuth flow consents to those scopes regardless of the user's pre-existing grant. The script ends with a `GET /me/accounts` call that returns one entry per Page the user manages — each entry includes a `type: PAGE` token with the configured scopes. The script auto-picks the Page if `MESSENGER_PAGE_ID` is set (or if only one Page is managed) and prompts otherwise.

   Prerequisites for Path B:
   - Create a Facebook Login for Business configuration at App Dashboard → Facebook Login for Business → Configurations → Create. Include at minimum `pages_show_list`, `pages_messaging`, `pages_manage_metadata`, `pages_read_engagement`. Copy the configuration id into `.env` as `MESSENGER_LOGIN_CONFIG_ID`.
   - Register `https://<NGROK_DOMAIN>/auth/messenger/callback` as a Valid OAuth Redirect URI under Facebook Login for Business → Settings. Byte-for-byte match: trailing slashes matter.
   - As with Instagram OAuth, free-tier ngrok permits only one active tunnel — stop any `capture:fixtures` server before running `setup:oauth:messenger`.

   ```bash
   npm run setup:oauth:messenger
   ```

   The script appends `MESSENGER_PAGE_ACCESS_TOKEN` (and `MESSENGER_PAGE_ID` if not already set) to `.env`. Default-masks the token; pass `--reveal` to print unmasked.

> **Do NOT use a System User token for Messenger.** Meta's [`/{page-id}/subscribed_apps` reference](https://developers.facebook.com/docs/graph-api/reference/page/subscribed_apps/) explicitly requires "*A Page access token requested by a person who can perform CREATE_CONTENT, MANAGE, or MODERATE task on the Page*" plus `pages_manage_metadata` and `pages_show_list`. The load-bearing phrase is "**requested by a person**": System User tokens are app-installed, not user-initiated, and don't satisfy that gate regardless of what scopes they carry or what Page-asset roles the System User has. Both Path A (Dashboard "Generate Token") and Path B (`setup:oauth:messenger`) mint Page tokens FROM a logged-in person, which clears the check. Validated during Stage 3 manual testing: a System User token (`type: SYSTEM_USER`, `profile_id: undefined`) with full Page asset control still fails the `POST /{pageId}/subscribed_apps` call with HTTP 403 / code 210 ("Subject not visible"); the same call succeeds with a person-derived Page token (`type: PAGE`, `profile_id` = Page id). Verify with `GET https://graph.facebook.com/v25.0/debug_token?input_token={page_token}&access_token={appId}|{appSecret}` — `data.type` must be `PAGE` and `data.profile_id` must equal the Page id.

> The System User permanence story is **WhatsApp-specific**. WhatsApp Cloud API has no Dashboard "Generate Permanent Token" equivalent, so System User is the standard production path there. Messenger has its own Dashboard path; Instagram Business Login uses the OAuth long-lived flow. See [Token type per channel](../CLAUDE.md#load-bearing-meta-platform-constraints) in CLAUDE.md.

> **Personal Facebook accounts must have a role on the app to DM the Page in Development mode.** Settings → App Roles → Roles → Add People — add yourself (and anyone else who will test inbound) as Admin / Developer / Tester. Without a role, the user can compose a DM but Meta silently drops it before any webhook fires. After publishing (Live mode), the same restriction continues to apply for permissions that have not passed App Review (`pages_messaging` typically requires App Review for non-roled users). Roled users always work, in any mode.

`.env`:

```
MESSENGER_PAGE_ID=...
MESSENGER_PAGE_ACCESS_TOKEN=...    # Person-derived Page Access Token (type: PAGE). NOT a System User token.
MESSENGER_LOGIN_CONFIG_ID=...      # REQUIRED only if using `setup:oauth:messenger` (Path B above).
                                   # FB Login for Business configuration id bundling the scope set.
```

### Instagram (Business Login)

> Use the **Business Login** flow, not the legacy "Instagram linked through a Page" flow. The legacy flow is being deprecated and the webhook payloads differ in subtle ways. The package targets `object: 'instagram'` only.

> **The Instagram product carries its OWN credential pair, separate from the Meta App.** Inside any Meta App that has the Instagram product, you have two sibling-but-distinct identifier pairs:
>
> | Identifier | Where it lives in the Dashboard | Used for |
> | --- | --- | --- |
> | `META_APP_ID` / `META_APP_SECRET` | App Settings → Basic | Webhook signature (`X-Hub-Signature-256`), app-level Graph API calls (`POST /{appId}/subscriptions`). |
> | Instagram `client_id` (parsed from the embed authorize URL into `INSTAGRAM_AUTHORIZE_URL`) / `INSTAGRAM_APP_SECRET` | Meta App Dashboard → Instagram → API setup with Instagram Business Login | Instagram OAuth code → short-lived → long-lived token exchanges. |
>
> They look similar (both are app-id + secret pairs on the same Meta App), but using the Meta App pair where the Instagram one is wanted yields opaque "Invalid platform app" / "redirect_uri mismatch" errors from `api.instagram.com/oauth/access_token`. `oauth-instagram.ts` deliberately validates the Instagram-specific env vars and never falls back to the Meta App pair.

1. On the IG mobile app, switch the account to Professional (Settings → Account → Switch to Professional → Business or Creator). **Personal IG accounts cannot use the Messaging API at all.**
2. Link the IG account to a Facebook Page in Business Manager — required for Business Login. The Page can be the same one you use for Messenger.
3. Add Product → Instagram → Business Login → Set up.
4. In Meta App Dashboard → **Instagram → API setup with Instagram Business Login → Business login settings → OAuth redirect URIs**, register the callback URL `https://<NGROK_DOMAIN>/auth/instagram/callback` (replace `<NGROK_DOMAIN>` with the bare hostname you reserved in step 3 of the next section). This must be registered BEFORE running `setup:oauth:instagram`, because the script reads the URL from the Dashboard-provided embed and refuses to construct one itself.
5. In the same Dashboard section ("API setup with Instagram Business Login"), find these two values and copy them into `.env`:
   - **"Authorize this app for Instagram business"** — copy the entire embed authorize URL (it includes `client_id`, `redirect_uri`, `scope`, `response_type`) into `INSTAGRAM_AUTHORIZE_URL`. Do not edit it; the script parses the fields out of the URL exactly as Meta delivers it.
   - **"Instagram app secret"** — copy this value into `INSTAGRAM_APP_SECRET`. This is the Instagram product's own secret, **not** the same as `META_APP_SECRET`.

   ```
   INSTAGRAM_AUTHORIZE_URL=https://www.instagram.com/oauth/authorize?...
   INSTAGRAM_APP_SECRET=...
   ```
6. Free ngrok permits **only one active tunnel at a time**. If `capture:fixtures` (or anything else) is currently bound to your reserved domain, stop it before running `setup:oauth:instagram` — the OAuth script spins its own tunnel.
7. Run `npm run setup:oauth:instagram`:
   - Spins up an ngrok tunnel on `NGROK_DOMAIN` and sanity-checks that its host matches the `redirect_uri` parsed out of `INSTAGRAM_AUTHORIZE_URL`. If they diverge, the script fails fast with a specific remediation (regenerate the embed URL with the current `NGROK_DOMAIN`, or update `NGROK_DOMAIN` to match).
   - Prints the embed authorize URL (with a freshly-generated `state` query parameter appended, because Meta's Dashboard embed omits `state`). Open it in your browser, sign in, approve scopes `instagram_business_basic` + `instagram_business_manage_messages` + `instagram_business_manage_comments` (the last powers the comment-to-DM private replies — `InstagramClient.sendPrivateReply`, landed in Stage 8).
   - Exchanges the OAuth code → short-lived token → long-lived (~60d) token automatically, using the Instagram credentials (the `client_id` parsed from the embed URL plus `INSTAGRAM_APP_SECRET`). The long-lived token endpoint is `https://graph.instagram.com/access_token` and is intentionally **unversioned** — do not "fix" the URL by adding `/v25.0/`; that returns 404. See the constraint list in [CLAUDE.md](../CLAUDE.md).
   - Verifies the token via `GET https://graph.instagram.com/me`.
   - Offers to append `INSTAGRAM_USER_ID` and `INSTAGRAM_ACCESS_TOKEN` to `.env`. The append step refuses to clobber an existing non-empty `INSTAGRAM_USER_ID` / `INSTAGRAM_ACCESS_TOKEN` but does NOT block empty placeholder lines copied from `.env.example` — those are skipped so a first-time capture can still succeed.

> **"Allow access to messages" on the IG mobile app is the silent killer.** Open the official Instagram app on the linked business account → Settings → Messages and story replies → Message controls → enable **Allow access to messages**. When this is OFF, OAuth completes successfully, webhook subscriptions POST 200, and **no real webhook ever fires**. There is no error log, no Graph API to detect the state, no UI signal in the Meta Dashboard. If you've done everything else right and webhooks aren't arriving, this is the first thing to check. `verify-instagram` surfaces it as a manual confirmation prompt.

> **Instagram Tester registration is a second silent killer (Development mode).** Verified during a live walkthrough on 2026-05-20: while the app is in Development mode, Instagram only fires messaging webhooks for DMs sent from accounts registered as **Instagram Testers**. Instagram keeps a *separate* tester list from the Facebook app roles — find it under **App Dashboard → App Roles → Roles → Instagram Testers**. Empirically, BOTH the business account AND every personal account you'll DM from must appear there as **accepted** testers, or the inbound webhook silently never arrives (no error, no log). Two gotchas:
> - A first DM from a non-connected account lands in the business's "message requests" folder. You do **NOT** need to manually accept the request — the Send API can reply within the 24-hour window without it (the user-initiated message opens the window). The message-request routing is a symptom of the account not being a connection, not the cause of webhook silence; the tester registration is the actual gate.
> - **The tester invite can only be ACCEPTED on the web** — `instagram.com` → Settings → Apps and websites → Tester invites (or accountscenter). The Instagram **mobile app does not surface the invite-acceptance screen** (confirmed 2026-05-20). Sending the invite is done in the Meta App Dashboard; accepting it must happen in a desktop browser.

`.env` (populated automatically by the script unless you decline):

```
INSTAGRAM_USER_ID=...
INSTAGRAM_ACCESS_TOKEN=...         # Long-lived, ~60 day lifetime
```

See [`scripts/setup/oauth-instagram.ts`](../scripts/setup/oauth-instagram.ts) for the OAuth flow internals and [Setup verification](./features/setup-verification.md) for the full per-channel verify walkthrough.

## 3. Capture credentials into `.env`

Start from [`.env.example`](../.env.example):

```bash
cp .env.example .env
```

Required for any deployment:

```
META_APP_ID=...
META_APP_SECRET=...
META_VERIFY_TOKEN=...              # See step 4
META_GRAPH_API_VERSION=v25.0
CHAT_ENDPOINT_URL=https://...      # Your developer-provided chat endpoint (Stage 5+ consumer)
NGROK_DOMAIN=...                   # Bare ngrok hostname; see "ngrok domain" below
NGROK_AUTHTOKEN=...                # ngrok account token
```

`META_GRAPH_API_VERSION` defaults to `v25.0`. The implementation plan was originally authored against `v23.0`, but Meta has since retired that version from the Dashboard (`v25.0` is the current minimum the Dashboard offers). Meta retires each version on a ~24-month cadence — assume any specific version reference in code, docs, or examples will eventually go stale. `loadConfig` validates the value against `^v\d+\.\d+$` and throws otherwise; if a future version label trips the regex (e.g. an unusual format), set `META_GRAPH_API_VERSION` explicitly in `.env`. See [TRUSTED-SOURCES.md](./TRUSTED-SOURCES.md) for the versioning policy.

Per channel (at least one block required):

```
# WhatsApp
WHATSAPP_PHONE_NUMBER_ID=...
WHATSAPP_ACCESS_TOKEN=...
WHATSAPP_BUSINESS_ACCOUNT_ID=...   # Required for programmatic webhook subscription

# Messenger
MESSENGER_PAGE_ID=...
MESSENGER_PAGE_ACCESS_TOKEN=...
MESSENGER_LOGIN_CONFIG_ID=...      # Optional — only required when minting the token via `setup:oauth:messenger`.

# Instagram
INSTAGRAM_AUTHORIZE_URL=...        # Embed authorize URL pasted from Dashboard (see step 5 below)
INSTAGRAM_APP_SECRET=...           # Instagram product secret — NOT the same as META_APP_SECRET
INSTAGRAM_USER_ID=...              # Populated by `npm run setup:oauth:instagram`
INSTAGRAM_ACCESS_TOKEN=...         # Populated by `npm run setup:oauth:instagram`
```

`INSTAGRAM_AUTHORIZE_URL` and `INSTAGRAM_APP_SECRET` are required BEFORE running `setup:oauth:instagram`; the script refuses to start without them. `INSTAGRAM_USER_ID` and `INSTAGRAM_ACCESS_TOKEN` are appended by the script on success.

Optional, but recommended for the Stage 3 tooling:

```
PUBLIC_BASE_URL=...                # If you run behind a non-ngrok proxy

E2E_TEST_WHATSAPP_NUMBER=...       # E.164 without "+", enables outbound smoke test
E2E_TEST_FACEBOOK_PSID=...
E2E_TEST_INSTAGRAM_IGSID=...
```

**PSIDs and IGSIDs cannot be looked up.** They are Page-Scoped IDs (Messenger) and Instagram-Scoped IDs (IG) and come into existence only after a user has interacted with your Page or IG account — there is no API to derive them from a profile URL, username, or Facebook ID. Leave `E2E_TEST_FACEBOOK_PSID` and `E2E_TEST_INSTAGRAM_IGSID` blank until you've captured one. The verify scripts read the sender id from the first inbound webhook automatically, so you only need to set these env vars if you want a stable target across re-runs.

### ngrok domain (required)

The single webhook callback URL `https://<NGROK_DOMAIN>/webhook` is what every Meta product's Dashboard subscription, every Page-level `subscribed_apps` POST, and Instagram's Business Login OAuth redirect URI all anchor to. If the domain rotates per run, every one of those Dashboard entries (and the OAuth registration) has to be edited byte-for-byte each time — there is no Graph API to update a registered callback URL atomically.

Pinning a static domain eliminates that churn. Every ngrok account (including the free tier) gets one reserved static domain at no cost.

1. Sign in at <https://dashboard.ngrok.com/cloud-edge/domains>.
2. Reserve a domain. **Free-tier static domains now end in `.ngrok-free.dev`** (e.g. `foo-bar-baz.ngrok-free.dev`); the older `.ngrok-free.app` TLD is paid-tier. Your actual reserved domain in the ngrok Dashboard is the source of truth — older docs or examples may show `.ngrok-free.app` placeholders, but copy your real domain verbatim.
3. Set `NGROK_DOMAIN` in `.env` to the **bare hostname** — no `https://` scheme, no path, no query. Example: `NGROK_DOMAIN=foo-bar-baz.ngrok-free.dev`. The SDK adds the scheme.
4. Use `https://<NGROK_DOMAIN>/webhook` as the callback URL every time you register webhooks in the Dashboard.

`loadConfig` rejects values with a scheme, with a path, or without a `.` separator.

**Only one active tunnel at a time on the free tier.** Stop any other ngrok-using process (e.g. a running `capture:fixtures` server) before running `setup:oauth:instagram`, `setup:{channel}`, or `setup:all` — those scripts spin their own tunnel and will fight the existing one for the reserved domain. Use `setup:all` over running multiple `setup:{channel}` scripts in parallel; it reuses a single tunnel across the three suites.

`loadConfig` ([`src/config/loader.ts`](../src/config/loader.ts)) throws on:

- Missing `META_APP_SECRET`.
- `META_VERIFY_TOKEN` shorter than 16 characters.
- Missing `CHAT_ENDPOINT_URL`.
- A partially-configured channel (e.g. `WHATSAPP_PHONE_NUMBER_ID` set but `WHATSAPP_ACCESS_TOKEN` empty).
- All three channel blocks empty.
- `META_GRAPH_API_VERSION` not matching `^v\d+\.\d+$`.

## 4. Generate `META_VERIFY_TOKEN`

This is a string YOU make up. Meta echoes it back in the `GET /webhook?hub.verify_token=...` handshake to prove the webhook URL belongs to someone who knows the value. Pick a random string ≥ 16 characters:

```bash
openssl rand -hex 24
```

Set it as `META_VERIFY_TOKEN` in `.env` AND use the exact same value when configuring each product's webhook in the Dashboard (and when the verify scripts ask for it). It is not the App Secret; the two are completely different keys with different purposes.

> **Match the verify token byte-for-byte.** Copy-paste failures (a trailing space, a wrapping quote character, a newline) are the second-most-common cause of the "callback URL or verify token couldn't be validated" error after "server not running". The token must be identical between `.env` and each of the three Dashboard webhook configs. If the handshake still fails after you've confirmed the server is running and the URL is right, re-paste the token from `.env` into each Dashboard tab.

## 5. Add Tester / Developer / Admin roles

While the app is in Development mode:

- **App Dashboard → App Roles → Roles → Add People.** Add your personal Facebook account (and any teammates) as Admin / Developer / Tester. This account can then DM the Page over Messenger and send test messages through WhatsApp.
- **Business Settings → Users → People.** For WhatsApp, also assign the relevant personal account to the WABA so it can receive test messages.
- **Instagram:** the IG account itself is the one linked via Business Login. Other personal IG accounts that DM it trigger webhooks only after the "Allow access to messages" toggle (see the silent-killer callout under "Instagram (Business Login)" above and the pitfall list in section 9) is ON.

`verify-messenger` surfaces this as a manual confirmation prompt — there is no Graph API to introspect app roles, so the script cannot verify the role programmatically.

## 6. Webhook subscription

The single callback URL `https://<public-host>/webhook` serves all three products.

### Preferred path: `npm run setup:all`

After `.env` is populated:

```bash
npm run setup:all
```

This:

1. Starts a shared ngrok tunnel (and a capture server bound to your local `PORT`).
2. Calls `registerAllWebhooks` for every configured channel:
   - **Messenger** — `POST /{appId}/subscriptions` (object=`page`, callback URL, verify token, fields) + `POST /{pageId}/subscribed_apps` (per-Page attachment).
   - **Instagram** — `POST graph.instagram.com/{userId}/subscribed_apps` (per-IG-user attachment). The app-level config must be set in the Dashboard once.
   - **WhatsApp** — `POST graph.facebook.com/{WABA_ID}/subscribed_apps` (per-WABA attachment). The app-level config must be set in the Dashboard once. Falls back to `manual_required` if `WHATSAPP_BUSINESS_ACCOUNT_ID` is unset.
3. Audits the resulting subscriptions and walks you through the per-channel verify steps (token validity, inbound capture, outbound smoke test).

When the script reports `manual_required`, it prints the exact Dashboard tab and the values to paste — copy the callback URL and verify token from the script output, paste them into the indicated Dashboard tab, then re-run `setup:all` (or `meta:webhooks --inspect`).

### Alternative: individual `setup:{channel}` scripts

```bash
npm run setup:whatsapp
npm run setup:messenger
npm run setup:instagram
```

Each runs the full bootstrap + per-channel verify for a single channel. They each spin their own tunnel and capture server, so don't run them in parallel on the free ngrok tier (1 simultaneous tunnel limit).

### Standalone: `npm run meta:webhooks`

```bash
npm run meta:webhooks                                   # Register, given PUBLIC_BASE_URL
npm run meta:webhooks -- --callback-url=https://...     # Register, explicit URL
npm run meta:webhooks -- --inspect                      # Read-only diagnostic
```

Useful when you've already brought your own public URL (e.g. a deployed staging environment) and just want to push subscriptions or check their state.

### Subscribed fields per channel

Source of truth: `SUBSCRIBED_FIELDS` in [`scripts/setup/register-webhooks.ts`](../scripts/setup/register-webhooks.ts). Copy from there verbatim when subscribing manually in the Dashboard — do not pluralize from memory.

| Channel | Fields |
| --- | --- |
| WhatsApp | `messages`, `message_template_status_update`, `account_review_update`, `phone_number_quality_update`, `phone_number_name_update` |
| Messenger | `messages`, `messaging_postbacks`, `message_deliveries`, `message_reads`, `messaging_optins`, `messaging_referrals`, `message_reactions`, `message_echoes` |
| Instagram | `messages`, `messaging_postbacks`, `messaging_seen`, `message_reactions`, `messaging_referral`, `message_echoes` |

#### Field-naming traps

- **`messaging_referral` (singular, Instagram) vs `messaging_referrals` (plural, Messenger).** Meta uses different spellings for the same concept on the two products. Mixing them up silently breaks the referral webhook on whichever channel was misspelled — the Dashboard accepts the subscription, but no events fire.
- **`message_reads` (Messenger) vs `messaging_seen` (Instagram).** Same concept (read receipt), different field name.
- **`message_echoes` is not exposed in the Instagram Dashboard UI.** Messenger's Dashboard UI exposes it; Instagram's does not. The field IS a valid Instagram subscription — `subscribeInstagramApp` (called by `setup:all` / `setup:instagram`) registers it via the Graph API. If you're subscribing Instagram manually in the Dashboard and don't see `message_echoes` in the list, that's expected — fall back to `npm run meta:webhooks`. Meta's UI behavior may evolve; if `message_echoes` later appears in the IG Dashboard, prefer the UI route.

#### Dashboard fields to NOT subscribe to

- **Instagram Dashboard also exposes** `comments`, `mentions`, `live_comments`, and `story_insights`. These are out of scope for the messaging-agent use case. They land in the parser's `unknown` bucket and pollute logs; do not subscribe.
- **`message_edits` and `message_context`** are 2025-era subscription fields that appear in the Dashboard (WhatsApp + Messenger for `message_edits`; varying per product for `message_context`). The parser in this package does **not** support either yet — see the entries in [Known gaps](./KNOWN-GAPS.md). Do not subscribe until parser support lands; the events would arrive but normalize to `MessageType: 'unknown'`.

Messenger's webhook field options in the Dashboard differ from Instagram's. They share `messages` / `messaging_postbacks` / `message_reactions` but diverge on the read-receipt and referral field names (as above). Always cross-check against `SUBSCRIBED_FIELDS`.

### Handshake

When you save the webhook URL in the Dashboard, Meta sends `GET /webhook?hub.mode=subscribe&hub.verify_token=<your_token>&hub.challenge=<random>`. The Stage 1 `GET /webhook` handler echoes `hub.challenge` as plain text when the token matches (200) and returns 403 otherwise.

## 7. Going Live (publishing the app)

Most Development-mode work happens with roled accounts (Admin / Developer / Tester) DMing the configured channels. Publishing the app flips it to Live mode, which is required for one of the three channels (WhatsApp) to deliver real webhooks and is the gate to accepting non-roled users on all three.

### When you actually need to publish

- **WhatsApp:** publishing is required to receive any real inbound webhook. In Development mode, the only WhatsApp inbound path is the Dashboard "Send Test" button. See [Known gaps](./KNOWN-GAPS.md) for the long-term touch-up.
- **Messenger / Instagram:** publishing is **not** required for testing with roled users — they receive webhooks fine in Development mode. Publishing is required to accept non-roled (public) users, and that step typically requires App Review for the relevant permissions.

If your use case is "developer + a small set of roled testers", you can stay in Development mode for Messenger and Instagram indefinitely.

### What you need to flip Live

App Dashboard → Settings → Basic must have the following populated before the "App Mode" toggle accepts Live:

1. **Privacy Policy URL** — a real hosted page. A GitHub Pages site, a simple static page, or a Notion public page works.
2. **Data Deletion Instructions URL** — a hosted page describing how a user requests deletion of their data. It does **not** need to be a programmatic endpoint; a written description of the process suffices.
3. **App Icon** — 1024×1024 PNG. A placeholder is fine.
4. **App Category** — pick "Business and Pages" or similar from the dropdown.
5. **App Domains** — must contain your ngrok hostname (bare, no scheme). Already populated in step 1 of "Create a Meta App" above.

### What you do NOT need (in the common case)

- **App Review for any permission**, *if* the only users will be roled accounts (Tester / Admin / Developer). Your own role on the app bypasses the App Review gate. App Review only becomes necessary when you want non-roled (public) users to be able to use a given permission.
- **Namespace field** — legacy from the Facebook Canvas era. Leave blank, or use a kebab-case slug (`my-meta-ai-agent`) if Meta forces non-empty.
- **Business Verification per app** — Business Verification is at the **Business Manager level**, not per-app. Once verified once, every app under that Business Manager inherits it. Re-verification is only triggered when the business entity itself changes (name change, legal restructure, etc.).

### What does NOT change after publishing

All of these are fully editable and reversible in Live mode:

- Code iteration, hot reloads, redeploys.
- Webhook config edits — subscribed fields, callback URL changes, verify token rotation.
- Token regeneration (Page Access Token, System User token, IG long-lived token).
- Adding or removing channels (Add Product / remove a product).
- Switching back to Development mode at any time.

### What DOES change after publishing

- **WhatsApp inbound webhooks start delivering real messages** to your callback URL (no longer test-only).
- **Messenger and Instagram now accept DMs from non-roled users** — but only for permissions that have passed App Review. Permissions still pending review behave as if the app were in Development mode for non-roled users.
- **Adding new permissions in Live mode requires App Review** before non-roled users can exercise them. Roled users continue to bypass App Review.

### Easily-broken-but-recoverable

- If you delete the Privacy Policy URL, blank the App Icon, or break Business Verification on the parent Business Manager, the app **auto-reverts to Development mode** until you fix the field. Annoying but not destructive — your config (webhook URLs, subscribed fields, tokens) is preserved.

## 8. End-to-end verification

```bash
npm run setup:all
```

Per channel, the script will:

1. Confirm the access token resolves to the expected entity (`/{phoneNumberId}`, `/{pageId}`, `/me`).
2. Confirm the webhook subscription is active and points at the current tunnel.
3. Send a test outbound message (WhatsApp `hello_world` template, Messenger reply, Instagram reply).
4. Wait for an inbound from your personal account.
5. Optionally capture a reaction (WhatsApp only).

Captures land in `.captures/meta/{channel}/` — see [Payload capture](./features/payload-capture.md). The session prints a summary table when finished; non-zero exit code means at least one channel failed.

## 9. Common pitfalls and lessons learned

A grab-bag of friction points encountered during real Stage 3 walkthroughs. The big ones (server-not-running, the "Allow access to messages" toggle, WhatsApp publish requirement, App Domains vs OAuth redirect URI, subscribed-field name traps) are called out inline in the relevant sections above; this list captures the rest.

### Tokens and identity

- **`META_APP_SECRET` and `META_VERIFY_TOKEN` confusion.** App Secret signs every webhook (`X-Hub-Signature-256`). Verify Token is a literal string echoed during the `GET /webhook` handshake. They are different values for different purposes; do not interchange them.
- **Don't use a System User token for Messenger.** [Meta's `subscribed_apps` reference](https://developers.facebook.com/docs/graph-api/reference/page/subscribed_apps/) requires "*A Page access token requested by a person who can perform CREATE_CONTENT, MANAGE, or MODERATE task on the Page*" — the "requested by a person" gate excludes app-installed System User tokens regardless of scopes or Page-asset roles. Validated in Stage 3 manual testing: System User tokens (`type: SYSTEM_USER`) fail `POST /{pageId}/subscribed_apps` with HTTP 403 / code 210 even with full Page asset control. Use the Dashboard "Generate Token" button on the Page row in Messenger → Settings → Access Tokens — it mints a `type: PAGE` token derived from your logged-in user. Confirm with `GET /debug_token?input_token=<token>&access_token={appId}|{appSecret}`.
- **Token lifecycle summary** (per-channel, post-Stage-3-validation):
  - **WhatsApp**: System User Access Token, never expires. Required for production permanence — Dashboard has no equivalent "Generate Permanent Token" button.
  - **Messenger**: Dashboard-generated Page Access Token (`type: PAGE`), long-lived and effectively permanent so long as the issuing user retains Page admin. Do NOT use System User tokens here (see above).
  - **Instagram**: OAuth long-lived token, ~60 days max. No permanent path exists. No refresh automation yet — re-run `setup:oauth:instagram` before expiry. See [Known gaps](./KNOWN-GAPS.md).
- **PSIDs and IGSIDs are scoped identifiers and not lookup-able.** See the env-var section above. Don't try to set `E2E_TEST_FACEBOOK_PSID` / `E2E_TEST_INSTAGRAM_IGSID` ahead of time — they're populated from the first inbound capture.

### WhatsApp

- **WhatsApp test number send quota.** Meta's sandbox phone number is free for ~250 conversations per month to up to 5 recipients you've explicitly added in the API Setup → Allow List panel. Production numbers need Business verification before going Live.
- **`WHATSAPP_BUSINESS_ACCOUNT_ID` missing.** Without it, `registerAllWebhooks` reports `manual_required` for WhatsApp and skips `POST /{WABA_ID}/subscribed_apps`. App-level callback configuration alone yields a working `GET /webhook` handshake but **zero actual deliveries**. The per-WABA call is the load-bearing step.
- **WhatsApp inbound only works in Live mode.** Documented inline (see "WhatsApp" section under "Configure products") and tracked in [Known gaps](./KNOWN-GAPS.md). Until you publish, use the Dashboard "Send Test" button.

### Instagram

- **OAuth redirect URI mismatch.** The redirect URI is parsed directly from `INSTAGRAM_AUTHORIZE_URL` (which you copied from the Dashboard) and must match the URL registered in App Dashboard → Instagram → API setup with Instagram Business Login → OAuth redirect URIs byte-for-byte. Trailing slashes and http vs https matter; `oauth-instagram.ts` also sanity-checks that the redirect host matches `NGROK_DOMAIN` and surfaces a hint when Meta returns "Invalid platform app" or similar. Also remember to populate **App Domains** (Settings → Basic) with the same hostname — see the callout under "Create a Meta App". If you rotate `NGROK_DOMAIN`, regenerate the embed URL in the Dashboard so the parsed `redirect_uri` keeps matching.
- **Confusing the Meta App and Instagram credential pairs.** `META_APP_ID` / `META_APP_SECRET` are for webhook signing and app-level Graph API calls; the Instagram OAuth flow needs the Instagram product's `client_id` (parsed from `INSTAGRAM_AUTHORIZE_URL`) and `INSTAGRAM_APP_SECRET`. They are siblings on the same Meta App but not equals; mixing them produces "Invalid platform app" or "redirect_uri mismatch" errors from `api.instagram.com/oauth/access_token`. See the boxed callout in "Instagram (Business Login)" above.
- **`localhost` does not work as an Instagram OAuth redirect URI** (Meta rejects it for IG Business Login). Use the ngrok HTTPS domain. `oauth-instagram.ts` does not accept CLI overrides for the redirect URI; the URL is parsed directly from `INSTAGRAM_AUTHORIZE_URL`, the embed URL Meta exposes in the Dashboard. If you need a non-ngrok redirect, regenerate the embed URL against that pre-registered value.
- **Instagram Tester registration (Development mode) — webhook silent killer #2.** In Development mode, Instagram only delivers messaging webhooks for DMs from registered **Instagram Testers** (App Dashboard → App Roles → Roles → **Instagram Testers** — a list separate from the Facebook app roles). Both the business account and every personal account you DM from must be **accepted** testers. The invite can **only be accepted on the web** (instagram.com → Settings → Apps and websites → Tester invites); the mobile app does not show the acceptance screen. Symptom: inbound DM webhook times out with no error even though OAuth, subscription, and "Allow access to messages" are all correct. `verify-instagram` step 5 surfaces this as a manual confirmation.
- **`message_echoes` is NOT a valid Instagram subscribed field.** It's Messenger-only (`page` object). Including it makes the IG `subscribed_apps` call fail with HTTP 400 / code 100 ("Param subscribed_fields[N] must be one of {...}"). The accepted IG set is `messages, messaging_postbacks, messaging_seen, message_reactions, messaging_referral` (singular referral). There is no IG echo-webhook field; outbound tracking on Instagram relies on the Send API response.
- **Instagram message requests do NOT require manual acceptance to reply via the API.** A first DM from a non-connected account lands in the "message requests" folder, but the Send API can reply within the 24-hour window without you tapping "Accept" — the user-initiated message opens the window. The request routing is cosmetic; don't mistake it for the cause of webhook silence (that's the tester gate above).

### Operational

- **ngrok free tier: 1 simultaneous tunnel.** Don't run `setup:whatsapp` and `setup:messenger` in parallel. Don't keep `capture:fixtures` running when starting `setup:oauth:instagram`. Use `setup:all` for the three-channel verify path; it reuses one tunnel.
- **ngrok free domains end in `.ngrok-free.dev`, not `.ngrok-free.app`.** Documented inline; surfaces here as a reminder when copy-pasting from older snippets.
- **Graph API version drift.** Meta retires versions on a ~24-month cadence. The plan was authored against `v23.0`; the Dashboard's current floor is `v25.0`. Bump `META_GRAPH_API_VERSION` deliberately and re-test.

## Related documents

- [Setup verification](./features/setup-verification.md) — what each verify script does step by step.
- [Payload capture](./features/payload-capture.md) — `capture:fixtures` and `capture:guided` tooling.
- [Webhook security](./features/webhook-security.md) — signature verification details.
- [Configuration](./features/configuration.md) — env var reference.
- [Architecture](./ARCHITECTURE.md) — module map.
- [Trusted sources](./TRUSTED-SOURCES.md) — Meta documentation references.
- [Known gaps](./KNOWN-GAPS.md) — deferred and unsupported items.
