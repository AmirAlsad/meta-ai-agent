# Testing Infrastructure

## Unit and Integration Tests

Run:

```bash
npm test
```

This runs **661 tests** (640 unit + 21 integration) across:

- `tests/unit/` — pure-logic tests that import a module directly and assert against its exports.
  - `tests/unit/config-loader.test.ts` (76 tests) — `loadConfig` validation: required-field errors, per-channel pair partial-config rejection, `META_GRAPH_API_VERSION` regex, `NGROK_DOMAIN` bare-hostname check, `PORT` / `AGENT_AUTOSTART` parsing, and the Stage 5 `conversation` section (buffer base/growth/max/noise, typing, delivery/chat timeouts, dedupe TTL, the `bufferMaxTimeoutMs >= bufferBaseTimeoutMs` cross-check, and `defaultConversationConfig`).
  - `tests/unit/security.test.ts` (28 tests) — covers `verifyMetaSignature` and the `createMetaSignatureVerifier` Express middleware, including multi-secret verification (WhatsApp/Messenger sign with `META_APP_SECRET`, Instagram with `INSTAGRAM_APP_SECRET`; the verifier accepts a match against any configured secret).
  - `tests/unit/parser.test.ts` (63 tests) — Stage 2 parser coverage. For each channel: text / media / reaction / reply-to / echo / unknown-type / timestamp normalization. WhatsApp also covers status events (delivered / read / failed with errors), CTWA referral extraction, Flow `nfm_reply` capture, forwarded-flag surfacing, system messages, template-button postback normalization. Messenger covers postback synthesis, delivery fan-out, read-watermark handling, the no-timestamp reaction synthetic id, and the per-payload unknown-event counter that prevents collapse under dedupe. Instagram covers story replies, story mentions, IG-scoped identities, and the IG-only `read.mid` form. Cross-channel: dispatcher routing on `object`, empty-result for non-routable inputs.
  - `tests/unit/parser-captured.test.ts` (32 tests) — Parser coverage against **real redacted Meta payloads** under `tests/fixtures/meta/{whatsapp,messenger,instagram}/captured/`. WhatsApp: outbound status, inbound text, inbound reaction (real fields documentation-derived fixtures lack: `contacts[].user_id`, `from_user_id`, the PMP `pricing` block). Messenger: inbound text, inbound reaction (real field: the named `reaction.reaction` string sent alongside `reaction.emoji`). Instagram: inbound text DM, inbound reaction (real shapes: the IG `mid` is a long `aWdf…`-prefixed string, `entry[].id`/`recipient.id` carry the 17-digit IG business-user id rather than a page id, and reactions carry the same named `reaction.reaction` string — captured as `"other"` for ❤ — that Messenger does). Locks in load-bearing behavior on real shapes Meta sends today; grows incrementally as capture sessions promote new shapes.
  - `tests/unit/scripts-graph-api.test.ts` (37 tests) — URL builders (`buildGraphUrl`, `buildInstagramGraphUrl`, query-string semantics, version + path normalization), `MetaApiError` shape and message formatting (the detailed formatting/truncation coverage lives here, exercising `MetaApiError` via the `scripts/lib/graph-api.ts` re-export of the canonical `src/meta/shared/errors.ts` class), `graphFetch` 2xx / non-2xx / network-failure branches, `appAccessToken` format, `setWebhookSubscriptionConfig` manual-fallback classification, per-channel `subscribed_apps` helpers.
  - `tests/unit/scripts-probe-outbound.test.ts` (35 tests) — the PURE helpers extracted from the manual `scripts/setup/probe-outbound.ts` send probe (the probe itself needs real Meta API + test devices and is not auto-run): `parseProbeArgs` flag grammar (`--only` channel filter + de-dup, the three `--*-target` flags, `--text`, `--dry-run` / `--yes` / `--help`, invalid-value rejection), `planChannelOperations` op names/order and the WhatsApp typing/mark-read skip semantics that hinge on `hasTarget`, `makeCapturingFetch` (records the request and returns the per-channel fake 200 body WITHOUT touching the network), `pickUsableInbound`, `remainingTargets`, and `redactId`.
  - `tests/unit/scripts-register-webhooks.test.ts` (17 tests) — `SUBSCRIBED_FIELDS` frozen contracts (including IG `messaging_referral` singular), `registerAllWebhooks` runner per channel, the WhatsApp WABA / app-id branching, `inspectExistingSubscriptions` shape, CLI arg parsing.
  - `tests/unit/scripts-oauth-instagram.test.ts` (27 tests) — `buildShortLivedTokenBody`, `buildLongLivedTokenUrl` (asserts the URL is unversioned), `generateState` / `verifyState`, `maskToken`, `formatExpiresIn`, `parseFlags` (covers the current `--reveal` / `--help` surface and asserts that previously-supported CLI flags are now rejected), `parseAuthorizeUrl` (extracts `client_id` / `redirect_uri` / `state` from the embed URL; tolerates extra Meta params; throws specific remediation when fields are missing), `withState` (appends or replaces the `state` query param), `hasExistingInstagramValue` (the `=\S` clobber-guard that distinguishes real values from empty `.env.example` placeholders).
  - `tests/unit/scripts-oauth-messenger.test.ts` (24 tests) — `buildMessengerAuthorizeUrl` (FB Login for Business format with `config_id` replacing `scope=`), `buildMessengerCodeExchangeUrl` (GET-style query params on `graph.facebook.com/v{N}/oauth/access_token`, asserts redirect_uri encoding), `buildMessengerFbExchangeUrl` (short→long User Token swap via `grant_type=fb_exchange_token`), `buildMeAccountsUrl` (`/me/accounts` field list), `parseFlags`, `hasExistingMessengerPageToken` (page-token clobber guard; deliberately does NOT match `MESSENGER_PAGE_ID` lines), `selectPage` (auto-pick when `MESSENGER_PAGE_ID` matches, auto-pick when only one Page, prompt fallthrough for non-matching id / multiple Pages / empty input).
  - `tests/unit/scripts-verify-shared.test.ts` (36 tests) — `parseVerifyArgs` flag grammar (including `--channels` validation, `--port` range), `isInboundTextMessage` / `isInboundReaction` / `isOutboundStatus` predicates against fixtures, `VerifyResultBuilder`, `printVerifySummary` stdout shape (with TTY mocked off).
  - `tests/unit/scripts-capture-server.test.ts` (10 tests) — `redactHeaders`, `defaultFilename` derivation, the GET handshake mirror, the POST signature middleware (both strict and lenient modes), `onWebhook` subscription, `saveCapture` writing under `.captures/meta/{channel}/`, in-memory ring bounding.
  - `tests/unit/scripts-fixture-capture.test.ts` (10 tests) — `parseFlags` (including unknown-flag rejection and `--port` range), `deriveFilename` for message / status / envelope-only deliveries, `--help` short-circuit.
  - `tests/unit/scripts-guided-capture.test.ts` (26 tests) — scenario tables per channel (WhatsApp / Messenger / Instagram), each predicate asserted against a representative fixture, `wrapForScenario` wrapper shape, `parseFlags` flag grammar, the `{username}` placeholder substitution in the Instagram `text-dm` prompt.
  - `tests/unit/graph-client.test.ts` (24 tests) — Stage 4 shared transport. `buildUrl` host/version/path/query semantics (`graph.facebook.com` + `graph.instagram.com`, `versioned: false`), `Authorization: Bearer` header (and that the token never lands in the URL), JSON `content-type` only when a body is present, empty-200-body → `{}`, error-envelope parsing into `MetaApiError`, and the retry/backoff matrix: 429 retried on any method, pre-response network error (status 0) retried on any method, 5xx retried for idempotent (GET) but NOT for non-idempotent POST, other 4xx never retried, `Retry-After` (seconds + HTTP-date) honored over exponential backoff. Driven with an injected `fetchImpl` mock and a recording no-op `sleep` so retries incur zero real delay.
  - `tests/unit/meta-errors.test.ts` (7 tests) — confirms the canonical `src/meta/shared/errors.ts` module exports `MetaApiError` (all structured fields, `cause` chaining, `instanceof Error`) and `extractServerMessage` with the same public shape as the scripts re-export — i.e. the consolidation didn't drift the contract.
  - `tests/unit/whatsapp-client.test.ts` (13 tests) — asserts the EXACT WhatsApp `POST {phoneNumberId}/messages` request bodies (the Meta contract): text with `preview_url: false` and `context.message_id` reply threading, the combined typing+read body (`status: 'read'` + `typing_indicator`) and the warn-and-skip when no `message_id` is supplied, mark-read, reaction (incl. empty-emoji unreact preserved verbatim), and `sendTemplate` (components forwarded vs. omitted). Verifies wamid parsing and the throw on a 2xx with no message id.
  - `tests/unit/messenger-client.test.ts` (17 tests) — asserts the EXACT Messenger `POST {pageId}/messages` bodies: `messaging_type` default `RESPONSE`, `MESSAGE_TAG` top-level `tag` (and the local throw when it is missing), `reply_to.mid`, the standalone `sender_action` calls (`typing_on` / `typing_off` / `mark_seen`) proving they are NOT combined with a message, and react/unreact `payload` shape (`payload.reaction` nested for react; `payload` with only `message_id` for unreact).
  - `tests/unit/instagram-client.test.ts` (16 tests) — asserts the EXACT Instagram bodies AND that every send targets host `graph.instagram.com` (`POST {igUserId}/messages`): a text-only body, that `opts.replyTo` is IGNORED (no `reply_to` / `reply_to_message_id` — the Instagram-Login Send API has no working outbound quoted reply, live-verified 2026-05-20; `supports('reply_to')` is `false`), standalone `typing_on` / `mark_seen`, react/unreact `payload` shape. The in-process rate pacer is tested **deterministically** with an injected controllable clock (`now`) and recording `sleep` — asserting that back-to-back sends are spaced by `minIntervalMs`, that concurrent sends serialize rather than collapse, and that a failed send does not poison the pacer — with no real delay.
  - `tests/unit/conversation-types.test.ts` (15 tests) — the per-channel key builders + `conversationKeyFor`, `createIdleConversation` (empty buffers, optional `contact` omitted not `undefined`), and `isWindowOpen` / `MESSAGING_WINDOW_MS` (unset window treated as closed, future window open).
  - `tests/unit/conversation-store.test.ts` (17 tests) — `InMemoryConversationStore`: clone-on-read/write isolation (a mutation of a returned record can't reach stored state), `claimInboundHandle` SETNX semantics + TTL expiry, `peekInboundHandle`, the outbound-handle map round-trip + delete, and `listConversationKeys`.
  - `tests/unit/conversation-buffering.test.ts` (10 tests) — `calculateBufferTimeout` with an injected `random`: the growth curve, the cap at `bufferMaxTimeoutMs`, the zero-noise short-circuit, and the jitter clamp bounds (`base*0.5` floor, `max*1.5` ceiling).
  - `tests/unit/conversation-scheduler.test.ts` (11 tests) — `InMemoryBufferScheduler`: one timer per key, reschedule-replaces-timer, trace-id propagation to the handler, the `delayMs <= 0` inline-fire path, `getStats`, and `close()` clearing every pending timer.
  - `tests/unit/chat-contract.test.ts` (30 tests) — `normalizeChatResponse`: the four response forms, legacy `message`-then-`messages[]` ordering, the mixed-silence drop (`mixed-silence-actions` warning), per-action validation + `invalid-action` drop, the lone-`silence` collapse, and the unknown-shape `ChatEndpointError` throw.
  - `tests/unit/chat-client.test.ts` (10 tests) — `HttpChatClient.complete` with an injected `fetchImpl`: success path, non-2xx, network/abort/JSON-parse failures all wrapping to one `ChatEndpointError` (original on `cause`), the `AbortController` timeout, and warning logging.
  - `tests/unit/delivery-queue.test.ts` (17 tests) — the pure queue logic: `buildOutboundItems` capability gating (media skipped, template WhatsApp-only, reply→message downgrade, silence no-op), `advancementMode` / `statusAdvancesQueue` per channel, and `currentItem` / `isQueueComplete` / `advanceCursor`.
  - `tests/unit/conversation-agent.test.ts` (22 tests) — the `ConversationAgent` state machine driven with a real in-memory store + scheduler, a fake `ChatClient`, fake `ChannelAdapter`s, and injected `random` / `now` / `sleep` (so jitter, timestamps, and the typing delay are deterministic and zero-wait). Covers the buffer→chat→send happy path, echo filtering, dedupe, silence/empty/invalid responses, `on_status` vs `on_send` advancement, the delivery-timeout fallback, typing injection, fail-soft send-skip, and — critically — the concurrency regressions: `concurrent same-key inbound: BOTH messages survive (per-key lock)` and `handleStatus concurrent with an in-flight send does not double-advance (exactly-once)`.
  - `tests/unit/test-chat-endpoint.test.ts` (10 tests) — `buildTestChatResponse`, the PURE keyword router extracted from the dev-only `scripts/dev/test-chat-endpoint.ts` stand-in chat endpoint (the Express server and the `dev:loop` orchestration are not auto-tested — they need real Meta credentials + ngrok). One case per keyword (`silence`, `multi`, `react`, `reply`, `typing`, `template`, `media`) asserting the exact `ChatResponse`, the default echo whose text embeds the channel + buffered message count (`echo [messenger] (3 msg): …`, making burst-buffering visible), and case-insensitive keyword matching.
- `tests/integration/` — full Express pipeline tests driven by `supertest`.
  - `tests/integration/webhook-routing.test.ts` (15 tests) builds the real app via `createApp({ config, logger })` with a synthetic in-memory pino-compatible logger and asserts: POST `/webhook` dispatches correctly per channel, per-message and per-status logs land in addition to the per-channel summary, malformed payloads still emit the summary, GET `/webhook` answers the handshake, signature rejection paths, `/health` liveness. One test inside the `dispatchWebhook defensive catch` block uses `vi.spyOn(parserModule, 'parseMetaWebhook').mockImplementationOnce(() => { throw new Error(...) })` to drive the dispatcher's safety-net catch and assert that `dispatcher parse failed unexpectedly` is logged at `error` while the route still ACKs 200. `vi.restoreAllMocks()` runs after each test so suite-order does not matter.
  - `tests/integration/end-to-end-flow.test.ts` (6 tests) builds the real app WITH a `ConversationAgent` and exercises the full inbound path — HTTP POST → signature verify → parse → `dispatchWebhook` → `handleInbound` → buffer flush (timer) → fake `ChatClient.complete` → delivery queue → fake `ChannelAdapter.sendText`. Only the chat endpoint and the per-channel send clients are faked; everything between (express app, signature verifier, parser, in-memory store + scheduler, pure delivery-queue logic, agent state machine) is real, so a regression anywhere in the wiring surfaces here. It proves a WhatsApp turn reaches the WhatsApp adapter, per-channel adapter selection (Messenger does not touch WhatsApp), an unmapped status no-ops cleanly, cross-delivery dedupe (one chat call for two identical webhook deliveries), the parse+log-only path when no agent is wired, and the multi-message-in-one-body per-key-lock proof (both messages reach the single chat call in order).

These tests do not require Meta credentials, ngrok, or any real Meta App. They run hardware-free in CI.

### Stage 4 outbound-client testing approach

The outbound clients are tested without any network. A `GraphClient` is constructed with an injected `fetchImpl` (a `vi.fn()` returning canned `Response`s) and a no-op recording `sleep`, so retries and backoff incur **zero real delay**. The per-channel client tests assert the **exact** request body, URL, method, and `Authorization: Bearer` header of each fetch call — those bodies *are* the contract with Meta, so the assertions lock in the precise shapes (`messaging_product` / `recipient` / `sender_action` / `payload.reaction` / template) rather than just "a request happened". The Instagram rate pacer is tested deterministically with an injected controllable clock (`now`) and recording `sleep`: tests advance the clock and assert the computed spacing and serialization without waiting in real time. This mirrors the inbound signature-test discipline (assert the exact bytes, not a paraphrase). See [Outbound clients](./features/outbound-clients.md) for the behavior these tests pin down.

### Stage 5 conversation-agent testing approach

The conversation layer is tested with the **real** in-memory store and scheduler plus fakes only at the two real-world boundaries — the developer's chat endpoint (a fake `ChatClient`) and Meta's send API (fake `ChannelAdapter`s with a `supports()` matrix close to the live clients: typing/read/reaction/reply true everywhere, template WhatsApp-only, media false). Time is fully controlled: `random`, `now`, and `sleep` are injected into the `ConversationAgent` so jitter is deterministic (`random: () => 0.5` pins the first flush to exactly `bufferBaseTimeoutMs`), timestamps are stable, and the outbound typing delay is zero-wait. The buffer flush is timer-driven, so the agent and end-to-end suites use `vi.useFakeTimers()` and `advanceTimersByTimeAsync` to drive the flush deterministically rather than waiting in real time.

The pure modules (`calculateBufferTimeout`, `normalizeChatResponse`, `buildOutboundItems`, the queue helpers) are tested directly against their exports — no doubles needed. `HttpChatClient` is tested with an injected `fetchImpl` so every transport/contract failure mode is exercised without a network. The load-bearing concurrency fix is pinned by an explicit regression test: `concurrent same-key inbound: BOTH messages survive (per-key lock)` fires two inbounds for the same conversation concurrently and asserts both land in the buffer — without the per-key serialization lock the second clone-on-write append clobbers the first and a message is silently lost. A companion test proves a status concurrent with an in-flight send does not double-advance the queue (exactly-once).

The setup and capture scripts themselves (`verify-*.ts`, `oauth-instagram.ts`, `register-webhooks.ts` CLI entry point, `fixture-capture.ts`, `guided-capture.ts` interactive walker, plus the dev harness `probe-outbound.ts` / `test-chat-endpoint.ts` / `loop.ts`) are **not** run end-to-end by automated tests — they require real Meta credentials, an active ngrok tunnel, and human input. Coverage focuses on the testable helpers extracted from each script: URL builders, response parsers, scenario predicates, flag parsers, header redaction, filename derivation, the probe's plan/capturing-fetch/pick-inbound helpers, the chat-endpoint keyword router, and the in-memory capture server. The integration story for the live scripts is `npm run setup:*` / `npm run capture:*` (and the dev harness below) against a real Meta App — see [Setup verification](./features/setup-verification.md) and [Payload capture](./features/payload-capture.md).

## Live / manual testing against real Meta accounts

Everything in this section is **dev-only tooling** (lives under `scripts/`, NOT part of the published package) and requires **real Meta credentials plus `NGROK_DOMAIN` + `NGROK_AUTHTOKEN`**. None of it runs in CI — it sends and receives real messages on real WhatsApp / Messenger / Instagram accounts.

### Stage 3 setup verification & capture (recap)

- `npm run setup:whatsapp` / `setup:messenger` / `setup:instagram` / `setup:all` — interactive per-channel verification (config + token + webhook registration + a test outbound + wait for an inbound, with a pass/fail summary). See [Setup verification](./features/setup-verification.md).
- `npm run capture:fixtures` (passive capture server) and `npm run capture:guided` (interactive scenario walker) write raw webhook payloads to `.captures/meta/{channel}/` for promotion into fixtures. See [Payload capture](./features/payload-capture.md).

### Outbound probe — `npm run probe:outbound`

A one-shot diagnostic (`scripts/setup/probe-outbound.ts`) that fires each Stage-4 outbound send method at the founder's test recipients and reports **exactly what the live Meta Graph API accepts or rejects**. It reuses the real per-channel clients over the shared `GraphClient`, so it exercises the production body-building path. Two modes:

- **Flag-driven** (default): reads the recipient from `E2E_TEST_WHATSAPP_NUMBER` / `E2E_TEST_FACEBOOK_PSID` / `E2E_TEST_INSTAGRAM_IGSID`, with `--only=<channels>`, `--wa-target`/`--fb-target`/`--ig-target` to supply a real inbound message id (the WhatsApp reaction/reply target, and the **required** inbound wamid for WhatsApp typing + markRead), and `--text`. Free-form sends need an **open 24h window**; the WhatsApp `hello_world` template is the window-independent baseline and always runs first.
- **`--capture` (round-trip)**: boots an ngrok tunnel + capture server, registers webhooks, captures a **real inbound per channel**, and fires the full send matrix back at that live conversation — answering each channel the moment its inbound arrives. The captured inbound supplies both the recipient and the target message id, so this mode ignores the `E2E_TEST_*` vars and `--*-target` flags; because the inbound just arrived, the 24h window is guaranteed open (so the free-form sends and the WhatsApp typing/markRead ops all run). Requires `NGROK_AUTHTOKEN`.
- **`--dry-run`**: builds + prints every request body via a capturing `fetchImpl` **without touching the network** (composes with `--capture`: real inbound captured, fake sends).

The pure helpers (`parseProbeArgs`, `planChannelOperations`, `makeCapturingFetch`, `pickUsableInbound`, `remainingTargets`, `redactId`) are unit-tested in `tests/unit/scripts-probe-outbound.test.ts`; the live send path is not.

### Full-loop harness — `npm run dev:loop` (and `dev:chat`)

`scripts/dev/loop.ts` is a one-command full-stack runner: in a single process it boots the keyword-driven test chat endpoint, the **real `ConversationAgent`** (via `buildRuntime()` exported from `src/index.ts`), an ngrok tunnel, and webhook registration — then points `CHAT_ENDPOINT_URL` at the in-process endpoint. You message the bot from real devices and watch the entire Stage 5 loop (burst buffering, channel-aware ordered delivery, typing injection, dedupe, echo filtering, the IG reply→message downgrade) in one terminal.

`scripts/dev/test-chat-endpoint.ts` (`npm run dev:chat`) is the same keyword-driven endpoint runnable standalone. It implements the `ChatRequest`→`ChatResponse` contract by scanning the aggregated `message` for keywords (first match wins):

| Keyword | Response |
| --- | --- |
| `reply` | quoted reply targeting your last message |
| `react` | 👍 reaction on your last message |
| `multi` | three separate messages (exercises ordered delivery) |
| `typing` | typing indicator, then a message |
| `template` | `hello_world` template (WhatsApp only) |
| `media` | an image with a caption |
| `silence` | bot stays silent (no reply) |
| `<anything>` | echo showing `[channel]` + the buffered message count (a rapid 3-message burst shows `(3 msg)`, making buffering visible) |

The pure router `buildTestChatResponse` is unit-tested in `tests/unit/test-chat-endpoint.test.ts`; the Express server and the `loop.ts` orchestration are not auto-tested.

## Live verification (2026-05-20)

The founder live-tested the system against real WhatsApp, Messenger, and Instagram accounts on **2026-05-20**, confirming the outbound layer and the full Stage 5 conversation loop end-to-end (not just unit-tested):

- **Outbound sends, all three channels:** text, typing indicators, read receipts, and reactions on WhatsApp / Messenger / Instagram; WhatsApp templates.
- **Quoted replies (per-channel mechanism):** WhatsApp (`context.message_id`) and Messenger (top-level `reply_to:{mid}`) render as quotes; Instagram-Login has no working outbound quoted reply, so the agent downgrades it to a plain message (the user still gets the text).
- **Full Stage 5 loop:** burst buffering aggregating a rapid 3-message burst into one chat call; channel-aware ordered delivery, including WhatsApp's wait-for-delivery-status advancement; typing injection before text; echo filtering with no runaway; silence; and the per-channel `template` / `media` skips.

This records the milestone: the outbound clients ([Outbound clients](./features/outbound-clients.md), [Known gaps](./KNOWN-GAPS.md)) and the Stage 5 loop were validated against the live Meta API, not only in the hardware-free test suite.

To run a single file:

```bash
npx vitest run --config vitest.config.ts tests/unit/security.test.ts
npx vitest run --config vitest.config.ts tests/integration/webhook-routing.test.ts
```

To run a single test by name, append `-t "<substring>"`:

```bash
npx vitest run --config vitest.config.ts tests/unit/security.test.ts -t "valid signature"
```

## Test fixtures

Fixture payloads live under `tests/fixtures/meta/{channel}/`. Stage 2 added one fixture per parser branch:

```
tests/fixtures/meta/
├── whatsapp/
│   ├── audio-voice-inbound.json        # voice=true media flag
│   ├── click-to-whatsapp.json          # CTWA referral attribution
│   ├── document-inbound.json           # filename + mimeType
│   ├── duplicate-message.json          # per-payload dedupe
│   ├── image-inbound.json
│   ├── interactive-button-reply.json
│   ├── interactive-nfm-reply.json      # WhatsApp Flow response_json
│   ├── location-inbound.json           # name lifted onto text
│   ├── multiple-entries.json           # multi-entry parsing
│   ├── reaction.json
│   ├── reply-to-text.json              # context.message_id
│   ├── status-delivered.json
│   ├── status-failed.json              # errorCode + errorTitle
│   ├── status-read.json
│   ├── system-message.json             # system.body lifted onto text
│   ├── template-button.json            # button → postback normalization
│   └── text-inbound.json
├── messenger/
│   ├── delivery.json                   # delivery.mids[] fan-out
│   ├── echo.json                       # is_echo direction-flip
│   ├── image-attachment.json
│   ├── message-read.json               # read.watermark
│   ├── postback.json
│   ├── reaction.json
│   ├── referral.json
│   ├── reply-to.json
│   └── text-message.json
└── instagram/
    ├── echo.json                       # IG echo direction-flip
    ├── image-attachment.json
    ├── reaction.json
    ├── referral.json
    ├── story-mention.json              # attachments[].type === story_mention
    ├── story-reply.json                # reply_to.story
    └── text-dm.json
```

**Most are documentation-derived.** They were built from Meta's published webhook payload shapes, not from live captures. Real Meta payloads frequently include extra fields, slight field-name variations, and undocumented additions. The Stage 3 [Payload capture](./features/payload-capture.md) tooling (`npm run capture:guided` and `npm run capture:fixtures`, plus the `setup:*` verification scripts) writes raw payloads to `.captures/meta/{channel}/{timestamp}-{scenario}.json`. Promoted captures (after redacting phone numbers, tokens, profile data) land in `tests/fixtures/meta/{channel}/captured/` — three WhatsApp shapes, two Messenger shapes, and two Instagram shapes (inbound text DM + inbound reaction) have been promoted so far and are exercised by `tests/unit/parser-captured.test.ts`.

`.captures/` and `.env` are gitignored — they may contain real phone numbers, profile names, tunnel URLs, and message content. Always redact before promoting.

## Signature-test helper pattern

The signature is computed inside each test against the exact bytes the test sends. This is essential because any whitespace/escape difference between "what you signed" and "what arrived at the server" invalidates the HMAC. The pattern, from `tests/integration/webhook-routing.test.ts`:

```typescript
function loadFixtureBuffer(relativePath: string): Buffer {
  const raw = readFileSync(path.join(fixturesDir, relativePath), 'utf8');
  const parsed = JSON.parse(raw);
  // Re-serialize so the byte sequence is deterministic and the signature
  // computed over `bodyBuf` exactly matches what supertest sends as the body.
  return Buffer.from(JSON.stringify(parsed));
}

function signBody(body: Buffer, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

const bodyBuf = loadFixtureBuffer('whatsapp/text-inbound.json');
const signature = signBody(bodyBuf, APP_SECRET);

await request(app)
  .post('/webhook')
  .set('Content-Type', 'application/json')
  .set('x-hub-signature-256', signature)
  .send(bodyBuf.toString('utf8'));  // Send the exact bytes we signed.
```

Two rules:

1. **Sign the exact buffer you will send.** Never sign a parsed object and rely on `JSON.stringify` round-tripping to the same bytes — implementations differ on whitespace, escaping of `<`/`>`/`&`, and Unicode handling.
2. **Send a string, not an object.** `supertest`'s `.send(object)` triggers another `JSON.stringify` inside supertest, which may produce different bytes than your fixture loader. Sending `bodyBuf.toString('utf8')` is byte-faithful.

The unit test (`tests/unit/security.test.ts`) verifies the signature module's edge cases directly: wrong secret, tampered body, missing header, missing `sha256=` prefix, non-hex characters, wrong-length hex (must not throw inside `timingSafeEqual`), empty-body roundtrip.

## E2E (planned for Stage 3)

Stage 3 of the implementation plan introduces a real-device E2E loop:

- `scripts/tunnel.ts` — ngrok tunnel via the `@ngrok/ngrok` SDK; reads `NGROK_AUTHTOKEN` and the required `NGROK_DOMAIN` (validated by `loadConfig`).
- `scripts/setup/verify-whatsapp.ts`, `verify-messenger.ts`, `verify-instagram.ts`, `verify-all.ts` — interactive verification that calls Graph API to confirm tokens, registers webhooks, sends a test outbound, waits for inbound, prints a per-channel pass/fail summary.
- `scripts/setup/oauth-instagram.ts` — minimal local OAuth server to exchange short-lived Instagram tokens for long-lived ones via Business Login.
- `scripts/setup/register-webhooks.ts` — Graph API webhook subscription per channel (`POST /{META_APP_ID}/subscriptions` and `POST /{businessId}/subscribed_apps` with the appropriate `subscribed_fields`).
- `scripts/capture/fixture-capture.ts` — passive capture server that ACKs everything and writes to `.captures/meta/`.
- `scripts/capture/guided-capture.ts` — interactive guided capture with per-channel scenarios (text, image, audio, reaction, reply, read, etc.).

The `.env.example` already lists the variables these scripts will need: `E2E_TEST_WHATSAPP_NUMBER`, `E2E_TEST_FACEBOOK_PSID`, `E2E_TEST_INSTAGRAM_IGSID`, `NGROK_AUTHTOKEN`, `NGROK_DOMAIN`. None of the scripts exist yet.

There will also be a `vitest.e2e.config.ts` and `tests/e2e/smoke.test.ts` (Stage 3) — these run only on demand and never in CI because they require real Meta credentials and send real messages.

## Captured fixtures

After running `npm run capture:guided` (or the `setup:*` verification scripts, which capture key payloads as part of verification) against a real Meta App, the developer manually redacts and promotes payloads from `.captures/meta/` to `tests/fixtures/meta/{channel}/captured/`. The captured fixtures replay through the parser and `tests/unit/parser-captured.test.ts` locks in load-bearing behavior on the real shapes. Three WhatsApp shapes (outbound status sent, inbound text, inbound reaction), two Messenger shapes (inbound text, inbound reaction), and two Instagram shapes (inbound text DM, inbound reaction) are promoted today; the remaining shapes — including IG story reply, story mention, image/media DM, echo, postback, and referral — await further captures from `setup:*` sessions. See [Payload capture](./features/payload-capture.md) for the step-by-step promotion workflow. Before committing captured payloads:

- Remove phone numbers, IGSIDs, PSIDs, profile names, and message content from real people.
- Remove account/email metadata.
- Remove tokens, webhook secrets, and tunnel URLs.
