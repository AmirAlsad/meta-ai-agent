# Inbound media hydration

Opt-in transport-side download of **inbound** user media. When enabled, the agent
downloads each buffered message's media on the flush path and attaches it to the
chat request as a base64 `data:` URL on `message.media.dataUrl`, so the chat
endpoint can "see" the media without doing the per-channel authenticated download
itself.

This is the inbound counterpart to outbound [media send/upload/download](./media.md):
it reuses the same Stage 7 download helpers (`getWhatsAppMediaUrl`,
`downloadWhatsAppMedia`, `downloadAttachmentUrl`) but runs them on the
inbound→chat path inside the conversation agent.

## Purpose

A WhatsApp inbound image arrives as a bare `media.id` with **no fetchable URL** —
downloading it needs a 2-hop **authenticated** Graph call carrying the WhatsApp
access token (see [Media download](./media.md#media-download)). The chat endpoint
holds no token, so it cannot fetch that media on its own. The transport **does**
hold the token.

Hydration closes that gap: the transport downloads the media here, on the
inbound→chat path, and hands the bytes to the endpoint as a ready-to-use base64
`data:` URL. The endpoint can pass that straight to an LLM with no token and no
second fetch. Messenger/Instagram media already arrive as a pre-signed CDN URL the
endpoint *could* fetch, but hydration normalizes all three channels to the same
`dataUrl` so the endpoint never branches on channel for media access.

It is **off by default** and opt-in because base64 inflates the request body by
~33% over the raw bytes — a cost paid on every media-bearing turn — so it stays
disabled until you ask for it.

## Configuration

Two conversation knobs ([`src/config/loader.ts`](../../src/config/loader.ts),
[`.env.example`](../../.env.example)) — see [Configuration](./configuration.md):

| Variable | Config field | Default | Meaning |
| --- | --- | --- | --- |
| `INBOUND_MEDIA_DOWNLOAD` | `config.conversation.inboundMediaDownload` | `false` | Master switch. When `true`, the transport downloads inbound media and base64-attaches it to the chat request. Off by default. Boolean (`1`/`0`/`true`/`false`). |
| `INBOUND_MEDIA_MAX_BYTES` | `config.conversation.inboundMediaMaxBytes` | `5242880` (5 MiB) | Hard cap on a single attachment. Media larger than this is left as `id`/`url` (not base64-attached) and logged. Positive integer. Only consulted when download is enabled. |

When `INBOUND_MEDIA_DOWNLOAD` is `false`, `buildRuntime`
([`src/index.ts`](../../src/index.ts)) constructs **no** hydrator (it passes
`undefined`, not a `NoopMediaHydrator`) and the agent behaves exactly as before.
When `true`, it constructs an `HttpMediaHydrator` (wired with the configured
WhatsApp access token, when present) and passes it to the `ConversationAgent`.

## How it works

### Where the agent invokes it

In `ConversationAgent.flushImpl` ([`src/conversation/agent.ts`](../../src/conversation/agent.ts))
hydration runs:

- **Unlocked** — outside the conversation lock, so a concurrent `handleInbound`
  can still append to the buffer and abort/rebatch the turn.
- **After the buffer snapshot** — it operates on the local batch (`prep.batch`),
  whose message objects **are** `request.messages`, so setting `dataUrl` on them
  is visible in the chat request.
- **Before the chat call** — the data must be present when the request is sent.
- **Per batched message**, concurrently (`Promise.all`). Each message is skipped
  when it has no `media` or already carries a `dataUrl`. Each hydrate is
  independently fail-open, so one bad attachment can't sink the turn.

```typescript
if (this.mediaHydrator) {
  const hydrator = this.mediaHydrator;
  await Promise.all(
    prep.batch.map(async message => {
      if (!message.media || message.media.dataUrl !== undefined) return;
      const dataUrl = await hydrator.hydrate(message);
      if (dataUrl && message.media) message.media.dataUrl = dataUrl;
    })
  );
}
```

### Per-channel download + auth

`HttpMediaHydrator.hydrate` mirrors the auth model in
[`media.ts`](../../src/meta/shared/media.ts):

- **WhatsApp** (a `media.id` with no `url`): the authenticated 2-hop path.
  1. **Size pre-flight**: `getWhatsAppMediaUrl` resolves the media metadata
     (`GET /{mediaId}`), which reports `file_size`. If `fileSizeBytes` exceeds
     the cap, the binary is **never downloaded** — it's logged and skipped. The
     cost on the under-cap path is one extra cheap JSON GET (the actual
     `downloadWhatsAppMedia` re-resolves the URL internally), accepted to reuse
     that helper's token-leak-on-redirect safety.
  2. **Download**: `downloadWhatsAppMedia` fetches the bytes with the Bearer
     token. Requires `whatsAppAccessToken` — absent ⇒ WhatsApp media is not
     hydrated (logged at `debug`, returns `undefined`).
- **Messenger / Instagram** (any channel that already carries a fetchable
  `media.url`): `downloadAttachmentUrl` fetches the pre-signed CDN URL
  **token-free**, passing `maxBytes` so the download early-rejects via the
  `Content-Length` header (see below) before buffering an over-cap body.
- **Neither id nor url** (e.g. WhatsApp media with no id): returns `undefined`.

### Early `Content-Length` reject (`MEDIA_OVER_CAP`)

For the Messenger/IG path, `downloadAttachmentUrl` is given `maxBytes` and checks
the response's `Content-Length` **before** reading the body. When the header is
present and over cap, it cancels the body (best-effort, to release the socket) and
returns the `MEDIA_OVER_CAP` sentinel — so a huge blob is never fully buffered
just to be discarded. This mirrors WhatsApp's `file_size` pre-flight intent. When
the header is **absent**, it falls back to the body read and the hydrator's
post-download cap check enforces the limit (covering channels that under-report or
omit `Content-Length`).

### Whole-operation timeout

The entire hydrate (URL-resolve + binary GET) is bounded by a single timeout
(default **10s**, `timeoutMs`). A hung download is abandoned and reported as
`undefined` rather than threading an `AbortController` through the token-careful
`media.ts` fetches.

### Idempotency

`hydrate` returns an existing `media.dataUrl` unchanged rather than
re-downloading. Reprocessed turns (the interrupt/rebatch flow) re-run hydration on
the same message objects; the existing `dataUrl` short-circuits the work.

## The `media.dataUrl` field

`MediaInfo.dataUrl` ([`src/meta/types.ts`](../../src/meta/types.ts)) is a
`data:<mime>;base64,<...>` URI for the media bytes. The MIME is the downloaded
type, falling back to the inbound `media.mimeType`, then to
`application/octet-stream`.

It is the easiest form for the chat endpoint to hand straight to an LLM (no token,
no second fetch). It is present **only** when:

1. inbound media download is **enabled**, AND
2. the download **succeeded** within the size cap.

The raw `id` / `url` are left untouched either way. base64 inflates the payload by
~33% over the raw bytes, which is why the cap matters — see
[Message parsing](./message-parsing.md) for the full inbound `media` shape.

## Fail-open

`InboundMediaHydrator.hydrate` **never throws** and never blocks delivery. Any
failure — over-cap, timeout, network error, auth error, missing token — returns
`undefined`, leaving `dataUrl` unset. The turn proceeds with the raw media
`id`/`url` exactly as it would with hydration disabled. Failures are logged
(`warn` for download/over-cap failures, `debug` for the missing-WhatsApp-token
case); media bytes and the access token are never logged.

## API

[`src/meta/shared/media-hydrator.ts`](../../src/meta/shared/media-hydrator.ts):

```typescript
interface InboundMediaHydrator {
  /** Best-effort: a data URL for a message's media, or undefined. NEVER throws. */
  hydrate(message: IncomingMessage): Promise<string | undefined>;
}
```

| Class | Behavior |
| --- | --- |
| `HttpMediaHydrator` | Downloads via the Stage 7 media utilities and returns a base64 `data:` URL (per-channel auth as above). Constructed by `buildRuntime` only when download is enabled. |
| `NoopMediaHydrator` | Always returns `undefined` — an explicit "hydration disabled" wiring, equivalent to passing no hydrator at all. |

`HttpMediaHydrator` constructor deps (`HttpMediaHydratorDeps`):

| Dep | Required | Meaning |
| --- | --- | --- |
| `graph` | Yes | The shared `GraphClient` (used to resolve WhatsApp media metadata). |
| `whatsAppAccessToken` | No | WhatsApp access token (`config.whatsapp?.accessToken`). Absent ⇒ WhatsApp media is not hydratable. |
| `maxBytes` | Yes | Hard per-attachment cap; over-cap ⇒ `undefined`. |
| `timeoutMs` | No | Whole-operation timeout. Default 10s. |
| `fetchImpl` | No | Injectable `fetch` (defaults to `globalThis.fetch`), overridden in tests. |
| `logger` | No | A pino logger restricted to `warn` / `debug`. |

## Known limitations / tradeoffs

- **Memory + payload size.** Each attachment is fully buffered into memory and
  base64-encoded into the chat request, inflating the body by ~33%. There is no
  streaming (the underlying downloads buffer too — see
  [Media download → Buffering](./media.md#buffering)).
- **The cap drops over-size media.** Anything larger than
  `INBOUND_MEDIA_MAX_BYTES` is left as `id`/`url` (no `dataUrl`) and logged — the
  endpoint must still fall back to fetching it itself if it wants those bytes.
- **WhatsApp requires the access token.** Without `WHATSAPP_ACCESS_TOKEN`, WhatsApp
  inbound media (a bare id) cannot be hydrated; Messenger/IG (pre-signed URLs) are
  unaffected.
- **Off by default.** The base64 cost means hydration is opt-in; leave it off if
  your endpoint already fetches media via the raw `id`/`url`.

## Code references

Source:

- [`src/meta/shared/media-hydrator.ts`](../../src/meta/shared/media-hydrator.ts) — `InboundMediaHydrator`, `HttpMediaHydrator`, `NoopMediaHydrator`.
- [`src/meta/shared/media.ts`](../../src/meta/shared/media.ts) — `getWhatsAppMediaUrl`, `downloadWhatsAppMedia`, `downloadAttachmentUrl` (+ `maxBytes` / `MEDIA_OVER_CAP`).
- [`src/conversation/agent.ts`](../../src/conversation/agent.ts) — the `flushImpl` hydration call site (unlocked, post-snapshot, pre-chat-call) and the optional `mediaHydrator` dep.
- [`src/meta/types.ts`](../../src/meta/types.ts) — `MediaInfo.dataUrl`.
- [`src/config/loader.ts`](../../src/config/loader.ts) — `inboundMediaDownload` / `inboundMediaMaxBytes`.
- [`src/index.ts`](../../src/index.ts) — `buildRuntime` constructs the `HttpMediaHydrator` only when enabled.

Tests (see [Testing](../TESTING.md)):

- [`tests/unit/media-hydrator.test.ts`](../../tests/unit/media-hydrator.test.ts) — the WhatsApp 2-hop download, the token-free Messenger/IG download, the size cap (pre-flight + `MEDIA_OVER_CAP` + post-download), timeout, idempotency, and fail-open branches.
- [`tests/unit/media.test.ts`](../../tests/unit/media.test.ts) — `downloadAttachmentUrl`'s `maxBytes` / `MEDIA_OVER_CAP` early reject.
- [`tests/unit/conversation-agent.test.ts`](../../tests/unit/conversation-agent.test.ts) — the agent flush-path hydration wiring.
- [`tests/unit/config-loader.test.ts`](../../tests/unit/config-loader.test.ts) — the `INBOUND_MEDIA_*` knobs + defaults.

Related: [Media send, upload & download](./media.md) · [Configuration](./configuration.md) · [Message parsing](./message-parsing.md) · [Inbound webhooks](./inbound-webhooks.md) · [Conversation state](./conversation-state.md).
