import { describe, expect, it } from 'vitest';
import {
  buildLongLivedTokenUrl,
  buildShortLivedTokenBody,
  formatExpiresIn,
  generateState,
  hasExistingInstagramValue,
  maskToken,
  parseAuthorizeUrl,
  parseFlags,
  verifyState,
  withState
} from '../../scripts/setup/oauth-instagram.js';

/* ────────────────────────────────────────────────────────────────────────── */
/* URL builders                                                               */
/* ────────────────────────────────────────────────────────────────────────── */

describe('buildShortLivedTokenBody', () => {
  it('constructs a form body with the documented fields', () => {
    const body = buildShortLivedTokenBody({
      clientId: 'APPID',
      clientSecret: 'SECRET',
      redirectUri: 'https://example.com/auth/instagram/callback',
      code: 'CODE123'
    });
    expect(body.get('client_id')).toBe('APPID');
    expect(body.get('client_secret')).toBe('SECRET');
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('redirect_uri')).toBe('https://example.com/auth/instagram/callback');
    expect(body.get('code')).toBe('CODE123');
  });
});

describe('buildLongLivedTokenUrl', () => {
  it('targets graph.instagram.com/access_token (unversioned) with ig_exchange_token grant', () => {
    const url = buildLongLivedTokenUrl({
      clientSecret: 'SECRET',
      shortLivedToken: 'SHORT'
    });
    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://graph.instagram.com');
    expect(parsed.pathname).toBe('/access_token');
    expect(parsed.searchParams.get('grant_type')).toBe('ig_exchange_token');
    expect(parsed.searchParams.get('client_secret')).toBe('SECRET');
    expect(parsed.searchParams.get('access_token')).toBe('SHORT');
    // CRITICAL: must NOT include a version segment (`/v25.0/...`) — Meta 404s.
    expect(parsed.pathname).not.toMatch(/^\/v\d+\.\d+\//);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* State                                                                      */
/* ────────────────────────────────────────────────────────────────────────── */

describe('generateState / verifyState', () => {
  it('generates 32-char hex states', () => {
    const a = generateState();
    const b = generateState();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(b).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });

  it('verifies matching state and rejects mismatches', () => {
    const s = generateState();
    // Flip the first char to a deterministically-different hex digit (the
    // previous `s.replace(/^./, 'f')` was a silent no-op when s happened to
    // start with 'f' — ~1-in-16 flake).
    const flipped = (s[0] === 'a' ? 'b' : 'a') + s.slice(1);
    expect(verifyState(s, s)).toBe(true);
    expect(verifyState(s, flipped)).toBe(false);
    expect(verifyState(s, 'short')).toBe(false);
    expect(verifyState('', '')).toBe(true);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Misc helpers                                                               */
/* ────────────────────────────────────────────────────────────────────────── */

describe('maskToken', () => {
  it('masks short tokens entirely', () => {
    expect(maskToken('abc')).toBe('***');
    expect(maskToken('1234567890123')).toBe('*'.repeat(13));
  });
  it('shows first 10 + last 4 of long tokens', () => {
    expect(maskToken('IGAAJabcdef1234567890XYZW')).toBe('IGAAJabcde...XYZW');
  });
});

describe('formatExpiresIn', () => {
  it('formats seconds into a friendly day count', () => {
    expect(formatExpiresIn(5_184_000)).toMatch(/~60 days/);
    expect(formatExpiresIn(3_600)).toBe('3600s');
    expect(formatExpiresIn(undefined)).toBe('unknown');
    expect(formatExpiresIn(0)).toBe('unknown');
  });
});

describe('parseFlags', () => {
  it('defaults to all-false flags', () => {
    expect(parseFlags([])).toEqual({
      help: false,
      reveal: false
    });
  });
  it('parses --help / -h and --reveal', () => {
    expect(parseFlags(['--help'])).toMatchObject({ help: true });
    expect(parseFlags(['-h'])).toMatchObject({ help: true });
    expect(parseFlags(['--reveal'])).toMatchObject({ reveal: true });
  });
  it('rejects unknown flags', () => {
    expect(() => parseFlags(['--nope'])).toThrow(/Unknown flag/);
  });
  it('rejects previously-supported flags now removed', () => {
    // --redirect-uri and --use-localhost were dropped when we made
    // INSTAGRAM_AUTHORIZE_URL the single source of truth.
    expect(() => parseFlags(['--use-localhost'])).toThrow(/Unknown flag/);
    expect(() => parseFlags(['--redirect-uri=https://example.com/cb'])).toThrow(/Unknown flag/);
  });
});

describe('parseAuthorizeUrl', () => {
  const goodUrl =
    'https://www.instagram.com/oauth/authorize' +
    '?client_id=965167189751983' +
    '&redirect_uri=https%3A%2F%2Ffoo.ngrok-free.app%2Fauth%2Finstagram%2Fcallback' +
    '&scope=instagram_business_basic%2Cinstagram_business_manage_messages' +
    '&response_type=code' +
    '&state=abc123def456';

  it('extracts clientId, redirect_uri, and state from a well-formed embed URL', () => {
    expect(parseAuthorizeUrl(goodUrl)).toEqual({
      clientId: '965167189751983',
      redirectUri: 'https://foo.ngrok-free.app/auth/instagram/callback',
      state: 'abc123def456'
    });
  });

  it('throws a clear error when the URL is not parseable', () => {
    expect(() => parseAuthorizeUrl('not a url')).toThrow(/not a valid URL/);
  });

  it('throws when client_id is missing', () => {
    const noClient =
      'https://www.instagram.com/oauth/authorize?redirect_uri=https%3A%2F%2Fexample.com%2Fcb&state=y&response_type=code';
    expect(() => parseAuthorizeUrl(noClient)).toThrow(/missing the required client_id/);
  });

  it('throws when redirect_uri is missing', () => {
    const noRedirect =
      'https://www.instagram.com/oauth/authorize?client_id=x&state=y&response_type=code';
    expect(() => parseAuthorizeUrl(noRedirect)).toThrow(/missing the required redirect_uri/);
  });

  it('returns state=undefined when missing (Meta Dashboard embed URLs omit it)', () => {
    const noState =
      'https://www.instagram.com/oauth/authorize' +
      '?client_id=x&redirect_uri=https%3A%2F%2Fexample.com%2Fcb&response_type=code';
    expect(parseAuthorizeUrl(noState)).toEqual({
      clientId: 'x',
      redirectUri: 'https://example.com/cb',
      state: undefined
    });
  });

  it('tolerates extra Meta-specific params (enable_fb_login, force_authentication, etc.)', () => {
    const extra =
      goodUrl + '&enable_fb_login=0&force_authentication=1';
    expect(parseAuthorizeUrl(extra)).toEqual({
      clientId: '965167189751983',
      redirectUri: 'https://foo.ngrok-free.app/auth/instagram/callback',
      state: 'abc123def456'
    });
  });
});

describe('withState', () => {
  const base =
    'https://www.instagram.com/oauth/authorize' +
    '?client_id=x&redirect_uri=https%3A%2F%2Fexample.com%2Fcb&response_type=code';

  it('appends state when absent', () => {
    const result = withState(base, 'newstate123');
    expect(new URL(result).searchParams.get('state')).toBe('newstate123');
  });

  it('replaces existing state', () => {
    const withOld = `${base}&state=old`;
    const result = withState(withOld, 'fresh');
    expect(new URL(result).searchParams.get('state')).toBe('fresh');
  });

  it('preserves all other query params', () => {
    const result = withState(base, 'x');
    const u = new URL(result);
    expect(u.searchParams.get('client_id')).toBe('x');
    expect(u.searchParams.get('redirect_uri')).toBe('https://example.com/cb');
    expect(u.searchParams.get('response_type')).toBe('code');
  });
});

describe('hasExistingInstagramValue', () => {
  it('returns false for empty .env contents', () => {
    expect(hasExistingInstagramValue('')).toBe(false);
  });
  it('returns false when only empty placeholder lines are present', () => {
    const env = 'FOO=bar\nINSTAGRAM_USER_ID=\nINSTAGRAM_ACCESS_TOKEN=\nBAR=baz\n';
    expect(hasExistingInstagramValue(env)).toBe(false);
  });
  it('returns false when placeholder line has only trailing whitespace', () => {
    expect(hasExistingInstagramValue('INSTAGRAM_USER_ID=   \n')).toBe(false);
  });
  it('returns true when INSTAGRAM_USER_ID has a real value', () => {
    expect(hasExistingInstagramValue('INSTAGRAM_USER_ID=17841405793187218\n')).toBe(true);
  });
  it('returns true when INSTAGRAM_ACCESS_TOKEN has a real value', () => {
    expect(hasExistingInstagramValue('INSTAGRAM_ACCESS_TOKEN=IGQ...\n')).toBe(true);
  });
  it('returns true when at least one of the two is non-empty', () => {
    const env = 'INSTAGRAM_USER_ID=\nINSTAGRAM_ACCESS_TOKEN=IGQ-real-token\n';
    expect(hasExistingInstagramValue(env)).toBe(true);
  });
  it('ignores other env vars that happen to start with INSTAGRAM', () => {
    expect(hasExistingInstagramValue('INSTAGRAM_OTHER=foo\n')).toBe(false);
  });
});
