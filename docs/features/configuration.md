# Configuration and Tunables

## What it does

Documents runtime configuration for `meta-ai-agent`: Meta App credentials, per-channel credentials, the developer's chat endpoint URL, and process-level controls (port, autostart gate, public base URL for webhook registration). Stage 5 added the nested `conversation` tuning section (buffer timing, typing, read receipts, delivery timeout, dedupe TTL, chat timeout) — see [`src/config/loader.ts`](../../src/config/loader.ts). Stage 6 added identity-enrichment knobs (`USER_LOOKUP_URL`, `USER_LOOKUP_TIMEOUT_MS`) and made `ADMIN_API_TOKEN` an active gate for the operational routes (with a ≥16-char floor). Persistence and full rate limiting (Stage 10) will add further tunables.

## How it works

Configuration is loaded from environment variables by `loadConfig(env = process.env)` in [`src/config/loader.ts`](../../src/config/loader.ts). All values are trimmed; empty strings are treated as unset. Required values are validated at startup and throw on missing/invalid inputs so a `.env` typo fails fast rather than 400ing the first webhook.

Per-channel credentials are loaded as pairs. A channel is **enabled** only when both of its credentials are present:

- WhatsApp: `WHATSAPP_PHONE_NUMBER_ID` + `WHATSAPP_ACCESS_TOKEN`
- Messenger: `MESSENGER_PAGE_ID` + `MESSENGER_PAGE_ACCESS_TOKEN`
- Instagram: `INSTAGRAM_USER_ID` + `INSTAGRAM_ACCESS_TOKEN`

If exactly one of a pair is set, `loadConfig` throws with a clear error (`Partial WhatsApp configuration: WHATSAPP_PHONE_NUMBER_ID set but missing WHATSAPP_ACCESS_TOKEN.`). Half-configured channels almost always indicate a copy-paste mistake — making them an error is intentional.

At least one channel must be configured. If none of the three pairs is fully set, `loadConfig` throws.

The returned `Config` object includes a `channels: { whatsapp: boolean, messenger: boolean, instagram: boolean }` map. Downstream code will use this to decide which adapters/routes to wire up in Stages 4–6. As of Stage 2, the parser itself does not consult this map — it routes by the inbound `object` field — but configured channels gate outbound and (later) per-channel feature toggles.

## Code files

| File | Role |
| --- | --- |
| [`src/config/loader.ts`](../../src/config/loader.ts) | `loadConfig()`, `Config` type, per-channel loader, validation. |
| [`src/index.ts`](../../src/index.ts) | Calls `loadConfig()` at startup; `AGENT_AUTOSTART` and `NODE_ENV` gate the `app.listen()` call. |
| [`src/http/app.ts`](../../src/http/app.ts) | Consumes `Config` (passes `meta.appSecret`, `meta.verifyToken`, channel flags to middleware/routes). |

## Configuration

Listed exactly as they appear in [`.env.example`](../../.env.example).

### Required (always)

| Variable | Purpose |
| --- | --- |
| `META_APP_SECRET` | Used to verify `X-Hub-Signature-256` on inbound WhatsApp (`whatsapp_business_account`) and Messenger (`page`) webhooks. **Instagram webhooks are signed with `INSTAGRAM_APP_SECRET` instead** (see below) — the verifier tries all configured secrets and accepts a match against any. |
| `META_VERIFY_TOKEN` | Echoed during the GET `/webhook` handshake; configured identically in each product's webhook settings. Validation: must be at least 16 characters. |
| `CHAT_ENDPOINT_URL` | The developer's HTTP endpoint that will receive inbound messages and return responses (consumed by `ChatClient` in Stage 5). Validated as a parseable URL at startup. |
| `NGROK_DOMAIN` | Reserved static ngrok hostname (bare hostname, no scheme or path). Required because the Meta Dashboard pins webhook callback URLs and the IG Business Login OAuth redirect URI to a single public domain — an ephemeral hostname forces re-registration every run. Reserve a free one at <https://dashboard.ngrok.com/cloud-edge/domains>. |

### Required: at least one channel

| Variable | Purpose |
| --- | --- |
| `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp Cloud API phone-number ID (numeric string from the App Dashboard). |
| `WHATSAPP_ACCESS_TOKEN` | WhatsApp System User Access Token (permanent, non-expiring). |
| `MESSENGER_PAGE_ID` | Facebook Page ID linked to the App. |
| `MESSENGER_PAGE_ACCESS_TOKEN` | Long-lived Page Access Token (generated via System User for production). |
| `INSTAGRAM_USER_ID` | Instagram User ID for the Business-Login-linked IG Professional account. Populated by `npm run setup:oauth:instagram`. |
| `INSTAGRAM_ACCESS_TOKEN` | Long-lived Instagram User Access Token (~60 days, must be refreshed via the long-lived exchange). Populated by `npm run setup:oauth:instagram`. |

Partial pairs throw. Zero channels configured throws.

> **Instagram inbound webhook verification needs `INSTAGRAM_APP_SECRET` too.** The pair above is what makes the Instagram channel *enabled*, but Instagram webhooks are signed with `INSTAGRAM_APP_SECRET` (not `META_APP_SECRET`). If you enable the IG channel without setting `INSTAGRAM_APP_SECRET`, the channel is considered configured (no throw) but every inbound IG webhook fails signature verification with `401`. `createApp` warns at startup in that case. See the next section and [Webhook security](./webhook-security.md).

### Instagram product credentials (`INSTAGRAM_APP_SECRET` is now a runtime secret)

The Instagram block in `.env.example` carries two product-specific env vars. Both are **distinct from `META_APP_ID` / `META_APP_SECRET`** — any Meta App that hosts the Instagram product carries two sibling-but-different credential pairs, and confusing them yields opaque "Invalid platform app" / "redirect_uri mismatch" errors from `api.instagram.com/oauth/access_token`.

| Variable | Read by `loadConfig()`? | Purpose |
| --- | --- | --- |
| `INSTAGRAM_AUTHORIZE_URL` | No | Embed authorize URL pasted from Meta App Dashboard → Instagram → API setup with Instagram Business Login → "Authorize this app for Instagram business". `oauth-instagram.ts` parses `client_id`, `redirect_uri`, and (when present) `state` out of this URL — the script never constructs an authorize URL itself in the live flow. Read directly by the OAuth script, not `loadConfig()`. |
| `INSTAGRAM_APP_SECRET` | **Yes (optional)** | The Instagram product's own app secret (labeled "Instagram app secret" in the same Dashboard section as the embed URL). Used by `oauth-instagram.ts` for the short-lived and long-lived token exchanges **AND, as of the 2026-05-20 fix, at RUNTIME** to verify inbound Instagram webhook signatures — Meta signs `object: instagram` webhooks with this secret, not `META_APP_SECRET` (verified against the live API). `loadConfig()` reads it onto `config.instagram.appSecret`. It is OPTIONAL and does NOT gate whether the IG channel is enabled; if it is absent on an enabled IG channel, inbound IG webhooks `401` and `createApp` warns at startup. |

`INSTAGRAM_AUTHORIZE_URL` is read directly by the OAuth script (not `loadConfig()`), which validates it at startup and refuses to run without it. See [Setup verification](./setup-verification.md) for the OAuth flow and [Webhook security](./webhook-security.md) for the runtime verification model.

### Required by `setup:oauth:messenger` (not consumed by the runtime)

The Messenger OAuth capture script reads one additional env var that the running agent does not need:

| Variable | Purpose |
| --- | --- |
| `MESSENGER_LOGIN_CONFIG_ID` | The Facebook Login for Business configuration id (created at App Dashboard → Facebook Login for Business → Configurations) that bundles the scope set the OAuth flow consents to. Replaces the legacy `scope=` query parameter on the authorize URL — `config_id` stores the scope set server-side, and the authorize URL points at that configuration. Use the OAuth flow when the App Dashboard "Generate Token" button cannot include scopes the user has not previously granted to the app. Not consumed by `loadConfig()`; the OAuth script validates it directly at startup. |

The Messenger OAuth script also reads `META_APP_ID` and `META_APP_SECRET` — unlike Instagram OAuth (which uses an Instagram-specific credential pair), the Messenger flow authenticates as the parent Meta App itself.

### Optional

| Variable | Default | Purpose |
| --- | --- | --- |
| `META_APP_ID` | unset | Optional; reserved for outbound clients (Stage 4) that may need the App ID for some Graph API admin calls. Not used in Stage 1. **Not used by `setup:oauth:instagram`** — Instagram OAuth uses the Instagram product's own `client_id` (parsed from `INSTAGRAM_AUTHORIZE_URL`) and `INSTAGRAM_APP_SECRET`, which are sibling-but-distinct credentials inside the same Meta App. |
| `META_GRAPH_API_VERSION` | `v25.0` | Pinned Graph API version. Validated against `^v\d+\.\d+$`. Used by outbound clients in Stage 4. |
| `PORT` | `3000` | Express listen port. Must be an integer between 1 and 65535. |
| `USER_LOOKUP_URL` | unset | Optional Stage 6 identity-enrichment endpoint. The resolver POSTs `{ channel, channelScopedUserId, channelScopedBusinessId }` and shapes the JSON response into a `Contact` that rides on the `ChatRequest`. When unset, a no-op resolver runs and conversations proceed without enrichment. When set it must parse as a URL (validated at load, like `CHAT_ENDPOINT_URL`). Enrichment is fail-open. See [Identity resolution](./identity-resolution.md). |
| `USER_LOOKUP_TIMEOUT_MS` | `5000` | Per-call timeout for the `USER_LOOKUP_URL` request (positive integer). A timeout drops enrichment rather than blocking the turn (fail-open). Loaded onto `config.conversation.userLookupTimeoutMs`, alongside `CHAT_ENDPOINT_TIMEOUT_MS`. Only consulted when `USER_LOOKUP_URL` is set. |
| `REDIS_URL` | unset | Reserved for Stage 10 (Redis-backed conversation store, dedupe, BullMQ buffer timers). As of Stage 6 it is surfaced in `GET /ready` as `configured` vs `not_configured` (presence-only — the real ping lands in Stage 10). |
| `ADMIN_API_TOKEN` | unset | Stage 6: gates the PII-bearing operational routes `GET /metrics`, `GET /admin/conversations/:key`, and `GET /admin/status/:messageId` (constant-time `Authorization: Bearer` / `x-admin-api-token` check). When **unset**, those routes are not mounted at all (a request 404s, not 401s — never advertise an admin surface a deploy hasn't configured a token for). When **set**, it must be at least **16 characters** (a high-entropy secret of **≥32** is recommended) — `loadConfig` throws otherwise. `/health` and `/ready` are unaffected (always on, unauthenticated). See [Operational visibility](./operational-visibility.md). |
| `PUBLIC_BASE_URL` | unset | Used by Stage 3 webhook-registration and capture scripts to compute the callback URL. Not consumed by the running app. |
| `AGENT_AUTOSTART` | `1` | `0` / `false` to prevent `src/index.ts` from auto-binding a port. Useful when embedding `createApp` in a custom entry point. |
| `NODE_ENV` | `development` | When `test`, `src/index.ts` skips autostart so test imports do not bind a port. |
| `LOG_LEVEL` | `info` | Consumed by `src/index.ts` when constructing the pino logger. |

### E2E (planned, consumed by Stage 3 scripts)

| Variable | Purpose |
| --- | --- |
| `E2E_TEST_WHATSAPP_NUMBER` | Developer's personal WhatsApp number (E.164) for live capture and verification. |
| `E2E_TEST_FACEBOOK_PSID` | Developer's PSID for Messenger testing. |
| `E2E_TEST_INSTAGRAM_IGSID` | Developer's IGSID for Instagram testing. |
| `NGROK_AUTHTOKEN` | ngrok SDK auth token. |

None of these are consumed by the running agent in Stage 1; they are read by the Stage 3 setup/capture scripts.

## Validation rules summary

`loadConfig` throws on:

- `META_APP_SECRET` missing/empty.
- `META_VERIFY_TOKEN` missing/empty or fewer than 16 characters.
- `CHAT_ENDPOINT_URL` missing/empty or not a parseable URL.
- `META_GRAPH_API_VERSION` set to a value not matching `^v\d+\.\d+$`.
- `USER_LOOKUP_URL` set but not a parseable URL.
- `ADMIN_API_TOKEN` set but fewer than 16 characters.
- `NGROK_DOMAIN` missing/empty, set with an `http://` / `https://` scheme, set with a path or query, or missing a `.` (not a hostname).
- Exactly one of a channel pair set (partial config).
- All three channels unset.
- `PORT` not an integer in `[1, 65535]`.
- `AGENT_AUTOSTART` set to a value other than `1`, `0`, `true`, `false`.

## Known limitations (Stages 1–2)

- Token format is not validated. Stage 10 of the plan adds shape checks: WhatsApp System User tokens are long alphanumeric strings, Page Access Tokens start with `EAA`, Instagram tokens start with `IGQ`.
- `META_APP_ID` is optional today and not asserted to be numeric. It will be required by some Stage 4 Graph API calls.
- No cross-field validation yet (e.g. window/buffer/retry tunables introduced in later stages will need cross-checks).
- Boolean parsing for `AGENT_AUTOSTART` only accepts `1`/`0`/`true`/`false` — other affirmative strings like `yes`/`on` are rejected.
