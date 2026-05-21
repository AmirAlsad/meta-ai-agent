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
  MediaSendInput,
  SendResult
} from '../../src/meta/shared/adapter.js';
import type { Channel, IncomingMessage, StatusUpdate } from '../../src/meta/types.js';
import { defaultConversationConfig, type Config } from '../../src/config/loader.js';
import { InMemoryMetricsCollector } from '../../src/metrics/collector.js';
import { createAgentMetrics, type AgentMetrics } from '../../src/metrics/registry.js';
import { InMemoryStatusTracker } from '../../src/status/tracker.js';
import type { IdentityResolver, IdentityLookupRequest } from '../../src/identity/resolver.js';
import type { Contact } from '../../src/identity/types.js';

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
  sendMedia: ReturnType<typeof vi.fn>;
  sendTemplate?: ReturnType<typeof vi.fn>;
}

let messageIdCounter = 0;

function makeAdapter(
  channel: Channel,
  supports: (f: ChannelFeature) => boolean,
  opts: {
    template?: boolean;
    /** When set, `sendMedia` uses this implementation (e.g. to throw for an IG document). */
    sendMedia?: (recipientId: string, input: MediaSendInput) => Promise<SendResult>;
  } = {}
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
    sendReaction: vi.fn(async () => undefined),
    sendMedia: vi.fn(
      opts.sendMedia ?? (async (recipientId: string, _input: MediaSendInput) => sendResult(recipientId))
    )
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
  /** Present only when the harness was built with Stage 6 observability. */
  collector?: InMemoryMetricsCollector;
  metrics?: AgentMetrics;
  statusTracker?: InMemoryStatusTracker;
  identityResolver?: IdentityResolver;
}

function makeHarness(opts: {
  responses: NormalizedChatResponse[];
  adapters?: Partial<Record<Channel, FakeAdapter>>;
  configMutate?: (c: Config) => void;
  /** Wire a real in-memory metrics collector + registry. */
  withMetrics?: boolean;
  /** Wire a real in-memory status tracker. */
  withStatusTracker?: boolean;
  /** Optional identity resolver (fake). */
  identityResolver?: IdentityResolver;
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
  const collector = opts.withMetrics ? new InMemoryMetricsCollector() : undefined;
  const metrics = collector ? createAgentMetrics(collector) : undefined;
  const statusTracker = opts.withStatusTracker ? new InMemoryStatusTracker() : undefined;
  const agent = new ConversationAgent({
    store,
    scheduler,
    chatClient: chat,
    adapters: adapters as Partial<Record<Channel, ChannelAdapter>>,
    config,
    logger: silentLogger,
    random: () => 0.5, // mid-range jitter, fully deterministic
    now: () => FIXED_NOW,
    sleep: async () => undefined, // no-op so typing delays don't wait
    ...(metrics ? { metrics } : {}),
    ...(statusTracker ? { statusTracker } : {}),
    ...(opts.identityResolver ? { identityResolver: opts.identityResolver } : {})
  });
  return {
    agent,
    store,
    scheduler,
    chat,
    adapters,
    ...(collector ? { collector } : {}),
    ...(metrics ? { metrics } : {}),
    ...(statusTracker ? { statusTracker } : {}),
    ...(opts.identityResolver ? { identityResolver: opts.identityResolver } : {})
  };
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Stage 6 helpers: metric snapshot readers + a fake identity resolver       */
/* ──────────────────────────────────────────────────────────────────────── */

/** Read a counter series value for `name` matching `labels` (0 if absent). */
function counterValue(
  collector: InMemoryMetricsCollector,
  name: string,
  labels: Record<string, string>
): number {
  const metric = collector.snapshot().metrics.find(m => m.name === name);
  if (!metric || metric.kind !== 'counter') return 0;
  const series = metric.series.find(s =>
    Object.entries(labels).every(([k, v]) => s.labels[k] === v)
  );
  return series ? (series as { value: number }).value : 0;
}

/** Read a histogram series `count` for `name` matching `labels` (0 if absent). */
function histogramCount(
  collector: InMemoryMetricsCollector,
  name: string,
  labels: Record<string, string>
): number {
  const metric = collector.snapshot().metrics.find(m => m.name === name);
  if (!metric || metric.kind !== 'histogram') return 0;
  const series = metric.series.find(s =>
    Object.entries(labels).every(([k, v]) => s.labels[k] === v)
  );
  return series ? (series as { count: number }).count : 0;
}

/** A fake {@link IdentityResolver} that returns a fixed result and counts calls. */
function makeResolver(result: Contact | undefined): IdentityResolver & { calls: IdentityLookupRequest[] } {
  const calls: IdentityLookupRequest[] = [];
  return {
    calls,
    async resolve(req: IdentityLookupRequest): Promise<Contact | undefined> {
      calls.push(req);
      return result;
    }
  };
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

  describe('read receipts (READ_RECEIPTS_ENABLED)', () => {
    const enableReadReceipts = (c: Config): void => {
      c.conversation.readReceiptsEnabled = true;
    };

    it('marks the most recent inbound read at flush, before the chat call', async () => {
      const h = makeHarness({ responses: [textResponse('hi')], configMutate: enableReadReceipts });
      await h.agent.handleInbound(inbound({ channelMessageId: 'wamid.r1', text: 'hello' }));
      await flushBuffer();

      const markRead = h.adapters.whatsapp!.markRead;
      expect(markRead).toHaveBeenCalledTimes(1);
      expect(markRead).toHaveBeenCalledWith('user-1', 'wamid.r1');
      // Fired BEFORE the chat dispatch — that's what lets silence/reaction-only/
      // error turns still mark read.
      expect(markRead.mock.invocationCallOrder[0]!).toBeLessThan(
        h.chat.complete.mock.invocationCallOrder[0]!
      );
    });

    it('marks read even when the chat response is silence', async () => {
      const h = makeHarness({
        responses: [{ actions: [], silence: true }],
        configMutate: enableReadReceipts
      });
      await h.agent.handleInbound(inbound({ channelMessageId: 'wamid.r2' }));
      await flushBuffer();

      expect(h.adapters.whatsapp!.markRead).toHaveBeenCalledWith('user-1', 'wamid.r2');
      expect(h.adapters.whatsapp!.sendText).not.toHaveBeenCalled();
    });

    it('marks read on a reaction-only turn (no text, no typing)', async () => {
      const h = makeHarness({
        responses: [{ actions: [{ type: 'reaction', emoji: '👍', targetMessageId: 'wamid.r3' }] }],
        configMutate: enableReadReceipts
      });
      await h.agent.handleInbound(inbound({ channelMessageId: 'wamid.r3' }));
      await flushBuffer();

      expect(h.adapters.whatsapp!.markRead).toHaveBeenCalledWith('user-1', 'wamid.r3');
      expect(h.adapters.whatsapp!.sendReaction).toHaveBeenCalledTimes(1);
      expect(h.adapters.whatsapp!.sendText).not.toHaveBeenCalled();
    });

    it('does NOT mark read when READ_RECEIPTS_ENABLED is false (default)', async () => {
      const h = makeHarness({ responses: [textResponse('hi')] });
      await h.agent.handleInbound(inbound({ channelMessageId: 'wamid.r4' }));
      await flushBuffer();

      expect(h.adapters.whatsapp!.markRead).not.toHaveBeenCalled();
      expect(h.adapters.whatsapp!.sendText).toHaveBeenCalledTimes(1);
    });

    it('does NOT mark read when the adapter lacks read_receipt support', async () => {
      const noReadSupport = (f: ChannelFeature): boolean => f !== 'read_receipt' && whatsappSupports(f);
      const adapter = makeAdapter('whatsapp', noReadSupport, { template: true });
      const h = makeHarness({
        responses: [textResponse('hi')],
        adapters: { whatsapp: adapter },
        configMutate: enableReadReceipts
      });
      await h.agent.handleInbound(inbound({ channelMessageId: 'wamid.r5' }));
      await flushBuffer();

      expect(adapter.markRead).not.toHaveBeenCalled();
      expect(adapter.sendText).toHaveBeenCalledTimes(1);
    });

    it('is fail-soft: a markRead failure does not block the turn', async () => {
      const adapter = makeAdapter('whatsapp', whatsappSupports, { template: true });
      adapter.markRead.mockRejectedValueOnce(new Error('mark-read boom'));
      const h = makeHarness({
        responses: [textResponse('still replies')],
        adapters: { whatsapp: adapter },
        configMutate: enableReadReceipts
      });
      await h.agent.handleInbound(inbound({ channelMessageId: 'wamid.r6' }));
      await flushBuffer();

      expect(adapter.markRead).toHaveBeenCalledTimes(1);
      expect(h.chat.complete).toHaveBeenCalledTimes(1);
      expect(adapter.sendText).toHaveBeenCalledWith('user-1', 'still replies');
    });

    it('Messenger marks the thread seen once per turn', async () => {
      // The real MessengerClient supports read_receipt (markSeen); the shared
      // fake omits it, so use an adapter whose supports() matches the real one.
      const messengerReadSupports = (f: ChannelFeature): boolean =>
        f === 'read_receipt' || messengerSupports(f);
      const adapter = makeAdapter('messenger', messengerReadSupports);
      const h = makeHarness({
        responses: [textResponse('hi')],
        adapters: { messenger: adapter },
        configMutate: enableReadReceipts
      });
      await h.agent.handleInbound(
        inbound({ channel: 'messenger', channelMessageId: 'm_r7', channelScopedUserId: 'psid-1' })
      );
      await flushBuffer();

      expect(adapter.markRead).toHaveBeenCalledTimes(1);
      expect(adapter.markRead).toHaveBeenCalledWith('psid-1', 'm_r7');
    });

    it('records a mark_read outbound-send metric on success', async () => {
      const h = makeHarness({
        responses: [textResponse('hi')],
        configMutate: enableReadReceipts,
        withMetrics: true
      });
      await h.agent.handleInbound(inbound({ channelMessageId: 'wamid.r8' }));
      await flushBuffer();

      expect(
        counterValue(h.collector!, 'outbound_send_total', {
          channel: 'whatsapp',
          operation: 'mark_read',
          result: 'success'
        })
      ).toBe(1);
    });
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

  /* ────────────────────────────────────────────────────────────────────── */
  /* Stage 8: postback / referral routing                                     */
  /*                                                                          */
  /* WHY these tests exist (and add NO routing code): postback + referral are */
  /* just IncomingMessage variants. handleInbound buffers EVERY type and      */
  /* flush ships the whole batch in ChatRequest.messages[] — there is no       */
  /* special path. These tests PROVE the structured payload reaches the chat   */
  /* endpoint intact, so a future change that accidentally drops a non-text    */
  /* type (e.g. a text-only buffer guard, or an over-broad echo filter) fails  */
  /* here.                                                                     */
  /* ────────────────────────────────────────────────────────────────────── */

  describe('postback / referral reach the chat endpoint (Stage 8)', () => {
    it('postback inbound → ChatRequest.messages[0] carries type:postback + payload', async () => {
      const h = makeHarness({ responses: [textResponse('welcome!')] });

      await h.agent.handleInbound(
        inbound({
          channel: 'messenger',
          channelMessageId: 'm_pb1',
          channelScopedUserId: 'fb-user',
          type: 'postback',
          // A Get Started / button postback carries no free text — only the
          // structured payload. Drop `text` to mirror the real shape.
          text: undefined,
          postback: { title: 'Get Started', payload: 'GET_STARTED_PAYLOAD' }
        })
      );
      await flushBuffer();

      // The chat client was actually called with the postback in messages[].
      expect(h.chat.complete).toHaveBeenCalledTimes(1);
      const req = h.chat.calls[0]!;
      expect(req.messages).toHaveLength(1);
      const m = req.messages[0]!;
      expect(m.type).toBe('postback');
      expect(m.postback).toEqual({ title: 'Get Started', payload: 'GET_STARTED_PAYLOAD' });
      // The endpoint replied → its action was dispatched to the adapter.
      expect(h.adapters.messenger!.sendText).toHaveBeenCalledWith('fb-user', 'welcome!');
    });

    it('referral inbound → ChatRequest.messages[] carries the referral with its ref', async () => {
      const h = makeHarness({ responses: [textResponse('thanks for clicking')] });

      await h.agent.handleInbound(
        inbound({
          channel: 'messenger',
          channelMessageId: 'm_ref1',
          channelScopedUserId: 'fb-user',
          type: 'referral',
          text: undefined,
          referral: { source: 'ADS', type: 'OPEN_THREAD', ref: 'my_ref' }
        })
      );
      await flushBuffer();

      expect(h.chat.complete).toHaveBeenCalledTimes(1);
      const req = h.chat.calls[0]!;
      expect(req.messages).toHaveLength(1);
      const m = req.messages[0]!;
      expect(m.type).toBe('referral');
      expect(m.referral).toEqual({ source: 'ADS', type: 'OPEN_THREAD', ref: 'my_ref' });
    });

    it('a text-less postback still flushes (turn not dropped for empty aggregated text)', async () => {
      // The buffer aggregates the structured message; the backward-compat
      // `message` string is empty (no text), but the turn MUST still flush and
      // carry the postback in messages[]. This guards against a "drop empty
      // turns" regression.
      const h = makeHarness({ responses: [textResponse('hi')] });

      await h.agent.handleInbound(
        inbound({
          channel: 'messenger',
          channelMessageId: 'm_pb_empty',
          channelScopedUserId: 'fb-user',
          type: 'postback',
          text: undefined,
          postback: { payload: 'NO_TEXT_PAYLOAD' }
        })
      );
      await flushBuffer();

      expect(h.chat.complete).toHaveBeenCalledTimes(1);
      const req = h.chat.calls[0]!;
      // Aggregated text is empty (no `text` on the postback) ...
      expect(req.message).toBe('');
      // ... but the structured postback survived and reached the endpoint.
      expect(req.messages).toHaveLength(1);
      expect(req.messages[0]!.type).toBe('postback');
      expect(req.messages[0]!.postback).toEqual({ payload: 'NO_TEXT_PAYLOAD' });
    });
  });

  /* ────────────────────────────────────────────────────────────────────── */
  /* Stage 7: media dispatch                                                  */
  /* ────────────────────────────────────────────────────────────────────── */

  describe('media dispatch (Stage 7)', () => {
    /** Messenger supports + media_send (so a media action survives buildOutboundItems). */
    const messengerWithMedia = (f: ChannelFeature): boolean =>
      f === 'media_send' || messengerSupports(f);

    it('media action → adapter.sendMedia called with inferred kind + url + caption (on_send advances)', async () => {
      // Messenger is on_send: the queue advances on the send response, so after
      // one flush the conversation reaches idle.
      const adapter = makeAdapter('messenger', messengerWithMedia);
      const h = makeHarness({
        responses: [
          {
            actions: [
              {
                type: 'media',
                url: 'https://cdn.example.com/cat.jpg',
                caption: 'a cat',
                mimeType: 'image/jpeg'
              }
            ]
          }
        ],
        adapters: { messenger: adapter },
        withMetrics: true
      });

      await h.agent.handleInbound(
        inbound({ channel: 'messenger', channelMessageId: 'm_med1', channelScopedUserId: 'fb-user' })
      );
      await flushBuffer();

      expect(adapter.sendMedia).toHaveBeenCalledTimes(1);
      // image/jpeg → kind 'image'; url + caption threaded through; no filename.
      expect(adapter.sendMedia).toHaveBeenCalledWith('fb-user', {
        kind: 'image',
        mediaIdOrUrl: 'https://cdn.example.com/cat.jpg',
        caption: 'a cat'
      });

      // on_send: the queue advanced and the conversation is idle.
      const record = await h.store.getConversation('messenger:biz-1:fb-user');
      expect(record!.state).toBe('idle');
      expect(record!.currentOutboundIndex).toBe(1);

      // The send metric is recorded with operation 'media:image'.
      expect(
        counterValue(h.collector!, 'outbound_send_total', {
          channel: 'messenger',
          operation: 'media:image',
          result: 'success',
          error_code: 'none'
        })
      ).toBe(1);
      expect(
        histogramCount(h.collector!, 'outbound_send_duration_seconds', {
          channel: 'messenger',
          operation: 'media:image'
        })
      ).toBe(1);
    });

    it('threads a document filename through to sendMedia (kind document)', async () => {
      const adapter = makeAdapter('messenger', messengerWithMedia);
      const h = makeHarness({
        responses: [
          {
            actions: [
              {
                type: 'media',
                url: 'https://cdn.example.com/report.pdf',
                mimeType: 'application/pdf',
                filename: 'q2-report.pdf'
              }
            ]
          }
        ],
        adapters: { messenger: adapter }
      });

      await h.agent.handleInbound(
        inbound({ channel: 'messenger', channelMessageId: 'm_med2', channelScopedUserId: 'fb-user' })
      );
      await flushBuffer();

      // application/pdf → kind 'document'; filename carried through.
      expect(adapter.sendMedia).toHaveBeenCalledWith('fb-user', {
        kind: 'document',
        mediaIdOrUrl: 'https://cdn.example.com/report.pdf',
        filename: 'q2-report.pdf'
      });
    });

    it('IG document: sendMedia is called with kind document and SENT (on_send advances, success counted)', async () => {
      // Instagram now supports documents (sent as a `file`/PDF attachment), so a
      // document media item is dispatched like any other: sendMedia is called with
      // kind 'document', the on_send queue advances, and the send is counted as a
      // success — NOT skipped via a throw.
      const igMedia = (f: ChannelFeature): boolean =>
        f === 'media_send' || f === 'typing_indicator' || f === 'reaction';
      const adapter = makeAdapter('instagram', igMedia);
      const h = makeHarness({
        responses: [
          {
            actions: [
              {
                type: 'media',
                url: 'https://cdn.example.com/report.pdf',
                mimeType: 'application/pdf',
                filename: 'q2-report.pdf'
              },
              { type: 'message', text: 'after the doc' }
            ]
          }
        ],
        adapters: { instagram: adapter },
        withMetrics: true
      });

      await h.agent.handleInbound(
        inbound({ channel: 'instagram', channelMessageId: 'ig_med1', channelScopedUserId: 'ig-user' })
      );
      await flushBuffer();

      // The document was SENT (kind 'document', filename threaded through), and
      // the following message also sent.
      expect(adapter.sendMedia).toHaveBeenCalledTimes(1);
      expect(adapter.sendMedia).toHaveBeenCalledWith('ig-user', {
        kind: 'document',
        mediaIdOrUrl: 'https://cdn.example.com/report.pdf',
        filename: 'q2-report.pdf'
      });
      expect(adapter.sendText).toHaveBeenCalledTimes(1);
      expect(adapter.sendText).toHaveBeenCalledWith('ig-user', 'after the doc');

      // on_send: the queue advanced past both items → idle, and the media item was
      // NOT skipped.
      const key = 'instagram:biz-1:ig-user';
      const record = await h.store.getConversation(key);
      expect(record!.state).toBe('idle');
      expect(record!.currentOutboundIndex).toBe(2);
      const mediaItem = record!.outboundQueue[0]!;
      expect(mediaItem.kind).toBe('media');
      expect(mediaItem.skippedAt).toBeUndefined();
      expect(mediaItem.skipReason).toBeUndefined();

      // The send is counted as a SUCCESS for operation 'media:document'.
      expect(
        counterValue(h.collector!, 'outbound_send_total', {
          channel: 'instagram',
          operation: 'media:document',
          result: 'success',
          error_code: 'none'
        })
      ).toBe(1);
    });

    it('media send that Meta rejects: sendMedia throws → item skipped, queue advances, error counted', async () => {
      // Repoints the former IG-document skip-via-catch test to a still-throwing
      // path (a fake adapter whose sendMedia throws), so the agent's fail-soft
      // catch — skip the item, advance, count an error — stays covered without
      // relying on IG documents (which now send).
      const igMedia = (f: ChannelFeature): boolean =>
        f === 'media_send' || f === 'typing_indicator' || f === 'reaction';
      const adapter = makeAdapter('instagram', igMedia, {
        sendMedia: async () => {
          // A non-MetaApiError throw hits the agent's `: 'other'` error_code branch.
          throw new Error('media rejected by Meta');
        }
      });
      const h = makeHarness({
        responses: [
          {
            actions: [
              { type: 'media', url: 'https://cdn.example.com/report.pdf', mimeType: 'application/pdf' },
              { type: 'message', text: 'after the doc' }
            ]
          }
        ],
        adapters: { instagram: adapter },
        withMetrics: true
      });

      await h.agent.handleInbound(
        inbound({ channel: 'instagram', channelMessageId: 'ig_med_reject', channelScopedUserId: 'ig-user' })
      );
      await flushBuffer();

      // sendMedia was attempted and threw; the following message still sent.
      expect(adapter.sendMedia).toHaveBeenCalledTimes(1);
      expect(adapter.sendText).toHaveBeenCalledWith('ig-user', 'after the doc');

      // The queue advanced past both items → idle; the media item is marked skipped.
      const key = 'instagram:biz-1:ig-user';
      const record = await h.store.getConversation(key);
      expect(record!.state).toBe('idle');
      expect(record!.currentOutboundIndex).toBe(2);
      const mediaItem = record!.outboundQueue[0]!;
      expect(mediaItem.skippedAt).toBeDefined();

      // The failed send is counted as an error for operation 'media:document'.
      expect(
        counterValue(h.collector!, 'outbound_send_total', {
          channel: 'instagram',
          operation: 'media:document',
          result: 'error',
          error_code: 'other'
        })
      ).toBe(1);
    });

    it('WhatsApp (on_status): a media send waits for a delivery status to advance', async () => {
      // WhatsApp is on_status — a media send (with a real id) is treated like a
      // text send: the queue holds until a delivery/sent status arrives.
      const waMedia = (f: ChannelFeature): boolean =>
        f === 'media_send' || whatsappSupports(f);
      const adapter = makeAdapter('whatsapp', waMedia, { template: true });
      const h = makeHarness({
        responses: [
          { actions: [{ type: 'media', url: 'https://cdn.example.com/clip.mp4', mimeType: 'video/mp4' }] }
        ],
        adapters: { whatsapp: adapter }
      });

      await h.agent.handleInbound(inbound({ channelMessageId: 'wamid.med1' }));
      await flushBuffer();

      expect(adapter.sendMedia).toHaveBeenCalledTimes(1);
      expect(adapter.sendMedia).toHaveBeenCalledWith('user-1', {
        kind: 'video',
        mediaIdOrUrl: 'https://cdn.example.com/clip.mp4'
      });

      const key = 'whatsapp:biz-1:user-1';
      const waiting = await h.store.getConversation(key);
      // on_status: still sending, holding the in-flight media handle.
      expect(waiting!.state).toBe('sending');
      const mediaId = (await (adapter.sendMedia.mock.results[0]!.value as Promise<SendResult>)).messageId;
      expect(waiting!.currentOutboundMessageId).toBe(mediaId);

      // A delivery status releases the queue → idle.
      await h.agent.handleStatus(status(mediaId, 'delivered'));
      const done = await h.store.getConversation(key);
      expect(done!.state).toBe('idle');
      expect(done!.currentOutboundIndex).toBe(1);
    });
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

  it('honors an explicit typing action durationMs before advancing', async () => {
    // Built directly (not via makeHarness) so we can inject a RECORDING sleep
    // and assert the requested duration is actually waited.
    const sleeps: number[] = [];
    const store = new InMemoryConversationStore({ dedupeTtlSeconds: 86_400 });
    const scheduler = new InMemoryBufferScheduler();
    const chat = makeChatClient([{ actions: [{ type: 'typing', durationMs: 3000 }] }]);
    const adapter = makeAdapter('whatsapp', whatsappSupports, { template: true });
    const agent = new ConversationAgent({
      store,
      scheduler,
      chatClient: chat,
      adapters: { whatsapp: adapter } as Partial<Record<Channel, ChannelAdapter>>,
      config: makeConfig(),
      logger: silentLogger,
      random: () => 0.5,
      now: () => FIXED_NOW,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      }
    });

    await agent.handleInbound(inbound({ channelMessageId: 'wamid.td1' }));
    await flushBuffer();

    expect(adapter.sendTypingIndicator).toHaveBeenCalledTimes(1);
    expect(sleeps).toContain(3000); // honored (under the 10s ceiling)
  });

  it('caps an oversized explicit typing duration at the hard ceiling', async () => {
    const sleeps: number[] = [];
    const store = new InMemoryConversationStore({ dedupeTtlSeconds: 86_400 });
    const scheduler = new InMemoryBufferScheduler();
    const chat = makeChatClient([{ actions: [{ type: 'typing', durationMs: 999_999 }] }]);
    const adapter = makeAdapter('whatsapp', whatsappSupports, { template: true });
    const agent = new ConversationAgent({
      store,
      scheduler,
      chatClient: chat,
      adapters: { whatsapp: adapter } as Partial<Record<Channel, ChannelAdapter>>,
      config: makeConfig(),
      logger: silentLogger,
      random: () => 0.5,
      now: () => FIXED_NOW,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      }
    });

    await agent.handleInbound(inbound({ channelMessageId: 'wamid.td2' }));
    await flushBuffer();

    // Clamped to MAX_EXPLICIT_TYPING_DURATION_MS (10_000); never the raw value.
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(10_000);
    expect(sleeps).toContain(10_000);
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

  /* ────────────────────────────────────────────────────────────────────── */
  /* Stage 6: identity enrichment (OPTIONAL, fail-open)                      */
  /* ────────────────────────────────────────────────────────────────────── */

  it('identity: a resolver returning a contact → ChatRequest carries it, record.contact set, metric resolved', async () => {
    const contact: Contact = {
      channel: 'whatsapp',
      channelScopedUserId: 'user-1',
      firstName: 'Ada',
      tags: ['tier:gold']
    };
    const resolver = makeResolver(contact);
    const h = makeHarness({ responses: [textResponse('hi')], withMetrics: true, identityResolver: resolver });

    await h.agent.handleInbound(inbound({ channelMessageId: 'wamid.id1' }));
    await flushBuffer();

    expect(resolver.calls).toHaveLength(1);
    expect(resolver.calls[0]).toEqual({
      channel: 'whatsapp',
      channelScopedUserId: 'user-1',
      channelScopedBusinessId: 'biz-1'
    });
    // The resolved contact rides on the chat request and is persisted.
    expect(h.chat.calls[0]!.contact).toEqual(contact);
    const record = await h.store.getConversation('whatsapp:biz-1:user-1');
    expect(record!.contact).toEqual(contact);
    expect(counterValue(h.collector!, 'identity_lookup_total', { result: 'resolved' })).toBe(1);
  });

  it('identity: a resolver returning undefined → no contact, metric none', async () => {
    const resolver = makeResolver(undefined);
    const h = makeHarness({ responses: [textResponse('hi')], withMetrics: true, identityResolver: resolver });

    await h.agent.handleInbound(inbound({ channelMessageId: 'wamid.id2' }));
    await flushBuffer();

    expect(resolver.calls).toHaveLength(1);
    expect(h.chat.calls[0]!.contact).toBeUndefined();
    const record = await h.store.getConversation('whatsapp:biz-1:user-1');
    expect(record!.contact).toBeUndefined();
    expect(counterValue(h.collector!, 'identity_lookup_total', { result: 'none' })).toBe(1);
  });

  it('identity: no resolver → metric disabled, no contact', async () => {
    const h = makeHarness({ responses: [textResponse('hi')], withMetrics: true });

    await h.agent.handleInbound(inbound({ channelMessageId: 'wamid.id3' }));
    await flushBuffer();

    expect(h.chat.calls[0]!.contact).toBeUndefined();
    expect(counterValue(h.collector!, 'identity_lookup_total', { result: 'disabled' })).toBe(1);
  });

  it('identity: resolver is called only ONCE per conversation (cached on the record)', async () => {
    const contact: Contact = { channel: 'whatsapp', channelScopedUserId: 'user-1', displayName: 'Ada' };
    const resolver = makeResolver(contact);
    const h = makeHarness({ responses: [textResponse('a'), textResponse('b')], withMetrics: true, identityResolver: resolver });

    // First inbound → resolves + flush completes (back to idle).
    await h.agent.handleInbound(inbound({ channelMessageId: 'wamid.id4a' }));
    await flushBuffer();
    // Second inbound on the SAME conversation → record.contact already set → skip.
    await h.agent.handleInbound(inbound({ channelMessageId: 'wamid.id4b' }));
    await flushBuffer();

    expect(resolver.calls).toHaveLength(1); // not re-resolved
    // Only the single resolved outcome was counted (skip path is uncounted).
    expect(counterValue(h.collector!, 'identity_lookup_total', { result: 'resolved' })).toBe(1);
  });

  /* ────────────────────────────────────────────────────────────────────── */
  /* Stage 6: metrics across the inbound→flush→send lifecycle                */
  /* ────────────────────────────────────────────────────────────────────── */

  it('metrics: a full inbound→flush→send records dedupe/inbound/dispatch/outbound', async () => {
    // Messenger so the send completes synchronously (on_send) and the queue
    // reaches idle in one flush, exercising the full success path.
    const h = makeHarness({ responses: [textResponse('reply')], withMetrics: true });

    await h.agent.handleInbound(
      inbound({ channel: 'messenger', channelMessageId: 'm_met1', channelScopedUserId: 'fb-user' })
    );
    await flushBuffer();

    const c = h.collector!;
    expect(counterValue(c, 'inbound_dedupe_total', { result: 'claimed' })).toBe(1);
    expect(counterValue(c, 'inbound_messages_total', { channel: 'messenger', type: 'text' })).toBe(1);
    expect(histogramCount(c, 'chat_dispatch_duration_seconds', { result: 'success' })).toBe(1);
    expect(counterValue(c, 'buffer_flush_total', { result: 'dispatched' })).toBe(1);
    expect(
      counterValue(c, 'outbound_send_total', {
        channel: 'messenger',
        operation: 'message',
        result: 'success',
        error_code: 'none'
      })
    ).toBe(1);
    expect(histogramCount(c, 'outbound_send_duration_seconds', { channel: 'messenger', operation: 'message' })).toBe(1);
  });

  it('metrics: a duplicate inbound increments inbound_dedupe{duplicate}', async () => {
    const h = makeHarness({ responses: [textResponse('reply')], withMetrics: true });
    const msg = inbound({ channelMessageId: 'wamid.metdup' });

    await h.agent.handleInbound(msg);
    await h.agent.handleInbound({ ...msg }); // redelivery
    await flushBuffer();

    expect(counterValue(h.collector!, 'inbound_dedupe_total', { result: 'claimed' })).toBe(1);
    expect(counterValue(h.collector!, 'inbound_dedupe_total', { result: 'duplicate' })).toBe(1);
  });

  it('metrics: a silence response records buffer_flush{silence} and no outbound', async () => {
    const h = makeHarness({ responses: [{ actions: [], silence: true }], withMetrics: true });

    await h.agent.handleInbound(inbound({ channelMessageId: 'wamid.metsil' }));
    await flushBuffer();

    expect(histogramCount(h.collector!, 'chat_dispatch_duration_seconds', { result: 'success' })).toBe(1);
    expect(counterValue(h.collector!, 'buffer_flush_total', { result: 'silence' })).toBe(1);
    expect(counterValue(h.collector!, 'buffer_flush_total', { result: 'dispatched' })).toBe(0);
  });

  /* ────────────────────────────────────────────────────────────────────── */
  /* Stage 6: status tracker (WhatsApp per-message + Messenger watermark)    */
  /* ────────────────────────────────────────────────────────────────────── */

  it('status tracker: a WhatsApp delivered status records history + metric', async () => {
    const h = makeHarness({ responses: [textResponse('hi')], withMetrics: true, withStatusTracker: true });

    await h.agent.handleInbound(inbound({ channelMessageId: 'wamid.tr1' }));
    await flushBuffer();

    const sentId = (await (h.adapters.whatsapp!.sendText.mock.results[0]!.value as Promise<SendResult>)).messageId;
    await h.agent.handleStatus(status(sentId, 'delivered'));

    const tracked = h.statusTracker!.getStatus(sentId);
    expect(tracked).toBeDefined();
    expect(tracked!.current).toBe('delivered');
    expect(tracked!.conversationKey).toBe('whatsapp:biz-1:user-1');
    expect(counterValue(h.collector!, 'status_callback_total', { channel: 'whatsapp', status: 'delivered' })).toBe(1);

    await h.agent.close();
  });

  it('status tracker: WhatsApp delivered + read are recorded after sent deletes the mapping', async () => {
    const h = makeHarness({ responses: [textResponse('hi')], withStatusTracker: true });
    await h.agent.handleInbound(inbound({ channelMessageId: 'wamid.tr2' }));
    await flushBuffer();
    const sentId = (await (h.adapters.whatsapp!.sendText.mock.results[0]!.value as Promise<SendResult>)).messageId;

    // 'sent' advances the WhatsApp queue and deletes the outbound-handle mapping.
    await h.agent.handleStatus(status(sentId, 'sent'));
    // delivered + read arrive AFTER the mapping is gone. Regression guard: they
    // were previously dropped at the unmapped early-return, freezing history at
    // the first status. They must now still be recorded.
    await h.agent.handleStatus(status(sentId, 'delivered'));
    await h.agent.handleStatus(status(sentId, 'read'));

    const tracked = h.statusTracker!.getStatus(sentId);
    expect(tracked).toBeDefined();
    expect(tracked!.current).toBe('read');
    expect(tracked!.history.map(e => e.status)).toEqual(['sent', 'delivered', 'read']);

    await h.agent.close();
  });

  it('watermark read (Messenger): both sent ids marked read; queue unaffected', async () => {
    // Messenger is on_send: two messages both send and the queue reaches idle.
    const h = makeHarness({
      responses: [{ actions: [{ type: 'message', text: 'one' }, { type: 'message', text: 'two' }] }],
      adapters: { messenger: makeAdapter('messenger', messengerSupports) },
      withMetrics: true,
      withStatusTracker: true
    });

    await h.agent.handleInbound(
      inbound({ channel: 'messenger', channelMessageId: 'm_wm1', channelScopedUserId: 'fb-user' })
    );
    await flushBuffer();

    const key = 'messenger:biz-1:fb-user';
    const beforeRecord = await h.store.getConversation(key);
    expect(beforeRecord!.state).toBe('idle');
    expect(beforeRecord!.currentOutboundIndex).toBe(2); // both advanced on send
    const firstId = (await (h.adapters.messenger!.sendText.mock.results[0]!.value as Promise<SendResult>)).messageId;
    const secondId = (await (h.adapters.messenger!.sendText.mock.results[1]!.value as Promise<SendResult>)).messageId;

    // Regression guard: the agent itself seeds a `sent` status record at SEND
    // time for on_send channels (Messenger/IG), which emit no per-message status
    // webhook. Without that seeding the watermark read below would be a no-op
    // (getStatus would return undefined). No manual pre-seed here — the records
    // must already exist purely from the agent having sent the two messages.
    expect(h.statusTracker!.getStatus(firstId)!.current).toBe('sent');
    expect(h.statusTracker!.getStatus(secondId)!.current).toBe('sent');

    // Feed a read watermark covering both sentAt timestamps (= FIXED_NOW).
    await h.agent.handleStatus({
      channel: 'messenger',
      channelMessageId: String(FIXED_NOW), // watermark, not a per-message id
      channelScopedUserId: 'fb-user',
      channelScopedBusinessId: 'biz-1',
      status: 'read',
      timestamp: FIXED_NOW,
      raw: {}
    });

    // Both messages now show read.
    expect(h.statusTracker!.getStatus(firstId)!.current).toBe('read');
    expect(h.statusTracker!.getStatus(secondId)!.current).toBe('read');
    expect(counterValue(h.collector!, 'status_callback_total', { channel: 'messenger', status: 'read' })).toBe(1);

    // The queue is NOT touched by the read (advance-on-send already completed it).
    const afterRecord = await h.store.getConversation(key);
    expect(afterRecord!.state).toBe('idle');
    expect(afterRecord!.currentOutboundIndex).toBe(2);

    await h.agent.close();
  });

  it('regression: optional deps absent → behavior unchanged (no metrics/tracker required)', async () => {
    // A plain harness (no withMetrics/withStatusTracker/identityResolver) must
    // still complete a full turn exactly as Stage 5 did.
    const h = makeHarness({ responses: [textResponse('hi there')] });
    expect(h.collector).toBeUndefined();
    expect(h.statusTracker).toBeUndefined();

    await h.agent.handleInbound(inbound({ channelMessageId: 'wamid.noopt' }));
    await flushBuffer();

    expect(h.chat.complete).toHaveBeenCalledTimes(1);
    expect(h.adapters.whatsapp!.sendText).toHaveBeenCalledWith('user-1', 'hi there');
    // A status with no tracker/metrics wired is a benign no-op (does not throw).
    const sentId = (await (h.adapters.whatsapp!.sendText.mock.results[0]!.value as Promise<SendResult>)).messageId;
    await expect(h.agent.handleStatus(status(sentId, 'delivered'))).resolves.toBeUndefined();
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
    // Real WhatsApp statuses carry recipient_id; the agent derives the
    // conversation key from it (+ business id) to record status history.
    channelScopedUserId: 'user-1',
    channelScopedBusinessId: 'biz-1',
    status: value,
    timestamp: FIXED_NOW,
    raw: {}
  };
}
