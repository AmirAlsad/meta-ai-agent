import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import httpMocks from 'node-mocks-http';
import type { Request, Response } from 'express';
import { verifyMetaSignature, createMetaSignatureVerifier } from '../../src/http/security.js';

const SECRET = 'test-app-secret';

function signBody(body: Buffer, secret: string = SECRET): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

function makeLogger() {
  return {
    warn: vi.fn(),
    error: vi.fn()
  };
}

interface ReqOpts {
  rawBody?: Buffer | undefined;
  signatureHeader?: string;
  path?: string;
}

function makeReq(opts: ReqOpts = {}): Request {
  const headers: Record<string, string> = {};
  if (typeof opts.signatureHeader === 'string') {
    headers['x-hub-signature-256'] = opts.signatureHeader;
  }
  const req = httpMocks.createRequest({
    method: 'POST',
    url: opts.path ?? '/webhook',
    headers
  }) as unknown as Request & { rawBody?: Buffer };
  if (opts.rawBody !== undefined) {
    req.rawBody = opts.rawBody;
  }
  return req as Request;
}

function makeRes(): Response {
  return httpMocks.createResponse() as unknown as Response;
}

describe('verifyMetaSignature', () => {
  const body = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [] }));

  it('returns true for a valid signature', () => {
    expect(verifyMetaSignature(body, signBody(body), SECRET)).toBe(true);
  });

  it('returns false when signed with a different secret', () => {
    const wrongSig = signBody(body, 'different-secret');
    expect(verifyMetaSignature(body, wrongSig, SECRET)).toBe(false);
  });

  it('returns false when the body is tampered after signing', () => {
    const original = Buffer.from('{"a":1}');
    const tampered = Buffer.from('{"a":2}');
    const sig = signBody(original);
    expect(verifyMetaSignature(tampered, sig, SECRET)).toBe(false);
  });

  it('returns false when the signature header is undefined', () => {
    expect(() => verifyMetaSignature(body, undefined, SECRET)).not.toThrow();
    expect(verifyMetaSignature(body, undefined, SECRET)).toBe(false);
  });

  it('returns false for an empty-string header', () => {
    expect(verifyMetaSignature(body, '', SECRET)).toBe(false);
  });

  it('returns false when the header is missing the sha256= prefix', () => {
    const hex = createHmac('sha256', SECRET).update(body).digest('hex');
    expect(verifyMetaSignature(body, hex, SECRET)).toBe(false);
  });

  it('returns false when the hex portion contains non-hex chars', () => {
    expect(verifyMetaSignature(body, 'sha256=' + 'z'.repeat(64), SECRET)).toBe(false);
  });

  it('returns false when the hex portion is empty', () => {
    expect(verifyMetaSignature(body, 'sha256=', SECRET)).toBe(false);
  });

  it('returns false for a wrong-length signature without throwing', () => {
    // 16 bytes (32 hex chars) is too short for SHA-256 (32 bytes / 64 hex chars).
    // The module must guard against this BEFORE calling timingSafeEqual, which
    // throws on length mismatch — this test catches a regression in that guard.
    const shortSig = 'sha256=' + 'aa'.repeat(16);
    expect(() => verifyMetaSignature(body, shortSig, SECRET)).not.toThrow();
    expect(verifyMetaSignature(body, shortSig, SECRET)).toBe(false);
  });

  it('returns true for a valid signature over an empty body', () => {
    const empty = Buffer.alloc(0);
    expect(verifyMetaSignature(empty, signBody(empty), SECRET)).toBe(true);
  });
});

describe('verifyMetaSignature with multiple secrets', () => {
  // Models the production multi-secret set: META_APP_SECRET (WhatsApp +
  // Messenger) and INSTAGRAM_APP_SECRET (Instagram). The verifier must accept a
  // signature made with ANY configured secret.
  const META_SECRET = 'meta-app-secret';
  const IG_SECRET = 'instagram-app-secret';
  const body = Buffer.from(JSON.stringify({ object: 'instagram', entry: [] }));

  it('accepts a signature made with the FIRST secret in the array', () => {
    const sig = signBody(body, META_SECRET);
    expect(verifyMetaSignature(body, sig, [META_SECRET, IG_SECRET])).toBe(true);
  });

  it('accepts a signature made with the SECOND secret in the array', () => {
    const sig = signBody(body, IG_SECRET);
    expect(verifyMetaSignature(body, sig, [META_SECRET, IG_SECRET])).toBe(true);
  });

  it('rejects a signature made with an unrelated secret not in the array', () => {
    const sig = signBody(body, 'some-other-secret');
    expect(verifyMetaSignature(body, sig, [META_SECRET, IG_SECRET])).toBe(false);
  });

  it('still accepts a single-string secret (backward-compat regression)', () => {
    expect(verifyMetaSignature(body, signBody(body, META_SECRET), META_SECRET)).toBe(true);
  });

  it('returns false for an empty secrets array (nothing to match)', () => {
    // Even a perfectly-formed signature cannot match when no secret is provided.
    const sig = signBody(body, META_SECRET);
    expect(verifyMetaSignature(body, sig, [])).toBe(false);
  });

  it('returns false (no throw) for a wrong-length signature against multiple secrets', () => {
    // Regression: the per-secret length guard must skip to the next secret
    // rather than letting timingSafeEqual throw on a length mismatch.
    const shortSig = 'sha256=' + 'aa'.repeat(16);
    expect(() => verifyMetaSignature(body, shortSig, [META_SECRET, IG_SECRET])).not.toThrow();
    expect(verifyMetaSignature(body, shortSig, [META_SECRET, IG_SECRET])).toBe(false);
  });

  it('verifies the exact production scenario: WhatsApp body signed with META secret AND IG body signed with IG secret both pass', () => {
    const secrets = [META_SECRET, IG_SECRET];
    const whatsappBody = Buffer.from(
      JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '1' }] })
    );
    const instagramBody = Buffer.from(JSON.stringify({ object: 'instagram', entry: [{ id: '2' }] }));

    expect(verifyMetaSignature(whatsappBody, signBody(whatsappBody, META_SECRET), secrets)).toBe(
      true
    );
    expect(verifyMetaSignature(instagramBody, signBody(instagramBody, IG_SECRET), secrets)).toBe(
      true
    );
    // And cross-signing (IG body with META secret) must NOT pass — that is
    // precisely the production bug this fix addresses.
    expect(verifyMetaSignature(instagramBody, signBody(instagramBody, META_SECRET), [
      IG_SECRET
    ])).toBe(false);
  });
});

describe('createMetaSignatureVerifier', () => {
  const body = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '1' }] }));

  it('calls next() and does not write a response on valid signature', () => {
    const middleware = createMetaSignatureVerifier(SECRET);
    const req = makeReq({ rawBody: body, signatureHeader: signBody(body) });
    const res = makeRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect((res as unknown as { _isEndCalled: () => boolean })._isEndCalled()).toBe(false);
  });

  it('responds 401 with invalid_signature when the signature is wrong', () => {
    const middleware = createMetaSignatureVerifier(SECRET);
    const req = makeReq({ rawBody: body, signatureHeader: signBody(body, 'wrong-secret') });
    const res = makeRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect((res as unknown as { _getJSONData: () => unknown })._getJSONData()).toEqual({
      error: 'invalid_signature'
    });
  });

  it('responds 400 with raw_body_unavailable when rawBody is missing', () => {
    const middleware = createMetaSignatureVerifier(SECRET, makeLogger());
    const req = makeReq({ signatureHeader: signBody(body) });
    const res = makeRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect((res as unknown as { _getJSONData: () => unknown })._getJSONData()).toEqual({
      error: 'raw_body_unavailable'
    });
  });

  it('logs the missing-rawBody failure with structured fields via error()', () => {
    const logger = makeLogger();
    const middleware = createMetaSignatureVerifier(SECRET, logger);
    const req = makeReq({ signatureHeader: signBody(body), path: '/webhook/whatsapp' });
    const res = makeRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/webhook/whatsapp',
        signaturePresent: true,
        bodyBytes: 0
      }),
      expect.any(String)
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('falls back to warn() when no error() method is provided and rawBody is missing', () => {
    const logger = { warn: vi.fn() };
    const middleware = createMetaSignatureVerifier(SECRET, logger);
    const req = makeReq({ signatureHeader: signBody(body) });
    const res = makeRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ signaturePresent: true, bodyBytes: 0 }),
      expect.any(String)
    );
  });

  it('responds 401 when the signature header is missing entirely', () => {
    const middleware = createMetaSignatureVerifier(SECRET);
    const req = makeReq({ rawBody: body });
    const res = makeRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect((res as unknown as { _getJSONData: () => unknown })._getJSONData()).toEqual({
      error: 'invalid_signature'
    });
  });

  it('logs structured fields on signature-verification failure via warn()', () => {
    const logger = makeLogger();
    const middleware = createMetaSignatureVerifier(SECRET, logger);
    const req = makeReq({
      rawBody: body,
      signatureHeader: signBody(body, 'wrong-secret'),
      path: '/webhook/messenger'
    });
    const res = makeRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/webhook/messenger',
        signaturePresent: true,
        bodyBytes: body.length
      }),
      expect.any(String)
    );
  });

  it('reports signaturePresent=false in log fields when no header was sent', () => {
    const logger = makeLogger();
    const middleware = createMetaSignatureVerifier(SECRET, logger);
    const req = makeReq({ rawBody: body });
    const res = makeRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ signaturePresent: false, bodyBytes: body.length }),
      expect.any(String)
    );
  });

  describe('with multiple secrets', () => {
    const META_SECRET = 'meta-app-secret';
    const IG_SECRET = 'instagram-app-secret';

    it('calls next() when the request is signed with the SECOND secret', () => {
      const middleware = createMetaSignatureVerifier([META_SECRET, IG_SECRET]);
      const req = makeReq({ rawBody: body, signatureHeader: signBody(body, IG_SECRET) });
      const res = makeRes();
      const next = vi.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect((res as unknown as { _isEndCalled: () => boolean })._isEndCalled()).toBe(false);
    });

    it('401s when the request is signed with neither configured secret', () => {
      const middleware = createMetaSignatureVerifier([META_SECRET, IG_SECRET]);
      const req = makeReq({ rawBody: body, signatureHeader: signBody(body, 'neither-secret') });
      const res = makeRes();
      const next = vi.fn();

      middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(401);
      expect((res as unknown as { _getJSONData: () => unknown })._getJSONData()).toEqual({
        error: 'invalid_signature'
      });
    });

    it('includes secretsCount in the failure log', () => {
      const logger = makeLogger();
      const middleware = createMetaSignatureVerifier([META_SECRET, IG_SECRET], logger);
      const req = makeReq({ rawBody: body, signatureHeader: signBody(body, 'neither-secret') });
      const res = makeRes();
      const next = vi.fn();

      middleware(req, res, next);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ secretsCount: 2, bodyBytes: body.length }),
        expect.any(String)
      );
    });
  });
});
