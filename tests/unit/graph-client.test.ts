import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphClient } from '../../src/meta/shared/graph-client.js';
import { MetaApiError } from '../../src/meta/shared/errors.js';

/* ────────────────────────────────────────────────────────────────────────── */
/* Helpers                                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

const API_VERSION = 'v25.0';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  });
}

/** A recording sleep that resolves immediately — NO real delay in tests. */
function recordingSleep(): { fn: (ms: number) => Promise<void>; calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    fn: (ms: number) => {
      calls.push(ms);
      return Promise.resolve();
    }
  };
}

/** Build a client with an injected fetch mock + recording sleep. */
function makeClient(
  fetchImpl: ReturnType<typeof vi.fn>,
  overrides: { maxRetries?: number; baseBackoffMs?: number; maxBackoffMs?: number } = {}
) {
  const sleep = recordingSleep();
  const client = new GraphClient({
    apiVersion: API_VERSION,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleep: sleep.fn,
    ...overrides
  });
  return { client, sleep };
}

// Make jitter deterministic so backoff assertions are stable. The client adds
// `Math.random() * baseBackoffMs` of jitter; pinning random to 0 removes it.
beforeEach(() => {
  vi.spyOn(Math, 'random').mockReturnValue(0);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ────────────────────────────────────────────────────────────────────────── */
/* buildUrl                                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

describe('GraphClient.buildUrl', () => {
  const client = new GraphClient({ apiVersion: API_VERSION });

  it('builds a versioned URL on the default host', () => {
    expect(client.buildUrl({ path: '123/messages' })).toBe(
      'https://graph.facebook.com/v25.0/123/messages'
    );
  });

  it('omits the version segment when versioned is false', () => {
    expect(client.buildUrl({ path: 'me', versioned: false })).toBe('https://graph.facebook.com/me');
  });

  it('targets graph.instagram.com when host is overridden', () => {
    expect(client.buildUrl({ host: 'graph.instagram.com', path: '789/messages' })).toBe(
      'https://graph.instagram.com/v25.0/789/messages'
    );
  });

  it('strips a leading slash from the path', () => {
    expect(client.buildUrl({ path: '/123/messages' })).toBe(
      'https://graph.facebook.com/v25.0/123/messages'
    );
  });

  it('encodes query values and drops undefined ones', () => {
    const url = client.buildUrl({
      path: 'search',
      query: { q: 'hello world & co', n: 5, flag: true, skip: undefined }
    });
    expect(url).toBe('https://graph.facebook.com/v25.0/search?q=hello+world+%26+co&n=5&flag=true');
  });

  it('omits the query string entirely when no params resolve', () => {
    expect(client.buildUrl({ path: 'x', query: { a: undefined } })).toBe(
      'https://graph.facebook.com/v25.0/x'
    );
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Success paths                                                               */
/* ────────────────────────────────────────────────────────────────────────── */

describe('GraphClient.request — success', () => {
  it('returns parsed JSON for a GET', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { id: '123', name: 'X' }));
    const { client } = makeClient(fetchImpl);
    const result = await client.request<{ id: string; name: string }>({
      method: 'GET',
      path: '123',
      accessToken: 'tok',
      operation: 'test.get'
    });
    expect(result).toEqual({ id: '123', name: 'X' });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('returns parsed JSON for a POST and serializes the body', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { messages: [{ id: 'wamid.X' }] }));
    const { client } = makeClient(fetchImpl);
    const result = await client.request<{ messages: Array<{ id: string }> }>({
      method: 'POST',
      path: '123/messages',
      body: { messaging_product: 'whatsapp', to: '15551234567' },
      accessToken: 'tok',
      operation: 'whatsapp.sendText'
    });
    expect(result.messages[0]?.id).toBe('wamid.X');
    const [, init] = fetchImpl.mock.calls[0] ?? [];
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).body).toBe(
      JSON.stringify({ messaging_product: 'whatsapp', to: '15551234567' })
    );
  });

  it('returns {} when a 200 response has an empty body', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response('', { status: 200 }));
    const { client } = makeClient(fetchImpl);
    const result = await client.request({
      method: 'POST',
      path: '123/messages',
      accessToken: 'tok',
      operation: 'whatsapp.markRead'
    });
    expect(result).toEqual({});
  });

  it('sets Content-Type only when there is a body', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, {}))
      .mockResolvedValueOnce(jsonResponse(200, {}));
    const { client } = makeClient(fetchImpl);

    await client.request({ method: 'GET', path: 'a', accessToken: 'tok', operation: 'op' });
    const getHeaders = (fetchImpl.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(getHeaders['content-type']).toBeUndefined();

    await client.request({ method: 'POST', path: 'b', body: { x: 1 }, accessToken: 'tok', operation: 'op' });
    const postHeaders = (fetchImpl.mock.calls[1]?.[1] as RequestInit).headers as Record<string, string>;
    expect(postHeaders['content-type']).toBe('application/json');
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Auth                                                                        */
/* ────────────────────────────────────────────────────────────────────────── */

describe('GraphClient.request — auth', () => {
  it('sends the token as an Authorization: Bearer header', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, {}));
    const { client } = makeClient(fetchImpl);
    await client.request({
      method: 'GET',
      path: '123',
      accessToken: 'super-secret-token',
      operation: 'op'
    });
    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer super-secret-token');
  });

  it('never puts the token in the URL or query string', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, {}));
    const { client } = makeClient(fetchImpl);
    await client.request({
      method: 'GET',
      path: '123',
      query: { fields: 'name' },
      accessToken: 'super-secret-token',
      operation: 'op'
    });
    const [url] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).not.toContain('super-secret-token');
    expect(String(url)).not.toContain('access_token');
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Error handling (no retry)                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

describe('GraphClient.request — 4xx errors', () => {
  it('throws MetaApiError with parsed Meta fields and does NOT retry', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(400, {
        error: {
          message: 'Invalid parameter',
          type: 'OAuthException',
          code: 100,
          error_subcode: 2018001,
          fbtrace_id: 'trace-400'
        }
      })
    );
    const { client, sleep } = makeClient(fetchImpl);
    await expect(
      client.request({ method: 'POST', path: '123/messages', body: { x: 1 }, accessToken: 'tok', operation: 'whatsapp.sendText' })
    ).rejects.toMatchObject({
      name: 'MetaApiError',
      httpStatus: 400,
      errorCode: 100,
      errorSubCode: 2018001,
      fbtraceId: 'trace-400'
    });
    // 4xx is deterministic — exactly one attempt, no backoff sleep.
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(sleep.calls).toEqual([]);
  });

  it('puts the raw text in responseBody when the error body is not JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response('upstream blew up', { status: 400 }));
    const { client } = makeClient(fetchImpl);
    let caught: unknown;
    try {
      await client.request({ method: 'GET', path: 'x', accessToken: 'tok', operation: 'op' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MetaApiError);
    const meta = caught as MetaApiError;
    expect(meta.httpStatus).toBe(400);
    expect(meta.errorCode).toBeUndefined();
    expect(meta.responseBody).toBe('upstream blew up');
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Retry decision matrix                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

describe('GraphClient.request — retry: 429', () => {
  it('retries a 429 (even for a non-idempotent POST) and succeeds on a later attempt', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { error: { message: 'rate limited', code: 4 } }))
      .mockResolvedValueOnce(jsonResponse(429, { error: { message: 'rate limited', code: 4 } }))
      .mockResolvedValueOnce(jsonResponse(200, { messages: [{ id: 'wamid.OK' }] }));
    const { client, sleep } = makeClient(fetchImpl, { baseBackoffMs: 500, maxBackoffMs: 8000 });
    const result = await client.request<{ messages: Array<{ id: string }> }>({
      method: 'POST',
      path: '123/messages',
      body: { x: 1 },
      accessToken: 'tok',
      operation: 'whatsapp.sendText'
    });
    expect(result.messages[0]?.id).toBe('wamid.OK');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    // Exponential backoff with jitter pinned to 0: 500*2^0=500, 500*2^1=1000.
    expect(sleep.calls).toEqual([500, 1000]);
  });

  it('respects Retry-After (seconds), capped at maxBackoffMs', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { error: { message: 'slow down' } }, { 'retry-after': '2' }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const { client, sleep } = makeClient(fetchImpl, { maxBackoffMs: 8000 });
    await client.request({ method: 'GET', path: 'x', accessToken: 'tok', operation: 'op' });
    expect(sleep.calls).toEqual([2000]);
  });

  it('caps Retry-After at maxBackoffMs', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { error: { message: 'slow' } }, { 'retry-after': '60' }))
      .mockResolvedValueOnce(jsonResponse(200, {}));
    const { client, sleep } = makeClient(fetchImpl, { maxBackoffMs: 8000 });
    await client.request({ method: 'GET', path: 'x', accessToken: 'tok', operation: 'op' });
    expect(sleep.calls).toEqual([8000]);
  });
});

describe('GraphClient.request — retry: 5xx and idempotency (double-send safety)', () => {
  it('retries a 5xx on an idempotent GET', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, { error: { message: 'unavailable' } }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'x' }));
    const { client, sleep } = makeClient(fetchImpl);
    const result = await client.request<{ id: string }>({
      method: 'GET',
      path: '123',
      accessToken: 'tok',
      operation: 'op'
    });
    expect(result.id).toBe('x');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep.calls.length).toBe(1);
  });

  it('does NOT retry a 5xx on a non-idempotent POST (avoids double-send)', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(500, { error: { message: 'server error', code: 1 } }));
    const { client, sleep } = makeClient(fetchImpl);
    await expect(
      client.request({ method: 'POST', path: '123/messages', body: { x: 1 }, accessToken: 'tok', operation: 'whatsapp.sendText' })
    ).rejects.toBeInstanceOf(MetaApiError);
    // Load-bearing: a 5xx after a POST might mean the message WAS sent.
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(sleep.calls).toEqual([]);
  });

  it('retries a 5xx on a POST when the caller opts in via idempotent: true', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(500, { error: { message: 'server error' } }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const { client } = makeClient(fetchImpl);
    await client.request({
      method: 'POST',
      path: 'x',
      body: { x: 1 },
      accessToken: 'tok',
      operation: 'op',
      idempotent: true
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('GraphClient.request — retry: network errors', () => {
  it('wraps a fetch rejection as MetaApiError httpStatus 0 with cause, and retries it', async () => {
    const networkErr = new Error('ECONNREFUSED');
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(networkErr)
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const { client, sleep } = makeClient(fetchImpl);
    const result = await client.request<{ ok: boolean }>({
      // POST on purpose: a pre-response network failure is safe to retry even
      // for non-idempotent requests because the request never reached Meta.
      method: 'POST',
      path: '123/messages',
      body: { x: 1 },
      accessToken: 'tok',
      operation: 'whatsapp.sendText'
    });
    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep.calls.length).toBe(1);
  });

  it('throws the network MetaApiError (httpStatus 0, cause set) when retries are exhausted', async () => {
    const networkErr = new Error('ENOTFOUND');
    const fetchImpl = vi.fn().mockRejectedValue(networkErr);
    const { client } = makeClient(fetchImpl, { maxRetries: 2 });
    let caught: unknown;
    try {
      await client.request({ method: 'POST', path: 'x', body: {}, accessToken: 'tok', operation: 'op' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MetaApiError);
    const meta = caught as MetaApiError & { cause?: unknown };
    expect(meta.httpStatus).toBe(0);
    expect(meta.cause).toBe(networkErr);
    // Initial attempt + 2 retries = 3 total.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe('GraphClient.request — exhausted retries', () => {
  it('throws the last MetaApiError after exhausting retries on persistent 429', async () => {
    // Return a FRESH Response per call — a Response body is a one-shot stream,
    // so reusing one instance across attempts would fail the second read.
    const fetchImpl = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(jsonResponse(429, { error: { message: 'still limited', code: 4, fbtrace_id: 'last' } }))
      );
    const { client } = makeClient(fetchImpl, { maxRetries: 2 });
    let caught: unknown;
    try {
      await client.request({ method: 'GET', path: 'x', accessToken: 'tok', operation: 'op' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MetaApiError);
    const meta = caught as MetaApiError;
    expect(meta.httpStatus).toBe(429);
    expect(meta.fbtraceId).toBe('last');
    // Initial attempt + 2 retries = 3.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Logging                                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

describe('GraphClient.request — logging', () => {
  it('logs a warn on each retry without leaking the token', async () => {
    const warn = vi.fn();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { error: { message: 'rate limited' } }))
      .mockResolvedValueOnce(jsonResponse(200, {}));
    const sleep = recordingSleep();
    const client = new GraphClient({
      apiVersion: API_VERSION,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: sleep.fn,
      logger: { warn, debug: vi.fn() }
    });
    await client.request({ method: 'GET', path: 'x', accessToken: 'secret-tok', operation: 'op' });
    expect(warn).toHaveBeenCalledTimes(1);
    const [meta, msg] = warn.mock.calls[0] ?? [];
    expect(msg).toBe('graph request retrying');
    expect(meta).toMatchObject({ operation: 'op', attempt: 0, status: 429 });
    expect(JSON.stringify(meta)).not.toContain('secret-tok');
  });
});
