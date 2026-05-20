/**
 * Unit tests for `guided-capture.ts` scenario lists, predicates, and the
 * scenario-wrapper helper.
 *
 * The scenario lists are exercised against real fixtures from
 * `tests/fixtures/meta/` so a parser regression on the load-bearing types
 * (text / image / reaction / replyTo / status:read / storyReply) fails
 * here too — keeping the corpus + walker tightly co-evolved.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  WHATSAPP_SCENARIOS,
  MESSENGER_SCENARIOS,
  INSTAGRAM_SCENARIOS,
  SCENARIOS_BY_CHANNEL,
  wrapForScenario,
  parseFlags,
  type CaptureScenario
} from '../../scripts/capture/guided-capture.js';
import { parseMetaWebhook } from '../../src/meta/parser.js';
import { objectToChannel } from '../../src/http/app.js';
import type { CapturedWebhook } from '../../scripts/lib/capture-server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXTURES_DIR = path.resolve(__dirname, '../fixtures/meta');

/* ────────────────────────────────────────────────────────────────────────── */
/* Fixture helpers                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

/** Load a fixture JSON, parse it, and build a synthetic CapturedWebhook. */
function capFromFixture(relPath: string): CapturedWebhook {
  const filePath = path.join(FIXTURES_DIR, relPath);
  const raw = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
  const objectField =
    raw !== null && typeof raw === 'object'
      ? (raw as { object?: unknown }).object
      : undefined;
  return {
    receivedAt: Date.UTC(2026, 0, 15, 12, 0, 0),
    channelHint: objectToChannel(objectField),
    rawBody: raw,
    parsed: parseMetaWebhook(raw),
    signatureValid: true,
    headers: {}
  };
}

function findScenario(scenarios: readonly CaptureScenario[], name: string): CaptureScenario {
  const found = scenarios.find((s) => s.name === name);
  if (!found) throw new Error(`Scenario "${name}" not in list. Have: ${scenarios.map((s) => s.name).join(', ')}`);
  return found;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Scenario list shape                                                        */
/* ────────────────────────────────────────────────────────────────────────── */

describe('scenario lists', () => {
  it('WhatsApp scenarios have the expected names in the expected order', () => {
    expect(WHATSAPP_SCENARIOS.map((s) => s.name)).toEqual([
      'text',
      'image',
      'audio-voice',
      'reaction',
      'reply-to',
      'status-read'
    ]);
  });

  it('Messenger scenarios have the expected names in the expected order', () => {
    expect(MESSENGER_SCENARIOS.map((s) => s.name)).toEqual([
      'text',
      'image',
      'reaction',
      'read'
    ]);
  });

  it('Instagram scenarios have the expected names in the expected order', () => {
    expect(INSTAGRAM_SCENARIOS.map((s) => s.name)).toEqual([
      'text-dm',
      'story-reply',
      'image',
      'reaction'
    ]);
  });

  it('SCENARIOS_BY_CHANNEL maps each channel to the right list', () => {
    expect(SCENARIOS_BY_CHANNEL.whatsapp).toBe(WHATSAPP_SCENARIOS);
    expect(SCENARIOS_BY_CHANNEL.messenger).toBe(MESSENGER_SCENARIOS);
    expect(SCENARIOS_BY_CHANNEL.instagram).toBe(INSTAGRAM_SCENARIOS);
  });

  it('scenario lists are frozen (cannot be mutated by callers at runtime)', () => {
    // Object.freeze + as const → push throws in strict mode (which vitest runs in).
    expect(() => {
      (WHATSAPP_SCENARIOS as unknown as CaptureScenario[]).push({
        name: 'oops',
        prompt: '',
        predicate: () => false
      });
    }).toThrow();
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* WhatsApp predicates                                                        */
/* ────────────────────────────────────────────────────────────────────────── */

describe('WhatsApp predicates', () => {
  it('text predicate matches a real text-inbound fixture', () => {
    const cap = capFromFixture('whatsapp/text-inbound.json');
    expect(findScenario(WHATSAPP_SCENARIOS, 'text').predicate(cap)).toBe(true);
    // And does NOT match a reaction.
    const reactionCap = capFromFixture('whatsapp/reaction.json');
    expect(findScenario(WHATSAPP_SCENARIOS, 'text').predicate(reactionCap)).toBe(false);
  });

  it('image predicate matches the image-inbound fixture', () => {
    const cap = capFromFixture('whatsapp/image-inbound.json');
    expect(findScenario(WHATSAPP_SCENARIOS, 'image').predicate(cap)).toBe(true);
  });

  it('audio-voice predicate matches the audio-voice-inbound fixture', () => {
    const cap = capFromFixture('whatsapp/audio-voice-inbound.json');
    expect(findScenario(WHATSAPP_SCENARIOS, 'audio-voice').predicate(cap)).toBe(true);
  });

  it('reaction predicate matches the WhatsApp reaction fixture', () => {
    const cap = capFromFixture('whatsapp/reaction.json');
    expect(findScenario(WHATSAPP_SCENARIOS, 'reaction').predicate(cap)).toBe(true);
    // And does NOT match a plain text inbound.
    const text = capFromFixture('whatsapp/text-inbound.json');
    expect(findScenario(WHATSAPP_SCENARIOS, 'reaction').predicate(text)).toBe(false);
  });

  it('reply-to predicate matches a WhatsApp reply (context.message_id) fixture', () => {
    const cap = capFromFixture('whatsapp/reply-to-text.json');
    expect(findScenario(WHATSAPP_SCENARIOS, 'reply-to').predicate(cap)).toBe(true);
  });

  it('status-read predicate matches the status-read fixture', () => {
    const cap = capFromFixture('whatsapp/status-read.json');
    expect(findScenario(WHATSAPP_SCENARIOS, 'status-read').predicate(cap)).toBe(true);
    // And does NOT match a delivery status (`status: "delivered"`).
    const delivered = capFromFixture('whatsapp/status-delivered.json');
    expect(findScenario(WHATSAPP_SCENARIOS, 'status-read').predicate(delivered)).toBe(false);
  });

  it('predicates reject captures from the wrong channel even when type matches', () => {
    // A Messenger text capture should NOT trip the WhatsApp text predicate
    // because the channelHint guard runs first.
    const msgr = capFromFixture('messenger/text-message.json');
    expect(findScenario(WHATSAPP_SCENARIOS, 'text').predicate(msgr)).toBe(false);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Messenger predicates                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

describe('Messenger predicates', () => {
  it('text predicate matches the text-message fixture', () => {
    const cap = capFromFixture('messenger/text-message.json');
    expect(findScenario(MESSENGER_SCENARIOS, 'text').predicate(cap)).toBe(true);
  });

  it('image predicate matches the image-attachment fixture', () => {
    const cap = capFromFixture('messenger/image-attachment.json');
    expect(findScenario(MESSENGER_SCENARIOS, 'image').predicate(cap)).toBe(true);
  });

  it('reaction predicate matches the reaction fixture', () => {
    const cap = capFromFixture('messenger/reaction.json');
    expect(findScenario(MESSENGER_SCENARIOS, 'reaction').predicate(cap)).toBe(true);
  });

  it('read predicate matches the message-read fixture', () => {
    const cap = capFromFixture('messenger/message-read.json');
    expect(findScenario(MESSENGER_SCENARIOS, 'read').predicate(cap)).toBe(true);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Instagram predicates                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

describe('Instagram predicates', () => {
  it('text-dm predicate matches the text-dm fixture', () => {
    const cap = capFromFixture('instagram/text-dm.json');
    expect(findScenario(INSTAGRAM_SCENARIOS, 'text-dm').predicate(cap)).toBe(true);
  });

  it('story-reply predicate matches the story-reply fixture', () => {
    const cap = capFromFixture('instagram/story-reply.json');
    expect(findScenario(INSTAGRAM_SCENARIOS, 'story-reply').predicate(cap)).toBe(true);
    // text-dm should NOT match story-reply, even though both contain a text
    // body (the parser splits storyReply into a distinct field).
    const text = capFromFixture('instagram/text-dm.json');
    expect(findScenario(INSTAGRAM_SCENARIOS, 'story-reply').predicate(text)).toBe(false);
  });

  it('image predicate matches the image-attachment fixture', () => {
    const cap = capFromFixture('instagram/image-attachment.json');
    expect(findScenario(INSTAGRAM_SCENARIOS, 'image').predicate(cap)).toBe(true);
  });

  it('reaction predicate matches the reaction fixture', () => {
    const cap = capFromFixture('instagram/reaction.json');
    expect(findScenario(INSTAGRAM_SCENARIOS, 'reaction').predicate(cap)).toBe(true);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* wrapForScenario                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

describe('wrapForScenario', () => {
  it('produces the documented scenario-annotation wrapper without polluting rawBody', () => {
    const cap = capFromFixture('whatsapp/text-inbound.json');
    const wrapped = wrapForScenario(cap, 'text');
    expect(wrapped._scenario).toBe('text');
    expect(wrapped._channel).toBe('whatsapp');
    expect(wrapped._signatureValid).toBe(true);
    expect(typeof wrapped._capturedAt).toBe('string');
    // ISO-8601 with millis.
    expect(wrapped._capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // rawBody is bit-faithful to what would have arrived from Meta — no `_`
    // prefixed annotations leaking into the body.
    const body = wrapped.rawBody as { object?: unknown };
    expect(body.object).toBe('whatsapp_business_account');
    expect((body as Record<string, unknown>)._scenario).toBeUndefined();
    expect((body as Record<string, unknown>)._channel).toBeUndefined();
  });

  it('round-trips through JSON.stringify with the expected structure', () => {
    const cap = capFromFixture('messenger/reaction.json');
    const wrapped = wrapForScenario(cap, 'reaction');
    const json = JSON.parse(JSON.stringify(wrapped)) as Record<string, unknown>;
    // The five top-level fields are exactly: _scenario, _capturedAt,
    // _channel, _signatureValid, rawBody. Any new sibling needs a
    // documentation update.
    expect(Object.keys(json).sort()).toEqual(
      ['_capturedAt', '_channel', '_scenario', '_signatureValid', 'rawBody'].sort()
    );
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* CLI flags                                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

describe('parseFlags', () => {
  it('parses --channel and --scenarios', () => {
    const flags = parseFlags(['--channel=whatsapp', '--scenarios=text,image']);
    expect(flags.channel).toBe('whatsapp');
    expect(flags.scenarios).toEqual(['text', 'image']);
  });

  it('accepts --channel=all', () => {
    expect(parseFlags(['--channel=all']).channel).toBe('all');
  });

  it('rejects invalid channel values', () => {
    expect(() => parseFlags(['--channel=unknown'])).toThrow(/Invalid --channel/);
  });

  it('rejects unknown flags', () => {
    expect(() => parseFlags(['--bogus'])).toThrow(/Unknown flag/);
  });
});
