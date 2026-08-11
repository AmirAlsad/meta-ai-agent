import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

/**
 * Constant-time check of a request bearer token against an expected value.
 * Accepts either `Authorization: Bearer <token>` or a channel-specific header
 * named by `headerName`. Always performs a fixed-cost comparison even on length
 * mismatch to avoid leaking information about how close the supplied token is.
 *
 * WHY the header name is a parameter: each token-gated surface carries its OWN
 * credential (admin introspection reads conversation PII; `/stats/daily` reads
 * only counts), and the separation is only real if a caller holding one token
 * cannot present it to the other surface. Every route therefore compares against
 * exactly one expected value — this function never consults a token set — and the
 * distinct header name keeps a client from accidentally offering the wrong one.
 */
export function validateBearerToken(
  req: Request,
  expected: string,
  headerName: string
): boolean {
  const authorization = req.header('authorization');
  if (authorization && authorization.toLowerCase().startsWith('bearer ')) {
    const provided = authorization.slice('bearer '.length).trim();
    if (constantTimeStringEquals(provided, expected)) return true;
  }
  const headerToken = req.header(headerName);
  if (headerToken && constantTimeStringEquals(headerToken, expected)) return true;
  return false;
}

/**
 * The admin-surface form of {@link validateBearerToken}: `Authorization: Bearer`
 * or `x-admin-api-token`. Behavior is unchanged from before the header name was
 * parameterized.
 */
export function validateAdminToken(req: Request, expected: string): boolean {
  return validateBearerToken(req, expected, 'x-admin-api-token');
}

/**
 * The stats-surface form of {@link validateBearerToken}: `Authorization: Bearer`
 * or `x-stats-api-token`. The expected value is `config.statsApiToken`, never the
 * admin token — see the note on {@link validateBearerToken}.
 */
export function validateStatsToken(req: Request, expected: string): boolean {
  return validateBearerToken(req, expected, 'x-stats-api-token');
}

export function constantTimeStringEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) {
    // timingSafeEqual requires equal-length buffers. Allocate a temp the same
    // size as the provided value and copy as many bytes of the expected token
    // as fit, then run timingSafeEqual against the actual provided buffer.
    // This way a length-mismatched probe still spends a comparison cost
    // proportional to the provided length, and the cost depends on `b`'s
    // bytes — not just on `a`'s — narrowing the timing channel that the
    // self-compare variant left open.
    const padded = Buffer.alloc(bufferA.length);
    bufferB.copy(padded, 0, 0, Math.min(bufferA.length, bufferB.length));
    timingSafeEqual(bufferA, padded);
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}
