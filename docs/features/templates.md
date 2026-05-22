# WhatsApp message templates

WhatsApp message templates are pre-approved messages — the only way to message a
user **outside** the 24-hour customer-service window. Templates are
**WhatsApp-only**: `supports('template')` is `true` only for the WhatsApp client
(Messenger's own message templates are a different feature out of scope here, and
Instagram has no template messaging — see the
[capability matrix](./outbound-clients.md#the-supports-capability-matrix)).

The send method (`WhatsAppClient.sendTemplate`) landed in Stage 4; Stage 7 added
the `buildTemplateComponents` builder that assembles the `components` array the
send method forwards, plus the `textParameter` / `payloadParameter` convenience
helpers.

## `WhatsAppClient.sendTemplate`

[`src/meta/whatsapp/client.ts`](../../src/meta/whatsapp/client.ts):

```typescript
sendTemplate(
  to: string,
  templateName: string,
  languageCode: string,
  components?: TemplateComponent[]
): Promise<SendResult>
```

It POSTs `{phoneNumberId}/messages` with:

```json
{
  "messaging_product": "whatsapp",
  "to": "<recipient>",
  "type": "template",
  "template": {
    "name": "<templateName>",
    "language": { "code": "<languageCode>" },
    "components": [ /* ... when supplied ... */ ]
  }
}
```

`components` is forwarded **verbatim** when supplied and **omitted entirely**
otherwise (a template with no variables takes no components). The client does not
know how to build the components array — that is the builder's job below.

The chat endpoint can request a template via a `{ type: 'template' }` action
(`{ name, language, components? }`); `buildOutboundItems` gates it on
`supports('template')` and forwards `components` to `sendTemplate` through the
delivery queue. See [Rich chat actions](./rich-chat-actions.md).

## `buildTemplateComponents`

[`src/meta/whatsapp/templates.ts`](../../src/meta/whatsapp/templates.ts) is a
pure, I/O-free, transport-agnostic builder. Its output is exactly the
`components` array `sendTemplate` accepts:

```typescript
buildTemplateComponents({
  headerParameters?: TemplateParameter[];
  bodyParameters?: TemplateParameter[];
  buttonParameters?: ButtonComponentInput[];
}): TemplateComponent[]
```

- **Header** — emitted only when `headerParameters` is supplied **and non-empty**
  → `{ type: 'header', parameters }`.
- **Body** — emitted only when `bodyParameters` is supplied **and non-empty** →
  `{ type: 'body', parameters }`.
- **Buttons** — one `{ type: 'button', sub_type, index, parameters }` component
  per `buttonParameters` entry **whose `parameters` is non-empty**.

Sections are omitted when absent (header/body) or when the list is empty
(buttons), so `buildTemplateComponents({})` returns `[]`. Order follows Meta's
documented layout: header, then body, then buttons. An **empty** `parameters: []`
for any section is treated as a clean no-op (the section is skipped, not emitted):
Meta rejects a template component carrying an empty `parameters` array with a 400
at send time, so skipping it locally is the safe behavior.

### Component / sub_type / index shape

`TemplateComponent` ([`src/meta/shared/adapter.ts`](../../src/meta/shared/adapter.ts)):

| Field | Applies to | Meaning |
| --- | --- | --- |
| `type` | all | `'header' \| 'body' \| 'button'` (extra kinds tolerated). |
| `parameters` | all | The per-component substitution values. |
| `sub_type` | button only | Which button kind this targets (`'quick_reply' \| 'url'`). |
| `index` | button only | The button position, **0-based**. |

Header and body are singletons; a dynamic button is keyed by its **kind**
(`sub_type`) and its **0-based position** (`index`), which is why each button is
its own component carrying both.

`TemplateComponent` / `TemplateParameter` live in the shared transport-contract
module (`src/meta/shared/adapter.ts`), not the WhatsApp client, so type-only
consumers (the chat contract, the delivery queue) can reference them without
importing the concrete client. The WhatsApp client re-exports both for backward
compatibility. They are kept **structural** (extra fields pass through), not a
faithful copy of Meta's full template schema — the agent only forwards the
caller-supplied components verbatim.

## Parameter helpers and the button-kind distinction

Two convenience builders for the common case
([`src/meta/whatsapp/templates.ts`](../../src/meta/whatsapp/templates.ts)):

- `textParameter(text)` → `{ type: 'text', text }`
- `payloadParameter(payload)` → `{ type: 'payload', payload }`

**The button parameter kind differs by `sub_type`, and it is the caller's
responsibility** — `buildTemplateComponents` does **not** infer or coerce the
parameter shape from `subType`, it forwards `button.parameters` verbatim:

| Button `sub_type` | Parameter kind | Helper |
| --- | --- | --- |
| `quick_reply` | `{ type: 'payload', payload }` | `payloadParameter` |
| `url` | `{ type: 'text', text }` | `textParameter` |

Supply the matching kind per button or Meta will reject the send. Example:

```typescript
const components = buildTemplateComponents({
  bodyParameters: [textParameter('Ada'), textParameter('Order #42')],
  buttonParameters: [
    { subType: 'quick_reply', index: 0, parameters: [payloadParameter('CONFIRM')] },
    { subType: 'url',         index: 1, parameters: [textParameter('track-123')] }
  ]
});
await wa.sendTemplate('15551234567', 'order_update', 'en_US', components);
```

Non-text parameters (currency / date_time / image / document / video) are already
valid `TemplateParameter`s and pass through the builder untouched — there is no
convenience helper for them, but they need none.

## Templates and the out-of-window mechanism

Templates are the **out-of-window mechanism** for WhatsApp: outside the 24-hour
customer-service window, only a pre-approved template can be sent. Stage 7 shipped
the send method and the component builder, and the chat request carries
`context.windowOpen` (and `context.windowExpiresAt` when known) so the endpoint can
*choose* a template when the window is closed.

**Out-of-window enforcement landed for WhatsApp in Stage 10.** When a WhatsApp send
fails with the 24h re-engagement error (`131047` / `470`), the agent re-prompts the
chat endpoint **once per turn** with `context.requiresTemplate: true` and
`windowOpen: false`, then replaces the outbound queue with whatever the endpoint
returns (`handleWindowClosed`). It is fail-soft — any failure skips and advances.
Messenger and Instagram have **no** reliable out-of-window mechanism for an
automated bot. See [Rate limiting](./rate-limiting.md),
[Known gaps](../KNOWN-GAPS.md), and [Conversation state](./conversation-state.md).

## Code references

Source:

- [`src/meta/whatsapp/templates.ts`](../../src/meta/whatsapp/templates.ts) — `buildTemplateComponents`, `textParameter`, `payloadParameter`, `ButtonComponentInput`.
- [`src/meta/whatsapp/client.ts`](../../src/meta/whatsapp/client.ts) — `sendTemplate`.
- [`src/meta/shared/adapter.ts`](../../src/meta/shared/adapter.ts) — `TemplateComponent` / `TemplateParameter` (the canonical location; the WhatsApp client re-exports them).
- [`src/chat/types.ts`](../../src/chat/types.ts) — the `template` `ChatAction`.
- [`src/delivery/queue.ts`](../../src/delivery/queue.ts) — `buildOutboundItems` template branch (capability-gated, components forwarded verbatim).

Tests (see [Testing](../TESTING.md)):

- [`tests/unit/whatsapp-templates.test.ts`](../../tests/unit/whatsapp-templates.test.ts) — `textParameter` / `payloadParameter`, the header/body/button component shapes and order, the `[]`-for-empty-input case, the empty-section preservation, currency passthrough.
- [`tests/unit/whatsapp-client.test.ts`](../../tests/unit/whatsapp-client.test.ts) — the exact `sendTemplate` request body (components forwarded vs. omitted).
- [`tests/unit/delivery-queue.test.ts`](../../tests/unit/delivery-queue.test.ts) — the template action is WhatsApp-only (skipped where `supports('template')` is false).

Related: [Outbound clients](./outbound-clients.md) · [Media send](./media.md) · [Rich chat actions](./rich-chat-actions.md) · [Conversation state](./conversation-state.md).
