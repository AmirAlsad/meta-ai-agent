/**
 * Unit tests for the Stage 5 {@link ConversationAgent} state machine.
 *
 * Uses the REAL {@link InMemoryConversationStore} and {@link
 * InMemoryBufferScheduler} (driven via `vi.useFakeTimers()` so the buffer-flush
 * and delivery-timeout timers advance deterministically), a fake `ChatClient`
 * returning canned {@link NormalizedChatResponse}s, and fake `ChannelAdapter`s
 * (vi.fn() sends + a real `supports`). `random`/`now`/`sleep` are injected for
 * determinism (sleep is a no-op so typing delays don't actually wait).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { ConversationAgent } from '../../src/conversation/agent.js';
import { InMemoryConversationStore } from '../../src/conversation/store.js';
import { InMemoryBufferScheduler } from '../../src/conversation/scheduler.js';
import { ChatEndpointError } from '../../src/chat/errors.js';
import type { ChatClient } from '../../src/chat/client.js';
import type { ChatRequest, NormalizedChatResponse } from '../../src/chat/types.js';
import type {
  ChannelAdapter,
  ChannelFeature,
  SendResult
} from '../../src/meta/shared/adapter.js';
import type { Channel, IncomingMessage, StatusUpdate } from '../../src/meta/types.js';
import { defaultConversationConfig, type Config } from '../../src/config/loader.js';

/* ──────────────────────────────────────────────────────────────────────── */
/* Fixtures                                                                  */
/* ──────────────────────────────────────────────────────────────────────── */

const FIXED_NOW = 1_700_000_000_000;
const silentLogger = pino({ level: 'silent' });

/** A `Config` with only the fields the agent reads; conversation knobs default. */
function makeConfig(): Config {
  return {
    meta: { appId: undefined, appSecret: 's', verifyToken: 'x'.repeat(16), graphApiVersion: 'v25.0' },
    channels: { whatsapp: true, messenger: true, instagram: true },
    conversation: defaultConversationConfig(),
    chatEndpointUrl: 'https://example.test/chat',
    ngrokDomain: 'foo.ngrok-free.app',
    agentAutostart: false,
    port: 3000,
    nodeEnv: 'test'
  } as Config;
}

/** WhatsApp supports text/typing/reaction/reply/template; not media. */
function whatsappSupports(feature: ChannelFeature): boolean {
  return (
    feature === 'typing_indicator' ||
    feature === 'read_receipt' ||
    feature === 'reaction' ||
    feature === 'reply_to' ||
    feature === 'template'
  );
}

/** Messenger supports typing/reaction/reply + the profile surfaces; no template. */
function messengerSupports(feature: ChannelFeature): boolean {
  return (
    feature === 'typing_indicator' ||
    feature === 'reaction' ||
    feature === 'reply_to' ||
    feature === 'persistent_menu' ||
    feature === 'get_started' ||
    feature === 'ice_breakers'
  );
}

interface FakeAdapter extends ChannelAdapter {
  sendText: ReturnType<typeof vi.fn>;
  sendTypingIndicator: ReturnType<typeof vi.fn>;
  markRead: ReturnType<typeof vi.fn>;
  sendReaction: ReturnType<typeof vi.fn>;
  sendTemplate?: ReturnType<typeof vi.fn>;
}

let messageIdCounter = 0;

function makeAdapter(
  channel: Channel,
  supports: (f: ChannelFeature) => boolean,
  opts: { template?: boolean } = {}
): FakeAdapter {
  const sendResult = (recipientId: string): SendResult => ({
    channel,
    messageId: `${channel}-msg-${++messageIdCounter}`,
    recipientId,
    timestamp: FIXED_NOW
  });
  const adapter: FakeAdapter = {
    channel,
    supports,
    sendText: vi.fn(async (recipientId: string) => sendResult(recipientId)),
    sendTypingIndicator: vi.fn(async () => undefined),
    markRead: vi.fn(async () => undefined),
    sendReaction: vi.fn(async () => undefined)
  };
  if (opts.template) {
    adapter.sendTemplate = vi.fn(async (recipientId: string) => sendResult(recipientId));
  }
  return adapter;
}

/** A ChatClient whose `complete` returns a queue of canned responses. */
function makeChatClient(
  responses: NormalizedChatResponse[]
): ChatClient & { complete: ReturnType<typeof vi.fn>; calls: ChatRequest[] } {
  const calls: ChatRequest[] = [];
  let i = 0;
  const complete = vi.fn(async (request: ChatRequest) => {
    calls.push(request);
    const resp = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return resp;
  });
  return { complete, calls };
}

function inbound(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    channel: 'whatsapp',
    channelMessageId: `wamid.${Math.random().toString(36).slice(2)}`,
    channelScopedUserId: 'user-1',
    channelScopedBusinessId: 'biz-1',
    timestamp: FIXED_NOW,
    type: 'text',
    text: 'hello',
    raw: {},
    ...overrides
  };
}

interface Harness {
  agent: ConversationAgent;
  store: InMemoryConversationStore;
  scheduler: InMemoryBufferScheduler;
  chat: ReturnType<typeof makeChatClient>;
  adapters: Partial<Record<Channel, FakeAdapter>>;
}

function makeHarness(opts: {
  responses: NormalizedChatResponse[];
  adapters?: Partial<Record<Channel, FakeAdapter>>;
  configMutate?: (c: Config) => void;
}): Harness {
  const config = makeConfig();
  opts.configMutate?.(config);
  const store = new InMemoryConversationStore({ dedupeTtlSeconds: config.conversation.dedupeTtlSeconds });
  const scheduler = new InMemoryBufferScheduler();
  const chat = makeChatClient(opts.responses);
  const adapters: Partial<Record<Channel, FakeAdapter>> = opts.adapters ?? {
    whatsapp: makeAdapter('whatsapp', whatsappSupports, { template: true }),
    messenger: makeAdapter('messenger', messengerSupports)
  };
  const agent = new ConversationAgent({
    store,
    scheduler,
    chatClient: chat,
    adapters: adapters as Partial<Record<Channel, ChannelAdapter>>,
    config,
    logger: silentLogger,
    random: () => 0.5, // mid-range jitter, fully deterministic
    now: () => FIXED_NOW,
    sleep: async () => undefined // no-op so typing delays don't wait
  });
  return { agent, store, scheduler, chat, adapters };
}

/** Advance fake timers far enough to fire the longest possible buffer flush. */
async function flushBuffer(): Promise<void> {
  // bufferMaxTimeoutMs * 1.5 ceiling = 12_000; go well past it.
  await vi.advanceTimersByTimeAsync(20_000);
}

const textResponse = (text: string): NormalizedChatResponse => ({ actions: [{ type: 'message', text }] });

/* ──────────────────────────────────────────────────────────────────────── */
/* Tests                                                                     */
/* ──────────────────────────────────────────────────────────────────────── */

describe('ConversationAgent', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    messageIdCounter = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('inbound → flush → chat called with correct request → adapter sends the reply', async () => {
    const h = makeHarness({ responses: [textResponse('hi there')] });

    await h.agent.handleInbound(inbound({ text: 'hello', channelMessageId: 'wamid.1' }));
    expect(h.chat.complete).not.toHaveBeenCalled(); // still buffering

    await flushBuffer();

    expect(h.chat.complete).toHaveBeenCalledTimes(1);
    const req = h.chat.calls[0]!;
    expect(req.channel).toBe('whatsapp');
    expect(req.conversationKey).toBe('whatsapp:biz-1:user-1');
    expect(req.message).toBe('hello');
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0]!.channelMessageId).toBe('wamid.1');
    expect(req.context.windowOpen).toBe(true);
    // capabilities reflect the WhatsApp adapter's supports().
    expect(req.capabilities).toContain('template');
    expect(req.capabilities).toContain('reaction');
    expect(req.capabilities).not.toContain('media_send');

    expect(h.adapters.whatsapp!.sendText).toHaveBeenCalledTimes(1);
    expect(h.adapters.whatsapp!.sendText).toHaveBeenCalledWith('user-1', 'hi there');
  });

  it('dedupe: the same channelMessageId twice is buffered/processed once', async () => {
    const h = makeHarness({ responses: [textResponse('reply')] });
    const msg = inbound({ channelMessageId: 'wamid.dup' });

    await h.agent.handleInbound(msg);
    await h.agent.handleInbound({ ...msg }); // redelivery
    await flushBuffer();

    expect(h.chat.complete).toHaveBeenCalledTimes(1);
    expect(h.chat.calls[0]!.messages).toHaveLength(1);
  });

  it('echo: an is_echo message is never buffered and the chat is never called', async () => {
    const h = makeHarness({ responses: [textResponse('reply')] });

    await h.agent.handleInbound(inbound({ isEcho: true, channel: 'messenger', channelMessageId: 'm_echo' }));
    await flushBuffer();

    expect(h.chat.complete).not.toHaveBeenCalled();
    expect(h.adapters.messenger!.sendText).not.toHaveBeenCalled();
  });

  it('buffering: two rapid inbounds before flush → ONE flush, batch has both, message concatenated', async () => {
    const h = makeHarness({ responses: [textResponse('ok')] });

    await h.agent.handleInbound(inbound({ text: 'first', channelMessageId: 'wamid.a' }));
    await vi.advanceTimersByTimeAsync(500); // within the burst window
    await h.agent.handleInbound(inbound({ text: 'second', channelMessageId: 'wamid.b' }));
    await flushBuffer();

    expect(h.chat.complete).toHaveBeenCalledTimes(1);
    const req = h.chat.calls[0]!;
    expect(req.messages).toHaveLength(2);
    expect(req.message).toBe('first\nsecond');
  });

  it('cross-channel isolation: WhatsApp + Messenger inbounds → two records, each to its own adapter', async () => {
    const h = makeHarness({ responses: [textResponse('wa-reply'), textResponse('fb-reply')] });

    await h.agent.handleInbound(inbound({ channel: 'whatsapp', channelMessageId: 'wamid.x', channelScopedUserId: 'wa-user' }));
    await h.agent.handleInbound(inbound({ channel: 'messenger', channelMessageId: 'm_y', channelScopedUserId: 'fb-user' }));
    await flushBuffer();

    expect(h.chat.complete).toHaveBeenCalledTimes(2);
    const waReq = h.chat.calls.find(c => c.channel === 'whatsapp')!;
    const fbReq = h.chat.calls.find(c => c.channel === 'messenger')!;
    expect(waReq.conversationKey).toBe('whatsapp:biz-1:wa-user');
    expect(fbReq.conversationKey).toBe('messenger:biz-1:fb-user');

    expect(h.adapters.whatsapp!.sendText).toHaveBeenCalledTimes(1);
    expect(h.adapters.messenger!.sendText).toHaveBeenCalledTimes(1);
    expect(h.adapters.whatsapp!.sendText).toHaveBeenCalledWith('wa-user', expect.any(String));
    expect(h.adapters.messenger!.sendText).toHaveBeenCalledWith('fb-user', expect.any(String));
  });

  it('silence response → no sends', async () => {
    const h = makeHarness({ responses: [{ actions: [], silence: true }] });

    await h.agent.handleInbound(inbound());
    await flushBuffer();

    expect(h.chat.complete).toHaveBeenCalledTimes(1);
    expect(h.adapters.whatsapp!.sendText).not.toHaveBeenCalled();
    const record = await h.store.getConversation('whatsapp:biz-1:user-1');
    expect(record!.state).toBe('idle');
  });

  it('Messenger (on_send): two message actions both send in sequence', async () => {
    const h = makeHarness({
      responses: [{ actions: [{ type: 'message', text: 'one' }, { type: 'message', text: 'two' }] }]
    });

    await h.agent.handleInbound(inbound({ channel: 'messenger', channelMessageId: 'm_1', channelScopedUserId: 'fb-user' }));
    await flushBuffer();

    expect(h.adapters.messenger!.sendText).toHaveBeenCalledTimes(2);
    expect(h.adapters.messenger!.sendText).toHaveBeenNthCalledWith(1, 'fb-user', 'one');
    expect(h.adapters.messenger!.sendText).toHaveBeenNthCalledWith(2, 'fb-user', 'two');
    const record = await h.store.getConversation('messenger:biz-1:fb-user');
    expect(record!.state).toBe('idle');
  });

  it('WhatsApp (on_status): only the FIRST sends; a delivered status releases the SECOND', async () => {
    const h = makeHarness({
      responses: [{ actions: [{ type: 'message', text: 'one' }, { type: 'message', text: 'two' }] }]
    });

    await h.agent.handleInbound(inbound({ channelMessageId: 'wamid.s1' }));
    await flushBuffer();

    // Only the first message has been sent; the queue waits on a status.
    expect(h.adapters.whatsapp!.sendText).toHaveBeenCalledTimes(1);
    const key = 'whatsapp:biz-1:user-1';
    const mid = h.adapters.whatsapp!.sendText.mock.results[0]!.value as Promise<SendResult>;
    const firstId = (await mid).messageId;

    const recordWaiting = await h.store.getConversation(key);
    expect(recordWaiting!.state).toBe('sending');
    expect(recordWaiting!.currentOutboundIndex).toBe(0);
    expect(recordWaiting!.currentOutboundMessageId).toBe(firstId);

    // Deliver a status for the in-flight message → the second message sends.
    await h.agent.handleStatus(status(firstId, 'delivered'));
    expect(h.adapters.whatsapp!.sendText).toHaveBeenCalledTimes(2);
    expect(h.adapters.whatsapp!.sendText).toHaveBeenNthCalledWith(2, 'user-1', 'two');

    // The LAST WhatsApp message is itself on_status — the queue stays `sending`
    // until its own delivery status arrives (true ordered delivery).
    const afterSecond = await h.store.getConversation(key);
    expect(afterSecond!.state).toBe('sending');
    expect(afterSecond!.currentOutboundIndex).toBe(1);
    const secondId = (await (h.adapters.whatsapp!.sendText.mock.results[1]!.value as Promise<SendResult>)).messageId;

    // Status for the second/last message → queue completes → idle.
    await h.agent.handleStatus(status(secondId, 'delivered'));
    const record = await h.store.getConversation(key);
    expect(record!.state).toBe('idle');
    expect(record!.currentOutboundIndex).toBe(2);
  });

  it('reaction action → adapter.sendReaction called with (userId, targetMessageId, emoji)', async () => {
    const h = makeHarness({
      responses: [{ actions: [{ type: 'reaction', emoji: '👍', targetMessageId: 'wamid.target' }] }]
    });

    await h.agent.handleInbound(inbound({ channelMessageId: 'wamid.r1' }));
    await flushBuffer();

    expect(h.adapters.whatsapp!.sendReaction).toHaveBeenCalledTimes(1);
    expect(h.adapters.whatsapp!.sendReaction).toHaveBeenCalledWith('user-1', 'wamid.target', '👍');
    // reaction is fire-and-forget → queue completes without waiting on a status.
    const record = await h.store.getConversation('whatsapp:biz-1:user-1');
    expect(record!.state).toBe('idle');
  });

  it('reply action → adapter.sendText with { replyTo }', async () => {
    const h = makeHarness({
      responses: [{ actions: [{ type: 'reply', text: 'threaded', targetMessageId: 'wamid.parent' }] }]
    });

    await h.agent.handleInbound(inbound({ channel: 'messenger', channelMessageId: 'm_rep', channelScopedUserId: 'fb-user' }));
    await flushBuffer();

    expect(h.adapters.messenger!.sendText).toHaveBeenCalledWith('fb-user', 'threaded', { replyTo: 'wamid.parent' });
  });

  it('typing injection: when enabled+supported, sendTypingIndicator is called before sendText', async () => {
    const h = makeHarness({ responses: [textResponse('hi')] });

    await h.agent.handleInbound(inbound({ channelMessageId: 'wamid.t1' }));
    await flushBuffer();

    const adapter = h.adapters.whatsapp!;
    expect(adapter.sendTypingIndicator).toHaveBeenCalledTimes(1);
    // typing is anchored to the last inbound message id on WhatsApp.
    expect(adapter.sendTypingIndicator).toHaveBeenCalledWith('user-1', 'wamid.t1');
    const typingOrder = adapter.sendTypingIndicator.mock.invocationCallOrder[0]!;
    const textOrder = adapter.sendText.mock.invocationCallOrder[0]!;
    expect(typingOrder).toBeLessThan(textOrder);
  });

  it('typing injection is skipped when outboundTypingIndicatorsEnabled is false', async () => {
    const h = makeHarness({
      responses: [textResponse('hi')],
      configMutate: c => {
        c.conversation.outboundTypingIndicatorsEnabled = false;
      }
    });

    await h.agent.handleInbound(inbound({ channelMessageId: 'wamid.t2' }));
    await flushBuffer();

    expect(h.adapters.whatsapp!.sendTypingIndicator).not.toHaveBeenCalled();
    expect(h.adapters.whatsapp!.sendText).toHaveBeenCalledTimes(1);
  });

  it('handleStatus for an unmapped id does not throw and advances nothing', async () => {
    const h = makeHarness({ responses: [textResponse('hi')] });
    await expect(h.agent.handleStatus(status('wamid.never-sent', 'delivered'))).resolves.toBeUndefined();
    expect(h.adapters.whatsapp!.sendText).not.toHaveBeenCalled();
  });

  it('capabilities array exactly reflects adapter.supports', async () => {
    const h = makeHarness({ responses: [textResponse('hi')] });
    await h.agent.handleInbound(inbound({ channel: 'messenger', channelMessageId: 'm_cap', channelScopedUserId: 'fb-user' }));
    await flushBuffer();

    const caps = h.chat.calls[0]!.capabilities;
    expect([...caps].sort()).toEqual(
      ['typing_indicator', 'reaction', 'reply_to', 'persistent_menu', 'get_started', 'ice_breakers'].sort()
    );
  });

  it('template action on WhatsApp routes to sendTemplate', async () => {
    const h = makeHarness({
      responses: [
        {
          actions: [
            {
              type: 'template',
              name: 'order_update',
              language: 'en_US',
              components: [{ type: 'body', parameters: [{ type: 'text', text: 'Ada' }] }]
            }
          ]
        }
      ]
    });

    await h.agent.handleInbound(inbound({ channelMessageId: 'wamid.tmpl' }));
    await flushBuffer();

    const adapter = h.adapters.whatsapp!;
    expect(adapter.sendTemplate).toHaveBeenCalledTimes(1);
    expect(adapter.sendTemplate).toHaveBeenCalledWith('user-1', 'order_update', 'en_US', [
      { type: 'body', parameters: [{ type: 'text', text: 'Ada' }] }
    ]);
    expect(adapter.sendText).not.toHaveBeenCalled();
  });

  it('chat endpoint error fails soft: no send, conversation returns to idle', async () => {
    const config = makeConfig();
    const store = new InMemoryConversationStore({ dedupeTtlSeconds: config.conversation.dedupeTtlSeconds });
    const scheduler = new InMemoryBufferScheduler();
    const adapter = makeAdapter('whatsapp', whatsappSupports, { template: true });
    const complete = vi.fn(async () => {
      throw new ChatEndpointError('boom');
    });
    const agent = new ConversationAgent({
      store,
      scheduler,
      chatClient: { complete } as unknown as ChatClient,
      adapters: { whatsapp: adapter },
      config,
      logger: silentLogger,
      random: () => 0.5,
      now: () => FIXED_NOW,
      sleep: async () => undefined
    });

    await agent.handleInbound(inbound({ channelMessageId: 'wamid.err' }));
    await flushBuffer();

    expect(complete).toHaveBeenCalledTimes(1);
    expect(adapter.sendText).not.toHaveBeenCalled();
    const record = await store.getConversation('whatsapp:biz-1:user-1');
    expect(record!.state).toBe('idle');
    await agent.close();
  });

  it('delivery-timeout fallback (WhatsApp): advancing the timer past the timeout sends the next item', async () => {
    const warnSpy = vi.fn();
    const config = makeConfig();
    const loggerWithWarn = { ...silentLogger, warn: warnSpy, child: () => ({ ...silentLogger, warn: warnSpy }) } as unknown as pino.Logger;
    const store = new InMemoryConversationStore({ dedupeTtlSeconds: config.conversation.dedupeTtlSeconds });
    const scheduler = new InMemoryBufferScheduler();
    const adapter = makeAdapter('whatsapp', whatsappSupports, { template: true });
    const chat = makeChatClient([
      { actions: [{ type: 'message', text: 'one' }, { type: 'message', text: 'two' }] }
    ]);
    const agent = new ConversationAgent({
      store,
      scheduler,
      chatClient: chat,
      adapters: { whatsapp: adapter },
      config,
      logger: loggerWithWarn,
      random: () => 0.5,
      now: () => FIXED_NOW,
      sleep: async () => undefined
    });

    await agent.handleInbound(inbound({ channelMessageId: 'wamid.to1' }));
    await flushBuffer();

    // First message sent, queue waiting on a status that will never come.
    expect(adapter.sendText).toHaveBeenCalledTimes(1);

    // Advance past outboundDeliveryTimeoutMs (default 30s) with no status.
    await vi.advanceTimersByTimeAsync(config.conversation.outboundDeliveryTimeoutMs + 1);

    expect(adapter.sendText).toHaveBeenCalledTimes(2);
    expect(adapter.sendText).toHaveBeenNthCalledWith(2, 'user-1', 'two');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ conversationKey: 'whatsapp:biz-1:user-1' }),
      'delivery status timeout; advancing'
    );

    // The second (last) message is itself awaiting on_status; its own timeout
    // fallback then completes the queue → idle.
    const midState = await store.getConversation('whatsapp:biz-1:user-1');
    expect(midState!.state).toBe('sending');
    await vi.advanceTimersByTimeAsync(config.conversation.outboundDeliveryTimeoutMs + 1);

    const record = await store.getConversation('whatsapp:biz-1:user-1');
    expect(record!.state).toBe('idle');
    expect(record!.currentOutboundIndex).toBe(2);
    await agent.close();
  });

  it('handleReaction delegates to the buffer (reaction reaches chat in messages[])', async () => {
    const h = makeHarness({ responses: [textResponse('noted')] });

    await h.agent.handleReaction(
      inbound({
        type: 'reaction',
        channelMessageId: 'wamid.react',
        text: undefined,
        reaction: { emoji: '❤️', targetMessageId: 'wamid.orig' }
      })
    );
    await flushBuffer();

    expect(h.chat.complete).toHaveBeenCalledTimes(1);
    const req = h.chat.calls[0]!;
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0]!.reaction).toEqual({ emoji: '❤️', targetMessageId: 'wamid.orig' });
    // No text body in the reaction → aggregated message string is empty.
    expect(req.message).toBe('');
  });

  it('close clears delivery timers and closes the scheduler', async () => {
    const h = makeHarness({
      responses: [{ actions: [{ type: 'message', text: 'one' }, { type: 'message', text: 'two' }] }]
    });
    const closeSpy = vi.spyOn(h.scheduler, 'close');

    await h.agent.handleInbound(inbound({ channelMessageId: 'wamid.close' }));
    await flushBuffer();
    // A WhatsApp delivery timeout is now armed; close() must clear it.
    await h.agent.close();

    expect(closeSpy).toHaveBeenCalledTimes(1);
    // After close, advancing time must not fire the (cleared) delivery timeout.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.adapters.whatsapp!.sendText).toHaveBeenCalledTimes(1);
  });

  /* ────────────────────────────────────────────────────────────────────── */
  /* Concurrency: per-key serialization lock (regression tests)             */
  /* ────────────────────────────────────────────────────────────────────── */

  it('concurrent same-key inbound: BOTH messages survive (per-key lock)', async () => {
    // REGRESSION TEST for the message-dropping clobber. Two inbounds for the
    // SAME conversation are fired WITHOUT awaiting between them, so their
    // read-modify-write cycles overlap. Without the per-key lock both flows read
    // the same idle clone, each appends ONE message, and the second write
    // clobbers the first → the buffer ends with a single message (one user
    // message silently lost). With the lock they serialize → the buffer holds
    // BOTH, so the single flushed chat request carries messages.length === 2.
    const h = makeHarness({ responses: [textResponse('ok')] });

    const p1 = h.agent.handleInbound(inbound({ text: 'first', channelMessageId: 'wamid.cc1' }));
    const p2 = h.agent.handleInbound(inbound({ text: 'second', channelMessageId: 'wamid.cc2' }));
    await Promise.all([p1, p2]);

    await flushBuffer();

    expect(h.chat.complete).toHaveBeenCalledTimes(1);
    const req = h.chat.calls[0]!;
    expect(req.messages).toHaveLength(2);
    expect(req.messages.map(m => m.channelMessageId)).toEqual(['wamid.cc1', 'wamid.cc2']);
    expect(req.message).toBe('first\nsecond');
  });

  it('flush vs. late inbound: a message arriving mid-flush is not lost', async () => {
    // While a flush is awaiting a SLOW chat call, a new inbound arrives for the
    // same key. The per-key lock makes the late inbound queue BEHIND the
    // in-flight flush; once the flush releases the lock, the late message is
    // buffered and a fresh flush fires for it. It must reach a SECOND chat call
    // (never dropped, never folded into the already-snapshotted first turn).
    const config = makeConfig();
    const store = new InMemoryConversationStore({ dedupeTtlSeconds: config.conversation.dedupeTtlSeconds });
    const scheduler = new InMemoryBufferScheduler();
    const adapter = makeAdapter('messenger', messengerSupports); // on_send: flush completes synchronously after the send

    // A chat client whose FIRST complete() blocks on a deferred we control; the
    // second resolves immediately.
    const calls: ChatRequest[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    let callIndex = 0;
    const complete = vi.fn(async (request: ChatRequest) => {
      calls.push(request);
      const thisCall = callIndex++;
      if (thisCall === 0) await firstGate;
      return textResponse(`reply-${thisCall}`);
    });

    const agent = new ConversationAgent({
      store,
      scheduler,
      chatClient: { complete } as unknown as ChatClient,
      adapters: { messenger: adapter },
      config,
      logger: silentLogger,
      random: () => 0.5,
      now: () => FIXED_NOW,
      sleep: async () => undefined
    });

    const key = 'messenger:biz-1:fb-user';
    // Buffer the first message and start its flush (which will block in chat).
    await agent.handleInbound(
      inbound({ channel: 'messenger', channelScopedUserId: 'fb-user', text: 'early', channelMessageId: 'm_early' })
    );
    // Kick the flush timer; the flush enters the (gated) chat call and parks
    // there, still holding the per-key lock.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(calls[0]!.messages.map(m => m.channelMessageId)).toEqual(['m_early']);

    // Late inbound for the SAME key while the flush is mid-flight. It must NOT
    // settle yet — the per-key lock is held by the in-flight flush.
    let lateSettled = false;
    const latePromise = agent
      .handleInbound(
        inbound({ channel: 'messenger', channelScopedUserId: 'fb-user', text: 'late', channelMessageId: 'm_late' })
      )
      .then(() => {
        lateSettled = true;
      });
    await Promise.resolve();
    await Promise.resolve();
    expect(lateSettled).toBe(false); // blocked behind the flush

    // Release the first chat call → flush finishes, releases the lock, the late
    // inbound runs and buffers 'late', then arms its own flush timer.
    releaseFirst();
    await latePromise;
    expect(lateSettled).toBe(true);

    // The late message is buffered, not lost.
    const buffered = await store.getConversation(key);
    expect(buffered!.inboundBuffer.map(m => m.channelMessageId)).toEqual(['m_late']);

    // Fire the late flush → a SECOND chat call carrying exactly the late message.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(calls[1]!.messages.map(m => m.channelMessageId)).toEqual(['m_late']);

    await agent.close();
  });

  it('handleStatus concurrent with an in-flight send does not double-advance (exactly-once)', async () => {
    // WhatsApp lifecycle: the queue waits on a delivery status. Fire the status
    // for the in-flight item TWICE concurrently (a status webhook can be
    // redelivered). The per-key lock + the currentOutboundIndex guard must let
    // exactly ONE of them advance the queue, so the second item is sent exactly
    // once (no double-advance that would skip an item).
    const h = makeHarness({
      responses: [{ actions: [{ type: 'message', text: 'one' }, { type: 'message', text: 'two' }] }]
    });

    await h.agent.handleInbound(inbound({ channelMessageId: 'wamid.ss1' }));
    await flushBuffer();

    expect(h.adapters.whatsapp!.sendText).toHaveBeenCalledTimes(1);
    const firstId = (await (h.adapters.whatsapp!.sendText.mock.results[0]!.value as Promise<SendResult>)).messageId;

    // Two concurrent delivered statuses for the SAME in-flight message.
    const s1 = h.agent.handleStatus(status(firstId, 'delivered'));
    const s2 = h.agent.handleStatus(status(firstId, 'sent'));
    await Promise.all([s1, s2]);

    // Exactly one advance → the second message sent exactly once.
    expect(h.adapters.whatsapp!.sendText).toHaveBeenCalledTimes(2);
    expect(h.adapters.whatsapp!.sendText).toHaveBeenNthCalledWith(2, 'user-1', 'two');
    const record = await h.store.getConversation('whatsapp:biz-1:user-1');
    expect(record!.currentOutboundIndex).toBe(1); // advanced once, now waiting on item 2's status
    await h.agent.close();
  });
});

/* ──────────────────────────────────────────────────────────────────────── */
/* Helpers                                                                   */
/* ──────────────────────────────────────────────────────────────────────── */

function status(channelMessageId: string, value: StatusUpdate['status']): StatusUpdate {
  return {
    channel: 'whatsapp',
    channelMessageId,
    channelScopedBusinessId: 'biz-1',
    status: value,
    timestamp: FIXED_NOW,
    raw: {}
  };
}
