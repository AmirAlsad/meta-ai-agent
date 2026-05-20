/**
 * Unit tests for the webhook registration library API.
 *
 * Strategy: we mock `graphFetch` via `vi.spyOn(globalThis, 'fetch')`. The
 * higher-level helpers in `scripts/lib/graph-api.ts` are unit-tested
 * separately in `scripts-graph-api.test.ts`; here we drive them through
 * `registerAllWebhooks` / `inspectExistingSubscriptions` to verify the
 * orchestration logic (status classification, partial success, idempotency,
 * fail-loud-but-keep-going behavior).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  registerAllWebhooks,
  inspectExistingSubscriptions,
  SUBSCRIBED_FIELDS,
  type RegistrationContext
} from '../../scripts/setup/register-webhooks.js';
import type { Config } from '../../src/config/loader.js';

const META_BASE: Config['meta'] = {
  appId: 'app-111',
  appSecret: 'app-secret',
  verifyToken: 'verify-token-1234567890ab',
  graphApiVersion: 'v25.0'
};

const CALLBACK_URL = 'https://example.ngrok.app/webhook';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    meta: META_BASE,
    whatsapp: { phoneNumberId: 'wa-phone-1', accessToken: 'wa-token', businessAccountId: 'waba-1' },
    messenger: { pageId: 'page-1', pageAccessToken: 'page-token' },
    instagram: { userId: 'ig-1', accessToken: 'ig-token' },
    channels: { whatsapp: true, messenger: true, instagram: true },
    chatEndpointUrl: 'https://chat.example.com',
    ngrokDomain: 'test.ngrok-free.dev',
    agentAutostart: true,
    port: 3000,
    nodeEnv: 'test',
    ...overrides
  };
}

function makeCtx(overrides: Partial<RegistrationContext> = {}): RegistrationContext {
  return {
    config: makeConfig(),
    callbackUrl: CALLBACK_URL,
    ...overrides
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

/**
 * Typed alias for a `vi.spyOn(globalThis, 'fetch')` mock. The library's
 * `MockInstance<(this: unknown, ...args: unknown[]) => unknown>` default
 * isn't assignable from the concrete fetch signature; we cast through `fn`
 * shape so callers get `mockResolvedValueOnce` / `mockImplementation` with
 * correct argument types. Same pattern as `scripts-graph-api.test.ts`.
 */
type FetchMock = ReturnType<
  typeof vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>
> & { mockRestore: () => void; mock: { calls: unknown[][] } };

function spyOnFetch(): FetchMock {
  return vi.spyOn(globalThis, 'fetch') as unknown as FetchMock;
}

/**
 * Capture every fetch call with parsed URL + init for assertion.
 * Auto-restores via vitest's restoreMocks: true config.
 */
function captureFetches(): { calls: FetchCall[]; mock: FetchMock } {
  const calls: FetchCall[] = [];
  const mock = spyOnFetch();
  mock.mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    // Default success — individual tests override via mockResolvedValueOnce
    // chains. Anything reaching the default has no expectation associated.
    return jsonResponse(200, { success: true });
  });
  return { calls, mock };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* SUBSCRIBED_FIELDS                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

describe('SUBSCRIBED_FIELDS', () => {
  // These lists are load-bearing — they're the contract with Meta. Any
  // change here changes the set of webhook events the agent receives.
  // This test catches accidental drift.
  it('WhatsApp fields exactly match the Stage 3 spec', () => {
    expect([...SUBSCRIBED_FIELDS.whatsapp]).toEqual([
      'messages',
      'message_template_status_update',
      'account_review_update',
      'phone_number_quality_update',
      'phone_number_name_update'
    ]);
  });

  it('Messenger fields exactly match the Stage 3 spec', () => {
    expect([...SUBSCRIBED_FIELDS.messenger]).toEqual([
      'messages',
      'messaging_postbacks',
      'message_deliveries',
      'message_reads',
      'messaging_optins',
      'messaging_referrals',
      'message_reactions',
      'message_echoes'
    ]);
  });

  it('Instagram fields exactly match the live-API-accepted set', () => {
    // Two load-bearing IG-specific distinctions, both verified against the
    // live Graph API on 2026-05-20:
    //   1. `messaging_referral` is SINGULAR for Instagram (Messenger uses the
    //      plural `messaging_referrals`).
    //   2. `message_echoes` is NOT a valid IG field — it exists only on the
    //      Messenger `page` object. Including it makes Meta reject the entire
    //      subscribe call with HTTP 400 / code 100. It must NOT appear here.
    expect([...SUBSCRIBED_FIELDS.instagram]).toEqual([
      'messages',
      'messaging_postbacks',
      'messaging_seen',
      'message_reactions',
      'messaging_referral'
    ]);
    expect(SUBSCRIBED_FIELDS.instagram).not.toContain('message_echoes');
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* registerAllWebhooks — full success path                                    */
/* ────────────────────────────────────────────────────────────────────────── */

describe('registerAllWebhooks: full success path', () => {
  let capture: ReturnType<typeof captureFetches>;

  beforeEach(() => {
    capture = captureFetches();
  });

  afterEach(() => {
    capture.mock.mockRestore();
  });

  it('marks all three channels success when every API call returns success', async () => {
    const summary = await registerAllWebhooks(makeCtx());

    expect(summary.allSucceeded).toBe(true);
    expect(summary.results.map((r) => `${r.channel}:${r.status}`)).toEqual([
      'whatsapp:success',
      'messenger:success',
      'instagram:success'
    ]);
  });

  it('uses the callback URL exactly as passed (no auto-append of /webhook)', async () => {
    // Only Messenger hits POST /{appId}/subscriptions (the app-level
    // endpoint is restricted to `page` and a handful of other objects per
    // Meta docs — WhatsApp and Instagram skip this call and surface the
    // Dashboard configuration step via `manual_required` or use their
    // per-WABA / per-user endpoints instead).
    await registerAllWebhooks(makeCtx({ callbackUrl: 'https://custom.example.com/path' }));
    const subscriptionCalls = capture.calls.filter((c) => c.url.includes('/subscriptions'));
    expect(subscriptionCalls.length).toBe(1); // messenger only
    const body = String(subscriptionCalls[0]?.init?.body);
    expect(body).toContain('callback_url=https%3A%2F%2Fcustom.example.com%2Fpath');
    expect(body).toContain('object=page');
  });

  it('does NOT call POST /{appId}/subscriptions for WhatsApp or Instagram', async () => {
    // Regression guard: the app-level /subscriptions endpoint is only
    // documented to accept `user`, `page`, `permissions`, `payments`.
    // Hitting it for `instagram` or `whatsapp_business_account` is a
    // documented-incorrect call that has historically returned misleading
    // errors. We surface those via manual_required or per-WABA/per-user
    // endpoints instead.
    await registerAllWebhooks(makeCtx());
    const subscriptionCalls = capture.calls.filter((c) => c.url.includes('/subscriptions'));
    for (const call of subscriptionCalls) {
      const body = String(call.init?.body ?? '');
      expect(body).not.toContain('object=instagram');
      expect(body).not.toContain('object=whatsapp_business_account');
    }
  });

  it('sends the comma-joined subscribed_fields for Messenger as a query parameter (not JSON body)', async () => {
    await registerAllWebhooks(makeCtx());
    // M2: subscribed_fields lives in the URL query string for the per-page
    // subscribed_apps POST. The request must NOT carry a JSON body.
    const pageCall = capture.calls.find((c) => /\/page-1\/subscribed_apps/.test(c.url));
    expect(pageCall).toBeDefined();
    const parsedUrl = new URL(String(pageCall?.url));
    expect(parsedUrl.searchParams.get('subscribed_fields')).toBe(SUBSCRIBED_FIELDS.messenger.join(','));
    expect(parsedUrl.searchParams.get('access_token')).toBe('page-token');
    expect(pageCall?.init?.body).toBeUndefined();
  });

  it('hits graph.instagram.com for the Instagram subscribed_apps step', async () => {
    await registerAllWebhooks(makeCtx());
    const igCall = capture.calls.find((c) => /\/ig-1\/subscribed_apps/.test(c.url));
    expect(igCall).toBeDefined();
    expect(igCall?.url).toMatch(/^https:\/\/graph\.instagram\.com\//);
  });

  it('calls POST /{wabaId}/subscribed_apps for WhatsApp when WHATSAPP_BUSINESS_ACCOUNT_ID is set', async () => {
    await registerAllWebhooks(makeCtx());
    const wabaCall = capture.calls.find((c) => /\/waba-1\/subscribed_apps/.test(c.url));
    expect(wabaCall).toBeDefined();
    expect(wabaCall?.url).toMatch(/^https:\/\/graph\.facebook\.com\//);
    expect(wabaCall?.init?.method).toBe('POST');
    const parsedUrl = new URL(String(wabaCall?.url));
    expect(parsedUrl.searchParams.get('access_token')).toBe('wa-token');
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* WhatsApp manual_required                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

describe('registerAllWebhooks: WhatsApp manual_required', () => {
  let mock: FetchMock;

  afterEach(() => {
    mock?.mockRestore();
  });

  it('surfaces manual_required when WHATSAPP_BUSINESS_ACCOUNT_ID is unset', async () => {
    // Without the WABA id we can't make the per-WABA subscribed_apps POST,
    // so the channel result is `manual_required` with a hint that points
    // the developer at the env var and the Dashboard path.
    mock = spyOnFetch();
    mock.mockImplementation(async () => jsonResponse(200, { success: true }));

    const config = makeConfig({
      whatsapp: { phoneNumberId: 'wa-phone-1', accessToken: 'wa-token' } // no businessAccountId
    });
    const summary = await registerAllWebhooks(makeCtx({ config }));

    const wa = summary.results.find((r) => r.channel === 'whatsapp');
    expect(wa?.status).toBe('manual_required');
    expect(wa?.remediation).toContain('WhatsApp');
    expect(wa?.remediation).toContain('WHATSAPP_BUSINESS_ACCOUNT_ID');
    expect(wa?.remediation).toContain('Subscribe to fields:');

    // No `/wa-phone-1/subscribed_apps` or `/{waba}/subscribed_apps` call:
    // we surfaced manual_required without hitting Meta.
    const calls = mock.mock.calls.map(([input]) =>
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as { url: string }).url
    );
    expect(calls.some((u) => u.includes('subscribed_apps') && u.includes('waba'))).toBe(false);

    // Messenger + Instagram still attempted — they should be success.
    const msg = summary.results.find((r) => r.channel === 'messenger');
    const ig = summary.results.find((r) => r.channel === 'instagram');
    expect(msg?.status).toBe('success');
    expect(ig?.status).toBe('success');
    expect(summary.allSucceeded).toBe(false);
  });

  it('surfaces manual_required (with helper error in details) when per-WABA subscribed_apps fails', async () => {
    // Permissions error on the per-WABA call → manual_required with the
    // helper's structured MetaApiError attached to details.
    mock = spyOnFetch();
    mock.mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (/\/waba-1\/subscribed_apps/.test(url)) {
        return jsonResponse(403, {
          error: {
            message: '(#200) Application does not have permission for this action',
            code: 200,
            error_subcode: 33
          }
        });
      }
      return jsonResponse(200, { success: true });
    });

    const summary = await registerAllWebhooks(makeCtx());

    const wa = summary.results.find((r) => r.channel === 'whatsapp');
    expect(wa?.status).toBe('manual_required');
    expect(wa?.remediation).toContain('App Dashboard → WhatsApp');
    const details = wa?.details as { helperError: { httpStatus: number } };
    expect(details.helperError.httpStatus).toBe(403);

    expect(summary.allSucceeded).toBe(false);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Partial config                                                             */
/* ────────────────────────────────────────────────────────────────────────── */

describe('registerAllWebhooks: partial config', () => {
  let capture: ReturnType<typeof captureFetches>;

  beforeEach(() => {
    capture = captureFetches();
  });

  afterEach(() => {
    capture.mock.mockRestore();
  });

  it('marks channels with missing creds as skipped, not failed', async () => {
    const config = makeConfig({
      messenger: undefined,
      instagram: undefined,
      channels: { whatsapp: true, messenger: false, instagram: false }
    });
    const summary = await registerAllWebhooks(makeCtx({ config }));

    expect(summary.results.map((r) => `${r.channel}:${r.status}`)).toEqual([
      'whatsapp:success',
      'messenger:skipped',
      'instagram:skipped'
    ]);
    // allSucceeded counts skipped as non-failure — true here.
    expect(summary.allSucceeded).toBe(true);

    // Verify the script didn't hit Messenger / Instagram endpoints at all.
    const msgCalls = capture.calls.filter((c) => /\/page-1\/subscribed_apps/.test(c.url));
    const igCalls = capture.calls.filter((c) => /\/ig-1\/subscribed_apps/.test(c.url));
    expect(msgCalls).toHaveLength(0);
    expect(igCalls).toHaveLength(0);
  });

  it('skipped result message names the env vars that need to be set', async () => {
    const config = makeConfig({
      whatsapp: undefined,
      messenger: undefined,
      instagram: { userId: 'ig-x', accessToken: 'ig-tok' },
      channels: { whatsapp: false, messenger: false, instagram: true }
    });
    const summary = await registerAllWebhooks(makeCtx({ config }));
    const wa = summary.results.find((r) => r.channel === 'whatsapp');
    expect(wa?.message).toMatch(/WHATSAPP_PHONE_NUMBER_ID/);
    expect(wa?.message).toMatch(/WHATSAPP_ACCESS_TOKEN/);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* One channel failing must not abort the others                              */
/* ────────────────────────────────────────────────────────────────────────── */

describe('registerAllWebhooks: a single failure does not abort the others', () => {
  let mock: FetchMock;

  afterEach(() => {
    mock?.mockRestore();
  });

  it('Messenger 500 fails Messenger but WhatsApp and Instagram still succeed', async () => {
    // Sequence of POSTs (per-channel order is wa → msg → ig):
    //   1. WA /waba-1/subscribed_apps           → success
    //   2. Messenger app-level /subscriptions   → success
    //   3. Messenger /page-1/subscribed_apps    → HTTP 500
    //   4. IG /ig-1/subscribed_apps             → success
    mock = spyOnFetch();
    mock.mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (/\/page-1\/subscribed_apps/.test(url)) {
        return jsonResponse(500, {
          error: {
            message: 'Internal server error',
            code: 1,
            fbtrace_id: 'trace-msg-500'
          }
        });
      }
      return jsonResponse(200, { success: true });
    });

    const summary = await registerAllWebhooks(makeCtx());

    expect(summary.results.find((r) => r.channel === 'whatsapp')?.status).toBe('success');
    expect(summary.results.find((r) => r.channel === 'messenger')?.status).toBe('failed');
    expect(summary.results.find((r) => r.channel === 'instagram')?.status).toBe('success');
    expect(summary.allSucceeded).toBe(false);

    // The failed result must surface the structured error fields.
    const msg = summary.results.find((r) => r.channel === 'messenger');
    expect(msg?.message).toContain('HTTP 500');
    const details = msg?.details as { httpStatus: number; fbtraceId: string };
    expect(details.httpStatus).toBe(500);
    expect(details.fbtraceId).toBe('trace-msg-500');
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* inspectExistingSubscriptions                                               */
/* ────────────────────────────────────────────────────────────────────────── */

describe('inspectExistingSubscriptions', () => {
  let mock: FetchMock;

  afterEach(() => {
    mock?.mockRestore();
  });

  it('returns the current subscriptions plus the expected fields per channel', async () => {
    mock = spyOnFetch();
    mock.mockResolvedValueOnce(
      jsonResponse(200, {
        data: [
          {
            object: 'page',
            callback_url: 'https://stale.example.com/webhook',
            active: true,
            fields: [{ name: 'messages' }, { name: 'messaging_postbacks' }]
          },
          {
            object: 'instagram',
            callback_url: 'https://current.ngrok.app/webhook',
            active: true,
            fields: [{ name: 'messages' }]
          }
        ]
      })
    );

    const result = await inspectExistingSubscriptions(makeCtx());

    expect(result.subscriptions).toHaveLength(2);
    // Stale callback URL surfaces in the result for the caller to diff.
    expect(result.subscriptions[0]?.callback_url).toBe('https://stale.example.com/webhook');
    expect(result.subscriptions[1]?.callback_url).toBe('https://current.ngrok.app/webhook');

    // Expected fields are the same lists exposed via SUBSCRIBED_FIELDS, copied
    // (not frozen) so callers can iterate without TypeScript ReadonlyArray pain.
    expect(result.expectedFields.whatsapp).toEqual([...SUBSCRIBED_FIELDS.whatsapp]);
    expect(result.expectedFields.messenger).toEqual([...SUBSCRIBED_FIELDS.messenger]);
    expect(result.expectedFields.instagram).toEqual([...SUBSCRIBED_FIELDS.instagram]);
  });

  it('uses the app access token (appId|appSecret) for /subscriptions GET', async () => {
    mock = spyOnFetch();
    mock.mockResolvedValueOnce(jsonResponse(200, { data: [] }));
    await inspectExistingSubscriptions(makeCtx());
    const url = String(mock.mock.calls[0]?.[0]);
    expect(url).toContain('/v25.0/app-111/subscriptions');
    // app-access token format `${appId}|${appSecret}` → URL-encoded `|` is %7C.
    expect(url).toContain('access_token=app-111%7Capp-secret');
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* App ID guard                                                                */
/* ────────────────────────────────────────────────────────────────────────── */

describe('registerAllWebhooks: missing appId', () => {
  it('throws a clear error when META_APP_ID is unset', async () => {
    const config = makeConfig();
    // Force-clear appId — loadConfig already permits this since appId is
    // typed `string | undefined`.
    const broken: Config = { ...config, meta: { ...config.meta, appId: undefined } };
    await expect(registerAllWebhooks(makeCtx({ config: broken }))).rejects.toThrow(/META_APP_ID/);
  });
});
