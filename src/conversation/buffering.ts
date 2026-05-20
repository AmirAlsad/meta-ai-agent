import type { ConversationConfig } from '../config/loader.js';

/**
 * Buffer timeout grows with the number of messages already in the buffer
 * (longer pauses as a burst continues), capped at the max, with optional
 * jitter so flush timing isn't perfectly periodic. Pure + deterministic given
 * an injected `random`.
 *
 * Ported verbatim (math-wise) from the SendBlue reference
 * (`sendblue-ai-agent/src/conversation/buffering.ts`); the only adaptation is
 * reading the knobs from the nested {@link ConversationConfig} section rather
 * than a flat `AgentConfig`.
 *
 * @param messageCount Count of messages already buffered (1 for the first).
 * @param config Buffer timing knobs (base/growth/max/noise).
 * @param random Injectable [0,1) source for jitter; defaults to `Math.random`.
 */
export function calculateBufferTimeout(
  messageCount: number,
  config: Pick<
    ConversationConfig,
    'bufferBaseTimeoutMs' | 'bufferGrowthFactor' | 'bufferMaxTimeoutMs' | 'bufferNoiseMaxDeviation'
  >,
  random: () => number = Math.random
): number {
  const calculated = config.bufferBaseTimeoutMs * Math.pow(config.bufferGrowthFactor, messageCount - 1);
  const capped = Math.min(calculated, config.bufferMaxTimeoutMs);

  if (config.bufferNoiseMaxDeviation === 0 || capped === 0) return Math.round(capped);

  const noiseRange = capped * config.bufferNoiseMaxDeviation;
  const noise = (random() * 2 - 1) * noiseRange;
  // WHY clamp to [base*0.5, max*1.5]: jitter is applied around the capped value,
  // so on the low side it must never collapse the flush window below half the
  // base delay (which would defeat burst aggregation), and on the high side it
  // is allowed to overshoot the hard max by up to 50% — the cap bounds the
  // growth curve, not the jitter, so flushes still de-synchronize near the
  // ceiling instead of all firing at exactly `max`.
  const min = config.bufferBaseTimeoutMs * 0.5;
  const max = config.bufferMaxTimeoutMs * 1.5;

  return Math.round(Math.max(min, Math.min(capped + noise, max)));
}
