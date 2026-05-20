/**
 * Unit tests for the pure helpers in scripts/setup/verify-shared.ts.
 *
 * The verify scripts themselves are inherently manual (real ngrok tunnel,
 * real Meta API, real human interaction), so we deliberately focus on the
 * boring-but-load-bearing pieces:
 *   - argument parsing (every flag combination + invalid input)
 *   - predicate functions that classify a CapturedWebhook
 *   - summary formatter
 *
 * Fixtures live in tests/fixtures/meta/{channel}/ and are fed through
 * parseMetaWebhook to construct realistic CapturedWebhook objects without
 * booting an Express server.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  parseVerifyArgs,
  printVerifySummary,
  isInboundTextMessage,
  isInboundReaction,
  isOutboundStatus,
  VerifyResultBuilder,
  type ChannelVerifyResult
} from '../../scripts/setup/verify-shared.js';
import { parseMetaWebhook } from '../../src/meta/parser.js';
import type { CapturedWebhook } from '../../scripts/lib/capture-server.js';

/* ────────────────────────────────────────────────────────────────────────── */
/* Fixtures                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

const FIXTURE_ROOT = path.resolve(process.cwd(), 'tests/fixtures/meta');

function loadFixture(channel: 'whatsapp' | 'messenger' | 'instagram', name: string): unknown {
  const file = path.join(FIXTURE_ROOT, channel, `${name}.json`);
  return JSON.parse(readFileSync(file, 'utf8')) as unknown;
}

function captureFromFixture(
  channel: 'whatsapp' | 'messenger' | 'instagram' | 'unknown',
  rawBody: unknown,
  signatureValid: boolean = true
): CapturedWebhook {
  return {
    receivedAt: Date.now(),
    channelHint: channel,
    rawBody,
    parsed: parseMetaWebhook(rawBody),
    signatureValid,
    headers: { 'content-type': 'application/json' }
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* parseVerifyArgs                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

describe('parseVerifyArgs', () => {
  it('returns sensible defaults on empty argv', () => {
    const parsed = parseVerifyArgs([]);
    expect(parsed.channels).toEqual([]);
    expect(parsed.skipWebhookRegistration).toBe(false);
    expect(parsed.skipOutbound).toBe(false);
    expect(parsed.acceptInvalidSignatures).toBe(false);
    expect(parsed.help).toBe(false);
    expect(parsed.port).toBeGreaterThan(0);
    expect(parsed.ngrokDomain).toBeUndefined();
  });

  it('parses --channels=whatsapp,messenger', () => {
    const parsed = parseVerifyArgs(['--channels=whatsapp,messenger']);
    expect(parsed.channels).toEqual(['whatsapp', 'messenger']);
  });

  it('de-duplicates repeated channels', () => {
    const parsed = parseVerifyArgs(['--channels=whatsapp,whatsapp,messenger']);
    expect(parsed.channels).toEqual(['whatsapp', 'messenger']);
  });

  it('rejects unknown channel values', () => {
    expect(() => parseVerifyArgs(['--channels=tiktok'])).toThrow(/unknown channel/i);
  });

  it('rejects an empty --channels list', () => {
    expect(() => parseVerifyArgs(['--channels='])).toThrow(/requires at least one value/);
  });

  it('sets skipWebhookRegistration with --skip-webhook-registration', () => {
    const parsed = parseVerifyArgs(['--skip-webhook-registration']);
    expect(parsed.skipWebhookRegistration).toBe(true);
  });

  it('sets skipOutbound with --skip-outbound', () => {
    const parsed = parseVerifyArgs(['--skip-outbound']);
    expect(parsed.skipOutbound).toBe(true);
  });

  it('parses --port=4000', () => {
    const parsed = parseVerifyArgs(['--port=4000']);
    expect(parsed.port).toBe(4000);
  });

  it('rejects --port=0 or --port=70000', () => {
    expect(() => parseVerifyArgs(['--port=0'])).toThrow(/expected integer 1.*65535/);
    expect(() => parseVerifyArgs(['--port=70000'])).toThrow(/expected integer 1.*65535/);
  });

  it('rejects --port=foo (non-numeric)', () => {
    expect(() => parseVerifyArgs(['--port=foo'])).toThrow(/expected integer/);
  });

  it('parses --ngrok-domain=foo.ngrok.app', () => {
    const parsed = parseVerifyArgs(['--ngrok-domain=foo.ngrok-free.app']);
    expect(parsed.ngrokDomain).toBe('foo.ngrok-free.app');
  });

  it('rejects an empty --ngrok-domain', () => {
    expect(() => parseVerifyArgs(['--ngrok-domain='])).toThrow(/requires a value/);
  });

  it('sets acceptInvalidSignatures with --accept-invalid-signatures', () => {
    const parsed = parseVerifyArgs(['--accept-invalid-signatures']);
    expect(parsed.acceptInvalidSignatures).toBe(true);
  });

  it('sets help with --help and -h', () => {
    expect(parseVerifyArgs(['--help']).help).toBe(true);
    expect(parseVerifyArgs(['-h']).help).toBe(true);
  });

  it('throws on unknown flag', () => {
    expect(() => parseVerifyArgs(['--made-up-flag'])).toThrow(/Unknown flag/);
  });

  it('composes multiple flags', () => {
    const parsed = parseVerifyArgs([
      '--channels=instagram',
      '--skip-webhook-registration',
      '--skip-outbound',
      '--port=4123',
      '--ngrok-domain=verify.ngrok.app',
      '--accept-invalid-signatures'
    ]);
    expect(parsed.channels).toEqual(['instagram']);
    expect(parsed.skipWebhookRegistration).toBe(true);
    expect(parsed.skipOutbound).toBe(true);
    expect(parsed.port).toBe(4123);
    expect(parsed.ngrokDomain).toBe('verify.ngrok.app');
    expect(parsed.acceptInvalidSignatures).toBe(true);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Predicates                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

describe('isInboundTextMessage', () => {
  it('matches a WhatsApp text-inbound fixture', () => {
    const cap = captureFromFixture('whatsapp', loadFixture('whatsapp', 'text-inbound'));
    expect(isInboundTextMessage(cap, 'whatsapp')).toBe(true);
  });

  it('matches a Messenger text-message fixture', () => {
    const cap = captureFromFixture('messenger', loadFixture('messenger', 'text-message'));
    expect(isInboundTextMessage(cap, 'messenger')).toBe(true);
  });

  it('matches an Instagram text-dm fixture', () => {
    const cap = captureFromFixture('instagram', loadFixture('instagram', 'text-dm'));
    expect(isInboundTextMessage(cap, 'instagram')).toBe(true);
  });

  it('does NOT match across channels (wa text -> messenger check)', () => {
    const cap = captureFromFixture('whatsapp', loadFixture('whatsapp', 'text-inbound'));
    expect(isInboundTextMessage(cap, 'messenger')).toBe(false);
    expect(isInboundTextMessage(cap, 'instagram')).toBe(false);
  });

  it('does NOT match a reaction event as a text message', () => {
    const cap = captureFromFixture('whatsapp', loadFixture('whatsapp', 'reaction'));
    expect(isInboundTextMessage(cap, 'whatsapp')).toBe(false);
  });

  it('does NOT match an echo (business-side outbound mirrored back)', () => {
    const cap = captureFromFixture('messenger', loadFixture('messenger', 'echo'));
    expect(isInboundTextMessage(cap, 'messenger')).toBe(false);
  });

  it('does NOT match a WhatsApp status-only payload', () => {
    const cap = captureFromFixture('whatsapp', loadFixture('whatsapp', 'status-delivered'));
    expect(isInboundTextMessage(cap, 'whatsapp')).toBe(false);
  });
});

describe('isInboundReaction', () => {
  it('matches a WhatsApp reaction fixture', () => {
    const cap = captureFromFixture('whatsapp', loadFixture('whatsapp', 'reaction'));
    expect(isInboundReaction(cap, 'whatsapp')).toBe(true);
  });

  it('matches a Messenger reaction fixture', () => {
    const cap = captureFromFixture('messenger', loadFixture('messenger', 'reaction'));
    expect(isInboundReaction(cap, 'messenger')).toBe(true);
  });

  it('matches an Instagram reaction fixture', () => {
    const cap = captureFromFixture('instagram', loadFixture('instagram', 'reaction'));
    expect(isInboundReaction(cap, 'instagram')).toBe(true);
  });

  it('does NOT match a plain text inbound', () => {
    const cap = captureFromFixture('whatsapp', loadFixture('whatsapp', 'text-inbound'));
    expect(isInboundReaction(cap, 'whatsapp')).toBe(false);
  });
});

describe('isOutboundStatus', () => {
  it('matches a WhatsApp status-delivered fixture', () => {
    const cap = captureFromFixture('whatsapp', loadFixture('whatsapp', 'status-delivered'));
    expect(isOutboundStatus(cap, 'whatsapp')).toBe(true);
  });

  it('matches a Messenger delivery fixture', () => {
    const cap = captureFromFixture('messenger', loadFixture('messenger', 'delivery'));
    expect(isOutboundStatus(cap, 'messenger')).toBe(true);
  });

  it('does NOT match a plain text inbound', () => {
    const cap = captureFromFixture('whatsapp', loadFixture('whatsapp', 'text-inbound'));
    expect(isOutboundStatus(cap, 'whatsapp')).toBe(false);
  });

  it('does NOT match across channels', () => {
    const cap = captureFromFixture('whatsapp', loadFixture('whatsapp', 'status-delivered'));
    expect(isOutboundStatus(cap, 'messenger')).toBe(false);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* printVerifySummary                                                         */
/* ────────────────────────────────────────────────────────────────────────── */

describe('printVerifySummary', () => {
  function captureStdout(fn: () => void): string {
    const chunks: string[] = [];
    // process.stdout.write has multiple overloads (cb-style + plain). We
    // cast through `unknown` to avoid having to redeclare every signature
    // here; the call sites all pass a single string anyway.
    const spy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((value: string | Uint8Array) => {
        chunks.push(typeof value === 'string' ? value : Buffer.from(value).toString('utf8'));
        return true;
      }) as unknown as typeof process.stdout.write);
    try {
      fn();
    } finally {
      spy.mockRestore();
    }
    return chunks.join('');
  }

  it('renders a single passing channel summary', () => {
    const result: ChannelVerifyResult = {
      channel: 'whatsapp',
      ok: true,
      steps: [
        { name: 'config', status: 'pass' },
        { name: 'token', status: 'pass', detail: 'display_phone_number=15551234567' }
      ]
    };
    const out = captureStdout(() => printVerifySummary([result]));
    expect(out).toContain('WHATSAPP');
    expect(out).toContain('PASS');
    expect(out).toContain('config');
    expect(out).toContain('token');
    expect(out).toContain('display_phone_number=15551234567');
    expect(out).toContain('All channels verified');
  });

  it('renders a mixed pass/fail/skip step list', () => {
    const result: ChannelVerifyResult = {
      channel: 'instagram',
      ok: false,
      steps: [
        { name: 'config', status: 'pass' },
        { name: 'token', status: 'pass' },
        { name: 'webhook', status: 'fail', detail: 'No instagram subscription' },
        { name: 'allow-access', status: 'skip', detail: 'User did not confirm' }
      ]
    };
    const out = captureStdout(() => printVerifySummary([result]));
    expect(out).toContain('INSTAGRAM');
    expect(out).toContain('FAIL');
    expect(out).toContain('webhook');
    expect(out).toContain('No instagram subscription');
    expect(out).toContain('allow-access');
    expect(out).toContain('One or more channels failed');
  });

  it('renders multiple channel results in order', () => {
    const results: ChannelVerifyResult[] = [
      {
        channel: 'whatsapp',
        ok: true,
        steps: [{ name: 'config', status: 'pass' }]
      },
      {
        channel: 'messenger',
        ok: false,
        steps: [{ name: 'token', status: 'fail', detail: 'invalid' }]
      }
    ];
    const out = captureStdout(() => printVerifySummary(results));
    expect(out.indexOf('WHATSAPP')).toBeLessThan(out.indexOf('MESSENGER'));
    expect(out).toContain('One or more channels failed');
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* VerifyResultBuilder                                                        */
/* ────────────────────────────────────────────────────────────────────────── */

describe('VerifyResultBuilder', () => {
  it('accumulates pass/skip steps and reports ok=true', () => {
    const builder = new VerifyResultBuilder('whatsapp');
    builder.pass('config');
    builder.pass('token', 'display_phone_number=15551234567');
    builder.skip('outbound', 'no test number set');
    const result = builder.build();
    expect(result.channel).toBe('whatsapp');
    expect(result.ok).toBe(true);
    expect(result.steps).toHaveLength(3);
    expect(result.steps[1]?.detail).toBe('display_phone_number=15551234567');
  });

  it('reports ok=false if any step failed', () => {
    const builder = new VerifyResultBuilder('messenger');
    builder.pass('config');
    builder.fail('token', 'HTTP 401');
    builder.pass('webhook');
    const result = builder.build();
    expect(result.ok).toBe(false);
    expect(result.steps.find((s) => s.status === 'fail')?.detail).toBe('HTTP 401');
  });
});
