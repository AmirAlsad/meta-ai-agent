# scripted-flow

A small, realistic conversational arc — a **coffee pickup order** — driven by a
hand-written **state machine**, with **no LLM**. State lives in memory, keyed by
`req.conversationKey` (the same key the transport uses), so the flow walks
forward one step per inbound turn. Where [`action-catalog`](../action-catalog)
shows each action in isolation, this example exercises the rich actions
**naturally** as the conversation progresses.

- Source: [`scripted-flow/index.ts`](./index.ts)
- Exports: `scriptedFlowResponse(req, store?)` (pure-ish handler — accepts an
  injectable state store), `createScriptedFlowChatEndpoint()` (the Express app),
  and `FlowStore` (the state-store interface + `createInMemoryFlowStore()`
  default).

## The arc

State advances `greet → size → milk → name → done`, one step per turn for a
given `conversationKey`:

| Step (waiting on) | User says | Bot returns | Action(s) exercised |
| --- | --- | --- | --- |
| `greet` | _first contact_ | greeting + "what size?" | `message` |
| `size` | "large" | size ack + "what milk?" | `reaction` (👍) **+** `message` — degrades to a bare `message` if `reaction` unsupported |
| `milk` | "oat" | "what name?" threaded onto the milk message | `reply` — degrades to a `message` if `reply_to` unsupported |
| `name` | "Amir" | pickup confirmation with the full order | `message` |
| `done` | _anything_ | nudge to say "restart" | `message` |

Cross-cutting behaviors (checked before the step machine):

- **Dedupe → silence.** A repeated inbound `channelMessageId` for the same
  conversation returns `{ silence: true }` (the transport dedupes too; this shows
  the endpoint-side path). Blank ids are never deduped.
- **Closed-window re-engagement.** When `req.context.windowOpen === false`, the
  bot emits a `template` action (`hello_world` / `en_US`) to reopen the 24h
  window — **WhatsApp-only**, gated on the `template` capability; other channels
  degrade to a plain message.
- **Restart.** Saying `restart` (or `reset` / `start over`) at any point wipes the
  collected answers and drops the user back at the `size` step.

## State store

The handler reads/writes a small `FlowStore`:

```ts
interface FlowStore {
  get(key: string): FlowState | undefined;
  set(key: string, state: FlowState): void;
  seen(key: string, msgId: string): boolean; // dedupe; records new ids
}
```

`scriptedFlowResponse(req)` uses a shared module-level in-memory store by default
(state persists for the life of the server). Tests inject a **fresh** store per
case via `createInMemoryFlowStore()`:

```ts
const store = createInMemoryFlowStore();
scriptedFlowResponse(req, store);
```

State resets on restart of the process. No Redis, no LLM, no external services —
just a `Map` and a `switch` over the current step.

## Run it

**Standalone** (listens on `PORT` or 4004, exposing `POST /` and `GET /health`):

```bash
node --import tsx examples/scripted-flow/index.ts
```

Then point the agent at it by setting `CHAT_ENDPOINT_URL=http://localhost:4004`.

**…or via the local REPL** (no standalone server, no Meta account):

```bash
npm run example:chat -- scripted-flow
```

In the REPL, type the answers one per turn (`large`, `oat`, `Amir`) to walk the
arc; `/channel messenger` to see the `reply`/`reaction` steps degrade; resend the
same message to trigger the dedupe-silence path; `restart` to start over.

## Curl recipe (walk two steps)

```bash
KEY="whatsapp:biz-1:user-1"

# 1. greet → size
curl -s http://localhost:4004/ -H 'content-type: application/json' -d '{
  "channel":"whatsapp","conversationKey":"'"$KEY"'","message":"hi",
  "messages":[{"channel":"whatsapp","channelMessageId":"m1","channelScopedUserId":"user-1","channelScopedBusinessId":"biz-1","type":"text","text":"hi","timestamp":1700000000000,"raw":{}}],
  "capabilities":["reaction","reply_to","template"],"context":{"windowOpen":true}
}' | jq

# 2. size → milk (reaction ack + next question)
curl -s http://localhost:4004/ -H 'content-type: application/json' -d '{
  "channel":"whatsapp","conversationKey":"'"$KEY"'","message":"large",
  "messages":[{"channel":"whatsapp","channelMessageId":"m2","channelScopedUserId":"user-1","channelScopedBusinessId":"biz-1","type":"text","text":"large","timestamp":1700000001000,"raw":{}}],
  "capabilities":["reaction","reply_to","template"],"context":{"windowOpen":true}
}' | jq
```

## The contract

This endpoint implements the developer's side of the chat contract: receive a
`ChatRequest`, return a `ChatResponse`. The full reference — request fields,
response shapes, capability gating, and normalization — lives in
[`docs/features/rich-chat-actions.md`](../../docs/features/rich-chat-actions.md).
