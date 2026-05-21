# identity-lookup — a `USER_LOOKUP_URL` stub

A reference stub for the **identity-resolution** hook. It returns a hardcoded
[`Contact`](../../src/identity/types.ts) for two known users and "nothing" for
everyone else, so you can watch the agent enrich an inbound conversation before
it calls your chat endpoint.

> [!IMPORTANT]
> This is **not** a chat endpoint. It implements the `USER_LOOKUP_URL` contract,
> **not** `CHAT_ENDPOINT_URL`. The agent POSTs an identity-lookup request here
> (a sender's `{ channel, channelScopedUserId, channelScopedBusinessId }`) and
> expects a `Contact` back — a different shape from the `ChatRequest` the chat
> examples answer. So it is **not** a target for the chat runners
> (`npm run example:chat` / `npm run example:dev`) and is **not** added to the
> REPL. Run it **alongside** a chat endpoint.

## What it demonstrates

- The `USER_LOOKUP_URL` request/response contract
  ([`docs/features/identity-resolution.md`](../../docs/features/identity-resolution.md)):
  the agent's `HttpIdentityResolver` POSTs the inbound sender's identity and you
  return a `Contact`.
- **Fail-open** enrichment: enrichment is best-effort. An unknown user, a
  non-2xx, a network error, a timeout, or a body with no recognized fields all
  resolve to "no enrichment, proceed" — they never block message delivery.
- That a resolved `contact` then **rides on the `ChatRequest`**: run this beside
  a chat example and the `contact` block appears in each request your chat
  endpoint receives.

## Exports

- `lookupIdentity(req)` — the pure handler: returns a `Contact` for a known
  `channelScopedUserId`, `null` otherwise.
- `createIdentityLookupEndpoint()` — the Express app (`POST /` lookup +
  `GET /health`).

## Run

Start the lookup stub (listens on `PORT` or **4010**, clear of the chat
examples' 4001 / 4002 / 4003):

```bash
node --import tsx examples/identity-lookup/index.ts
```

It must run **alongside a chat endpoint**, because enrichment is layered in
front of the chat call. In one terminal start a chat endpoint, in another start
this stub, then point the agent at both:

```bash
# terminal 1 — a chat endpoint
node --import tsx examples/minimal-chat-endpoint/index.ts   # listens on 4001

# terminal 2 — this identity-lookup stub
node --import tsx examples/identity-lookup/index.ts         # listens on 4010

# terminal 3 — the agent, wired to both
CHAT_ENDPOINT_URL=http://localhost:4001 \
USER_LOOKUP_URL=http://localhost:4010 \
npm run dev
```

When an inbound arrives from one of the known users below, the agent resolves
the contact, attaches it to the `ChatRequest`, and your chat endpoint sees the
`contact` block. (The lookup runs at most **once per conversation** and the
result is cached — see the doc.)

## Built-in contacts

Keyed by `channelScopedUserId` (the OTHER party — `wa_id` / PSID / IGSID):

| `channelScopedUserId` | Channel   | Enrichment                                                  |
| --------------------- | --------- | ---------------------------------------------------------- |
| `447700900123`        | whatsapp  | `firstName` / `lastName` / `email` / `tags` / `unifiedContactId` |
| `987654321098765`     | messenger | `displayName` / `customVariables` / `unifiedContactId`     |

Any other id → **404**, which the fail-open resolver treats as "no contact;
proceed".

## Request / response shape

```bash
# Known user → 200 with a Contact
curl -s http://localhost:4010/ \
  -H 'content-type: application/json' \
  -d '{"channel":"whatsapp","channelScopedUserId":"447700900123","channelScopedBusinessId":"1112223334"}'
```

```json
{
  "channel": "whatsapp",
  "channelScopedUserId": "447700900123",
  "firstName": "Alice",
  "lastName": "Anderson",
  "email": "alice@example.com",
  "tags": ["tier:gold", "beta"],
  "unifiedContactId": "crm-0001"
}
```

```bash
# Unknown user → 404 (resolver fail-opens: no enrichment, conversation proceeds)
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:4010/ \
  -H 'content-type: application/json' \
  -d '{"channel":"whatsapp","channelScopedUserId":"000000000000","channelScopedBusinessId":"1112223334"}'
# -> 404
```

### Why 404 for an unknown user

The agent's `HttpIdentityResolver` ([`src/identity/resolver.ts`](../../src/identity/resolver.ts))
is fail-open: its `!response.ok` branch maps **any** non-2xx to `undefined`
("no enrichment, proceed") without throwing. A `200` with `null` / `{}` would
work too — `shapeContact` returns `undefined` for a body with no recognized
field — but `404` is the more honest status for "not found", and either way the
conversation is never blocked.
