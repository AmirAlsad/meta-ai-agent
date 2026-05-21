import { describe, expect, it, vi } from 'vitest';
import { GraphClient } from '../../src/meta/shared/graph-client.js';
import { MetaApiError } from '../../src/meta/shared/errors.js';
import {
  InstagramIceBreakers,
  type LocalizedIceBreakers
} from '../../src/meta/instagram/ice-breakers.js';
import type { InstagramConfig } from '../../src/config/loader.js';

/* ────────────────────────────────────────────────────────────────────────── */
/* Helpers                                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

const API_VERSION = 'v25.0';
const USER_ID = '17841400000000000';
const ACCESS_TOKEN = 'IGAA-super-secret-token';
const PROFILE_URL = `https://graph.instagram.com/${API_VERSION}/${USER_ID}/messenger_profile`;

const CONFIG: InstagramConfig = {
  userId: USER_ID,
  accessToken: ACCESS_TOKEN
};

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  });
}

/** A recording sleep that resolves immediately — NO real delay in tests. */
function recordingSleep(): (ms: number) => Promise<void> {
  return () => Promise.resolve();
}

/** Build an InstagramIceBreakers over a GraphClient with an injected fetch mock. */
function makeManager(fetchImpl: ReturnType<typeof vi.fn>) {
  const graph = new GraphClient({
    apiVersion: API_VERSION,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleep: recordingSleep() // GraphClient retry sleep — unused in these tests.
  });
  return new InstagramIceBreakers({ config: CONFIG, graph });
}

/** Pull the [url, init] of the Nth fetch call and parse its JSON body. */
function callAt(
  fetchImpl: ReturnType<typeof vi.fn>,
  index: number
): { url: string; init: RequestInit; body: unknown } {
  const [url, init] = fetchImpl.mock.calls[index] ?? [];
  const reqInit = init as RequestInit;
  const body = typeof reqInit?.body === 'string' ? JSON.parse(reqInit.body) : undefined;
  return { url: String(url), init: reqInit, body };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* setIceBreakers                                                               */
/* ────────────────────────────────────────────────────────────────────────── */

describe('InstagramIceBreakers.setIceBreakers', () => {
  it('POSTs the localized ice_breakers schema to graph.instagram.com /{userId}/messenger_profile', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { result: 'success' }));
    const manager = makeManager(fetchImpl);

    const iceBreakers: LocalizedIceBreakers[] = [
      {
        locale: 'default',
        callToActions: [
          { question: 'What are your hours?', payload: 'HOURS' },
          { question: 'Where are you located?', payload: 'LOCATION' }
        ]
      },
      {
        locale: 'es_ES',
        callToActions: [{ question: '¿Cuál es tu horario?', payload: 'HOURS' }]
      }
    ];

    await manager.setIceBreakers(iceBreakers);

    expect(fetchImpl).toHaveBeenCalledOnce();
    const { url, init, body } = callAt(fetchImpl, 0);

    // Exact host + URL (graph.instagram.com /{userId}/messenger_profile).
    expect(url).toBe(PROFILE_URL);
    expect(init.method).toBe('POST');

    // Exact request body: platform discriminator (required on the IG-Login
    // surface) + localized form with snake_case call_to_actions.
    expect(body).toEqual({
      platform: 'instagram',
      ice_breakers: [
        {
          locale: 'default',
          call_to_actions: [
            { question: 'What are your hours?', payload: 'HOURS' },
            { question: 'Where are you located?', payload: 'LOCATION' }
          ]
        },
        {
          locale: 'es_ES',
          call_to_actions: [{ question: '¿Cuál es tu horario?', payload: 'HOURS' }]
        }
      ]
    });

    // Token is a Bearer header, NEVER in the URL.
    const headers = init.headers as Record<string, string>;
    expect(headers['authorization']).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(url).not.toContain(ACCESS_TOKEN);
    expect(url).not.toContain('access_token');
  });

  it('rejects a locale with more than 4 ice breakers BEFORE making any request', async () => {
    const fetchImpl = vi.fn();
    const manager = makeManager(fetchImpl);

    const tooMany: LocalizedIceBreakers[] = [
      {
        locale: 'default',
        callToActions: [
          { question: 'q1', payload: 'P1' },
          { question: 'q2', payload: 'P2' },
          { question: 'q3', payload: 'P3' },
          { question: 'q4', payload: 'P4' },
          { question: 'q5', payload: 'P5' }
        ]
      }
    ];

    await expect(manager.setIceBreakers(tooMany)).rejects.toThrow(/maximum is 4 per locale/i);
    // Validation must fail fast — no Graph call is made.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('surfaces a 400 Meta error as MetaApiError', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(400, {
        error: {
          message: 'Invalid ice breaker',
          type: 'OAuthException',
          code: 100,
          error_subcode: 2018001,
          fbtrace_id: 'trace-ig-ib-400'
        }
      })
    );
    const manager = makeManager(fetchImpl);

    let caught: unknown;
    try {
      await manager.setIceBreakers([
        { locale: 'default', callToActions: [{ question: 'q', payload: 'P' }] }
      ]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MetaApiError);
    const meta = caught as MetaApiError;
    expect(meta.operation).toBe('instagram.setIceBreakers');
    expect(meta.httpStatus).toBe(400);
    expect(meta.errorCode).toBe(100);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* getIceBreakers                                                               */
/* ────────────────────────────────────────────────────────────────────────── */

describe('InstagramIceBreakers.getIceBreakers', () => {
  it('GETs /{userId}/messenger_profile?fields=ice_breakers and returns the raw envelope', async () => {
    const envelope = {
      data: [
        {
          ice_breakers: [
            { locale: 'default', call_to_actions: [{ question: 'q', payload: 'P' }] }
          ]
        }
      ]
    };
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, envelope));
    const manager = makeManager(fetchImpl);

    const result = await manager.getIceBreakers();

    expect(fetchImpl).toHaveBeenCalledOnce();
    const { url, init, body } = callAt(fetchImpl, 0);

    // Method + host + path + the platform discriminator and fields query params.
    // platform=instagram is REQUIRED on the IG-Login messenger_profile surface.
    expect(init.method).toBe('GET');
    expect(url).toBe(`${PROFILE_URL}?platform=instagram&fields=ice_breakers`);
    expect(url).toContain('platform=instagram');
    // A GET carries no JSON body.
    expect(body).toBeUndefined();

    // Token is a Bearer header, NEVER in the URL.
    const headers = init.headers as Record<string, string>;
    expect(headers['authorization']).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(url).not.toContain(ACCESS_TOKEN);
    expect(url).not.toContain('access_token');

    // The raw Graph envelope is returned unmodified.
    expect(result).toEqual(envelope);
  });

  it('surfaces a 400 Meta error as MetaApiError', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(400, {
        error: { message: 'bad', type: 'OAuthException', code: 100, fbtrace_id: 'trace-get' }
      })
    );
    const manager = makeManager(fetchImpl);

    let caught: unknown;
    try {
      await manager.getIceBreakers();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MetaApiError);
    expect((caught as MetaApiError).operation).toBe('instagram.getIceBreakers');
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* deleteIceBreakers                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

describe('InstagramIceBreakers.deleteIceBreakers', () => {
  it('DELETEs /{userId}/messenger_profile with body { platform: "instagram", fields: ["ice_breakers"] }', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { result: 'success' }));
    const manager = makeManager(fetchImpl);

    await manager.deleteIceBreakers();

    expect(fetchImpl).toHaveBeenCalledOnce();
    const { url, init, body } = callAt(fetchImpl, 0);

    // Exact host + URL + method.
    expect(url).toBe(PROFILE_URL);
    expect(init.method).toBe('DELETE');

    // The targeted field is named in the BODY (not a query param), alongside the
    // platform discriminator required on the IG-Login surface.
    expect(body).toEqual({ platform: 'instagram', fields: ['ice_breakers'] });
    expect(url).not.toContain('fields');

    // Token is a Bearer header, NEVER in the URL.
    const headers = init.headers as Record<string, string>;
    expect(headers['authorization']).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(url).not.toContain(ACCESS_TOKEN);
    expect(url).not.toContain('access_token');
  });

  it('surfaces a 400 Meta error as MetaApiError', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(400, {
        error: { message: 'bad', type: 'OAuthException', code: 100, fbtrace_id: 'trace-del' }
      })
    );
    const manager = makeManager(fetchImpl);

    let caught: unknown;
    try {
      await manager.deleteIceBreakers();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MetaApiError);
    expect((caught as MetaApiError).operation).toBe('instagram.deleteIceBreakers');
  });
});
