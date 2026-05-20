import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

const SIGNATURE_PREFIX = 'sha256=';

/**
 * Verifies a Meta X-Hub-Signature-256 against the raw request body using HMAC-SHA256.
 * Constant-time comparison. Returns false (never throws) if header is missing,
 * malformed, or the digest doesn't match ANY of the provided secrets.
 *
 * WHY multiple secrets (try-all): a single Meta App fans three products into one
 * webhook URL, but they do NOT all sign with the same secret. WhatsApp
 * (`object: whatsapp_business_account`) and Messenger (`object: page`) sign with
 * `META_APP_SECRET`; Instagram (`object: instagram`) signs with the Instagram
 * product's own `INSTAGRAM_APP_SECRET` (proven against the live API 2026-05-20 —
 * an IG DM webhook's HMAC matched only `INSTAGRAM_APP_SECRET`, never the Meta App
 * secret). We accept the signature if it matches ANY configured secret rather
 * than parsing the body to pick a secret per-channel: signature verification runs
 * on the RAW bytes BEFORE JSON parsing, and parsing untrusted/unverified input to
 * choose a secret would add a parse-before-verify risk surface. Both secrets
 * belong to the same Meta App's trust domain, so "matches either" is the correct
 * trust model. Early-return on first match is safe — which secret matched is not
 * a meaningful signal to leak (both are server-side), and the constant-time
 * property that matters (`timingSafeEqual` within each HMAC compare) is preserved
 * per-secret.
 */
export function verifyMetaSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  appSecret: string | readonly string[]
): boolean {
  if (!signatureHeader || typeof signatureHeader !== 'string') return false;
  if (!signatureHeader.startsWith(SIGNATURE_PREFIX)) return false;

  const providedHex = signatureHeader.slice(SIGNATURE_PREFIX.length);
  if (providedHex.length === 0 || !/^[0-9a-fA-F]+$/.test(providedHex)) return false;

  // Parse the provided hex ONCE; reuse across every candidate secret.
  const providedBuf = Buffer.from(providedHex, 'hex');
  const secrets = typeof appSecret === 'string' ? [appSecret] : appSecret;

  for (const secret of secrets) {
    const expectedBuf = createHmac('sha256', secret).update(rawBody).digest();

    if (providedBuf.length !== expectedBuf.length) {
      // Keep timing flat on the length-mismatch rejection path — `timingSafeEqual`
      // throws on a length mismatch, so we self-compare instead and skip to the
      // next secret (digest length is fixed per algorithm, so this is effectively
      // "the provided signature is the wrong length for SHA-256").
      timingSafeEqual(expectedBuf, expectedBuf);
      continue;
    }

    if (timingSafeEqual(expectedBuf, providedBuf)) return true;
  }

  return false;
}

interface MinimalLogger {
  warn: (obj: object, msg?: string) => void;
  error?: (obj: object, msg?: string) => void;
}

/**
 * Express middleware factory that verifies X-Hub-Signature-256 on the request
 * and 401s if invalid. Requires that an earlier middleware has captured the raw
 * body buffer on `req.rawBody` (e.g., via express.json({ verify: (req, _res, buf) => { (req as any).rawBody = buf; } })).
 *
 * `appSecret` accepts a single secret OR an array of candidate secrets. The
 * request is accepted if its signature matches ANY of them — see
 * {@link verifyMetaSignature} for why (Instagram signs with its own
 * `INSTAGRAM_APP_SECRET`, not `META_APP_SECRET`).
 */
export function createMetaSignatureVerifier(
  appSecret: string | readonly string[],
  logger?: MinimalLogger
): (req: Request, res: Response, next: NextFunction) => void {
  const secretsCount = typeof appSecret === 'string' ? 1 : appSecret.length;
  return function metaSignatureVerifier(req: Request, res: Response, next: NextFunction): void {
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    const signatureHeader = req.header('x-hub-signature-256');
    const signaturePresent = typeof signatureHeader === 'string' && signatureHeader.length > 0;

    if (!Buffer.isBuffer(rawBody)) {
      const logFields = { path: req.path, signaturePresent, bodyBytes: 0 };
      const errMsg = 'raw body buffer missing; ensure express.json verify hook captures req.rawBody before this middleware';
      if (logger?.error) {
        logger.error(logFields, errMsg);
      } else {
        logger?.warn(logFields, errMsg);
      }
      res.status(400).json({ error: 'raw_body_unavailable' });
      return;
    }

    const ok = verifyMetaSignature(rawBody, signatureHeader, appSecret);
    if (!ok) {
      logger?.warn(
        { path: req.path, signaturePresent, bodyBytes: rawBody.length, secretsCount },
        'meta webhook signature verification failed'
      );
      res.status(401).json({ error: 'invalid_signature' });
      return;
    }

    next();
  };
}
