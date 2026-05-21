import { describe, expect, it } from 'vitest';
import { transientRetryDelayMs } from '../../src/limits/retry.js';

describe('transientRetryDelayMs', () => {
  // random()=>0.5 → jitter = 0.8 + 0.5*0.4 = 1.0 (no-op jitter), so the result
  // is exactly the un-jittered exponential schedule.
  const noJitter = () => 0.5;

  it('grows exponentially by powers of 2 (attempt 1-based)', () => {
    expect(transientRetryDelayMs(1, 1000, 60000, noJitter)).toBe(1000);
    expect(transientRetryDelayMs(2, 1000, 60000, noJitter)).toBe(2000);
    expect(transientRetryDelayMs(3, 1000, 60000, noJitter)).toBe(4000);
    expect(transientRetryDelayMs(4, 1000, 60000, noJitter)).toBe(8000);
    expect(transientRetryDelayMs(5, 1000, 60000, noJitter)).toBe(16000);
  });

  it('caps the raw value at maxMs', () => {
    // 1000 * 2^6 = 64000 > 60000 → capped at 60000.
    expect(transientRetryDelayMs(7, 1000, 60000, noJitter)).toBe(60000);
    expect(transientRetryDelayMs(20, 1000, 60000, noJitter)).toBe(60000);
  });

  it('applies the low jitter bound (random=0 → 0.8x)', () => {
    expect(transientRetryDelayMs(2, 1000, 60000, () => 0)).toBe(1600); // 2000 * 0.8
  });

  it('applies (just under) the high jitter bound and re-clamps to maxMs', () => {
    // random just under 1 → jitter just under 1.2.
    const almostOne = () => 0.999999;
    // attempt 2 = 2000 raw, *~1.2 ≈ 2400 (well under cap).
    expect(transientRetryDelayMs(2, 1000, 60000, almostOne)).toBe(2400);
    // attempt at the cap: raw=60000, *1.2 would be 72000 but re-clamped to maxMs.
    expect(transientRetryDelayMs(10, 1000, 60000, almostOne)).toBe(60000);
  });

  it('returns 0 for attempt < 1', () => {
    expect(transientRetryDelayMs(0, 1000, 60000, noJitter)).toBe(0);
    expect(transientRetryDelayMs(-3, 1000, 60000, noJitter)).toBe(0);
  });

  it('defaults random to Math.random and stays within the jitter window', () => {
    for (let i = 0; i < 50; i += 1) {
      const d = transientRetryDelayMs(3, 1000, 60000); // raw 4000
      expect(d).toBeGreaterThanOrEqual(Math.round(4000 * 0.8));
      expect(d).toBeLessThanOrEqual(Math.round(4000 * 1.2));
    }
  });
});
