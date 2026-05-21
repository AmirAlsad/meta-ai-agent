# Examples

Reference implementations of the **developer's side** of the meta-ai-agent chat
contract, plus two ways to run them end to end.

The transport package (`meta-ai-agent`) buffers each inbound turn and `POST`s a
`ChatRequest` to your `CHAT_ENDPOINT_URL`; your endpoint replies with a
`ChatResponse` (plain text, or a rich `actions[]` array). That boundary is the
whole contract — see [`docs/features/rich-chat-actions.md`](../docs/features/rich-chat-actions.md)
for the request/response shapes, capability gating, and normalization rules.

## The examples

### `minimal-chat-endpoint` — the echo bot

The smallest possible endpoint: it echoes the aggregated inbound text back, and
stays silent on a reaction-only / media-only turn (no text to echo). Start here
to see the bare contract: read `req.message`, return `{ message }`.

- Source: [`minimal-chat-endpoint/index.ts`](./minimal-chat-endpoint/index.ts)
- Exports: `echoResponse(req)` (pure handler) and `createEchoChatEndpoint()`
  (the Express app).

Run it **standalone** (listens on `PORT` or 4001, exposing `POST /` and
`GET /health`):

```bash
node --import tsx examples/minimal-chat-endpoint/index.ts
```

…or, faster, drive it through the **local REPL** (below) — no standalone server
to wire up.

### `multi-channel-router` — channel-aware + capability-driven

Where the minimal example just echoes, this one demonstrates the two things that
make the contract useful:

- **channel-aware** responses (`req.channel`) — per-channel greeting copy, and
- **capability-driven** actions — it gates each action on
  `req.capabilities` (the adapter's `supports()` truth set), so it only sends a
  WhatsApp `template` when the channel actually supports one and degrades to
  plain text elsewhere.

- Source: [`multi-channel-router/index.ts`](./multi-channel-router/index.ts)
- Exports: `routerResponse(req)` (pure handler) and `createRouterChatEndpoint()`
  (the Express app).

Run it **standalone** (listens on `PORT` or 4002):

```bash
node --import tsx examples/multi-channel-router/index.ts
```

…or via the **local REPL** (below).

### `showcase-bot` — LLM-backed (separate package)

A full reference endpoint backed by **Claude** (via the Anthropic SDK):
multi-turn history, prompt caching, and capability-gated rich actions via tool
use. It is a **separate npm package** with its own dependencies — the root
`meta-ai-agent` package intentionally never depends on a model provider — so it
is **not** installed by the root `npm install` and is **not** booted by the
runners below.

Run it standalone, then point the agent at it:

```bash
cd examples/showcase-bot
npm install
export ANTHROPIC_API_KEY=sk-ant-...      # required
npm start                                 # listens on PORT (default 4003)
```

Then set `CHAT_ENDPOINT_URL=http://localhost:4003` and run the agent (or
`npm run dev:loop`). See [`showcase-bot/README.md`](./showcase-bot/README.md)
for full details.

## Running the examples

There are two runners, both driven by npm scripts from the repo root.

### Local REPL — no Meta account needed

```bash
npm run example:chat -- minimal-chat-endpoint
# or:
npm run example:chat -- multi-channel-router
```

This is the **fastest way to see the full loop**. It boots the chosen example
endpoint **and** the conversation agent in one process, wired to **fake console
adapters** instead of real Meta channels — so no Meta App, no ngrok, no
credentials. You type messages at a prompt and watch the agent buffer, call your
endpoint, and "send" the response in the console.

REPL commands:

| Command | What it does |
| --- | --- |
| `/channel <name>` | Switch the simulated channel (`whatsapp` / `messenger` / `instagram`) — changes the `capabilities` your endpoint sees. |
| `/media` | Send a simulated inbound media message (image) instead of text. |
| `/reaction <emoji>` | Send a simulated inbound reaction on the last message. |
| `/status` | Show the current simulated conversation state (channel, window, last message id). |
| `/raw` | Toggle printing the raw `ChatRequest` / `ChatResponse` JSON for the next turns. |
| `/reset` | Clear the simulated conversation state and start fresh. |
| `/help` | List the commands. |

Anything that isn't a `/command` is sent as inbound text.

### Live device — real Meta App + ngrok

```bash
npm run example:dev -- minimal-chat-endpoint
# or:
npm run example:dev -- multi-channel-router
```

This boots the **real** agent stack (real Meta adapters → live Graph API sends)
pointed at the chosen in-repo example, opens an **ngrok** tunnel, and
**registers webhooks** — so you can message your WhatsApp number / Facebook Page
/ Instagram account from a **real device** and watch the example respond.

It requires a complete `.env`: real Meta App credentials, at least one channel,
`NGROK_DOMAIN`, `NGROK_AUTHTOKEN`, and `CHAT_ENDPOINT_URL` (any valid URL — the
runner **overrides** it to the in-process example for this run). Useful flags:

| Flag | Effect |
| --- | --- |
| `--port=<n>` | Local port for the agent webhook server (default `PORT` / 3000). |
| `--ngrok-domain=<domain>` | Override the reserved ngrok domain (default `NGROK_DOMAIN`). |
| `--no-webhook-registration` | Skip programmatic subscription (assume the Dashboard is already configured). |
| `--help` | Show usage. |

The `showcase-bot` is **not** bootable through `example:dev` (separate package);
run it standalone and set `CHAT_ENDPOINT_URL` as shown above.

## At a glance

| Example | LLM? | Meta account needed? | Separate install? |
| --- | --- | --- | --- |
| `minimal-chat-endpoint` | No | No (REPL) / Yes (`example:dev`) | No |
| `multi-channel-router` | No | No (REPL) / Yes (`example:dev`) | No |
| `showcase-bot` | Yes (Claude) | Only to test on a real device | Yes (`cd examples/showcase-bot && npm install`) |

## The contract

Every example implements the same chat-endpoint contract: receive a
`ChatRequest`, return a `ChatResponse`. The full reference — request fields
(`channel`, `messages`, `capabilities`, `context`…), the response shapes
(`message` / `messages` / `silence` / `actions[]`), per-channel capability
gating, and how responses are normalized into ordered outbound actions — lives
in [`docs/features/rich-chat-actions.md`](../docs/features/rich-chat-actions.md).
