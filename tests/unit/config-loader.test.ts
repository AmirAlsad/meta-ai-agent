/**
 * Focused tests for the validation rules added to `loadConfig`. The broader
 * channel-loading + per-channel behavior is exercised implicitly by every
 * other test in this suite; this file pins down the rules that don't have
 * other test coverage today — primarily the new `NGROK_DOMAIN` validation
 * and the bumped Graph API default.
 */
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/loader.js';

/**
 * A minimal env that satisfies every required loader rule EXCEPT the one
 * under test. Tests selectively delete or overwrite keys to exercise a
 * single validation path at a time.
 */
function baseEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {
    META_APP_SECRET: 'fake-app-secret',
    META_VERIFY_TOKEN: 'verify-token-1234567890',
    CHAT_ENDPOINT_URL: 'https://chat.example.com/agent',
    WHATSAPP_PHONE_NUMBER_ID: '200000000000002',
    WHATSAPP_ACCESS_TOKEN: 'fake-wa-token',
    NGROK_DOMAIN: 'foo.ngrok-free.app',
    ...overrides
  };
  // Mirror the trim-empty-as-unset semantics by stripping undefined keys.
  for (const key of Object.keys(env)) {
    if (env[key] === undefined) delete env[key];
  }
  return env as NodeJS.ProcessEnv;
}

describe('loadConfig: NGROK_DOMAIN', () => {
  it('accepts a bare hostname and surfaces it on Config', () => {
    const config = loadConfig(baseEnv({ NGROK_DOMAIN: 'foo.ngrok-free.app' }));
    expect(config.ngrokDomain).toBe('foo.ngrok-free.app');
  });

  it('throws when NGROK_DOMAIN is missing', () => {
    expect(() => loadConfig(baseEnv({ NGROK_DOMAIN: undefined }))).toThrow(
      /Missing required NGROK_DOMAIN/
    );
  });

  it('throws when NGROK_DOMAIN is whitespace-only', () => {
    expect(() => loadConfig(baseEnv({ NGROK_DOMAIN: '   ' }))).toThrow(
      /Missing required NGROK_DOMAIN/
    );
  });

  it('throws when NGROK_DOMAIN includes an https:// scheme', () => {
    expect(() =>
      loadConfig(baseEnv({ NGROK_DOMAIN: 'https://foo.ngrok-free.app' }))
    ).toThrow(/bare hostname/i);
  });

  it('throws when NGROK_DOMAIN includes an http:// scheme', () => {
    expect(() =>
      loadConfig(baseEnv({ NGROK_DOMAIN: 'http://foo.ngrok-free.app' }))
    ).toThrow(/bare hostname/i);
  });

  it('throws when NGROK_DOMAIN includes a path', () => {
    expect(() =>
      loadConfig(baseEnv({ NGROK_DOMAIN: 'foo.ngrok-free.app/webhook' }))
    ).toThrow(/no path or query/);
  });

  it('throws when NGROK_DOMAIN includes a query string', () => {
    expect(() =>
      loadConfig(baseEnv({ NGROK_DOMAIN: 'foo.ngrok-free.app?x=1' }))
    ).toThrow(/no path or query/);
  });

  it('throws when NGROK_DOMAIN is not a fully-qualified hostname (no dot)', () => {
    expect(() => loadConfig(baseEnv({ NGROK_DOMAIN: 'myapp' }))).toThrow(
      /fully-qualified hostname/
    );
  });

  it('does not pin a specific TLD — accepts paid + custom domains', () => {
    // `.ngrok.app` is paid; custom CNAMEs can use anything. The validator
    // intentionally only checks shape (bare hostname, contains a dot).
    expect(loadConfig(baseEnv({ NGROK_DOMAIN: 'agent.example.com' })).ngrokDomain).toBe(
      'agent.example.com'
    );
    expect(loadConfig(baseEnv({ NGROK_DOMAIN: 'stable.ngrok.app' })).ngrokDomain).toBe(
      'stable.ngrok.app'
    );
  });
});

describe('loadConfig: META_GRAPH_API_VERSION default', () => {
  it('defaults to v25.0 when unset', () => {
    const config = loadConfig(baseEnv());
    expect(config.meta.graphApiVersion).toBe('v25.0');
  });

  it('honors an explicit override', () => {
    const config = loadConfig(baseEnv({ META_GRAPH_API_VERSION: 'v26.0' }));
    expect(config.meta.graphApiVersion).toBe('v26.0');
  });
});
