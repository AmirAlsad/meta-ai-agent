import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  parseInstagramWebhook,
  parseMessengerWebhook,
  parseMetaWebhook,
  parseWhatsAppWebhook
} from '../../src/meta/parser.js';
import type { Channel } from '../../src/meta/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(here, '../fixtures/meta');

function loadFixture(channel: Channel, name: string): unknown {
  const raw = readFileSync(path.join(fixturesDir, channel, name), 'utf8');
  return JSON.parse(raw);
}

describe('parseMetaWebhook (dispatcher)', () => {
  it('routes whatsapp_business_account payloads to the WhatsApp parser', () => {
    const payload = loadFixture('whatsapp', 'text-inbound.json');
    expect(parseMetaWebhook(payload)).toEqual(parseWhatsAppWebhook(payload));
  });

  it('routes page payloads to the Messenger parser', () => {
    const payload = loadFixture('messenger', 'text-message.json');
    expect(parseMetaWebhook(payload)).toEqual(parseMessengerWebhook(payload));
  });

  it('routes instagram payloads to the Instagram parser', () => {
    const payload = loadFixture('instagram', 'text-dm.json');
    expect(parseMetaWebhook(payload)).toEqual(parseInstagramWebhook(payload));
  });

  it('returns an empty result for unknown object discriminators without throwing', () => {
    expect(parseMetaWebhook({ object: 'unknown', entry: [] })).toEqual({
      messages: [],
      statuses: []
    });
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['number', 42],
    ['string', 'string'],
    ['empty object', {}],
    ['array', [{ object: 'page' }]]
  ])('returns an empty result for non-routable input (%s)', (_label, input) => {
    expect(parseMetaWebhook(input)).toEqual({ messages: [], statuses: [] });
  });
});

describe('parseWhatsAppWebhook', () => {
  it('parses a text inbound into a normalized text IncomingMessage', () => {
    const result = parseWhatsAppWebhook(loadFixture('whatsapp', 'text-inbound.json'));

    expect(result.statuses).toEqual([]);
    expect(result.messages).toHaveLength(1);
    const msg = result.messages[0]!;
    expect(msg).toEqual(
      expect.objectContaining({
        channel: 'whatsapp',
        channelMessageId:
          'wamid.HBgLMTU1NTc2NTQzMjEVAgASGBQzQTAwMDAwMDAwMDAwMDAwMDAwMQA=',
        channelScopedUserId: '15557654321',
        channelScopedBusinessId: '200000000000002',
        type: 'text',
        text: 'Hello from WhatsApp'
      })
    );
    expect(msg.timestamp).toBe(1716000000 * 1000);
  });

  it('parses an image inbound with media id, mimeType, and sha256', () => {
    const result = parseWhatsAppWebhook(loadFixture('whatsapp', 'image-inbound.json'));

    expect(result.messages).toHaveLength(1);
    const msg = result.messages[0]!;
    expect(msg.type).toBe('image');
    expect(msg.text).toBeUndefined();
    expect(msg.media).toEqual(
      expect.objectContaining({
        id: '300000000000003',
        mimeType: 'image/jpeg',
        sha256:
          'abc123def4567890abc123def4567890abc123def4567890abc123def4567890',
        caption: 'Look at this'
      })
    );
  });

  it('parses an audio voice-note inbound with voice=true', () => {
    const result = parseWhatsAppWebhook(loadFixture('whatsapp', 'audio-voice-inbound.json'));

    expect(result.messages).toHaveLength(1);
    const msg = result.messages[0]!;
    expect(msg.type).toBe('audio');
    expect(msg.media?.voice).toBe(true);
    expect(msg.media?.id).toBe('300000000000005');
    expect(msg.media?.mimeType).toBe('audio/ogg; codecs=opus');
  });

  it('parses a document inbound with filename and mimeType', () => {
    const result = parseWhatsAppWebhook(loadFixture('whatsapp', 'document-inbound.json'));

    expect(result.messages).toHaveLength(1);
    const msg = result.messages[0]!;
    expect(msg.type).toBe('document');
    expect(msg.media?.filename).toBe('quarterly-report.pdf');
    expect(msg.media?.mimeType).toBe('application/pdf');
  });

  it('parses a location inbound and surfaces the name as text', () => {
    const result = parseWhatsAppWebhook(loadFixture('whatsapp', 'location-inbound.json'));

    expect(result.messages).toHaveLength(1);
    const msg = result.messages[0]!;
    expect(msg.type).toBe('location');
    expect(msg.text).toBe('Ferry Building');
  });

  it('parses a reaction inbound with emoji and targetMessageId', () => {
    const result = parseWhatsAppWebhook(loadFixture('whatsapp', 'reaction.json'));

    expect(result.messages).toHaveLength(1);
    const msg = result.messages[0]!;
    expect(msg.type).toBe('reaction');
    expect(msg.reaction).toEqual({
      emoji: '❤️',
      targetMessageId:
        'wamid.HBgLMTU1NTc2NTQzMjEVAgASGBQzQTAwMDAwMDAwMDAwMDAwMDAxAA='
    });
  });

  it('parses an interactive button reply and lifts the title into text', () => {
    const result = parseWhatsAppWebhook(loadFixture('whatsapp', 'interactive-button-reply.json'));

    expect(result.messages).toHaveLength(1);
    const msg = result.messages[0]!;
    expect(msg.type).toBe('interactive');
    expect(msg.text).toBe('Yes, confirm');
  });

  it('parses a reply-to text and populates replyTo from context.message_id', () => {
    const result = parseWhatsAppWebhook(loadFixture('whatsapp', 'reply-to-text.json'));

    expect(result.messages).toHaveLength(1);
    const msg = result.messages[0]!;
    expect(msg.text).toBe("Yes, that's correct");
    expect(msg.replyTo).toBe(
      'wamid.HBgLMTU1NTc2NTQzMjEVAgASGBQzQTAwMDAwMDAwMDAwMDAwMDAwAA='
    );
  });

  it('emits a delivered StatusUpdate from a status payload (no inbound messages)', () => {
    const result = parseWhatsAppWebhook(loadFixture('whatsapp', 'status-delivered.json'));

    expect(result.messages).toEqual([]);
    expect(result.statuses).toHaveLength(1);
    expect(result.statuses[0]).toEqual(
      expect.objectContaining({
        channel: 'whatsapp',
        status: 'delivered',
        channelMessageId:
          'wamid.HBgLMTU1NTc2NTQzMjEVAgASGBQzQTAwMDAwMDAwMDAwMDAwMDAzAA=',
        channelScopedUserId: '15557654321',
        channelScopedBusinessId: '200000000000002'
      })
    );
    expect(result.statuses[0]!.timestamp).toBe(1716000020 * 1000);
  });

  it('emits a read StatusUpdate from a status payload', () => {
    const result = parseWhatsAppWebhook(loadFixture('whatsapp', 'status-read.json'));

    expect(result.messages).toEqual([]);
    expect(result.statuses).toHaveLength(1);
    expect(result.statuses[0]!.status).toBe('read');
  });

  it('emits a failed StatusUpdate carrying errorCode and errorTitle', () => {
    const result = parseWhatsAppWebhook(loadFixture('whatsapp', 'status-failed.json'));

    expect(result.statuses).toHaveLength(1);
    const status = result.statuses[0]!;
    expect(status.status).toBe('failed');
    expect(status.errorCode).toBe(131026);
    expect(status.errorTitle).toBe('Message undeliverable');
  });

  it('parses multiple entries into multiple messages with distinct ids', () => {
    const result = parseWhatsAppWebhook(loadFixture('whatsapp', 'multiple-entries.json'));

    expect(result.messages).toHaveLength(2);
    const ids = result.messages.map((m) => m.channelMessageId);
    expect(new Set(ids).size).toBe(2);
    expect(ids).toContain(
      'wamid.HBgLMTU1NTc2NTQzMjEVAgASGBQzQTAwMDAwMDAwMDAwMDAwMDExAA='
    );
    expect(ids).toContain(
      'wamid.HBgLMTU1NTc2NTQzMjEVAgASGBQzQTAwMDAwMDAwMDAwMDAwMDEyAA='
    );
  });

  it('dedupes duplicate channelMessageId within a single payload', () => {
    const result = parseWhatsAppWebhook(loadFixture('whatsapp', 'duplicate-message.json'));

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.channelMessageId).toBe(
      'wamid.HBgLMTU1NTc2NTQzMjEVAgASGBQzQTAwMDAwMDAwMDAwMDAwMDEzAA='
    );
  });

  it('normalizes a string-seconds timestamp to milliseconds', () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '100000000000001',
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: '200000000000002' },
                messages: [
                  {
                    from: '15557654321',
                    id: 'wamid.string-seconds-test',
                    timestamp: '1716000000',
                    type: 'text',
                    text: { body: 'string seconds' }
                  }
                ]
              }
            }
          ]
        }
      ]
    };
    const result = parseWhatsAppWebhook(payload);
    expect(result.messages[0]!.timestamp).toBe(1716000000000);
  });

  it('normalizes a numeric-seconds timestamp to milliseconds', () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '100000000000001',
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: '200000000000002' },
                messages: [
                  {
                    from: '15557654321',
                    id: 'wamid.numeric-seconds-test',
                    timestamp: 1716000000,
                    type: 'text',
                    text: { body: 'numeric seconds' }
                  }
                ]
              }
            }
          ]
        }
      ]
    };
    const result = parseWhatsAppWebhook(payload);
    expect(result.messages[0]!.timestamp).toBe(1716000000000);
  });

  it('preserves an already-milliseconds timestamp as-is', () => {
    const ms = 1_716_000_000_000;
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '100000000000001',
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: '200000000000002' },
                messages: [
                  {
                    from: '15557654321',
                    id: 'wamid.ms-passthrough-test',
                    timestamp: ms,
                    type: 'text',
                    text: { body: 'already ms' }
                  }
                ]
              }
            }
          ]
        }
      ]
    };
    const result = parseWhatsAppWebhook(payload);
    expect(result.messages[0]!.timestamp).toBe(ms);
  });

  it('falls back to a sensible Date.now() when timestamp is missing', () => {
    const before = Date.now();
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '100000000000001',
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: '200000000000002' },
                messages: [
                  {
                    from: '15557654321',
                    id: 'wamid.no-timestamp-test',
                    type: 'text',
                    text: { body: 'no timestamp' }
                  }
                ]
              }
            }
          ]
        }
      ]
    };
    const result = parseWhatsAppWebhook(payload);
    const after = Date.now();
    const ts = result.messages[0]!.timestamp;
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('falls back to Date.now() when timestamp is unparseable garbage', () => {
    const before = Date.now();
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '100000000000001',
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: '200000000000002' },
                messages: [
                  {
                    from: '15557654321',
                    id: 'wamid.garbage-timestamp-test',
                    timestamp: 'not-a-number',
                    type: 'text',
                    text: { body: 'garbage' }
                  }
                ]
              }
            }
          ]
        }
      ]
    };
    const result = parseWhatsAppWebhook(payload);
    const after = Date.now();
    const ts = result.messages[0]!.timestamp;
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('returns an empty result for a payload with only the object discriminator', () => {
    expect(parseWhatsAppWebhook({ object: 'whatsapp_business_account' })).toEqual({
      messages: [],
      statuses: []
    });
  });

  it('returns an empty result when entry is not an array', () => {
    expect(
      parseWhatsAppWebhook({ object: 'whatsapp_business_account', entry: 'oops' })
    ).toEqual({ messages: [], statuses: [] });
  });

  it('returns an empty result when entry items lack changes', () => {
    expect(
      parseWhatsAppWebhook({
        object: 'whatsapp_business_account',
        entry: [{ id: '100000000000001' }]
      })
    ).toEqual({ messages: [], statuses: [] });
  });

  it('skips entries whose metadata is missing phone_number_id', () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '100000000000001',
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { display_phone_number: '15551234567' },
                messages: [
                  {
                    from: '15557654321',
                    id: 'wamid.no-business-id',
                    timestamp: '1716000000',
                    type: 'text',
                    text: { body: 'no biz id' }
                  }
                ]
              }
            }
          ]
        }
      ]
    };
    expect(parseWhatsAppWebhook(payload)).toEqual({ messages: [], statuses: [] });
  });

  it('drops status entries with non-allowlisted status values', () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '100000000000001',
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: '200000000000002' },
                statuses: [
                  {
                    id: 'wamid.weird-status',
                    status: 'weirdo',
                    timestamp: '1716000000',
                    recipient_id: '15557654321'
                  }
                ]
              }
            }
          ]
        }
      ]
    };
    expect(parseWhatsAppWebhook(payload)).toEqual({ messages: [], statuses: [] });
  });

  it('surfaces unknown message types as MessageType=unknown without dropping the message', () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '100000000000001',
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: '200000000000002' },
                messages: [
                  {
                    from: '15557654321',
                    id: 'wamid.contacts-event',
                    timestamp: '1716000000',
                    type: 'contacts',
                    contacts: [{ name: { formatted_name: 'Test' } }]
                  }
                ]
              }
            }
          ]
        }
      ]
    };
    const result = parseWhatsAppWebhook(payload);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.type).toBe('unknown');
    expect(result.messages[0]!.channelMessageId).toBe('wamid.contacts-event');
  });

  // D1: Click-to-WhatsApp ad attribution must surface through `referral` —
  // dropping it would permanently sever ad → conversation linkage.
  it('extracts Click-to-WhatsApp referral metadata onto referral with type=click_to_whatsapp', () => {
    const result = parseWhatsAppWebhook(loadFixture('whatsapp', 'click-to-whatsapp.json'));

    expect(result.messages).toHaveLength(1);
    const msg = result.messages[0]!;
    expect(msg.type).toBe('text');
    expect(msg.text).toBe('Hi, saw your ad!');
    expect(msg.referral).toBeDefined();
    expect(msg.referral!.type).toBe('click_to_whatsapp');
    expect(msg.referral!.source).toBe('ad');
    expect(msg.referral!.ref).toBe('ctwa_clid_abc123def456ghi789');
    expect(msg.referral!.ctwaClid).toBe('ctwa_clid_abc123def456ghi789');
    expect(msg.referral!.sourceUrl).toBe('https://fb.me/example-ad');
    expect(msg.referral!.headline).toBe('Try our new product');
  });

  // D2: WhatsApp Flow nfm_reply surfaces submitted form JSON via flowResponse.
  it('extracts WhatsApp Flow nfm_reply submission with response_json on flowResponse', () => {
    const result = parseWhatsAppWebhook(loadFixture('whatsapp', 'interactive-nfm-reply.json'));

    expect(result.messages).toHaveLength(1);
    const msg = result.messages[0]!;
    expect(msg.type).toBe('interactive');
    expect(msg.text).toBe('Submitted');
    expect(msg.flowResponse).toBeDefined();
    expect(msg.flowResponse!.name).toBe('appointment_flow');
    expect(msg.flowResponse!.bodyText).toBe('Submitted');
    // Preserved verbatim — downstream owns its own parsing schema.
    expect(typeof msg.flowResponse!.responseJson).toBe('string');
    expect(msg.flowResponse!.responseJson).toContain('"appointment_date":"2026-05-25"');
  });

  // D3: forwarded / frequently_forwarded flags ride on `context` and are a
  // useful spam / misinformation signal for the conversation agent.
  it('surfaces context.forwarded and frequently_forwarded as forwarded info', () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '100000000000001',
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: '200000000000002' },
                messages: [
                  {
                    from: '15557654321',
                    id: 'wamid.forwarded-event',
                    timestamp: '1716000150',
                    type: 'text',
                    text: { body: 'Forwarded message' },
                    context: {
                      forwarded: true,
                      frequently_forwarded: false
                    }
                  }
                ]
              }
            }
          ]
        }
      ]
    };
    const result = parseWhatsAppWebhook(payload);
    expect(result.messages).toHaveLength(1);
    const msg = result.messages[0]!;
    expect(msg.forwarded).toEqual({ forwarded: true, frequentlyForwarded: false });
  });

  // D4: system message type now maps to MessageType=system, body lifted to text.
  it('parses a system message with body lifted onto text', () => {
    const result = parseWhatsAppWebhook(loadFixture('whatsapp', 'system-message.json'));

    expect(result.messages).toHaveLength(1);
    const msg = result.messages[0]!;
    expect(msg.type).toBe('system');
    expect(msg.text).toBe(
      'Test User changed their phone number from +1 555 765 4321 to +1 555 765 4322'
    );
  });

  // D5: template button reply routes via payload (was lossy: payload used to
  // be overwritten by text on the cross-channel `interactive` variant).
  it('parses a template button reply as postback with payload preserved', () => {
    const result = parseWhatsAppWebhook(loadFixture('whatsapp', 'template-button.json'));

    expect(result.messages).toHaveLength(1);
    const msg = result.messages[0]!;
    expect(msg.type).toBe('postback');
    expect(msg.postback).toEqual({
      title: 'Confirm appointment',
      payload: 'CONFIRM_APPT_BTN_PAYLOAD'
    });
    // Reply context (the template message this button belongs to) should
    // still be surfaced as replyTo.
    expect(msg.replyTo).toBe(
      'wamid.HBgLMTU1NTc2NTQzMjEVAgASGBQzQTAwMDAwMDAwMDAwMDAwMDAyMwA='
    );
  });
});

describe('parseMessengerWebhook', () => {
  it('parses a text message into a normalized IncomingMessage with ms timestamp', () => {
    const result = parseMessengerWebhook(loadFixture('messenger', 'text-message.json'));

    expect(result.statuses).toEqual([]);
    expect(result.messages).toHaveLength(1);
    const msg = result.messages[0]!;
    expect(msg).toEqual(
      expect.objectContaining({
        channel: 'messenger',
        channelMessageId: 'm_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIj',
        channelScopedUserId: '6000000000000061',
        channelScopedBusinessId: '500000000000005',
        type: 'text',
        text: 'Hello from Messenger',
        timestamp: 1716000100000
      })
    );
  });

  it('parses an image attachment with payload.url surfaced as media.url', () => {
    const result = parseMessengerWebhook(loadFixture('messenger', 'image-attachment.json'));

    expect(result.messages).toHaveLength(1);
    const msg = result.messages[0]!;
    expect(msg.type).toBe('image');
    expect(msg.media?.url).toBe('https://scontent.example.test/messenger/image-001.jpg');
  });

  it('parses a postback into postback.title + payload with synthetic id when mid is provided', () => {
    const result = parseMessengerWebhook(loadFixture('messenger', 'postback.json'));

    expect(result.messages).toHaveLength(1);
    const msg = result.messages[0]!;
    expect(msg.type).toBe('postback');
    expect(msg.postback).toEqual({
      title: 'Get Started',
      payload: 'GET_STARTED_PAYLOAD'
    });
    expect(msg.channelMessageId).toBe('m_PostbackXyZ0123456789AbCdEfGhIjKlMnOpQrStUv');
  });

  it('synthesizes channelMessageId for postback events without a mid', () => {
    const payload = {
      object: 'page',
      entry: [
        {
          id: '500000000000005',
          time: 1716000111000,
          messaging: [
            {
              sender: { id: '6000000000000061' },
              recipient: { id: '500000000000005' },
              timestamp: 1716000111000,
              postback: {
                title: 'No Mid',
                payload: 'NO_MID_PAYLOAD'
              }
            }
          ]
        }
      ]
    };
    const result = parseMessengerWebhook(payload);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.channelMessageId).toBe(
      '500000000000005-1716000111000-postback'
    );
  });

  it('parses a reaction event with action, emoji, and targetMessageId', () => {
    const result = parseMessengerWebhook(loadFixture('messenger', 'reaction.json'));

    expect(result.messages).toHaveLength(1);
    const msg = result.messages[0]!;
    expect(msg.type).toBe('reaction');
    expect(msg.reaction).toEqual({
      emoji: '❤️',
      targetMessageId: 'm_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIj',
      action: 'react'
    });
    // Synthetic id intentionally omits timestamp so per-payload retries that
    // ship the same logical reaction at a slightly-different ms still dedupe.
    expect(msg.channelMessageId).toBe(
      '6000000000000061-m_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIj-react'
    );
  });

  it('parses a reply_to message and surfaces replyTo as the referenced mid', () => {
    const result = parseMessengerWebhook(loadFixture('messenger', 'reply-to.json'));

    expect(result.messages).toHaveLength(1);
    const msg = result.messages[0]!;
    expect(msg.replyTo).toBe('m_PrevOriginalAbCdEfGhIjKlMnOpQrStUv012345Prev');
    expect(msg.text).toBe('Got it, thanks');
  });

  it('parses a referral event and populates the referral block', () => {
    const result = parseMessengerWebhook(loadFixture('messenger', 'referral.json'));

    expect(result.messages).toHaveLength(1);
    const msg = result.messages[0]!;
    expect(msg.type).toBe('referral');
    expect(msg.referral).toEqual({
      source: 'ADS',
      type: 'OPEN_THREAD',
      ref: 'my_ref'
    });
    expect(msg.channelMessageId).toBe(
      '500000000000005-1716000330000-referral'
    );
  });

  it('emits a read StatusUpdate (no inbound message) from a read event', () => {
    const result = parseMessengerWebhook(loadFixture('messenger', 'message-read.json'));

    expect(result.messages).toEqual([]);
    expect(result.statuses).toHaveLength(1);
    const status = result.statuses[0]!;
    expect(status.status).toBe('read');
    expect(status.channel).toBe('messenger');
    expect(status.channelScopedUserId).toBe('6000000000000061');
    expect(status.channelScopedBusinessId).toBe('500000000000005');
    expect(status.channelMessageId).toBe('1716000115000');
  });

  it('fans out a delivery event into one StatusUpdate per mid', () => {
    const result = parseMessengerWebhook(loadFixture('messenger', 'delivery.json'));

    expect(result.messages).toEqual([]);
    expect(result.statuses).toHaveLength(2);
    const ids = result.statuses.map((s) => s.channelMessageId);
    expect(ids).toEqual([
      'm_DeliveredA0123456789AbCdEfGhIjKlMnOpQrStUv',
      'm_DeliveredB0123456789AbCdEfGhIjKlMnOpQrStUv'
    ]);
    for (const s of result.statuses) {
      expect(s.status).toBe('delivered');
      expect(s.timestamp).toBe(1716000309000);
      expect(s.channelScopedBusinessId).toBe('500000000000005');
      expect(s.channelScopedUserId).toBe('6000000000000061');
    }
  });

  it('flips sender/recipient for echo messages so user id is on the user side', () => {
    const result = parseMessengerWebhook(loadFixture('messenger', 'echo.json'));

    expect(result.messages).toHaveLength(1);
    const msg = result.messages[0]!;
    expect(msg.isEcho).toBe(true);
    expect(msg.type).toBe('echo');
    expect(msg.channelScopedUserId).toBe('6000000000000061');
    expect(msg.channelScopedBusinessId).toBe('500000000000005');
    expect(msg.text).toBe('Echoed business reply');
  });

  it('returns empty for non-object payloads without throwing', () => {
    expect(parseMessengerWebhook(null)).toEqual({ messages: [], statuses: [] });
    expect(parseMessengerWebhook(42)).toEqual({ messages: [], statuses: [] });
    expect(parseMessengerWebhook('nope')).toEqual({ messages: [], statuses: [] });
  });

  it('returns empty when entry is missing or wrong-shaped', () => {
    expect(parseMessengerWebhook({ object: 'page' })).toEqual({
      messages: [],
      statuses: []
    });
    expect(parseMessengerWebhook({ object: 'page', entry: 'no' })).toEqual({
      messages: [],
      statuses: []
    });
    expect(
      parseMessengerWebhook({ object: 'page', entry: [{ id: 'x' }] })
    ).toEqual({ messages: [], statuses: [] });
  });

  it('surfaces unknown messaging-event types as MessageType=unknown with a synthetic id', () => {
    const payload = {
      object: 'page',
      entry: [
        {
          id: '500000000000005',
          time: 1716000999000,
          messaging: [
            {
              sender: { id: '6000000000000061' },
              recipient: { id: '500000000000005' },
              timestamp: 1716000999000,
              optin: { ref: 'pass_through' }
            }
          ]
        }
      ]
    };
    const result = parseMessengerWebhook(payload);
    expect(result.messages).toHaveLength(1);
    const msg = result.messages[0]!;
    expect(msg.type).toBe('unknown');
    // Trailing `-1` is the per-payload monotonic counter (B3 fix) — keeps a
    // burst of opt-in / handover events from collapsing under dedupe.
    expect(msg.channelMessageId).toBe('500000000000005-1716000999000-unknown-1');
    expect(msg.channelScopedUserId).toBe('6000000000000061');
    expect(msg.channelScopedBusinessId).toBe('500000000000005');
  });

  // B1: an attachment with an unmapped `type` and no text must surface as
  // MessageType=unknown, not leak the initialized `text` placeholder.
  it('classifies an attachment with an unmapped type and no text as unknown', () => {
    const payload = {
      object: 'page',
      entry: [
        {
          id: '500000000000005',
          time: 1716000800000,
          messaging: [
            {
              sender: { id: '6000000000000061' },
              recipient: { id: '500000000000005' },
              timestamp: 1716000800000,
              message: {
                mid: 'm_UnmappedAttachment_AbCdEfGhIjKlMnOpQrStUv',
                attachments: [
                  {
                    type: 'unsupported_type',
                    payload: { url: 'https://scontent.example.test/unsupported-001.bin' }
                  }
                ]
              }
            }
          ]
        }
      ]
    };
    const result = parseMessengerWebhook(payload);
    expect(result.messages).toHaveLength(1);
    const msg = result.messages[0]!;
    expect(msg.type).toBe('unknown');
    expect(msg.text).toBeUndefined();
  });

  // B2: identical reactions (same sender, target, action) at different ms
  // must dedupe — the synthetic id no longer includes timestamp.
  it('dedupes identical reaction events that differ only in timestamp', () => {
    const payload = {
      object: 'page',
      entry: [
        {
          id: '500000000000005',
          time: 1716000130000,
          messaging: [
            {
              sender: { id: '6000000000000061' },
              recipient: { id: '500000000000005' },
              timestamp: 1716000130000,
              reaction: {
                mid: 'm_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIj',
                action: 'react',
                emoji: '❤️',
                reaction: 'love'
              }
            },
            {
              sender: { id: '6000000000000061' },
              recipient: { id: '500000000000005' },
              timestamp: 1716000130003,
              reaction: {
                mid: 'm_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIj',
                action: 'react',
                emoji: '❤️',
                reaction: 'love'
              }
            }
          ]
        }
      ]
    };
    const result = parseMessengerWebhook(payload);
    expect(result.messages).toHaveLength(1);
  });

  // B3: two distinct unknown messaging events at the same timestamp must NOT
  // collapse under dedupe — the synthetic id now appends a per-payload counter.
  it('does not dedupe two unknown messaging events at the same timestamp', () => {
    const payload = {
      object: 'page',
      entry: [
        {
          id: '500000000000005',
          time: 1716000999000,
          messaging: [
            {
              sender: { id: '6000000000000061' },
              recipient: { id: '500000000000005' },
              timestamp: 1716000999000,
              optin: { ref: 'first_optin' }
            },
            {
              sender: { id: '6000000000000061' },
              recipient: { id: '500000000000005' },
              timestamp: 1716000999000,
              account_linking: { status: 'linked' }
            }
          ]
        }
      ]
    };
    const result = parseMessengerWebhook(payload);
    expect(result.messages).toHaveLength(2);
    const ids = result.messages.map((m) => m.channelMessageId);
    expect(new Set(ids).size).toBe(2);
  });

  // B4: a read event missing both `mid` and `watermark` has nothing to
  // advance against and must be dropped entirely (logging `'undefined'` as
  // a channelMessageId would poison downstream status sweeps).
  it('drops read events that have neither mid nor watermark', () => {
    const payload = {
      object: 'page',
      entry: [
        {
          id: '500000000000005',
          time: 1716000400000,
          messaging: [
            {
              sender: { id: '6000000000000061' },
              recipient: { id: '500000000000005' },
              timestamp: 1716000400000,
              read: { seq: 42 }
            }
          ]
        }
      ]
    };
    const result = parseMessengerWebhook(payload);
    expect(result.statuses).toEqual([]);
    expect(result.messages).toEqual([]);
  });
});

describe('parseInstagramWebhook', () => {
  it('parses an Instagram DM into a normalized text IncomingMessage', () => {
    const result = parseInstagramWebhook(loadFixture('instagram', 'text-dm.json'));

    expect(result.statuses).toEqual([]);
    expect(result.messages).toHaveLength(1);
    const msg = result.messages[0]!;
    expect(msg).toEqual(
      expect.objectContaining({
        channel: 'instagram',
        channelMessageId: 'aWdfZG06MTpJRzpUZXh0RG1NZXNzYWdlSWQwMTIzNDU2Nzg5',
        channelScopedUserId: '1780000000000008',
        channelScopedBusinessId: '17841400000000007',
        type: 'text',
        text: 'Hello from Instagram',
        timestamp: 1716000200000
      })
    );
  });

  it('parses an image attachment with payload.url surfaced as media.url', () => {
    const result = parseInstagramWebhook(loadFixture('instagram', 'image-attachment.json'));

    expect(result.messages).toHaveLength(1);
    const msg = result.messages[0]!;
    expect(msg.type).toBe('image');
    expect(msg.media?.url).toBe(
      'https://scontent.example.test/instagram/dm-image-001.jpg'
    );
  });

  it('parses a story reply and populates storyReply with id and url', () => {
    const result = parseInstagramWebhook(loadFixture('instagram', 'story-reply.json'));

    expect(result.messages).toHaveLength(1);
    const msg = result.messages[0]!;
    expect(msg.type).toBe('text');
    expect(msg.text).toBe('Loved this story!');
    expect(msg.storyReply).toEqual({
      id: '1800000000000009',
      url: 'https://cdn.example.test/stories/1800000000000009.jpg'
    });
  });

  it('parses a story mention attachment and populates storyMention', () => {
    const result = parseInstagramWebhook(loadFixture('instagram', 'story-mention.json'));

    expect(result.messages).toHaveLength(1);
    const msg = result.messages[0]!;
    expect(msg.storyMention).toEqual({
      id: 'aWdfZG06MTpJRzpTdG9yeU1lbnRpb25NZXNzYWdlSWQwMTIz',
      url: 'https://cdn.example.test/stories/mention-1800000000000010.jpg'
    });
  });

  it('parses an Instagram reaction with IG-scoped user/business ids', () => {
    const result = parseInstagramWebhook(loadFixture('instagram', 'reaction.json'));

    expect(result.messages).toHaveLength(1);
    const msg = result.messages[0]!;
    expect(msg.type).toBe('reaction');
    expect(msg.channelScopedUserId).toBe('1780000000000008');
    expect(msg.channelScopedBusinessId).toBe('17841400000000007');
    expect(msg.reaction).toEqual({
      emoji: '❤️',
      targetMessageId: 'aWdfZG06MTpJRzpUZXh0RG1NZXNzYWdlSWQwMTIzNDU2Nzg5',
      action: 'react'
    });
  });

  it('flips sender/recipient for Instagram echoes', () => {
    const result = parseInstagramWebhook(loadFixture('instagram', 'echo.json'));

    expect(result.messages).toHaveLength(1);
    const msg = result.messages[0]!;
    expect(msg.isEcho).toBe(true);
    expect(msg.type).toBe('echo');
    expect(msg.channelScopedUserId).toBe('1780000000000008');
    expect(msg.channelScopedBusinessId).toBe('17841400000000007');
  });

  it('parses an Instagram referral event and populates referral', () => {
    const result = parseInstagramWebhook(loadFixture('instagram', 'referral.json'));

    expect(result.messages).toHaveLength(1);
    const msg = result.messages[0]!;
    expect(msg.type).toBe('referral');
    expect(msg.referral).toEqual({
      source: 'IG_ME_LINK',
      type: 'OPEN_THREAD',
      ref: 'ig_campaign_ref_01'
    });
  });
});
