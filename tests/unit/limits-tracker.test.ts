import pino from 'pino';
import { describe, expect, it } from 'vitest';
import type { LimitsConfig } from '../../src/config/loader.js';
import { MetaApiError } from '../../src/meta/shared/errors.js';
import { InMemoryLimitCounterStore, type LimitCounterStore } from '../../src/limits/store.js';
import { createLimitTracker } from '../../src/limits/tracker.js';

const silentLogger = pino({ level: 'silent' });

function makeConfig(overrides: Partial<LimitsConfig> = {}): LimitsConfig {
  return {
    whatsappPerSecond: 80,
    messengerPerSecond: 40,
    instagramPerSecond: 2,
    whatsappPerHour: 1000,
    whatsappPerDay: 10000,
    messengerPerHour: 0,
    messengerPerDay: 0,
    instagramPerHour: 0,
    instagramPerDay: 0,
    transientRetryMaxAttempts: 3,
    transientRetryBaseMs: 1000,
    transientRetryMaxMs: 60000,
    ...overrides
  };
}

function metaError(httpStatus: number, errorCode?: number): MetaApiError {
  return new MetaApiError({
    operation: 'sendText',
    httpStatus,
    ...(errorCode !== undefined ? { errorCode } : {}),
    responseBody: { error: { message: 'boom', code: errorCode } }
  });
}

describe('createLimitTracker — pacing', () => {
  it('does not sleep on the first send, sleeps ~intervalMs on a rapid second send', async () => {
    const slept: number[] = [];
    const tracker = createLimitTracker({
      store: new InMemoryLimitCounterStore(),
      config: makeConfig({ whatsappPerSecond: 4 }), // intervalMs = 250
      logger: silentLogger,
      now: () => 1000,
      sleep: async ms => {
        slept.push(ms);
      }
    });

    await tracker.acquireSendSlot('whatsapp', 'biz');
    expect(slept).toEqual([]); // first send: delay 0, sleep skipped
    await tracker.acquireSendSlot('whatsapp', 'biz');
    expect(slept).toEqual([250]);
  });

  it('picks the per-channel rate (instagram slower than whatsapp)', async () => {
    const slept: number[] = [];
    const tracker = createLimitTracker({
      store: new InMemoryLimitCounterStore(),
      config: makeConfig({ whatsappPerSecond: 10, instagramPerSecond: 2 }),
      logger: silentLogger,
      now: () => 100_000, // non-zero so the first send on each line is free
      sleep: async ms => {
        slept.push(ms);
      }
    });

    // WhatsApp: intervalMs = 100. IG: intervalMs = 500. Distinct lines.
    await tracker.acquireSendSlot('whatsapp', 'biz'); // 0 (first on line)
    await tracker.acquireSendSlot('whatsapp', 'biz'); // 100
    await tracker.acquireSendSlot('instagram', 'biz'); // 0 (new line)
    await tracker.acquireSendSlot('instagram', 'biz'); // 500
    expect(slept).toEqual([100, 500]);
  });

  it('keys lines by channel:businessId so distinct businesses do not collide', async () => {
    const slept: number[] = [];
    const tracker = createLimitTracker({
      store: new InMemoryLimitCounterStore(),
      config: makeConfig({ whatsappPerSecond: 4 }),
      logger: silentLogger,
      now: () => 1000,
      sleep: async ms => {
        slept.push(ms);
      }
    });
    await tracker.acquireSendSlot('whatsapp', 'bizA');
    await tracker.acquireSendSlot('whatsapp', 'bizB'); // different line: no wait
    expect(slept).toEqual([]);
  });

  it('is fail-open: a throwing store never throws and never sleeps', async () => {
    const slept: number[] = [];
    const throwingStore: LimitCounterStore = {
      async acquireOutboundSlot() {
        throw new Error('redis down');
      },
      async incrementWindowCounters() {
        throw new Error('redis down');
      }
    };
    const tracker = createLimitTracker({
      store: throwingStore,
      config: makeConfig(),
      logger: silentLogger,
      sleep: async ms => {
        slept.push(ms);
      }
    });
    await expect(tracker.acquireSendSlot('whatsapp', 'biz')).resolves.toBeUndefined();
    expect(slept).toEqual([]);
  });
});

describe('createLimitTracker — classifyError', () => {
  const tracker = createLimitTracker({
    store: new InMemoryLimitCounterStore(),
    config: makeConfig(),
    logger: silentLogger
  });

  it('classifies WhatsApp re-engagement codes (131047, 470) as window_closed', () => {
    for (const code of [131047, 470]) {
      expect(tracker.classifyError('whatsapp', metaError(400, code))).toBe('window_closed');
    }
  });

  it('does NOT treat 131051 (unsupported message type) as window_closed — it is permanent', () => {
    // 131051 is a malformed-payload bug, not the 24h window; a template re-prompt
    // would not fix it, so it must fall through to permanent (skip + advance).
    expect(tracker.classifyError('whatsapp', metaError(400, 131051))).toBe('permanent');
  });

  it('treats the same window codes as permanent on a non-whatsapp channel', () => {
    // A 400 on messenger/IG with a "window" code is just a permanent 400 there.
    expect(tracker.classifyError('messenger', metaError(400, 131047))).toBe('permanent');
    expect(tracker.classifyError('instagram', metaError(400, 470))).toBe('permanent');
  });

  it('classifies network (httpStatus 0) and 429 as transient', () => {
    expect(tracker.classifyError('whatsapp', metaError(0))).toBe('transient');
    expect(tracker.classifyError('messenger', metaError(429))).toBe('transient');
  });

  it('classifies Meta rate-limit error CODES (4/80007/130429/131056/613) as transient even on a 4xx', () => {
    // Meta returns rate limits as a 4xx with a specific code, NOT HTTP 429.
    for (const code of [4, 80007, 130429, 131056, 613]) {
      expect(tracker.classifyError('whatsapp', metaError(400, code))).toBe('transient');
      expect(tracker.classifyError('instagram', metaError(403, code))).toBe('transient');
    }
  });

  it('classifies 5xx as permanent (double-send safety — a 5xx after a POST may have delivered)', () => {
    // Re-sending a POST after a 5xx could double-deliver; Meta has no idempotency
    // key for the messages endpoint, so we mirror GraphClient and do NOT retry.
    expect(tracker.classifyError('instagram', metaError(500))).toBe('permanent');
    expect(tracker.classifyError('whatsapp', metaError(503))).toBe('permanent');
  });

  it('classifies a generic (non-Meta) Error as permanent (could have surfaced post-acceptance)', () => {
    expect(tracker.classifyError('whatsapp', new Error('ECONNRESET'))).toBe('permanent');
    expect(tracker.classifyError('instagram', new TypeError('fetch failed'))).toBe('permanent');
  });

  it('classifies a plain 4xx MetaApiError as permanent', () => {
    expect(tracker.classifyError('whatsapp', metaError(400))).toBe('permanent');
    expect(tracker.classifyError('messenger', metaError(403, 10))).toBe('permanent');
  });

  it('classifies a non-Error value as permanent', () => {
    expect(tracker.classifyError('whatsapp', 'just a string')).toBe('permanent');
    expect(tracker.classifyError('whatsapp', undefined)).toBe('permanent');
  });
});

describe('createLimitTracker — classifyStatusErrorCode (async failed-status path)', () => {
  const tracker = createLimitTracker({
    store: new InMemoryLimitCounterStore(),
    config: makeConfig(),
    logger: silentLogger
  });

  it('classifies WhatsApp window codes (131047, 470) as window_closed', () => {
    expect(tracker.classifyStatusErrorCode('whatsapp', 131047)).toBe('window_closed');
    expect(tracker.classifyStatusErrorCode('whatsapp', 470)).toBe('window_closed');
  });

  it('does NOT treat 131051 as window_closed — it is permanent', () => {
    expect(tracker.classifyStatusErrorCode('whatsapp', 131051)).toBe('permanent');
  });

  it('treats window codes as permanent on a non-whatsapp channel', () => {
    expect(tracker.classifyStatusErrorCode('messenger', 131047)).toBe('permanent');
    expect(tracker.classifyStatusErrorCode('instagram', 470)).toBe('permanent');
  });

  it('classifies Meta rate-limit codes as transient on ANY channel', () => {
    for (const code of [4, 80007, 130429, 131056, 613]) {
      expect(tracker.classifyStatusErrorCode('whatsapp', code)).toBe('transient');
      expect(tracker.classifyStatusErrorCode('messenger', code)).toBe('transient');
      expect(tracker.classifyStatusErrorCode('instagram', code)).toBe('transient');
    }
  });

  it('classifies undefined (no code on the status) as permanent', () => {
    expect(tracker.classifyStatusErrorCode('whatsapp', undefined)).toBe('permanent');
    expect(tracker.classifyStatusErrorCode('messenger', undefined)).toBe('permanent');
  });

  it('classifies policy / recipient / unknown codes as permanent', () => {
    // 131048 spam, 131026 undeliverable, 999999 unknown — none is retry-safe.
    for (const code of [131048, 131026, 190, 999999]) {
      expect(tracker.classifyStatusErrorCode('whatsapp', code)).toBe('permanent');
    }
  });
});

describe('createLimitTracker — recordOutbound (track-only per-hour/day counters)', () => {
  /** Capture warn/error log lines via a pino destination-stream spy logger. */
  function spyLogger(): { logger: pino.Logger; warns: unknown[]; errors: unknown[] } {
    const warns: unknown[] = [];
    const errors: unknown[] = [];
    // pino merges the first-arg mergeObject (which carries our `window` field)
    // into the emitted JSON line, so the captured object exposes `.window`.
    const logger = pino(
      { level: 'trace' },
      {
        write(line: string) {
          const obj = JSON.parse(line) as { level: number };
          if (obj.level === 40) warns.push(obj);
          if (obj.level >= 50) errors.push(obj);
        }
      }
    ) as pino.Logger;
    return { logger, warns, errors };
  }

  it('warns exactly once at 80% of the hourly cap and errors exactly once at 100%', async () => {
    const { logger, warns, errors } = spyLogger();
    // hour cap 10 → warn at 8; day disabled (0) so only the hour window logs.
    const tracker = createLimitTracker({
      store: new InMemoryLimitCounterStore(),
      config: makeConfig({ whatsappPerHour: 10, whatsappPerDay: 0 }),
      logger,
      now: () => 0
    });
    for (let i = 0; i < 12; i += 1) {
      await tracker.recordOutbound('whatsapp', 'biz');
    }
    // Warn fires only on the EXACT crossing (count === 8), not on every send past it.
    const hourWarns = warns.filter((w) => (w as { window?: string }).window === 'hour');
    const hourErrors = errors.filter((e) => (e as { window?: string }).window === 'hour');
    expect(hourWarns).toHaveLength(1);
    expect(hourErrors).toHaveLength(1);
  });

  it('logs nothing when the window cap is 0 (disabled)', async () => {
    const { logger, warns, errors } = spyLogger();
    const tracker = createLimitTracker({
      store: new InMemoryLimitCounterStore(),
      config: makeConfig({ whatsappPerHour: 0, whatsappPerDay: 0 }),
      logger,
      now: () => 0
    });
    for (let i = 0; i < 50; i += 1) await tracker.recordOutbound('whatsapp', 'biz');
    expect(warns).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  it('tracks hour and day windows independently (day warn at its own 80%)', async () => {
    const { logger, warns } = spyLogger();
    // hour 100 (warn at 80, never reached), day 5 (warn at 4).
    const tracker = createLimitTracker({
      store: new InMemoryLimitCounterStore(),
      config: makeConfig({ whatsappPerHour: 100, whatsappPerDay: 5 }),
      logger,
      now: () => 0
    });
    for (let i = 0; i < 4; i += 1) await tracker.recordOutbound('whatsapp', 'biz');
    const dayWarns = warns.filter((w) => (w as { window?: string }).window === 'day');
    const hourWarns = warns.filter((w) => (w as { window?: string }).window === 'hour');
    expect(dayWarns).toHaveLength(1); // count hit 4 = floor(5*0.8)
    expect(hourWarns).toHaveLength(0); // never reached 80
  });

  it('is fail-open: a throwing store never throws out of recordOutbound', async () => {
    const throwingStore: LimitCounterStore = {
      async acquireOutboundSlot() {
        return 0;
      },
      async incrementWindowCounters() {
        throw new Error('redis down');
      }
    };
    const tracker = createLimitTracker({
      store: throwingStore,
      config: makeConfig({ whatsappPerHour: 10 }),
      logger: silentLogger
    });
    await expect(tracker.recordOutbound('whatsapp', 'biz')).resolves.toBeUndefined();
  });

  it('keys windows by channel:businessId (distinct lines counted separately)', async () => {
    const { logger, errors } = spyLogger();
    // hour cap 2 → error at 2. Two different businesses each need 2 to error.
    const tracker = createLimitTracker({
      store: new InMemoryLimitCounterStore(),
      config: makeConfig({ whatsappPerHour: 2, whatsappPerDay: 0 }),
      logger,
      now: () => 0
    });
    await tracker.recordOutbound('whatsapp', 'bizA'); // A=1
    await tracker.recordOutbound('whatsapp', 'bizB'); // B=1 (independent line)
    expect(errors.filter((e) => (e as { window?: string }).window === 'hour')).toHaveLength(0);
    await tracker.recordOutbound('whatsapp', 'bizA'); // A=2 → error
    expect(errors.filter((e) => (e as { window?: string }).window === 'hour')).toHaveLength(1);
  });
});

describe('createLimitTracker — retry knobs', () => {
  it('retryDelayMs reflects config base/max and the injected RNG', () => {
    const tracker = createLimitTracker({
      store: new InMemoryLimitCounterStore(),
      config: makeConfig({ transientRetryBaseMs: 500, transientRetryMaxMs: 4000 }),
      logger: silentLogger,
      random: () => 0.5 // jitter 1.0
    });
    expect(tracker.retryDelayMs(1)).toBe(500);
    expect(tracker.retryDelayMs(2)).toBe(1000);
    expect(tracker.retryDelayMs(3)).toBe(2000);
    expect(tracker.retryDelayMs(4)).toBe(4000); // 4000 raw, capped
    expect(tracker.retryDelayMs(5)).toBe(4000); // capped at max
  });

  it('transientRetryMaxAttempts reflects config', () => {
    const tracker = createLimitTracker({
      store: new InMemoryLimitCounterStore(),
      config: makeConfig({ transientRetryMaxAttempts: 7 }),
      logger: silentLogger
    });
    expect(tracker.transientRetryMaxAttempts()).toBe(7);
  });

  it('close() delegates to store.close when present', async () => {
    let closed = false;
    const store: LimitCounterStore = {
      async acquireOutboundSlot() {
        return 0;
      },
      async incrementWindowCounters() {
        return { hourCount: 0, dayCount: 0 };
      },
      async close() {
        closed = true;
      }
    };
    const tracker = createLimitTracker({ store, config: makeConfig(), logger: silentLogger });
    await tracker.close?.();
    expect(closed).toBe(true);
  });
});
