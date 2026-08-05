/**
 * Production-hardening tests: the NGROK_DOMAIN production bypass, the
 * expanded Messenger/Instagram rate-limit code set, the send-failure subcode
 * hints, the webhook delivery-gap monitor, and the Instagram token-refresh
 * script's pure helpers.
 */
import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { loadConfig } from '../../src/config/loader.js';
import {
  META_RATE_LIMIT_ERROR_CODES,
  MESSENGER_SEND_SUBCODE_HINTS
} from '../../src/limits/error-codes.js';
import { createLimitTracker } from '../../src/limits/tracker.js';
import { InMemoryLimitCounterStore } from '../../src/limits/store.js';
import { defaultLimitsConfig } from '../../src/config/loader.js';
import { MetaApiError } from '../../src/meta/shared/errors.js';
import { WebhookGapMonitor } from '../../src/monitoring/webhook-gap.js';
import {
  parseFlags as parseRefreshFlags,
  replaceTokenLine,
  tokenEnvVarName
} from '../../scripts/setup/refresh-instagram-tokens.js';
import { parseMetaWebhook } from '../../src/meta/parser.js';

const silentLogger = pino({ level: 'silent' });

function baseEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {
    META_APP_SECRET: 'fake-app-secret',
    META_VERIFY_TOKEN: 'verify-token-1234567890',
    CHAT_ENDPOINT_URL: 'https://chat.example.com/agent',
    WHATSAPP_PHONE_NUMBER_ID: '200000000000002',
    WHATSAPP_ACCESS_TOKEN: 'fake-wa-token-long-enough',
    NGROK_DOMAIN: 'foo.ngrok-free.app',
    ...overrides
  };
  for (const key of Object.keys(env)) {
    if (env[key] === undefined) delete env[key];
  }
  return env as NodeJS.ProcessEnv;
}

describe('NGROK_DOMAIN production bypass', () => {
  it('still throws when missing in development', () => {
    expect(() => loadConfig(baseEnv({ NGROK_DOMAIN: undefined }))).toThrow(
      /Missing required NGROK_DOMAIN/
    );
  });

  it('is optional when NODE_ENV=production', () => {
    const config = loadConfig(baseEnv({ NGROK_DOMAIN: undefined, NODE_ENV: 'production' }));
    expect(config.ngrokDomain).toBeUndefined();
    expect(config.nodeEnv).toBe('production');
  });

  it('still validates a malformed value in production', () => {
    expect(() =>
      loadConfig(baseEnv({ NGROK_DOMAIN: 'https://foo.ngrok-free.app', NODE_ENV: 'production' }))
    ).toThrow(/Use a bare hostname/);
  });
});

describe('rate-limit code classification', () => {
  it('includes the Messenger/Instagram throttle codes', () => {
    for (const code of [4, 17, 32, 613, 80002, 80006, 80007, 130429, 131056]) {
      expect(META_RATE_LIMIT_ERROR_CODES.has(code)).toBe(true);
    }
  });

  it('classifies a Page-throttle error as transient (bounded backoff retry)', () => {
    const tracker = createLimitTracker({
      store: new InMemoryLimitCounterStore(),
      config: defaultLimitsConfig(),
      logger: silentLogger
    });
    const error = new MetaApiError({
      operation: 'messenger.sendText',
      httpStatus: 400,
      errorCode: 32,
      responseBody: {}
    });
    expect(tracker.classifyError('messenger', error)).toBe('transient');
  });

  it('keeps the role-gate and window subcodes permanent, with distinct hints', () => {
    const tracker = createLimitTracker({
      store: new InMemoryLimitCounterStore(),
      config: defaultLimitsConfig(),
      logger: silentLogger
    });
    const roleGate = new MetaApiError({
      operation: 'messenger.sendText',
      httpStatus: 400,
      errorCode: 10,
      errorSubCode: 2018028,
      responseBody: {}
    });
    const window = new MetaApiError({
      operation: 'messenger.sendText',
      httpStatus: 400,
      errorCode: 10,
      errorSubCode: 2018065,
      responseBody: {}
    });
    expect(tracker.classifyError('messenger', roleGate)).toBe('permanent');
    expect(tracker.classifyError('messenger', window)).toBe('permanent');
    expect(MESSENGER_SEND_SUBCODE_HINTS.get(2018028)).toMatch(/role/i);
    expect(MESSENGER_SEND_SUBCODE_HINTS.get(2018065)).toMatch(/window/i);
  });
});

describe('WebhookGapMonitor', () => {
  function makeMonitor(thresholdMs: number): {
    monitor: WebhookGapMonitor;
    errors: unknown[];
    clock: { t: number };
  } {
    const errors: unknown[] = [];
    const clock = { t: 1_000_000 };
    const logger = pino(
      { level: 'error' },
      {
        write(line: string) {
          errors.push(JSON.parse(line));
        }
      }
    );
    const monitor = new WebhookGapMonitor({
      logger,
      thresholdMs,
      now: () => clock.t
    });
    return { monitor, errors, clock };
  }

  it('never alerts for a channel that has not delivered at all', () => {
    const h = makeMonitor(60_000);
    h.clock.t += 10 * 60_000;
    h.monitor.check();
    expect(h.errors).toHaveLength(0);
  });

  it('alerts once the gap exceeds the threshold, and re-alerts once per window', () => {
    const h = makeMonitor(60_000);
    h.monitor.recordReceipt('messenger');
    h.clock.t += 30_000;
    h.monitor.check();
    expect(h.errors).toHaveLength(0);

    h.clock.t += 40_000; // gap 70s > 60s
    h.monitor.check();
    expect(h.errors).toHaveLength(1);

    h.clock.t += 10_000; // same window — no re-alert
    h.monitor.check();
    expect(h.errors).toHaveLength(1);

    h.clock.t += 60_000; // next window — re-alert
    h.monitor.check();
    expect(h.errors).toHaveLength(2);
  });

  it('a new receipt clears the gap and the alert state', () => {
    const h = makeMonitor(60_000);
    h.monitor.recordReceipt('instagram');
    h.clock.t += 70_000;
    h.monitor.check();
    expect(h.errors).toHaveLength(1);

    h.monitor.recordReceipt('instagram');
    h.clock.t += 30_000;
    h.monitor.check();
    expect(h.errors).toHaveLength(1);
  });
});

describe('refresh-instagram-tokens helpers', () => {
  it('parseFlags handles --write / --reveal and rejects unknowns', () => {
    expect(parseRefreshFlags([])).toEqual({ help: false, write: false, reveal: false });
    expect(parseRefreshFlags(['--write', '--reveal'])).toEqual({
      help: false,
      write: true,
      reveal: true
    });
    expect(() => parseRefreshFlags(['--nope'])).toThrow(/Unknown flag/);
  });

  it('tokenEnvVarName maps default to the bare var, names to the suffixed form', () => {
    expect(tokenEnvVarName('default')).toBe('INSTAGRAM_ACCESS_TOKEN');
    expect(tokenEnvVarName('reed')).toBe('INSTAGRAM_ACCESS_TOKEN__reed');
  });

  it('replaceTokenLine rewrites only the targeted account line', () => {
    const env = [
      'INSTAGRAM_ACCESS_TOKEN=IGAAoldDefault',
      'INSTAGRAM_ACCESS_TOKEN__reed=IGAAoldReed',
      'OTHER=x'
    ].join('\n');
    const updated = replaceTokenLine(env, 'reed', 'IGAAnewReed');
    expect(updated).toContain('INSTAGRAM_ACCESS_TOKEN__reed=IGAAnewReed');
    expect(updated).toContain('INSTAGRAM_ACCESS_TOKEN=IGAAoldDefault');
    // Rewriting default must not touch reed's line (the bare-var pattern must
    // not match the suffixed line).
    const updatedDefault = replaceTokenLine(env, 'default', 'IGAAnewDefault');
    expect(updatedDefault).toContain('INSTAGRAM_ACCESS_TOKEN=IGAAnewDefault');
    expect(updatedDefault).toContain('INSTAGRAM_ACCESS_TOKEN__reed=IGAAoldReed');
  });

  it('replaceTokenLine returns undefined when no non-empty line exists', () => {
    expect(replaceTokenLine('INSTAGRAM_ACCESS_TOKEN=\n', 'default', 'IGAAx')).toBeUndefined();
    expect(replaceTokenLine('OTHER=x\n', 'reed', 'IGAAx')).toBeUndefined();
  });
});

describe('policy_enforcement surfacing', () => {
  it('parses a sender-less policy_enforcement event instead of dropping it', () => {
    const result = parseMetaWebhook({
      object: 'page',
      entry: [
        {
          id: '111111111111111',
          time: 1785905000000,
          messaging: [
            {
              recipient: { id: '111111111111111' },
              timestamp: 1785905000000,
              policy_enforcement: { action: 'warning', reason: 'Repetitive content.' }
            }
          ]
        }
      ]
    });
    expect(result.messages).toHaveLength(1);
    const msg = result.messages[0]!;
    expect(msg.type).toBe('unknown');
    expect(msg.channelScopedBusinessId).toBe('111111111111111');
    expect((msg.raw as { policy_enforcement?: unknown }).policy_enforcement).toEqual({
      action: 'warning',
      reason: 'Repetitive content.'
    });
  });
});
