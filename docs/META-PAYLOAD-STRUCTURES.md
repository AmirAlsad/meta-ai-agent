# Observed Meta Webhook Payload Structures

This file documents real Meta webhook payload shapes observed during live capture, populated incrementally as `npm run capture:guided` / `npm run setup:*` sessions surface them. Every entry below maps to a redacted fixture committed under `tests/fixtures/meta/{channel}/captured/` and is exercised by `tests/unit/parser-captured.test.ts`.

Today's `tests/fixtures/meta/{whatsapp,messenger,instagram}/*.json` (non-`captured/`) payloads are documentation-derived starter fixtures; they reflect Meta's published webhook shapes but have not all been validated against live traffic. Real payloads frequently include extra fields, slight field-name variations, and undocumented additions. Promote real captures into `tests/fixtures/meta/{channel}/captured/` only after manual redaction (phone numbers, IGSIDs, PSIDs, profile names, tokens, tunnel URLs, message content).

## WhatsApp (`object: "whatsapp_business_account"`)

### Verified shapes (captured 2026-05-19)

- **Outbound status — `status: "sent"`** — `tests/fixtures/meta/whatsapp/captured/outbound-status-sent.json`
- **Inbound text** — `tests/fixtures/meta/whatsapp/captured/inbound-text.json`
- **Inbound reaction** — `tests/fixtures/meta/whatsapp/captured/inbound-reaction.json`

### Real-world fields observed that our parser does NOT currently extract

The first round of captures surfaced several fields Meta sends that aren't yet surfaced on `IncomingMessage` / `StatusUpdate`. They are preserved on `raw` for downstream consumers but listed here so Stage 4+ work can prioritize:

| Field path | Type | Notes |
|---|---|---|
| `entry[].id` | string | The **WABA id** (NOT the phone_number_id). Our parser correctly uses `metadata.phone_number_id` for the business id; this is informational. |
| `value.contacts[].user_id` | string `US.*` | A new Meta-internal user identifier prefixed `US.`, distinct from `wa_id` (E.164). Persistent across phone-number changes. Likely useful for Stage 5 contact tracking. |
| `value.contacts[].profile.name` | string | The user's WhatsApp profile name. PII — handle carefully in logs. Useful for Stage 6 identity enrichment. |
| `value.messages[].from_user_id` | string `US.*` | Same `US.*` identifier on the message itself; redundant with `contacts[].user_id` but per-message. |
| `value.statuses[].recipient_user_id` | string `US.*` | Same `US.*` identifier on outbound status callbacks. |
| `value.statuses[].pricing` | object | The new PMP (Per-Message Pricing) block — `{ billable, pricing_model: "PMP", category: "utility" \| "marketing" \| "authentication" \| "service", type: "regular" }`. Replaces the older conversation-pricing block in 2025. Load-bearing for Stage 4 messaging-window tracking and cost accounting. |
| `value.statuses[].conversation` (not yet observed) | object | Reserved for future window-tracking work — Stage 4. |

### Pricing model note

The `pricing.pricing_model: "PMP"` is the per-message pricing model that replaced the 24-hour conversation-pricing window on July 1, 2025. Stage 4's messaging-window tracker will need to consume `pricing.category` to classify outbound traffic.

### Still TODO (need capture)

- [ ] Inbound image, audio, video, document, sticker
- [ ] Inbound location
- [ ] Inbound reply — `messages[].context.message_id` referencing prior `wamid.*`
- [ ] Inbound interactive (button reply, list reply, nfm_reply)
- [ ] Status callback: `status: "delivered"`, `"read"`, `"failed"` with errors
- [ ] Click-to-WhatsApp ad inbound (`messages[].referral`)
- [ ] Errors envelope (`messages[].errors[]` or top-level `errors[]`)
- [ ] Template button reply (`messages[].type === "button"`)
- [ ] System messages (`messages[].type === "system"`)

## Messenger (`object: "page"`)

### Verified shapes (captured 2026-05-19)

- **Inbound text DM** — `tests/fixtures/meta/messenger/captured/inbound-text.json`
- **Inbound reaction** — `tests/fixtures/meta/messenger/captured/inbound-reaction.json`

For Messenger, `entry[].id` and `messaging[].recipient.id` are both the **Page id**; `messaging[].sender.id` is the user's **PSID**. Timestamps (`entry[].time`, `messaging[].timestamp`) are **milliseconds** (unlike WhatsApp's seconds) — the parser keeps them as-is.

### Real-world fields observed that our parser does NOT currently extract

| Field path | Type | Notes |
|---|---|---|
| `messaging[].reaction.reaction` | string | The **named reaction** ("laugh", "love", "wow", etc.) sent alongside `reaction.emoji` (😆). Our documentation-derived `reaction.json` fixture lacked this; the parser surfaces `emoji`/`action`/`targetMessageId` as first-class fields and keeps the named string on `raw`. A future `reaction.name` field on `ReactionInfo` could surface it if a consumer needs it. |

### Still TODO (need capture)

- [ ] Inbound attachment — `messaging[].message.attachments[]`
- [ ] Echo of business-sent text — `messaging[].message.is_echo === true` (we confirmed echoes arrive — the `setup:messenger` echo-confirm step relies on them — but haven't promoted a redacted fixture yet)
- [ ] Postback — `messaging[].postback.title` + `messaging[].postback.payload`
- [ ] Quick reply tap — `messaging[].message.quick_reply.payload`
- [ ] Read receipt — `messaging[].read.watermark` (timestamp-based)
- [ ] Delivery callback — `messaging[].delivery.mids[]`
- [ ] `unreact` reaction — `messaging[].reaction.action === 'unreact'` (only `react` captured so far)
- [ ] Referral (m.me link click) — `messaging[].referral.ref`
- [ ] Reply-to — `messaging[].message.reply_to.mid` referencing prior `mid.*`

## Instagram (`object: "instagram"`)

### Verified shapes (captured 2026-05-20)

- **Inbound text DM** — `tests/fixtures/meta/instagram/captured/inbound-text.json`
- **Inbound reaction** — `tests/fixtures/meta/instagram/captured/inbound-reaction.json`

Instagram reuses the FB-style messaging envelope (`entry[].messaging[]` with `sender` / `recipient` / `message` | `reaction`), but the identities differ from Messenger: `entry[].id` and `messaging[].recipient.id` are both the **17-digit IG business-user id** (e.g. captured as `17841…`, redacted to `17000000000000001`) — there is **no page id** in the IG path. `messaging[].sender.id` is the user's **IGSID**. Timestamps (`entry[].time`, `messaging[].timestamp`) are **milliseconds** like Messenger — the parser keeps them as-is.

The IG message/reaction **`mid` is a long base64-ish string prefixed `aWdf…`** — a noticeably different shape from Messenger's `m_…` mids. The parser passes it straight through as `channelMessageId` for messages; reactions have no top-level mid, so the parser synthesizes `${senderId}-${reaction.mid}-${action}` (the `reaction.mid` is the **target** message id) and exposes the target on `reaction.targetMessageId`.

### Real-world fields observed that our parser does NOT currently extract

| Field path | Type | Notes |
|---|---|---|
| `messaging[].reaction.reaction` | string | The **named reaction** string sent alongside `reaction.emoji` and `reaction.action`. Captured value was `"other"` for a ❤ react (the named-reaction vocabulary differs from Messenger's — Messenger sent `"laugh"` for 😆; IG's `-1` capture also showed `"laugh"` for 😂, but ❤ maps to the catch-all `"other"`). Our documentation-derived IG `reaction.json` fixture lacked this field. Same handling as Messenger: the parser surfaces `emoji`/`action`/`targetMessageId` as first-class fields and keeps the named string on `raw`. |

### Still TODO (need capture)

- [ ] Inbound attachment (image/audio/video — note: no document support)
- [ ] Echo of business-sent text — `messaging[].message.is_echo === true`
- [ ] Story reply — `messaging[].message.reply_to.story` (url, id)
- [ ] Story mention — `messaging[].message.attachments[].type === 'story_mention'`
- [ ] `unreact` reaction — `messaging[].reaction.action === 'unreact'` (only `react` captured so far)
- [ ] Read (seen) — `messaging[].read.watermark` or `read.mid`
- [ ] Referral (ig.me link click) — `messaging[].referral.ref`
- [ ] Postback (from Ice Breaker or button) — `messaging[].postback.payload`

For each captured payload, document the **timestamp unit** (WhatsApp: seconds; Messenger/Instagram: milliseconds), any **`is_echo` flag** that must be filtered, and any **non-obvious field name** that differs from Meta's published examples.

## Capture and promotion workflow

```bash
# Either of these writes to .captures/meta/{channel}/ (gitignored)
npm run setup:whatsapp        # walks through verification AND captures key payloads
npm run setup:messenger
npm run setup:instagram
npm run capture:guided        # scenario walker for additional shapes
npm run capture:fixtures      # passive long-running capture
```

After capture:

1. Inspect `.captures/meta/{channel}/*.json` for PII (phone numbers, names, IDs, tokens, tunnel URLs, message content).
2. Manually redact — see `tests/fixtures/meta/whatsapp/captured/` for the redaction convention (555-prefixed test phones, `US.0000000000000001`-style placeholder IDs, shape-preserving wamid placeholders, generic profile names).
3. Strip the capture wrapper down to the raw `rawBody` payload — that's the fixture style under `tests/fixtures/`.
4. Promote to `tests/fixtures/meta/{channel}/captured/<descriptive-name>.json`.
5. Add an assertion in `tests/unit/parser-captured.test.ts` that loads the new fixture and locks in parser behavior.
6. Update the "Verified shapes" list above with the new entry.

See [Testing](./TESTING.md) and [Payload capture](./features/payload-capture.md) for more.
