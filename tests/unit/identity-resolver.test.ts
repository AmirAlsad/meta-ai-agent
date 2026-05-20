/**
 * Unit tests for the Stage 6 identity resolver (`src/identity/resolver.ts`).
 *
 * Uses an injected `fetchImpl` mock so no real network is touched. Asserts the
 * happy path (2xx -> shaped Contact + cached), the cache-then-fetch
 * short-circuit, EVERY fail-open failure mode (non-2xx, network error, timeout,
 * malformed JSON, irrelevant body) returning `undefined` WITHOUT throwing, the
 * no-op resolver, and the PII-safe logging contract (no raw name/email ever
 * reaches the logger; the debug line is the redacted shape).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  HttpIdentityResolver,
  NoopIdentityResolver
} from '../../src/identity/resolver.js';
import type { IdentityLookupRequest } from '../../src/identity/resolver.js';
import { InMemoryContactStore } from '../../src/identity/contact-store.js';

const URL_ = 'https://lookup.example.test/identity';
const TIMEOUT = 5_000;

function makeRequest(overrides: Partial<IdentityLookupRequest> = {}): IdentityLookupRequest {
  return {
    channel: 'whatsapp',
    channelScopedUserId: '15551234567',
    channelScopedBusinessId: 'pn-1',
    ...overrides
  };
}

/** Minimal `Response`-like stub matching what `resolve` reads (`ok`/`status`/`json`). */
function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body
  } as unknown as Response;
}

function makeLogger() {
  return { warn: vi.fn(), debug: vi.fn() };
}

describe('HttpIdentityResolver.resolve — happy path', () => {
  it('POSTs the lookup request and shapes a 2xx body into a Contact', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ firstName: 'Ada', lastName: 'Lovelace', tags: ['tier:gold'] })
    ) as unknown as typeof fetch;

    const resolver = new HttpIdentityResolver({ lookupUrl: URL_, timeoutMs: TIMEOUT, fetchImpl });
    const contact = await resolver.resolve(makeRequest());

    expect(contact).toEqual({
      channel: 'whatsapp',
      channelScopedUserId: '15551234567',
      firstName: 'Ada',
      lastName: 'Lovelace',
      tags: ['tier:gold']
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(calledUrl).toBe(URL_);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body)).toEqual({
      channel: 'whatsapp',
      channelScopedUserId: '15551234567',
      channelScopedBusinessId: 'pn-1'
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('keys the contact off the REQUEST, ignoring channel/user id in the body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ channel: 'instagram', channelScopedUserId: 'spoofed', firstName: 'Ada' })
    ) as unknown as typeof fetch;
    const resolver = new HttpIdentityResolver({ lookupUrl: URL_, timeoutMs: TIMEOUT, fetchImpl });

    const contact = await resolver.resolve(makeRequest());
    expect(contact?.channel).toBe('whatsapp');
    expect(contact?.channelScopedUserId).toBe('15551234567');
  });

  it('shapes the full Contact field set and drops wrong-typed fields', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        firstName: 'Ada',
        lastName: 'Lovelace',
        displayName: 'Countess',
        email: 'ada@example.com',
        tags: ['a', 7, '', 'b'],
        customVariables: { plan: 'pro', bad: 5 },
        unifiedContactId: 'u-123',
        extraIgnored: { nested: true }
      })
    ) as unknown as typeof fetch;
    const resolver = new HttpIdentityResolver({ lookupUrl: URL_, timeoutMs: TIMEOUT, fetchImpl });

    expect(await resolver.resolve(makeRequest())).toEqual({
      channel: 'whatsapp',
      channelScopedUserId: '15551234567',
      firstName: 'Ada',
      lastName: 'Lovelace',
      displayName: 'Countess',
      email: 'ada@example.com',
      tags: ['a', 'b'],
      customVariables: { plan: 'pro' },
      unifiedContactId: 'u-123'
    });
  });

  it('stores a resolved contact in the contact store on success', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ firstName: 'Ada', tags: ['tier:gold'] })
    ) as unknown as typeof fetch;
    const contactStore = new InMemoryContactStore();
    const resolver = new HttpIdentityResolver({
      lookupUrl: URL_,
      timeoutMs: TIMEOUT,
      fetchImpl,
      contactStore
    });

    await resolver.resolve(makeRequest());
    expect(contactStore.get('whatsapp', '15551234567')).toMatchObject({ firstName: 'Ada' });
  });
});

describe('HttpIdentityResolver.resolve — cache-then-fetch', () => {
  it('returns the cached contact on a second resolve WITHOUT a second fetch', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ firstName: 'Ada', tags: ['tier:gold'] })
    ) as unknown as typeof fetch;
    const contactStore = new InMemoryContactStore();
    const resolver = new HttpIdentityResolver({
      lookupUrl: URL_,
      timeoutMs: TIMEOUT,
      fetchImpl,
      contactStore
    });

    const first = await resolver.resolve(makeRequest());
    const second = await resolver.resolve(makeRequest());

    expect(second).toEqual(first);
    // The cache hit short-circuits before any HTTP call: still exactly one fetch.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('logs the cache hit with the redacted, PII-safe debug shape', async () => {
    const contactStore = new InMemoryContactStore();
    contactStore.set({ channel: 'whatsapp', channelScopedUserId: '15551234567', firstName: 'Ada' });
    const logger = makeLogger();
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const resolver = new HttpIdentityResolver({
      lookupUrl: URL_,
      timeoutMs: TIMEOUT,
      fetchImpl,
      contactStore,
      logger
    });

    await resolver.resolve(makeRequest());
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'whatsapp', user: '****4567', enriched: true, cached: true }),
      expect.any(String)
    );
  });
});

describe('HttpIdentityResolver.resolve — fail-open failure modes', () => {
  it('returns undefined (no throw) on a non-2xx response', async () => {
    const json = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json
    } as unknown as Response) as unknown as typeof fetch;
    const logger = makeLogger();
    const resolver = new HttpIdentityResolver({ lookupUrl: URL_, timeoutMs: TIMEOUT, fetchImpl, logger });

    await expect(resolver.resolve(makeRequest())).resolves.toBeUndefined();
    expect(json).not.toHaveBeenCalled(); // body never read on non-2xx
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('does not cache a non-2xx outcome (a later success still resolves)', async () => {
    const contactStore = new InMemoryContactStore();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503, json: vi.fn() } as unknown as Response)
      .mockResolvedValueOnce(jsonResponse({ firstName: 'Ada' })) as unknown as typeof fetch;
    const resolver = new HttpIdentityResolver({
      lookupUrl: URL_,
      timeoutMs: TIMEOUT,
      fetchImpl,
      contactStore
    });

    expect(await resolver.resolve(makeRequest())).toBeUndefined();
    expect(await resolver.resolve(makeRequest())).toMatchObject({ firstName: 'Ada' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('returns undefined (no throw) when fetch rejects (network error)', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
    const logger = makeLogger();
    const resolver = new HttpIdentityResolver({ lookupUrl: URL_, timeoutMs: TIMEOUT, fetchImpl, logger });

    await expect(resolver.resolve(makeRequest())).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('returns undefined (no throw) on a timeout/abort', async () => {
    // Mirror platform fetch: reject with an AbortError as soon as the
    // AbortController fires. Tiny timeout so the real setTimeout fires fast.
    const fetchImpl = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        })
    ) as unknown as typeof fetch;
    const logger = makeLogger();
    const resolver = new HttpIdentityResolver({ lookupUrl: URL_, timeoutMs: 5, fetchImpl, logger });

    await expect(resolver.resolve(makeRequest())).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'AbortError' }),
      expect.any(String)
    );
  });

  it('returns undefined (no throw) on malformed JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token');
      }
    } as unknown as Response) as unknown as typeof fetch;
    const resolver = new HttpIdentityResolver({ lookupUrl: URL_, timeoutMs: TIMEOUT, fetchImpl });

    await expect(resolver.resolve(makeRequest())).resolves.toBeUndefined();
  });

  it('returns undefined for a 2xx body with no recognized fields', async () => {
    const contactStore = new InMemoryContactStore();
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ unrelated: true, channel: 'whatsapp', channelScopedUserId: '15551234567' })
    ) as unknown as typeof fetch;
    const resolver = new HttpIdentityResolver({
      lookupUrl: URL_,
      timeoutMs: TIMEOUT,
      fetchImpl,
      contactStore
    });

    expect(await resolver.resolve(makeRequest())).toBeUndefined();
    // Nothing to enrich -> nothing cached.
    expect(contactStore.get('whatsapp', '15551234567')).toBeUndefined();
  });

  it('returns undefined for a non-object 2xx body (array / primitive / null)', async () => {
    for (const body of [null, ['a'], 'string', 42] as const) {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(body)) as unknown as typeof fetch;
      const resolver = new HttpIdentityResolver({ lookupUrl: URL_, timeoutMs: TIMEOUT, fetchImpl });
      expect(await resolver.resolve(makeRequest())).toBeUndefined();
    }
  });
});

describe('HttpIdentityResolver — PII-safe logging', () => {
  it('never logs raw name/email; the success debug line is the redacted shape', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com' })
    ) as unknown as typeof fetch;
    const logger = makeLogger();
    const resolver = new HttpIdentityResolver({ lookupUrl: URL_, timeoutMs: TIMEOUT, fetchImpl, logger });

    await resolver.resolve(makeRequest());

    // The debug line carries only the redacted shape.
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'whatsapp',
        user: '****4567',
        enriched: true,
        cached: false
      }),
      expect.any(String)
    );

    // No log call (debug OR warn) anywhere leaks a raw PII field or the full id.
    const allCalls = [...logger.debug.mock.calls, ...logger.warn.mock.calls];
    const serialized = JSON.stringify(allCalls);
    expect(serialized).not.toContain('Ada');
    expect(serialized).not.toContain('Lovelace');
    expect(serialized).not.toContain('ada@example.com');
    expect(serialized).not.toContain('15551234567');
  });
});

describe('NoopIdentityResolver', () => {
  it('always resolves to undefined', async () => {
    const resolver = new NoopIdentityResolver();
    await expect(resolver.resolve(makeRequest())).resolves.toBeUndefined();
    await expect(
      resolver.resolve(makeRequest({ channel: 'instagram', channelScopedUserId: 'igsid-9' }))
    ).resolves.toBeUndefined();
  });
});
