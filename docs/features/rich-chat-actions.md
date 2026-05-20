# Rich chat actions (Stage 5)

The chat contract is the boundary between this transport package and the
developer's AI logic. The agent POSTs a `ChatRequest` describing one buffered
inbound turn to `CHAT_ENDPOINT_URL`; the endpoint replies with either the legacy
`message` / `messages` / `silence` form or a rich `actions[]` array. A normalizer
collapses every shape into one ordered `ChatAction[]`, which the delivery layer
turns into outbound items.

Source: [`src/chat/types.ts`](../../src/chat/types.ts) (shapes),
[`src/chat/contract.ts`](../../src/chat/contract.ts) (`normalizeChatResponse`),
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
| `contact` | `Contact?` | Resolved identity, when available. Undefined in Stage 5 (no identity resolver yet). |
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
| `reply` | `{ type: 'reply', text, targetMessageId }` | Send `text` threaded as a reply to `targetMessageId`. |
| `reaction` | `{ type: 'reaction', emoji, targetMessageId }` | React to `targetMessageId` with `emoji`. |
| `typing` | `{ type: 'typing', durationMs? }` | Show a typing indicator. |
| `media` | `{ type: 'media', url, caption?, mimeType? }` | Send media at `url`. Skipped until Stage 7. |
| `template` | `{ type: 'template', name, language, components? }` | Send a WhatsApp template. WhatsApp-only. |
| `silence` | `{ type: 'silence' }` | A no-op signal — produces no outbound. |

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

## The HTTP client

`HttpChatClient.complete(request)`
([`src/chat/client.ts`](../../src/chat/client.ts)) POSTs the `ChatRequest` to
`CHAT_ENDPOINT_URL`, enforces a hard timeout via an `AbortController`
(`CHAT_ENDPOINT_TIMEOUT_MS`, default 30000), and returns an already-normalized
response. Every failure mode — non-2xx, network error, abort/timeout, JSON parse
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
| `reply` | → `reply` item (`reply_to`) | **downgraded** to a plain `message` item (text still delivered; threading lost), recorded in `skipped` |
| `reaction` | → `reaction` item | skipped with a reason |
| `typing` | → `typing` item | skipped (best-effort; no content lost) |
| `media` | → `media` item (`media_send`) | skipped — `media_send` is `false` everywhere until **Stage 7** |
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
(30 tests) covers `normalizeChatResponse`: the four forms, legacy ordering,
mixed-silence drop, invalid-action drop, the lone-silence collapse, and the
unknown-shape throw.
[`tests/unit/chat-client.test.ts`](../../tests/unit/chat-client.test.ts)
(10 tests) covers `HttpChatClient` with an injected `fetchImpl`: success, non-2xx,
network/abort/parse failures all wrapping to `ChatEndpointError`, the timeout, and
warning logging. `buildOutboundItems` capability gating lives in
[`tests/unit/delivery-queue.test.ts`](../../tests/unit/delivery-queue.test.ts).

## Known limitations

- `contact` is always undefined — no identity resolver yet (Stage 6).
- `media` actions are skipped (Stage 7).
- `context.windowOpen` is reported but not enforced (Stage 10).

See [Known gaps](../KNOWN-GAPS.md) and [Architecture](../ARCHITECTURE.md).
