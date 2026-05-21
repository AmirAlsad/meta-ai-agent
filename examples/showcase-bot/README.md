# Showcase bot — an LLM-backed chat endpoint

A **reference implementation** of the developer's side of the meta-ai-agent chat
contract, backed by **Claude** (via the official Anthropic SDK). The transport
package (`meta-ai-agent`) POSTs each buffered inbound turn to your
`CHAT_ENDPOINT_URL`; this server calls Claude and returns a `ChatResponse` —
plain text plus, where the channel supports it, rich `actions[]`.

> **This is a separate npm package** (`meta-ai-agent-showcase-bot`) with its own
> dependencies. It brings `@anthropic-ai/sdk`, which the root `meta-ai-agent`
> package intentionally never depends on (the root stays model-provider-free).
> It has its own `package.json` and `tsconfig.json`, is excluded from the root
> typecheck/test, and is never imported by `src/`. **Install it separately.**

## What it demonstrates

- **Multi-turn history** — conversation state kept per `conversationKey`
  (in-memory; per-process and unbounded — fine for a demo).
- **Prompt caching** — the (stable) system prompt is marked
  `cache_control: { type: 'ephemeral' }` so it is cached and re-read across
  turns. Volatile per-turn context (channel, capabilities, contact) goes in the
  user turn so it never invalidates the cached prefix.
- **Channel / capability-aware replies** — the inbound `channel` and
  `capabilities` are passed to the model, and tools are gated on them.
- **Rich actions via tool use** — two small tools the model can call:
  - `react_to_message(emoji, targetMessageId)` → a `reaction` action
    (offered only when `capabilities` includes `reaction`),
  - `reply_to_message(text, targetMessageId)` → a `reply` action
    (offered only when `capabilities` includes `reply_to`).

  Each tool call is translated **directly** into the corresponding `ChatAction`
  (no second round-trip — these tools are pure output side-effects with nothing
  to feed back to the model).

It is **fail-soft**: any Anthropic/SDK error returns HTTP 200 with a friendly
message rather than a non-2xx (which the agent would treat as a chat error).

## Setup & run

This package is **not** installed by the root `npm install`. From this directory:

```bash
cd examples/showcase-bot
npm install
```

Set your Anthropic API key (required — the bot fails fast if it is unset):

```bash
export ANTHROPIC_API_KEY=sk-ant-...
# optional:
export SHOWCASE_MODEL=claude-sonnet-4-6   # default; any current Claude model id
export MAX_TOKENS=1024                     # default
export PORT=4003                           # default
```

(You can also put these in a `.env` file in this directory — `dotenv` is loaded
on startup.)

Start the server:

```bash
npm start
```

It listens on `PORT` (default **4003**) with:

- `POST /` — the chat endpoint (`ChatRequest` → `ChatResponse`),
- `GET /health` — liveness (200).

## Point the agent at it

Set the transport package's chat endpoint URL to this server:

```bash
CHAT_ENDPOINT_URL=http://localhost:4003
```

Then run the agent (or the `npm run dev:loop` harness) as usual; each inbound
turn will be answered by Claude, with reactions/threaded replies on channels
that support them.

## Files

- `index.ts` — the endpoint: local copies of the `ChatRequest` / `ChatResponse`
  / `ChatAction` contract (matching `src/chat/types.ts` field-for-field), the
  Claude call with prompt caching, capability-gated tools, and the tool-use →
  `actions[]` mapping.
- `package.json` / `tsconfig.json` — this package's own deps and TypeScript
  config (self-contained; does not extend the root tsconfig).

## Model & SDK notes

- Defaults to `claude-sonnet-4-6` (fast + capable for an example); override with
  `SHOWCASE_MODEL`.
- Uses the manual response-mapping path (read `message.content` blocks) so both
  text and `tool_use` blocks can be turned into a `ChatResponse`. The full
  assistant content (including `tool_use` blocks) is appended to history for
  multi-turn coherence.
- See `docs/features/rich-chat-actions.md` for the contract this implements.
