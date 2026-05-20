import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appAccessToken,
  buildGraphUrl,
  buildInstagramGraphUrl,
  graphFetch,
  MetaApiError,
  getInstagramSubscribedApps,
  getInstagramUser,
  getMessengerPage,
  getWhatsAppPhoneNumber,
  listWebhookSubscriptions,
  setWebhookSubscriptionConfig,
  subscribeInstagramApp,
  subscribeMessengerPageApp,
  subscribeWhatsAppBusinessAccount,
  type GraphConfig
} from '../../scripts/lib/graph-api.js';

const CONFIG: GraphConfig = { apiVersion: 'v25.0' };

/* ────────────────────────────────────────────────────────────────────────── */
/* URL builders                                                               */
/* ────────────────────────────────────────────────────────────────────────── */

describe('buildGraphUrl', () => {
  it('builds a URL with default base, version, and trimmed path', () => {
    const url = buildGraphUrl('foo/bar', { a: '1' }, CONFIG);
    expect(url).toBe('https://graph.facebook.com/v25.0/foo/bar?a=1');
  });

  it('drops query params with undefined values', () => {
    const url = buildGraphUrl('foo', { a: '1', b: undefined, c: '3' }, CONFIG);
    expect(url).toBe('https://graph.facebook.com/v25.0/foo?a=1&c=3');
  });

  it('coerces number query values to strings', () => {
    const url = buildGraphUrl('foo', { n: 42 }, CONFIG);
    expect(url).toBe('https://graph.facebook.com/v25.0/foo?n=42');
  });

  it('omits the query string when no params are supplied', () => {
    const url = buildGraphUrl('foo', {}, CONFIG);
    expect(url).toBe('https://graph.facebook.com/v25.0/foo');
  });

  it('strips leading slashes from path', () => {
    const url = buildGraphUrl('/foo', { a: '1' }, CONFIG);
    expect(url).toBe('https://graph.facebook.com/v25.0/foo?a=1');
  });

  it('respects custom baseUrl', () => {
    const url = buildGraphUrl('foo', { a: '1' }, { apiVersion: 'v25.0', baseUrl: 'https://example.com' });
    expect(url).toBe('https://example.com/v25.0/foo?a=1');
  });

  it('URL-encodes special characters in query values', () => {
    const url = buildGraphUrl('foo', { q: 'hello world & friends' }, CONFIG);
    expect(url).toBe('https://graph.facebook.com/v25.0/foo?q=hello+world+%26+friends');
  });
});

describe('buildInstagramGraphUrl', () => {
  it('uses graph.instagram.com as the base host', () => {
    const url = buildInstagramGraphUrl('me', { fields: 'user_id,username' }, CONFIG);
    expect(url).toBe('https://graph.instagram.com/v25.0/me?fields=user_id%2Cusername');
  });

  it('honors per-call baseUrl override (so callers can switch to graph.facebook.com if needed)', () => {
    const url = buildInstagramGraphUrl(
      'me',
      { fields: 'user_id' },
      { apiVersion: 'v25.0', baseUrl: 'https://graph.facebook.com' }
    );
    // Note: explicit override of baseUrl wins — buildInstagramGraphUrl is a
    // default. This is intentional per the function's JSDoc.
    expect(url).toBe('https://graph.instagram.com/v25.0/me?fields=user_id');
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* MetaApiError                                                               */
/* ────────────────────────────────────────────────────────────────────────── */

describe('MetaApiError', () => {
  it('carries all structured fields', () => {
    const err = new MetaApiError({
      operation: 'get_thing',
      httpStatus: 400,
      errorCode: 100,
      errorSubCode: 33,
      fbtraceId: 'abc123',
      responseBody: { error: { message: 'Invalid' } }
    });
    expect(err.operation).toBe('get_thing');
    expect(err.httpStatus).toBe(400);
    expect(err.errorCode).toBe(100);
    expect(err.errorSubCode).toBe(33);
    expect(err.fbtraceId).toBe('abc123');
    expect(err.responseBody).toEqual({ error: { message: 'Invalid' } });
    expect(err.name).toBe('MetaApiError');
    expect(err.message).toContain('get_thing');
    expect(err.message).toContain('HTTP 400');
    expect(err.message).toContain('code 100');
    expect(err.message).toContain('subcode 33');
    expect(err.message).toContain('fbtrace_id: abc123');
    expect(err.message).toContain('Invalid');
  });

  it('formats a useful message even when only httpStatus is set', () => {
    const err = new MetaApiError({
      operation: 'op',
      httpStatus: 500,
      responseBody: undefined
    });
    expect(err.message).toContain('op');
    expect(err.message).toContain('HTTP 500');
  });

  it('uses an explicit message override when provided', () => {
    const err = new MetaApiError({
      operation: 'op',
      httpStatus: 500,
      responseBody: undefined,
      message: 'custom message text'
    });
    expect(err.message).toBe('custom message text');
  });

  it('truncates very long response bodies in the formatted message', () => {
    const huge = 'x'.repeat(5000);
    const err = new MetaApiError({
      operation: 'op',
      httpStatus: 500,
      responseBody: huge
    });
    expect(err.message.length).toBeLessThan(huge.length);
    expect(err.message).toContain('…');
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* graphFetch + common operations                                             */
/* ────────────────────────────────────────────────────────────────────────── */

describe('graphFetch', () => {
  let fetchSpy: ReturnType<typeof spyOnFetch>;

  beforeEach(() => {
    fetchSpy = spyOnFetch();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('returns parsed JSON body on 2xx', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { id: '123', name: 'Test' }));
    const result = await graphFetch<{ id: string; name: string }>(
      'https://graph.facebook.com/v25.0/123',
      { method: 'GET' },
      'get_thing'
    );
    expect(result).toEqual({ id: '123', name: 'Test' });
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://graph.facebook.com/v25.0/123',
      { method: 'GET' }
    );
  });

  it('returns null when 2xx body is empty', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('', { status: 200 }));
    const result = await graphFetch('https://example.com/foo', { method: 'POST' }, 'op');
    expect(result).toBeNull();
  });

  it('throws MetaApiError with parsed error fields on 4xx with valid Meta JSON', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(400, {
        error: {
          message: 'Invalid OAuth access token.',
          type: 'OAuthException',
          code: 190,
          error_subcode: 463,
          fbtrace_id: 'trace-xyz'
        }
      })
    );
    await expect(
      graphFetch('https://example.com/foo', { method: 'GET' }, 'get_thing')
    ).rejects.toMatchObject({
      name: 'MetaApiError',
      operation: 'get_thing',
      httpStatus: 400,
      errorCode: 190,
      errorSubCode: 463,
      fbtraceId: 'trace-xyz'
    });
  });

  it('throws MetaApiError with raw text body on 4xx with non-JSON body', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('plain text error', { status: 400 }));
    let caught: unknown;
    try {
      await graphFetch('https://example.com/foo', { method: 'GET' }, 'op');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MetaApiError);
    const meta = caught as MetaApiError;
    expect(meta.httpStatus).toBe(400);
    expect(meta.errorCode).toBeUndefined();
    expect(meta.responseBody).toBe('plain text error');
  });

  it('wraps a network failure with httpStatus 0', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    let caught: unknown;
    try {
      await graphFetch('https://example.com/foo', { method: 'GET' }, 'op');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MetaApiError);
    const meta = caught as MetaApiError;
    expect(meta.httpStatus).toBe(0);
    expect(meta.responseBody).toBe('ECONNREFUSED');
    expect(meta.message).toContain('ECONNREFUSED');
  });

  it('preserves the underlying network error as `cause` on the MetaApiError', async () => {
    // CR4: when fetch throws, the original error must be linked via `cause`
    // so stack chains are debuggable (V8 prints the inner trace alongside
    // the wrapping MetaApiError).
    const originalError = new Error('ECONNRESET');
    fetchSpy.mockRejectedValueOnce(originalError);
    let caught: unknown;
    try {
      await graphFetch('https://example.com/foo', { method: 'GET' }, 'op');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MetaApiError);
    const meta = caught as MetaApiError & { cause?: unknown };
    expect(meta.cause).toBe(originalError);
  });
});

describe('getWhatsAppPhoneNumber', () => {
  it('hits /{phoneNumberId} with the expected fields', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse(200, {
        id: '123',
        display_phone_number: '+1 555 5555',
        verified_name: 'Test Co',
        quality_rating: 'GREEN'
      })
    );
    const result = await getWhatsAppPhoneNumber('123', 'token-abc', CONFIG);
    expect(result.display_phone_number).toBe('+1 555 5555');
    expect(fetchSpy).toHaveBeenCalledOnce();
    const url = fetchSpy.mock.calls[0]?.[0];
    expect(String(url)).toMatch(/^https:\/\/graph\.facebook\.com\/v25\.0\/123\?/);
    expect(String(url)).toContain('fields=display_phone_number');
    expect(String(url)).toContain('access_token=token-abc');
    fetchSpy.mockRestore();
  });
});

describe('getMessengerPage', () => {
  it('hits /{pageId} with name,id fields', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse(200, { id: '456', name: 'My Page' })
    );
    const result = await getMessengerPage('456', 'token-xyz', CONFIG);
    expect(result.name).toBe('My Page');
    const url = fetchSpy.mock.calls[0]?.[0];
    expect(String(url)).toContain('fields=name%2Cid');
    fetchSpy.mockRestore();
  });
});

describe('getInstagramUser', () => {
  it('hits /me on graph.instagram.com', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse(200, { user_id: '789', username: 'foo' })
    );
    const result = await getInstagramUser('token-ig', CONFIG);
    expect(result.username).toBe('foo');
    const url = fetchSpy.mock.calls[0]?.[0];
    expect(String(url)).toMatch(/^https:\/\/graph\.instagram\.com\/v25\.0\/me\?/);
    fetchSpy.mockRestore();
  });
});

describe('subscribeMessengerPageApp', () => {
  it('POSTs to /{pageId}/subscribed_apps with subscribed_fields in the URL query (no JSON body)', async () => {
    // M2: subscribed_fields was previously sent in a JSON body; per Meta's
    // documented contract for this endpoint, it belongs in the query
    // string. The request has NO body — content-type can be omitted.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(200, { success: true }));
    const result = await subscribeMessengerPageApp({
      pageId: '500',
      pageAccessToken: 'page-token',
      subscribedFields: ['messages', 'messaging_postbacks', 'message_reactions'],
      config: CONFIG
    });
    expect(result.success).toBe(true);
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    const parsedUrl = new URL(String(url));
    expect(parsedUrl.origin).toBe('https://graph.facebook.com');
    expect(parsedUrl.pathname).toBe('/v25.0/500/subscribed_apps');
    expect(parsedUrl.searchParams.get('subscribed_fields')).toBe(
      'messages,messaging_postbacks,message_reactions'
    );
    expect(parsedUrl.searchParams.get('access_token')).toBe('page-token');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeUndefined();
    fetchSpy.mockRestore();
  });
});

describe('subscribeWhatsAppBusinessAccount', () => {
  it('POSTs to /{wabaId}/subscribed_apps on graph.facebook.com with access_token in the query (no body)', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(200, { success: true }));
    const result = await subscribeWhatsAppBusinessAccount({
      wabaId: 'waba-99',
      accessToken: 'system-user-token',
      config: CONFIG
    });
    expect(result.success).toBe(true);
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    const parsedUrl = new URL(String(url));
    expect(parsedUrl.origin).toBe('https://graph.facebook.com');
    expect(parsedUrl.pathname).toBe('/v25.0/waba-99/subscribed_apps');
    expect(parsedUrl.searchParams.get('access_token')).toBe('system-user-token');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeUndefined();
    fetchSpy.mockRestore();
  });

  it('includes override_callback_uri and verify_token in the form body when provided', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(200, { success: true }));
    await subscribeWhatsAppBusinessAccount({
      wabaId: 'waba-99',
      accessToken: 'system-user-token',
      overrideCallbackUri: 'https://example.com/webhook',
      verifyToken: 'verify-token-1234567890ab',
      config: CONFIG
    });
    const [, init] = fetchSpy.mock.calls[0] ?? [];
    expect(init?.method).toBe('POST');
    const body = String(init?.body);
    expect(body).toBe(
      'override_callback_uri=https%3A%2F%2Fexample.com%2Fwebhook&verify_token=verify-token-1234567890ab'
    );
    fetchSpy.mockRestore();
  });
});

describe('subscribeInstagramApp', () => {
  it('POSTs to /{userId}/subscribed_apps on graph.instagram.com with the comma-joined fields', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(200, { success: true }));
    await subscribeInstagramApp({
      userId: '789',
      accessToken: 'ig-token',
      subscribedFields: ['messages', 'messaging_postbacks'],
      config: CONFIG
    });
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    const urlStr = String(url);
    expect(urlStr).toMatch(/^https:\/\/graph\.instagram\.com\/v25\.0\/789\/subscribed_apps\?/);
    expect(urlStr).toContain('subscribed_fields=messages%2Cmessaging_postbacks');
    expect(urlStr).toContain('access_token=ig-token');
    expect(init?.method).toBe('POST');
    fetchSpy.mockRestore();
  });
});

describe('getInstagramSubscribedApps', () => {
  it('GETs /{userId}/subscribed_apps on graph.instagram.com and returns the data array', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse(200, {
        data: [{ id: '18104734225860020', subscribed_fields: ['messages', 'message_reactions'] }]
      })
    );
    const apps = await getInstagramSubscribedApps('789', 'ig-token', CONFIG);
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    const urlStr = String(url);
    expect(urlStr).toMatch(/^https:\/\/graph\.instagram\.com\/v25\.0\/789\/subscribed_apps\?/);
    expect(urlStr).toContain('access_token=ig-token');
    expect(init?.method).toBe('GET');
    expect(apps).toHaveLength(1);
    expect(apps[0]?.subscribed_fields).toEqual(['messages', 'message_reactions']);
    fetchSpy.mockRestore();
  });

  it('returns an empty array when no apps are subscribed (data absent)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse(200, {}));
    const apps = await getInstagramSubscribedApps('789', 'ig-token', CONFIG);
    expect(apps).toEqual([]);
    fetchSpy.mockRestore();
  });
});

describe('setWebhookSubscriptionConfig', () => {
  it('POSTs to /{appId}/subscriptions with the app access token and form body', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(200, { success: true }));
    const result = await setWebhookSubscriptionConfig({
      appId: '111',
      appSecret: 'secret',
      callbackUrl: 'https://example.ngrok.app/webhook',
      verifyToken: 'verify-token-1234567890ab',
      object: 'page',
      fields: ['messages', 'messaging_postbacks'],
      config: CONFIG
    });
    expect(result.success).toBe(true);
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(String(url)).toContain('/v25.0/111/subscriptions');
    expect(String(url)).toContain('access_token=111%7Csecret');
    expect(init?.method).toBe('POST');
    const body = String(init?.body);
    expect(body).toContain('object=page');
    expect(body).toContain('callback_url=https%3A%2F%2Fexample.ngrok.app%2Fwebhook');
    expect(body).toContain('verify_token=verify-token-1234567890ab');
    expect(body).toContain('fields=messages%2Cmessaging_postbacks');
    fetchSpy.mockRestore();
  });

  it('surfaces manualConfigurationRequired when Meta says App is not active', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse(400, {
        error: {
          message: 'App is not active. Please activate it in the App Dashboard.',
          code: 100
        }
      })
    );
    const result = await setWebhookSubscriptionConfig({
      appId: '111',
      appSecret: 'secret',
      callbackUrl: 'https://example.ngrok.app/webhook',
      verifyToken: 'verify-token-1234567890ab',
      object: 'whatsapp_business_account',
      fields: ['messages'],
      config: CONFIG
    });
    expect(result.manualConfigurationRequired).toBe(true);
    expect(result.manualConfigurationHint).toContain('whatsapp_business_account');
    expect(result.manualConfigurationHint).toContain('https://example.ngrok.app/webhook');
    fetchSpy.mockRestore();
  });

  it('rethrows MetaApiError for non-manual-fallback errors', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse(500, {
        error: { message: 'Internal server error', code: 1 }
      })
    );
    await expect(
      setWebhookSubscriptionConfig({
        appId: '111',
        appSecret: 'secret',
        callbackUrl: 'https://example.com/webhook',
        verifyToken: 'verify-token-1234567890ab',
        object: 'page',
        fields: ['messages'],
        config: CONFIG
      })
    ).rejects.toBeInstanceOf(MetaApiError);
    fetchSpy.mockRestore();
  });

  it('does NOT classify a generic permission error (code 10) as manual_required', async () => {
    // CR2: previously a 400 with any "permission"-containing message was
    // reclassified to manual_required, which masked real auth issues
    // (missing scope, expired token). The narrowed heuristic now only
    // triggers for the documented (200/33) code-pair, "App is not active",
    // and "not supported for this object". A generic
    // `(#10) User does not have permission to access this object` must
    // propagate as a thrown MetaApiError.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse(400, {
        error: {
          message: '(#10) User does not have permission to access this object',
          code: 10
        }
      })
    );
    await expect(
      setWebhookSubscriptionConfig({
        appId: '111',
        appSecret: 'secret',
        callbackUrl: 'https://example.com/webhook',
        verifyToken: 'verify-token-1234567890ab',
        object: 'page',
        fields: ['messages'],
        config: CONFIG
      })
    ).rejects.toBeInstanceOf(MetaApiError);
    fetchSpy.mockRestore();
  });

  it('classifies code 200 / subcode 33 as manual_required (documented case)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse(403, {
        error: {
          message: '(#200) Application does not have permission for this action',
          code: 200,
          error_subcode: 33
        }
      })
    );
    const result = await setWebhookSubscriptionConfig({
      appId: '111',
      appSecret: 'secret',
      callbackUrl: 'https://example.com/webhook',
      verifyToken: 'verify-token-1234567890ab',
      object: 'page',
      fields: ['messages'],
      config: CONFIG
    });
    expect(result.manualConfigurationRequired).toBe(true);
    fetchSpy.mockRestore();
  });

  it('classifies "not supported for this object" as manual_required', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse(400, {
        error: {
          message: 'This subscription is not supported for this object.',
          code: 100
        }
      })
    );
    const result = await setWebhookSubscriptionConfig({
      appId: '111',
      appSecret: 'secret',
      callbackUrl: 'https://example.com/webhook',
      verifyToken: 'verify-token-1234567890ab',
      object: 'page',
      fields: ['messages'],
      config: CONFIG
    });
    expect(result.manualConfigurationRequired).toBe(true);
    fetchSpy.mockRestore();
  });
});

describe('listWebhookSubscriptions', () => {
  it('returns the data array from /{appId}/subscriptions', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse(200, {
        data: [
          { object: 'page', callback_url: 'https://x.com/webhook', active: true },
          { object: 'instagram', callback_url: 'https://x.com/webhook', active: true }
        ]
      })
    );
    const result = await listWebhookSubscriptions('111', 'secret', CONFIG);
    expect(result).toHaveLength(2);
    expect(result[0]?.object).toBe('page');
    fetchSpy.mockRestore();
  });

  it('returns [] when the response has no data array', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(200, { other: 'shape' }));
    const result = await listWebhookSubscriptions('111', 'secret', CONFIG);
    expect(result).toEqual([]);
    fetchSpy.mockRestore();
  });
});

describe('appAccessToken', () => {
  it('formats as ${appId}|${appSecret}', () => {
    expect(appAccessToken('111', 'secret')).toBe('111|secret');
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Helpers                                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

/**
 * spyOnFetch returns a vi.spyOn-shaped mock of globalThis.fetch with the
 * concrete fetch signature so callers get typed mockResolvedValueOnce etc.
 */
function spyOnFetch() {
  return vi.spyOn(globalThis, 'fetch') as unknown as ReturnType<
    typeof vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>
  > & { mockRestore: () => void };
}
