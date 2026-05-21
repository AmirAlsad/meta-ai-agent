# minimal-chat-endpoint

The smallest possible chat endpoint: it **echoes the aggregated inbound text**
back to the sender. Start here to see the bare
[chat contract](../../docs/features/rich-chat-actions.md) — read `req.message`,
return `{ message }` — with no channel logic, no capabilities, and **no LLM**.

It stays silent on a turn that carried no text (a reaction-only or media-only
turn): `req.message` is empty, so there is nothing to echo and the handler
returns `{ silence: true }` rather than sending a blank message.

- Source: [`minimal-chat-endpoint/index.ts`](./index.ts)
- Exports: `echoResponse(req)` (the pure handler) and `createEchoChatEndpoint()`
  (the Express app — `POST /` + `GET /health`).

## Run it

**Standalone** (listens on `PORT` or 4001, exposing `POST /` and `GET /health`):

```bash
node --import tsx examples/minimal-chat-endpoint/index.ts
```

Then point the agent at it by setting `CHAT_ENDPOINT_URL=http://localhost:4001`.

**…or via the local REPL** (no standalone server, no Meta account — boots this
endpoint and the agent in one process against fake console adapters):

```bash
npm run example:chat -- minimal-chat-endpoint
```

Type a line and watch it come back; send a `/reaction` or `/media` (with no
accompanying text) to see the `silence` path.

## The contract

This endpoint implements the developer's side of the chat contract: receive a
`ChatRequest`, return a `ChatResponse`. The full reference — request fields,
response shapes, capability gating, and normalization — lives in
[`docs/features/rich-chat-actions.md`](../../docs/features/rich-chat-actions.md).
