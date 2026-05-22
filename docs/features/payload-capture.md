# Payload capture

## Purpose

Two capture modes for collecting real Meta webhook payloads:

- **Passive (`fixture-capture`)** — "leave it running, see what arrives". Boots a tunnel + capture server, optionally registers webhooks, and writes every inbound webhook to disk with parser output and signature validity attached. Useful for discovering payload variants without a script in front of the developer.
- **Guided (`guided-capture`)** — interactive scenario walker. Prints a per-scenario prompt ("Send an image now"), waits for a webhook matching that scenario's predicate, saves it with the scenario name baked into the filename and a self-describing JSON wrapper, advances to the next scenario. The output is the raw material for the `tests/fixtures/meta/{channel}/captured/` corpus replayed against the parser in [`tests/unit/parser-captured.test.ts`](../../tests/unit/parser-captured.test.ts) (and, later, against the conversation agent).

Both modes mount a separate Express app from the production runtime ([`scripts/lib/capture-server.ts`](../../scripts/lib/capture-server.ts)). The capture server mirrors production signature middleware so app-secret typos still fail fast, but it never dispatches to the conversation agent — captures are side-effect-free.

## Commands

```bash
npm run capture:fixtures                       # Passive: capture everything
npm run capture:guided                         # Guided: prompt → wait → save → next
npm run capture:guided -- --list               # List the scenarios per channel and exit (no creds needed)
npm run capture:guided -- --channel=whatsapp   # Restrict to one channel
npm run capture:guided -- --channel=messenger
npm run capture:guided -- --channel=instagram
```

Append `-- --help` to either for the full flag list. `capture:guided -- --list` is the
zero-config inventory dump — it is resolved **before** `loadConfig()`, so it prints the
available scenario ids grouped by channel without any `.env` / credentials.

### Shared flags

Defined in [`scripts/capture/fixture-capture.ts`](../../scripts/capture/fixture-capture.ts) and [`scripts/capture/guided-capture.ts`](../../scripts/capture/guided-capture.ts).

| Flag | Mode | Effect |
| --- | --- | --- |
| `--port=<n>` | both | Local listener port. Default: `config.port` (3000). |
| `--ngrok-domain=<x>` | both | Reserved ngrok subdomain for a stable callback URL across runs. |
| `--captures-dir=<path>` | fixture-capture only | Output directory. Default: `.captures/meta`. (Guided always uses `.captures/meta`.) |
| `--accept-invalid-signatures` | fixture-capture only | Capture even when `X-Hub-Signature-256` fails (logs `sig=INVALID`). Default: strict — 401 + drop. Guided capture is strict-only. |
| `--no-webhook-registration` | both | Skip the Meta webhook subscription POST. Use when subscriptions are already configured. |
| `--channel=<x>` | guided only | `whatsapp` \| `messenger` \| `instagram` \| `all`. If omitted, you're prompted. |
| `--scenarios=<a,b,c>` | guided only | Run only these scenarios for the chosen channel (by name). |
| `--list` | guided only | Print the available scenario ids grouped by channel and exit. Resolved before `loadConfig()`, so it needs no `.env` / credentials. |
| `--help`, `-h` | both | Print usage. |

## File output format

### `fixture-capture`

Filename: `.captures/meta/{channelHint}/{ISO-ts}-{channelHint}-{type}.json` where `type` is the first message type, the first status string, or `envelope` when the body has neither. The colons and dots in the ISO timestamp are replaced with `-` so the filename is filesystem-safe.

Body: the full `CapturedWebhook` shape produced by [`scripts/lib/capture-server.ts`](../../scripts/lib/capture-server.ts) — `receivedAt`, `channelHint`, `rawBody`, `parsed`, `signatureValid`, `headers` (redacted), plus pretty-printed JSON with mode `0o600`. The `parsed` field includes the normalized `ParseResult` so you can spot parser drift at a glance.

### `guided-capture`

Filename: `.captures/meta/{channel}/{ISO-ts}-{scenarioName}.json`.

Body: a self-describing wrapper around the raw payload — annotations are siblings of `rawBody`, never folded into it, so `rawBody` stays bit-faithful to what Meta posted.

```json
{
  "_scenario": "image",
  "_capturedAt": "2026-05-18T17:52:00.123Z",
  "_channel": "whatsapp",
  "_signatureValid": true,
  "rawBody": {
    "object": "whatsapp_business_account",
    "entry": [
      {
        "id": "...",
        "changes": [ /* ... */ ]
      }
    ]
  }
}
```

Promoting a capture into `tests/fixtures/meta/{channel}/captured/` is a manual three-step process: read the file, redact `rawBody` (phone numbers, IGSIDs, PSIDs, profile names, message content, tokens), drop the redacted file (or just the `rawBody` sub-object) into `tests/fixtures/meta/{channel}/captured/`.

## Per-channel guided scenarios

Defined in [`scripts/capture/guided-capture.ts`](../../scripts/capture/guided-capture.ts) (`WHATSAPP_SCENARIOS`, `MESSENGER_SCENARIOS`, `INSTAGRAM_SCENARIOS`).

### WhatsApp

| Scenario | Predicate (post-parse) | Prompt |
| --- | --- | --- |
| `text` | `messages.some(m => m.type === 'text')` | Send a text message to your WhatsApp business number from a personal account. |
| `image` | `messages.some(m => m.type === 'image')` | Send an image to your WhatsApp business number. |
| `audio-voice` | `messages.some(m => m.type === 'audio')` | Send a voice message (hold the mic button). |
| `reaction` | `messages.some(m => m.type === 'reaction')` | React to any message in the thread with an emoji. |
| `reply-to` | `messages.some(m => m.replyTo !== undefined)` | Long-press a message and reply to it. |
| `status-read` | `statuses.some(s => s.status === 'read')` | Open the thread and read any unread bot message. |

### Messenger

| Scenario | Predicate | Prompt |
| --- | --- | --- |
| `text` | `messages.some(m => m.type === 'text')` | Send a text message from a personal Facebook account to your Page. |
| `image` | `messages.some(m => m.type === 'image')` | Send an image (attachment) to your Page. |
| `reaction` | `messages.some(m => m.type === 'reaction')` | React to any message in the thread. |
| `read` | `statuses.some(s => s.status === 'read')` | Open the thread on the personal account; mark all as read. |

### Instagram

| Scenario | Predicate | Prompt |
| --- | --- | --- |
| `text-dm` | `messages.some(m => m.type === 'text')` | Send a DM from a personal IG account to `@{username}` (resolved live). |
| `story-reply` | `messages.some(m => m.storyReply !== undefined)` | Reply to a story posted by your business account. |
| `image` | `messages.some(m => m.type === 'image')` | Send an image DM. |
| `reaction` | `messages.some(m => m.type === 'reaction')` | React to any DM in the thread. |

The walker waits up to 5 minutes per scenario. You can type `skip` + Enter at the prompt to advance, or `retry` at the timeout prompt to try once more. Captures that arrive out of order are buffered — sending an image before being prompted does not lose the capture; the queue holds non-matching entries until a later scenario's predicate consumes them.

## Redaction warning

Captures may contain personal data (phone numbers, IGSIDs, PSIDs, profile names, message content, tunnel URLs) and sometimes tokens or signed-URL media references. The `.captures/` directory is gitignored. Files are written with mode `0o600` (owner read/write only). The `X-Hub-Signature-256` header is redacted to length-only in the captured `headers` block.

**Always manually redact before promoting captures into `tests/fixtures/meta/{channel}/captured/`.**

## Workflow for fixture refresh

1. **Capture.** Run `npm run setup:<channel>` (which also captures key payloads as part of verification) or `npm run capture:guided -- --channel=<x>` and walk through the scenarios.
2. **Inspect.** Open the JSON files under `.captures/meta/{channel}/`. Compare against the documentation-derived fixtures in `tests/fixtures/meta/{channel}/`. Look for new fields, renamed fields, undocumented additions — Meta payloads regularly drift from published examples.
3. **Redact.** Remove phone numbers, IGSIDs, PSIDs, profile names, message content from real users, account/email metadata, tokens, signed media URLs, and tunnel URLs from the `rawBody`. Use a stable redaction convention (a 555-prefixed phone, `US.0000000000000001`-style placeholder IDs, shape-preserving wamid placeholders, generic profile names) so multiple promoted captures cross-reference cleanly — see `tests/fixtures/meta/whatsapp/captured/` for the worked example. Note that **wamids themselves encode phone numbers in base64** (`wamid.HBgL<base64-phone>...`), so don't keep real wamids verbatim either.
4. **Promote.** Strip the capture wrapper down to the bare `rawBody` (matches the existing fixture style) and save under `tests/fixtures/meta/{channel}/captured/<descriptive-name>.json`.
5. **Add a test.** Add an assertion in [`tests/unit/parser-captured.test.ts`](../../tests/unit/parser-captured.test.ts) that loads the new fixture and locks in parser behavior (channel, ids, type, key fields). This is the difference between a documentation snapshot and a regression check.
6. **Update docs.** Add an entry under "Verified shapes" in [META-PAYLOAD-STRUCTURES.md](../META-PAYLOAD-STRUCTURES.md). If the captured shape surfaces an undocumented field the parser doesn't extract, also add it to [KNOWN-GAPS.md](../KNOWN-GAPS.md) so a future stage can decide whether to promote it onto `IncomingMessage` / `StatusUpdate`.

### Worked example

The first three promoted captures (2026-05-19, WhatsApp) live at:

```
tests/fixtures/meta/whatsapp/captured/
├── inbound-reaction.json
├── inbound-text.json
└── outbound-status-sent.json
```

Each is exercised by `tests/unit/parser-captured.test.ts`. The session that produced them also surfaced four Meta fields not in our docs-derived fixtures (`contacts[].user_id`, `contacts[].profile.name`, `messages[].from_user_id`, `statuses[].pricing` block) — all captured in [KNOWN-GAPS.md](../KNOWN-GAPS.md) under "Real-capture findings".

## Related documents

- [Setup verification](./setup-verification.md) — verify scripts that also use the capture server.
- [Inbound webhooks](./inbound-webhooks.md) — the production handler the capture server mirrors.
- [Message parsing](./message-parsing.md) — the parser the capture server runs against each delivery.
- [Webhook security](./webhook-security.md) — signature verification that's shared between production and capture.
- [Meta payload structures](../META-PAYLOAD-STRUCTURES.md) — observed payload shapes (populated as captures land).
- [Testing](../TESTING.md) — fixture inventory and the captured-fixtures workflow.
