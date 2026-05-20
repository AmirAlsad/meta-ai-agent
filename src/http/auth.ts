import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

/**
 * Constant-time check of a request bearer token against an expected value.
 * Accepts either `Authorization: Bearer <token>` or `x-admin-api-token: <token>`.
 * Always performs a fixed-cost comparison even on length mismatch to avoid
 * leaking information about how close the supplied token is.
 */
export function validateAdminToken(req: Request, expected: string): boolean {
  const authorization = req.header('authorization');
  if (authorization && authorization.toLowerCase().startsWith('bearer ')) {
    const provided = authorization.slice('bearer '.length).trim();
    if (constantTimeStringEquals(provided, expected)) return true;
  }
  const headerToken = req.header('x-admin-api-token');
  if (headerToken && constantTimeStringEquals(headerToken, expected)) return true;
  return false;
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
