# Known Gaps and Deferrals

A running list of items surfaced during code review or implementation that were intentionally deferred to a later stage. Recording them here keeps the institutional memory from getting lost between stages — if you are working on the stage listed, treat the entry as a TODO.

## Open as of Stage 9 (examples, local REPL)

These cover the Stage 9 example/dev surface. None affect the runtime package — they are deliberate scoping choices for reference/dev tooling. See [`examples/README.md`](../examples/README.md) and [Architecture → Examples & local development](./ARCHITECTURE.md#examples--local-development-stage-9).

- **The showcase-bot now runs on the Vercel AI SDK's multi-step tool loop (the prior raw-SDK hand-rolled loop / reaction-only-no-text bug is RESOLVED)** — `examples/showcase-bot` was rewritten off the raw `@anthropic-ai/sdk` (which used a hand-rolled message/tool loop that could return a reaction with no accompanying text) onto the **Vercel AI SDK**: `generateText({ ..., stopWhen: stepCountIs(maxSteps) })` drives the model → tool → model round-trip for free, so the model emits its real text answer AFTER any side-effect tool calls. It is multi-provider via a provider registry (`ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai`). NOT A GAP — recorded here to close out the prior note.
  - **Where**: [`examples/showcase-bot/src/llm.ts`](../examples/showcase-bot/src/llm.ts) (`generateText` + `stopWhen`), [`examples/showcase-bot/src/tools.ts`](../examples/showcase-bot/src/tools.ts). Documented in [`examples/showcase-bot/README.md`](../examples/showcase-bot/README.md).
  - **When**: Done (this revision).

- **The showcase-bot keeps an in-memory, unbounded conversation history (demo only)** — `examples/showcase-bot` stores per-`conversationKey` history in a process-local `Map` (in `llm.ts`) that grows for the life of the process and is lost on restart, with no TTL/eviction or context compaction for very long chats. Fine for a demo; a real deployment would back this with a store that has TTL/eviction (and likely server-side compaction). The bot is also a SEPARATE npm package outside the root tsc/test suite (its own Vercel AI SDK + media/STT deps), so the root `npm test` does not exercise it (verify with its own `npm run typecheck`).
  - **Where**: [`examples/showcase-bot/src/llm.ts`](../examples/showcase-bot/src/llm.ts) (`history` Map; the in-code note). Documented in [`examples/showcase-bot/README.md`](../examples/showcase-bot/README.md).
  - **When**: No code change planned — it is a demo. A production endpoint owns its own history store.

- **The standalone showcase-bot can't download WhatsApp id-only inbound media (no Graph token), so it describes it textually** — WhatsApp delivers inbound media as a bare media id that must be fetched via a 2-step authenticated Graph download (Bearer token). The showcase-bot is a standalone endpoint with NO Meta Graph token of its own, so for an id-only WhatsApp media reference it cannot fetch the bytes; its media-processor falls back to describing the attachment textually rather than processing it (images from Messenger/Instagram, which arrive as pre-signed fetchable URLs, ARE downloaded and sent to the model multimodally). A production endpoint that owns a Graph token would download and process it.
  - **Where**: [`examples/showcase-bot/src/media-processor.ts`](../examples/showcase-bot/src/media-processor.ts). Documented in [`examples/showcase-bot/README.md`](../examples/showcase-bot/README.md).
  - **When**: By design for a token-less demo endpoint; a real consumer with a Graph token downloads the media. **Cross-reference:** the transport's opt-in inbound media hydration (next entry) is the DEPLOY-TIME fix for this exact standalone limitation — wired behind the transport (which holds the WhatsApp token), the chat endpoint receives a ready base64 `data:` URL instead of an id-only reference it can't fetch.

- **Inbound media hydration tradeoffs (opt-in transport feature)** — when `INBOUND_MEDIA_DOWNLOAD=true`, the transport downloads inbound media on the flush path and attaches a base64 `data:` URL on `message.media.dataUrl` so the chat endpoint can see media it can't fetch itself (notably the WhatsApp id-only case above). The tradeoffs are deliberate, recorded here so a deployer can weigh them: (1) base64 inflates the request body **~33%** over the raw bytes, so it stays OFF by default; (2) the per-attachment `INBOUND_MEDIA_MAX_BYTES` cap (default 5 MiB) **silently drops** over-cap media — the raw id/url is left intact and the turn proceeds (fail-open), so the endpoint just won't get a `dataUrl` for a large asset; (3) the WhatsApp 2-hop fetch requires the WhatsApp **access token** (`config.whatsapp?.accessToken`) — without it, WhatsApp media is not hydrated (Messenger/IG pre-signed URLs still are); (4) like the rest of the media subsystem, the whole asset is **buffered in memory** (no streaming), so the in-memory-only Stage 7 gap below applies to hydration too.
  - **Where**: [`src/meta/shared/media-hydrator.ts`](../src/meta/shared/media-hydrator.ts), the flush-path call in [`src/conversation/agent.ts`](../src/conversation/agent.ts) (`flushImpl`), the `INBOUND_MEDIA_DOWNLOAD` / `INBOUND_MEDIA_MAX_BYTES` knobs in [`src/config/loader.ts`](../src/config/loader.ts). Documented in [Media hydration](./features/media-hydration.md).
  - **When**: By design — opt-in with a size cap; a streaming/size-bounded path moves with the Stage 7 "fully buffered in memory" item below.

- **Speech-to-text in the showcase-bot requires `GROQ_API_KEY`; without it, audio is described, not transcribed** — voice notes are transcribed via Groq Whisper. When `GROQ_API_KEY` is unset, the STT step is skipped and the audio is surfaced to the model as a textual description (`[a voice message]`) rather than its transcript, so the bot can still respond but without the spoken content. Set `GROQ_API_KEY` in the showcase-bot's own `.env` to enable transcription.
  - **Where**: [`examples/showcase-bot/src/stt/`](../examples/showcase-bot/src/stt/) (`groq.ts`, `index.ts`), wired in [`media-processor.ts`](../examples/showcase-bot/src/media-processor.ts). Documented in [`examples/showcase-bot/README.md`](../examples/showcase-bot/README.md).
  - **When**: By design — STT is an opt-in dependency keyed on the provider credential.

- **The local REPL fakes the channel adapters (no real Meta sends) and uses low buffer timeouts** — `npm run example:chat` (`scripts/repl.ts`) substitutes "console" `ChannelAdapter`s that PRINT each outbound instead of calling the Graph API, so it runs the full inbound→chat→outbound loop with no Meta account / no network. Its `supports()` mirrors the real adapters so nothing is downgraded, but no message is actually sent. It also overrides the production buffer timing (150ms base / 400ms max instead of 2s/8s) and the typing delay so the REPL feels snappy rather than frozen between lines — so the REPL does NOT exercise the production timing curve. To send through real Meta, use `npm run example:dev` (real `buildRuntime` stack) or the live-device flow.
  - **Where**: [`scripts/repl.ts`](../scripts/repl.ts) (`createConsoleAdapter`, `buildReplConfig`'s `bufferBaseTimeoutMs`/`bufferMaxTimeoutMs`/`typingRefreshIntervalMs`).
  - **When**: By design — the REPL is a no-Meta-account harness, not a fidelity test of timing or real sends.

- **`example-dev` boots only the four in-repo chat endpoints in-process; the showcase bot and identity-lookup run separately** — `npm run example:dev` (`scripts/example-dev.ts`) imports and boots `minimal-chat-endpoint` / `multi-channel-router` / `action-catalog` / `scripted-flow` in-process and overrides `config.chatEndpointUrl` to point the real agent at them. It canNOT boot `examples/showcase-bot` (a separate npm package with its own dependencies the root never installs) nor `examples/identity-lookup` (a `USER_LOOKUP_URL` stub, not a chat endpoint). To exercise the showcase bot live, run it standalone (`cd examples/showcase-bot && npm install && npm start`), set `CHAT_ENDPOINT_URL` to it, and start the agent with `npm run dev` (not `npm run dev:loop`, which overrides `CHAT_ENDPOINT_URL` with its own in-process keyword test endpoint).
  - **Where**: [`scripts/example-dev.ts`](../scripts/example-dev.ts) (the `EXAMPLES` registry + the WHY-the-showcase-bot-is-NOT-booted-here note).
  - **When**: By design — the model-provider-free root cannot import a model-SDK package in-process; identity-lookup implements a different contract.

- **The `scripted-flow` and `action-catalog` examples keep in-memory, per-process state (demo only)** — `scripted-flow` walks its coffee-order arc using a process-local `FlowStore` (the default `createInMemoryFlowStore()`) keyed by `req.conversationKey`, and it also tracks last-seen message ids in-process for its duplicate→silence dedupe; that state is lost on restart and is NOT shared across multiple processes/instances. (`action-catalog` is itself stateless — pure keyword→shape — but is driven through the same per-process runners.) Fine for a single-process demo; a horizontally-scaled deployment would back the flow state with a shared store. The `scriptedFlowResponse` handler accepts an injectable `FlowStore` precisely so a real consumer can swap in a durable/shared one.
  - **Where**: [`examples/scripted-flow/index.ts`](../examples/scripted-flow/index.ts) (`createInMemoryFlowStore`, the injectable `FlowStore` seam). Documented in [`examples/scripted-flow/README.md`](../examples/scripted-flow/README.md).
  - **When**: By design for a demo; a production flow injects a shared/durable store.

- **The in-repo examples import the chat-contract types via relative `src/` paths** — the four chat endpoints (`minimal-chat-endpoint`, `multi-channel-router`, `action-catalog`, `scripted-flow`) and the `identity-lookup` stub `import type ... from '../../src/...'` because they live inside the repo (and so participate in the root dev typecheck). A real consumer installs the package and imports the same types from `meta-ai-agent` (e.g. `import type { ChatRequest } from 'meta-ai-agent'`); the examples carry an in-file note saying so. (The showcase-bot, being a separate package, instead keeps field-for-field local copies of the contract types.)
  - **Where**: [`examples/minimal-chat-endpoint/index.ts`](../examples/minimal-chat-endpoint/index.ts), [`examples/multi-channel-router/index.ts`](../examples/multi-channel-router/index.ts), [`examples/action-catalog/index.ts`](../examples/action-catalog/index.ts), [`examples/scripted-flow/index.ts`](../examples/scripted-flow/index.ts), [`examples/identity-lookup/index.ts`](../examples/identity-lookup/index.ts) (the relative import + the "A real consumer installs the package" note).
  - **When**: No change while the examples live in-repo; a published-package consumer imports from the package entry point.

## Open as of Stage 8 (platform-specific surfaces)

### Meta API fidelity (worth live-verifying)

- **The Get-Started-required error code (2018145) is empirically-observed, not documented by Meta** — `MessengerProfileClient.setPersistentMenu` reclassifies the "you must set a Get Started button before a persistent menu" rejection into a clear, actionable error. Meta DOCUMENTS the requirement (Get Started must precede a persistent menu) but does NOT publish the numeric code; **2018145 was observed empirically**. It is isolated as a named constant (`GET_STARTED_REQUIRED_ERROR_CODE`) and matched on `errorCode` **OR** `errorSubCode` (Meta may surface it as either). If Meta changes the code, the reclassification silently stops firing (the raw error still propagates — no data loss, just a less friendly message). Worth confirming the code against the live API and updating the constant if it drifts.
  - **Where**: [`src/meta/messenger/profile.ts`](../src/meta/messenger/profile.ts) (`GET_STARTED_REQUIRED_ERROR_CODE`, `setPersistentMenu`). Documented in [Messenger profile](./features/messenger-profile.md).
  - **When**: Live-verify during a Stage 9 (examples / device testing) Messenger session; no code change otherwise.

- **Instagram ice-breaker endpoint/host + the `platform` field are per Meta docs and should be live-verified** — `InstagramIceBreakers` configures ice breakers via `messenger_profile` on `graph.instagram.com` (the Instagram-Login flavor), carrying the required `platform:'instagram'` field on every set/get/delete. The body shapes match Meta's documented ice-breaker schema, and the source carries a reviewer note flagging the host/path for confirmation — Meta has historically served some IG profile config from `graph.facebook.com/{IG_USER_ID}/...` under the Facebook-Login flavor. Like other IG specifics in this package (e.g. the PDF `file` document, the no-`reply_to` finding), this is worth confirming against the live API.
  - **Where**: [`src/meta/instagram/ice-breakers.ts`](../src/meta/instagram/ice-breakers.ts) (the ENDPOINT/HOST reviewer note, `INSTAGRAM_PLATFORM`). Documented in [Instagram platform](./features/instagram-platform.md).
  - **When**: Live-verify during a Stage 9 IG session.

### Client-side validation not enforced

- **Instagram private-reply 7-day window is not enforced client-side** — `InstagramClient.sendPrivateReply` sends a single comment-to-DM message that must land within **7 days** of the comment (distinct from the 24h messaging window). The client does NOT check the age — it sends as-is and lets Meta reject a late call (or a second reply to the same comment), which surfaces as a `MetaApiError` for the caller to fail-soft on. This mirrors the deliberate fail-soft posture elsewhere (e.g. the IG PDF `file` document): we don't duplicate Meta's window bookkeeping client-side.
  - **Where**: [`src/meta/instagram/client.ts`](../src/meta/instagram/client.ts) `sendPrivateReply` (the 7-DAY WINDOW comment). Documented in [Instagram platform](./features/instagram-platform.md) and [Outbound clients](./features/outbound-clients.md).
  - **When**: No code change planned — Meta rejects late ones; fail-soft is sufficient.

- **The persistent-menu CTA cap (20) is not validated client-side** — `MessengerProfileClient.setPersistentMenu` passes the `call_to_actions` list through and lets **Meta** validate the ≤20-top-level-CTA cap (its error names the exact limit). This is asymmetric with the ice-breaker cap (≤4 per locale), which **is** validated locally with a clear named throw. The asymmetry is deliberate — only the ice-breaker count is enforced up front — but a future change could add a local ≤20 check for parity.
  - **Where**: [`src/meta/messenger/profile.ts`](../src/meta/messenger/profile.ts) `setPersistentMenu`. Documented in [Messenger profile](./features/messenger-profile.md).
  - **When**: Optional polish; no change planned (Meta's error is specific enough).

## Open as of Stage 7 (media send, WhatsApp templates)

### Media scope

- **Media is fully buffered in memory (no streaming)** — both the WhatsApp upload (`uploadWhatsAppMedia`) and the download utilities (`downloadWhatsAppMedia` / `downloadAttachmentUrl`) read the entire asset into a `Uint8Array` in memory; the per-channel media SENDs are URL-based (or a WhatsApp media_id) and never touch the bytes. There is no streaming path, so a very large asset is held whole in memory. Acceptable for typical message media; a streaming/size-bounded path is deferred.
  - **Where**: [`src/meta/shared/media.ts`](../src/meta/shared/media.ts). Documented in [Media send](./features/media.md).
  - **When**: Stage 10+ (streaming / size limits, alongside the production hardening pass).

- **Untyped media infers `document`** — `inferMediaKind(undefined)` returns `document`, so a `{type:'media'}` chat action with no `mimeType` is sent as a document. On WhatsApp that is a document body with a derived filename (usually fine); on Instagram a document is a **PDF-only `file`** attachment, so a non-PDF asset sent untyped is rejected by Meta (then skipped fail-soft) rather than delivered as its real kind. This is a deliberate default, not a bug: **supply a `mimeType` on media actions** so the kind routes correctly, especially for Instagram.
  - **Where**: [`src/meta/shared/media.ts`](../src/meta/shared/media.ts) `inferMediaKind`, [`src/conversation/agent.ts`](../src/conversation/agent.ts) `sendNext` media case. Documented in [Media send](./features/media.md).
  - **When**: No code change planned — the guidance is to set `mimeType`. Revisit only if the chat contract gains a way to assert the kind explicitly.

- **Instagram `file` (PDF) document support is per Meta docs and should be live-verified** — `InstagramClient.sendDocument` sends a document as an IG `file` attachment, which Meta documents as **PDF-only and ~25MB**. The client does NOT validate MIME or size; it sends as-is and lets Meta reject a non-PDF / oversized file (caught fail-soft by the agent). This behavior is taken from Meta's "Instagram API with Instagram Login — messaging" reference and, like other IG specifics in this client, is worth confirming against the live API.
  - **Where**: [`src/meta/instagram/client.ts`](../src/meta/instagram/client.ts) `sendDocument`. Documented in [Media send](./features/media.md) and [Outbound clients](./features/outbound-clients.md).
  - **When**: Live-verify during a Stage 9 (examples / device testing) IG session.

- **WhatsApp media-download token-on-redirect relies on undici stripping `Authorization` cross-origin** — `downloadWhatsAppMedia`'s binary GET sends the Bearer token (WhatsApp's CDN requires it). The resolved lookaside URL is terminal and we do not expect a cross-origin 3xx, but the safety against leaking the token to a foreign origin on an unexpected redirect rests on `fetch`/undici stripping the `Authorization` header on a cross-origin redirect (verified to hold in current undici; recorded in a load-bearing comment). If that strip behavior ever changes, switch the GET to `redirect: 'manual'` and re-resolve rather than auto-follow with the token attached.
  - **Where**: [`src/meta/shared/media.ts`](../src/meta/shared/media.ts) `downloadWhatsAppMedia` (the TOKEN-LEAK-ON-REDIRECT comment). Documented in [Media send](./features/media.md).
  - **When**: No action today; revisit if a Node/undici upgrade changes cross-origin redirect header handling.

### Out-of-window templates

- **Out-of-window WhatsApp template enforcement is deferred** — Stage 7 ships `WhatsAppClient.sendTemplate` + `buildTemplateComponents`, and the chat request already carries `context.windowOpen` (and `context.windowExpiresAt` when known), so the endpoint can *choose* a template when the window is closed. But the agent does NOT require a template when the window is closed — it does not block an out-of-window plain send or force a template fallback. A reply attempted after the window closes simply fails at the Meta API and is skipped fail-soft. (This is the template-side view of the "24h messaging window is tracked but not enforced" Stage 5 gap below.)
  - **Where**: [`src/meta/whatsapp/templates.ts`](../src/meta/whatsapp/templates.ts), [`src/meta/whatsapp/client.ts`](../src/meta/whatsapp/client.ts) `sendTemplate`, [`src/conversation/agent.ts`](../src/conversation/agent.ts) (window stamped on inbound, surfaced on the request). Documented in [WhatsApp templates](./features/templates.md).
  - **When**: Stage 10 (rate limiting + WhatsApp messaging-window awareness — require-template-when-closed enforcement).

## Open as of Stage 6 (status tracking, identity, operational visibility)

### Verification deferred to live testing

- **Read-receipt agent wiring is unit-tested but not yet live-verified** — `ConversationAgent.maybeMarkRead` (gated on `READ_RECEIPTS_ENABLED`) marks the user's inbound message read at flush, *before* the chat call, so silent and reaction-only turns still mark read (decoupled from the typing indicator). This is covered by unit tests but has NOT been exercised end-to-end against the real Meta APIs. **Verify at Stage 9 (live device / examples testing):** with `READ_RECEIPTS_ENABLED=true`, confirm that both a silent turn and a reaction-only turn mark the user's message read on WhatsApp (most-recent message), Messenger, and Instagram (thread `mark_seen`).
  - **Where**: [`src/conversation/agent.ts`](../src/conversation/agent.ts) `maybeMarkRead`. Documented in [Read receipts](./features/read-receipts.md).
  - **When**: Stage 9 (live testing).

### Operational-surface deferrals

- **`/ready` Redis check is presence-only** — `buildReadinessReport` reports `redis: 'configured'` when `REDIS_URL` is set and `'not_configured'` otherwise, but it does NOT actually ping Redis, and a configured-but-unreachable Redis does not fail readiness. The real ping (and the Redis-backed store / BullMQ scheduler it would gate) lands in Stage 10.
  - **Where**: [`src/http/app.ts`](../src/http/app.ts) `buildReadinessReport`.
  - **When**: Stage 10 (real Redis ping once the Redis-backed store/scheduler exist).

- **Per-dispatch-log PII gating is deferred** — the webhook dispatch logs (`inbound.message`) still emit the full channel-scoped user id at `info` so the wiring stays debuggable end-to-end. Stage 6 redacts only the ADMIN-route OUTPUT (`src/http/redaction.ts`), not these per-dispatch logs. Gating dispatch-log PII (e.g. on `config.nodeEnv` or a log-redaction serializer) is an accepted gap, not an unfulfilled TODO.
  - **Where**: [`src/http/app.ts`](../src/http/app.ts) `logIncomingMessage` (see the in-code KNOWN GAP comment).
  - **When**: Stage 10.

- **`contact.tags` / `customVariables` are not redacted in admin output** — `redactContact` masks the user-id, name, and email but deliberately keeps `tags`, `customVariables`, and `unifiedContactId` intact, because they are developer-supplied operational metadata (e.g. `tier:gold`), not inherently Meta user PII. A developer who stuffs PII into `customVariables` will see it in clear on `GET /admin/conversations/:key`. `?reveal=true` is the escape hatch for the rest; these fields are kept by design.
  - **Where**: [`src/http/redaction.ts`](../src/http/redaction.ts) `redactContact`. Documented in [Identity resolution](./features/identity-resolution.md) and [Operational visibility](./features/operational-visibility.md).
  - **When**: No code change planned unless the contact model gains a PII-typed field; revisit if so.

- **Webhook signature-rejection metric is not wired** — the signature verifier 401s an invalid signature BEFORE the dispatcher runs, so `webhook_received_total` counts only signature-valid requests. A rejected webhook surfaces only in a warn log, not in a metric. There is no `webhook_signature_rejected_total` counter yet.
  - **Where**: [`src/http/security.ts`](../src/http/security.ts) (the verifier), [`src/http/app.ts`](../src/http/app.ts) (`POST /webhook` — counter increments after the verifier).
  - **When**: Stage 10 (or whenever signature-rejection alerting becomes load-bearing).

- **Identity-lookup metric is coarse** — `identity_lookup_total{result}` uses a `resolved | none | disabled` split only. The resolver's fail-open contract returns `undefined` indistinguishably for a cache miss, an HTTP miss, a non-2xx, a timeout, or a parse failure, so a finer `hit | cached | error` split cannot be emitted honestly from the agent.
  - **Where**: [`src/conversation/agent.ts`](../src/conversation/agent.ts) (`handleInboundImpl`), [`src/identity/resolver.ts`](../src/identity/resolver.ts). Documented in [Identity resolution](./features/identity-resolution.md).
  - **When**: Deferred — would require the resolver to surface a typed outcome rather than `undefined`.

### Persistence and durability

- **In-memory metrics / status / contact stores are unbounded until Redis** — `InMemoryMetricsCollector`, `InMemoryStatusTracker`, and `InMemoryContactStore` are all per-process plain `Map`s, lost on restart, and (apart from the metrics per-metric cardinality cap that folds overflow into `__overflow__`) unbounded with no TTL or sweeper. This is acceptable for Stage 6 because the production path is the Redis-backed implementations with TTL eviction in Stage 10. The collector/tracker/store interfaces are the contract those impls will honor.
  - **Where**: [`src/metrics/collector.ts`](../src/metrics/collector.ts), [`src/status/tracker.ts`](../src/status/tracker.ts), [`src/identity/contact-store.ts`](../src/identity/contact-store.ts).
  - **When**: Stage 10 (Redis-backed status tracker with TTL, shared/bounded contact cache; metrics export model TBD).

## Open as of Stage 5 (conversation agent)

### Not yet wired

- **Scheduler-internal flush failure has no dedicated counter** — the buffer scheduler's flush handler is invoked fire-and-forget; a flush that rejects is surfaced as `buffer_flush_total{result:'error'}` at the AGENT level (the agent's flush body is fail-soft and counts its own errors), but the scheduler's own swallowed `.catch` does not emit a scheduler-scoped failure metric. In practice the agent counter covers the real failure path; a dedicated scheduler-internal counter is a nice-to-have, not a gap that loses signal today.
  - **Where**: [`src/conversation/scheduler.ts`](../src/conversation/scheduler.ts) (the swallowed `.catch`), [`src/conversation/agent.ts`](../src/conversation/agent.ts) (`buffer_flush_total{result:'error'}`).
  - **When**: Optional polish; no change planned.

- **No rate limiting on the conversation/outbound path** — The agent sends as fast as the queue drains. The only pacing anywhere is the Instagram client's coarse 100ms in-process floor (see the Stage 4 entry below). No per-channel send-rate accounting, no token bucket, no cross-replica coordination.
  - **Where**: [`src/conversation/agent.ts`](../src/conversation/agent.ts) `sendNext`; planned `src/limits/tracker.ts`.
  - **When**: Stage 10 (`LimitTracker`).

### Persistence and durability

- **In-memory store + scheduler only; Redis + BullMQ deferred** — Conversation state, the dedupe set, and the outbound-handle map live in `InMemoryConversationStore`'s plain `Map`s; the buffer scheduler is `InMemoryBufferScheduler` (setTimeout). All of it is per-process and lost on restart, and the per-replica view diverges in a multi-replica deploy. The `ConversationStore` / `BufferScheduler` interfaces are the contract the production impls will honor.
  - **Where**: [`src/conversation/store.ts`](../src/conversation/store.ts), [`src/conversation/scheduler.ts`](../src/conversation/scheduler.ts); planned `src/conversation/redis-store.ts` + a `'bullmq'` scheduler, selected on `REDIS_URL`.
  - **When**: Stage 10 (Redis persistence: conversation state, dedupe via `SET NX`, `SCAN` for `listConversationKeys`, BullMQ for delayed buffer flushes, boot-time `recoverPendingRetries`).

- **In-memory dedupe map is never swept** — `InMemoryConversationStore.inboundHandles` stores `channelMessageId -> expiry` and checks expiry on read (`claimInboundHandle` / `peekInboundHandle`), but expired entries are never deleted, so the map grows unbounded for a long-lived process. This is acceptable only because the in-memory store is for tests/local runs; the production Redis store relies on a native key TTL (`SET NX` with expiry) so there is nothing to sweep.
  - **Where**: [`src/conversation/store.ts`](../src/conversation/store.ts) `inboundHandles`.
  - **When**: Stage 10 (resolved by the Redis store's native TTL; no sweep needed for the in-memory impl).

### Load-bearing invariants to preserve

- **Buffer timeout must stay strictly positive (no inline scheduler fire under the lock)** — `InMemoryBufferScheduler.schedule` fires the flush handler INLINE (synchronously) when `delayMs <= 0`. `handleInboundImpl` calls `schedule` while HOLDING the per-key serialization lock, and the flush handler re-acquires that same key's lock — so an inline fire self-deadlocks the conversation. `calculateBufferTimeout` never returns `<= 0` for a valid config (`bufferBaseTimeoutMs` is a positive int; jitter is clamped to `>= base*0.5`), so `schedule` always takes the `setTimeout` branch. This is not a bug today; it is an invariant a future change to the buffer math could break.
  - **Where**: [`src/conversation/buffering.ts`](../src/conversation/buffering.ts) (the clamp), [`src/conversation/agent.ts`](../src/conversation/agent.ts) (the `LOCK SAFETY` comment in `handleInboundImpl`), [`src/conversation/scheduler.ts`](../src/conversation/scheduler.ts) (`delayMs <= 0`). Documented in [Message buffering](./features/message-buffering.md) and [Conversation state](./features/conversation-state.md).
  - **When**: No action needed; keep the clamp positive if the buffer math is revised.

### Feature scope

- **24h messaging window is tracked but not enforced** — The agent stamps `windowExpiresAt = lastInboundAt + 24h` on each inbound and surfaces `context.windowOpen` to the chat endpoint, but it does NOT block an out-of-window send or force a WhatsApp template fallback. A reply attempted after the window closes will simply fail at the Meta API and be skipped (fail-soft), with no proactive template substitution.
  - **Where**: [`src/conversation/types.ts`](../src/conversation/types.ts) (`MESSAGING_WINDOW_MS` / `isWindowOpen`), [`src/conversation/agent.ts`](../src/conversation/agent.ts) (window stamped on inbound, surfaced on the request).
  - **When**: Stage 10 (rate limiting + WhatsApp messaging-window awareness — full enforcement and template fallback).

## Open as of Stage 4 (outbound clients)

### Outbound-adapter scope

- **Templates exist only for WhatsApp (by design)** — Stage 7 added the WhatsApp template-component builder (`src/meta/whatsapp/templates.ts`: `buildTemplateComponents` + `textParameter` / `payloadParameter`) on top of `WhatsAppClient.sendTemplate`. Templates remain **WhatsApp-only by design**: Messenger's own message templates and any Instagram rich-message surfaces are unimplemented, and `supports('template')` stays `false` for Messenger and Instagram (it is the WhatsApp template concept). Recorded here so a future reader knows the Messenger/IG omission is deliberate, not a missing feature. See [WhatsApp templates](./features/templates.md).
  - **Where**: [`src/meta/whatsapp/client.ts`](../src/meta/whatsapp/client.ts), [`src/meta/whatsapp/templates.ts`](../src/meta/whatsapp/templates.ts).
  - **When**: WhatsApp builder done (Stage 7). Messenger/IG template surfaces are not planned.

- **Instagram outbound quoted replies: NOT supported on the Instagram-Login Send API (`graph.instagram.com`)** — Exhaustively live-verified 2026-05-20 (every `reply_to` shape and target, including a bot's own just-returned valid message id, returns `code 100 / subcode 2534002` or is silently ignored: top-level `reply_to:{mid}` → 100/2534002 "Invalid Message ID"; `reply_to_message_id` (flat) → accepted but rendered as a PLAIN message; nested `message.reply_to` / `reply_to:{message_id}` → "invalid keys"; `reply_to:"string"` → "must be object"). So `InstagramClient.supports('reply_to')` is `false` and `sendText` builds no reply field. The conversation agent downgrades a `reply` action to a plain `message`, so the user still receives the text — only the threading link is lost. The Facebook-Login "Messenger API for Instagram" flavor supports `reply_to`, so native IG quotes would require a different IG integration path (out of scope here, which targets Instagram-Login by design).
  - **Where**: [`src/meta/instagram/client.ts`](../src/meta/instagram/client.ts) `sendText` / `supports`; downgrade in [`src/delivery/queue.ts`](../src/delivery/queue.ts) `buildOutboundItems`. Documented in [Outbound clients](./features/outbound-clients.md) ("Quoted replies (per-channel)").
  - **When**: No code change planned — the field is non-functional on this API flavor. Revisit only if Meta enables `reply_to` on `graph.instagram.com` or if a Facebook-Login IG integration path is added.

### Rate limiting

- **Full per-channel rate limiting is deferred; the Instagram 100ms pacer is an interim floor** — The Instagram client has a minimal in-process pacer that enforces a default 100ms minimum spacing between Graph calls for one account (`minIntervalMs`-overridable). It is a coarse per-process floor chosen to honor the strictest per-second sub-limit (the ~10/sec media ceiling → 1000ms/10 = 100ms) without throttling legitimate text bursts. It does NOT model the real per-second ceilings (~300/sec text/links/reactions/stickers, ~10/sec media), does NOT model the hourly throughput cap (`200 × number-of-messageable-users`), and does NOT coordinate across replicas. WhatsApp and Messenger have no pacer at all today.
  - **Where**: [`src/meta/instagram/client.ts`](../src/meta/instagram/client.ts) `pace` / `DEFAULT_MIN_CALL_SPACING_MS`; planned `src/limits/tracker.ts`.
  - **When**: Stage 10 (`LimitTracker` — shared, Redis-backed, multi-replica-aware, token-bucket accounting + metrics, modeling both the per-second and hourly Instagram limits and per-channel limits generally).

- **WhatsApp messaging-window / pricing tracking still deferred** — Two Stage-2 entries below (`statuses[].conversation` / `pricing`, and the PMP `pricing` block) were tentatively tagged "Stage 4". Stage 4 added the send clients but NOT messaging-window or billing tracking; that work moves with the rest of the limits/observability surface. The clients are window-agnostic today (WhatsApp `sendTemplate` exists for out-of-window sends, but nothing tracks whether the 24-hour window is open).
  - **Where**: `parseWhatsAppStatus` in [`src/meta/parser.ts`](../src/meta/parser.ts).
  - **When**: Stage 10 (rate limiting + WhatsApp messaging-window awareness), with cost observability in Stage 6.

### Implementation-plan fidelity

- **The implementation plan's WhatsApp typing-indicator description is outdated** — `meta-ai-agent-implementation-plan.md` describes the WhatsApp typing indicator as a standalone `type: 'typing_indicator'` message. That is INCORRECT against current Meta docs (verified during Stage 4). WhatsApp has no standalone "typing on": the real mechanism is a COMBINED call that marks a specific inbound message read AND attaches the typing bubble — `POST {phoneNumberId}/messages` with `{ messaging_product: 'whatsapp', status: 'read', message_id: <inbound wamid>, typing_indicator: { type: 'text' } }`. The code (`WhatsAppClient.sendTypingIndicator`) implements the correct combined call and requires the inbound `message_id`. The plan file was deliberately NOT edited; this note records the discrepancy so a future reader does not "fix" the code to match the stale plan.
  - **Where**: [`src/meta/whatsapp/client.ts`](../src/meta/whatsapp/client.ts) `sendTypingIndicator`; described accurately in [Outbound clients](./features/outbound-clients.md) and [CLAUDE.md](../CLAUDE.md) load-bearing constraints.
  - **When**: No code change needed — the code is correct. Update the plan file's prose if/when it is next revised.

## Open as of Stage 2

### Parser-adjacent

- **WhatsApp `statuses[].conversation` and `pricing` blocks** — Preserved on `raw` but not extracted into the normalized `StatusUpdate`. The conversation expiration timestamp (24-hour Customer Service Window) and pricing category (`marketing` / `utility` / `service`) matter for messaging-window awareness and billing observability.
  - **Where**: `parseWhatsAppStatus` in [`src/meta/parser.ts`](../src/meta/parser.ts).
  - **When**: Stage 10 (messaging-window awareness + billing observability; Stage 4 added the send clients but not window/pricing tracking — see the Stage 4 rate-limiting entry above).

- **Order / contact-card / reel / template-fallback attachments** — Surfaced as `MessageType: 'unknown'`. The Messenger attachment-type mapper (`mapFbAttachmentType`) returns `undefined` for `fallback`, `template`, and any future variant, and the message falls back to `'unknown'` rather than dropping. Real-payload captures may surface `reel`, `payment`, or other un-modeled types we'll want first-class normalization for.
  - **Where**: `mapFbAttachmentType` and the attachment branch in `parseFbStyleMessage` in [`src/meta/parser.ts`](../src/meta/parser.ts).
  - **When**: Deferred — Stage 7 added media SEND adapters but not first-class normalization of these inbound variants; revisit when real captures surface `reel` / `payment` / order shapes worth modeling.

- **Page-linked Instagram routing detection** — This package targets the Instagram Business Login path (`object: 'instagram'`) only. The legacy Page-linked Instagram flow surfaces under `object: 'page'` and is currently misrouted to the Messenger parser. We do not intend to support the Page-linked flow, but a defensive check + clear log message would be better than silent misrouting. (Not addressed in Stage 8 — Stage 8 added the setup-time IG profile surfaces, not parser-level routing detection.)
  - **Where**: `parseMetaWebhook` dispatch in [`src/meta/parser.ts`](../src/meta/parser.ts).
  - **When**: Stage 9+ (low priority; a defensive detection/log, not a supported flow).

- **IG `story_mention.id` semantic refactor** — The Instagram story-mention `StoryReplyInfo.id` is set to the message `mid` rather than the story id (Meta does not surface a separate story id for mentions). This is correct given the data but reads strangely against `storyReply.id`, which IS the story id. Cosmetic; renaming the field shape would churn fixtures.
  - **Where**: `parseFbStyleMessage` story_mention branch in [`src/meta/parser.ts`](../src/meta/parser.ts).
  - **When**: Deferred — cosmetic; not addressed in the Stage 7 rich-features pass and only worth doing alongside a broader stories/reels normalization.

- **WhatsApp `context.id` for template-button replies** — Template button replies (`messages[i].type === 'button'`) include a `context.id` referencing the outbound template message. The parser surfaces the button payload but does not populate `replyTo` from `context.id`. The conversation agent will need this linkage to associate template replies with the template send.
  - **Where**: `parseWhatsAppMessage` button branch in [`src/meta/parser.ts`](../src/meta/parser.ts).
  - **When**: Stage 5+ (conversation agent — when template-reply correlation becomes load-bearing).

- **Parser support for `message_edits` webhook field** — Meta added the `message_edits` subscription field in 2025 (WhatsApp + Messenger). It fires when a user edits a previously-sent message and is exposed as a subscribable option in the App Dashboard webhook configuration. This package does not subscribe to it and the parser does not normalize the payload. The natural shape would be either a new `MessageType: 'edit'` discriminator or an `editTarget?: { messageId: string }` field on `IncomingMessage`. We need real captured payloads before committing to a shape.
  - **Where**: subscription list in [`scripts/setup/register-webhooks.ts`](../scripts/setup/register-webhooks.ts) (`SUBSCRIBED_FIELDS`); parser dispatch in [`src/meta/parser.ts`](../src/meta/parser.ts).
  - **When**: Deferred (not picked up in Stage 7) — needs real captured `message_edits` payloads before committing to a shape.

- **Parser support for `message_context` webhook field** — Meta added the `message_context` subscription field in 2025. It carries additional structured context around messages (the documented shape varies by product surface). This package does not subscribe and does not parse it. Pending captured real-payload examples to commit to a normalization.
  - **Where**: subscription list in [`scripts/setup/register-webhooks.ts`](../scripts/setup/register-webhooks.ts); parser dispatch in [`src/meta/parser.ts`](../src/meta/parser.ts).
  - **When**: Deferred (not picked up in Stage 7) — after `npm run capture:guided` surfaces real `message_context` payloads.

- **Postback / referral synthetic-id retry-dedupe** — Synthetic ids for postback (`${recipientId}-${timestamp}-postback`) and referral (`${recipientId}-${timestamp}-referral`) events include the timestamp, so identical events redelivered on Meta retry produce different ids. This is an acceptable trade-off because these events have meaningful single-payload uniqueness already. Reactions deliberately omit the timestamp from their synthetic id (see [Message parsing](./features/message-parsing.md)). **Re-evaluated in Stage 8 and kept as-is:** Stage 8 confirmed postback/referral ride the generic inbound buffer and reach the chat endpoint in `ChatRequest.messages[]` with no special routing (see [Inbound webhooks](./features/inbound-webhooks.md#postbacks-and-referrals)); the timestamped synthetic id remains acceptable and was deliberately not changed.
  - **Where**: `parseFbStylePostback` and `parseFbStyleReferral` in [`src/meta/parser.ts`](../src/meta/parser.ts).
  - **When**: Re-evaluated in Stage 8 — no change. Revisit only if a redelivered postback/referral double-processing is observed in practice.

### Fixture / capture-related

- **Real captures via `npm run capture:guided`** — Most fixtures remain documentation-derived. Promoted so far (exercised by `tests/unit/parser-captured.test.ts`): three WhatsApp shapes (`tests/fixtures/meta/whatsapp/captured/`: outbound status, inbound text, inbound reaction) and two Messenger shapes (`tests/fixtures/meta/messenger/captured/`: inbound text, inbound reaction) from 2026-05-19 `setup:whatsapp` + `setup:messenger` sessions; and two Instagram shapes (`tests/fixtures/meta/instagram/captured/`: inbound text DM, inbound reaction) from the 2026-05-20 `setup:instagram` live test. Still missing real Instagram captures: story reply, story mention, image/media DM, echo, postback, referral, and read/seen — none captured yet. The remaining WhatsApp/Messenger shapes also still need real captures. See [META-PAYLOAD-STRUCTURES.md](./META-PAYLOAD-STRUCTURES.md) for the running checklist.
  - **Where**: [`tests/fixtures/meta/`](../tests/fixtures/meta/).
  - **When**: Stage 3 (capture tooling), then iteratively as fixtures get promoted from `.captures/meta/` into `tests/fixtures/meta/{channel}/captured/`.

### Real-capture findings (Stage 3 live-test 2026-05-19, WhatsApp)

These fields appear in real Meta WhatsApp payloads but aren't extracted into the normalized types yet. All are preserved on `raw`, so downstream consumers can read them, but pulling them onto first-class fields is deferred.

- **`statuses[].pricing` (PMP block)** — `{ billable, pricing_model: "PMP", category, type }`. The Per-Message Pricing model replaced conversation-pricing in July 2025. `category` (`utility` / `marketing` / `authentication` / `service`) is load-bearing for messaging-window tracking and cost observability.
  - **Where**: `parseWhatsAppStatus` in [`src/meta/parser.ts`](../src/meta/parser.ts).
  - **When**: Stage 10 (messaging-window awareness + cost observability).

- **`contacts[].user_id` / `messages[].from_user_id` / `statuses[].recipient_user_id` (US.\*-prefixed identifiers)** — A Meta-internal user identifier (e.g. `US.0000000000000001`) that persists across phone-number changes, distinct from `wa_id` (E.164 phone). Useful for cross-phone-change contact tracking. Not extracted onto `IncomingMessage` / `StatusUpdate` (still `raw`-only); Stage 5's conversation agent keys on `wa_id` and did not adopt this identifier.
  - **Where**: `parseWhatsAppMessage` and `parseWhatsAppStatus` in [`src/meta/parser.ts`](../src/meta/parser.ts).
  - **When**: Deferred — adopt when stable cross-phone-change identity becomes load-bearing.

- **`contacts[].profile.name`** — The user's WhatsApp profile name. Useful for identity enrichment / contact upsert flows. Treat as PII. Stage 6 identity enrichment populates `contact` via `USER_LOOKUP_URL` instead, so this inline profile name is still `raw`-only and not lifted onto the normalized message.
  - **Where**: `parseWhatsAppMessage` in [`src/meta/parser.ts`](../src/meta/parser.ts).
  - **When**: Deferred — only if the agent should fall back to the inline WhatsApp profile name when no `USER_LOOKUP_URL` enrichment is configured.

## Setup / Dashboard observations

- **`pages_read_engagement` Dashboard visibility quirk** — During Stage 3 manual setup, a developer reported the Permissions and Features Dashboard initially indicated `pages_read_engagement` "doesn't exist on this app" (would need to be added), then on re-check the permission was present in the list as expected. Meta's Dashboard UX appears inconsistent here — possibly tied to product configuration order, region, app age, or stale page state. If a future developer reports they cannot locate `pages_read_engagement` (or another standard Messenger permission) in the Permissions and Features list, the first remediation is a hard refresh / wait a few minutes before treating it as a real missing-permission issue. Not a code defect; logged for institutional memory.
  - **Where**: Meta App Dashboard → App Review → Permissions and Features.
  - **When**: If reported by a user during setup, otherwise no action.

- **WhatsApp inbound webhooks require the app to be Live** — Meta's Dashboard surfaces a warning under the WhatsApp product: "Apps will only be able to receive test webhooks sent from the app dashboard while the app is unpublished. No production data, including from app admins, developers or testers, will be delivered unless the app has been published." This is specific to the WhatsApp product. Messenger and Instagram deliver webhooks to roled users (Tester / Admin / Developer) while the app is in Development mode; WhatsApp does not. Implication for setup verification: until the app is published (Live mode + App Review for WhatsApp messaging permissions), the inbound step of `setup:whatsapp` can only be exercised via the Dashboard's "Send Test" button under WhatsApp → Configuration → Webhook, or by publishing the app. The verify script still has no `--skip-inbound` flag (confirmed not added through Stage 8); adding one would let a developer running Development-mode verification mark the inbound step as `skip` rather than waiting for a timeout that cannot succeed.
  - **Where**: [`scripts/setup/verify-whatsapp.ts`](../scripts/setup/verify-whatsapp.ts) inbound step; [`docs/META-SETUP-GUIDE.md`](./META-SETUP-GUIDE.md) WhatsApp section.
  - **When**: Deferred polish — add a `--skip-inbound` flag to `setup:whatsapp` (low priority; the Dashboard "Send Test" workaround exists).

- **System User tokens cannot subscribe Pages via `POST /{pageId}/subscribed_apps`** — Validated during Stage 3 manual testing AND confirmed against Meta's documentation. [Meta's reference page for the endpoint](https://developers.facebook.com/docs/graph-api/reference/page/subscribed_apps/) explicitly requires "*A Page access token requested by a person who can perform CREATE_CONTENT, MANAGE, or MODERATE task on the Page*" along with `pages_manage_metadata` and `pages_show_list`. The load-bearing phrase is "requested by a person" — System User tokens are app-installed (not user-initiated) and don't satisfy that requirement regardless of what scopes they carry or what Page-asset roles the System User has. Empirically: a System User token (`type: SYSTEM_USER`, `profile_id: undefined` per `GET /debug_token`) with the required scopes and explicit Page asset access ("full control" via Business Settings → System Users → Add Assets → Pages) returns HTTP 403 / code 210 ("Subject not visible") on the subscribed_apps endpoint, while a Dashboard-generated Page Access Token (`type: PAGE`, `profile_id` = page id, minted from the logged-in admin user) succeeds. Every other Page operation we exercised (token introspection, send message) worked fine with the System User token, so this is a per-endpoint design choice by Meta. Documentation steers developers to the Dashboard "Generate Token" button for Messenger. The System User permanence story is **WhatsApp-specific** (Cloud API has no Dashboard "Generate Permanent Token" alternative); Messenger and Instagram do not need it.
  - **Where**: [`scripts/setup/register-webhooks.ts`](../scripts/setup/register-webhooks.ts) `subscribeMessengerPageApp`; documented in [META-SETUP-GUIDE.md](./META-SETUP-GUIDE.md) Messenger section and [CLAUDE.md](../CLAUDE.md) load-bearing constraints.
  - **When**: No code change needed today — the documentation guides developers to the right token type. If Meta ever relaxes the restriction, the documentation note becomes obsolete; no other adjustment required.

- **Dashboard "Generate Token" produces a minimal-scope Page Access Token** — Validated during Stage 3 manual testing. The Messenger → Settings → Access Tokens → Generate Token button mints a `type: PAGE` token bound to the Page id (good — that's what `subscribed_apps` needs), but the resulting token's scope set is constrained to whatever the underlying user has already authorized for the app via OAuth — not the scopes the developer wants. A token observed in practice carried only `pages_messaging` + `public_profile`, missing `pages_read_engagement` (needed for `GET /{pageId}` introspection) and `pages_manage_metadata` (needed for some subscription operations). The Dashboard does not surface scope checkboxes inline on that button. The resolution is **Facebook Login for Business**: create a configuration with the full scope set in App Dashboard → Facebook Login for Business → Configurations, save the `config_id` to `MESSENGER_LOGIN_CONFIG_ID` in `.env`, then run `npm run setup:oauth:messenger`. The script drives the authorize-URL → User Token → `/me/accounts` → Page Token flow and produces a `type: PAGE` token carrying all configured scopes.
  - **Where**: [`scripts/setup/oauth-messenger.ts`](../scripts/setup/oauth-messenger.ts); documented in [META-SETUP-GUIDE.md](./META-SETUP-GUIDE.md) Messenger section "Path B" and [CLAUDE.md](../CLAUDE.md) load-bearing constraints.
  - **When**: No code change needed — the script is the resolution. If Meta ever adds inline scope selection to the Dashboard "Generate Token" button, the FB Login for Business path remains valid but becomes optional. Update [META-SETUP-GUIDE.md](./META-SETUP-GUIDE.md) at that point.

- **Instagram messaging webhooks require Instagram Tester registration in Development mode** — Validated during a live walkthrough on 2026-05-20. While the app is unpublished, Instagram only delivers messaging webhooks for DMs sent from accounts registered as **Instagram Testers**. Instagram keeps a SEPARATE tester list from the Facebook app roles (App Dashboard → App Roles → Roles → **Instagram Testers**). Empirically, BOTH the business account and the personal account sending the test DM must appear there as **accepted** testers; otherwise the inbound webhook silently never arrives — no error, no log, identical symptom to the "Allow access to messages" silent killer. Two compounding gotchas: (1) the tester INVITE can only be ACCEPTED on the web (instagram.com → Settings → Apps and websites → Tester invites) — the Instagram mobile app does not surface the acceptance screen; (2) a first DM from a non-connected account lands in the "message requests" folder, but this is cosmetic — the Send API can reply within the 24h window without manually accepting the request, and the request routing is NOT the cause of webhook silence (the tester gate is). `verify-instagram.ts` step 5 now surfaces this as a manual confirmation, paralleling `verify-messenger.ts`'s app-role reminder.
  - **Where**: [`scripts/setup/verify-instagram.ts`](../scripts/setup/verify-instagram.ts) step 5; documented in [META-SETUP-GUIDE.md](./META-SETUP-GUIDE.md) Instagram section + section 9 pitfalls.
  - **When**: No code change needed beyond the reminder step (already added). Resolves naturally once the app is published (Live mode).

- **`message_echoes` is not a valid Instagram subscribed field** — Verified against the live API on 2026-05-20. It exists only on the Messenger (`page`) object; including it in the Instagram (`instagram`) subscribe call returns HTTP 400 / code 100 ("Param subscribed_fields[N] must be one of {...} - got message_echoes"). It was mistakenly added to `SUBSCRIBED_FIELDS.instagram` during the Stage 3 review's M3 fix (correct for Messenger, wrong for IG) and silently broke every IG registration until removed. The accepted IG set is `messages, messaging_postbacks, messaging_seen, message_reactions, messaging_referral`. There is no IG echo-webhook field; Instagram outbound tracking relies on the Send API response, not an echo.
  - **Where**: [`scripts/setup/register-webhooks.ts`](../scripts/setup/register-webhooks.ts) `SUBSCRIBED_FIELDS.instagram`; test guard in [`tests/unit/scripts-register-webhooks.test.ts`](../tests/unit/scripts-register-webhooks.test.ts).
  - **When**: Fixed (field removed + regression test asserts `not.toContain('message_echoes')`). No further action.

- **The `verify-instagram` step-3 webhook audit is IG-blind** — `inspectExistingSubscriptions` checks app-level `GET /{appId}/subscriptions`, which never surfaces Instagram's per-user subscription (created via `graph.instagram.com/{userId}/subscribed_apps`). The audit therefore always warns "No `instagram` subscription found" even when registration succeeded. Cosmetic — the registration block above it reports the true state (registration actually succeeds via the per-user `graph.instagram.com/{userId}/subscribed_apps` call). A fix would query the IG per-user subscription endpoint instead of (or in addition to) the app-level one — i.e. an IG-aware audit. Flagged again during the 2026-05-20 Instagram signature-verification fix as a benign false-warn.
  - **Where**: [`scripts/setup/verify-instagram.ts`](../scripts/setup/verify-instagram.ts) step 3; [`scripts/setup/register-webhooks.ts`](../scripts/setup/register-webhooks.ts) `inspectExistingSubscriptions`.
  - **When**: Stage 4+ polish. Low priority — misleading warn only, no functional impact.

### Fixed during Stage 3 manual testing (kept for institutional memory)

- **Instagram inbound webhooks were rejected — IG signs with `INSTAGRAM_APP_SECRET`, not `META_APP_SECRET`** — Found + fixed during Stage 3 manual testing on 2026-05-20. The signature verifier (`src/http/security.ts`) accepted only a single secret, and both the runtime app (`src/http/app.ts`) and the capture server (`scripts/lib/capture-server.ts`) passed only `META_APP_SECRET`. Empirically verified against the live Meta API: capturing a real Instagram DM webhook and recomputing the `X-Hub-Signature-256` HMAC with both secrets showed it matched **only `INSTAGRAM_APP_SECRET`** — Instagram (`object: instagram`) signs with the Instagram product's own app secret, while WhatsApp (`whatsapp_business_account`) and Messenger (`page`) sign with `META_APP_SECRET`. Result: every real Instagram webhook failed verification and was `401`'d in production, not just in setup tooling.
  - **Fix**: `verifyMetaSignature` / `createMetaSignatureVerifier` now accept `string | readonly string[]` and accept a signature matching ANY configured secret (try-all, chosen over channel-aware parsing because verification runs on the raw bytes BEFORE JSON parsing — parsing untrusted input to pick a secret would add a parse-before-verify risk surface; both secrets share the same Meta App trust domain). `loadConfig` reads `INSTAGRAM_APP_SECRET` onto `config.instagram.appSecret` (optional, does not gate channel-enabled). `createApp` and the capture server build the deduped candidate set `[META_APP_SECRET, ...(INSTAGRAM_APP_SECRET if set)]` and warn at startup if the IG channel is enabled without its secret. Multi-secret unit tests added in `tests/unit/security.test.ts`.
  - **Where**: [`src/http/security.ts`](../src/http/security.ts), [`src/config/loader.ts`](../src/config/loader.ts), [`src/http/app.ts`](../src/http/app.ts), [`scripts/lib/capture-server.ts`](../scripts/lib/capture-server.ts); docs in [`docs/features/webhook-security.md`](./features/webhook-security.md) + [`docs/features/configuration.md`](./features/configuration.md) + [CLAUDE.md](../CLAUDE.md).
  - **When**: Fixed. Open follow-up: live secret rotation still requires a process restart (candidate set is built once at `createApp` time) — see [Webhook security](./features/webhook-security.md) known limitations.

## How to use this file

- When deferring an item during a stage's implementation, add an entry here with stage / location / rationale.
- When a stage lands, sweep the file and either resolve the entry (remove it) or push it forward to a later stage with a one-line rationale.
- Cosmetic / non-blocking items are fine — the goal is institutional memory, not a strict TODO list.

See [Architecture](./ARCHITECTURE.md) for the full module map and [`meta-ai-agent-implementation-plan.md`](../meta-ai-agent-implementation-plan.md) for the staged roadmap.
