# Multi-account

Run several accounts per channel — multiple Facebook Pages, Instagram
professional accounts, and WhatsApp numbers — under one Meta App and one
running transport, each answering as itself.

## Why the seam was outbound-only

Inbound has been multi-account since Stage 1: the parser normalizes every
webhook onto `channelScopedBusinessId` (WhatsApp `phone_number_id` / Page id /
IG user id), and conversation keys embed it — two Pages' conversations never
collide. The single-account constraint lived entirely in outbound adapter
selection: `buildRuntime` constructed at most one client per channel and the
agent looked adapters up by channel alone. Multi-account closes exactly that
seam; no conversation-state, dedupe, or parsing behavior changes.

## Declaring accounts

The bare env vars declare one account per channel, named `default` — an
existing deploy needs no changes. Additional accounts add a `__<name>` suffix
to every credential var:

```bash
# the classic single account, still named "default"
MESSENGER_PAGE_ID=1173448049176722
MESSENGER_PAGE_ACCESS_TOKEN=EAA...

# two more, named "reed" and "iris"
MESSENGER_PAGE_ID__reed=2222222222
MESSENGER_PAGE_ACCESS_TOKEN__reed=EAA...
INSTAGRAM_USER_ID__iris=17841400000000000
INSTAGRAM_ACCESS_TOKEN__iris=IGAA...
```

Account names are discovered by scanning the environment for the suffixed
**primary** var of each channel (`WHATSAPP_PHONE_NUMBER_ID__*`,
`MESSENGER_PAGE_ID__*`, `INSTAGRAM_USER_ID__*`) — there is no separate account
list to drift out of sync. Names must match `[A-Za-z0-9][A-Za-z0-9-]*` (no
underscores; `__` is the delimiter) and `default` is reserved for the bare
vars. Loader validation is fail-fast, matching the rest of `loadConfig`:

- a half-configured named account throws, naming the exact suffixed vars;
- two accounts on one channel sharing a business id throw (inbound routing
  would be ambiguous);
- a malformed or reserved suffix throws at boot, not at first webhook.

Per-account optional vars follow the same suffix
(`WHATSAPP_BUSINESS_ACCOUNT_ID__<name>`). `INSTAGRAM_APP_SECRET` is app-level
— it verifies webhook signatures for the whole app — so named IG accounts
inherit the bare var (`INSTAGRAM_APP_SECRET__<name>` exists as an override for
the unusual several-apps setup).

On the `Config` object the collections surface as `config.accounts.<channel>`
(the `default` account first), with the legacy `config.whatsapp` /
`config.messenger` / `config.instagram` fields still carrying the bare-var
account for existing callers. Consumers should read accounts through
`configuredAccounts(config)`, which derives the single-account form for
hand-assembled configs that predate the field.

## Routing

`buildRuntime` constructs one send client per account and registers it in an
`AdapterRegistry` (`src/meta/shared/registry.ts`) keyed `channel:businessId`.
The conversation agent resolves every outbound through
`resolve(record.channel, record.channelScopedBusinessId)`:

1. an exact `channel:businessId` match wins;
2. when the channel has exactly one account, that account answers for any
   business id — preserving the historical single-account behavior for
   pre-existing records and tests;
3. otherwise the turn is dropped with a warning, exactly like the old
   "channel not configured" case — on a genuinely multi-account channel an
   unclaimed business id is ambiguous, and guessing would answer as the wrong
   identity.

The agent's `adapters` dependency accepts either an `AdapterRegistry` or the
legacy channel-keyed map; the map is wrapped via
`AdapterRegistry.fromChannelMap` so embedders and tests keep working verbatim.

## The chat request

`ChatRequest` gains `accountName` — `'default'` on a single-account deploy,
else the suffix name. One chat endpoint can therefore serve several personas
by routing on `accountName` instead of parsing raw business ids. The
`messages[]` entries still carry `channelScopedBusinessId` for endpoints that
want the id itself.

## Setup scripts

- `npm run meta:webhooks` loops every configured account: the app-level
  subscription runs once per channel (callback URL + field selection are
  app-global), then each Messenger Page / IG user / WABA subscribes with its
  own token. Results are reported per account.
- `npm run setup:whatsapp|messenger|instagram` verify ONE account per run —
  they are interactive end-to-end tests (send a DM from your phone…) — and
  take `--account=<name>` to pick which. Default: `default`.
- `npm run setup:oauth:instagram -- --account=<name>` and
  `npm run setup:oauth:messenger -- --account=<name>` mint tokens for a named
  account: the captured credentials are printed and appended to `.env` under
  the suffixed var names, and the clobber guards become account-scoped (a
  populated default no longer blocks capturing `reed`). The Messenger flow's
  Page auto-selection reads `MESSENGER_PAGE_ID__<name>` when an account is
  named.

## Notes and edges

- **Webhook field selection is app-global** on every channel: you cannot
  subscribe one IG account to `comments` and another to `messages` only. What
  is per-account is the subscription itself (`/{id}/subscribed_apps`).
- **Inbound media hydration** authenticates with one WhatsApp token (the first
  configured account's). WhatsApp media ids are app-scoped, so this works for
  the common case; per-account hydration tokens require injecting a custom
  hydrator through `buildRuntime`'s seams.
- Per-channel outbound pacing (`src/limits`) was already keyed by
  `(channel, businessId)`, so each account gets its own token bucket with no
  changes.
