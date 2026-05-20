/**
 * Unit tests for `normalizeChatResponse` (`src/chat/contract.ts`).
 *
 * Covers every supported response form (legacy `message` / `messages`,
 * explicit `silence`, rich `actions[]`), the mixed-silence drop, per-action
 * validation, and the two reject-with-throw shapes (non-object and
 * unrecognized object). XML tagging is intentionally out of scope here.
 */
import { describe, expect, it } from 'vitest';
import { normalizeChatResponse } from '../../src/chat/contract.js';
import { ChatEndpointError } from '../../src/chat/errors.js';
import type { ChatAction } from '../../src/chat/types.js';

describe('normalizeChatResponse — legacy message', () => {
  it('maps a non-empty `message` to one message action', () => {
    const result = normalizeChatResponse({ message: 'hello there' });
    expect(result).toEqual({ actions: [{ type: 'message', text: 'hello there' }] });
    expect(result.warnings).toBeUndefined();
    expect(result.silence).toBeUndefined();
  });

  it('drops an empty/whitespace `message` (no actions, no warning)', () => {
    const result = normalizeChatResponse({ message: '   ' });
    // `message` is present (recognized shape) but blank -> nothing to say.
    expect(result).toEqual({ actions: [] });
  });
});

describe('normalizeChatResponse — legacy messages[]', () => {
  it('maps each non-empty entry to a message action in order', () => {
    const result = normalizeChatResponse({ messages: ['one', 'two', 'three'] });
    expect(result.actions).toEqual([
      { type: 'message', text: 'one' },
      { type: 'message', text: 'two' },
      { type: 'message', text: 'three' }
    ]);
  });

  it('skips empty/whitespace and non-string entries', () => {
    const result = normalizeChatResponse({ messages: ['keep', '', '   ', 42, 'also'] });
    expect(result.actions).toEqual([
      { type: 'message', text: 'keep' },
      { type: 'message', text: 'also' }
    ]);
  });

  it('emits `message` before `messages[]` when both are present', () => {
    const result = normalizeChatResponse({ message: 'first', messages: ['second', 'third'] });
    expect(result.actions).toEqual([
      { type: 'message', text: 'first' },
      { type: 'message', text: 'second' },
      { type: 'message', text: 'third' }
    ]);
  });

  it('returns empty actions for an empty messages[] array (recognized shape)', () => {
    expect(normalizeChatResponse({ messages: [] })).toEqual({ actions: [] });
  });
});

describe('normalizeChatResponse — silence', () => {
  it('returns explicit silence for `silence: true`', () => {
    expect(normalizeChatResponse({ silence: true })).toEqual({ actions: [], silence: true });
  });

  it('drops the response with a warning when silence is mixed with a message', () => {
    const result = normalizeChatResponse({ silence: true, message: 'hi' });
    expect(result.actions).toEqual([]);
    expect(result.silence).toBeUndefined();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings?.[0].code).toBe('mixed-silence-actions');
  });

  it('drops the response with a warning when silence is mixed with actions', () => {
    const result = normalizeChatResponse({
      silence: true,
      actions: [{ type: 'message', text: 'hi' }]
    });
    expect(result.actions).toEqual([]);
    expect(result.warnings?.[0].code).toBe('mixed-silence-actions');
  });

  it('does NOT treat silence + only-blank message as mixed', () => {
    // A blank message is not real content, so silence still wins cleanly.
    expect(normalizeChatResponse({ silence: true, message: '  ' })).toEqual({
      actions: [],
      silence: true
    });
  });
});

describe('normalizeChatResponse — rich actions passthrough', () => {
  it('passes a message action through', () => {
    expect(normalizeChatResponse({ actions: [{ type: 'message', text: 'hi' }] })).toEqual({
      actions: [{ type: 'message', text: 'hi' }]
    });
  });

  it('passes a reply action through', () => {
    const action: ChatAction = { type: 'reply', text: 'sure', targetMessageId: 'wamid.1' };
    expect(normalizeChatResponse({ actions: [action] })).toEqual({ actions: [action] });
  });

  it('passes a reaction action through', () => {
    const action: ChatAction = { type: 'reaction', emoji: '👍', targetMessageId: 'wamid.2' };
    expect(normalizeChatResponse({ actions: [action] })).toEqual({ actions: [action] });
  });

  it('passes a media action through, keeping optional caption/mimeType', () => {
    const action: ChatAction = {
      type: 'media',
      url: 'https://x/y.jpg',
      caption: 'look',
      mimeType: 'image/jpeg'
    };
    expect(normalizeChatResponse({ actions: [action] })).toEqual({ actions: [action] });
  });

  it('passes a template action through with components', () => {
    const action: ChatAction = {
      type: 'template',
      name: 'order_update',
      language: 'en_US',
      components: [{ type: 'body', parameters: [] }]
    };
    expect(normalizeChatResponse({ actions: [action] })).toEqual({ actions: [action] });
  });

  it('passes a typing action through (with and without durationMs)', () => {
    expect(normalizeChatResponse({ actions: [{ type: 'typing', durationMs: 1500 }] })).toEqual({
      actions: [{ type: 'typing', durationMs: 1500 }]
    });
    expect(normalizeChatResponse({ actions: [{ type: 'typing' }] })).toEqual({
      actions: [{ type: 'typing' }]
    });
  });

  it('collapses an actions[] of only silence to explicit silence', () => {
    expect(normalizeChatResponse({ actions: [{ type: 'silence' }] })).toEqual({
      actions: [],
      silence: true
    });
  });

  it('drops a silence action sitting alongside real content (no warning)', () => {
    const result = normalizeChatResponse({
      actions: [{ type: 'message', text: 'hi' }, { type: 'silence' }]
    });
    expect(result).toEqual({ actions: [{ type: 'message', text: 'hi' }] });
  });

  it('preserves the order of multiple valid actions', () => {
    const result = normalizeChatResponse({
      actions: [
        { type: 'typing', durationMs: 500 },
        { type: 'message', text: 'a' },
        { type: 'reaction', emoji: '🔥', targetMessageId: 'm1' }
      ]
    });
    expect(result.actions.map(a => a.type)).toEqual(['typing', 'message', 'reaction']);
  });
});

describe('normalizeChatResponse — invalid actions dropped with warning', () => {
  it('drops a reply missing targetMessageId', () => {
    const result = normalizeChatResponse({
      actions: [{ type: 'reply', text: 'hi' }, { type: 'message', text: 'ok' }]
    });
    expect(result.actions).toEqual([{ type: 'message', text: 'ok' }]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings?.[0].code).toBe('invalid-action');
    expect(result.warnings?.[0].message).toContain('targetMessageId');
  });

  it('drops a reaction missing emoji', () => {
    const result = normalizeChatResponse({
      actions: [{ type: 'reaction', targetMessageId: 'm1' }]
    });
    // Only-invalid actions leave an empty list (no surviving silence).
    expect(result.actions).toEqual([]);
    expect(result.warnings?.[0].code).toBe('invalid-action');
    expect(result.warnings?.[0].message).toContain('emoji');
  });

  it('drops a message with empty text', () => {
    const result = normalizeChatResponse({ actions: [{ type: 'message', text: '   ' }] });
    expect(result.actions).toEqual([]);
    expect(result.warnings?.[0].code).toBe('invalid-action');
  });

  it('drops a media action missing url', () => {
    const result = normalizeChatResponse({ actions: [{ type: 'media', caption: 'x' }] });
    expect(result.warnings?.[0].message).toContain('url');
  });

  it('drops a template missing language', () => {
    const result = normalizeChatResponse({ actions: [{ type: 'template', name: 'n' }] });
    expect(result.warnings?.[0].message).toContain('language');
  });

  it('drops an unknown action type with a warning', () => {
    const result = normalizeChatResponse({
      actions: [{ type: 'explode' }, { type: 'message', text: 'safe' }]
    });
    expect(result.actions).toEqual([{ type: 'message', text: 'safe' }]);
    expect(result.warnings?.[0].message).toContain('explode');
  });

  it('drops a non-object / typeless action entry', () => {
    const result = normalizeChatResponse({ actions: [null, 'nope', { type: 'message', text: 'k' }] as never });
    expect(result.actions).toEqual([{ type: 'message', text: 'k' }]);
    expect(result.warnings).toHaveLength(2);
  });
});

describe('normalizeChatResponse — rejected payloads', () => {
  it('throws on null', () => {
    expect(() => normalizeChatResponse(null)).toThrow(ChatEndpointError);
    expect(() => normalizeChatResponse(null)).toThrow('must be an object');
  });

  it('throws on a non-object (string / number)', () => {
    expect(() => normalizeChatResponse('hi')).toThrow(ChatEndpointError);
    expect(() => normalizeChatResponse(7)).toThrow(ChatEndpointError);
  });

  it('throws on an array payload', () => {
    expect(() => normalizeChatResponse([{ type: 'message', text: 'x' }])).toThrow(ChatEndpointError);
  });

  it('throws on an unrecognized object shape', () => {
    expect(() => normalizeChatResponse({ foo: 1 })).toThrow(ChatEndpointError);
    expect(() => normalizeChatResponse({ foo: 1 })).toThrow(
      'did not include message, messages, actions, or silence'
    );
  });
});
