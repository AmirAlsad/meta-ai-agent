# Rich chat actions

The chat contract is the boundary between this transport package and the
developer's AI logic. The agent POSTs a `ChatRequest` describing one buffered
inbound turn to `CHAT_ENDPOINT_URL`; the endpoint replies with either the legacy
`message` / `messages` / `silence` form or a rich `actions[]` array. A normalizer
collapses every shape into one ordered `ChatAction[]`, which the delivery layer
turns into outbound items.

Source: [`src/chat/types.ts`](../../src/chat/types.ts) (shapes, incl. `TargetRef` /
`ChatActionTarget`),
[`src/chat/contract.ts`](../../src/chat/contract.ts) (`normalizeChatResponse` + the
field-aliasing in `validateAction`),
[`src/chat/target-resolver.ts`](../../src/chat/target-resolver.ts)
(`resolveTargetRef`),
[`src/chat/client.ts`](../../src/chat/client.ts) (the HTTP client),
[`src/chat/errors.ts`](../../src/chat/errors.ts) (`ChatEndpointError`), and
`buildOutboundItems` in [`src/delivery/queue.ts`](../../src/delivery/queue.ts).
For where this fits see [Conversation state](./conversation-state.md) and
[Ordered delivery](./ordered-delivery.md).

## The request

`ChatRequest` ([`src/chat/types.ts`](../../src/chat/types.ts)) is what the
developer's endpoint receives for one (possibly buffered) turn:

| Field | Type | Meaning |
| --- | --- | --- |
| `channel` | `'whatsapp' \| 'messenger' \| 'instagram'` | Which channel the turn arrived on. |
| `conversationKey` | `string` | The `{channel}:{business}:{user}` key (see [Conversation state](./conversation-state.md)). |
| `message` | `string` | Backward-compat aggregated text: the buffered bodies, newline-joined. |
| `messages` | `IncomingMessage[]` | The structured per-message array for the buffered turn, in arrival order. |
| `contact` | `Contact?` | Resolved identity, when available. Populated by the [identity resolver](./identity-resolution.md) when `USER_LOOKUP_URL` is set; otherwise undefined. |
| `capabilities` | `ChannelFeature[]` | The responding adapter's `supports()` truth set, so the endpoint can tailor its `actions[]` to what the channel can actually do. |
| `context.windowOpen` | `boolean` | Whether the 24h customer-service window is currently open. |
| `context.windowExpiresAt` | `number?` | Unix ms the window closes, when known. |

`capabilities` is built by filtering every `ChannelFeature` through the adapter's
`supports()` (`capabilitiesOf` in
[`src/conversation/agent.ts`](../../src/conversation/agent.ts)). A WhatsApp turn,
for example, includes `template`; a Messenger/Instagram turn does not.

### Example request

```json
{
  "channel": "whatsapp",
  "conversationKey": "whatsapp:200000000000002:15557654321",
  "message": "hey\nare you open today?",
  "messages": [
    {
      "channel": "whatsapp",
      "channelMessageId": "wamid.ONE",
      "channelScopedUserId": "15557654321",
      "channelScopedBusinessId": "200000000000002",
      "type": "text",
      "text": "hey",
      "timestamp": 1716000200000
    },
    {
      "channel": "whatsapp",
      "channelMessageId": "wamid.TWO",
      "channelScopedUserId": "15557654321",
      "channelScopedBusinessId": "200000000000002",
      "type": "text",
      "text": "are you open today?",
      "timestamp": 1716000201000
    }
  ],
  "capabilities": ["typing_indicator", "read_receipt", "reaction", "reply_to", "template"],
  "context": { "windowOpen": true, "windowExpiresAt": 1716086601000 }
}
```

## The response

`ChatResponse` ([`src/chat/types.ts`](../../src/chat/types.ts)) has all fields
optional and supports four overlapping forms:

- `message?: string` — a single legacy text reply.
- `messages?: string[]` — a legacy array of text replies.
- `silence?: boolean` — an explicit "send nothing" turn.
- `actions?: ChatAction[]` — the rich form.

### The `ChatAction` union

| Type | Shape | Semantics |
| --- | --- | --- |
| `message` | `{ type: 'message', text }` | Send a plain text message. |
| `reply` | `{ type: 'reply', text, targetMessageId }` | Send `text` threaded as a reply to `targetMessageId` (a literal id OR a symbolic `TargetRef` — see [Symbolic reply/reaction targets](#symbolic-replyreaction-targets)). |
| `reaction` | `{ type: 'reaction', emoji, targetMessageId }` | React to `targetMessageId` with `emoji` (literal id OR `TargetRef`). |
| `typing` | `{ type: 'typing', durationMs? }` | Show a typing indicator. |
| `media` | `{ type: 'media', url, caption?, mimeType?, filename? }` | Send media at `url` (all three channels — see [Media send](./media.md)). |
| `template` | `{ type: 'template', name, language, components? }` | Send a WhatsApp template. WhatsApp-only. |
| `silence` | `{ type: 'silence' }` | A no-op signal — produces no outbound. |

`targetMessageId` on `reply` / `reaction` is typed `ChatActionTarget` =
`string | TargetRef`: either a literal channel message id (the backward-compatible
form) or a symbolic selector resolved against the turn's buffered inbound messages.

### Example `actions[]` response

```json
{
  "actions": [
    { "type": "reaction", "emoji": "👍", "targetMessageId": "wamid.TWO" },
    { "type": "reply", "text": "Yes — open until 6pm today.", "targetMessageId": "wamid.TWO" },
    { "type": "message", "text": "Anything I can help you find?" }
  ]
}
```

## Normalization

`normalizeChatResponse(payload)`
([`src/chat/contract.ts`](../../src/chat/contract.ts)) folds any response form
into a `NormalizedChatResponse` (`{ actions, silence?, warnings? }`) so the
delivery queue never has to know which form the endpoint used. The rules:

- **Non-object payload** (null, primitive, array) → throws `ChatEndpointError`.
- **Mixed silence + content** (`silence: true` alongside any
  `message`/`messages`/`actions` content) → the entire response is **dropped**
  (empty actions) with a `mixed-silence-actions` warning. Sending conflicting
  output is worse than sending nothing; the warning lets operators spot the buggy
  endpoint.
- **Explicit silence** (`silence: true`, no competing content) → `{ actions: [],
  silence: true }`, a deliberate no-reply turn.
- **Rich `actions[]` present and non-empty** → validated (see below). Rich actions
  take precedence over the legacy fields.
- **Legacy fields** → `message` (trimmed, non-empty) is emitted first as a
  `message` action, then each non-empty string in `messages[]`. This deterministic
  ordering mirrors the request shape (aggregate first, structured list after).
  Empty/whitespace strings are treated as "nothing to say", not errors.
- **Unknown shape** — none of `message` / `messages` / `actions` / `silence`
  present at all → throws `ChatEndpointError`. (An empty `actions: []` or
  `messages: []` is a recognized, if empty, shape and does NOT throw.)

### Action validation

When validating an `actions[]` array, each entry is checked against the union:

- A valid action passes through typed.
- A malformed or unknown-type action is **dropped** with an `invalid-action`
  warning (e.g. a `reply` missing `text` or `targetMessageId`, a `reaction`
  missing `emoji`, an unsupported `type`). Validation never throws — one bad
  action does not sink the rest.
- A lone surviving `{ type: 'silence' }` collapses the whole turn to explicit
  silence. A `silence` action sitting alongside real content is silently dropped
  (it is a no-op next to other output — no warning).

Warnings are non-fatal `ChatContractWarning`s. The HTTP client logs them at
`warn` but still returns the normalized actions.

### Defensive field aliasing

An LLM endpoint emits inconsistent JSON, so `validateAction` reads fields through a
permissive aliasing layer (`readAliasedString` / `readTarget`) that tolerates the
common drift before validating. It is permissive about INPUT spelling but always
emits the canonical `ChatAction` shape — downstream code never sees an alias:

| Canonical field | Accepted aliases |
| --- | --- |
| `text` (message / reply) | `content` |
| `url` (media) | `media_url` |
| `mimeType` (media) | `mime_type` |
| `targetMessageId` (reply / reaction) | `target_message_id` |

A `reaction` `emoji` of `""` is preserved verbatim (the documented "unreact"
signal). An unknown action **type** still produces an `invalid-action` warning
(never a throw). The sibling sendblue package's reaction emoji-synonym coercion
(heart→love etc.) was **deliberately NOT ported** — it is iMessage-Tapback-specific
and has no Meta meaning.

## Symbolic reply/reaction targets

An LLM chat endpoint almost never knows the literal channel message id (a WhatsApp
`wamid`, a Messenger `m_*`, an Instagram base64-ish id) verbatim, so `reply` /
`reaction` accept a symbolic `TargetRef` instead of (or alongside) a literal id.
`resolveTargetRef` ([`src/chat/target-resolver.ts`](../../src/chat/target-resolver.ts))
maps it against the turn's buffered inbound `IncomingMessage[]` (the natural target —
you react/reply to what the **user** said, oldest→newest) inside
`buildOutboundItems`:

| `TargetRef` variant | Resolves to |
| --- | --- |
| `{ alias: 'last' }` | the most recent inbound (also the **default** when no target is given) |
| `{ alias: 'first' }` | the oldest inbound |
| `{ alias: 'previous' }` | the second-most-recent inbound (needs ≥2 messages, else `not_found`) |
| `{ contentIncludes, occurrence? }` | substring match; `occurrence` (1-based) disambiguates >1 match; ambiguous (>1 match, no `occurrence`) is `not_found`/`ambiguous` |
| `{ content }` | exact (trim+lowercase) text match (first match wins) |
| `{ messageId }` | an explicit literal id — the escape-hatch form, equivalent to a bare string |

A bare string and `{ messageId }` pass through **without** consulting history (the
endpoint may legitimately know an id from a prior turn the buffer no longer holds;
the adapter is the authority on whether an id is sendable). Symbolic forms require
non-empty history.

On a resolution failure the behaviour matches the unsupported-feature handling: an
**unresolvable reaction is skipped** (with a note), while an **unresolvable reply is
downgraded to a plain message** (the text still matters to the user even when the
threading target can't be found). When `targetMessageId` is absent entirely it
defaults to `{ alias: 'last' }`.

## The HTTP client

`HttpChatClient.complete(request, signal?)`
([`src/chat/client.ts`](../../src/chat/client.ts)) POSTs the `ChatRequest` to
`CHAT_ENDPOINT_URL`, enforces a hard timeout via an `AbortController`
(`CHAT_ENDPOINT_TIMEOUT_MS`, default 30000), and returns an already-normalized
response. The optional external `signal` is combined with the internal timeout on
one controller (and short-circuits if already aborted): the agent passes its
per-conversation abort signal so a message arriving mid-flush can cancel the
in-flight chat call and rebatch both messages into one reply (see
[Conversation state](./conversation-state.md)). Every failure mode — non-2xx, network error, abort/timeout, JSON parse
error, malformed payload — surfaces as a single `ChatEndpointError`
([`src/chat/errors.ts`](../../src/chat/errors.ts)), with the original failure on
`cause` for wrapped cases. The agent therefore catches one type instead of
branching on transport vs. contract failures, and on any chat error it ends the
turn quietly (see [Conversation state](./conversation-state.md#fail-soft)).

## Actions to outbound items

`buildOutboundItems(actions, supports)`
([`src/delivery/queue.ts`](../../src/delivery/queue.ts)) maps the normalized
actions to `OutboundItem`s, gating on the adapter's capabilities. Each produced
item gets a fresh local `id` (`randomUUID`) for correlation, distinct from the
`channelMessageId` Meta returns after a send. Unsupported actions are returned in
a `skipped` list (for logging), not thrown:

| Action | If supported | If unsupported |
| --- | --- | --- |
| `message` | → `message` item | always supported |
| `reply` | → `reply` item (`reply_to`) — `targetMessageId` resolved via `resolveTargetRef` | **downgraded** to a plain `message` item (text still delivered; threading lost) when the channel lacks `reply_to` OR the target is unresolvable, recorded in `skipped` |
| `reaction` | → `reaction` item — `targetMessageId` resolved via `resolveTargetRef` | skipped with a reason (unsupported channel OR unresolvable target) |
| `typing` | → `typing` item | skipped (best-effort; no content lost) |
| `media` | → `media` item (`media_send`; the agent infers the kind from `mimeType` and routes via `sendMedia` — see [Media send](./media.md)) | skipped — only on a channel without `media_send` (all three support it since **Stage 7**) |
| `template` | → `template` item (`template`) | skipped — only WhatsApp `supports('template')` |
| `silence` | — | produces neither an item nor a skip note (pure no-op) |

The reply→message downgrade is deliberate: the text content still matters to the
user even when the channel can't thread the reply, so the body is delivered as a
plain message rather than silently dropped. Capability values come from the
per-channel `supports()` matrix — see
[Outbound clients](./outbound-clients.md) for the full matrix. How the resulting
queue is sent (ordering, channel-aware advancement) is
[Ordered delivery](./ordered-delivery.md).

## Testing

[`tests/unit/chat-contract.test.ts`](../../tests/unit/chat-contract.test.ts)
covers `normalizeChatResponse`: the four forms, legacy ordering,
mixed-silence drop, invalid-action drop, the lone-silence collapse, and the
unknown-shape throw.
[`tests/unit/chat-client.test.ts`](../../tests/unit/chat-client.test.ts)
covers `HttpChatClient` with an injected `fetchImpl`: success, non-2xx,
network/abort/parse failures all wrapping to `ChatEndpointError`, the timeout, and
warning logging. `buildOutboundItems` capability gating lives in
[`tests/unit/delivery-queue.test.ts`](../../tests/unit/delivery-queue.test.ts).

## Known limitations

- `context.windowOpen` is now enforced for WhatsApp via the closed-window template
  re-prompt (`context.requiresTemplate`); Messenger/Instagram have no out-of-window
  mechanism to enforce. See [Rate limiting](./rate-limiting.md).
- Symbolic targets resolve against the **buffered inbound turn only** — a `TargetRef`
  pointing at a message from a prior turn (no longer in the buffer) won't resolve;
  the endpoint must use a literal id for those.

See [Known gaps](../KNOWN-GAPS.md) and [Architecture](../ARCHITECTURE.md).
