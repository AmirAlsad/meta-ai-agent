# Messenger Profile API

The Messenger Profile API configures a Page's **conversation-entry surface** — the
Get Started button, the greeting (welcome) text, the persistent menu, and ice
breakers. These are **setup-time** configs applied **out-of-band** of the live
message loop: they are set once (or whenever the setup changes) against
`{pageId}/messenger_profile` and then apply to every conversation thread. They are
**not** per-message sends.

This is the counterpart to the per-message
[`MessengerClient`](./outbound-clients.md): the send client owns
`{pageId}/messages` (one POST per outbound message); this client owns the profile
surface. Keeping them apart stops the per-message hot path from carrying setup
concerns.

Source:
[`src/meta/messenger/profile.ts`](../../src/meta/messenger/profile.ts)
(`MessengerProfileClient`).

## Purpose

`MessengerProfileClient` is a thin wrapper over the shared
[`GraphClient`](./outbound-clients.md#the-shared-graphclient) that owns the
`messenger_profile` body shapes (`get_started`, `greeting`, `persistent_menu`,
`ice_breakers`). The public TypeScript inputs are camelCase (idiomatic TS); Meta's
JSON is snake_case — every method maps camelCase to snake_case before the request,
so callers never think in Meta's wire casing.

Every call hits `{pageId}/messenger_profile` on `graph.facebook.com` with the Page
access token (`MessengerConfig.pageAccessToken`) sent as an
`Authorization: Bearer` header (the `GraphClient` does this — the token is **never**
in the URL).

`supports('get_started' | 'persistent_menu' | 'ice_breakers')` on `MessengerClient`
is now **`true`** — it advertises that these surfaces **exist** for the channel
(configured out-of-band, not per message), so the conversation agent includes them
in its capability set. See [Outbound clients](./outbound-clients.md#the-supports-capability-matrix).

Reference: Meta's
[Messenger Profile API](https://developers.facebook.com/docs/messenger-platform/reference/messenger-profile-api).

## Methods → JSON

Each write method maps its camelCase input to the snake_case `messenger_profile`
body field and POSTs it. The reads/deletes target the same path.

| Method | HTTP | Body / query it produces |
| --- | --- | --- |
| `setGetStartedButton(payload)` | `POST` | `{ get_started: { payload } }` |
| `setGreetingText([{ locale, text }])` | `POST` | `{ greeting: [{ locale, text }, …] }` |
| `setPersistentMenu([{ locale, composerInputDisabled?, callToActions }])` | `POST` | `{ persistent_menu: [{ locale, composer_input_disabled?, call_to_actions: [{ type, title, payload? \| url?, webview_height_ratio? }] }] }` |
| `setIceBreakers([{ locale, callToActions }])` | `POST` | `{ ice_breakers: [{ locale, call_to_actions: [{ question, payload }] }] }` |
| `getMessengerProfile(fields)` | `GET` | `?fields=<comma-joined>` (e.g. `get_started,persistent_menu,greeting,ice_breakers`) |
| `deleteMessengerProfileFields(fields)` | `DELETE` | body `{ fields: [...] }` (deletes by listing field names in the **body**, not a query) |

Field mapping details:

- `composerInputDisabled` → `composer_input_disabled` (emitted **only** when
  explicitly set, so Meta applies its own default otherwise).
- `callToActions` → `call_to_actions`; `webviewHeightRatio` →
  `webview_height_ratio`.
- A `CallToAction` is a discriminated union — only the fields valid for each `type`
  are emitted: `postback` → `{ type, title, payload }`; `web_url` →
  `{ type, title, url, webview_height_ratio? }` (a free `mapCallToAction` helper
  enforces this per-type field discipline).
- `getMessengerProfile` returns Meta's raw response (`{ data: [...] }`) untyped —
  callers inspect what they asked for. The Profile API requires an explicit
  `fields` list (there is no implicit "all"), so the names are comma-joined.

`Greeting` is passed through as `{ locale, text }`; Meta requires a `'default'`
locale entry, and the client lets Meta validate that rule rather than duplicating
(and risking drift from) Meta's locale bookkeeping. `locale` is `'default'` (the
fallback) or a Meta locale code such as `'en_US'`.

> Persistent menus also support a `nested` action type (sub-menus). It is
> intentionally **not** modeled (`CallToAction` covers only `postback` / `web_url`)
> — the agent's menus are flat. A caller needing nesting can extend the union later.

## Ordering: Get Started must precede the persistent menu

Meta **requires** the Get Started button to exist **before** a persistent menu can
be set. A `persistent_menu` POST with no existing `get_started` is rejected with
error code **2018145**.

`setPersistentMenu` catches that specific code and re-throws a clear, actionable
`MetaApiError` telling the operator to call `setGetStartedButton(payload)` first:

```
Cannot set a persistent menu before the Get Started button exists. Call
setGetStartedButton(payload) first, then setPersistentMenu(...) (Meta error code
2018145).
```

Any **other** error propagates unchanged (the original error + `cause` are
preserved).

Two fragile details, both encoded in the source and worth keeping in mind:

- **2018145 is empirically-observed, not documented by Meta.** Meta documents the
  *requirement* (Get Started before persistent menu) but does not publish the
  numeric code. It is isolated as a named constant
  (`GET_STARTED_REQUIRED_ERROR_CODE`) so a future Meta change is easy to spot/update.
- **It can surface as either `errorCode` OR `errorSubCode`,** so the match checks
  **both** fields.

In a setup sequence (and in the [`setup:profile` script](#the-setupprofile-script)),
call `setGetStartedButton` first. See [Known gaps](../KNOWN-GAPS.md).

## Caps

- **Persistent menu: up to 20 top-level `call_to_actions`** per locale (Meta's cap).
  The client passes the list through and lets **Meta** validate the count (its
  error names the exact limit) — there is **no client-side check** of the 20-CTA cap.
- **Ice breakers: at most 4 per locale** (`MAX_ICE_BREAKERS_PER_LOCALE`). This **is**
  validated locally: `setIceBreakers` throws a clear error naming the offending
  locale before any request is made, rather than letting Meta reject the whole call
  with a less specific message (the same fail-fast posture the send client uses for
  `MESSAGE_TAG`). Only the count is enforced locally; everything else (e.g.
  duplicate locales) is left for Meta to validate.

## Retry posture

The shared POST helper deliberately leaves `idempotent` unset (it defaults to
`false` for POST), so the `GraphClient` does **not** retry a 5xx on a profile
write — re-applying a configuration mutation after an ambiguous server error is
needless; the operator can simply re-run setup. 429 and pre-response network
failures are still retried (safe — they never reached Meta). See the
[retry/backoff matrix](./outbound-clients.md#retry--backoff-matrix).

A debug breadcrumb logs the **operation name only** on each write — never the body,
which can carry payloads/titles. The client never logs access tokens or full
request bodies.

## The `setup:profile` script

[`scripts/setup/configure-profile.ts`](../../scripts/setup/configure-profile.ts)
applies the Messenger Profile surfaces **and** the
[Instagram ice breakers](./instagram-platform.md#ice-breakers) from a single JSON
config file against a real Meta App. It is the companion to
`register-webhooks.ts`: webhooks make events flow **in**; this makes the
conversation-entry UI (buttons / menus / starters) show up on the threads.

```bash
npm run setup:profile -- --config=<path> [--channels=messenger,instagram]
```

It reuses the **real** clients (`MessengerProfileClient` / `InstagramIceBreakers`)
over the shared `GraphClient`, so it exercises the exact camelCase→snake_case
body-mapping + validation code that production uses — it does **not** reimplement
any profile body shaping.

### JSON config shape

All sections and fields are **optional**. The shape (also shipped at
[`scripts/setup/profile.example.json`](../../scripts/setup/profile.example.json)):

```json
{
  "messenger": {
    "getStarted": { "payload": "GET_STARTED" },
    "greeting": [{ "locale": "default", "text": "Hi! How can we help?" }],
    "persistentMenu": [
      {
        "locale": "default",
        "composerInputDisabled": false,
        "callToActions": [
          { "type": "postback", "title": "Talk to us", "payload": "TALK" },
          { "type": "web_url", "title": "Website", "url": "https://example.com" }
        ]
      }
    ],
    "iceBreakers": [
      {
        "locale": "default",
        "callToActions": [{ "question": "What are your hours?", "payload": "HOURS" }]
      }
    ]
  },
  "instagram": {
    "iceBreakers": [
      {
        "locale": "default",
        "callToActions": [{ "question": "How do I order?", "payload": "ORDER" }]
      }
    ]
  }
}
```

### Per-step ordering and partial success

The JSON→client-calls mapping lives in `applyProfile`, a **pure** function (the CLI
wrapper does only I/O: parse args, load config, read the JSON, build the clients,
call `applyProfile`, print the summary, set the exit code). For Messenger it applies
present fields in the fixed order:

```
get_started → greeting → persistent_menu → ice_breakers
```

so a single config file that defines both Get Started and a persistent menu always
satisfies the [Get-Started-first dependency](#ordering-get-started-must-precede-the-persistent-menu).
Instagram has only an `ice_breakers` step.

**Partial success:** every step runs in its own `try`/`catch`. A failing step is
recorded (with the Meta error code/subcode/fbtrace_id, never the body) and the
**next** step and channel still run — one bad surface never aborts the rest. The
script prints a per-channel, per-step pass/fail table and exits non-zero only when a
step actually **failed**. "Nothing to do" (no channel both configured **and** present
in the JSON) is a no-op success.

**Channel/section skipping:** a channel is applied only when it is **both**
configured (credentials present, so a client is wired) **and** has a section in the
JSON. `--channels=` restricts to specific channels. The CLI emits a `warn` for any
channel a developer plausibly expected to apply but won't (present in the JSON but
missing creds, or requested via `--channels` but absent from the JSON). It **never
crashes** — a bad file / malformed JSON / missing channel is a friendly console
error and a non-zero `process.exitCode`, never an unhandled throw.

The pure `applyProfile` (and `parseProfileConfig` / `parseProfileArgs`) seams are
unit-tested. See [Setup verification](./setup-verification.md#instagram--messenger-profile-configuration-setupprofile)
and [Testing](../TESTING.md).

## Code references

Source:

- [`src/meta/messenger/profile.ts`](../../src/meta/messenger/profile.ts) —
  `MessengerProfileClient` (the four write methods, `getMessengerProfile`,
  `deleteMessengerProfileFields`, the 2018145 reclassification, the ≤4 ice-breaker
  cap, `mapCallToAction`).
- [`src/meta/messenger/client.ts`](../../src/meta/messenger/client.ts) — the
  `supports()` matrix advertising `get_started` / `persistent_menu` /
  `ice_breakers` as channel capabilities.
- [`scripts/setup/configure-profile.ts`](../../scripts/setup/configure-profile.ts)
  — the `setup:profile` CLI + the pure `applyProfile` seam.
- [`scripts/setup/profile.example.json`](../../scripts/setup/profile.example.json)
  — sample config.

Tests (see [Testing](../TESTING.md)):

- [`tests/unit/messenger-profile.test.ts`](../../tests/unit/messenger-profile.test.ts)
  — the exact `messenger_profile` bodies/URL/method per write, the 2018145→friendly
  reclassification (matched on code OR subcode), the ≤4 ice-breaker local throw, the
  GET `fields` query, the DELETE body.
- [`tests/unit/scripts-configure-profile.test.ts`](../../tests/unit/scripts-configure-profile.test.ts)
  — `applyProfile` ordering + partial success, `parseProfileConfig` validation,
  `parseProfileArgs` flag grammar.

Related: [Instagram platform](./instagram-platform.md) ·
[Outbound clients](./outbound-clients.md) ·
[Setup verification](./setup-verification.md) ·
[Rich chat actions](./rich-chat-actions.md) (postbacks fired by these surfaces
arrive inbound) · [Known gaps](../KNOWN-GAPS.md).
