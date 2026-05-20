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

describe('loadConfig: conversation defaults', () => {
  it('applies all documented defaults when no conversation vars are set', () => {
    const { conversation } = loadConfig(baseEnv());
    expect(conversation).toEqual({
      bufferBaseTimeoutMs: 2000,
      bufferGrowthFactor: 1.25,
      bufferMaxTimeoutMs: 8000,
      bufferNoiseMaxDeviation: 0.3,
      outboundTypingIndicatorsEnabled: true,
      typingRefreshIntervalMs: 5000,
      typingRefreshMaxMs: 120000,
      readReceiptsEnabled: false,
      outboundDeliveryTimeoutMs: 30000,
      chatEndpointTimeoutMs: 30000,
      dedupeTtlSeconds: 86400
    });
  });
});

describe('loadConfig: positive-integer conversation knobs', () => {
  // Every positive-integer knob shares one loader; table-drive the cases.
  // `extra` pins companion vars so a single override never trips the buffer
  // max>=base cross-check (e.g. raising base above the default max).
  const intKnobs: Array<{
    env: string;
    field: keyof ReturnType<typeof loadConfig>['conversation'];
    extra?: Record<string, string>;
  }> = [
    { env: 'BUFFER_BASE_TIMEOUT_MS', field: 'bufferBaseTimeoutMs', extra: { BUFFER_MAX_TIMEOUT_MS: '99999' } },
    { env: 'BUFFER_MAX_TIMEOUT_MS', field: 'bufferMaxTimeoutMs' },
    { env: 'TYPING_REFRESH_INTERVAL_MS', field: 'typingRefreshIntervalMs' },
    { env: 'TYPING_REFRESH_MAX_MS', field: 'typingRefreshMaxMs' },
    { env: 'OUTBOUND_DELIVERY_TIMEOUT_MS', field: 'outboundDeliveryTimeoutMs' },
    { env: 'CHAT_ENDPOINT_TIMEOUT_MS', field: 'chatEndpointTimeoutMs' },
    { env: 'DEDUPE_TTL_SECONDS', field: 'dedupeTtlSeconds' }
  ];

  for (const { env, field, extra } of intKnobs) {
    describe(env, () => {
      it('honors a valid override', () => {
        // Use a large value so a single override never trips the max>=base check.
        const config = loadConfig(baseEnv({ ...extra, [env]: '99999' }));
        expect(config.conversation[field]).toBe(99999);
      });

      it('throws (naming the var) on a non-numeric value', () => {
        expect(() => loadConfig(baseEnv({ [env]: 'abc' }))).toThrow(new RegExp(`Invalid ${env}`));
      });

      it('throws on a non-integer (float) value', () => {
        expect(() => loadConfig(baseEnv({ [env]: '12.5' }))).toThrow(new RegExp(`Invalid ${env}`));
      });

      it('throws on zero (must be >= 1)', () => {
        expect(() => loadConfig(baseEnv({ [env]: '0' }))).toThrow(new RegExp(`Invalid ${env}`));
      });

      it('throws on a negative value', () => {
        expect(() => loadConfig(baseEnv({ [env]: '-1' }))).toThrow(new RegExp(`Invalid ${env}`));
      });
    });
  }
});

describe('loadConfig: BUFFER_GROWTH_FACTOR', () => {
  it('honors a valid override', () => {
    expect(loadConfig(baseEnv({ BUFFER_GROWTH_FACTOR: '1.5' })).conversation.bufferGrowthFactor).toBe(
      1.5
    );
  });

  it('accepts exactly 1 (the minimum)', () => {
    expect(loadConfig(baseEnv({ BUFFER_GROWTH_FACTOR: '1' })).conversation.bufferGrowthFactor).toBe(1);
  });

  it('throws when below 1', () => {
    expect(() => loadConfig(baseEnv({ BUFFER_GROWTH_FACTOR: '0.9' }))).toThrow(
      /Invalid BUFFER_GROWTH_FACTOR/
    );
  });

  it('throws on a non-numeric value', () => {
    expect(() => loadConfig(baseEnv({ BUFFER_GROWTH_FACTOR: 'fast' }))).toThrow(
      /Invalid BUFFER_GROWTH_FACTOR/
    );
  });
});

describe('loadConfig: BUFFER_NOISE_MAX_DEVIATION', () => {
  it('honors a valid override inside 0..1', () => {
    expect(
      loadConfig(baseEnv({ BUFFER_NOISE_MAX_DEVIATION: '0.5' })).conversation.bufferNoiseMaxDeviation
    ).toBe(0.5);
  });

  it('accepts the 0 and 1 bounds', () => {
    expect(
      loadConfig(baseEnv({ BUFFER_NOISE_MAX_DEVIATION: '0' })).conversation.bufferNoiseMaxDeviation
    ).toBe(0);
    expect(
      loadConfig(baseEnv({ BUFFER_NOISE_MAX_DEVIATION: '1' })).conversation.bufferNoiseMaxDeviation
    ).toBe(1);
  });

  it('throws when above 1', () => {
    expect(() => loadConfig(baseEnv({ BUFFER_NOISE_MAX_DEVIATION: '1.1' }))).toThrow(
      /Invalid BUFFER_NOISE_MAX_DEVIATION/
    );
  });

  it('throws when below 0', () => {
    expect(() => loadConfig(baseEnv({ BUFFER_NOISE_MAX_DEVIATION: '-0.1' }))).toThrow(
      /Invalid BUFFER_NOISE_MAX_DEVIATION/
    );
  });
});

describe('loadConfig: buffer max >= base cross-check', () => {
  it('accepts max equal to base', () => {
    const config = loadConfig(
      baseEnv({ BUFFER_BASE_TIMEOUT_MS: '5000', BUFFER_MAX_TIMEOUT_MS: '5000' })
    );
    expect(config.conversation.bufferBaseTimeoutMs).toBe(5000);
    expect(config.conversation.bufferMaxTimeoutMs).toBe(5000);
  });

  it('throws (naming both vars) when max < base', () => {
    expect(() =>
      loadConfig(baseEnv({ BUFFER_BASE_TIMEOUT_MS: '9000', BUFFER_MAX_TIMEOUT_MS: '3000' }))
    ).toThrow(/BUFFER_MAX_TIMEOUT_MS.*less than BUFFER_BASE_TIMEOUT_MS/);
  });
});

describe('loadConfig: boolean conversation knobs', () => {
  for (const { env, field, def } of [
    { env: 'OUTBOUND_TYPING_INDICATORS_ENABLED', field: 'outboundTypingIndicatorsEnabled', def: true },
    { env: 'READ_RECEIPTS_ENABLED', field: 'readReceiptsEnabled', def: false }
  ] as const) {
    describe(env, () => {
      it(`defaults to ${def}`, () => {
        expect(loadConfig(baseEnv()).conversation[field]).toBe(def);
      });

      for (const truthy of ['1', 'true', 'TRUE']) {
        it(`parses "${truthy}" as true`, () => {
          expect(loadConfig(baseEnv({ [env]: truthy })).conversation[field]).toBe(true);
        });
      }

      for (const falsy of ['0', 'false', 'False']) {
        it(`parses "${falsy}" as false`, () => {
          expect(loadConfig(baseEnv({ [env]: falsy })).conversation[field]).toBe(false);
        });
      }

      it('throws (naming the var) on an unrecognized value', () => {
        expect(() => loadConfig(baseEnv({ [env]: 'yes' }))).toThrow(new RegExp(`Invalid ${env}`));
      });
    });
  }
});

describe('loadConfig: AGENT_AUTOSTART (unchanged after loadBoolean refactor)', () => {
  it('defaults to true', () => {
    expect(loadConfig(baseEnv()).agentAutostart).toBe(true);
  });

  it('parses "0" / "false" as false', () => {
    expect(loadConfig(baseEnv({ AGENT_AUTOSTART: '0' })).agentAutostart).toBe(false);
    expect(loadConfig(baseEnv({ AGENT_AUTOSTART: 'false' })).agentAutostart).toBe(false);
  });

  it('still throws with its own var name on a bad value', () => {
    expect(() => loadConfig(baseEnv({ AGENT_AUTOSTART: 'maybe' }))).toThrow(
      /Invalid AGENT_AUTOSTART/
    );
  });
});
