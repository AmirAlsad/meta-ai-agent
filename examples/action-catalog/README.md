# action-catalog

A keyword-routed reference endpoint that returns **one labeled response shape per
[`ChatAction`](../../docs/features/rich-chat-actions.md)** — so you can see, in
one place, the exact JSON the transport expects for each capability. There is
**no LLM**: it is a pure `switch` over the first word of the inbound message.

Every rich branch gates on `req.capabilities` (the adapter's `supports()` truth
set) and **degrades to a plain message** when the channel can't do the rich
thing — the central teaching point of the chat contract.

- Source: [`action-catalog/index.ts`](./index.ts)
- Exports: `catalogResponse(req)` (pure handler) and
  `createCatalogChatEndpoint()` (the Express app).

## Keyword → action map

Send a keyword as the **first word** of your message (case-insensitive; trailing
words are ignored). The first match wins.

| Keyword | What it returns | Capability gate (degrades to a `message`) |
| --- | --- | --- |
| `silence` | `{ silence: true }` — the canonical no-reply turn | — |
| `multi` | `{ messages: ['First bubble.', 'Second bubble.'] }` (ordered) | — |
| `react` | `reaction` (👍 on the last inbound id) **+** a confirming `message` | `reaction` |
| `reply` | `reply` threaded onto the last inbound id | `reply_to` |
| `media` | `media` action (`url` + `caption` + `mimeType`) | `media_send` |
| `template` | `template` (`hello_world` / `en_US`) — WhatsApp-only | `template` |
| `typing` | `typing` (2000ms) **+** a `message` once it clears | `typing_indicator` |
| `help` _or anything unrecognized_ | a `message` listing the keywords | — |

Rich actions that reference a prior message (`reaction`, `reply`) target
`req.messages.at(-1)?.channelMessageId` — the most recent inbound — falling back
to a placeholder when the turn carried no id. (`targetMessageId` also accepts a
symbolic `TargetRef` instead of a literal id — e.g. `{ alias: 'last' }`,
`{ contentIncludes }` — which the agent resolves against the turn's inbound
messages; see `TargetRef` in [`src/chat/types.ts`](../../src/chat/types.ts).)

## Run it

**Standalone** (listens on `PORT` or 4003, exposing `POST /` and `GET /health`):

```bash
node --import tsx examples/action-catalog/index.ts
```

Then point the agent at it by setting `CHAT_ENDPOINT_URL=http://localhost:4003`.

**…or via the local REPL** (no standalone server, no Meta account — boots this
endpoint and the agent in one process against fake console adapters):

```bash
npm run example:chat -- action-catalog
```

Switch the simulated channel in the REPL with `/channel <whatsapp|messenger|instagram>`
to watch the capability gates flip (e.g. `template` only fires on WhatsApp;
`react`/`reply`/`media` degrade where unsupported).

## Curl recipe

```bash
curl -s http://localhost:4003/ \
  -H 'content-type: application/json' \
  -d '{
    "channel": "whatsapp",
    "conversationKey": "whatsapp:biz-1:user-1",
    "message": "react",
    "messages": [{
      "channel": "whatsapp", "channelMessageId": "wamid.LAST",
      "channelScopedUserId": "user-1", "channelScopedBusinessId": "biz-1",
      "type": "text", "text": "react", "timestamp": 1700000000000, "raw": {}
    }],
    "capabilities": ["reaction"],
    "context": { "windowOpen": true }
  }' | jq
```

## The contract

This endpoint implements the developer's side of the chat contract: receive a
`ChatRequest`, return a `ChatResponse`. The full reference — request fields,
response shapes, capability gating, and normalization — lives in
[`docs/features/rich-chat-actions.md`](../../docs/features/rich-chat-actions.md).
