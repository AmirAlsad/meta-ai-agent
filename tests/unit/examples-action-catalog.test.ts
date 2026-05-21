/**
 * Unit tests for the action-catalog example's PURE handler
 * (`catalogResponse`, examples/action-catalog).
 *
 * We test only the pure request→response function — no HTTP server. Each keyword
 * should yield the matching {@link ChatResponse} shape, and every capability-
 * gated branch should degrade to a plain `message` when the capability is
 * absent. Fixtures are built inline via `makeChatRequest`.
 */
import { describe, expect, it } from 'vitest';
import { catalogResponse } from '../../examples/action-catalog/index.js';
import type { ChatRequest } from '../../src/chat/types.js';
import type { Channel, ChannelFeature, IncomingMessage } from '../../src/meta/types.js';

/** Build a minimal text {@link IncomingMessage}. */
function textMessage(channelMessageId: string, text: string, channel: Channel = 'whatsapp'): IncomingMessage {
  return {
    channel,
    channelMessageId,
    channelScopedUserId: 'user-1',
    channelScopedBusinessId: 'biz-1',
    timestamp: 1_700_000_000_000,
    type: 'text',
    text,
    raw: {}
  };
}

/**
 * Minimal {@link ChatRequest} fixture. Defaults to a single WhatsApp text turn
 * with the full WhatsApp capability set and an open window. Override `message`
 * to pick the keyword and `capabilities` to exercise the degrade paths.
 */
function makeChatRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
  const channel = overrides.channel ?? 'whatsapp';
  const message = overrides.message ?? 'help';
  const capabilities: ChannelFeature[] =
    overrides.capabilities ?? ['typing_indicator', 'reaction', 'reply_to', 'template', 'media_send'];
  return {
    channel,
    conversationKey: `${channel}:biz-1:user-1`,
    message,
    messages: overrides.messages ?? [textMessage('mid-LAST', message, channel)],
    capabilities,
    context: overrides.context ?? { windowOpen: true },
    ...(overrides.contact ? { contact: overrides.contact } : {})
  };
}

describe('catalogResponse (action-catalog)', () => {
  describe('silence', () => {
    it('returns explicit silence', () => {
      expect(catalogResponse(makeChatRequest({ message: 'silence' }))).toEqual({ silence: true });
    });
  });

  describe('multi', () => {
    it('returns an ordered messages[] array', () => {
      expect(catalogResponse(makeChatRequest({ message: 'multi' }))).toEqual({
        messages: ['First bubble.', 'Second bubble.']
      });
    });
  });

  describe('react', () => {
    it('emits a reaction + confirming message targeting the last inbound id', () => {
      const req = makeChatRequest({ message: 'react', capabilities: ['reaction'] });
      expect(catalogResponse(req)).toEqual({
        actions: [
          { type: 'reaction', emoji: '👍', targetMessageId: 'mid-LAST' },
          { type: 'message', text: 'Reacted 👍' }
        ]
      });
    });

    it('degrades to a plain message when reactions are unsupported', () => {
      const req = makeChatRequest({ message: 'react', capabilities: [] });
      expect(catalogResponse(req)).toEqual({ message: 'Reactions are not supported on this channel.' });
    });
  });

  describe('reply', () => {
    it('emits a reply action targeting the last inbound id when reply_to is supported', () => {
      const req = makeChatRequest({ message: 'reply', capabilities: ['reply_to'] });
      expect(catalogResponse(req)).toEqual({
        actions: [{ type: 'reply', text: 'Threaded reply.', targetMessageId: 'mid-LAST' }]
      });
    });

    it('degrades to a plain message when reply_to is unsupported', () => {
      const req = makeChatRequest({ message: 'reply', capabilities: [] });
      expect(catalogResponse(req)).toEqual({
        message: 'Threaded reply (sent as a normal message — this channel has no reply_to).'
      });
    });
  });

  describe('media', () => {
    it('emits a media action when media_send is supported', () => {
      const req = makeChatRequest({ message: 'media', capabilities: ['media_send'] });
      expect(catalogResponse(req)).toEqual({
        actions: [
          { type: 'media', url: 'https://example.com/sample.jpg', caption: 'A sample image', mimeType: 'image/jpeg' }
        ]
      });
    });

    it('degrades to a plain message when media_send is unsupported', () => {
      const req = makeChatRequest({ message: 'media', capabilities: [] });
      expect(catalogResponse(req)).toEqual({ message: 'Media sending is not supported on this channel.' });
    });
  });

  describe('template', () => {
    it('emits a template action on WhatsApp (template supported)', () => {
      const req = makeChatRequest({ message: 'template', capabilities: ['template'] });
      expect(catalogResponse(req)).toEqual({
        actions: [{ type: 'template', name: 'hello_world', language: 'en_US' }]
      });
    });

    it('degrades to a plain message off WhatsApp (no template capability)', () => {
      const req = makeChatRequest({ message: 'template', channel: 'messenger', capabilities: ['reaction'] });
      expect(catalogResponse(req)).toEqual({
        message: 'Templates are WhatsApp-only; here is a normal message instead.'
      });
    });
  });

  describe('typing', () => {
    it('emits a typing indicator + message when typing_indicator is supported', () => {
      const req = makeChatRequest({ message: 'typing', capabilities: ['typing_indicator'] });
      expect(catalogResponse(req)).toEqual({
        actions: [
          { type: 'typing', durationMs: 2000 },
          { type: 'message', text: 'Done typing!' }
        ]
      });
    });

    it('degrades to just the message when typing_indicator is unsupported', () => {
      const req = makeChatRequest({ message: 'typing', capabilities: [] });
      expect(catalogResponse(req)).toEqual({ message: 'Done typing!' });
    });
  });

  describe('help / unknown', () => {
    it('lists the keywords on "help"', () => {
      const res = catalogResponse(makeChatRequest({ message: 'help' }));
      expect(res.message).toContain('silence');
      expect(res.message).toContain('template');
    });

    it('falls back to the help listing for an unrecognized keyword', () => {
      const res = catalogResponse(makeChatRequest({ message: 'wat' }));
      expect(res.message).toContain('Try:');
    });
  });

  describe('keyword parsing', () => {
    it('matches the first word case-insensitively, ignoring trailing text', () => {
      const req = makeChatRequest({ message: 'SILENCE please' });
      expect(catalogResponse(req)).toEqual({ silence: true });
    });

    it('falls back to a placeholder target id when the turn carried no message id', () => {
      const req = makeChatRequest({ message: 'react', messages: [], capabilities: ['reaction'] });
      expect(catalogResponse(req)).toEqual({
        actions: [
          { type: 'reaction', emoji: '👍', targetMessageId: 'unknown-message-id' },
          { type: 'message', text: 'Reacted 👍' }
        ]
      });
    });
  });
});
