# Outbound send clients (Stage 4)

The outbound layer turns a desired action ("send this text", "show typing", "mark
read", "react") into the exact Meta Graph API request each channel expects, and
sends it through a shared HTTP transport with retry/backoff. It is the
counterpart to the Stage 2 inbound parser: the parser folds three channels into
one normalized `IncomingMessage`; the outbound clients fan one uniform
`ChannelAdapter` call back out to three channel-specific request shapes.

## Purpose

Every per-channel client (WhatsApp / Messenger / Instagram) implements the same
[`ChannelAdapter`](../../src/meta/shared/adapter.ts) interface. The (future)
conversation agent (Stage 5) can therefore dispatch an outbound message without
branching on `channel === 'whatsapp'`: it holds a `ChannelAdapter`, calls
`sendText` / `sendTypingIndicator` / `markRead` / `sendReaction`, and asks
`supports(feature)` before attempting anything channel-specific. Capability
differences are surfaced at runtime via `supports()` rather than by throwing, so
an unsupported request (e.g. a template on Instagram) is skipped cleanly instead
of erroring.

The clients are transport adapters only. They own request body shapes and the
read of the success envelope; they do not buffer, sequence, dedupe, or decide
*when* to send. That sequencing (typing → delay → text, ordered delivery,
cross-payload dedupe) is the conversation agent / delivery queue's job in
Stage 5.

## The shared `GraphClient`

[`src/meta/shared/graph-client.ts`](../../src/meta/shared/graph-client.ts) is the
runtime HTTP transport all three clients call. It is deliberately
**transport-only**: it knows nothing about `messaging_product`, `recipient`, or
`sender_action`. The per-channel clients own those and call
`GraphClient.request(...)`.

This client is **separate** from the setup-time `graphFetch` in
[`scripts/lib/graph-api.ts`](../../scripts/lib/graph-api.ts). The setup helper is
a thin one-shot wrapper used by the verify/capture tooling; the runtime client
adds retry with exponential backoff and sends the token as an
`Authorization: Bearer` header rather than a query parameter. `src/` never
imports from `scripts/` — the dependency direction is one-way (`scripts/ → src/`).

### Versioned URL building

`buildUrl()` produces `https://{host}/{version}/{path}?{query}`:

- **Host** is either `graph.facebook.com` (default) or `graph.instagram.com`
  (`GraphHost` union). The Instagram client overrides the host; WhatsApp and
  Messenger use the default.
- **Version** is `GraphClientOptions.apiVersion` (e.g. `config.meta.graphApiVersion`,
  `'v25.0'`). The version segment is included unless `versioned: false` is passed
  (some endpoints, like the Instagram OAuth token swap, are unversioned — that is
  a setup-script concern, not a runtime-send one).
- **Path** is given without a leading slash and without the version prefix, e.g.
  `'{phoneNumberId}/messages'`.
- **Query** values that are `undefined` are dropped; numbers/booleans are
  stringified. Runtime sends are POST bodies, so the query string is normally
  empty.

### Bearer auth

The access token is always sent as an `Authorization: Bearer <token>` header,
**never** in the query string. Proxies, CDNs, and server access logs routinely
record full query strings, so a token in the URL leaks into logs; the header
keeps it out of URLs. This matches the choice Stage 3 made for the webhook
surface. See [Auth & secrets](#auth--secrets).

### Error parsing

On any non-2xx response (and on a transport failure before any response) the
client throws a [`MetaApiError`](#metaapierror). It reads the body as text first,
attempts a JSON parse, and extracts Meta's standard error envelope
(`{ error: { message, type, code, error_subcode, fbtrace_id } }`) into structured
fields. A 2xx with an empty body is normalized to `{}` so callers always get an
object back.

### Retry / backoff matrix

This is the subtle part. `GraphClient.request` retries up to `maxRetries` times
(default 3, i.e. up to 4 total attempts), and the decision to retry depends on
**both** the HTTP status and whether the request is idempotent:

| Condition | Retry? | Why |
| --- | --- | --- |
| `429` (rate limited) | Always, any method | Meta rejected the request before processing it, so re-sending is safe even for a non-idempotent POST. |
| Network error before any response (`httpStatus: 0`) | Always, any method | `fetch` rejected before a response; the request never reached Meta (or we never learned it did), so re-sending cannot double-apply it. |
| `5xx` (server error) | Only when `idempotent === true` | A 5xx **after** a POST is ambiguous — Meta may have already accepted and sent the message before the error surfaced. Retrying could **double-send**. |
| Any other `4xx` | Never | Deterministic client error; re-sending changes nothing and burns rate budget. |

`idempotent` defaults to `true` for `GET` and `false` for `POST`/`DELETE`. **All
outbound sends are POST and leave `idempotent` unset**, so a 5xx is *not* retried
for them — this is the double-send-safety guarantee. (429 and pre-response
network failures are still retried, because those never reached Meta.)

Backoff honors a `Retry-After` response header when present (numeric seconds or
an HTTP-date), capped at `maxBackoffMs` (default 8000). Otherwise it uses
exponential backoff with full jitter:
`min(maxBackoffMs, baseBackoffMs * 2^attempt) + random(0, baseBackoffMs)`
(`baseBackoffMs` default 500). Both `fetchImpl` and `sleep` are injectable so
tests run with a mock fetch and a no-op sleep — see [Testing](../TESTING.md).

## `MetaApiError`

[`src/meta/shared/errors.ts`](../../src/meta/shared/errors.ts) is the **canonical**
location for the error type. It is intentionally dependency-free (no fetch, no
config) so both the runtime client and the setup scripts can share it without
dragging runtime concerns into setup. [`scripts/lib/graph-api.ts`](../../scripts/lib/graph-api.ts)
re-exports it — there is one error class, defined in `src/`, consumed in both
places.

Fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `operation` | `string` | Free-form label, e.g. `'whatsapp.sendText'`. |
| `httpStatus` | `number` | HTTP status; `0` for a transport failure before any response. |
| `errorCode` | `number?` | Meta's `error.code`. |
| `errorSubCode` | `number?` | Meta's `error.error_subcode`. |
| `fbtraceId` | `string?` | Meta's `error.fbtrace_id` (quote it in support tickets). |
| `responseBody` | `unknown` | Parsed error JSON when available, else raw text. |
| `cause` | `unknown?` | The underlying transport exception, passed to `Error`'s `cause` so the stack chain links to e.g. `ECONNREFUSED`. |

Callers branch on **codes, not message strings**. The error envelope shape
(`error.code` / `error.error_subcode` / `error.fbtrace_id`) is consistent across
all three products, so downstream logic should switch on `errorCode` /
`errorSubCode` rather than regex-matching `error.message`, which is unstable and
localized.

## The `ChannelAdapter` interface

[`src/meta/shared/adapter.ts`](../../src/meta/shared/adapter.ts) defines the
uniform contract:

```typescript
interface ChannelAdapter {
  readonly channel: Channel;
  sendText(recipientId: string, text: string, opts?: SendOptions): Promise<SendResult>;
  sendTypingIndicator(recipientId: string, messageId?: string): Promise<void>;
  markRead(recipientId: string, messageId: string): Promise<void>;
  sendReaction(recipientId: string, messageId: string, emoji: string): Promise<void>;
  supports(feature: ChannelFeature): boolean;
}
```

A uniform signature is kept even where a channel ignores a parameter, so the
conversation agent's dispatch code stays channel-agnostic:

- `sendReaction` takes `recipientId` on every channel because WhatsApp's reaction
  send **requires** the recipient `to` in the body; Messenger/Instagram derive the
  target from `messageId` and ignore the param.
- `sendTypingIndicator`'s `messageId` is **required in practice on WhatsApp**
  (typing is anchored to an inbound message id — see below) but optional in the
  signature because Messenger/Instagram type at the conversation level and ignore
  it.
- `markRead`'s `messageId` is used by WhatsApp (it marks a specific message read)
  but ignored by Messenger/Instagram, which advance a thread-level watermark.

### `SendResult`

Returned by `sendText` (and WhatsApp's `sendTemplate`). Shared across channels so
a delivery queue / status tracker can key on `messageId` uniformly.

| Field | Type | Notes |
| --- | --- | --- |
| `channel` | `Channel` | `'whatsapp' \| 'messenger' \| 'instagram'`. |
| `messageId` | `string` | Channel-scoped outbound id: `wamid.*` (WA), `m_*` (Messenger), `mid.*` (IG). |
| `recipientId` | `string` | The recipient the message was sent to (Messenger prefers the id Meta echoes back). |
| `timestamp` | `number` | Milliseconds since epoch, set by the client at send time. |
| `raw` | `unknown?` | The raw API response, for debugging. |

A 2xx response with no message id is treated as an error: every client throws
loudly rather than returning an empty/garbage id downstream.

### `SendOptions`

Per-send options; channels ignore fields they do not support.

| Field | Type | Applies to |
| --- | --- | --- |
| `replyTo` | `string?` | WhatsApp `context.message_id`; Messenger top-level `reply_to.mid`. **Ignored by Instagram** — the Instagram-Login Send API has no working outbound quoted reply (see [Quoted replies](#quoted-replies-per-channel)). |
| `messagingType` | `'RESPONSE' \| 'UPDATE' \| 'MESSAGE_TAG'?` | Messenger/Instagram. Ignored by WhatsApp. Defaults to `RESPONSE`. |
| `tag` | `string?` | Messenger/Instagram; required (top-level) when `messagingType === 'MESSAGE_TAG'`. |

## The `supports()` capability matrix

`supports(feature: ChannelFeature)` returns whether a channel actually has a
feature wired **at Stage 4**. The conversation agent checks this before
attempting a feature. The `ChannelFeature` union and the per-channel answers:

| Feature | WhatsApp | Messenger | Instagram |
| --- | --- | --- | --- |
| `typing_indicator` | Yes | Yes | Yes |
| `read_receipt` | Yes | Yes | Yes |
| `reaction` | Yes | Yes | Yes |
| `reply_to` | Yes | Yes | No |
| `template` | Yes | No | No |
| `media_send` | No | No | No |
| `persistent_menu` | No | No | No |
| `get_started` | No | No | No |
| `ice_breakers` | No | No | No |
| `story_reply` | No | No | No |

Notes on the `No` cells:

- `template` is the WhatsApp message-template concept. Messenger's own message
  templates are a different feature and are out of Stage 4 scope; Instagram has no
  template messaging at all.
- `media_send` lands in Stage 7 (media upload + send) on all three channels.
- `persistent_menu` / `get_started` / `ice_breakers` are Messenger/Instagram
  profile surfaces (Stage 8); none apply to WhatsApp.
- `story_reply` is an **inbound** concept (a user replying to a business story
  arrives via webhook), not an outbound send capability, so it is `No`
  everywhere.
- Instagram's `reply_to` is `No`: the Instagram-Login Send API (`graph.instagram.com`)
  has **no working outbound quoted reply** — exhaustively live-verified 2026-05-20
  (every `reply_to` shape and target rejected or silently ignored; see
  [Quoted replies](#quoted-replies-per-channel) and [Known gaps](../KNOWN-GAPS.md)).
  The conversation agent downgrades a `reply` action to a plain `message` so the
  user still receives the text.
- Instagram's `read_receipt` is advertised `Yes` but is **pending fidelity
  confirmation** against the Instagram-Login Send API (see the `mark_seen` flag in
  the source). It is advertised true so the agent attempts it; flip to false if a
  fidelity review proves it unsupported.

## Quoted replies (per-channel)

"Quoted reply" (threading a reply to a specific inbound message) uses a **different
mechanism on each channel**. All three were live-verified on 2026-05-20:

| Channel | Mechanism | Status |
| --- | --- | --- |
| WhatsApp | `context: { message_id }` (nested in the message body) | Works |
| Messenger | **top-level** `reply_to: { mid }` (a sibling of `message`, NOT `message.reply_to`) | Works |
| Instagram (Instagram-Login) | none — `opts.replyTo` is ignored | **Unsupported** |

- **WhatsApp** attaches `context.message_id` referencing the inbound wamid.
- **Messenger** attaches a **top-level** `reply_to.mid`. The nested `message.reply_to`
  shape is rejected with `(#100) Invalid keys "reply_to" were found in param "message"`,
  so the field must be a sibling of `message`.
- **Instagram (Instagram-Login, `graph.instagram.com`)** has **no working outbound
  quoted reply**. Exhaustively verified 2026-05-20: a top-level `reply_to:{mid}`
  returns `code 100 / subcode 2534002 "Invalid Message ID"` — even for a bot's own
  just-returned (provably valid) message id; `reply_to_message_id` (flat) is accepted
  but renders as a **plain** message; nested forms are "invalid keys". So
  `supports('reply_to')` is `false` and the client builds no reply field. The
  conversation agent **downgrades** a `reply` action to a plain `message`
  ([`src/delivery/queue.ts`](../../src/delivery/queue.ts) `buildOutboundItems`), so
  the user still receives the text — only the threading link is lost. (The
  Facebook-Login "Messenger API for Instagram" flavor supports `reply_to`; native IG
  quotes would require that different integration path. See [Known gaps](../KNOWN-GAPS.md).)

## Per-channel client notes

### WhatsApp — [`src/meta/whatsapp/client.ts`](../../src/meta/whatsapp/client.ts)

Every method is `POST {phoneNumberId}/messages` on `graph.facebook.com`. The
token comes from `WhatsAppConfig.accessToken`.

- **`sendText`** sets `preview_url: false` (the agent controls link presentation;
  URLs do not auto-expand). `opts.replyTo` attaches `context: { message_id }` so
  the message renders as a threaded reply to that inbound wamid.
- **Typing indicator is a combined call.** WhatsApp has no standalone "typing on".
  `sendTypingIndicator(to, messageId)` POSTs
  `{ messaging_product: 'whatsapp', status: 'read', message_id: <inbound wamid>, typing_indicator: { type: 'text' } }`
  — i.e. it marks the specific inbound message read **and** attaches the typing
  bubble in one request. The bubble is anchored to an inbound wamid, so
  `messageId` is **required**; if it is absent the client logs a warn and returns
  rather than sending a malformed request. (This supersedes any older description
  of a standalone `type: 'typing_indicator'` message — see
  [Known gaps](../KNOWN-GAPS.md).)
- **`markRead`** POSTs `{ messaging_product: 'whatsapp', status: 'read', message_id }`.
  The `to` param is unused — the wamid identifies the conversation.
- **Reactions** POST `{ messaging_product: 'whatsapp', to, type: 'reaction', reaction: { message_id, emoji } }`.
  An **empty-string `emoji` is preserved verbatim** because WhatsApp's documented
  unreact is a reaction with `emoji: ''` — passing `''` removes the existing
  reaction. The client deliberately does not coerce or skip it.
- **`sendTemplate(to, name, languageCode, components?)`** is the only way to
  message a user **outside** the 24-hour customer-service window. It POSTs
  `type: 'template'` with `template: { name, language: { code }, components? }`.
  `components` (header/body/button substitutions) is forwarded verbatim when
  supplied and omitted entirely otherwise. `TemplateComponent` / `TemplateParameter`
  are kept structural (extra fields pass through) rather than a faithful copy of
  Meta's full template schema.

### Messenger — [`src/meta/messenger/client.ts`](../../src/meta/messenger/client.ts)

Every method is `POST {pageId}/messages` on `graph.facebook.com` with the Page
access token (`MessengerConfig.pageAccessToken`).

- **`sendText`** body is
  `{ recipient: { id }, messaging_type, message: { text }, reply_to?, tag? }`.
  `messaging_type` defaults to `RESPONSE`. `opts.replyTo` becomes a **top-level**
  `reply_to.mid` (a sibling of `message`, NOT nested inside it — Meta rejects
  `message.reply_to` with `(#100) Invalid keys "reply_to" ... in param "message"`).
  Live-confirmed working 2026-05-20 (see [Quoted replies](#quoted-replies-per-channel)).
- **`MESSAGE_TAG` requires a top-level `tag`.** When
  `messagingType === 'MESSAGE_TAG'` the client validates `opts.tag` is set and
  throws a clear local error otherwise (Meta would reject it with an opaque
  error). The `tag` is a **top-level** body field, not nested under `message`.
- **`sender_action` must be a separate request.** The Messenger Send API rejects
  a body that combines a `sender_action` with a `message`. So typing, mark-seen,
  and reactions are each their own POST:
  - `sendTypingOn` / `sendTypingOff`: `{ recipient: { id }, sender_action: 'typing_on' | 'typing_off' }`.
  - `markSeen`: `{ recipient: { id }, sender_action: 'mark_seen' }` — a
    thread-level watermark that marks all prior inbound messages read (there is no
    per-message read receipt).
  - The adapter methods `sendTypingIndicator` and `markRead` delegate to
    `sendTypingOn` / `markSeen` and ignore the `messageId` param.
- **React / unreact** via `sender_action` (also a standalone request):
  - React (non-empty `emoji`): `{ recipient: { id }, sender_action: 'react', payload: { message_id, reaction: emoji } }`
    — the emoji is nested **inside** `payload` as `reaction`, not a sibling.
  - Unreact (empty-string `emoji`): `{ recipient: { id }, sender_action: 'unreact', payload: { message_id } }`
    — `payload` carries only `message_id`, no `reaction` key. Passing `''` is the
    documented unreact path, mirroring WhatsApp's empty-emoji convention.
  - `recipientId` **is** used here — it is the user whose message is being reacted
    to (`recipient.id`).

### Instagram — [`src/meta/instagram/client.ts`](../../src/meta/instagram/client.ts)

Every method is `POST {igUserId}/messages` on **`graph.instagram.com`** (not the
default host). This client targets the Instagram API with Instagram Login
(Business Login), whose messaging endpoints are served from that host. The token
comes from `InstagramConfig.accessToken`.

- **`sendText`** body is `{ recipient: { id }, message: { text } }`. `opts.replyTo`
  is **ignored** — the Instagram-Login Send API has no working outbound quoted
  reply (see [Quoted replies](#quoted-replies-per-channel)); the text still sends.
- **`mark_seen` and typing** are standalone `sender_action` POSTs, same
  separate-request constraint as Messenger:
  - `sendTypingOn`: `{ recipient: { id }, sender_action: 'typing_on' }`.
  - `markSeen`: `{ recipient: { id }, sender_action: 'mark_seen' }`.
  - The adapter methods delegate and ignore `messageId` (IG typing/seen are
    conversation-scoped, not anchored to a single message).
- **React / unreact** mirror Messenger exactly:
  - React: `{ recipient: { id }, sender_action: 'react', payload: { message_id, reaction: emoji } }`.
  - Unreact (empty `emoji`): `{ recipient: { id }, sender_action: 'unreact', payload: { message_id } }`.
- **In-process rate pacer.** Every IG send is routed through a minimal serialized
  pacer that enforces a minimum spacing between two outbound Graph calls for one
  account. The default is **100ms** (`DEFAULT_MIN_CALL_SPACING_MS`), overridable
  per client via `InstagramClientDeps.minIntervalMs`. The pacer:
  1. **Spaces** calls — if the last call was less than the interval ago, it sleeps
     for the remaining time.
  2. **Serializes** concurrent callers via a single promise chain (`pacerTail`), so
     N concurrent sends are spaced apart rather than all reading the same stale
     timestamp and firing together. A failed send does not poison the chain for
     later calls.

  Why 100ms: Meta documents per-account ceilings well above 2 calls/sec —
  roughly **300 calls/sec** for text/links/reactions/stickers and **10 calls/sec**
  for audio/video, plus a separate hourly throughput model of
  `200 × number-of-messageable-users`. The strictest per-second sub-limit is the
  10/sec media ceiling, so `1000ms / 10 = 100ms` is a conservative floor that
  honors it without throttling legitimate text bursts. This is **only** a coarse
  per-process floor to avoid tripping immediate 429s; it does **not** coordinate
  across replicas. The full model (per-second + hourly throughput, multi-replica,
  token-bucket accounting) is Stage 10's `LimitTracker`. The pacer's `now` and
  `sleep` are injectable so tests assert spacing deterministically with no real
  delay.

## Auth & secrets

- Access tokens are always sent as `Authorization: Bearer <token>` and never
  placed in a URL/query string (see [the Bearer-auth rationale](#bearer-auth)).
- The clients never log access tokens or full request bodies — only redacted
  shapes (operation, attempt, status, delay). `MetaApiError` likewise carries only
  redacted shapes; never log raw secrets through it.
- Each client reads its token per request from its channel config
  (`WhatsAppConfig` / `MessengerConfig` / `InstagramConfig` in
  [`src/config/loader.ts`](../../src/config/loader.ts)).

## What is NOT in scope yet

- **Media send** (`sendImage` / `sendAudio` / `sendVideo` / `sendDocument`) —
  Stage 7. `supports('media_send')` is `No` everywhere today.
- **Templates beyond WhatsApp** — Messenger message templates and any IG
  rich-message surfaces are out of scope; only WhatsApp `sendTemplate` exists.
- **Profile surfaces** — persistent menu, Get Started, ice breakers — Stage 8.
- **Full rate limiting** — the real per-second + hourly model and cross-replica
  coordination — Stage 10 (`LimitTracker`). The IG 100ms pacer is an interim
  in-process floor only.
- **Conversation wiring** — the clients are not yet called by any conversation
  flow. The Stage 1 webhook route still discards the parsed `ParseResult`; Stage 5
  introduces the `ConversationAgent` / delivery queue that drives these adapters
  (typing → delay → text, ordered delivery).

See [Known gaps](../KNOWN-GAPS.md) for the running deferral list.

## Code references

Source:

- [`src/meta/shared/errors.ts`](../../src/meta/shared/errors.ts) — canonical `MetaApiError`.
- [`src/meta/shared/graph-client.ts`](../../src/meta/shared/graph-client.ts) — runtime transport, retry/backoff matrix.
- [`src/meta/shared/adapter.ts`](../../src/meta/shared/adapter.ts) — `ChannelAdapter`, `SendResult`, `SendOptions`, `ChannelFeature`.
- [`src/meta/whatsapp/client.ts`](../../src/meta/whatsapp/client.ts) — WhatsApp client (+ `sendTemplate`).
- [`src/meta/messenger/client.ts`](../../src/meta/messenger/client.ts) — Messenger client.
- [`src/meta/instagram/client.ts`](../../src/meta/instagram/client.ts) — Instagram client (+ rate pacer).

Tests (see [Testing](../TESTING.md)):

- [`tests/unit/graph-client.test.ts`](../../tests/unit/graph-client.test.ts)
- [`tests/unit/meta-errors.test.ts`](../../tests/unit/meta-errors.test.ts)
- [`tests/unit/whatsapp-client.test.ts`](../../tests/unit/whatsapp-client.test.ts)
- [`tests/unit/messenger-client.test.ts`](../../tests/unit/messenger-client.test.ts)
- [`tests/unit/instagram-client.test.ts`](../../tests/unit/instagram-client.test.ts)

Related: [Architecture](../ARCHITECTURE.md) · [Message parsing](./message-parsing.md) (the inbound counterpart) · [Webhook security](./webhook-security.md) (the Bearer-vs-query precedent).
