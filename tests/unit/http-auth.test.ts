import { describe, expect, it } from 'vitest';
import httpMocks from 'node-mocks-http';
import type { Request } from 'express';
import { validateAdminToken, constantTimeStringEquals } from '../../src/http/auth.js';

const EXPECTED = 'super-secret-admin-token';

function makeReq(headers: Record<string, string> = {}): Request {
  return httpMocks.createRequest({
    method: 'GET',
    url: '/admin/queue',
    headers
  }) as unknown as Request;
}

describe('validateAdminToken', () => {
  it('returns true for a valid Authorization: Bearer token', () => {
    const req = makeReq({ authorization: `Bearer ${EXPECTED}` });
    expect(validateAdminToken(req, EXPECTED)).toBe(true);
  });

  it('accepts a case-insensitive "bearer " scheme prefix', () => {
    const req = makeReq({ authorization: `bEaReR ${EXPECTED}` });
    expect(validateAdminToken(req, EXPECTED)).toBe(true);
  });

  it('tolerates surrounding whitespace after the bearer scheme', () => {
    const req = makeReq({ authorization: `Bearer   ${EXPECTED}  ` });
    expect(validateAdminToken(req, EXPECTED)).toBe(true);
  });

  it('returns true for a valid x-admin-api-token header', () => {
    const req = makeReq({ 'x-admin-api-token': EXPECTED });
    expect(validateAdminToken(req, EXPECTED)).toBe(true);
  });

  it('returns false for a wrong bearer token', () => {
    const req = makeReq({ authorization: 'Bearer not-the-token' });
    expect(validateAdminToken(req, EXPECTED)).toBe(false);
  });

  it('returns false for a wrong x-admin-api-token header', () => {
    const req = makeReq({ 'x-admin-api-token': 'nope' });
    expect(validateAdminToken(req, EXPECTED)).toBe(false);
  });

  it('returns false when no auth header is present', () => {
    expect(validateAdminToken(makeReq(), EXPECTED)).toBe(false);
  });

  it('returns false when the Authorization header lacks the Bearer scheme', () => {
    const req = makeReq({ authorization: EXPECTED });
    expect(validateAdminToken(req, EXPECTED)).toBe(false);
  });

  it('does not throw and returns false for a length-mismatched bearer token', () => {
    const req = makeReq({ authorization: 'Bearer short' });
    expect(() => validateAdminToken(req, EXPECTED)).not.toThrow();
    expect(validateAdminToken(req, EXPECTED)).toBe(false);
  });

  it('does not throw and returns false for a length-mismatched header token', () => {
    const req = makeReq({ 'x-admin-api-token': `${EXPECTED}-with-extra-bytes` });
    expect(() => validateAdminToken(req, EXPECTED)).not.toThrow();
    expect(validateAdminToken(req, EXPECTED)).toBe(false);
  });

  it('prefers the header token when the bearer is wrong but the header is right', () => {
    const req = makeReq({
      authorization: 'Bearer wrong-token-here-xx',
      'x-admin-api-token': EXPECTED
    });
    expect(validateAdminToken(req, EXPECTED)).toBe(true);
  });
});

describe('constantTimeStringEquals', () => {
  it('returns true for two equal strings', () => {
    expect(constantTimeStringEquals('abc123', 'abc123')).toBe(true);
  });

  it('returns false for equal-length but different strings', () => {
    expect(constantTimeStringEquals('abc123', 'abc124')).toBe(false);
  });

  it('returns false when the provided string is LONGER than expected (no throw)', () => {
    expect(() => constantTimeStringEquals('abc123xxxx', 'abc123')).not.toThrow();
    expect(constantTimeStringEquals('abc123xxxx', 'abc123')).toBe(false);
  });

  it('returns false when the provided string is SHORTER than expected (no throw)', () => {
    expect(() => constantTimeStringEquals('abc', 'abc123')).not.toThrow();
    expect(constantTimeStringEquals('abc', 'abc123')).toBe(false);
  });

  it('returns true for two empty strings', () => {
    expect(constantTimeStringEquals('', '')).toBe(true);
  });

  it('returns false when only one side is empty (no throw)', () => {
    expect(() => constantTimeStringEquals('', 'abc')).not.toThrow();
    expect(constantTimeStringEquals('', 'abc')).toBe(false);
    expect(constantTimeStringEquals('abc', '')).toBe(false);
  });

  it('handles multi-byte UTF-8 correctly (byte length, not char length)', () => {
    // 'é' is 2 bytes in UTF-8; equal strings must still compare equal.
    expect(constantTimeStringEquals('café', 'café')).toBe(true);
    // Same char count, different content.
    expect(constantTimeStringEquals('café', 'cafe')).toBe(false);
  });
});
