# Configuration and Tunables

## What it does

Documents runtime configuration for `meta-ai-agent`: Meta App credentials, per-channel credentials, the developer's chat endpoint URL, and process-level controls (port, autostart gate, public base URL for webhook registration). Stage 5 added the nested `conversation` tuning section (buffer timing, typing, read receipts, delivery timeout, dedupe TTL, chat timeout) — see [`src/config/loader.ts`](../../src/config/loader.ts). Stage 6 added identity-enrichment knobs (`USER_LOOKUP_URL`, `USER_LOOKUP_TIMEOUT_MS`) and made `ADMIN_API_TOKEN` an active gate for the operational routes (with a ≥16-char floor). Stage 10 added the nested `persistence` section (Redis/BullMQ tuning, gated on `REDIS_URL`) and the `limits` section (per-channel pacing, track-only per-hour/per-day counters, transient-retry backoff), promoted `REDIS_URL` to an active toggle with scheme validation, and added advisory token-format warnings. See [Persistence](./persistence.md) and [Rate limiting](./rate-limiting.md) for the runtime behavior; this doc is the env-var reference.

## How it works

Configuration is loaded from environment variables by `loadConfig(env = process.env)` in [`src/config/loader.ts`](../../src/config/loader.ts). All values are trimmed; empty strings are treated as unset. Required values are validated at startup and throw on missing/invalid inputs so a `.env` typo fails fast rather than 400ing the first webhook.

Per-channel credentials are loaded as pairs. A channel is **enabled** only when both of its credentials are present:

- WhatsApp: `WHATSAPP_PHONE_NUMBER_ID` + `WHATSAPP_ACCESS_TOKEN`
- Messenger: `MESSENGER_PAGE_ID` + `MESSENGER_PAGE_ACCESS_TOKEN`
- Instagram: `INSTAGRAM_USER_ID` + `INSTAGRAM_ACCESS_TOKEN`

If exactly one of a pair is set, `loadConfig` throws with a clear error (`Partial WhatsApp configuration: WHATSAPP_PHONE_NUMBER_ID set but missing WHATSAPP_ACCESS_TOKEN.`). Half-configured channels almost always indicate a copy-paste mistake — making them an error is intentional.

At least one channel must be configured. If none of the three pairs is fully set, `loadConfig` throws.

The returned `Config` object includes a `channels: { whatsapp: boolean, messenger: boolean, instagram: boolean }` map. `buildRuntime` ([`src/index.ts`](../../src/index.ts)) uses the per-channel config to decide which adapters to wire up (only configured channels get a `ChannelAdapter`). The parser itself does not consult this map — it routes by the inbound `object` field — but configured channels gate outbound and per-channel feature toggles.

The `Config` also carries three nested tuning sections, each loaded by its own helper with defaults and range/cross-field validation: `conversation` ([`ConversationConfig`](../../src/config/loader.ts) — Stage 5 buffering/typing/delivery), `persistence` ([`PersistenceConfig`](../../src/config/loader.ts) — Stage 10 Redis/BullMQ; only consulted when `REDIS_URL` is set), and `limits` ([`LimitsConfig`](../../src/config/loader.ts) — Stage 10 pacing/throughput/retry). `redisUrl` is a top-level toggle (`loadRedisUrl` validates the scheme and throws). Every nested field has a default, so an env with none of these set still produces a complete `Config`.

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
| `CHAT_ENDPOINT_URL` | The developer's HTTP endpoint that receives inbound messages and returns responses (consumed by `ChatClient`). Validated as a parseable URL at startup. |
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
| `META_APP_ID` | unset | Optional; loaded onto `config.appId` but not consumed by the running agent today (reserved for Graph API admin calls that may need the App ID). Read by `setup:oauth:messenger` to authenticate the OAuth flow. **Not used by `setup:oauth:instagram`** — Instagram OAuth uses the Instagram product's own `client_id` (parsed from `INSTAGRAM_AUTHORIZE_URL`) and `INSTAGRAM_APP_SECRET`, which are sibling-but-distinct credentials inside the same Meta App. |
| `META_GRAPH_API_VERSION` | `v25.0` | Pinned Graph API version. Validated against `^v\d+\.\d+$`. Used by the outbound clients (the shared `GraphClient`). |
| `PORT` | `3000` | Express listen port. Must be an integer between 1 and 65535. |
| `USER_LOOKUP_URL` | unset | Optional Stage 6 identity-enrichment endpoint. The resolver POSTs `{ channel, channelScopedUserId, channelScopedBusinessId }` and shapes the JSON response into a `Contact` that rides on the `ChatRequest`. When unset, a no-op resolver runs and conversations proceed without enrichment. When set it must parse as a URL (validated at load, like `CHAT_ENDPOINT_URL`). Enrichment is fail-open. See [Identity resolution](./identity-resolution.md). |
| `USER_LOOKUP_TIMEOUT_MS` | `5000` | Per-call timeout for the `USER_LOOKUP_URL` request (positive integer). A timeout drops enrichment rather than blocking the turn (fail-open). Loaded onto `config.conversation.userLookupTimeoutMs`, alongside `CHAT_ENDPOINT_TIMEOUT_MS`. Only consulted when `USER_LOOKUP_URL` is set. |
| `INBOUND_MEDIA_DOWNLOAD` | `false` | Opt-in inbound media hydration. When `true`, the transport downloads inbound media on the flush path (it holds the WhatsApp access token the chat endpoint lacks) and attaches it to the chat request as a base64 `data:` URL on `message.media.dataUrl`. Off by default: base64 inflates each media-bearing request body by ~33% over the raw bytes. Boolean (`1`/`0`/`true`/`false`), loaded onto `config.conversation.inboundMediaDownload`. See [Inbound media hydration](./media-hydration.md). |
| `INBOUND_MEDIA_MAX_BYTES` | `5242880` | Hard cap (bytes) on a single inbound attachment to hydrate (positive integer; 5 MiB). Media larger than this is left as `id`/`url` (not base64-attached) and logged. Loaded onto `config.conversation.inboundMediaMaxBytes`. Only consulted when `INBOUND_MEDIA_DOWNLOAD` is `true`. |
| `REDIS_URL` | unset | Stage 10 toggle for the Redis-backed persistence path (durable conversation store + dedupe, BullMQ buffer timers, Redis limit-counter store). When **set**, `buildRuntime` selects the Redis trio and `GET /ready` issues a real timeout-bounded Redis ping. When **unset**, the in-memory trio runs. Validated by `loadRedisUrl`: must parse as a URL with the `redis:` or `rediss:` scheme — `loadConfig` **throws** otherwise (e.g. an `http://` paste). See the Persistence section below and [Persistence](./persistence.md). |
| `ADMIN_API_TOKEN` | unset | Stage 6: gates the PII-bearing operational routes `GET /metrics`, `GET /admin/conversations/:key`, and `GET /admin/status/:messageId` (constant-time `Authorization: Bearer` / `x-admin-api-token` check). When **unset**, those routes are not mounted at all (a request 404s, not 401s — never advertise an admin surface a deploy hasn't configured a token for). When **set**, it must be at least **16 characters** (a high-entropy secret of **≥32** is recommended) — `loadConfig` throws otherwise. `/health` and `/ready` are unaffected (always on, unauthenticated). See [Operational visibility](./operational-visibility.md). |
| `PUBLIC_BASE_URL` | unset | Used by the webhook-registration and capture scripts to compute the callback URL. Not consumed by the running app. |
| `AGENT_AUTOSTART` | `1` | `0` / `false` to prevent `src/index.ts` from auto-binding a port. Useful when embedding `createApp` in a custom entry point. |
| `NODE_ENV` | `development` | When `test`, `src/index.ts` skips autostart so test imports do not bind a port. |
| `LOG_LEVEL` | `info` | Consumed by `src/index.ts` when constructing the pino logger. |

### Persistence (Stage 10; nested `config.persistence` — only consulted when `REDIS_URL` is set)

Loaded by `loadPersistenceConfig`. Every field has a default; the `REDIS_URL` toggle (in the Optional table above) selects the Redis path. See [Persistence](./persistence.md).

| Variable | Default | Range / validation | Purpose |
| --- | --- | --- | --- |
| `CONVERSATION_TTL_SECONDS` | `86400` | Positive integer (≥1). | TTL applied to Redis conversation records and outbound-handle mappings (`conversation:{key}` / `outbound:{id}`). 86400 = 1 day. |
| `BUFFER_QUEUE_NAME` | `meta-ai-buffer-timers` | Any non-empty trimmed string (falls back to the default when blank). | BullMQ queue name for the `BullMqBufferScheduler` buffer-flush jobs. |
| `BUFFER_WORKER_CONCURRENCY` | `10` | Positive integer (≥1). | BullMQ Worker concurrency for buffer-flush jobs. `>1` deliberately, so a slow chat-endpoint call for one conversation does not serialize every other conversation's flush behind it (parity with the in-memory scheduler's independent timers). |
| `READY_REDIS_TIMEOUT_MS` | `2000` | Positive integer (≥1). | Timeout the `GET /ready` Redis `ping()` is raced against; a rejection or timeout fails readiness (503) rather than 500ing. |

> The inbound dedupe TTL (`DEDUPE_TTL_SECONDS`, default `86400`) lives in the `conversation` section, not `persistence`, but applies to the Redis dedupe claim too (`dedupe:inbound:{id}` is written `SET ... EX dedupeTtlSeconds NX`). See [Persistence](./persistence.md#redis-key-schema-and-ttls).

### Rate limiting and transient retry (Stage 10; nested `config.limits`)

Loaded by `loadLimitsConfig`. Pacing values are non-negative floats (`0` disables pacing for that channel); the per-hour/per-day caps are non-negative integers (`0` disables that advisory window); the retry knobs are positive integers. The Redis path for the underlying counter store is selected on `REDIS_URL`. See [Rate limiting](./rate-limiting.md).

| Variable | Default | Range / validation | Purpose |
| --- | --- | --- | --- |
| `WHATSAPP_RATE_LIMIT_PER_SECOND` | `80` | Non-negative float (`0` disables pacing). | WhatsApp outbound pre-send pacing (messages/sec) per `{channel}:{businessId}` line. |
| `MESSENGER_RATE_LIMIT_PER_SECOND` | `40` | Non-negative float (`0` disables pacing). | Messenger outbound pacing. |
| `INSTAGRAM_RATE_LIMIT_PER_SECOND` | `10` | Non-negative float (`0` disables pacing). | Instagram outbound pacing. `10` matches the IG media cap and the `InstagramClient`'s own ~10/s in-process floor; `2/s` is the *general* Graph baseline, not the messaging limit, so it would over-throttle. |
| `WHATSAPP_RATE_LIMIT_PER_HOUR` | `1000` | Non-negative integer (`0` disables the window). | **Track-only** WhatsApp per-hour outbound MESSAGE-count counter (advisory warn at 80% / error at the cap; **never gates a send**). |
| `WHATSAPP_RATE_LIMIT_PER_DAY` | `10000` | Non-negative integer (`0` disables the window). | Track-only WhatsApp per-day counter (advisory; never gates). |
| `MESSENGER_RATE_LIMIT_PER_HOUR` | `0` | Non-negative integer. | Track-only Messenger per-hour counter (disabled by default). |
| `MESSENGER_RATE_LIMIT_PER_DAY` | `0` | Non-negative integer. | Track-only Messenger per-day counter (disabled by default). |
| `INSTAGRAM_RATE_LIMIT_PER_HOUR` | `0` | Non-negative integer. | Track-only Instagram per-hour counter (disabled by default). |
| `INSTAGRAM_RATE_LIMIT_PER_DAY` | `0` | Non-negative integer. | Track-only Instagram per-day counter (disabled by default). |
| `TRANSIENT_RETRY_MAX_ATTEMPTS` | `3` | Positive integer (≥1). | Max transient-retry attempts after the first send before the item is skipped and the queue advances. |
| `TRANSIENT_RETRY_BASE_MS` | `1000` | Positive integer (≥1). | Base backoff (ms) for transient retry; exponential with ±20% jitter. Must be `<=` `TRANSIENT_RETRY_MAX_MS`. |
| `TRANSIENT_RETRY_MAX_MS` | `60000` | Positive integer (≥1). | Backoff ceiling (ms) for transient retry. Must be `>=` `TRANSIENT_RETRY_BASE_MS`. |

**Cross-field checks (throw at load):**

- `TRANSIENT_RETRY_BASE_MS <= TRANSIENT_RETRY_MAX_MS` (a base above the max would start backoff beyond its own ceiling).
- For each channel, per-hour `<=` per-day **when both are `> 0`** (an hourly cap above the daily cap is always a misconfiguration; a `0` means that window is disabled, so the check is skipped).

### E2E (consumed by the setup/capture scripts)

| Variable | Purpose |
| --- | --- |
| `E2E_TEST_WHATSAPP_NUMBER` | Developer's personal WhatsApp number (E.164) for live capture and verification. |
| `E2E_TEST_FACEBOOK_PSID` | Developer's PSID for Messenger testing. |
| `E2E_TEST_INSTAGRAM_IGSID` | Developer's IGSID for Instagram testing. |
| `NGROK_AUTHTOKEN` | ngrok SDK auth token. |

None of these are consumed by the running agent; they are read by the setup/capture scripts (see [Setup verification](./setup-verification.md) and [Payload capture](./payload-capture.md)).

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
- `INBOUND_MEDIA_MAX_BYTES` not a positive integer (when set).
- `REDIS_URL` set but not a parseable URL, or set with a scheme other than `redis:` / `rediss:`.
- Any `persistence` knob (`CONVERSATION_TTL_SECONDS`, `BUFFER_WORKER_CONCURRENCY`, `READY_REDIS_TIMEOUT_MS`) not a positive integer (when set).
- Any per-second pacing knob not a non-negative number; any per-hour/per-day cap not a non-negative integer; any transient-retry knob not a positive integer (when set).
- `TRANSIENT_RETRY_BASE_MS > TRANSIENT_RETRY_MAX_MS` (cross-field).
- Any channel's per-hour cap `>` its per-day cap when both are `> 0` (cross-field).

**Advisory only (warns, never throws):** token-format shape checks. `tokenFormatWarnings(config)` is a separate exported pure helper (NOT called from `loadConfig`, which stays logging-free) that `createApp` runs at startup and logs: a Messenger Page token that does not start with `EAA`, an Instagram token that does not start with `IGQ`, or a WhatsApp token shorter than 20 chars. These are heuristics — Meta token formats vary, so a false reject would break a working deploy; the package warns rather than refuses to boot. This is a deliberate deviation from the original plan (which proposed throwing).

## Known limitations

- Token format is **warned, not validated** (deviation from the plan, which proposed throwing). `tokenFormatWarnings` runs heuristic shape checks (Page token `EAA…`, Instagram token `IGQ…`, WhatsApp token ≥20 chars) and `createApp` logs them — a malformed-looking token still boots, because Meta token formats vary and a false reject would break a working deploy. `loadConfig` itself does no token-format check.
- `META_APP_ID` is optional and not asserted to be numeric; it is loaded but not consumed by the running agent today.
- Cross-field validation now covers the buffer window (`BUFFER_MAX_TIMEOUT_MS >= BUFFER_BASE_TIMEOUT_MS`), the transient-retry window (`TRANSIENT_RETRY_BASE_MS <= TRANSIENT_RETRY_MAX_MS`), and per-channel per-hour `<=` per-day (when both `> 0`). There is no cross-check that per-second pacing is consistent with the per-hour/per-day caps — the latter are track-only and never gate, so a mismatch is harmless.
- The per-hour/per-day caps are **track-only** (advisory warn/error logs); they do not gate a send and there is no true gating throughput cap. See [Rate limiting](./rate-limiting.md).
- Boolean parsing for `AGENT_AUTOSTART` (and the other boolean knobs) only accepts `1`/`0`/`true`/`false` — other affirmative strings like `yes`/`on` are rejected.
