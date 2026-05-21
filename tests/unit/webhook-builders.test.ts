/**
 * Unit tests for the REPL's pure webhook-payload builders.
 *
 * The contract these builders must honor is "produce a payload {@link
 * parseMetaWebhook} accepts and normalizes correctly". So every test feeds a
 * builder's output straight through the REAL parser and asserts on the
 * normalized {@link ParseResult} — text → one IncomingMessage with the right
 * channel/text/ids, image → media, reaction → reaction (emoji + target),
 * status/read → a StatusUpdate. If a builder ever drifts from the fixture shape
 * the parser keys on, the corresponding assertion here fails.
 */
import { describe, expect, it } from 'vitest';
import { parseMetaWebhook } from '../../src/meta/parser.js';
import {
  buildInstagramImageWebhook,
  buildInstagramReactionWebhook,
  buildInstagramReadWebhook,
  buildInstagramTextWebhook,
  buildMessengerImageWebhook,
  buildMessengerReactionWebhook,
  buildMessengerReadWebhook,
  buildMessengerTextWebhook,
  buildWhatsAppImageWebhook,
  buildWhatsAppReactionWebhook,
  buildWhatsAppStatusWebhook,
  buildWhatsAppTextWebhook
} from '../../scripts/lib/webhook-builders.js';

/* ────────────────────────────────────────────────────────────────────────── */
/* WhatsApp                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

describe('WhatsApp webhook builders → parseMetaWebhook', () => {
  it('text → one text IncomingMessage with channel/text/ids', () => {
    const payload = buildWhatsAppTextWebhook({
      phoneNumberId: '200000000000002',
      waId: '15557654321',
      text: 'hi there',
      messageId: 'wamid.TEXT1'
    });
    const { messages, statuses } = parseMetaWebhook(payload);
    expect(statuses).toEqual([]);
    expect(messages).toHaveLength(1);
    const msg = messages[0]!;
    expect(msg.channel).toBe('whatsapp');
    expect(msg.type).toBe('text');
    expect(msg.text).toBe('hi there');
    expect(msg.channelMessageId).toBe('wamid.TEXT1');
    expect(msg.channelScopedUserId).toBe('15557654321');
    expect(msg.channelScopedBusinessId).toBe('200000000000002');
  });

  it('generates a wamid.* id when none is supplied', () => {
    const payload = buildWhatsAppTextWebhook({
      phoneNumberId: '200000000000002',
      waId: '15557654321',
      text: 'auto id'
    });
    const { messages } = parseMetaWebhook(payload);
    expect(messages[0]!.channelMessageId).toMatch(/^wamid\./);
  });

  it('image → media with id, mimeType, and caption', () => {
    const payload = buildWhatsAppImageWebhook({
      phoneNumberId: '200000000000002',
      waId: '15557654321',
      mediaId: '300000000000003',
      caption: 'look',
      messageId: 'wamid.IMG1'
    });
    const { messages } = parseMetaWebhook(payload);
    expect(messages).toHaveLength(1);
    const msg = messages[0]!;
    expect(msg.type).toBe('image');
    expect(msg.media).toEqual({ id: '300000000000003', mimeType: 'image/jpeg', caption: 'look' });
  });

  it('reaction → reaction with emoji + target', () => {
    const payload = buildWhatsAppReactionWebhook({
      phoneNumberId: '200000000000002',
      waId: '15557654321',
      emoji: '❤️',
      targetMessageId: 'wamid.TARGET',
      messageId: 'wamid.REACT1'
    });
    const { messages } = parseMetaWebhook(payload);
    expect(messages).toHaveLength(1);
    const msg = messages[0]!;
    expect(msg.type).toBe('reaction');
    expect(msg.reaction).toEqual({ emoji: '❤️', targetMessageId: 'wamid.TARGET' });
  });

  it('status (delivered) → a StatusUpdate with the right status + ids', () => {
    const payload = buildWhatsAppStatusWebhook({
      phoneNumberId: '200000000000002',
      waId: '15557654321',
      status: 'delivered',
      messageId: 'wamid.OUT1'
    });
    const { messages, statuses } = parseMetaWebhook(payload);
    expect(messages).toEqual([]);
    expect(statuses).toHaveLength(1);
    const status = statuses[0]!;
    expect(status.channel).toBe('whatsapp');
    expect(status.status).toBe('delivered');
    expect(status.channelMessageId).toBe('wamid.OUT1');
    expect(status.channelScopedUserId).toBe('15557654321');
    expect(status.channelScopedBusinessId).toBe('200000000000002');
  });

  it('status (failed) → a StatusUpdate carrying the error code/title', () => {
    const payload = buildWhatsAppStatusWebhook({
      phoneNumberId: '200000000000002',
      waId: '15557654321',
      status: 'failed',
      messageId: 'wamid.OUTFAIL'
    });
    const { statuses } = parseMetaWebhook(payload);
    expect(statuses).toHaveLength(1);
    expect(statuses[0]!.status).toBe('failed');
    expect(statuses[0]!.errorCode).toBe(131_026);
    expect(statuses[0]!.errorTitle).toBe('Message undeliverable');
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Messenger                                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

describe('Messenger webhook builders → parseMetaWebhook', () => {
  it('text → one text IncomingMessage with channel/text/ids', () => {
    const payload = buildMessengerTextWebhook({
      pageId: '500000000000005',
      psid: '6000000000000061',
      text: 'hello fb',
      messageId: 'm_TEXT1'
    });
    const { messages, statuses } = parseMetaWebhook(payload);
    expect(statuses).toEqual([]);
    expect(messages).toHaveLength(1);
    const msg = messages[0]!;
    expect(msg.channel).toBe('messenger');
    expect(msg.type).toBe('text');
    expect(msg.text).toBe('hello fb');
    expect(msg.channelMessageId).toBe('m_TEXT1');
    // Inbound: user is sender, business is recipient — parser unflips correctly.
    expect(msg.channelScopedUserId).toBe('6000000000000061');
    expect(msg.channelScopedBusinessId).toBe('500000000000005');
  });

  it('generates an m_* id when none is supplied', () => {
    const payload = buildMessengerTextWebhook({
      pageId: '500000000000005',
      psid: '6000000000000061',
      text: 'auto id'
    });
    expect(parseMetaWebhook(payload).messages[0]!.channelMessageId).toMatch(/^m_/);
  });

  it('image → media with the attachment url', () => {
    const url = 'https://scontent.example.test/messenger/image-001.jpg';
    const payload = buildMessengerImageWebhook({
      pageId: '500000000000005',
      psid: '6000000000000061',
      url,
      messageId: 'm_IMG1'
    });
    const { messages } = parseMetaWebhook(payload);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.type).toBe('image');
    expect(messages[0]!.media).toEqual({ url });
  });

  it('reaction → reaction with emoji + target + action', () => {
    const payload = buildMessengerReactionWebhook({
      pageId: '500000000000005',
      psid: '6000000000000061',
      emoji: '❤️',
      targetMessageId: 'm_TARGET'
    });
    const { messages } = parseMetaWebhook(payload);
    expect(messages).toHaveLength(1);
    const msg = messages[0]!;
    expect(msg.type).toBe('reaction');
    expect(msg.reaction).toEqual({ emoji: '❤️', targetMessageId: 'm_TARGET', action: 'react' });
  });

  it('read → a read StatusUpdate (watermark-derived)', () => {
    const payload = buildMessengerReadWebhook({
      pageId: '500000000000005',
      psid: '6000000000000061',
      watermark: 1716000115000
    });
    const { messages, statuses } = parseMetaWebhook(payload);
    expect(messages).toEqual([]);
    expect(statuses).toHaveLength(1);
    const status = statuses[0]!;
    expect(status.channel).toBe('messenger');
    expect(status.status).toBe('read');
    // Watermark stringified into channelMessageId (the parser's FB/IG read path).
    expect(status.channelMessageId).toBe('1716000115000');
    expect(status.channelScopedUserId).toBe('6000000000000061');
    expect(status.channelScopedBusinessId).toBe('500000000000005');
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Instagram                                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

describe('Instagram webhook builders → parseMetaWebhook', () => {
  it('text → one text IncomingMessage with channel/text/ids', () => {
    const payload = buildInstagramTextWebhook({
      igUserId: '17841400000000007',
      igsid: '1780000000000008',
      text: 'hello ig',
      messageId: 'ig-mid-TEXT1'
    });
    const { messages, statuses } = parseMetaWebhook(payload);
    expect(statuses).toEqual([]);
    expect(messages).toHaveLength(1);
    const msg = messages[0]!;
    expect(msg.channel).toBe('instagram');
    expect(msg.type).toBe('text');
    expect(msg.text).toBe('hello ig');
    expect(msg.channelMessageId).toBe('ig-mid-TEXT1');
    expect(msg.channelScopedUserId).toBe('1780000000000008');
    expect(msg.channelScopedBusinessId).toBe('17841400000000007');
  });

  it('image → media with the attachment url', () => {
    const url = 'https://scontent.example.test/instagram/dm-image-001.jpg';
    const payload = buildInstagramImageWebhook({
      igUserId: '17841400000000007',
      igsid: '1780000000000008',
      url,
      messageId: 'ig-mid-IMG1'
    });
    const { messages } = parseMetaWebhook(payload);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.type).toBe('image');
    expect(messages[0]!.media).toEqual({ url });
  });

  it('reaction → reaction with emoji + target + action', () => {
    const payload = buildInstagramReactionWebhook({
      igUserId: '17841400000000007',
      igsid: '1780000000000008',
      emoji: '❤️',
      targetMessageId: 'ig-mid-TARGET'
    });
    const { messages } = parseMetaWebhook(payload);
    expect(messages).toHaveLength(1);
    const msg = messages[0]!;
    expect(msg.type).toBe('reaction');
    expect(msg.reaction).toEqual({ emoji: '❤️', targetMessageId: 'ig-mid-TARGET', action: 'react' });
  });

  it('read → a read StatusUpdate (watermark-derived)', () => {
    const payload = buildInstagramReadWebhook({
      igUserId: '17841400000000007',
      igsid: '1780000000000008',
      watermark: 1716000205000
    });
    const { messages, statuses } = parseMetaWebhook(payload);
    expect(messages).toEqual([]);
    expect(statuses).toHaveLength(1);
    const status = statuses[0]!;
    expect(status.channel).toBe('instagram');
    expect(status.status).toBe('read');
    expect(status.channelMessageId).toBe('1716000205000');
    expect(status.channelScopedUserId).toBe('1780000000000008');
    expect(status.channelScopedBusinessId).toBe('17841400000000007');
  });
});
