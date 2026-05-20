import { describe, expect, it } from 'vitest';
import {
  buildMeAccountsUrl,
  buildMessengerAuthorizeUrl,
  buildMessengerCodeExchangeUrl,
  buildMessengerFbExchangeUrl,
  hasExistingMessengerPageToken,
  parseFlags,
  selectPage,
  type PageEntry
} from '../../scripts/setup/oauth-messenger.js';

/* ────────────────────────────────────────────────────────────────────────── */
/* URL builders                                                               */
/* ────────────────────────────────────────────────────────────────────────── */

describe('buildMessengerAuthorizeUrl', () => {
  it('targets https://www.facebook.com/{version}/dialog/oauth with config_id (not scope)', () => {
    const url = buildMessengerAuthorizeUrl({
      apiVersion: 'v25.0',
      clientId: '1234567890',
      configId: 'CFG-9999',
      redirectUri: 'https://example.ngrok-free.dev/auth/messenger/callback',
      state: 'abcd1234'
    });
    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://www.facebook.com');
    expect(parsed.pathname).toBe('/v25.0/dialog/oauth');
    expect(parsed.searchParams.get('client_id')).toBe('1234567890');
    expect(parsed.searchParams.get('config_id')).toBe('CFG-9999');
    expect(parsed.searchParams.get('redirect_uri')).toBe(
      'https://example.ngrok-free.dev/auth/messenger/callback'
    );
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('state')).toBe('abcd1234');
    // config_id replaces scope= in FB Login for Business; we must NOT send a scope param.
    expect(parsed.searchParams.get('scope')).toBeNull();
  });

  it('respects a different apiVersion in the path segment', () => {
    const url = buildMessengerAuthorizeUrl({
      apiVersion: 'v26.0',
      clientId: 'x',
      configId: 'y',
      redirectUri: 'https://example.com/cb',
      state: 's'
    });
    expect(new URL(url).pathname).toBe('/v26.0/dialog/oauth');
  });
});

describe('buildMessengerCodeExchangeUrl', () => {
  it('hits graph.facebook.com/{version}/oauth/access_token via GET-style query params', () => {
    const url = buildMessengerCodeExchangeUrl({
      apiVersion: 'v25.0',
      clientId: 'APPID',
      clientSecret: 'SECRET',
      redirectUri: 'https://example.com/auth/messenger/callback',
      code: 'CODE123'
    });
    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://graph.facebook.com');
    expect(parsed.pathname).toBe('/v25.0/oauth/access_token');
    expect(parsed.searchParams.get('client_id')).toBe('APPID');
    expect(parsed.searchParams.get('client_secret')).toBe('SECRET');
    expect(parsed.searchParams.get('redirect_uri')).toBe(
      'https://example.com/auth/messenger/callback'
    );
    expect(parsed.searchParams.get('code')).toBe('CODE123');
    // Code exchange does NOT use the fb_exchange_token grant — that's a
    // separate endpoint shape. Asserting absence guards against accidentally
    // merging the two URL builders.
    expect(parsed.searchParams.get('grant_type')).toBeNull();
  });

  it('properly URL-encodes redirect_uri', () => {
    const url = buildMessengerCodeExchangeUrl({
      apiVersion: 'v25.0',
      clientId: 'a',
      clientSecret: 'b',
      redirectUri: 'https://foo.bar/auth/messenger/callback?x=1&y=2',
      code: 'c'
    });
    // The URLSearchParams encoding is what Meta expects byte-for-byte.
    expect(url).toContain('redirect_uri=https%3A%2F%2Ffoo.bar%2Fauth%2Fmessenger%2Fcallback%3Fx%3D1%26y%3D2');
  });
});

describe('buildMessengerFbExchangeUrl', () => {
  it('uses the fb_exchange_token grant to swap short → long User Token', () => {
    const url = buildMessengerFbExchangeUrl({
      apiVersion: 'v25.0',
      clientId: 'APPID',
      clientSecret: 'SECRET',
      shortLivedToken: 'SHORT'
    });
    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://graph.facebook.com');
    expect(parsed.pathname).toBe('/v25.0/oauth/access_token');
    expect(parsed.searchParams.get('grant_type')).toBe('fb_exchange_token');
    expect(parsed.searchParams.get('client_id')).toBe('APPID');
    expect(parsed.searchParams.get('client_secret')).toBe('SECRET');
    expect(parsed.searchParams.get('fb_exchange_token')).toBe('SHORT');
    // Sanity-check: fb_exchange_token swap doesn't take a code or redirect_uri.
    expect(parsed.searchParams.get('code')).toBeNull();
    expect(parsed.searchParams.get('redirect_uri')).toBeNull();
  });
});

describe('buildMeAccountsUrl', () => {
  it('targets graph.facebook.com/{version}/me/accounts with the right fields', () => {
    const url = buildMeAccountsUrl({
      apiVersion: 'v25.0',
      accessToken: 'USER_TOKEN'
    });
    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://graph.facebook.com');
    expect(parsed.pathname).toBe('/v25.0/me/accounts');
    expect(parsed.searchParams.get('fields')).toBe('id,name,access_token,category,tasks');
    expect(parsed.searchParams.get('access_token')).toBe('USER_TOKEN');
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* parseFlags                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

describe('parseFlags', () => {
  it('defaults to all-false flags', () => {
    expect(parseFlags([])).toEqual({
      help: false,
      reveal: false
    });
  });
  it('parses --help / -h', () => {
    expect(parseFlags(['--help'])).toMatchObject({ help: true });
    expect(parseFlags(['-h'])).toMatchObject({ help: true });
  });
  it('parses --reveal', () => {
    expect(parseFlags(['--reveal'])).toMatchObject({ reveal: true });
  });
  it('rejects unknown flags with a remediation message', () => {
    expect(() => parseFlags(['--nope'])).toThrow(/Unknown flag/);
    expect(() => parseFlags(['--config-id=foo'])).toThrow(/Unknown flag/);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* hasExistingMessengerPageToken                                              */
/* ────────────────────────────────────────────────────────────────────────── */

describe('hasExistingMessengerPageToken', () => {
  it('returns false for empty .env contents', () => {
    expect(hasExistingMessengerPageToken('')).toBe(false);
  });
  it('returns false when only the empty placeholder line is present', () => {
    const env = 'FOO=bar\nMESSENGER_PAGE_ACCESS_TOKEN=\nBAZ=qux\n';
    expect(hasExistingMessengerPageToken(env)).toBe(false);
  });
  it('returns false when the placeholder line has only trailing whitespace', () => {
    expect(hasExistingMessengerPageToken('MESSENGER_PAGE_ACCESS_TOKEN=   \n')).toBe(false);
  });
  it('returns true when MESSENGER_PAGE_ACCESS_TOKEN has a real value', () => {
    expect(hasExistingMessengerPageToken('MESSENGER_PAGE_ACCESS_TOKEN=EAAGm0PX...\n')).toBe(true);
  });
  it('does not match MESSENGER_PAGE_ID lines (different env var)', () => {
    // Page id is intentionally NOT guarded — the user may set it before OAuth.
    expect(hasExistingMessengerPageToken('MESSENGER_PAGE_ID=1234567890\n')).toBe(false);
  });
  it('matches when MESSENGER_PAGE_ACCESS_TOKEN appears anywhere in the file', () => {
    const env =
      '# Messenger\nMESSENGER_PAGE_ID=1234\nMESSENGER_PAGE_ACCESS_TOKEN=EAA-real-token\n# done\n';
    expect(hasExistingMessengerPageToken(env)).toBe(true);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* selectPage                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

describe('selectPage', () => {
  const pageA: PageEntry = { id: '111', name: 'A', access_token: 'tokA' };
  const pageB: PageEntry = { id: '222', name: 'B', access_token: 'tokB' };
  const pageC: PageEntry = { id: '333', name: 'C', access_token: 'tokC' };

  it('returns prompt mode when zero Pages are returned', () => {
    const result = selectPage([], undefined);
    expect(result.mode).toBe('prompt');
    expect(result.selected).toBeUndefined();
    expect(result.pages).toEqual([]);
  });

  it('auto-selects the only Page when exactly one is returned', () => {
    const result = selectPage([pageA], undefined);
    expect(result.mode).toBe('auto');
    expect(result.selected).toBe(pageA);
  });

  it('auto-selects the Page whose id matches MESSENGER_PAGE_ID', () => {
    const result = selectPage([pageA, pageB, pageC], '222');
    expect(result.mode).toBe('auto');
    expect(result.selected).toBe(pageB);
  });

  it('trims whitespace on MESSENGER_PAGE_ID before matching', () => {
    const result = selectPage([pageA, pageB], '  111  ');
    expect(result.mode).toBe('auto');
    expect(result.selected).toBe(pageA);
  });

  it('falls through to prompt mode when MESSENGER_PAGE_ID is set but does not match', () => {
    // Defensive: a stale MESSENGER_PAGE_ID from a previous account shouldn't
    // grab the wrong Page silently. Force a re-pick.
    const result = selectPage([pageA, pageB, pageC], '999');
    expect(result.mode).toBe('prompt');
    expect(result.selected).toBeUndefined();
    expect(result.pages).toHaveLength(3);
  });

  it('prompts when multiple Pages and no MESSENGER_PAGE_ID hint', () => {
    const result = selectPage([pageA, pageB, pageC], undefined);
    expect(result.mode).toBe('prompt');
    expect(result.selected).toBeUndefined();
  });

  it('treats an empty MESSENGER_PAGE_ID the same as undefined', () => {
    const result = selectPage([pageA, pageB], '');
    expect(result.mode).toBe('prompt');
  });

  it('treats a whitespace-only MESSENGER_PAGE_ID the same as undefined', () => {
    const result = selectPage([pageA, pageB], '   ');
    expect(result.mode).toBe('prompt');
  });
});
