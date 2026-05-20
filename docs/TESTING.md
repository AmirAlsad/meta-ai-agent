# Testing Infrastructure

## Unit and Integration Tests

Run:

```bash
npm test
```

This runs **336 tests** (321 unit + 15 integration) across:

- `tests/unit/` — pure-logic tests that import a module directly and assert against its exports.
  - `tests/unit/config-loader.test.ts` (11 tests) — `loadConfig` validation: required-field errors, per-channel pair partial-config rejection, `META_GRAPH_API_VERSION` regex, `NGROK_DOMAIN` bare-hostname check, `PORT` / `AGENT_AUTOSTART` parsing.
  - `tests/unit/security.test.ts` (28 tests) — covers `verifyMetaSignature` and the `createMetaSignatureVerifier` Express middleware, including multi-secret verification (WhatsApp/Messenger sign with `META_APP_SECRET`, Instagram with `INSTAGRAM_APP_SECRET`; the verifier accepts a match against any configured secret).
  - `tests/unit/parser.test.ts` (63 tests) — Stage 2 parser coverage. For each channel: text / media / reaction / reply-to / echo / unknown-type / timestamp normalization. WhatsApp also covers status events (delivered / read / failed with errors), CTWA referral extraction, Flow `nfm_reply` capture, forwarded-flag surfacing, system messages, template-button postback normalization. Messenger covers postback synthesis, delivery fan-out, read-watermark handling, the no-timestamp reaction synthetic id, and the per-payload unknown-event counter that prevents collapse under dedupe. Instagram covers story replies, story mentions, IG-scoped identities, and the IG-only `read.mid` form. Cross-channel: dispatcher routing on `object`, empty-result for non-routable inputs.
  - `tests/unit/parser-captured.test.ts` (32 tests) — Parser coverage against **real redacted Meta payloads** under `tests/fixtures/meta/{whatsapp,messenger,instagram}/captured/`. WhatsApp: outbound status, inbound text, inbound reaction (real fields documentation-derived fixtures lack: `contacts[].user_id`, `from_user_id`, the PMP `pricing` block). Messenger: inbound text, inbound reaction (real field: the named `reaction.reaction` string sent alongside `reaction.emoji`). Instagram: inbound text DM, inbound reaction (real shapes: the IG `mid` is a long `aWdf…`-prefixed string, `entry[].id`/`recipient.id` carry the 17-digit IG business-user id rather than a page id, and reactions carry the same named `reaction.reaction` string — captured as `"other"` for ❤ — that Messenger does). Locks in load-bearing behavior on real shapes Meta sends today; grows incrementally as capture sessions promote new shapes.
  - `tests/unit/scripts-graph-api.test.ts` (35 tests) — URL builders (`buildGraphUrl`, `buildInstagramGraphUrl`, query-string semantics, version + path normalization), `MetaApiError` shape and message formatting, `graphFetch` 2xx / non-2xx / network-failure branches, `appAccessToken` format, `setWebhookSubscriptionConfig` manual-fallback classification, per-channel `subscribed_apps` helpers.
  - `tests/unit/scripts-register-webhooks.test.ts` (17 tests) — `SUBSCRIBED_FIELDS` frozen contracts (including IG `messaging_referral` singular), `registerAllWebhooks` runner per channel, the WhatsApp WABA / app-id branching, `inspectExistingSubscriptions` shape, CLI arg parsing.
  - `tests/unit/scripts-oauth-instagram.test.ts` (27 tests) — `buildShortLivedTokenBody`, `buildLongLivedTokenUrl` (asserts the URL is unversioned), `generateState` / `verifyState`, `maskToken`, `formatExpiresIn`, `parseFlags` (covers the current `--reveal` / `--help` surface and asserts that previously-supported CLI flags are now rejected), `parseAuthorizeUrl` (extracts `client_id` / `redirect_uri` / `state` from the embed URL; tolerates extra Meta params; throws specific remediation when fields are missing), `withState` (appends or replaces the `state` query param), `hasExistingInstagramValue` (the `=\S` clobber-guard that distinguishes real values from empty `.env.example` placeholders).
  - `tests/unit/scripts-oauth-messenger.test.ts` (24 tests) — `buildMessengerAuthorizeUrl` (FB Login for Business format with `config_id` replacing `scope=`), `buildMessengerCodeExchangeUrl` (GET-style query params on `graph.facebook.com/v{N}/oauth/access_token`, asserts redirect_uri encoding), `buildMessengerFbExchangeUrl` (short→long User Token swap via `grant_type=fb_exchange_token`), `buildMeAccountsUrl` (`/me/accounts` field list), `parseFlags`, `hasExistingMessengerPageToken` (page-token clobber guard; deliberately does NOT match `MESSENGER_PAGE_ID` lines), `selectPage` (auto-pick when `MESSENGER_PAGE_ID` matches, auto-pick when only one Page, prompt fallthrough for non-matching id / multiple Pages / empty input).
  - `tests/unit/scripts-verify-shared.test.ts` (36 tests) — `parseVerifyArgs` flag grammar (including `--channels` validation, `--port` range), `isInboundTextMessage` / `isInboundReaction` / `isOutboundStatus` predicates against fixtures, `VerifyResultBuilder`, `printVerifySummary` stdout shape (with TTY mocked off).
  - `tests/unit/scripts-capture-server.test.ts` (10 tests) — `redactHeaders`, `defaultFilename` derivation, the GET handshake mirror, the POST signature middleware (both strict and lenient modes), `onWebhook` subscription, `saveCapture` writing under `.captures/meta/{channel}/`, in-memory ring bounding.
  - `tests/unit/scripts-fixture-capture.test.ts` (10 tests) — `parseFlags` (including unknown-flag rejection and `--port` range), `deriveFilename` for message / status / envelope-only deliveries, `--help` short-circuit.
  - `tests/unit/scripts-guided-capture.test.ts` (26 tests) — scenario tables per channel (WhatsApp / Messenger / Instagram), each predicate asserted against a representative fixture, `wrapForScenario` wrapper shape, `parseFlags` flag grammar, the `{username}` placeholder substitution in the Instagram `text-dm` prompt.
  - Future stages will add channel-client tests, `conversation-agent.test.ts`, and `buffering.test.ts`.
- `tests/integration/` — full Express pipeline tests driven by `supertest`.
  - `tests/integration/webhook-routing.test.ts` (15 tests) builds the real app via `createApp({ config, logger })` with a synthetic in-memory pino-compatible logger and asserts: POST `/webhook` dispatches correctly per channel, per-message and per-status logs land in addition to the per-channel summary, malformed payloads still emit the summary, GET `/webhook` answers the handshake, signature rejection paths, `/health` liveness. One test inside the `dispatchWebhook defensive catch` block uses `vi.spyOn(parserModule, 'parseMetaWebhook').mockImplementationOnce(() => { throw new Error(...) })` to drive the dispatcher's safety-net catch and assert that `dispatcher parse failed unexpectedly` is logged at `error` while the route still ACKs 200. `vi.restoreAllMocks()` runs after each test so suite-order does not matter.

These tests do not require Meta credentials, ngrok, or any real Meta App. They run hardware-free in CI.

The setup and capture scripts themselves (`verify-*.ts`, `oauth-instagram.ts`, `register-webhooks.ts` CLI entry point, `fixture-capture.ts`, `guided-capture.ts` interactive walker) are **not** covered by automated tests — they require real Meta credentials, an active ngrok tunnel, and human input. Coverage focuses on the testable helpers extracted from each script: URL builders, response parsers, scenario predicates, flag parsers, header redaction, filename derivation, and the in-memory capture server. The integration story for the live scripts is `npm run setup:*` / `npm run capture:*` against a real Meta App — see [Setup verification](./features/setup-verification.md) and [Payload capture](./features/payload-capture.md).

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
