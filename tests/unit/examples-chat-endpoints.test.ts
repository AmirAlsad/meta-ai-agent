/**
 * Unit tests for the example chat endpoints' PURE handlers:
 *  - `echoResponse`   (examples/minimal-chat-endpoint)
 *  - `routerResponse` (examples/multi-channel-router)
 *
 * We test only the pure request→response functions — no HTTP server, no loop
 * orchestration. Fixtures are built inline via `makeChatRequest`.
 */
import { describe, expect, it } from 'vitest';
import { echoResponse } from '../../examples/minimal-chat-endpoint/index.js';
import { routerResponse } from '../../examples/multi-channel-router/index.js';
import type { ChatRequest } from '../../src/chat/types.js';
import type { Channel, IncomingMessage } from '../../src/meta/types.js';

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

/** Build a minimal reaction {@link IncomingMessage} targeting `targetMessageId`. */
function reactionMessage(
  channelMessageId: string,
  emoji: string,
  targetMessageId: string,
  channel: Channel = 'whatsapp'
): IncomingMessage {
  return {
    channel,
    channelMessageId,
    channelScopedUserId: 'user-1',
    channelScopedBusinessId: 'biz-1',
    timestamp: 1_700_000_000_000,
    type: 'reaction',
    reaction: { emoji, targetMessageId },
    raw: {}
  };
}

/**
 * Minimal {@link ChatRequest} fixture. Defaults to a single WhatsApp text turn
 * with the full WhatsApp capability set and an open window. Override any field
 * to exercise a specific branch.
 */
function makeChatRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
  const channel = overrides.channel ?? 'whatsapp';
  const message = overrides.message ?? 'hello world';
  return {
    channel,
    conversationKey: `${channel}:biz-1:user-1`,
    message,
    messages: overrides.messages ?? [textMessage('mid-1', message, channel)],
    capabilities: overrides.capabilities ?? ['typing_indicator', 'reaction', 'reply_to', 'template'],
    context: overrides.context ?? { windowOpen: true },
    ...(overrides.contact ? { contact: overrides.contact } : {})
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* echoResponse                                                                */
/* ────────────────────────────────────────────────────────────────────────── */

describe('echoResponse (minimal-chat-endpoint)', () => {
  it('echoes the aggregated message back for a normal text turn', () => {
    const req = makeChatRequest({ message: 'hey there' });
    expect(echoResponse(req)).toEqual({ message: 'hey there' });
  });

  it('returns explicit silence for an empty-message turn (reaction/media-only)', () => {
    const req = makeChatRequest({ message: '', messages: [reactionMessage('r1', '👍', 'mid-1')] });
    expect(echoResponse(req)).toEqual({ silence: true });
  });

  it('treats a whitespace-only message as nothing to echo', () => {
    expect(echoResponse(makeChatRequest({ message: '   ' }))).toEqual({ silence: true });
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* routerResponse                                                              */
/* ────────────────────────────────────────────────────────────────────────── */

describe('routerResponse (multi-channel-router)', () => {
  describe('greeting branch', () => {
    it('returns the WhatsApp greeting on whatsapp', () => {
      const req = makeChatRequest({ channel: 'whatsapp', message: 'hi' });
      expect(routerResponse(req)).toEqual({
        message: 'Welcome to our WhatsApp line! How can we help?'
      });
    });

    it('returns the Messenger greeting on messenger', () => {
      const req = makeChatRequest({
        channel: 'messenger',
        message: 'hello',
        capabilities: ['typing_indicator', 'reaction', 'reply_to'] // no template
      });
      expect(routerResponse(req)).toEqual({
        message: 'Hi from our Facebook Page! What can we do for you?'
      });
    });

    it('returns the Instagram greeting on instagram', () => {
      const req = makeChatRequest({
        channel: 'instagram',
        message: 'hey',
        capabilities: ['reaction'] // no template
      });
      expect(routerResponse(req)).toEqual({
        message: 'Hey there on Instagram! How can we help?'
      });
    });
  });

  describe('capability-driven template branch', () => {
    it('fires a template action when the channel supports templates (whatsapp)', () => {
      const req = makeChatRequest({ channel: 'whatsapp', message: 'send me a template please' });
      expect(routerResponse(req)).toEqual({
        actions: [{ type: 'template', name: 'hello_world', language: 'en_US' }]
      });
    });

    it('falls back to plain text when the channel lacks templates (messenger)', () => {
      const req = makeChatRequest({
        channel: 'messenger',
        message: 'send me a template please',
        capabilities: ['typing_indicator', 'reaction'] // no template
      });
      expect(routerResponse(req)).toEqual({
        message: 'Thanks for reaching out! A team member will be with you shortly.'
      });
    });

    it('fires a template when the window is closed and templates are supported', () => {
      const req = makeChatRequest({
        channel: 'whatsapp',
        message: 'are you open?',
        context: { windowOpen: false }
      });
      expect(routerResponse(req)).toEqual({
        actions: [{ type: 'template', name: 'hello_world', language: 'en_US' }]
      });
    });

    it('falls back to plain text when the window is closed but templates are unsupported', () => {
      const req = makeChatRequest({
        channel: 'instagram',
        message: 'are you open?',
        capabilities: ['reaction'], // no template
        context: { windowOpen: false }
      });
      expect(routerResponse(req)).toEqual({
        message: 'Thanks for reaching out! A team member will be with you shortly.'
      });
    });
  });

  describe('reaction branch', () => {
    it('reacts back when the latest inbound is a reaction and reactions are supported', () => {
      const req = makeChatRequest({
        channel: 'whatsapp',
        message: '',
        messages: [reactionMessage('r1', '❤️', 'wamid.TARGET')],
        capabilities: ['reaction']
      });
      expect(routerResponse(req)).toEqual({
        actions: [{ type: 'reaction', emoji: '👍', targetMessageId: 'wamid.TARGET' }]
      });
    });

    it('does NOT react when reactions are unsupported (falls through to echo)', () => {
      const req = makeChatRequest({
        channel: 'instagram',
        message: '',
        messages: [reactionMessage('r1', '❤️', 'mid.TARGET', 'instagram')],
        capabilities: [] // no reaction support
      });
      // No reaction action; falls through to the channel-tagged echo (of the
      // empty aggregated text).
      expect(routerResponse(req)).toEqual({ message: '[instagram] You said: ' });
    });
  });

  describe('default branch', () => {
    it('echoes with a channel tag when nothing else matches', () => {
      const req = makeChatRequest({
        channel: 'messenger',
        message: 'what are your hours?',
        capabilities: ['typing_indicator', 'reaction']
      });
      expect(routerResponse(req)).toEqual({
        message: '[messenger] You said: what are your hours?'
      });
    });
  });
});
