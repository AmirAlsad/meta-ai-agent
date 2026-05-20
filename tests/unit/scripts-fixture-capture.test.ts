/**
 * Unit tests for the `fixture-capture.ts` filename-derivation helper.
 *
 * The bulk of the capture flow is exercised end-to-end via the
 * `scripts-capture-server.test.ts` suite (which boots a real Express
 * listener). This file pins down the pure name-derivation logic so a
 * one-line edit to the filename template surfaces here, not in a hard-to-
 * read snapshot.
 */
import { describe, expect, it } from 'vitest';
import type {
  IncomingMessage,
  ParseResult,
  StatusUpdate
} from '../../src/meta/types.js';
import type { CapturedWebhook } from '../../scripts/lib/capture-server.js';
import { deriveFilename, parseFlags } from '../../scripts/capture/fixture-capture.js';

const RECEIVED_AT = Date.UTC(2026, 0, 15, 12, 30, 45, 678); // 2026-01-15T12:30:45.678Z

function makeCap(overrides: Partial<CapturedWebhook> & { parsed: ParseResult }): CapturedWebhook {
  return {
    receivedAt: RECEIVED_AT,
    channelHint: 'whatsapp',
    rawBody: {},
    signatureValid: true,
    headers: {},
    ...overrides
  };
}

function msg(type: IncomingMessage['type']): IncomingMessage {
  return {
    channel: 'whatsapp',
    channelMessageId: 'wamid.test',
    channelScopedUserId: '15551234567',
    channelScopedBusinessId: '15559876543',
    timestamp: 1716000000000,
    type,
    raw: {}
  };
}

function status(s: StatusUpdate['status']): StatusUpdate {
  return {
    channel: 'whatsapp',
    channelMessageId: 'wamid.test',
    channelScopedBusinessId: '15559876543',
    status: s,
    timestamp: 1716000000000,
    raw: {}
  };
}

describe('deriveFilename', () => {
  it('uses the first message type for the type segment', () => {
    const name = deriveFilename(
      makeCap({ parsed: { messages: [msg('text')], statuses: [] } })
    );
    expect(name).toBe('2026-01-15T12-30-45-678Z-whatsapp-text.json');
  });

  it('uses the first status when there are no messages', () => {
    const name = deriveFilename(
      makeCap({
        channelHint: 'whatsapp',
        parsed: { messages: [], statuses: [status('read')] }
      })
    );
    expect(name).toBe('2026-01-15T12-30-45-678Z-whatsapp-read.json');
  });

  it('falls back to "envelope" when both messages and statuses are empty', () => {
    const name = deriveFilename(
      makeCap({
        channelHint: 'unknown',
        parsed: { messages: [], statuses: [] }
      })
    );
    expect(name).toBe('2026-01-15T12-30-45-678Z-unknown-envelope.json');
  });

  it('encodes the channelHint into the filename', () => {
    const igMsg: IncomingMessage = { ...msg('image'), channel: 'instagram' };
    const name = deriveFilename(
      makeCap({
        channelHint: 'instagram',
        parsed: { messages: [igMsg], statuses: [] }
      })
    );
    expect(name).toBe('2026-01-15T12-30-45-678Z-instagram-image.json');
  });

  it('prefers messages over statuses when both are present (filename is a navigational aid, not a manifest)', () => {
    const name = deriveFilename(
      makeCap({
        parsed: { messages: [msg('reaction')], statuses: [status('sent')] }
      })
    );
    // The first message type wins; the status is recoverable from the body.
    expect(name).toBe('2026-01-15T12-30-45-678Z-whatsapp-reaction.json');
  });

  it('sanitizes channel + type segments to filesystem-safe characters', () => {
    const name = deriveFilename(
      makeCap({
        // `messenger` is already safe, but we coerce a type with funky chars
        // to make sure the sanitizer is reached.
        channelHint: 'messenger',
        parsed: {
          messages: [{ ...msg('text'), type: 'weird/type:with*chars' as IncomingMessage['type'] }],
          statuses: []
        }
      })
    );
    expect(name).toMatch(/^2026-01-15T12-30-45-678Z-messenger-[a-zA-Z0-9_-]+\.json$/);
    expect(name).not.toContain('/');
    expect(name).not.toContain(':');
    expect(name).not.toContain('*');
  });
});

describe('parseFlags', () => {
  it('returns sane defaults for an empty arg list', () => {
    expect(parseFlags([])).toEqual({
      help: false,
      port: undefined,
      ngrokDomain: undefined,
      capturesDir: undefined,
      acceptInvalidSignatures: false,
      noWebhookRegistration: false
    });
  });

  it('parses all flags', () => {
    const flags = parseFlags([
      '--port=4242',
      '--ngrok-domain=foo.ngrok-free.app',
      '--captures-dir=/tmp/captures',
      '--accept-invalid-signatures',
      '--no-webhook-registration'
    ]);
    expect(flags).toEqual({
      help: false,
      port: 4242,
      ngrokDomain: 'foo.ngrok-free.app',
      capturesDir: '/tmp/captures',
      acceptInvalidSignatures: true,
      noWebhookRegistration: true
    });
  });

  it('throws on unknown flags', () => {
    expect(() => parseFlags(['--bogus'])).toThrow(/Unknown flag/);
  });

  it('rejects invalid port values', () => {
    expect(() => parseFlags(['--port=abc'])).toThrow(/Invalid --port/);
    expect(() => parseFlags(['--port=0'])).toThrow(/Invalid --port/);
    expect(() => parseFlags(['--port=70000'])).toThrow(/Invalid --port/);
  });
});
