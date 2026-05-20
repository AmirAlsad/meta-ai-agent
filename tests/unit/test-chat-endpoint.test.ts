/**
 * Unit tests for `buildTestChatResponse` (the pure keyword router in
 * `scripts/dev/test-chat-endpoint.ts`). One case per keyword plus the default
 * echo. We do NOT test the Express server or the loop orchestration here.
 */
import { describe, expect, it } from 'vitest';
import { buildTestChatResponse } from '../../scripts/dev/test-chat-endpoint.js';
import type { ChatRequest } from '../../src/chat/types.js';
import type { Channel, IncomingMessage } from '../../src/meta/types.js';

function msg(channelMessageId: string, text: string): IncomingMessage {
  return {
    channel: 'whatsapp',
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
 * Minimal ChatRequest fixture. `messages` carries a couple of IncomingMessages
 * so `messages.length` and `lastMid` (last entry) are exercised; `message` is
 * the aggregated text the router scans.
 */
function req(message: string, opts: { channel?: Channel; messages?: IncomingMessage[] } = {}): ChatRequest {
  const messages = opts.messages ?? [msg('mid-1', 'first'), msg('mid-2', message)];
  return {
    channel: opts.channel ?? 'whatsapp',
    conversationKey: 'whatsapp:biz-1:user-1',
    message,
    messages,
    capabilities: ['typing_indicator', 'reaction'],
    context: { windowOpen: true }
  };
}

describe('buildTestChatResponse', () => {
  it('silence → explicit silence', () => {
    expect(buildTestChatResponse(req('please silence now'))).toEqual({ silence: true });
  });

  it('multi → three message actions in order', () => {
    expect(buildTestChatResponse(req('multi please'))).toEqual({
      actions: [
        { type: 'message', text: 'first' },
        { type: 'message', text: 'second' },
        { type: 'message', text: 'third' }
      ]
    });
  });

  it('react → reaction action targeting the last message id', () => {
    const result = buildTestChatResponse(req('react', { messages: [msg('a', 'hi'), msg('b', 'react')] }));
    expect(result).toEqual({
      actions: [{ type: 'reaction', emoji: '👍', targetMessageId: 'b' }]
    });
  });

  it('reply → reply action targeting the last message id', () => {
    const result = buildTestChatResponse(req('reply', { messages: [msg('x', 'yo'), msg('y', 'reply')] }));
    expect(result).toEqual({
      actions: [{ type: 'reply', text: '↩️ quoted reply', targetMessageId: 'y' }]
    });
  });

  it('typing → typing action followed by a message action', () => {
    expect(buildTestChatResponse(req('typing test'))).toEqual({
      actions: [
        { type: 'typing', durationMs: 3000 },
        { type: 'message', text: 'done "typing"' }
      ]
    });
  });

  it('template → template action', () => {
    expect(buildTestChatResponse(req('send a template'))).toEqual({
      actions: [{ type: 'template', name: 'hello_world', language: 'en_US' }]
    });
  });

  it('media → media action with caption', () => {
    expect(buildTestChatResponse(req('send media'))).toEqual({
      actions: [
        { type: 'media', url: 'https://www.gstatic.com/webp/gallery/1.jpg', caption: 'sample' }
      ]
    });
  });

  it('default → echo whose text includes the channel and buffered message count', () => {
    const result = buildTestChatResponse(
      req('hello world', {
        channel: 'messenger',
        messages: [msg('1', 'a'), msg('2', 'b'), msg('3', 'hello world')]
      })
    );
    expect(result).toEqual({ message: 'echo [messenger] (3 msg): hello world' });
  });

  it('default echo reflects a single-message turn count', () => {
    const result = buildTestChatResponse(
      req('just one', { channel: 'instagram', messages: [msg('only', 'just one')] })
    );
    expect(result).toEqual({ message: 'echo [instagram] (1 msg): just one' });
  });

  it('matches keywords case-insensitively', () => {
    expect(buildTestChatResponse(req('SILENCE'))).toEqual({ silence: true });
    expect(buildTestChatResponse(req('MULTI'))).toEqual({
      actions: [
        { type: 'message', text: 'first' },
        { type: 'message', text: 'second' },
        { type: 'message', text: 'third' }
      ]
    });
  });
});
