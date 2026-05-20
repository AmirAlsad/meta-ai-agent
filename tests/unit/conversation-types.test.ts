/**
 * Unit tests for the Stage 5 conversation type helpers: the three key
 * builders, `conversationKeyFor`, `createIdleConversation`, and the 24h
 * messaging-window helper.
 */
import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from '../../src/meta/types.js';
import {
  MESSAGING_WINDOW_MS,
  conversationKeyFor,
  createIdleConversation,
  instagramConversationKey,
  isWindowOpen,
  messengerConversationKey,
  whatsappConversationKey
} from '../../src/conversation/types.js';

/** A minimal valid `IncomingMessage` with the fields the key derivation reads. */
function makeMessage(overrides: Partial<IncomingMessage> & Pick<IncomingMessage, 'channel'>): IncomingMessage {
  return {
    channelMessageId: 'mid-1',
    channelScopedUserId: 'user-1',
    channelScopedBusinessId: 'biz-1',
    timestamp: 1_700_000_000_000,
    type: 'text',
    text: 'hi',
    raw: {},
    ...overrides
  };
}

describe('conversation key builders', () => {
  it('whatsappConversationKey produces whatsapp:{phoneNumberId}:{waId}', () => {
    expect(whatsappConversationKey('200000000000002', '15551234567')).toBe(
      'whatsapp:200000000000002:15551234567'
    );
  });

  it('messengerConversationKey produces messenger:{pageId}:{psid}', () => {
    expect(messengerConversationKey('500000000000005', 'psid-abc')).toBe(
      'messenger:500000000000005:psid-abc'
    );
  });

  it('instagramConversationKey produces instagram:{igUserId}:{igsid}', () => {
    expect(instagramConversationKey('17841400000000007', 'igsid-xyz')).toBe(
      'instagram:17841400000000007:igsid-xyz'
    );
  });
});

describe('conversationKeyFor', () => {
  it('derives the WhatsApp key (business before user) from an IncomingMessage', () => {
    const key = conversationKeyFor(
      makeMessage({ channel: 'whatsapp', channelScopedBusinessId: 'pn-1', channelScopedUserId: 'wa-1' })
    );
    expect(key).toBe('whatsapp:pn-1:wa-1');
    // Must match the dedicated builder exactly.
    expect(key).toBe(whatsappConversationKey('pn-1', 'wa-1'));
  });

  it('derives the Messenger key from an IncomingMessage', () => {
    const key = conversationKeyFor(
      makeMessage({ channel: 'messenger', channelScopedBusinessId: 'page-1', channelScopedUserId: 'psid-1' })
    );
    expect(key).toBe('messenger:page-1:psid-1');
    expect(key).toBe(messengerConversationKey('page-1', 'psid-1'));
  });

  it('derives the Instagram key from an IncomingMessage', () => {
    const key = conversationKeyFor(
      makeMessage({ channel: 'instagram', channelScopedBusinessId: 'ig-1', channelScopedUserId: 'igsid-1' })
    );
    expect(key).toBe('instagram:ig-1:igsid-1');
    expect(key).toBe(instagramConversationKey('ig-1', 'igsid-1'));
  });
});

describe('createIdleConversation', () => {
  it('produces a well-formed idle record with empty buffers/queues', () => {
    const record = createIdleConversation({
      key: 'whatsapp:pn-1:wa-1',
      channel: 'whatsapp',
      channelScopedUserId: 'wa-1',
      channelScopedBusinessId: 'pn-1',
      now: 1234
    });
    expect(record).toEqual({
      key: 'whatsapp:pn-1:wa-1',
      channel: 'whatsapp',
      channelScopedUserId: 'wa-1',
      channelScopedBusinessId: 'pn-1',
      state: 'idle',
      inboundBuffer: [],
      outboundQueue: [],
      currentOutboundIndex: 0,
      deliveredMessageIds: [],
      lastActivity: 1234
    });
  });

  it('omits contact when not supplied (key absent, not undefined)', () => {
    const record = createIdleConversation({
      key: 'k',
      channel: 'messenger',
      channelScopedUserId: 'u',
      channelScopedBusinessId: 'b'
    });
    expect('contact' in record).toBe(false);
  });

  it('attaches contact when supplied', () => {
    const contact = { channel: 'instagram', channelScopedUserId: 'igsid-1', firstName: 'Ada' };
    const record = createIdleConversation({
      key: 'k',
      channel: 'instagram',
      channelScopedUserId: 'igsid-1',
      channelScopedBusinessId: 'ig-1',
      contact
    });
    expect(record.contact).toEqual(contact);
  });

  it('defaults lastActivity to roughly now when not provided', () => {
    const before = Date.now();
    const record = createIdleConversation({
      key: 'k',
      channel: 'whatsapp',
      channelScopedUserId: 'u',
      channelScopedBusinessId: 'b'
    });
    expect(record.lastActivity).toBeGreaterThanOrEqual(before);
    expect(record.lastActivity).toBeLessThanOrEqual(Date.now());
  });
});

describe('isWindowOpen', () => {
  it('exposes the 24h window constant', () => {
    expect(MESSAGING_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('is true within 24h of windowExpiresAt', () => {
    const now = 1_700_000_000_000;
    // windowExpiresAt one hour in the future -> still open.
    expect(isWindowOpen({ windowExpiresAt: now + 60 * 60 * 1000 }, now)).toBe(true);
  });

  it('is false after windowExpiresAt has passed', () => {
    const now = 1_700_000_000_000;
    expect(isWindowOpen({ windowExpiresAt: now - 1 }, now)).toBe(false);
  });

  it('is false exactly at windowExpiresAt (boundary is closed)', () => {
    const now = 1_700_000_000_000;
    expect(isWindowOpen({ windowExpiresAt: now }, now)).toBe(false);
  });

  it('is false when windowExpiresAt is unset (no inbound seen yet)', () => {
    expect(isWindowOpen({}, 1_700_000_000_000)).toBe(false);
  });
});
