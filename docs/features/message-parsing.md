# Message Parsing

## Purpose

The parser converts raw Meta webhook payloads from all three channels (WhatsApp Cloud API, Messenger Platform, Instagram Business Login) into a single normalized `IncomingMessage` / `StatusUpdate` shape. The conversation agent, status tracker, and outbound clients consume that shape directly so they never branch on `channel === 'whatsapp'` for routing concerns the parser can hide. A unified shape matters because the three raw payloads disagree on timestamp units (WhatsApp seconds vs. Messenger/IG milliseconds), echo direction, identity fields (`wa_id` / PSID / IGSID), and message-id formats (`wamid.*` / `m_*` / base64-ish) — folding those differences into a single discriminated union is the only way to keep downstream stages tractable.

The parser is a pure, side-effect-free function: `parseMetaWebhook(payload: unknown): ParseResult`. It is wired into the POST `/webhook` route via `dispatchWebhook` in [`src/http/app.ts`](../../src/http/app.ts), which emits structured logs per message and per status update after the 200 ACK has already been sent.

## The `IncomingMessage` shape

Defined in [`src/meta/types.ts`](../../src/meta/types.ts). Fields below are grouped by role.

### Identity

| Field | Type | Semantics |
| --- | --- | --- |
| `channel` | `'whatsapp' \| 'messenger' \| 'instagram'` | Source channel. The parser never emits `'unknown'` here — unknown discriminators produce an empty `ParseResult`. |
| `channelMessageId` | `string` | `wamid.*` for WhatsApp, `m_*` for Messenger, base64-ish for Instagram. Synthesized for events without a top-level id (reactions, referrals, postbacks without `mid`). |
| `channelScopedUserId` | `string` | Always the OTHER party (the user). For echoes, the raw `sender.id` is the business and `recipient.id` is the user — the parser unflips this. |
| `channelScopedBusinessId` | `string` | Always your side: `phone_number_id` (WA) / page id (Messenger) / IG user id. |

### Time

| Field | Type | Semantics |
| --- | --- | --- |
| `timestamp` | `number` | Unix **milliseconds**. WhatsApp's seconds-as-string form is upscaled at the parser boundary; Messenger/IG milliseconds pass through. See [Load-bearing rules](#load-bearing-rules) for the fallback policy. |

### Type discriminator

`type: MessageType` where `MessageType` is:

| Value | Produced by | Notes |
| --- | --- | --- |
| `'text'` | all channels | Free-form text body. |
| `'image'`, `'audio'`, `'video'`, `'document'`, `'sticker'` | all channels | Document/sticker semantics differ (see Media). |
| `'location'` | all channels (WA native; Messenger/IG via `attachments[].type === 'location'`) | WhatsApp surfaces `location.name` as `text` for display. |
| `'reaction'` | all channels | Targets a prior `channelMessageId` via `reaction.targetMessageId`. |
| `'interactive'` | WhatsApp only (button_reply / list_reply / nfm_reply) | Title is lifted into `text`; Flow responses also populate `flowResponse`. |
| `'postback'` | Messenger / Instagram / WhatsApp template button | WhatsApp template `button` events are normalized to `'postback'`. |
| `'referral'` | Messenger / Instagram standalone `referral` events | WhatsApp CTWA referrals attach to a message of any other type. |
| `'echo'` | Messenger / Instagram only | Business-sent message echoed back; `isEcho: true` is always set in parallel. |
| `'system'` | WhatsApp only | Group/number-change body lifted into `text`. |
| `'unknown'` | all channels | Unmodeled types, story mentions (see below), bare unmodeled messaging events. The dispatcher logs these at `warn`. |

Note: `'read'` is intentionally NOT in this union — read receipts produce a `StatusUpdate`, not an `IncomingMessage`.

### Content

| Field | Type | Semantics |
| --- | --- | --- |
| `text` | `string?` | Plain text body for `'text'`. Also populated from interactive titles (button/list reply), Flow `body`/`name`, WhatsApp location `name`, WhatsApp `system.body`. |
| `media` | `MediaInfo?` | Attached for image/audio/video/document/sticker. `id` (Meta media id, WA download key), `url` (Messenger/IG direct URL), `mimeType`, `sha256` (WA only), `caption`, `filename` (WA documents only), `voice` (WA audio only), `animated` (WA stickers only). |
| `reaction` | `ReactionInfo?` | `{ emoji, targetMessageId, action? }`. WhatsApp encodes an unreact as `emoji: ''` (not omitted) — preserved verbatim. |
| `postback` | `PostbackInfo?` | `{ payload, title? }`. WhatsApp template `button.payload` lands here too. |
| `referral` | `ReferralInfo?` | `{ source, type, ref?, ctwaClid?, sourceUrl?, sourceId?, headline?, body? }`. WA CTWA fields (`ctwaClid` onward) are channel-specific. Messenger/IG referrals populate only `source` / `type` / `ref`. |
| `replyTo` | `string?` | Channel-scoped id of the referenced message — WA `context.message_id`, Messenger/IG `reply_to.mid`. |
| `storyReply` | `StoryReplyInfo?` | Instagram-only. User replied to a story you posted; `id` is the story id, `url` is the preview. |
| `storyMention` | `StoryReplyInfo?` | Instagram-only. User mentioned the business in their story (an attachment with `type: 'story_mention'`). Distinct from `storyReply`. |

### Flags

| Field | Type | Semantics |
| --- | --- | --- |
| `isEcho` | `boolean?` | True iff this is a business-sent message echoed back (Messenger/IG only — WhatsApp does not emit echoes). |
| `forwarded` | `ForwardedInfo?` | WhatsApp-only. `{ forwarded, frequentlyForwarded? }` pulled from `context.forwarded` / `context.frequently_forwarded`. |
| `flowResponse` | `FlowResponseInfo?` | WhatsApp-only. Set when `interactive.type === 'nfm_reply'`. `responseJson` is the verbatim form-submission JSON string (the parser does not pre-parse it). |

### Debug

| Field | Type | Semantics |
| --- | --- | --- |
| `raw` | `unknown` | The per-event raw payload (e.g. `messages[i]` for WhatsApp or the `messaging[]` entry for Messenger/IG). **Not** the full webhook envelope. For downstream debugging and observability only. |

## The `StatusUpdate` shape

Also defined in [`src/meta/types.ts`](../../src/meta/types.ts). Produced for outbound delivery state changes.

| Field | Type | Semantics |
| --- | --- | --- |
| `channel` | `Channel` | Source channel. |
| `channelMessageId` | `string` | Channel id of the OUTBOUND message this status refers to. For Messenger/IG read events without an explicit `mid`, this is the stringified watermark — the [status tracker](./status-tracking.md) sweeps all outbound with `timestamp <= watermark`. |
| `channelScopedUserId` | `string?` | The user side. WhatsApp provides this; Messenger/IG derive it from `messaging[].sender.id` on read/delivery events. |
| `channelScopedBusinessId` | `string` | Your side. |
| `status` | `'sent' \| 'delivered' \| 'read' \| 'failed'` | Cross-channel delivery enum. WhatsApp produces all four; Messenger emits `'delivered'` and `'read'`; Instagram emits only `'read'`. |
| `timestamp` | `number` | Unix **milliseconds**. For Messenger delivery events, this is the delivery watermark (preferred over the event timestamp). |
| `errorCode` | `number?` | WhatsApp-only. Top error code on `'failed'`. |
| `errorTitle` | `string?` | WhatsApp-only. Short error title. |
| `raw` | `unknown` | Per-status raw payload. |

## Per-channel parsing notes

### WhatsApp (`object: 'whatsapp_business_account'`)

- **Raw outer shape**: `entry[].changes[].value.{metadata, messages?, statuses?, contacts?, errors?}`. The parser walks each entry/change pair, validates `metadata.phone_number_id` (required — entries without it are dropped), and processes `messages[]` and `statuses[]` independently.
- **User vs. business id**: `messages[i].from` is the user `wa_id`; `metadata.phone_number_id` is the business id. WhatsApp does not emit echoes, so no direction flip is needed.
- **Mapped message types**: `text`, `image`, `audio`, `video`, `document`, `sticker`, `location`, `reaction`, `interactive` (`button_reply` / `list_reply` / `nfm_reply`), `button` (template button — normalized to `'postback'`), `system`. Anything else (`contacts`, future variants) falls through to `'unknown'`.
- **Channel-specific surface**:
  - **CTWA referrals**: `messages[i].referral` (sibling of, not nested under, `context`) carries the Click-to-WhatsApp ad attribution. The parser builds a `ReferralInfo` with `type: 'click_to_whatsapp'`, surfacing `source_type` → `source`, `ctwa_clid` → both `ref` and `ctwaClid`, and the ad's `source_url` / `source_id` / `headline` / `body`. Dropping this would permanently lose the ad → conversation linkage.
  - **Flow responses (`interactive.type === 'nfm_reply'`)**: `response_json` is preserved verbatim on `flowResponse.responseJson`. Downstream parses it lazily against its own flow schema.
  - **System messages**: `messages[i].system.body` is lifted onto `text` and `type: 'system'`.
  - **Template button replies**: `messages[i].button.payload` becomes `postback.payload`; `button.text` becomes `postback.title`. `type` is `'postback'`, not `'button'`, so it shares the cross-channel postback surface.
  - **Status events**: `statuses[].status` is allowlisted to `'sent' | 'delivered' | 'read' | 'failed'`; anything else is dropped. The first `errors[]` element (if any) populates `errorCode` and `errorTitle`.
  - **Forwarded flags**: `context.forwarded` / `context.frequently_forwarded` surface on `forwarded` as a spam / misinformation signal.

### Messenger (`object: 'page'`)

- **Raw outer shape**: `entry[].messaging[].{sender, recipient, timestamp, message?, postback?, referral?, reaction?, read?, delivery?, ...}`. The parser dispatches per event by checking each field in order: `message` → `postback` → `referral` → `reaction` → `read` → `delivery` → fallback `'unknown'`.
- **User vs. business id**: For inbound, `sender.id` is the user PSID and `recipient.id` is the page id. For `is_echo: true` messages, Meta inverts the direction (business sent the message), so the parser flips them: `channelScopedUserId = recipient.id`, `channelScopedBusinessId = sender.id`. Read events are user→business by definition and are NOT direction-flipped.
- **Mapped message types**: `text` (default), attachments mapped via `mapFbAttachmentType` (`image` → `image`, `audio` → `audio`, `video` → `video`, `file` → `document`, `location` → `location`). Unmapped attachment types (`fallback`, `template`, future variants) fall back to `'unknown'` when there's no `text` to anchor the message.
- **Channel-specific surface**:
  - **Postbacks**: `payload` is required (events without it are dropped). `mid` becomes `channelMessageId` when present; otherwise the parser synthesizes ``${recipientId}-${timestamp}-postback``. Postbacks can carry an embedded `referral` block (e.g. Get Started from an m.me link with `ref`) — that's promoted to the top-level `referral` field.
  - **Referrals**: Standalone `referral` events (no `message` block). Require both `source` and `type`. The channel id is synthesized as ``${recipientId}-${timestamp}-referral``.
  - **Reactions**: Synthetic id is ``${senderId}-${targetMessageId}-${action}`` — see [Load-bearing rules](#load-bearing-rules) for the no-timestamp rationale.
  - **Delivery fan-out**: `delivery.mids[]` produces ONE `StatusUpdate` per mid (status `'delivered'`), with the delivery `watermark` (when present) preferred over the event timestamp.
  - **Read watermark**: `read.watermark` is stringified into `channelMessageId`; downstream sweeps any outbound at `timestamp <= watermark` and marks `'read'`.
  - **Unknown events**: A monotonic counter scoped to the current `parseFbStylePayload` call disambiguates bursty opt-in / handover events that share a timestamp — without this they would collapse to a single record under per-payload dedupe.

### Instagram (`object: 'instagram'`)

- **Raw outer shape**: Identical to Messenger (`entry[].messaging[]`). Shares `parseFbStylePayload` with Messenger, channel-tagged via the second argument.
- **User vs. business id**: `sender.id` is the user IGSID; `recipient.id` is the business IG user id. Echo direction-flip applies identically to Messenger.
- **Mapped message types**: Same attachment mapping as Messenger. Story mentions are an exception — see below.
- **Channel-specific surface**:
  - **Story replies**: `message.reply_to.story` (with `id` / `url`) populates `storyReply`. The user replied to a story the business posted.
  - **Story mentions**: An attachment with `type: 'story_mention'` populates `storyMention` (with `id` set to the message `mid` and `url` from the attachment payload). The user mentioned the business in their own story. `type` is forced to `'unknown'` to make sure the conversation agent treats it as a structured side-channel event rather than a regular DM. Distinct from `storyReply`.
  - **No delivery webhooks**: Instagram does not emit `delivery` events in the Messenger shape. Read receipts use `read.mid` (the specific message id seen) on `messaging_seen` events, falling back to a stringified watermark in the same way.
  - **GIFs and stickers**: Per Meta's docs, these do NOT fire webhooks at all. There is nothing to parse and the parser tolerates the absence silently.

## Load-bearing rules

- **The parser is non-throwing.** Every public entry point (`parseMetaWebhook`, `parseWhatsAppWebhook`, `parseMessengerWebhook`, `parseInstagramWebhook`) returns a `ParseResult` even for malformed, null, undefined, primitive, or array inputs. Throwing would corrupt the dead-letter-queue contract: Meta retries non-2xx for 7 days then permanently drops, so a thrown parser bug would either crash the handler or get swallowed and lose data. The dispatcher wraps the call in a defensive `try`/`catch` as a belt-and-suspenders safety net (see [Inbound webhooks](./inbound-webhooks.md)).
- **Echo direction-flip.** For `is_echo: true` messages on Messenger and Instagram, raw `sender.id` is the BUSINESS and `recipient.id` is the USER. The parser unflips this so `channelScopedUserId` is ALWAYS the user side. Downstream code keys on `channelScopedUserId` for conversation routing, identity resolution, and dedupe — this rule is load-bearing.
- **Timestamp normalization.** All timestamps land as Unix milliseconds. WhatsApp's seconds-as-string is parsed and upscaled (`* 1000` for values below 1e12). If the timestamp is missing or unparseable, the parser falls back to `Date.now()` rather than dropping the message — losing a parseable message because of a bad timestamp is worse than logging the moment we received it, since Meta will not retry a 200-ACKed delivery.
- **Per-payload dedupe.** Both `messages` and `statuses` are deduped in-place by `channelMessageId`, preserving first occurrence. This handles Meta's observed habit of batching identical message blocks across `entry[]` items within a single delivery. **Cross-payload dedupe** (across redelivery) is the conversation agent's responsibility.
- **Reaction synthetic id is `${senderId}-${targetMessageId}-${action}` with no timestamp.** Meta retries non-2xx for 7 days, and batched events sometimes carry slightly-different timestamps for the same logical reaction. A stable id collapses identical reaction events across per-payload retries. Postback / referral synthetic ids deliberately keep the timestamp because they have meaningful single-payload uniqueness already.
- **Unknown-event counter for Messenger/IG.** A monotonic counter scoped to a single `parseFbStylePayload` call prevents bursty opt-in / handover events at the same millisecond from collapsing to one record under dedupe. Postback / referral ids do not use the counter — they have other discriminators.
- **`raw` is per-event, not the whole webhook.** Each `IncomingMessage.raw` is the per-message slice (e.g. `messages[i]` for WhatsApp or the `messaging[]` entry for Messenger/IG); each `StatusUpdate.raw` is the per-status slice. Keeping the slice small bounds memory and avoids leaking unrelated events into observability logs.

## What's intentionally NOT in scope yet

- **WhatsApp `statuses[].conversation` / `pricing` blocks** are preserved on `raw` but not extracted. Pulling `conversation.expiration_timestamp` and `pricing.category` (for messaging-window awareness and billing observability) is deferred to Stage 10 — see [Known gaps](../KNOWN-GAPS.md).
- **Order, contact-card, reel, and template-fallback attachments** are surfaced as `'unknown'`. First-class normalized variants are deferred (revisit when real captures surface `reel` / `payment` / order shapes worth modeling) — see [Known gaps](../KNOWN-GAPS.md).
- **Cross-payload dedupe** is the conversation agent's job. The parser only dedupes within a single delivery.
- **Page-linked Instagram routing** is unsupported. This package targets the Instagram Business Login path (`object: 'instagram'`) only.
- **Real-payload validation.** Most fixtures are still documentation-derived; `npm run capture:guided` (and the `setup:<channel>` scripts) have promoted a handful of redacted live captures (exercised by `tests/unit/parser-captured.test.ts`), with more still to capture — live payloads often surface drift the parser will need to absorb. See [Payload capture](./payload-capture.md) and [Known gaps](../KNOWN-GAPS.md).

## Code references

- [`src/meta/types.ts`](../../src/meta/types.ts) — raw + normalized type declarations.
- [`src/meta/parser.ts`](../../src/meta/parser.ts) — `parseMetaWebhook` plus per-channel parsers, narrowing helpers, and `dedupeById`.
- [`src/http/app.ts`](../../src/http/app.ts) — `dispatchWebhook` integration, per-message and per-status logging.
- [`tests/unit/parser.test.ts`](../../tests/unit/parser.test.ts) — parser tests covering all three channels.
- [`tests/integration/webhook-routing.test.ts`](../../tests/integration/webhook-routing.test.ts) — full Express pipeline including the dispatcher's defensive catch.

See [Inbound webhooks](./inbound-webhooks.md) for the route-level wiring and [Architecture](../ARCHITECTURE.md) for the downstream consumers.
