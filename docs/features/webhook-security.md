# Webhook Security

## What it does

Authenticates every inbound Meta webhook before it reaches any dispatch or parsing logic. Meta signs each delivery with `X-Hub-Signature-256` using HMAC-SHA256 keyed by an app secret over the **raw request body**; this module verifies that signature with constant-time comparison and drops unauthenticated traffic at the middleware layer.

A single Meta App hosts WhatsApp, Messenger, and Instagram products. They do **not** all sign with the same secret: WhatsApp and Messenger sign with `META_APP_SECRET`, while Instagram signs with the Instagram product's own `INSTAGRAM_APP_SECRET`. One verifier still covers all three channels — it is given the full set of candidate secrets and accepts a signature that matches **any** of them.

### Per-channel signing secret

| `object` field | Channel | Signing secret |
| --- | --- | --- |
| `whatsapp_business_account` | WhatsApp | `META_APP_SECRET` |
| `page` | Messenger | `META_APP_SECRET` |
| `instagram` | Instagram | `INSTAGRAM_APP_SECRET` (NOT `META_APP_SECRET`) |

This was **verified empirically against the live Meta API on 2026-05-20**: a captured Instagram DM webhook's HMAC matched only `INSTAGRAM_APP_SECRET`, never `META_APP_SECRET`. Before this fix the verifier used a single secret (`META_APP_SECRET`), so every real Instagram webhook failed signature verification and was rejected with `401 invalid_signature` in production.

### Why try-all rather than channel-aware

The verifier tries every configured secret rather than parsing the body's `object` field to choose the "right" secret. Signature verification runs on the **raw bytes before JSON parsing** — parsing untrusted, unverified input to decide which secret to use would add a parse-before-verify risk surface. Both secrets belong to the same Meta App's trust domain, so "matches either secret" is the correct trust model. Early-return on the first matching secret is safe: which secret matched is not a meaningful signal to leak (both are server-side), and the constant-time property that matters — `crypto.timingSafeEqual` within each per-secret HMAC compare — is preserved for every candidate.

## How it works

Meta documents the signature scheme at https://developers.facebook.com/docs/graph-api/webhooks/getting-started#payload. The header value is `sha256=<hex>`, where `<hex>` is `HMAC_SHA256(appSecret, rawBody)` encoded as hexadecimal. The HMAC is computed over the **bytes Meta sent** — any whitespace, key-order, or escape difference between the raw body and a re-serialized JSON object will invalidate the digest.

This package handles that in two cooperating pieces:

### 1. Raw-body capture before JSON parsing

In [`src/http/app.ts`](../../src/http/app.ts), the JSON body parser is registered with a `verify` callback that copies the raw bytes onto `req.rawBody` **before** JSON parsing mutates them:

```typescript
app.use(
  express.json({
    limit: '5mb',
    verify: (req, _res, buf) => {
      (req as RawBodyRequest).rawBody = Buffer.isBuffer(buf) ? Buffer.from(buf) : Buffer.alloc(0);
    }
  })
);
```

The buffer is cloned with `Buffer.from(buf)` so subsequent body-parser internals cannot mutate the captured copy. Any future middleware that needs to inspect the body must read `req.rawBody`, not re-parse and re-serialize.

### 2. The verifier function and middleware

[`src/http/security.ts`](../../src/http/security.ts) exports:

- `verifyMetaSignature(rawBody: Buffer, signatureHeader: string | undefined, appSecret: string | readonly string[]): boolean`
  Pure function. Parses the provided hex from the header once, then for each candidate secret computes the expected digest with `createHmac('sha256', secret).update(rawBody).digest()` and compares with `crypto.timingSafeEqual`, returning `true` on the first match. Accepts a single secret string (backward-compatible) or an array of candidate secrets. Returns `false` (never throws) for missing header, missing `sha256=` prefix, non-hex characters, empty hex, wrong-length hex, an empty secrets array, or no matching secret. The wrong-length guard is important: `timingSafeEqual` itself throws on length mismatch, so the function checks lengths first (per secret) and runs a self-compare to keep timing flat on the rejection path.
- `createMetaSignatureVerifier(appSecret: string | readonly string[], logger?, onReject?)` — Express middleware factory. Passes the secret(s) through to `verifyMetaSignature`. On failure it logs a `secretsCount` field alongside `path` / `signaturePresent` / `bodyBytes`. The optional `onReject(reason)` callback (Stage 10) is invoked once per rejection with a bounded reason (`'missing_signature'` / `'mismatch'` / `'no_raw_body'`) so the HTTP layer can increment `webhook_secret_rejections_total{reason}` — kept as a callback (not a metrics dependency) so this module stays dependency-free; a throw from it is swallowed so a misbehaving metrics sink can never break the security path.

The middleware's behavior:

| Condition | Status | Body |
| --- | --- | --- |
| `req.rawBody` not a `Buffer` | `400` | `{ "error": "raw_body_unavailable" }` |
| Signature header missing | `401` | `{ "error": "invalid_signature" }` |
| Signature header malformed (no `sha256=`, bad hex, wrong length) | `401` | `{ "error": "invalid_signature" }` |
| Signature does not match | `401` | `{ "error": "invalid_signature" }` |
| Valid signature | (passes to next handler) | — |

The `400 raw_body_unavailable` path indicates a **server-side wiring bug** — `express.json({ verify })` was not registered, or another middleware reset `req.rawBody`. Logged at `error` level (or `warn` if the logger lacks `error`) with the path, header presence, and `bodyBytes: 0`.

The `401 invalid_signature` path is the normal rejection for unauthenticated traffic. Logged at `warn` with the path, `signaturePresent` flag, `bodyBytes`, and `secretsCount` (how many candidate secrets were tried — useful when debugging "all my IG webhooks 401": if `secretsCount` is 1 on a deployment that expects Instagram traffic, `INSTAGRAM_APP_SECRET` is probably unset). The actual header value is never logged.

### Why HTTP 400 vs 401

400 is reserved for the developer's bug (the raw body wasn't captured). 401 covers anything where the signature itself can't be trusted — missing header, malformed header, or hash mismatch. Meta retries 5xx for up to 7 days; 4xx responses are not retried, so the agent does not enter a retry loop on either of these.

### Constant-time comparison

`timingSafeEqual(expected, provided)` guarantees the comparison time does not depend on where the byte mismatch occurs, preventing timing-side-channel inference of partial-match prefixes. When buffers differ in length, the function still calls `timingSafeEqual(expectedBuf, expectedBuf)` to keep the rejection-path timing comparable to the success path.

## Test pattern

The signature tests **compute the HMAC against the exact bytes they send** rather than trusting that a `JSON.stringify` round-trip will produce the same digest twice. From [`tests/integration/webhook-routing.test.ts`](../../tests/integration/webhook-routing.test.ts):

```typescript
function loadFixtureBuffer(relativePath: string): Buffer {
  const raw = readFileSync(path.join(fixturesDir, relativePath), 'utf8');
  const parsed = JSON.parse(raw);
  // Re-serialize so the byte sequence is deterministic and the signature
  // computed over `bodyBuf` exactly matches what supertest sends as the body.
  return Buffer.from(JSON.stringify(parsed));
}

const bodyBuf = loadFixtureBuffer('whatsapp/text-inbound.json');
const signature = signBody(bodyBuf, APP_SECRET);

await request(app)
  .post('/webhook')
  .set('Content-Type', 'application/json')
  .set('x-hub-signature-256', signature)
  .send(bodyBuf.toString('utf8'));  // Send the exact bytes we signed.
```

`.send(bodyBuf.toString('utf8'))` rather than `.send(object)` is deliberate — supertest's object send path triggers its own `JSON.stringify` which may not produce byte-identical output.

The unit tests in [`tests/unit/security.test.ts`](../../tests/unit/security.test.ts) cover: valid signature, wrong secret, tampered body, missing header, empty-string header, missing `sha256=` prefix, non-hex characters, empty hex, wrong-length hex (must not throw on `timingSafeEqual`), and an empty-body roundtrip. A dedicated multi-secret block covers: a signature made with the first secret, a signature made with the second secret, an unrelated secret (rejected), single-string backward compat, an empty secrets array (always false), wrong-length hex against multiple secrets (no throw), and the exact production scenario — a WhatsApp body signed with `META_APP_SECRET` and an Instagram body signed with `INSTAGRAM_APP_SECRET` both passing when both secrets are provided. The middleware tests cover the 400 raw-body-missing path, the 401 paths, structured logging fields (`path`, `signaturePresent`, `bodyBytes`, `secretsCount`), and the two-secret middleware (request signed with the second secret passes `next()`; request signed with neither 401s).

## Code files

| File | Role |
| --- | --- |
| [`src/http/security.ts`](../../src/http/security.ts) | `verifyMetaSignature` pure function (single secret or candidate array); `createMetaSignatureVerifier` Express middleware factory. |
| [`src/http/app.ts`](../../src/http/app.ts) | Registers the `verify` hook on `express.json` to capture `req.rawBody`; builds the candidate secret set (`META_APP_SECRET` + `INSTAGRAM_APP_SECRET` when set, deduped); warns if the IG channel is enabled without its secret; mounts the verifier on POST `/webhook`. |
| [`scripts/lib/capture-server.ts`](../../scripts/lib/capture-server.ts) | Setup/capture server; mirrors the production secret set so captured Instagram webhooks verify against `INSTAGRAM_APP_SECRET`. |
| [`tests/unit/security.test.ts`](../../tests/unit/security.test.ts) | Edge cases of the verifier function and middleware, including multi-secret coverage. |
| [`tests/integration/webhook-routing.test.ts`](../../tests/integration/webhook-routing.test.ts) | Full-pipeline tests including the signature/no-signature paths through the real Express app. |

## Configuration

- `META_APP_SECRET` — verifies WhatsApp (`whatsapp_business_account`) and Messenger (`page`) webhooks. Required (always). Rotate via the Meta App Dashboard's temporary-secondary-secret mechanism (see https://developers.facebook.com/docs/development/build-and-test/app-secret).
- `INSTAGRAM_APP_SECRET` — verifies Instagram (`instagram`) webhooks. **Distinct from `META_APP_SECRET`** (Meta App Dashboard → Instagram → API setup with Instagram Business Login → "Instagram app secret"). Now consumed at RUNTIME for inbound IG webhook verification (previously only used by the OAuth setup script). Optional at config-load time so WhatsApp+Messenger-only deployments are unaffected — but if the Instagram channel is enabled and this is unset, every inbound IG webhook will `401`, and `createApp` warns at startup ("Instagram channel enabled but INSTAGRAM_APP_SECRET not set — inbound Instagram webhooks will fail signature verification.").

`createApp` builds the candidate secret set as `[META_APP_SECRET, ...(INSTAGRAM_APP_SECRET if set)]`, deduped (in case the two values are identical), and hands it to `createMetaSignatureVerifier`.

## Known limitations

- No secondary-secret rotation support yet — but the multi-secret verifier is the natural foundation for it. A rotation flow would add the previous secret to the candidate array during a grace window; the try-all match logic already supports "current OR previous" with no further change. (The candidate set is built once at `createApp` time, so a live rotation would still require a process restart or a reload hook.)
- The verifier doesn't surface a distinct "header malformed" vs. "header wrong" error to the client (both return `invalid_signature`). This is intentional — leaking the difference helps an attacker calibrate. The logs do distinguish via `signaturePresent`, `bodyBytes`, and `secretsCount`.
