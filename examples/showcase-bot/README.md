# Showcase bot — an LLM-backed chat endpoint

A **reference implementation** of the developer's side of the meta-ai-agent chat
contract, backed by the **Vercel AI SDK** (multi-provider via a provider
registry — Anthropic by default, OpenAI swappable). The transport package
(`meta-ai-agent`) POSTs each buffered inbound turn to your `CHAT_ENDPOINT_URL`;
this server calls the model and returns a `ChatResponse` — plain text plus, where
the channel supports it, rich `actions[]` (reactions / threaded replies / media).

> **This is a separate npm package** (`meta-ai-agent-showcase-bot`) with its own
> dependencies. It brings the Vercel AI SDK (`ai`, `@ai-sdk/anthropic`,
> `@ai-sdk/openai`) plus media/STT deps, which the root `meta-ai-agent` package
> intentionally never depends on (the root stays model-provider-free). It has its
> own `package.json` / `tsconfig.json`, is excluded from the root typecheck/test,
> and is never imported by `src/`. **Install it separately.**

## What it demonstrates

- **Multi-provider via the Vercel AI SDK** — `createProviderRegistry({ anthropic,
  openai })` + `registry.languageModel(id)`. Swap providers by changing the
  registry-prefixed `model:` in `config.yaml` (e.g. `anthropic:claude-sonnet-4-6`,
  `anthropic:claude-haiku-4-5`, `openai:gpt-4o-mini`).
- **The tool round-trip for free** — `generateText({ ..., stopWhen:
  stepCountIs(maxSteps) })`. After the model calls a side-effect tool the SDK
  feeds the result back and calls the model again, so it produces its real TEXT
  answer with **no hand-rolled loop**.
- **Tools that build the chat contract** — each tool's `execute` pushes a Meta
  `ChatAction` into a per-request collector and returns a short ack:
  - `send_message(text)` → a `message` action — the normal reply tool, always
    available. Call it multiple times in one turn to send several bubbles.
  - `react_to_message(emoji, targetMessageId)` → a `reaction` action (gated on
    `capabilities` including `reaction`),
  - `reply_to_message(text, targetMessageId)` → a `reply` action (gated on
    `reply_to`),
  - `send_media(url, caption?, mimeType?)` → a `media` action (gated on
    `media_send`),
  - `stay_silent()` → an explicit `silence`.

  The model's plain text is only a **fallback** message when it calls no outbound
  tool at all (see `src/llm.ts`).
- **Per-conversation history** keyed by `conversationKey`, so the model stays
  coherent across turns and the tool-call/tool-result pairs never desync.
- **Inbound media processing** — images go to the model multimodally, PDFs are
  extracted via `pdf-parse`, voice notes are transcribed via Groq Whisper when
  `GROQ_API_KEY` is set. Any fetch/parse error degrades to a textual description
  rather than failing the turn. See [Media](#media--speech-to-text) for the
  Meta-specific WhatsApp-id limitation.
- **Prompt caching** — on Anthropic the (stable) system prompt is marked
  `cacheControl: { type: 'ephemeral' }` so it is cached and re-read across turns;
  volatile per-turn context goes in the user turn so the cached prefix stays
  valid.
- **Capability gating** — tools are offered only when `capabilities` advertises
  the underlying feature, so the bot never tries to react on a channel that
  cannot react.

It is **fail-soft**: any error returns HTTP 200 with a friendly message rather
than a non-2xx (which the agent would treat as a chat error and drop).

## Setup

This package is **not** installed by the root `npm install`. From this directory:

```bash
cd examples/showcase-bot
npm install
cp .env.example .env
# then edit .env and set ANTHROPIC_API_KEY=sk-ant-...
# optional: OPENAI_API_KEY (only for an openai: model), GROQ_API_KEY (for STT)
```

`.env.example` documents every variable. Env vars override `config.yaml`:
`SHOWCASE_MODEL` → `model`, `MAX_TOKENS` → `maxTokens`, `PORT` → `port`. The bot
**fails fast** if the key for the selected provider is missing.

## Configuration (`config.yaml`)

| Field          | Default                          | Notes                                                  |
| -------------- | -------------------------------- | ------------------------------------------------------ |
| `port`         | `4055`                           | Overridable via `PORT`.                                |
| `model`        | `anthropic:claude-sonnet-4-6`    | Registry-prefixed (`<provider>:<id>`). `SHOWCASE_MODEL`.|
| `maxTokens`    | `1024`                           | Per-response cap. `MAX_TOKENS`.                        |
| `maxSteps`     | `5`                              | Tool-calling step cap per turn (drives `stopWhen`).    |
| `systemPrompt` | _(see config.yaml)_              | The Ava persona — warm, concise support assistant.     |

## Run

```bash
npm start            # node --import tsx src/server.ts
# or
npm run dev          # tsx watch — restarts on file changes
```

It listens on `port` (default **4055**) with:

- `POST /` — the chat endpoint (`ChatRequest` → `ChatResponse`),
- `GET /health` — liveness (200).

Point the transport at it:

```bash
CHAT_ENDPOINT_URL=http://localhost:4055
```

## Curl recipe

```bash
curl -s http://localhost:4055/ \
  -H 'content-type: application/json' \
  -d '{
    "channel": "whatsapp",
    "conversationKey": "whatsapp:100:1555",
    "message": "do you offer refunds?",
    "messages": [{
      "channel": "whatsapp",
      "channelMessageId": "wamid.R1",
      "channelScopedUserId": "1555",
      "channelScopedBusinessId": "100",
      "timestamp": 1779360000000,
      "type": "text",
      "text": "do you offer refunds?"
    }],
    "capabilities": ["typing_indicator","read_receipt","reaction","reply_to","template","media_send"],
    "context": { "windowOpen": true }
  }'
```

## Media & speech-to-text

Inbound `messages[].media` is processed for the model in `src/media-processor.ts`:

| Inbound media | Behavior |
| --- | --- |
| image (`image/jpeg\|png\|gif\|webp`) with a `url` | fetched, attached as a multimodal **image part** |
| other image MIME (e.g. `image/heic`) | described textually (most providers reject it) |
| audio with a `url` | **STT** via Groq Whisper (`src/stt/`) → transcript text |
| `application/pdf` with a `url` | extracted via `pdf-parse` → text |
| video / other document / unknown | short textual description |

**STT degradation:** `GROQ_API_KEY` is optional. When unset, `createSttProvider()`
returns `null` and a voice note is described ("[Voice note received — no
transcription provider configured…]") instead of transcribed. The provider sits
behind an `SttProvider` interface so another backend can be dropped in.

**Meta WhatsApp-id limitation (important):** the sendblue showcase always received
a ready-to-fetch `media_url`. Meta differs by channel — Messenger / Instagram
attachments carry a pre-signed CDN `url`, but **WhatsApp media is `id`-based**: you
must call the Graph API *with the WhatsApp access token* to resolve a short-lived
download URL, which this standalone bot does not hold (that is the transport
package's job). So when an inbound media block has only an `id` and no `url`, the
processor **describes it textually** ("[customer sent an image — id only, not
downloadable without the WhatsApp token]") and does **not** fail. A real
deployment behind the transport would receive a `url` (or download via the token)
before this endpoint is hit.

## Files

- `src/server.ts` — Express app: `POST /` (`ChatRequest` → `ChatResponse`),
  `GET /health`, fail-soft, standalone-run guard.
- `src/llm.ts` — the Vercel AI SDK call: provider registry, `generateText` +
  `stopWhen: stepCountIs`, prompt caching, per-`conversationKey` history,
  result → `ChatResponse` mapping.
- `src/tools.ts` — capability-gated zod tools whose `execute` pushes a
  `ChatAction` into a per-request collector.
- `src/media-processor.ts` — inbound media → model content (image / audio / PDF /
  description), with the WhatsApp-id limitation handled gracefully.
- `src/stt/` — the Groq Whisper transcriber behind an `SttProvider` interface.
- `src/contract.ts` — local copies of the meta-ai-agent chat contract
  (`ChatRequest` / `ChatResponse` / `ChatAction` / `IncomingMessage`), matching
  `src/chat/types.ts` and `src/meta/types.ts` field-for-field.
- `src/config.ts` + `config.yaml` — config loading with env overrides and
  fail-fast provider-key validation.
- `src/logger.ts` — a tiny structured (one-JSON-line) logger.
- `package.json` / `tsconfig.json` — this package's own deps and TS config
  (self-contained; does not extend the root tsconfig).

## Model & SDK notes

- Defaults to `anthropic:claude-sonnet-4-6` (fast + capable for an example).
- Uses `generateText` + `stopWhen: stepCountIs(maxSteps)` — the SDK handles the
  tool round-trip and feeds `result.response.messages` back into history, so the
  model produces its text answer after any side-effect tool calls with no manual
  loop. The model id is **registry-prefixed** (`<provider>:<id>`); the provider
  registry resolves the prefix.
- See `docs/features/rich-chat-actions.md` and `docs/features/media.md` for the
  contracts this implements.
