# Identity resolution

## What it does

Identity resolution is **optional, fail-open** enrichment (Stage 6). When a `USER_LOOKUP_URL` is configured, the agent calls it once per conversation to enrich the inbound sender with contact info (name / email / tags / custom variables / a cross-channel unified id). The resolved `Contact` rides on the `ChatRequest` so the developer's chat endpoint sees it, and persists on the conversation record.

Enrichment is best-effort: any failure (missing URL, non-2xx, network error, timeout, malformed body) resolves to "no enrichment, proceed" and never blocks message delivery. When `USER_LOOKUP_URL` is unset, a no-op resolver runs so the agent can call `resolve()` unconditionally.

This package never synthesizes a cross-channel identity itself — Meta does not link `wa_id`, PSID, and IGSID, and there is no API to resolve them. Cross-channel unification is the developer's resolver's job (via the `unifiedContactId` it returns). See the three-identifiers constraint in [CLAUDE.md](../../CLAUDE.md).

## How it works

### The `USER_LOOKUP_URL` contract

The resolver POSTs JSON to `USER_LOOKUP_URL` ([`src/identity/resolver.ts`](../../src/identity/resolver.ts)):

**Request body:**

```json
{
  "channel": "whatsapp",
  "channelScopedUserId": "447700900123",
  "channelScopedBusinessId": "1112223334"
}
```

- `channel` — `whatsapp` / `messenger` / `instagram`.
- `channelScopedUserId` — the OTHER party: `wa_id` / PSID / IGSID.
- `channelScopedBusinessId` — your side: `phone_number_id` / page id / ig user id.

**Response body** — any 2xx with a JSON object; every field is optional and leniently coerced into a `Contact` ([`src/identity/types.ts`](../../src/identity/types.ts)):

```json
{
  "firstName": "Alice",
  "lastName": "Anderson",
  "displayName": "Alice A.",
  "email": "alice@example.com",
  "tags": ["tier:gold"],
  "customVariables": { "plan": "pro" },
  "unifiedContactId": "crm-12345"
}
```

The resolver stamps `channel` and `channelScopedUserId` from the **request** (the identity of who we looked up), not the body, so a resolver cannot accidentally re-key the contact onto a different sender. Wrong-typed fields are dropped rather than throwing (the fail-open posture extends to the body shape). If the body contributes **none** of the recognized enrichment fields, `shapeContact` returns `undefined` — a bare `{channel, userId}` adds nothing the agent didn't already have.

### Fail-open behavior

`HttpIdentityResolver.resolve` never throws. Every failure mode returns `undefined`:

- A non-2xx response → warn + `undefined`.
- A network error, a timeout (`AbortController` after `USER_LOOKUP_TIMEOUT_MS`, default 5000ms), or a JSON-parse error → warn + `undefined`.
- A 2xx whose body contributes no recognized field → `undefined` (debug-logged).

Logging is PII-safe: the resolver logs only a boolean `enriched` flag, the channel, and a redacted user-id hint (last-4) — never the raw contact body, name, or email.

### The contact cache

A resolved contact is cached in `InMemoryContactStore` ([`src/identity/contact-store.ts`](../../src/identity/contact-store.ts)) keyed by `${channel}:${channelScopedUserId}`. The resolver is **cache-then-fetch**: a cache hit short-circuits the HTTP call entirely, so a repeated inbound from the same sender does not re-hit the lookup endpoint. Only a real enrichment is cached — a miss is not, so a later-populated upstream record can still be picked up on the next inbound. The store clones on read and write (pass-by-value), matching `InMemoryConversationStore`.

### Resolve-once-per-conversation

The agent resolves at most once per conversation. In `handleInboundImpl` ([`src/conversation/agent.ts`](../../src/conversation/agent.ts)) the lookup runs **only when `record.contact` is not already set**:

- If `record.contact` is already populated (a prior inbound enriched it), the lookup is skipped entirely and nothing is counted.
- Otherwise, if an `identityResolver` is wired, it resolves and (on success) sets `record.contact`.
- Otherwise (no resolver / a `NoopIdentityResolver`), enrichment is disabled for this deploy.

The lookup runs **under the per-key lock** (`handleInboundImpl` already holds it), so the awaited resolve serializes with other ops for the same conversation.

### How the `Contact` flows to the chat endpoint and record

Once set on `record.contact`, the contact is persisted with the record (`setConversation`). On flush, it is attached to the `ChatRequest` only when present ([`src/conversation/agent.ts`](../../src/conversation/agent.ts)):

```typescript
const request: ChatRequest = {
  // ...
  ...(record.contact !== undefined ? { contact: record.contact } : {})
};
```

So the developer's chat endpoint receives the enriched contact alongside the buffered messages.

### The `identityLookupTotal` coarse metric

The `identity_lookup_total{result}` counter uses a **coarse** `resolved | none | disabled` split, incremented in `handleInboundImpl`:

| `result` | Meaning |
| --- | --- |
| `resolved` | A resolver was wired and it produced a contact. |
| `none` | A resolver was wired and it produced nothing (or threw — defensive). |
| `disabled` | No resolver wired (or a `NoopIdentityResolver`). |

The split is coarse on purpose: the resolver contract returns `undefined` **indistinguishably** for a cache miss, an HTTP miss, a non-2xx, a timeout, or a parse failure (fail-open swallows the reason). The agent can only honestly observe "we had a resolver and got a contact", "we had a resolver and got nothing", and "no resolver". A finer hit/cached/error split is deferred (see [Known gaps](../KNOWN-GAPS.md)).

### `NoopIdentityResolver` default

When `USER_LOOKUP_URL` is unset, `buildRuntime` ([`src/index.ts`](../../src/index.ts)) wires a `NoopIdentityResolver` (always returns `undefined`). The agent holds a non-null resolver reference and calls `resolve` unconditionally — no `if (enabled)` branch at every call site — and every conversation simply proceeds without contact info.

## Redaction note (admin output)

When the resolved contact is rendered on `GET /admin/conversations/:key`, `redactContact` ([`src/http/redaction.ts`](../../src/http/redaction.ts)) masks `channelScopedUserId`, `firstName`, `lastName`, `displayName`, and `email`. It deliberately **does not** redact `tags`, `customVariables`, or `unifiedContactId` — these are developer-supplied operational metadata (e.g. `tier:gold`), not inherently Meta user PII the way a name/email/phone-derived id is, so they are kept intact to keep the masked view useful. `?reveal=true` returns the contact untouched. This is a recorded gap: a developer who stuffs PII into `customVariables` will see it in admin output — see [Known gaps](../KNOWN-GAPS.md).

## Code files

| File | Role |
| --- | --- |
| [`src/identity/resolver.ts`](../../src/identity/resolver.ts) | `IdentityResolver` interface, `HttpIdentityResolver` (cache-then-fetch, fail-open), `NoopIdentityResolver`, body shaping. |
| [`src/identity/contact-store.ts`](../../src/identity/contact-store.ts) | `ContactStore` interface + `InMemoryContactStore` (clone-on-read/write cache). |
| [`src/identity/types.ts`](../../src/identity/types.ts) | The `Contact` shape. |
| [`src/conversation/agent.ts`](../../src/conversation/agent.ts) | Resolve-once-per-conversation wiring + the `identityLookupTotal` metric. |
| [`src/index.ts`](../../src/index.ts) | Chooses `HttpIdentityResolver` (when `USER_LOOKUP_URL` set) vs `NoopIdentityResolver`. |
| [`src/config/loader.ts`](../../src/config/loader.ts) | `USER_LOOKUP_URL` (validated URL) + `USER_LOOKUP_TIMEOUT_MS` (default 5000). |
| [`src/http/redaction.ts`](../../src/http/redaction.ts) | `redactContact` — masks name/email/user-id; keeps `tags`/`customVariables`/`unifiedContactId`. |

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `USER_LOOKUP_URL` | unset | Developer endpoint for identity enrichment. When unset, a no-op resolver runs (enrichment disabled). When set it must parse as a URL (validated at load, like `CHAT_ENDPOINT_URL`). |
| `USER_LOOKUP_TIMEOUT_MS` | `5000` | Per-call timeout for the lookup HTTP request. A timeout drops enrichment (fail-open). Lives in the `conversation` config group alongside `chatEndpointTimeoutMs`. |

See [Configuration](./configuration.md).

## Known limitations

- **Fail-open is total** — a misbehaving lookup endpoint can never stall or break the conversation, but it also means failures are silent past the warn log.
- **Coarse metric** — `resolved | none | disabled` only; no hit/cached/error split (deferred).
- **`tags` / `customVariables` are not redacted** in admin output (developer-supplied; see [Known gaps](../KNOWN-GAPS.md)).
- **Contact store is still in-memory (Stage 10 did NOT swap it)** — `InMemoryContactStore` is per-process, unbounded, and lost on restart, in both the in-memory and Redis runtime paths. Stage 10 made the conversation store, buffer scheduler, and limit-counter store Redis-backed, but left the contact store (along with the metrics collector and status tracker) for a later pass; a TTL/Redis-backed cache (shared across replicas, bounded/expired) is still deferred (see [Known gaps](../KNOWN-GAPS.md)).

See [Operational visibility](./operational-visibility.md), [Conversation state](./conversation-state.md), and [Known gaps](../KNOWN-GAPS.md).
