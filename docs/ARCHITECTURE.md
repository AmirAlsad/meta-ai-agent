# Architecture

## Overview

`meta-ai-agent` receives Meta webhooks for WhatsApp Cloud API, Facebook Messenger, and Instagram DMs on a single endpoint, verifies signatures against the raw request body, routes by channel, parses each channel's payload into a normalized message, buffers inbound bursts, calls a developer-provided chat endpoint, and delivers replies through the appropriate channel adapter using channel-aware ordered delivery.

The package stays transport/orchestration focused: the developer owns the chat endpoint and any model, prompt, account, or product logic behind it.

## Single Meta App, three products, one webhook URL

A single Meta App can host all three messaging products at once. All three deliver to the same callback URL and use the same `X-Hub-Signature-256` HMAC scheme — but they do **not** all sign with the same secret: WhatsApp and Messenger sign with `META_APP_SECRET`, while Instagram signs with the Instagram product's own `INSTAGRAM_APP_SECRET` (verified against the live API 2026-05-20). The verifier tries all configured secrets — see [Webhook security](./features/webhook-security.md). They are distinguished by the top-level `object` field on the webhook body:

| `object` value | Product | User ID | Business ID | Token type |
| --- | --- | --- | --- | --- |
| `whatsapp_business_account` | WhatsApp Cloud API | `wa_id` (E.164) | `phone_number_id` | System User Access Token |
| `page` | Messenger Platform | PSID | Page ID | Page Access Token |
| `instagram` | Instagram (Business Login) | IGSID | IG User ID | Instagram User Access Token |

`objectToChannel(req.body.object)` in `src/http/app.ts` maps each value to a `Channel` (`'whatsapp' | 'messenger' | 'instagram' | 'unknown'`). The `dispatchWebhook` function uses that to log/route. Anything else returns `unknown` and is warn-logged but still ACKed with 200.

## Data flow

```
Meta POST /webhook (any channel)
   |
   v
express.json({ verify }) -- captures req.rawBody before parse
   |
   v
createMetaSignatureVerifier -- HMAC-SHA256 over rawBody, constant-time compare
   |           \
   | 401 invalid_signature / 400 raw_body_unavailable
   v
ACK 200 EVENT_RECEIVED  (sent first; processing is async, fire-and-forget)
   |
   v
dispatchWebhook(req.body)
   |       \-- objectToChannel(req.body.object) -> whatsapp | messenger | instagram | unknown
   v
parseMetaWebhook(req.body) -> ParseResult { messages, statuses }
   |  (non-throwing; dispatcher catches any unexpected throw and logs at error)
   v
per-message log (inbound.message; warn iff type==='unknown')
per-status  log (inbound.status)
summary     log (inbound.{channel}; warn for unknown)
   |
   v
ConversationAgent (Stage 5) -- per parsed message: handleInbound; per status: handleStatus
   |  (sequential awaited loop, preserving intra-webhook order; agent OPTIONAL on createApp)
   |
   |  handleInbound: echo filter -> SETNX dedupe (claimInboundHandle)
   |               -> append to buffer (state: buffering) -> (re)arm flush timer
   v
buffer flush (timer; state: processing)
   |  snapshot+clear buffer -> ChatClient.complete(ChatRequest)
   v
normalizeChatResponse -> ChatAction[]  -> buildOutboundItems (capability-gated)
   |
   v
ordered outbound queue (state: sending) -> ChannelAdapter (see Outbound path below)
   |  WhatsApp advances on sent/delivered status (handleStatus); Messenger/IG advance on send
   v
queue complete / silence / chat error -> state: idle
   |
   v
[Stage 6+ PLANNED: StatusTracker, IdentityResolver, MetricsCollector]
```

Per-conversation flows are serialized by a per-key async lock (`runExclusive`) so
concurrent inbounds/statuses for one conversation can't clobber the
clone-on-write store; different keys still run concurrently. See
[Conversation state](./features/conversation-state.md).

### Outbound path (Stage 5 — wired to the conversation agent)

```
ConversationAgent.sendNext   -- ordered, channel-aware advancement; typing injected before text
   |  sendText / sendTypingIndicator / markRead / sendReaction (+ WhatsApp sendTemplate)
   v
ChannelAdapter            -- one of WhatsAppClient / MessengerClient / InstagramClient
   |  (owns channel body shapes: messaging_product / recipient / sender_action / template)
   v
GraphClient.request       -- shared transport: versioned URL, Bearer header,
   |                          retry/backoff (429 + network always; 5xx only if idempotent —
   |                          POST sends are non-idempotent, so a 5xx is NOT retried)
   v
Meta Graph API            -- graph.facebook.com (WhatsApp/Messenger) or graph.instagram.com (Instagram)
```

The conversation agent now drives the Stage 4 clients at runtime. See
[Ordered delivery](./features/ordered-delivery.md) and
[Outbound clients](./features/outbound-clients.md).

Meta retries any non-2xx response with exponential backoff for up to 7 days, then permanently drops the event. There is no replay API. The handler is the dead-letter queue. The POST route sends the 200 before invoking the dispatcher.

## Currently implemented (Stages 1–5)

| Module | Source | Role |
| --- | --- | --- |
| Config loader | [`src/config/loader.ts`](../src/config/loader.ts) | Reads env, validates per-channel pairs, throws on partial config or missing required fields. Defaults `META_GRAPH_API_VERSION` to `v25.0`. Requires `NGROK_DOMAIN` (bare hostname; validated against scheme/path/dot). Exposes optional `WhatsAppConfig.businessAccountId` for the per-WABA subscribe step. Stage 5 adds the nested `conversation` section (buffer timing, typing, delivery timeout, dedupe TTL, chat timeout) with per-knob validation and a `bufferMaxTimeoutMs >= bufferBaseTimeoutMs` cross-check. |
| Signature verifier | [`src/http/security.ts`](../src/http/security.ts) | `verifyMetaSignature(rawBody, header, appSecret)` and the Express middleware factory `createMetaSignatureVerifier`. Constant-time compare; rejects malformed/short hex without throwing on `timingSafeEqual`. |
| Express app | [`src/http/app.ts`](../src/http/app.ts) | `createApp({ config, logger, agent? })`. Mounts `GET /health`, `GET /webhook`, `POST /webhook`. Captures raw body via `express.json({ verify })`. Defines `objectToChannel` and `dispatchWebhook` for channel routing, parsing, and structured per-event logging. When an `agent` is supplied, `dispatchWebhook` routes each parsed message into `agent.handleInbound` and each status into `agent.handleStatus` (sequential awaited loop, after the logs, preserving intra-webhook order); the agent is optional so the parse+log shapes are unchanged without it. |
| Webhook types | [`src/meta/types.ts`](../src/meta/types.ts) | Raw per-channel envelopes (`WhatsAppWebhookPayload`, `MessengerWebhookPayload`, `InstagramWebhookPayload`) plus normalized cross-channel shapes (`IncomingMessage`, `StatusUpdate`, `ParseResult`, `MessageType`, supporting info types). |
| Webhook parser | [`src/meta/parser.ts`](../src/meta/parser.ts) | `parseMetaWebhook` dispatcher + `parseWhatsAppWebhook` / `parseMessengerWebhook` / `parseInstagramWebhook`. Non-throwing; normalizes timestamps to ms, unflips echoes, per-payload dedupe by `channelMessageId`, CTWA / Flow / forwarded / story-mention / story-reply surfacing. See [Message parsing](./features/message-parsing.md). |
| Graph error | [`src/meta/shared/errors.ts`](../src/meta/shared/errors.ts) | Canonical `MetaApiError` (operation / httpStatus / errorCode / errorSubCode / fbtraceId / responseBody / cause). Dependency-free; re-exported by `scripts/lib/graph-api.ts` so setup and runtime share one error class. Callers branch on codes, not message strings. |
| Graph client | [`src/meta/shared/graph-client.ts`](../src/meta/shared/graph-client.ts) | Runtime HTTP transport: versioned URL build (`graph.facebook.com` + `graph.instagram.com`), `Authorization: Bearer` auth, error parsing into `MetaApiError`, retry/backoff (429 + pre-response network on any method; 5xx only when idempotent — POST sends are non-idempotent, so a 5xx is NOT retried for double-send safety). Transport-only; injectable `fetchImpl` / `sleep`. SEPARATE from the setup-time `graphFetch` in `scripts/lib/graph-api.ts`. |
| Channel adapter | [`src/meta/shared/adapter.ts`](../src/meta/shared/adapter.ts) | `ChannelAdapter` interface (`sendText`, `sendTypingIndicator`, `markRead`, `sendReaction`, `supports`) + `SendResult` / `SendOptions` / `ChannelFeature`. Uniform cross-channel signature so the conversation agent dispatches without per-channel branching; capabilities surfaced via `supports()` rather than throwing. |
| WhatsApp client | [`src/meta/whatsapp/client.ts`](../src/meta/whatsapp/client.ts) | `ChannelAdapter` over `GraphClient`. `POST {phoneNumberId}/messages` for text / typing (combined with mark-read, needs inbound wamid) / mark-read / reaction (empty emoji = unreact). Adds `sendTemplate` for out-of-window messaging. `supports`: typing/read/reaction/reply_to/template = true. |
| Messenger client | [`src/meta/messenger/client.ts`](../src/meta/messenger/client.ts) | `ChannelAdapter` over `GraphClient`. `POST {pageId}/messages`. `sender_action` (typing / mark_seen / react / unreact) is a SEPARATE request from a message; `messaging_type` default `RESPONSE`, top-level `tag` required for `MESSAGE_TAG`; top-level `reply_to.mid` thread replies (sibling of `message`, live-verified 2026-05-20). `supports`: typing/read/reaction/reply_to = true. |
| Instagram client | [`src/meta/instagram/client.ts`](../src/meta/instagram/client.ts) | `ChannelAdapter` over `GraphClient` on host `graph.instagram.com`. `POST {igUserId}/messages` for text / typing / mark_seen / react-unreact. NO outbound quoted reply — `opts.replyTo` is ignored (Instagram-Login Send API rejects/ignores every `reply_to` shape, live-verified 2026-05-20; agent downgrades reply→message). Minimal in-process rate pacer (default 100ms inter-call floor, `minIntervalMs`-overridable; Stage 10 replaces it). `supports`: typing/read/reaction = true, reply_to = false. |
| Conversation types | [`src/conversation/types.ts`](../src/conversation/types.ts) | `ConversationRecord` (one per channel/business/user), `ConversationStateName`, the per-channel key builders + `conversationKeyFor`, `OutboundHandleMapping`, `createIdleConversation`, the 24h `MESSAGING_WINDOW_MS` + `isWindowOpen`. See [Conversation state](./features/conversation-state.md). |
| Conversation store | [`src/conversation/store.ts`](../src/conversation/store.ts) | `ConversationStore` interface + `InMemoryConversationStore`: conversation records (clone-on-read/write), inbound dedupe (`claimInboundHandle` SETNX-with-TTL), outbound-handle map (`mapOutboundHandle`/`getOutboundHandleMapping`), `listConversationKeys`. In-memory/per-process; Redis impl is Stage 10. |
| Buffering | [`src/conversation/buffering.ts`](../src/conversation/buffering.ts) | `calculateBufferTimeout` — pure growth-with-jitter curve (base × growth^(n-1), capped, clamped jitter). Aggregates a burst into one flush. See [Message buffering](./features/message-buffering.md). |
| Buffer scheduler | [`src/conversation/scheduler.ts`](../src/conversation/scheduler.ts) | `BufferScheduler` interface + `InMemoryBufferScheduler` (one setTimeout per key; reschedule replaces). `kind`/`getStats` shared with the future BullMQ impl (Stage 10). `delayMs <= 0` fires inline — the agent never passes that (load-bearing). |
| Chat contract | [`src/chat/types.ts`](../src/chat/types.ts), [`src/chat/contract.ts`](../src/chat/contract.ts) | `ChatRequest`/`ChatResponse`/`ChatAction` shapes; `normalizeChatResponse` collapses legacy (`message`/`messages`/`silence`) + rich `actions[]` into one `ChatAction[]` (mixed-silence drop, invalid-action drop, unknown-shape throw). See [Rich chat actions](./features/rich-chat-actions.md). |
| Chat client | [`src/chat/client.ts`](../src/chat/client.ts), [`src/chat/errors.ts`](../src/chat/errors.ts) | `HttpChatClient.complete` POSTs the `ChatRequest` to `CHAT_ENDPOINT_URL` with an `AbortController` timeout; every failure mode surfaces as one `ChatEndpointError`; returns an already-normalized response. |
| Delivery queue | [`src/delivery/queue.ts`](../src/delivery/queue.ts), [`src/delivery/types.ts`](../src/delivery/types.ts) | Pure logic: `buildOutboundItems` (capability-gated action→item mapping, reply→message downgrade), `advancementMode`/`statusAdvancesQueue` (WhatsApp `on_status`, Messenger/IG `on_send`), cursor helpers. See [Ordered delivery](./features/ordered-delivery.md). |
| Conversation agent | [`src/conversation/agent.ts`](../src/conversation/agent.ts) | `ConversationAgent` state machine (`idle → buffering → processing → sending → idle`): inbound buffering, chat dispatch, ordered channel-aware outbound, delivery-timeout fallback, typing injection, the per-key serialization lock (`runExclusive`), fail-soft `handle*`. See [Conversation state](./features/conversation-state.md). |
| Bootstrap | [`src/index.ts`](../src/index.ts) | Loads `.env`, builds a pino logger (pretty in non-prod), constructs the full Stage 5 graph (`GraphClient`, per-channel `ChannelAdapter`s, `InMemoryConversationStore`, `InMemoryBufferScheduler`, `HttpChatClient`, `ConversationAgent`), calls `createApp({ config, logger, agent })`, and `app.listen()` unless `AGENT_AUTOSTART=0` or `NODE_ENV=test`. Wires SIGINT/SIGTERM (closes the agent before the server). |
| Setup library | [`scripts/lib/`](../scripts/lib/) | `tunnel.ts` (ngrok via `@ngrok/ngrok`), `graph-api.ts` (`buildGraphUrl`, `buildInstagramGraphUrl`, `MetaApiError`, `graphFetch`, `subscribeMessengerPageApp`, `subscribeInstagramApp`, `subscribeWhatsAppBusinessAccount`, `setWebhookSubscriptionConfig`, `listWebhookSubscriptions`), `console.ts` (status helpers, `ask` / `confirm` / `pause` / `waitFor`, `registerShutdown` registry), `capture-server.ts` (Express + tunnel + in-memory ring with the same signature middleware as production). |
| Setup scripts | [`scripts/setup/`](../scripts/setup/) | `register-webhooks.ts` (`registerAllWebhooks`, `inspectExistingSubscriptions`, `SUBSCRIBED_FIELDS`), `oauth-instagram.ts` (Business Login OAuth → ~60d long-lived token), `oauth-messenger.ts` (Facebook Login for Business OAuth → User Token → `/me/accounts` → scope-controlled Page Access Token), `verify-shared.ts` (bootstrap + predicates + summary), `verify-{whatsapp,messenger,instagram,all}.ts` (per-channel guided verification). |
| Capture scripts | [`scripts/capture/`](../scripts/capture/) | `fixture-capture.ts` (passive capture, one file per delivery), `guided-capture.ts` (scenario walker emitting self-describing wrappers under `.captures/meta/{channel}/`). |
| Unit tests | [`tests/unit/`](../tests/unit/) | Config loader (76), security middleware (28), parser (63), parser-captured (32), graph-api helpers (37), register-webhooks (17), oauth-instagram pure helpers (27), oauth-messenger pure helpers (24), verify-shared CLI + predicates + summary (36), capture-server (10), fixture-capture pure helpers (10), guided-capture scenarios + flag parser (26). Stage 4 outbound: graph-client (24), meta-errors (7), whatsapp-client (13), messenger-client (17), instagram-client (16). Stage 5 conversation: conversation-agent (22 — includes the concurrent-same-key serialization regression), conversation-buffering (10), conversation-scheduler (11), conversation-store (17), conversation-types (15), chat-contract (30), chat-client (10), delivery-queue (17). See [Testing](./TESTING.md). |
| Integration tests | [`tests/integration/`](../tests/integration/) | Full Express pipeline via supertest. `webhook-routing.test.ts` (15): dispatcher routing, per-channel summary / per-message / per-status logs, signature rejection, handshake, `/health` liveness, the dispatcher's defensive catch. `end-to-end-flow.test.ts` (6): the full inbound path with real store/scheduler/queue/agent and only the chat endpoint + adapters faked — webhook → signature → parse → buffer flush → chat → ordered send, plus dedupe and the multi-message per-key-lock proof. |
| Fixtures | [`tests/fixtures/meta/{whatsapp,messenger,instagram}/`](../tests/fixtures/meta/) | Documentation-derived payloads exercising every parser branch. See [Testing](./TESTING.md) for the inventory. |

`scripts/lib/capture-server.ts` is a **separate Express app** from `src/http/app.ts`. The runtime path dispatches to the conversation agent (Stage 5); the capture path records bit-faithful payloads without side effects. Both apply the same signature middleware so app-secret typos still fail at the door, but they diverge after the verification step — the capture path emits an in-memory event + an on-disk file rather than calling the dispatcher. See [Payload capture](./features/payload-capture.md) for the rationale.

## Planned (Stages 6–10)

The implementation plan ([`meta-ai-agent-implementation-plan.md`](../meta-ai-agent-implementation-plan.md)) defines the staged rollout. None of the following exists in `src/` yet (Stage 5's conversation agent, chat contract, and delivery queue are listed under [Currently implemented](#currently-implemented-stages-15) above).

Still **PLANNED** as of Stage 5: the identity resolver (so `contact` is undefined for now), metrics, rate limiting, and persistence (the Redis store + BullMQ scheduler that swap in on `REDIS_URL` — Stage 5 ships the in-memory store/scheduler only). Media send is also still pending (Stage 7).

- **Stage 6 — Status tracking, identity, operational visibility.** `src/status/tracker.ts`, `src/identity/{resolver,contact-store}.ts`, `src/metrics/{collector,prometheus}.ts`, `src/http/{trace,auth,redaction}.ts`. New routes: `GET /ready`, `GET /metrics` (token-gated), `GET /admin/conversations/:key`, `GET /admin/status/:messageId`. The conversation agent already threads a `traceId` and surfaces `contact` on the request — both become live once Stage 6 wires trace middleware and the identity resolver.
- **Stage 7 — Rich features.** Media send/download (`src/meta/shared/media.ts`) and richer template helpers (`src/meta/whatsapp/templates.ts`). `ChannelAdapter` gains `sendImage`, `sendAudio`, `sendVideo`, `sendDocument` (`supports('media_send')` flips to true). Note: reactions, reply-to, and basic WhatsApp templates already landed in Stage 4.
- **Stage 8 — Platform-specific surfaces.** Messenger Profile API (Get Started button, Persistent Menu, Ice Breakers, greeting text), Instagram Ice Breakers, Instagram Private Replies (comment → DM with `recipient: { comment_id }`).
- **Stage 9 — Examples and REPL.** `examples/{minimal-chat-endpoint,multi-channel-router,showcase-bot}/`, `scripts/repl.ts`.
- **Stage 10 — Production hardening.** Redis persistence (conversation state, dedupe via `SET NX`, BullMQ for delayed buffer processing), per-channel rate limiting, WhatsApp messaging-window awareness, boot-time `recoverPendingRetries`, additional `loadConfig` validation (token format, version regex).

## Key design decisions

- **Single endpoint for three products.** Routing by `object` is simpler and matches Meta's design (one App, one webhook URL, one secret). It also keeps signature verification uniform across channels.
- **Raw-body capture before parsing.** `express.json({ verify })` is the only safe place to copy the bytes Meta signed — by the time the JSON body lands on `req.body`, whitespace and key order are gone. Any future middleware that needs to read the body must respect `req.rawBody`.
- **ACK before dispatch.** The POST handler sends `200 EVENT_RECEIVED` before calling `dispatchWebhook`. Meta's retry behavior (7 days of exponential backoff) means slow processing would queue thousands of duplicate deliveries. This is non-negotiable.
- **Identity is a tuple, not a unified user.** Meta does not link `wa_id`, PSID, and IGSID. The package will model identity as `(channel, channelScopedId)` and leave cross-channel merging to the developer's identity resolver (Stage 6).
- **Adapters expose capabilities, not a uniform feature set.** All three clients share the `ChannelAdapter` *signature*, but `supports('template')` returns `false` for Messenger and Instagram (it is a WhatsApp concept). The conversation agent branches on capability (via `buildOutboundItems` gating) rather than assuming features are uniformly available. See [Outbound clients](./features/outbound-clients.md) for the full matrix.
- **Per-conversation serialization, not a global lock.** The Stage 5 store is pass-by-value with last-write-wins, so two concurrent flows for one conversation can clobber each other's record (a confirmed message-dropping race). The agent serializes per key via a promise tail (`runExclusive`); different keys still run concurrently. Entry points acquire the lock; internal helpers stay lock-free. See [Conversation state](./features/conversation-state.md).
- **Channel-aware queue advancement.** WhatsApp emits per-message delivery statuses, so its outbound queue waits for a `sent`/`delivered` webhook (`on_status`) with a delivery-timeout fallback. Messenger/Instagram have no reliable per-message delivery callback, so their queue advances on the successful send response (`on_send`). One queue abstraction, two confirmation rules. See [Ordered delivery](./features/ordered-delivery.md).
- **Outbound 5xx is not retried on POST (double-send safety).** The shared `GraphClient` retries `429` and pre-response network failures on any method, but a `5xx` only when the request is idempotent. Sends are POST and non-idempotent, so an ambiguous post-acceptance 5xx is surfaced rather than retried. See [Outbound clients](./features/outbound-clients.md).

## Known limitations (Stages 1–5)

- Conversation state, dedupe, and the buffer scheduler are **in-memory and per-process** (`InMemoryConversationStore` + `InMemoryBufferScheduler`). State is lost on restart and the per-replica view diverges in a multi-replica deploy; the in-memory dedupe map is never swept (it relies on the later Redis TTL). The Redis store + BullMQ scheduler swap in on `REDIS_URL` in Stage 10.
- No identity resolution — the `ChatRequest.contact` field exists but is always undefined (Stage 6). No metrics yet — the scheduler's failure catch is a TODO for Stage 6.
- A failed outbound send is marked skipped and the queue advances; there is no retry yet (Stage 10). The 24h window is tracked and surfaced as `context.windowOpen` but not enforced — no out-of-window block or WhatsApp template fallback (Stage 10).
- Outbound clients cover text, typing, read receipts, reactions, and (WhatsApp) templates only. No media send (`supports('media_send')` is false everywhere — Stage 7); media chat actions are skipped before they reach the queue.
- The Instagram client's rate pacer is a coarse in-process 100ms floor, not the real per-second + hourly model and not cross-replica aware (Stage 10's `LimitTracker`).
- Fixtures under `tests/fixtures/meta/` are documentation-derived. Real Meta payloads always differ in subtle ways; the Stage 3 `npm run capture:guided` tooling exists for this exact purpose — promoted captures land under `tests/fixtures/meta/captured/` after manual redaction.
- See [Known gaps](./KNOWN-GAPS.md) for items intentionally deferred (CTWA pricing/conversation blocks, order/contact attachments, IG `story_mention.id` semantics, Dashboard programmatic config gaps, token refresh automation).
