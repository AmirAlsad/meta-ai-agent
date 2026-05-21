import { describe, expect, it, vi } from 'vitest';
import { GraphClient } from '../../src/meta/shared/graph-client.js';
import { MetaApiError } from '../../src/meta/shared/errors.js';
import { MessengerProfileClient } from '../../src/meta/messenger/profile.js';
import type { MessengerConfig } from '../../src/config/loader.js';

/* ────────────────────────────────────────────────────────────────────────── */
/* Helpers                                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

const API_VERSION = 'v25.0';
const PAGE_ID = '1112223334';
const PAGE_ACCESS_TOKEN = 'page-access-token-xyz';
const PROFILE_URL = `https://graph.facebook.com/${API_VERSION}/${PAGE_ID}/messenger_profile`;

const config: MessengerConfig = { pageId: PAGE_ID, pageAccessToken: PAGE_ACCESS_TOKEN };

/** A real `Response` so GraphClient's `.text()` / `.headers.get()` work. */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

/** Build a MessengerProfileClient wired to an injected fetch mock + no-op sleep. */
function makeClient(fetchImpl: ReturnType<typeof vi.fn>) {
  const graph = new GraphClient({
    apiVersion: API_VERSION,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    // No-op sleep so any (unexpected) retry incurs zero real delay.
    sleep: () => Promise.resolve()
  });
  return new MessengerProfileClient({ config, graph });
}

/** Parse the JSON body from a recorded fetch call's RequestInit. */
function bodyOf(fetchImpl: ReturnType<typeof vi.fn>, callIndex = 0): Record<string, unknown> {
  const init = fetchImpl.mock.calls[callIndex]![1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

/** Read the HTTP method from a recorded fetch call. */
function methodOf(fetchImpl: ReturnType<typeof vi.fn>, callIndex = 0): string {
  const init = fetchImpl.mock.calls[callIndex]![1] as RequestInit;
  return init.method as string;
}

/** Read a header from a recorded fetch call (headers are a plain object here). */
function headersOf(fetchImpl: ReturnType<typeof vi.fn>, callIndex = 0): Record<string, string> {
  const init = fetchImpl.mock.calls[callIndex]![1] as RequestInit;
  return init.headers as Record<string, string>;
}

/** Read the request URL from a recorded fetch call. */
function urlOf(fetchImpl: ReturnType<typeof vi.fn>, callIndex = 0): string {
  return fetchImpl.mock.calls[callIndex]![0] as string;
}

/** Assert the common contract: versioned profile URL + Bearer header, token never in URL. */
function expectProfileEndpoint(fetchImpl: ReturnType<typeof vi.fn>, callIndex = 0) {
  const url = urlOf(fetchImpl, callIndex);
  expect(url).toBe(PROFILE_URL);
  expect(headersOf(fetchImpl, callIndex)['authorization']).toBe(`Bearer ${PAGE_ACCESS_TOKEN}`);
  expect(url).not.toContain(PAGE_ACCESS_TOKEN);
  expect(url).not.toContain('access_token');
}

/* ────────────────────────────────────────────────────────────────────────── */
/* setGetStartedButton                                                         */
/* ────────────────────────────────────────────────────────────────────────── */

describe('MessengerProfileClient.setGetStartedButton', () => {
  it('POSTs { get_started: { payload } } to {pageId}/messenger_profile', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { result: 'success' }));
    const client = makeClient(fetchImpl);

    await client.setGetStartedButton('GET_STARTED_PAYLOAD');

    expect(fetchImpl).toHaveBeenCalledOnce();
    expectProfileEndpoint(fetchImpl);
    expect(methodOf(fetchImpl)).toBe('POST');
    expect(bodyOf(fetchImpl)).toEqual({ get_started: { payload: 'GET_STARTED_PAYLOAD' } });
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* setGreetingText                                                             */
/* ────────────────────────────────────────────────────────────────────────── */

describe('MessengerProfileClient.setGreetingText', () => {
  it('POSTs { greeting: [{ locale, text }] }', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { result: 'success' }));
    const client = makeClient(fetchImpl);

    await client.setGreetingText([
      { locale: 'default', text: 'Hi {{user_first_name}}, welcome!' },
      { locale: 'en_US', text: 'Hello! How can we help?' }
    ]);

    expect(fetchImpl).toHaveBeenCalledOnce();
    expectProfileEndpoint(fetchImpl);
    expect(methodOf(fetchImpl)).toBe('POST');
    expect(bodyOf(fetchImpl)).toEqual({
      greeting: [
        { locale: 'default', text: 'Hi {{user_first_name}}, welcome!' },
        { locale: 'en_US', text: 'Hello! How can we help?' }
      ]
    });
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* setPersistentMenu — camelCase → snake_case mapping                          */
/* ────────────────────────────────────────────────────────────────────────── */

describe('MessengerProfileClient.setPersistentMenu', () => {
  it('POSTs persistent_menu with camelCase mapped to snake_case for both action types', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { result: 'success' }));
    const client = makeClient(fetchImpl);

    await client.setPersistentMenu([
      {
        locale: 'default',
        composerInputDisabled: true,
        callToActions: [
          { type: 'postback', title: 'Talk to a human', payload: 'TALK_TO_HUMAN' },
          {
            type: 'web_url',
            title: 'Visit our site',
            url: 'https://example.com',
            webviewHeightRatio: 'tall'
          }
        ]
      }
    ]);

    expect(fetchImpl).toHaveBeenCalledOnce();
    expectProfileEndpoint(fetchImpl);
    expect(methodOf(fetchImpl)).toBe('POST');
    // composerInputDisabled → composer_input_disabled, callToActions →
    // call_to_actions, webviewHeightRatio → webview_height_ratio.
    expect(bodyOf(fetchImpl)).toEqual({
      persistent_menu: [
        {
          locale: 'default',
          composer_input_disabled: true,
          call_to_actions: [
            { type: 'postback', title: 'Talk to a human', payload: 'TALK_TO_HUMAN' },
            {
              type: 'web_url',
              title: 'Visit our site',
              url: 'https://example.com',
              webview_height_ratio: 'tall'
            }
          ]
        }
      ]
    });
  });

  it('omits composer_input_disabled and webview_height_ratio when unset', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { result: 'success' }));
    const client = makeClient(fetchImpl);

    await client.setPersistentMenu([
      {
        locale: 'default',
        callToActions: [{ type: 'web_url', title: 'Home', url: 'https://example.com' }]
      }
    ]);

    const body = bodyOf(fetchImpl);
    const menu = (body['persistent_menu'] as Record<string, unknown>[])[0]!;
    expect(menu).not.toHaveProperty('composer_input_disabled');
    const cta = (menu['call_to_actions'] as Record<string, unknown>[])[0]!;
    expect(cta).not.toHaveProperty('webview_height_ratio');
    // postback fields must not leak onto a web_url action.
    expect(cta).not.toHaveProperty('payload');
    expect(body).toEqual({
      persistent_menu: [
        {
          locale: 'default',
          call_to_actions: [{ type: 'web_url', title: 'Home', url: 'https://example.com' }]
        }
      ]
    });
  });

  it('surfaces a clear error when Meta rejects with the get-started-required code (2018145)', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(400, {
        error: {
          message: 'Get started button must be set before setting persistent menu.',
          type: 'OAuthException',
          code: 2018145,
          fbtrace_id: 'OrderingTrace'
        }
      })
    );
    const client = makeClient(fetchImpl);

    let thrown: unknown;
    try {
      await client.setPersistentMenu([
        { locale: 'default', callToActions: [{ type: 'postback', title: 'Go', payload: 'GO' }] }
      ]);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(MetaApiError);
    const apiError = thrown as MetaApiError;
    // Clear, actionable remediation pointing at setGetStartedButton.
    expect(apiError.message).toMatch(/setGetStartedButton/);
    expect(apiError.message).toMatch(/persistent menu/i);
    expect(apiError.operation).toBe('messenger.setPersistentMenu');
    expect(apiError.errorCode).toBe(2018145);
    // The original error is preserved as the cause.
    expect(apiError.cause).toBeInstanceOf(MetaApiError);
    // 400 is a deterministic client error — not retried.
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('reclassifies when 2018145 arrives as error_subcode (not code)', async () => {
    // Meta may surface the empirically-observed get-started-required marker as
    // either errorCode OR errorSubCode — here it comes back as the subcode.
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(400, {
        error: {
          message: 'Get started button must be set before setting persistent menu.',
          type: 'OAuthException',
          code: 100,
          error_subcode: 2018145,
          fbtrace_id: 'OrderingSubcodeTrace'
        }
      })
    );
    const client = makeClient(fetchImpl);

    let thrown: unknown;
    try {
      await client.setPersistentMenu([
        { locale: 'default', callToActions: [{ type: 'postback', title: 'Go', payload: 'GO' }] }
      ]);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(MetaApiError);
    const apiError = thrown as MetaApiError;
    // Same clear, actionable remediation as the errorCode case.
    expect(apiError.message).toMatch(/setGetStartedButton/);
    expect(apiError.message).toMatch(/persistent menu/i);
    expect(apiError.operation).toBe('messenger.setPersistentMenu');
    // The subcode is carried through on the reclassified error.
    expect(apiError.errorSubCode).toBe(2018145);
    // The original error is preserved as the cause.
    expect(apiError.cause).toBeInstanceOf(MetaApiError);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('does NOT reclassify an unrelated error (passes through unchanged)', async () => {
    // A generic 400 that is neither errorCode nor errorSubCode 2018145 must
    // propagate verbatim — no get-started remediation message swapped in.
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(400, {
        error: {
          message: 'Some other validation failure.',
          type: 'OAuthException',
          code: 100,
          error_subcode: 2018022,
          fbtrace_id: 'UnrelatedTrace'
        }
      })
    );
    const client = makeClient(fetchImpl);

    let thrown: unknown;
    try {
      await client.setPersistentMenu([
        { locale: 'default', callToActions: [{ type: 'postback', title: 'Go', payload: 'GO' }] }
      ]);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(MetaApiError);
    const apiError = thrown as MetaApiError;
    // Original error preserved — NOT replaced with the get-started remediation.
    expect(apiError.message).not.toMatch(/setGetStartedButton/);
    expect(apiError.message).toContain('Some other validation failure.');
    expect(apiError.errorCode).toBe(100);
    expect(apiError.errorSubCode).toBe(2018022);
    // It is the original error itself (not a re-wrapped one), so no cause chain.
    expect(apiError.cause).toBeUndefined();
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* setIceBreakers — localized form + ≤4 cap                                    */
/* ────────────────────────────────────────────────────────────────────────── */

describe('MessengerProfileClient.setIceBreakers', () => {
  it('POSTs ice_breakers with the localized call_to_actions form', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { result: 'success' }));
    const client = makeClient(fetchImpl);

    await client.setIceBreakers([
      {
        locale: 'default',
        callToActions: [
          { question: 'What are your hours?', payload: 'HOURS' },
          { question: 'Where are you located?', payload: 'LOCATION' }
        ]
      }
    ]);

    expect(fetchImpl).toHaveBeenCalledOnce();
    expectProfileEndpoint(fetchImpl);
    expect(methodOf(fetchImpl)).toBe('POST');
    // callToActions → call_to_actions; each item stays { question, payload }.
    expect(bodyOf(fetchImpl)).toEqual({
      ice_breakers: [
        {
          locale: 'default',
          call_to_actions: [
            { question: 'What are your hours?', payload: 'HOURS' },
            { question: 'Where are you located?', payload: 'LOCATION' }
          ]
        }
      ]
    });
  });

  it('throws (and never calls fetch) when a locale exceeds 4 ice breakers', async () => {
    const fetchImpl = vi.fn();
    const client = makeClient(fetchImpl);

    const five = Array.from({ length: 5 }, (_, i) => ({ question: `Q${i}`, payload: `P${i}` }));

    await expect(
      client.setIceBreakers([{ locale: 'default', callToActions: five }])
    ).rejects.toThrow(/locale "default".*limit of 4/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('allows exactly 4 ice breakers in a locale', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { result: 'success' }));
    const client = makeClient(fetchImpl);

    const four = Array.from({ length: 4 }, (_, i) => ({ question: `Q${i}`, payload: `P${i}` }));
    await client.setIceBreakers([{ locale: 'default', callToActions: four }]);

    expect(fetchImpl).toHaveBeenCalledOnce();
    const body = bodyOf(fetchImpl);
    const entry = (body['ice_breakers'] as Record<string, unknown>[])[0]!;
    expect((entry['call_to_actions'] as unknown[]).length).toBe(4);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* getMessengerProfile                                                         */
/* ────────────────────────────────────────────────────────────────────────── */

describe('MessengerProfileClient.getMessengerProfile', () => {
  it('GETs with a comma-joined fields query and returns the raw response', async () => {
    const responseBody = {
      data: [{ get_started: { payload: 'GET_STARTED_PAYLOAD' } }]
    };
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, responseBody));
    const client = makeClient(fetchImpl);

    const result = await client.getMessengerProfile(['get_started', 'persistent_menu', 'greeting']);

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(methodOf(fetchImpl)).toBe('GET');
    const url = urlOf(fetchImpl);
    // Base path is the versioned profile endpoint; fields is a comma-joined query.
    expect(url.startsWith(`${PROFILE_URL}?`)).toBe(true);
    expect(url).toContain('fields=get_started%2Cpersistent_menu%2Cgreeting');
    // Token still in the Authorization header, never in the URL.
    expect(headersOf(fetchImpl)['authorization']).toBe(`Bearer ${PAGE_ACCESS_TOKEN}`);
    expect(url).not.toContain(PAGE_ACCESS_TOKEN);
    expect(url).not.toContain('access_token');
    // A GET has no request body.
    expect((fetchImpl.mock.calls[0]![1] as RequestInit).body).toBeUndefined();

    expect(result).toEqual(responseBody);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* deleteMessengerProfileFields                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

describe('MessengerProfileClient.deleteMessengerProfileFields', () => {
  it('DELETEs with { fields: [...] } in the body (not the query string)', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { result: 'success' }));
    const client = makeClient(fetchImpl);

    await client.deleteMessengerProfileFields(['persistent_menu', 'ice_breakers']);

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(methodOf(fetchImpl)).toBe('DELETE');
    const url = urlOf(fetchImpl);
    // Plain profile endpoint — fields go in the BODY, not the query.
    expect(url).toBe(PROFILE_URL);
    expect(url).not.toContain('fields');
    expect(bodyOf(fetchImpl)).toEqual({ fields: ['persistent_menu', 'ice_breakers'] });
    expect(headersOf(fetchImpl)['authorization']).toBe(`Bearer ${PAGE_ACCESS_TOKEN}`);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Error path                                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

describe('MessengerProfileClient error handling', () => {
  it('wraps a generic 400 Meta error in MetaApiError with the parsed errorCode', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(400, {
        error: {
          message: 'Invalid OAuth access token.',
          type: 'OAuthException',
          code: 190,
          error_subcode: 463,
          fbtrace_id: 'AbCdEfTrace'
        }
      })
    );
    const client = makeClient(fetchImpl);

    let thrown: unknown;
    try {
      await client.setGetStartedButton('GET_STARTED_PAYLOAD');
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(MetaApiError);
    const apiError = thrown as MetaApiError;
    expect(apiError.operation).toBe('messenger.setGetStarted');
    expect(apiError.httpStatus).toBe(400);
    expect(apiError.errorCode).toBe(190);
    expect(apiError.errorSubCode).toBe(463);
    expect(apiError.fbtraceId).toBe('AbCdEfTrace');
    // 400 is a deterministic client error — not retried (single fetch call).
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
