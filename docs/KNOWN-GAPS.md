# Known Gaps and Deferrals

A running list of items surfaced during code review or implementation that were intentionally deferred to a later stage. Recording them here keeps the institutional memory from getting lost between stages — if you are working on the stage listed, treat the entry as a TODO.

## Open as of Stage 5 (conversation agent)

### Not yet wired

- **Identity resolver is a no-op** — `ChatRequest.contact` and `ConversationRecord.contact` exist in the type, and `createIdleConversation` / the flush already thread `contact` through when present, but nothing populates it — there is no `IdentityResolver` / `ContactStore`, so `contact` is always undefined and the conversation key is always the raw `(channel, channelScopedId)` tuple with no cross-channel merge.
  - **Where**: [`src/conversation/agent.ts`](../src/conversation/agent.ts) (flush builds the request), [`src/conversation/types.ts`](../src/conversation/types.ts) (`Contact` import); planned `src/identity/{resolver,contact-store}.ts`.
  - **When**: Stage 6 (status tracking, identity, operational visibility).

- **Metrics are not wired** — There is no metrics collector. Notably, `InMemoryBufferScheduler`'s timer-fired-handler catch and the scheduler-handler path swallow failures silently with an explicit "Stage 6: increment a failure counter and log here" TODO.
  - **Where**: [`src/conversation/scheduler.ts`](../src/conversation/scheduler.ts) (the swallowed `.catch`); planned `src/metrics/`.
  - **When**: Stage 6.

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

- **Media chat actions are skipped** — `buildOutboundItems` drops a `{type:'media'}` action with a `media_send unsupported (Stage 7)` skip note because `supports('media_send')` is `false` on all three adapters. The chat endpoint can return media actions, but nothing sends them yet (this is the conversation-layer view of the Stage 4 / Stage 7 media-send gap below).
  - **Where**: [`src/delivery/queue.ts`](../src/delivery/queue.ts) `buildOutboundItems` media branch.
  - **When**: Stage 7 (flip `media_send` to `true` once the adapter send methods exist).

- **24h messaging window is tracked but not enforced** — The agent stamps `windowExpiresAt = lastInboundAt + 24h` on each inbound and surfaces `context.windowOpen` to the chat endpoint, but it does NOT block an out-of-window send or force a WhatsApp template fallback. A reply attempted after the window closes will simply fail at the Meta API and be skipped (fail-soft), with no proactive template substitution.
  - **Where**: [`src/conversation/types.ts`](../src/conversation/types.ts) (`MESSAGING_WINDOW_MS` / `isWindowOpen`), [`src/conversation/agent.ts`](../src/conversation/agent.ts) (window stamped on inbound, surfaced on the request).
  - **When**: Stage 10 (rate limiting + WhatsApp messaging-window awareness — full enforcement and template fallback).

## Open as of Stage 4 (outbound clients)

### Outbound-adapter scope

- **Media send is not implemented** — The `ChannelAdapter` covers text, typing, read receipts, reactions, and (WhatsApp) templates only. There is no `sendImage` / `sendAudio` / `sendVideo` / `sendDocument`, and `supports('media_send')` returns `false` on all three channels. Inbound media is already parsed; outbound media (upload + send) is the gap.
  - **Where**: [`src/meta/shared/adapter.ts`](../src/meta/shared/adapter.ts) (`ChannelFeature`), the three [`src/meta/{whatsapp,messenger,instagram}/client.ts`](../src/meta/) clients; planned `src/meta/shared/media.ts`.
  - **When**: Stage 7 (rich features — media upload/download). Flip the `media_send` capability to `true` once the send methods exist.

- **Templates exist only for WhatsApp** — `WhatsAppClient.sendTemplate` is the only template path. Messenger's own message templates and any Instagram rich-message surfaces are unimplemented; `supports('template')` is `false` for Messenger and Instagram (it is the WhatsApp template concept).
  - **Where**: [`src/meta/whatsapp/client.ts`](../src/meta/whatsapp/client.ts); planned `src/meta/whatsapp/templates.ts` for richer helpers.
  - **When**: Stage 7.

- **Profile surfaces are not wired** — Persistent menu, Get Started, and ice breakers all report `supports(...) === false`. These are Messenger/Instagram profile-API features.
  - **Where**: the three client `supports` matrices.
  - **When**: Stage 8 (platform-specific surfaces).

- **Instagram outbound quoted replies: NOT supported on the Instagram-Login Send API (`graph.instagram.com`)** — Exhaustively live-verified 2026-05-20 (every `reply_to` shape and target, including a bot's own just-returned valid message id, returns `code 100 / subcode 2534002` or is silently ignored: top-level `reply_to:{mid}` → 100/2534002 "Invalid Message ID"; `reply_to_message_id` (flat) → accepted but rendered as a PLAIN message; nested `message.reply_to` / `reply_to:{message_id}` → "invalid keys"; `reply_to:"string"` → "must be object"). So `InstagramClient.supports('reply_to')` is `false` and `sendText` builds no reply field. The conversation agent downgrades a `reply` action to a plain `message`, so the user still receives the text — only the threading link is lost. The Facebook-Login "Messenger API for Instagram" flavor supports `reply_to`, so native IG quotes would require a different IG integration path (out of scope here, which targets Instagram-Login by design).
  - **Where**: [`src/meta/instagram/client.ts`](../src/meta/instagram/client.ts) `sendText` / `supports`; downgrade in [`src/delivery/queue.ts`](../src/delivery/queue.ts) `buildOutboundItems`. Documented in [Outbound clients](./features/outbound-clients.md) ("Quoted replies (per-channel)").
  - **When**: No code change planned — the field is non-functional on this API flavor. Revisit only if Meta enables `reply_to` on `graph.instagram.com` or if a Facebook-Login IG integration path is added.

- **Outbound clients are not wired into a conversation flow** — RESOLVED in Stage 5. `dispatchWebhook` now routes each parsed message into `ConversationAgent.handleInbound` and each status into `handleStatus`; the agent buffers, calls the chat endpoint, and drives the `ChannelAdapter`s through the ordered delivery queue (typing → delay → text, channel-aware advancement, cross-payload dedupe). The parsed `ParseResult` is no longer discarded when an agent is wired.
  - **Where**: [`src/http/app.ts`](../src/http/app.ts) `dispatchWebhook`, [`src/conversation/agent.ts`](../src/conversation/agent.ts), [`src/delivery/queue.ts`](../src/delivery/queue.ts). See [Conversation state](./features/conversation-state.md) and [Ordered delivery](./features/ordered-delivery.md).
  - **When**: Fixed (Stage 5). No further action.

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
  - **When**: Stage 10 (messaging-window awareness; Stage 4 added the send clients but not window tracking — see the Stage 4 rate-limiting entry above), with billing observability in Stage 6.

- **Order / contact-card / reel / template-fallback attachments** — Surfaced as `MessageType: 'unknown'`. The Messenger attachment-type mapper (`mapFbAttachmentType`) returns `undefined` for `fallback`, `template`, and any future variant, and the message falls back to `'unknown'` rather than dropping. Real-payload captures may surface `reel`, `payment`, or other un-modeled types we'll want first-class normalization for.
  - **Where**: `mapFbAttachmentType` and the attachment branch in `parseFbStyleMessage` in [`src/meta/parser.ts`](../src/meta/parser.ts).
  - **When**: Stage 7 (rich features — adds dedicated `sendImage` / `sendAudio` / `sendVideo` / `sendDocument` adapters; normalized inbound variants for these surfaces follow).

- **Page-linked Instagram routing detection** — This package targets the Instagram Business Login path (`object: 'instagram'`) only. The legacy Page-linked Instagram flow surfaces under `object: 'page'` and is currently misrouted to the Messenger parser. We do not intend to support the Page-linked flow, but a defensive check + clear log message would be better than silent misrouting.
  - **Where**: `parseMetaWebhook` dispatch in [`src/meta/parser.ts`](../src/meta/parser.ts).
  - **When**: Stage 8 (platform-specific surfaces — the right place to introduce IG-Business-Login-specific detection).

- **IG `story_mention.id` semantic refactor** — The Instagram story-mention `StoryReplyInfo.id` is set to the message `mid` rather than the story id (Meta does not surface a separate story id for mentions). This is correct given the data but reads strangely against `storyReply.id`, which IS the story id. Cosmetic; renaming the field shape would churn fixtures.
  - **Where**: `parseFbStyleMessage` story_mention branch in [`src/meta/parser.ts`](../src/meta/parser.ts).
  - **When**: Stage 7 (alongside the rich-features pass for stories / reels).

- **WhatsApp `context.id` for template-button replies** — Template button replies (`messages[i].type === 'button'`) include a `context.id` referencing the outbound template message. The parser surfaces the button payload but does not populate `replyTo` from `context.id`. The conversation agent will need this linkage to associate template replies with the template send.
  - **Where**: `parseWhatsAppMessage` button branch in [`src/meta/parser.ts`](../src/meta/parser.ts).
  - **When**: Stage 5+ (conversation agent — when template-reply correlation becomes load-bearing).

- **Parser support for `message_edits` webhook field** — Meta added the `message_edits` subscription field in 2025 (WhatsApp + Messenger). It fires when a user edits a previously-sent message and is exposed as a subscribable option in the App Dashboard webhook configuration. This package does not subscribe to it and the parser does not normalize the payload. The natural shape would be either a new `MessageType: 'edit'` discriminator or an `editTarget?: { messageId: string }` field on `IncomingMessage`. We need real captured payloads before committing to a shape.
  - **Where**: subscription list in [`scripts/setup/register-webhooks.ts`](../scripts/setup/register-webhooks.ts) (`SUBSCRIBED_FIELDS`); parser dispatch in [`src/meta/parser.ts`](../src/meta/parser.ts).
  - **When**: Stage 7 (rich features) or later.

- **Parser support for `message_context` webhook field** — Meta added the `message_context` subscription field in 2025. It carries additional structured context around messages (the documented shape varies by product surface). This package does not subscribe and does not parse it. Pending captured real-payload examples to commit to a normalization.
  - **Where**: subscription list in [`scripts/setup/register-webhooks.ts`](../scripts/setup/register-webhooks.ts); parser dispatch in [`src/meta/parser.ts`](../src/meta/parser.ts).
  - **When**: Stage 7 or later (after `npm run capture:guided` surfaces real `message_context` payloads).

- **Postback / referral synthetic-id retry-dedupe** — Synthetic ids for postback (`${recipientId}-${timestamp}-postback`) and referral (`${recipientId}-${timestamp}-referral`) events include the timestamp, so identical events redelivered on Meta retry produce different ids. This is an acceptable trade-off in Stage 2 because cross-payload dedupe is the conversation agent's job and these events have meaningful single-payload uniqueness already. Reactions deliberately omit the timestamp from their synthetic id (see [Message parsing](./features/message-parsing.md)) — re-evaluate whether postbacks / referrals should follow the same rule once the conversation agent lands.
  - **Where**: `parseFbStylePostback` and `parseFbStyleReferral` in [`src/meta/parser.ts`](../src/meta/parser.ts).
  - **When**: Stage 5 (revisit once the conversation agent's cross-payload dedupe is wired up).

### Fixture / capture-related

- **Real captures via `npm run capture:guided`** — Most fixtures remain documentation-derived. Promoted so far (exercised by `tests/unit/parser-captured.test.ts`): three WhatsApp shapes (`tests/fixtures/meta/whatsapp/captured/`: outbound status, inbound text, inbound reaction) and two Messenger shapes (`tests/fixtures/meta/messenger/captured/`: inbound text, inbound reaction) from 2026-05-19 `setup:whatsapp` + `setup:messenger` sessions; and two Instagram shapes (`tests/fixtures/meta/instagram/captured/`: inbound text DM, inbound reaction) from the 2026-05-20 `setup:instagram` live test. Still missing real Instagram captures: story reply, story mention, image/media DM, echo, postback, referral, and read/seen — none captured yet. The remaining WhatsApp/Messenger shapes also still need real captures. See [META-PAYLOAD-STRUCTURES.md](./META-PAYLOAD-STRUCTURES.md) for the running checklist.
  - **Where**: [`tests/fixtures/meta/`](../tests/fixtures/meta/).
  - **When**: Stage 3 (capture tooling), then iteratively as fixtures get promoted from `.captures/meta/` into `tests/fixtures/meta/{channel}/captured/`.

### Real-capture findings (Stage 3 live-test 2026-05-19, WhatsApp)

These fields appear in real Meta WhatsApp payloads but aren't extracted into the normalized types yet. All are preserved on `raw`, so downstream consumers can read them, but pulling them onto first-class fields is deferred.

- **`statuses[].pricing` (PMP block)** — `{ billable, pricing_model: "PMP", category, type }`. The Per-Message Pricing model replaced conversation-pricing in July 2025. `category` (`utility` / `marketing` / `authentication` / `service`) is load-bearing for messaging-window tracking and cost observability.
  - **Where**: `parseWhatsAppStatus` in [`src/meta/parser.ts`](../src/meta/parser.ts).
  - **When**: Stage 10 (messaging-window awareness), with cost observability in Stage 6.

- **`contacts[].user_id` / `messages[].from_user_id` / `statuses[].recipient_user_id` (US.\*-prefixed identifiers)** — A Meta-internal user identifier (e.g. `US.0000000000000001`) that persists across phone-number changes, distinct from `wa_id` (E.164 phone). Likely useful for Stage 5 contact tracking when a user changes phone number mid-conversation. Not yet surfaced on `IncomingMessage` / `StatusUpdate`.
  - **Where**: `parseWhatsAppMessage` and `parseWhatsAppStatus` in [`src/meta/parser.ts`](../src/meta/parser.ts).
  - **When**: Stage 5 (conversation agent — when stable cross-phone-change identity becomes load-bearing).

- **`contacts[].profile.name`** — The user's WhatsApp profile name. Useful for Stage 6 identity enrichment / contact upsert flows. Treat as PII.
  - **Where**: `parseWhatsAppMessage` in [`src/meta/parser.ts`](../src/meta/parser.ts).
  - **When**: Stage 6 (operational visibility / identity resolution).

## Setup / Dashboard observations

- **`pages_read_engagement` Dashboard visibility quirk** — During Stage 3 manual setup, a developer reported the Permissions and Features Dashboard initially indicated `pages_read_engagement` "doesn't exist on this app" (would need to be added), then on re-check the permission was present in the list as expected. Meta's Dashboard UX appears inconsistent here — possibly tied to product configuration order, region, app age, or stale page state. If a future developer reports they cannot locate `pages_read_engagement` (or another standard Messenger permission) in the Permissions and Features list, the first remediation is a hard refresh / wait a few minutes before treating it as a real missing-permission issue. Not a code defect; logged for institutional memory.
  - **Where**: Meta App Dashboard → App Review → Permissions and Features.
  - **When**: If reported by a user during setup, otherwise no action.

- **WhatsApp inbound webhooks require the app to be Live** — Meta's Dashboard surfaces a warning under the WhatsApp product: "Apps will only be able to receive test webhooks sent from the app dashboard while the app is unpublished. No production data, including from app admins, developers or testers, will be delivered unless the app has been published." This is specific to the WhatsApp product. Messenger and Instagram deliver webhooks to roled users (Tester / Admin / Developer) while the app is in Development mode; WhatsApp does not. Implication for setup verification: until the app is published (Live mode + App Review for WhatsApp messaging permissions), the inbound step of `setup:whatsapp` can only be exercised via the Dashboard's "Send Test" button under WhatsApp → Configuration → Webhook, or by publishing the app. The verify script has no `--skip-inbound` flag today; a Stage 4+ touch-up should add one so a developer running Development-mode verification can mark the inbound step as `skip` rather than waiting for a timeout that cannot succeed.
  - **Where**: [`scripts/setup/verify-whatsapp.ts`](../scripts/setup/verify-whatsapp.ts) inbound step; [`docs/META-SETUP-GUIDE.md`](./META-SETUP-GUIDE.md) WhatsApp section.
  - **When**: Stage 4+ (add `--skip-inbound` flag to `setup:whatsapp` once outbound clients land and the verify scripts evolve to cover them).

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
