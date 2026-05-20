import { describe, expect, it } from 'vitest';
import { MetaApiError, extractServerMessage } from '../../src/meta/shared/errors.js';

/**
 * The detailed message-formatting / truncation behavior is exercised by
 * `scripts-graph-api.test.ts` (which imports `MetaApiError` via the
 * `scripts/lib/graph-api.ts` re-export). This file confirms the CANONICAL
 * module (`src/meta/shared/errors.ts`) exports the same class with the same
 * public shape — i.e. the consolidation didn't drift the contract.
 */
describe('MetaApiError (canonical module)', () => {
  it('constructs with all structured fields', () => {
    const err = new MetaApiError({
      operation: 'whatsapp.sendText',
      httpStatus: 400,
      errorCode: 100,
      errorSubCode: 33,
      fbtraceId: 'trace-abc',
      responseBody: { error: { message: 'Invalid parameter' } }
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('MetaApiError');
    expect(err.operation).toBe('whatsapp.sendText');
    expect(err.httpStatus).toBe(400);
    expect(err.errorCode).toBe(100);
    expect(err.errorSubCode).toBe(33);
    expect(err.fbtraceId).toBe('trace-abc');
    expect(err.responseBody).toEqual({ error: { message: 'Invalid parameter' } });
  });

  it('formats a useful message including operation, status, codes, and server message', () => {
    const err = new MetaApiError({
      operation: 'messenger.sendText',
      httpStatus: 400,
      errorCode: 190,
      errorSubCode: 463,
      fbtraceId: 'trace-xyz',
      responseBody: { error: { message: 'Token expired' } }
    });
    expect(err.message).toContain('messenger.sendText');
    expect(err.message).toContain('HTTP 400');
    expect(err.message).toContain('code 190');
    expect(err.message).toContain('subcode 463');
    expect(err.message).toContain('fbtrace_id: trace-xyz');
    expect(err.message).toContain('Token expired');
  });

  it('honors an explicit message override', () => {
    const err = new MetaApiError({
      operation: 'op',
      httpStatus: 500,
      responseBody: undefined,
      message: 'pre-formatted message'
    });
    expect(err.message).toBe('pre-formatted message');
  });

  it('sets `.cause` when provided (and preserves the inner error)', () => {
    const inner = new Error('ECONNRESET');
    const err = new MetaApiError({
      operation: 'op',
      httpStatus: 0,
      responseBody: 'ECONNRESET',
      cause: inner
    });
    expect((err as Error & { cause?: unknown }).cause).toBe(inner);
  });

  it('does not set `.cause` when omitted', () => {
    const err = new MetaApiError({ operation: 'op', httpStatus: 500, responseBody: undefined });
    expect((err as Error & { cause?: unknown }).cause).toBeUndefined();
  });
});

describe('extractServerMessage', () => {
  it('pulls error.message out of a Meta error envelope', () => {
    expect(extractServerMessage({ error: { message: 'boom' } })).toBe('boom');
  });

  it('returns undefined for non-envelope shapes', () => {
    expect(extractServerMessage(null)).toBeUndefined();
    expect(extractServerMessage('plain string')).toBeUndefined();
    expect(extractServerMessage({ notError: true })).toBeUndefined();
    expect(extractServerMessage({ error: { code: 1 } })).toBeUndefined();
  });
});
