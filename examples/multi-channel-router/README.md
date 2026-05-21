# multi-channel-router

Where [`minimal-chat-endpoint`](../minimal-chat-endpoint) just echoes, this
endpoint demonstrates the two things that make the
[chat contract](../../docs/features/rich-chat-actions.md) useful — with **no
LLM**, just a small `if`/`switch`:

- **channel-aware** responses (`req.channel`) — per-channel greeting copy, and
- **capability-driven** actions — it gates each rich action on `req.capabilities`
  (the adapter's `supports()` truth set), so it only sends a WhatsApp `template`
  when the channel actually supports one and degrades to plain text elsewhere.

- Source: [`multi-channel-router/index.ts`](./index.ts)
- Exports: `routerResponse(req)` (the pure handler) and
  `createRouterChatEndpoint()` (the Express app — `POST /` + `GET /health`).

## What it routes

Branches are checked top to bottom; the first match wins:

| Inbound | Bot returns | Notes |
| --- | --- | --- |
| a `reaction` message | `reaction` (👍) back on the reacted-to message | gated on `reaction` |
| a greeting (`hi`/`hello`/`hey`/`start`) | per-channel greeting copy | uses `req.channel` |
| `template`, or a closed 24h window (`context.windowOpen === false`) | `template` (`hello_world` / `en_US`) on WhatsApp; plain text elsewhere | gated on `template` |
| anything else | echo, prefixed with the channel | — |

## Run it

**Standalone** (listens on `PORT` or 4002, exposing `POST /` and `GET /health`):

```bash
node --import tsx examples/multi-channel-router/index.ts
```

Then point the agent at it by setting `CHAT_ENDPOINT_URL=http://localhost:4002`.

**…or via the local REPL** (no standalone server, no Meta account):

```bash
npm run example:chat -- multi-channel-router
```

Switch the simulated channel with `/channel <whatsapp|messenger|instagram>` to
watch the greeting copy change and the WhatsApp-only `template` degrade to plain
text on Messenger / Instagram.

## The contract

This endpoint implements the developer's side of the chat contract: receive a
`ChatRequest`, return a `ChatResponse`. The full reference — request fields,
response shapes, capability gating, and normalization — lives in
[`docs/features/rich-chat-actions.md`](../../docs/features/rich-chat-actions.md).
