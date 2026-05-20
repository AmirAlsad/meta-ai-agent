import { describe, expect, it } from 'vitest';
import httpMocks from 'node-mocks-http';
import pino from 'pino';
import type { Request, Response } from 'express';
import { traceMiddleware, requestContextFromLocals } from '../../src/http/trace.js';

const silentLogger = pino({ level: 'silent' });

// A loose UUID v4 shape check — we only need to assert "a generated id was
// minted", not validate the RFC down to the version nibble.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ReqOpts {
  traceHeader?: string;
  path?: string;
}

function makeReq(opts: ReqOpts = {}): Request {
  const headers: Record<string, string> = {};
  if (typeof opts.traceHeader === 'string') headers['x-trace-id'] = opts.traceHeader;
  return httpMocks.createRequest({
    method: 'GET',
    url: opts.path ?? '/metrics',
    headers
  }) as unknown as Request;
}

function makeRes(): Response {
  return httpMocks.createResponse() as unknown as Response;
}

function getTraceHeader(res: Response): unknown {
  return (res as unknown as { getHeader: (n: string) => unknown }).getHeader('x-trace-id');
}

describe('traceMiddleware', () => {
  it('generates a uuid traceId when no inbound header is present', () => {
    const req = makeReq();
    const res = makeRes();
    let nextCalls = 0;

    traceMiddleware({ logger: silentLogger })(req, res, () => {
      nextCalls += 1;
    });

    expect(nextCalls).toBe(1);
    expect(res.locals.traceId).toMatch(UUID_RE);
    expect(getTraceHeader(res)).toBe(res.locals.traceId);
    // A child logger was attached.
    expect(res.locals.requestLogger).toBeDefined();
  });

  it('accepts a valid inbound x-trace-id and echoes it back', () => {
    const inbound = 'trace-abc.123:def-456';
    const req = makeReq({ traceHeader: inbound });
    const res = makeRes();

    traceMiddleware({ logger: silentLogger })(req, res, () => {});

    expect(res.locals.traceId).toBe(inbound);
    expect(getTraceHeader(res)).toBe(inbound);
  });

  it('trims surrounding whitespace from an otherwise-valid inbound header', () => {
    const req = makeReq({ traceHeader: '   trace-trimmed-1   ' });
    const res = makeRes();

    traceMiddleware({ logger: silentLogger })(req, res, () => {});

    expect(res.locals.traceId).toBe('trace-trimmed-1');
  });

  it('REJECTS a header containing a newline (CRLF injection) and mints a fresh uuid', () => {
    const injection = 'abc\r\nset-cookie: evil=1';
    const req = makeReq({ traceHeader: injection });
    const res = makeRes();

    traceMiddleware({ logger: silentLogger })(req, res, () => {});

    expect(res.locals.traceId).not.toBe(injection);
    expect(res.locals.traceId).toMatch(UUID_RE);
    // The untrusted bytes are never reflected into the response header.
    expect(getTraceHeader(res)).toBe(res.locals.traceId);
    expect(String(getTraceHeader(res))).not.toContain('\n');
    expect(String(getTraceHeader(res))).not.toContain('set-cookie');
  });

  it('REJECTS a header containing a space and mints a fresh uuid', () => {
    const req = makeReq({ traceHeader: 'has a space' });
    const res = makeRes();

    traceMiddleware({ logger: silentLogger })(req, res, () => {});

    expect(res.locals.traceId).toMatch(UUID_RE);
  });

  it('REJECTS a header containing a < (log/markup injection) and mints a fresh uuid', () => {
    const req = makeReq({ traceHeader: '<script>alert(1)</script>' });
    const res = makeRes();

    traceMiddleware({ logger: silentLogger })(req, res, () => {});

    expect(res.locals.traceId).toMatch(UUID_RE);
    expect(String(getTraceHeader(res))).not.toContain('<');
  });

  it('REJECTS an over-length header (>128 chars) and mints a fresh uuid', () => {
    const req = makeReq({ traceHeader: 'a'.repeat(129) });
    const res = makeRes();

    traceMiddleware({ logger: silentLogger })(req, res, () => {});

    expect(res.locals.traceId).toMatch(UUID_RE);
  });

  it('accepts a 128-char header at the boundary', () => {
    const boundary = 'a'.repeat(128);
    const req = makeReq({ traceHeader: boundary });
    const res = makeRes();

    traceMiddleware({ logger: silentLogger })(req, res, () => {});

    expect(res.locals.traceId).toBe(boundary);
  });

  it('REJECTS an empty-string header and mints a fresh uuid', () => {
    const req = makeReq({ traceHeader: '' });
    const res = makeRes();

    traceMiddleware({ logger: silentLogger })(req, res, () => {});

    expect(res.locals.traceId).toMatch(UUID_RE);
  });
});

describe('requestContextFromLocals', () => {
  it('returns the context when both traceId and logger are present', () => {
    const req = makeReq({ traceHeader: 'ctx-trace-1' });
    const res = makeRes();
    traceMiddleware({ logger: silentLogger })(req, res, () => {});

    const ctx = requestContextFromLocals(res);
    expect(ctx).toBeDefined();
    expect(ctx?.traceId).toBe('ctx-trace-1');
    expect(ctx?.logger).toBe(res.locals.requestLogger);
  });

  it('returns undefined when locals were never populated', () => {
    const res = makeRes();
    expect(requestContextFromLocals(res)).toBeUndefined();
  });

  it('returns undefined when traceId is present but logger is missing', () => {
    const res = makeRes();
    res.locals.traceId = 'orphan-trace';
    expect(requestContextFromLocals(res)).toBeUndefined();
  });
});
