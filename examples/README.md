# Examples

Reference implementations of the **developer's side** of the meta-ai-agent chat
contract, plus two ways to run them end to end.

The transport package (`meta-ai-agent`) buffers each inbound turn and `POST`s a
`ChatRequest` to your `CHAT_ENDPOINT_URL`; your endpoint replies with a
`ChatResponse` (plain text, or a rich `actions[]` array). That boundary is the
whole contract — see [`docs/features/rich-chat-actions.md`](../docs/features/rich-chat-actions.md)
for the request/response shapes, capability gating, and normalization rules.

## The examples

There are **six**, in three groups:

- **Chat endpoints (drivable via the REPL / `example:dev`)** —
  [`minimal-chat-endpoint`](#minimal-chat-endpoint--the-echo-bot) (echo),
  [`multi-channel-router`](#multi-channel-router--channel-aware--capability-driven)
  (channel + capability aware),
  [`action-catalog`](#action-catalog--every-chataction-shape) (every `ChatAction`
  shape), and [`scripted-flow`](#scripted-flow--deterministic-state-machine) (a
  deterministic state machine). All four are pure, LLM-free, and boot in-process
  in the runners below. Each has its own per-example README with a keyword map /
  state table.
- **[`showcase-bot`](#showcase-bot--llm-backed-separate-package)** — an
  LLM-backed endpoint; a **separate package**, run standalone.
- **[`identity-lookup`](#identity-lookup--a-user_lookup_url-stub)** — a
  `USER_LOOKUP_URL` stub (NOT a chat endpoint); run alongside a chat endpoint.

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

### `action-catalog` — every `ChatAction` shape

A keyword-routed **reference endpoint**: send a keyword as the first word of your
message and it returns **one labeled response shape per `ChatAction`** — so you
can see, in one place, the exact JSON the transport expects for each capability.
A pure `switch`, **no LLM**. Every rich branch gates on `req.capabilities` and
**degrades to a plain message** when the channel can't do the rich thing.

Keywords: `silence`, `multi`, `react`, `reply`, `media`, `template`, `typing`,
`help`. See [`action-catalog/README.md`](./action-catalog/README.md) for the full
keyword → action map.

- Source: [`action-catalog/index.ts`](./action-catalog/index.ts)
- Exports: `catalogResponse(req)` (pure handler) and `createCatalogChatEndpoint()`
  (the Express app).

Run it **standalone** (listens on `PORT` or 4003):

```bash
node --import tsx examples/action-catalog/index.ts
```

…or via the **local REPL** (below):

```bash
npm run example:chat -- action-catalog
```

### `scripted-flow` — deterministic state machine

A small, realistic conversational arc — a **coffee pickup order** — driven by a
hand-written **state machine**, with **no LLM**. State lives in memory keyed by
`req.conversationKey`, so the flow walks `greet → size → milk → name → done`, one
step per inbound turn. Where `action-catalog` shows each action in isolation, this
exercises the rich actions **naturally** as the conversation progresses (a
`reaction` ack, a threaded `reply`, a closed-window `template` re-engagement, and
`silence` on a duplicate message id). Say `restart` to start over. See
[`scripted-flow/README.md`](./scripted-flow/README.md) for the full step table.

- Source: [`scripted-flow/index.ts`](./scripted-flow/index.ts)
- Exports: `scriptedFlowResponse(req, store?)` (pure-ish handler — accepts an
  injectable state store), `createScriptedFlowChatEndpoint()` (the Express app),
  and `FlowStore` (+ `createInMemoryFlowStore()`).

Run it **standalone** (listens on `PORT` or 4004):

```bash
node --import tsx examples/scripted-flow/index.ts
```

…or via the **local REPL** (below) — type the answers one per turn (`large`,
`oat`, `Amir`) to walk the arc:

```bash
npm run example:chat -- scripted-flow
```

### `showcase-bot` — LLM-backed (separate package)

A full reference endpoint backed by an LLM via the **[Vercel AI SDK](https://sdk.vercel.ai)**
— multi-provider (Anthropic by default, OpenAI swappable via a provider
registry), with multi-turn history, prompt caching, capability-gated rich actions
via tool use, **inbound media** (images multimodally, PDFs extracted), and
**speech-to-text** (voice notes via Groq Whisper). It is a **separate npm
package** with its own dependencies (`ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai`,
plus media/STT deps) — the root `meta-ai-agent` package intentionally never
depends on a model provider — so it is **not** installed by the root
`npm install` and is **not** booted by the runners below.

Run it standalone, then point the agent at it:

```bash
cd examples/showcase-bot
npm install
cp .env.example .env                      # then set ANTHROPIC_API_KEY=sk-ant-...
npm start                                 # listens on PORT (default 4055)
```

It has its **own** `.env.example` (separate from the root package's) documenting
`ANTHROPIC_API_KEY` (required), optional `OPENAI_API_KEY` (for an `openai:` model)
and `GROQ_API_KEY` (for STT), plus `SHOWCASE_MODEL`, `MAX_TOKENS`, and `PORT`.

Then set `CHAT_ENDPOINT_URL=http://localhost:4055` in the transport package's
`.env` and start the agent with `npm run dev` (it reads `CHAT_ENDPOINT_URL`).
Note: `npm run dev:loop` will **not** route here — it overrides
`CHAT_ENDPOINT_URL` with its own in-process keyword test endpoint. See
[`showcase-bot/README.md`](./showcase-bot/README.md) for full details.

### `identity-lookup` — a `USER_LOOKUP_URL` stub

A reference stub for the **identity-resolution** hook — it implements the
`USER_LOOKUP_URL` contract, **not** `CHAT_ENDPOINT_URL`, so it is **not** a chat
endpoint and is **not** a target for the runners below (it is deliberately absent
from the REPL / `example:dev` example lists). The agent POSTs an inbound sender's
`{ channel, channelScopedUserId, channelScopedBusinessId }` and expects a
`Contact` back; this stub returns a hardcoded contact for two known users and a
404 (fail-open → "no enrichment, proceed") for everyone else.

Run it **alongside** a chat endpoint so the resolved `contact` rides on the
`ChatRequest`:

```bash
# terminal 1 — a chat endpoint
node --import tsx examples/minimal-chat-endpoint/index.ts   # listens on 4001

# terminal 2 — this lookup stub
node --import tsx examples/identity-lookup/index.ts         # listens on 4010

# terminal 3 — the agent, wired to BOTH
CHAT_ENDPOINT_URL=http://localhost:4001 \
USER_LOOKUP_URL=http://localhost:4010 \
npm run dev
```

- Source: [`identity-lookup/index.ts`](./identity-lookup/index.ts)
- Exports: `lookupIdentity(req)` (pure handler) and
  `createIdentityLookupEndpoint()` (the Express app).

See [`identity-lookup/README.md`](./identity-lookup/README.md) and
[`docs/features/identity-resolution.md`](../docs/features/identity-resolution.md)
for the request/response shape, the built-in contacts, and the fail-open rules.

## Running the examples

There are two runners, both driven by npm scripts from the repo root.

### Local REPL — no Meta account needed

```bash
npm run example:chat -- minimal-chat-endpoint
# or any of the other chat endpoints:
npm run example:chat -- multi-channel-router
npm run example:chat -- action-catalog
npm run example:chat -- scripted-flow
```

This is the **fastest way to see the full loop**. It boots the chosen example
endpoint **and** the conversation agent in one process, wired to **fake console
adapters** instead of real Meta channels — so no Meta App, no ngrok, no
credentials. You type messages at a prompt and watch the agent buffer, call your
endpoint, and "send" the response in the console.

REPL commands:

| Command | What it does |
| --- | --- |
| `/channel <whatsapp\|messenger\|instagram>` | Switch the simulated channel — changes the `capabilities` your endpoint sees. |
| `/media <url>` | Send a simulated inbound image (by URL; on WhatsApp the value is used as the media id) instead of text. |
| `/reaction <emoji>` | Send a simulated inbound reaction targeting the **last outbound** message id. |
| `/status <delivered\|read>` | Send a delivery/read status for the last outbound id (WhatsApp drives queue advancement; Messenger/Instagram `read` is a read receipt). |
| `/raw` | Toggle printing the raw signed webhook + response JSON for subsequent turns. |
| `/reset` | Clear the simulated conversation state and start fresh. |
| `/help` | List the commands. |
| `/exit` | Shut down and quit (Ctrl-C also works). |

Anything that isn't a `/command` is sent as inbound text.

### Live device — real Meta App + ngrok

```bash
npm run example:dev -- minimal-chat-endpoint
# or any of the other chat endpoints:
npm run example:dev -- multi-channel-router
npm run example:dev -- action-catalog
npm run example:dev -- scripted-flow
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

Neither `showcase-bot` (separate package) nor `identity-lookup` (a
`USER_LOOKUP_URL` stub, not a chat endpoint) is bootable through `example:dev`;
run each standalone as shown in its section above.

## At a glance

| Example | LLM? | Meta account? | Separate install? | REPL-drivable? |
| --- | --- | --- | --- | --- |
| `minimal-chat-endpoint` | No | No (REPL) / Yes (`example:dev`) | No | Yes |
| `multi-channel-router` | No | No (REPL) / Yes (`example:dev`) | No | Yes |
| `action-catalog` | No | No (REPL) / Yes (`example:dev`) | No | Yes |
| `scripted-flow` | No | No (REPL) / Yes (`example:dev`) | No | Yes |
| `showcase-bot` | Yes (Vercel AI SDK) | Only to test on a real device | Yes (`cd examples/showcase-bot && npm install`) | No (separate package) |
| `identity-lookup` | No | No | No | No (`USER_LOOKUP_URL` stub, not a chat endpoint) |

## The contract

Every example implements the same chat-endpoint contract: receive a
`ChatRequest`, return a `ChatResponse`. The full reference — request fields
(`channel`, `messages`, `capabilities`, `context`…), the response shapes
(`message` / `messages` / `silence` / `actions[]`), per-channel capability
gating, and how responses are normalized into ordered outbound actions — lives
in [`docs/features/rich-chat-actions.md`](../docs/features/rich-chat-actions.md).

A `reply` / `reaction` action's `targetMessageId` accepts either a literal
channel message id (what these examples pass) **or** a symbolic `TargetRef` the
agent resolves against the turn's inbound messages — `{ alias: 'last' |
'previous' | 'first' }` (default `{ alias: 'last' }`), `{ contentIncludes, occurrence? }`,
`{ content }`, or `{ messageId }`. See `TargetRef` in
[`src/chat/types.ts`](../src/chat/types.ts).
