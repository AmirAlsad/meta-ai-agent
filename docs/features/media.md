# Media send, upload & download

Outbound media works across all three channels behind a single uniform
`ChannelAdapter.sendMedia`, plus WhatsApp media upload/download utilities and the
download helper for Messenger/Instagram attachment URLs. The chat endpoint asks
for a media send with a `{ type: 'media' }` action; the conversation agent infers
the send-kind from the MIME type and dispatches it to the right per-channel send
method **without any channel branching**.

This is the outbound counterpart to inbound media parsing (the parser already
normalizes inbound `image` / `audio` / `video` / `document` / `sticker` blocks —
see [Message parsing](./message-parsing.md)). It builds directly on the Stage 4
[outbound clients](./outbound-clients.md) and the shared
[`GraphClient`](./outbound-clients.md#the-shared-graphclient).

## The `media` chat action

The chat endpoint returns a media action in its `actions[]`
([`src/chat/types.ts`](../../src/chat/types.ts)):

```typescript
{ type: 'media'; url: string; caption?: string; mimeType?: string; filename?: string }
```

| Field | Required | Meaning |
| --- | --- | --- |
| `url` | Yes | Public URL of the asset (every channel fetches it). For WhatsApp it may instead be a pre-uploaded `media_id` (see [WhatsApp id-vs-URL](#whatsapp--id-or-url)). |
| `caption` | No | Caption shown with the media. WhatsApp applies it to image/video/document; **WhatsApp audio drops it**; Messenger/Instagram URL attachments carry no caption (see the [body-shape table](#per-channel-send-methods--body-shapes)). |
| `mimeType` | No | MIME type used to infer the send-kind (`inferMediaKind`). **Supply it** — without it the kind defaults to `document` (see [Supply mimeType](#supply-a-mimetype)). |
| `filename` | No | Document filename the recipient sees (used by `kind: 'document'`). WhatsApp derives one from the URL basename when absent. |

`buildOutboundItems` ([`src/delivery/queue.ts`](../../src/delivery/queue.ts))
gates a media action on `supports('media_send')` and maps it to an
`OutboundItem{ kind: 'media', mediaUrl, mediaCaption, mediaMimeType, mediaFilename }`.
All three channels advertise `media_send` (see the
[capability matrix](./outbound-clients.md#the-supports-capability-matrix)), so a
media action is never skipped at this layer for a configured channel; a channel
that does not support media records a `media_send unsupported on this channel`
skip note instead.

## How it flows to `sendMedia`

In `ConversationAgent.sendNext` ([`src/conversation/agent.ts`](../../src/conversation/agent.ts))
the `media` case:

1. Guards against a missing `mediaUrl` (defensive — `buildOutboundItems` always
   sets it; a malformed item is skipped rather than sent with an empty reference).
2. Infers the send-kind: `const kind = inferMediaKind(item.mediaMimeType)`.
3. Sets the metric `operation` label to `media:<kind>` (e.g. `media:image`).
4. Calls the uniform adapter method — **no channel/kind branch**:

```typescript
sendResult = await adapter.sendMedia(userId, {
  kind,
  mediaIdOrUrl: item.mediaUrl,
  ...(item.mediaCaption !== undefined ? { caption: item.mediaCaption } : {}),
  ...(item.mediaFilename !== undefined ? { filename: item.mediaFilename } : {})
});
```

`MediaSendInput` is defined in
[`src/meta/shared/adapter.ts`](../../src/meta/shared/adapter.ts):

```typescript
interface MediaSendInput {
  kind: 'image' | 'audio' | 'video' | 'document'; // resolved MediaKind
  mediaIdOrUrl: string;   // public URL (any channel) or a WhatsApp media_id
  caption?: string;       // image/video/document; ignored where unsupported
  filename?: string;      // document filename
}
```

Each client implements one `sendMedia` that `switch`es on `input.kind` and routes
to its own typed per-kind method internally. Putting the per-kind switch on the
client (not the interface) is what keeps the agent channel-agnostic — the clients
diverge (Messenger's document method is `sendFile`, WhatsApp's `sendDocument`
needs a filename, WhatsApp `sendAudio` takes no caption, Instagram's document is a
PDF-only `file`), but the agent dispatches one media item the same way every time.

## `inferMediaKind`

[`src/meta/shared/media.ts`](../../src/meta/shared/media.ts) — a pure, no-I/O,
non-throwing MIME → send-kind mapping (case-insensitive on the top-level type per
RFC 2045):

| MIME (top-level) | `MediaKind` |
| --- | --- |
| `image/*` | `image` |
| `audio/*` | `audio` |
| `video/*` | `video` |
| anything else — `application/*`, `text/*`, octet-stream | `document` |
| `undefined` | `document` |

Documents are the catch-all. This is why an untyped media action becomes a
document — see [Supply a mimeType](#supply-a-mimetype).

## Per-channel send methods + body shapes

Each client gained typed media methods; `sendMedia` routes to them by kind. The
bodies below **are** the Meta contract — the client tests assert them exactly.

| Channel | image | audio | video | document |
| --- | --- | --- | --- | --- |
| **WhatsApp** | `sendImage(to, mediaIdOrUrl, caption?)` → `type:'image'`, `image:{ id\|link, caption? }` | `sendAudio(to, mediaIdOrUrl)` → `type:'audio'`, `audio:{ id\|link }` — **no caption** | `sendVideo(to, mediaIdOrUrl, caption?)` → `type:'video'`, `video:{ id\|link, caption? }` | `sendDocument(to, mediaIdOrUrl, filename, caption?)` → `type:'document'`, `document:{ id\|link, filename, caption? }` — **filename required** |
| **Messenger** | `sendImage(recipientId, url)` → `message.attachment{ type:'image', payload:{ url, is_reusable } }` | `sendAudio(recipientId, url)` → `type:'audio'` | `sendVideo(recipientId, url)` → `type:'video'` | `sendFile(recipientId, url)` → `type:'file'` |
| **Instagram** | `sendImage(recipientId, url)` → `message.attachment{ type:'image', payload:{ url } }` | `sendAudio(recipientId, url)` → `type:'audio'` | `sendVideo(recipientId, url)` → `type:'video'` | `sendDocument(recipientId, url)` → `type:'file'` (**PDF-only**) |

All three send via `POST {phoneNumberId|pageId|igUserId}/messages`. WhatsApp and
Messenger use `graph.facebook.com`; Instagram uses **`graph.instagram.com`** (and
each IG send passes through the in-process [rate pacer](./outbound-clients.md#instagram--srcmetainstagramclientts)).

### WhatsApp — id or URL

WhatsApp media accepts **either** a pre-uploaded `media_id` (`{ id }`) **or** a
publicly reachable URL (`{ link }`) it fetches itself. The client's `mediaRef`
helper picks the form by a regex test: a value matching `^https?://` becomes
`{ link }`, anything else is treated as `{ id }`. So callers pass whichever they
have without a separate flag.

`sendMedia` for a `document` derives a filename when none is supplied: the last
non-empty path segment of an `http(s)://` URL (query/hash stripped, URL-decoded),
falling back to `'file'` for a bare media_id or an unparseable URL. WhatsApp
requires *some* filename, so a sensible default beats erroring.

WhatsApp `sendAudio` takes no `caption` parameter at all — the WhatsApp `audio`
message object has no caption field and Meta rejects one, so the uniform input's
`caption` is intentionally dropped for the audio kind.

### Messenger — `file` type + `is_reusable`

Messenger documents use the attachment `type: 'file'` (hence the method name
`sendFile`, mirroring the API rather than WhatsApp's `sendDocument`). Messenger
media is URL-based (Meta fetches the asset; there is no separate upload step). The
private `sendAttachment` helper defaults `is_reusable: false` (these are one-shot
sends — `true` would make Meta mint a persistent reusable attachment id, needless
server-side state for a single outbound message). The public `MessengerClient`
methods expose an optional `MediaSendOptions{ isReusable? }`, but the uniform
`sendMedia` does not set it, and Messenger's URL-attachment body carries no
caption/filename, so `input.caption` / `input.filename` are unused there.

### Instagram — PDF-only `file`, image/audio/video

Instagram supports image/audio/video URL attachments and a document via an IG
`file` attachment. Per Meta's "Instagram API with Instagram Login — messaging"
reference the IG `file` attachment is **PDF-only and capped at ~25MB**. The client
deliberately does **not** validate the MIME or size — it sends what it is given
and lets Meta reject a non-PDF / oversized file. A rejection surfaces as a
`MetaApiError`, which the agent's per-item [fail-soft](#advancement--fail-soft)
catch turns into a skip + advance, so a bad document never wedges the queue. IG's
URL-attachment body carries no caption/filename, so those input fields are unused.
This PDF-only behavior is per Meta docs and is **worth live-verifying** (see
[Known gaps](../KNOWN-GAPS.md)).

## WhatsApp media upload

[`uploadWhatsAppMedia`](../../src/meta/shared/media.ts) (wrapped by
`WhatsAppClient.uploadMedia(data, mimeType, filename?)`) uploads bytes you
generated locally and returns a reusable `media_id` you can then pass to any
WhatsApp `send*` method:

- `POST /{apiVersion}/{phoneNumberId}/media` as **`multipart/form-data`** with
  `messaging_product=whatsapp`, `type=<mimeType>`, and the bytes in the `file`
  part. Returns `{ id }` → the `media_id`.
- Uses raw `fetch`, **not** `GraphClient` — the body is multipart, and
  `GraphClient.request` is JSON-only (`JSON.stringify`s the body). Crucially the
  client does **not** set `Content-Type` itself: letting `fetch` serialize the
  `FormData` is the only way to get the correct `multipart/form-data; boundary=…`
  header. A hand-set Content-Type omits the boundary and the server rejects the
  body.
- The token rides in `Authorization: Bearer`, never the URL.
- `WhatsAppClient.uploadMedia` requires `apiVersion` to be injected on
  `WhatsAppClientDeps` (the multipart fetch builds its own versioned URL outside
  the `GraphClient`, whose `apiVersion` is private). It throws a clear error if
  invoked without it rather than guessing a version.

> `uploadMedia` is a convenience for attaching locally-generated bytes. The agent
> never uploads on the media dispatch path — it forwards the chat action's `url`
> straight to `sendMedia`. Upload is for callers that hold raw bytes and want a
> reusable id.

## Media download

The download auth model differs by channel, which is the whole reason these are
separate functions ([`src/meta/shared/media.ts`](../../src/meta/shared/media.ts)).

### WhatsApp — two-step + Bearer + User-Agent

`downloadWhatsAppMedia({ mediaId, accessToken, graph })`:

1. **Resolve the URL** via `getWhatsAppMediaUrl` — `GET /{mediaId}` (through
   `GraphClient`, so it gets retry/backoff + redacted logging). Returns a
   short-lived CDN URL plus `mimeType` / `fileSizeBytes` / `sha256` (Meta's
   snake_case mapped to camelCase). The URL expires in roughly **5 minutes**.
2. **Fetch the bytes** from that URL with **both** an `Authorization: Bearer`
   token **and** a `User-Agent` header:
   - The Bearer is **required** — WhatsApp's media CDN URLs are not pre-signed; an
     unauthenticated GET returns 401.
   - The `User-Agent` (`meta-ai-agent/0.1`) is sent because the lookaside CDN
     rejects requests with a default `node`/`curl` (or absent) UA.

The metadata MIME is authoritative; the response `Content-Type` is the fallback.

**Token-leak-on-redirect:** the resolved URL is the terminal lookaside URL and we
do not expect a cross-origin 3xx. Even if the CDN ever redirected cross-origin,
`fetch`/undici strips the `Authorization` header on a cross-origin redirect, so
the Bearer is not leaked to a foreign origin (verified to hold in current undici;
documented in a load-bearing comment). If that strip behavior ever changes, the
GET should switch to `redirect: 'manual'` and re-resolve rather than auto-follow
with the token attached.

### Messenger / Instagram — pre-signed, no token

`downloadAttachmentUrl({ url, maxBytes? })` fetches the **pre-signed CDN URL Meta
already put in the webhook payload** with **no Authorization header**:

- These URLs are already signed by Meta. Sending the app token is unnecessary and
  can be actively harmful — the CDN may reject a Bearer it didn't expect, and a
  redirect to a third-party origin would leak the token cross-origin.
- A benign `User-Agent` **is** sent (a UA is not auth) for the same CDN-rejection
  reason as the WhatsApp hop.

**Optional early size cap (`maxBytes`).** When `maxBytes` is supplied, the
response's `Content-Length` header is checked **before** `response.arrayBuffer()`
reads (and buffers) the body. An over-cap attachment is rejected with the exported
`MEDIA_OVER_CAP` sentinel having read nothing — the unread body is cancelled
(best-effort) to release the socket — so a huge blob is no longer fully buffered
just to be discarded. This mirrors the WhatsApp path's `file_size` pre-flight.
Fail-open: when the header is **absent** (or `maxBytes` is omitted) it falls back
to the body read and the caller's post-download check enforces the cap, exactly as
before. The return type is therefore `DownloadedMedia | typeof MEDIA_OVER_CAP`.
`MEDIA_OVER_CAP` is a `Symbol`, distinct from a thrown error, so the caller (the
fail-open hydrator) can treat it as a clean over-cap skip.

### Buffering

Both download paths fully buffer the asset into a `Uint8Array` in memory (no
streaming). Large files are a known limitation deferred to a later stage — see
[Known gaps](../KNOWN-GAPS.md).

### Backing inbound media hydration

These same download helpers (`getWhatsAppMediaUrl`, `downloadWhatsAppMedia`,
`downloadAttachmentUrl`) also back the **opt-in inbound media hydration** step,
which downloads *inbound* user media on the agent's flush path and attaches it to
the chat request as a base64 `data:` URL (`message.media.dataUrl`). The
`downloadAttachmentUrl` `maxBytes` / `MEDIA_OVER_CAP` early reject above exists to
serve that caller. See [Inbound media hydration](./media-hydration.md).

## Advancement + fail-soft

A media item that sends successfully behaves like a `message` / `reply` for queue
advancement (see [Ordered delivery](./ordered-delivery.md)):

- **WhatsApp** waits for a `sent` / `delivered` status webhook (`on_status`), with
  the delivery-timeout fallback.
- **Messenger / Instagram** advance the moment the send returns (`on_send`).

Every media send is counted in `outbound_send_total` / `outbound_send_duration`
with `operation: 'media:<kind>'`.

**Fail-soft:** the media `sendMedia` call sits inside `sendNext`'s per-item
try/catch. A send that throws — e.g. a Meta rejection of a non-PDF / oversized
Instagram `file`, or an out-of-window send — is caught, the item is marked skipped
with the error message, and the queue advances. A bad media item never crashes or
wedges the queue; it is skipped exactly like any other send error. (There is no
retry yet — Stage 10.)

## Supply a mimeType

`inferMediaKind(undefined)` returns `document`. So a media action **without** a
`mimeType` is sent as a document:

- On WhatsApp that means a `document` body with a derived filename (usually fine).
- On Instagram a document is sent as a **`file` (PDF-only)** attachment — a non-PDF
  asset sent as a file is **rejected by Meta** (then skipped fail-soft). An image
  the endpoint *meant* to send as an image would be dropped instead of delivered.

Always set `mimeType` on a media action so the kind routes correctly,
**especially for Instagram**. This is recorded as a deliberate inference, not a
bug — see [Known gaps](../KNOWN-GAPS.md).

## Code references

Source:

- [`src/meta/shared/media.ts`](../../src/meta/shared/media.ts) — `inferMediaKind`, `uploadWhatsAppMedia`, `getWhatsAppMediaUrl`, `downloadWhatsAppMedia`, `downloadAttachmentUrl` (+ its `maxBytes` cap), `MEDIA_OVER_CAP`.
- [`src/meta/shared/media-hydrator.ts`](../../src/meta/shared/media-hydrator.ts) — `HttpMediaHydrator` / `NoopMediaHydrator` (inbound media hydration; see [Inbound media hydration](./media-hydration.md)).
- [`src/meta/shared/adapter.ts`](../../src/meta/shared/adapter.ts) — `MediaSendInput`, the `ChannelAdapter.sendMedia` method, `MediaKind`.
- [`src/meta/whatsapp/client.ts`](../../src/meta/whatsapp/client.ts) — `sendImage` / `sendAudio` / `sendVideo` / `sendDocument` / `uploadMedia` / `sendMedia` (+ the `mediaRef` id-vs-URL switch and `deriveFilename`).
- [`src/meta/messenger/client.ts`](../../src/meta/messenger/client.ts) — `sendImage` / `sendAudio` / `sendVideo` / `sendFile` / `sendMedia` (the private `sendAttachment` + `is_reusable`).
- [`src/meta/instagram/client.ts`](../../src/meta/instagram/client.ts) — `sendImage` / `sendAudio` / `sendVideo` / `sendDocument` (PDF `file`) / `sendMedia`.
- [`src/conversation/agent.ts`](../../src/conversation/agent.ts) — `sendNext` media dispatch case.
- [`src/chat/types.ts`](../../src/chat/types.ts) — the `media` `ChatAction` shape.
- [`src/delivery/queue.ts`](../../src/delivery/queue.ts), [`src/delivery/types.ts`](../../src/delivery/types.ts) — `buildOutboundItems` media branch + the `OutboundItem` media fields.

Tests (see [Testing](../TESTING.md)):

- [`tests/unit/media.test.ts`](../../tests/unit/media.test.ts) — `inferMediaKind`, upload (multipart FormData + Bearer + no manual Content-Type), the 2-step WhatsApp download (Bearer + User-Agent), the no-token FB/IG download, the `maxBytes` / `MEDIA_OVER_CAP` early reject, error/transport branches.
- [`tests/unit/media-hydrator.test.ts`](../../tests/unit/media-hydrator.test.ts) — the inbound `HttpMediaHydrator` / `NoopMediaHydrator` (see [Inbound media hydration](./media-hydration.md)).
- [`tests/unit/whatsapp-client.test.ts`](../../tests/unit/whatsapp-client.test.ts), [`tests/unit/messenger-client.test.ts`](../../tests/unit/messenger-client.test.ts), [`tests/unit/instagram-client.test.ts`](../../tests/unit/instagram-client.test.ts) — the exact per-channel media send bodies.
- [`tests/unit/conversation-agent.test.ts`](../../tests/unit/conversation-agent.test.ts) — the agent media dispatch (kind inference, `media:<kind>` metric, fail-soft skip).

Related: [Outbound clients](./outbound-clients.md) · [WhatsApp templates](./templates.md) · [Rich chat actions](./rich-chat-actions.md) · [Ordered delivery](./ordered-delivery.md) · [Message parsing](./message-parsing.md) (the inbound media counterpart) · [Inbound media hydration](./media-hydration.md).
