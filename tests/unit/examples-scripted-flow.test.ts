/**
 * Unit tests for the scripted-flow example's PURE handler
 * (`scriptedFlowResponse`, examples/scripted-flow).
 *
 * We test only the pure request→response function, injecting a FRESH
 * {@link FlowStore} per case so the in-memory state doesn't leak between tests.
 * Coverage: the arc advances step-by-step across calls sharing a
 * `conversationKey`; a duplicate `channelMessageId` collapses to silence; a
 * closed window with template support emits a template; "restart" resets.
 * Fixtures are built inline via `makeChatRequest`.
 */
import { describe, expect, it } from 'vitest';
import {
  createInMemoryFlowStore,
  scriptedFlowResponse,
  type FlowStore
} from '../../examples/scripted-flow/index.js';
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
 * Minimal {@link ChatRequest} fixture. Defaults to a WhatsApp text turn with the
 * full capability set and an open window. `mid` controls the inbound message id
 * (so tests can drive the dedupe path).
 */
function makeChatRequest(
  overrides: Partial<ChatRequest> & { mid?: string } = {}
): ChatRequest {
  const channel = overrides.channel ?? 'whatsapp';
  const message = overrides.message ?? 'hi';
  const mid = overrides.mid ?? 'mid-1';
  const capabilities: ChannelFeature[] =
    overrides.capabilities ?? ['typing_indicator', 'reaction', 'reply_to', 'template', 'media_send'];
  return {
    channel,
    conversationKey: overrides.conversationKey ?? `${channel}:biz-1:user-1`,
    message,
    messages: overrides.messages ?? [textMessage(mid, message, channel)],
    capabilities,
    context: overrides.context ?? { windowOpen: true }
  };
}

describe('scriptedFlowResponse (scripted-flow)', () => {
  describe('the arc advances step-by-step for one conversationKey', () => {
    it('walks greet → size → milk → name → done with a fresh store', () => {
      const store: FlowStore = createInMemoryFlowStore();

      // greet → size: first contact greets and asks for size.
      const greet = scriptedFlowResponse(makeChatRequest({ mid: 'm1', message: 'hi' }), store);
      expect(greet.message).toMatch(/what size/i);

      // size → milk: captures the size, acks with a reaction (supported), asks milk.
      const size = scriptedFlowResponse(makeChatRequest({ mid: 'm2', message: 'large' }), store);
      expect(size.actions).toEqual([
        { type: 'reaction', emoji: '👍', targetMessageId: 'm2' },
        { type: 'message', text: 'Great — a large. What milk? (whole, oat, none)' }
      ]);

      // milk → name: captures the milk, asks for a name via a threaded reply.
      const milk = scriptedFlowResponse(makeChatRequest({ mid: 'm3', message: 'oat' }), store);
      expect(milk.actions).toEqual([
        {
          type: 'reply',
          text: 'Got it — oat milk. What name should we put on the order?',
          targetMessageId: 'm3'
        }
      ]);

      // name → done: captures the name and confirms pickup with the full order.
      const name = scriptedFlowResponse(makeChatRequest({ mid: 'm4', message: 'Amir' }), store);
      expect(name.message).toContain('Amir');
      expect(name.message).toContain('large');
      expect(name.message).toContain('oat');

      // done: subsequent turns nudge toward restart.
      const after = scriptedFlowResponse(makeChatRequest({ mid: 'm5', message: 'thanks' }), store);
      expect(after.message).toMatch(/restart/i);
    });
  });

  describe('capability degradation across the arc', () => {
    it('skips the reaction ack and uses a plain message when reaction is unsupported', () => {
      const store = createInMemoryFlowStore();
      // greet (no reaction/reply_to capability).
      scriptedFlowResponse(makeChatRequest({ mid: 'm1', message: 'hi', capabilities: [] }), store);
      // size → milk: no reaction → just the plain follow-up message.
      const size = scriptedFlowResponse(makeChatRequest({ mid: 'm2', message: 'small', capabilities: [] }), store);
      expect(size).toEqual({ message: 'Great — a small. What milk? (whole, oat, none)' });
    });

    it('uses a plain message instead of a reply when reply_to is unsupported', () => {
      const store = createInMemoryFlowStore();
      scriptedFlowResponse(makeChatRequest({ mid: 'm1', message: 'hi', capabilities: [] }), store);
      scriptedFlowResponse(makeChatRequest({ mid: 'm2', message: 'small', capabilities: [] }), store);
      const milk = scriptedFlowResponse(makeChatRequest({ mid: 'm3', message: 'none', capabilities: [] }), store);
      expect(milk).toEqual({
        message: 'Got it — none milk. What name should we put on the order?'
      });
    });
  });

  describe('dedupe', () => {
    it('returns silence on a duplicate channelMessageId', () => {
      const store = createInMemoryFlowStore();
      // First sighting advances greet → size.
      const first = scriptedFlowResponse(makeChatRequest({ mid: 'dup', message: 'hi' }), store);
      expect(first.message).toMatch(/what size/i);
      // Same id again → silence (no further advance).
      const second = scriptedFlowResponse(makeChatRequest({ mid: 'dup', message: 'hi' }), store);
      expect(second).toEqual({ silence: true });
    });

    it('does not dedupe blank message ids (synthetic turns)', () => {
      const store = createInMemoryFlowStore();
      const first = scriptedFlowResponse(makeChatRequest({ mid: '', message: 'hi' }), store);
      expect(first.message).toMatch(/what size/i);
      // A second blank-id turn is NOT treated as a duplicate; it advances.
      const second = scriptedFlowResponse(makeChatRequest({ mid: '', message: 'large' }), store);
      expect(second.actions?.some((a) => a.type === 'message')).toBe(true);
    });
  });

  describe('closed window re-engagement', () => {
    it('emits a template action when the window is closed and templates are supported', () => {
      const store = createInMemoryFlowStore();
      const res = scriptedFlowResponse(
        makeChatRequest({ mid: 'm1', message: 'hi', context: { windowOpen: false }, capabilities: ['template'] }),
        store
      );
      expect(res).toEqual({ actions: [{ type: 'template', name: 'hello_world', language: 'en_US' }] });
    });

    it('degrades to a plain message when the window is closed but templates are unsupported', () => {
      const store = createInMemoryFlowStore();
      const res = scriptedFlowResponse(
        makeChatRequest({ mid: 'm1', message: 'hi', context: { windowOpen: false }, capabilities: [] }),
        store
      );
      expect(res.message).toMatch(/message us again/i);
    });
  });

  describe('restart', () => {
    it('resets the arc back to the size step from anywhere', () => {
      const store = createInMemoryFlowStore();
      // Advance a couple of steps.
      scriptedFlowResponse(makeChatRequest({ mid: 'm1', message: 'hi' }), store);
      scriptedFlowResponse(makeChatRequest({ mid: 'm2', message: 'large' }), store);
      // Restart drops back to asking for size.
      const restart = scriptedFlowResponse(makeChatRequest({ mid: 'm3', message: 'restart' }), store);
      expect(restart.message).toMatch(/starting over/i);
      expect(restart.message).toMatch(/what size/i);
      // The very next turn is treated as a size answer again (state was reset).
      const size = scriptedFlowResponse(makeChatRequest({ mid: 'm4', message: 'medium' }), store);
      expect(size.actions).toEqual([
        { type: 'reaction', emoji: '👍', targetMessageId: 'm4' },
        { type: 'message', text: 'Great — a medium. What milk? (whole, oat, none)' }
      ]);
    });
  });

  describe('store isolation', () => {
    it('keeps separate state per conversationKey', () => {
      const store = createInMemoryFlowStore();
      // Conversation A greets.
      scriptedFlowResponse(makeChatRequest({ conversationKey: 'A', mid: 'a1', message: 'hi' }), store);
      // Conversation B is independent — its first turn also greets.
      const b = scriptedFlowResponse(makeChatRequest({ conversationKey: 'B', mid: 'b1', message: 'hi' }), store);
      expect(b.message).toMatch(/what size/i);
    });
  });
});
