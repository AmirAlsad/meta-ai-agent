/**
 * Unit coverage for the leaf error-codes module: the `whatsappFailureCategory`
 * display-bucket mapper and the source-of-truth code Sets it shares with the
 * retry classifier. The exhaustive matrix here guards against silent drift if a
 * code is moved between buckets.
 */
import { describe, expect, it } from 'vitest';
import {
  META_RATE_LIMIT_ERROR_CODES,
  WHATSAPP_WINDOW_ERROR_CODES,
  whatsappFailureCategory,
  type FailureCategory
} from '../../src/limits/error-codes.js';

describe('whatsappFailureCategory', () => {
  const cases: Array<{ code: number; expected: FailureCategory }> = [
    // window
    { code: 131047, expected: 'window_closed' },
    { code: 470, expected: 'window_closed' },
    // rate_limit
    { code: 4, expected: 'rate_limit' },
    { code: 80007, expected: 'rate_limit' },
    { code: 130429, expected: 'rate_limit' },
    { code: 131056, expected: 'rate_limit' },
    { code: 613, expected: 'rate_limit' },
    // policy
    { code: 131048, expected: 'policy' },
    { code: 131049, expected: 'policy' },
    { code: 368, expected: 'policy' },
    // unsupported
    { code: 131051, expected: 'unsupported' },
    // recipient
    { code: 131026, expected: 'recipient' },
    { code: 131030, expected: 'recipient' },
    { code: 131045, expected: 'recipient' },
    // auth
    { code: 190, expected: 'auth' },
    { code: 10, expected: 'auth' },
    { code: 200, expected: 'auth' },
    // server
    { code: 131000, expected: 'server' },
    { code: 1, expected: 'server' },
    { code: 2, expected: 'server' }
  ];

  for (const { code, expected } of cases) {
    it(`maps ${code} → ${expected}`, () => {
      expect(whatsappFailureCategory(code)).toBe(expected);
    });
  }

  it('maps undefined → unknown (a failed status with no diagnostic code)', () => {
    expect(whatsappFailureCategory(undefined)).toBe('unknown');
  });

  it('maps an unrecognized code → unknown (never throws on novel codes)', () => {
    expect(whatsappFailureCategory(999999)).toBe('unknown');
    expect(whatsappFailureCategory(0)).toBe('unknown');
  });
});

describe('error-code Sets (single source of truth)', () => {
  it('window and rate-limit Sets are disjoint (a code is never in both)', () => {
    for (const code of WHATSAPP_WINDOW_ERROR_CODES) {
      expect(META_RATE_LIMIT_ERROR_CODES.has(code)).toBe(false);
    }
  });

  it('every window code maps to window_closed via the mapper', () => {
    for (const code of WHATSAPP_WINDOW_ERROR_CODES) {
      expect(whatsappFailureCategory(code)).toBe('window_closed');
    }
  });

  it('every rate-limit code maps to rate_limit via the mapper', () => {
    for (const code of META_RATE_LIMIT_ERROR_CODES) {
      expect(whatsappFailureCategory(code)).toBe('rate_limit');
    }
  });
});
