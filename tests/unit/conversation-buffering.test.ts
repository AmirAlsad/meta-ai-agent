/**
 * Unit tests for the Stage 5 buffer timer math (`calculateBufferTimeout`).
 *
 * Covers the growth curve, the hard cap, the jitter band clamp, and the
 * no-jitter (deviation 0) short-circuit. All jitter cases inject a deterministic
 * `random` so assertions are exact.
 */
import { describe, expect, it } from 'vitest';
import { defaultConversationConfig, type ConversationConfig } from '../../src/config/loader.js';
import { calculateBufferTimeout } from '../../src/conversation/buffering.js';

/** Buffer-only knobs with deviation forced off, for deterministic math. */
function noJitterConfig(
  overrides?: Partial<Pick<ConversationConfig, 'bufferBaseTimeoutMs' | 'bufferGrowthFactor' | 'bufferMaxTimeoutMs'>>
): Pick<
  ConversationConfig,
  'bufferBaseTimeoutMs' | 'bufferGrowthFactor' | 'bufferMaxTimeoutMs' | 'bufferNoiseMaxDeviation'
> {
  return {
    bufferBaseTimeoutMs: 2000,
    bufferGrowthFactor: 1.25,
    bufferMaxTimeoutMs: 8000,
    bufferNoiseMaxDeviation: 0,
    ...overrides
  };
}

describe('calculateBufferTimeout', () => {
  it('returns exactly the base for the first message when deviation is 0', () => {
    expect(calculateBufferTimeout(1, noJitterConfig())).toBe(2000);
  });

  it('grows the timeout as the burst continues', () => {
    const config = noJitterConfig();
    const t1 = calculateBufferTimeout(1, config);
    const t2 = calculateBufferTimeout(2, config);
    const t3 = calculateBufferTimeout(3, config);
    expect(t2).toBeGreaterThan(t1);
    expect(t3).toBeGreaterThan(t2);
    // base * growth^(count-1): 2000, 2500, 3125, ...
    expect(t2).toBe(2500);
    expect(t3).toBe(Math.round(2000 * 1.25 ** 2));
  });

  it('caps growth at the configured max (without noise)', () => {
    const config = noJitterConfig();
    // A very high count would explode past the max without the cap.
    expect(calculateBufferTimeout(50, config)).toBe(8000);
  });

  it('never exceeds max*1.5 even with maximal positive noise', () => {
    const config = noJitterConfig({}); // start from clean knobs
    const withNoise = { ...config, bufferNoiseMaxDeviation: 0.3 };
    // random()===1 -> +full noise range on the capped value (=max).
    // capped + noise = 8000 + (8000*0.3) = 10400, which is under the max*1.5
    // (12000) ceiling, so jitter alone can't break the clamp at this deviation.
    const value = calculateBufferTimeout(50, withNoise, () => 1);
    expect(value).toBeLessThanOrEqual(8000 * 1.5);
    expect(value).toBe(10400);
  });

  it('clamps to exactly max*1.5 when noise would push past the ceiling', () => {
    // A deviation > 0.5 makes the positive noise large enough to exceed max*1.5,
    // proving the upper clamp actually fires: capped(8000) + 8000*0.75 = 14000,
    // clamped down to 8000*1.5 = 12000.
    const config = { ...noJitterConfig(), bufferNoiseMaxDeviation: 0.75 };
    expect(calculateBufferTimeout(50, config, () => 1)).toBe(8000 * 1.5);
  });

  it('never drops below base*0.5 with maximal negative noise', () => {
    const config = { ...noJitterConfig(), bufferNoiseMaxDeviation: 0.3 };
    // random()===0 -> -full noise range on the first (smallest) timeout.
    const value = calculateBufferTimeout(1, config, () => 0);
    expect(value).toBeGreaterThanOrEqual(2000 * 0.5);
  });

  it('jitters within [base*0.5, max*1.5] and differs from the no-noise value', () => {
    const base = noJitterConfig();
    const withNoise = { ...base, bufferNoiseMaxDeviation: 0.3 };
    const plain = calculateBufferTimeout(2, base); // 2500, no jitter

    const high = calculateBufferTimeout(2, withNoise, () => 1); // +noise
    const low = calculateBufferTimeout(2, withNoise, () => 0); // -noise

    for (const v of [high, low]) {
      expect(v).toBeGreaterThanOrEqual(2000 * 0.5);
      expect(v).toBeLessThanOrEqual(8000 * 1.5);
    }
    expect(high).not.toBe(plain);
    expect(low).not.toBe(plain);
    expect(high).toBeGreaterThan(plain);
    expect(low).toBeLessThan(plain);
  });

  it('applies zero net jitter when random() is 0.5 (equals the capped value)', () => {
    const config = { ...noJitterConfig(), bufferNoiseMaxDeviation: 0.3 };
    // random()===0.5 -> (0.5*2 - 1) === 0 -> no net noise.
    expect(calculateBufferTimeout(2, config, () => 0.5)).toBe(2500);
    // Also holds at the cap.
    expect(calculateBufferTimeout(50, config, () => 0.5)).toBe(8000);
  });

  it('deviation 0 is deterministic regardless of random (no jitter path)', () => {
    const config = noJitterConfig();
    // random is irrelevant when deviation is 0: must equal the rounded cap math.
    expect(calculateBufferTimeout(2, config, () => 0)).toBe(2500);
    expect(calculateBufferTimeout(2, config, () => 1)).toBe(2500);
  });

  it('works with the documented production defaults', () => {
    const config = defaultConversationConfig();
    const first = calculateBufferTimeout(1, config, () => 0.5); // net-zero jitter
    expect(first).toBe(config.bufferBaseTimeoutMs);
  });
});
