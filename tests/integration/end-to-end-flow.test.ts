/**
 * End-to-end Stage 5 wiring test.
 *
 * Exercises the FULL inbound path with fakes ONLY at the two real-world
 * boundaries (the developer's chat endpoint and Meta's send API):
 *
 *   HTTP POST → signature verify → parse → dispatchWebhook → agent.handleInbound
 *     → buffer flush (timer) → fake ChatClient.complete → delivery queue
 *     → fake ChannelAdapter.sendText
 *
 * Everything between those boundaries is the REAL implementation: the express
 * app + signature verifier, the parser, the in-memory store + scheduler, the
 * pure delivery-queue logic, and the ConversationAgent state machine. Only the
 * chat endpoint and the per-channel send clients are faked, so a regression
 * anywhere in the wiring surfaces here.
 *
 * The buffer flush is timer-driven, so the suite uses fake timers and
 * `advanceTimersByTimeAsync` to drive the flush deterministically. Jitter is
 * pinned to zero (`random: () => 0.5`) so the first flush fires at exactly
 * `bufferBaseTimeoutMs`, and `sleep` is a no-op so the outbound typing delay
 * adds no real wait.
 */

import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import request from 'supertest';
import type pino from 'pino';
import { createApp } from '../../src/http/app.js';
import type { Config } from '../../src/config/loader.js';
import { defaultConversationConfig } from '../../src/config/loader.js';
import { ConversationAgent } from '../../src/conversation/agent.js';
import { InMemoryConversationStore } from '../../src/conversation/store.js';
import { InMemoryBufferScheduler } from '../../src/conversation/scheduler.js';
import type { ChatClient } from '../../src/chat/client.js';
import type { NormalizedChatResponse } from '../../src/chat/types.js';
import type {
  ChannelAdapter,
  ChannelFeature,
  MediaSendInput,
  SendResult
} from '../../src/meta/shared/adapter.js';
import type { Channel } from '../../src/meta/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(here, '../fixtures/meta');

const APP_SECRET = 'test-app-secret-1234567890';
const VERIFY_TOKEN = 'test-verify-token-1234567890';

/* ──────────────────────────────────────────────────────────────────────── */
/* Test doubles                                                             */
/* ──────────────────────────────────────────────────────────────────────── */

interface SpyLogger {
  info: Mock;
  warn: Mock;
  error: Mock;
  debug: Mock;
  fatal: Mock;
  trace: Mock;
}

type SpyPinoLogger = pino.Logger & { mock: SpyLogger };

function makeSpyLogger(): SpyPinoLogger {
  const mock: SpyLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn()
  };
  const logger: Record<string, unknown> = {
    info: mock.info,
    warn: mock.warn,
    error: mock.error,
    debug: mock.debug,
    fatal: mock.fatal,
    trace: mock.trace,
    silent: vi.fn(),
    level: 'info',
    child(): SpyPinoLogger {
      return logger as unknown as SpyPinoLogger;
    },
    bindings(): Record<string, unknown> {
      return {};
    },
    flush(): void {
      /* no-op */
    },
    isLevelEnabled(): boolean {
      return true;
    }
  };
  logger.mock = mock;
  return logger as unknown as SpyPinoLogger;
}

function makeTestConfig(): Config {
  return {
    meta: {
      appId: undefined,
      appSecret: APP_SECRET,
      verifyToken: VERIFY_TOKEN,
      graphApiVersion: 'v25.0'
    },
    whatsapp: {
      phoneNumberId: '200000000000002',
      accessToken: 'fake-whatsapp-access-token'
    },
    messenger: {
      pageId: '500000000000005',
      pageAccessToken: 'fake-messenger-page-access-token'
    },
    instagram: {
      userId: '17841400000000007',
      accessToken: 'fake-instagram-access-token'
    },
    channels: { whatsapp: true, messenger: true, instagram: true },
    conversation: defaultConversationConfig(),
    chatEndpointUrl: 'http://localhost:9999/chat',
    ngrokDomain: 'test.ngrok-free.dev',
    agentAutostart: false,
    port: 3000,
    nodeEnv: 'test'
  };
}

/** A fake ChatClient whose `complete` returns one canned text action. */
interface FakeChatClient extends ChatClient {
  complete: Mock;
}

function makeFakeChatClient(): FakeChatClient {
  const response: NormalizedChatResponse = {
    actions: [{ type: 'message', text: 'hi there' }]
  };
  return { complete: vi.fn().mockResolvedValue(response) };
}

/**
 * A fake {@link ChannelAdapter} with `vi.fn()` send methods and a REAL
 * `supports` matrix close to the live clients: typing/read/reaction/reply +
 * media true everywhere; template true only for WhatsApp.
 */
interface FakeAdapter extends ChannelAdapter {
  sendText: Mock;
  sendReaction: Mock;
  sendTypingIndicator: Mock;
  markRead: Mock;
  sendMedia: Mock;
}

function makeFakeAdapter(channel: Channel): FakeAdapter {
  const sendText = vi.fn(
    async (recipientId: string): Promise<SendResult> => ({
      channel,
      // A channel-shaped fake outbound id, unique per call so handle mapping
      // doesn't collide across sends.
      messageId: `${channel}-out-${sendText.mock.calls.length}`,
      recipientId,
      timestamp: Date.now()
    })
  );
  const sendMedia = vi.fn(
    async (recipientId: string, _input: MediaSendInput): Promise<SendResult> => ({
      channel,
      messageId: `${channel}-media-${sendMedia.mock.calls.length}`,
      recipientId,
      timestamp: Date.now()
    })
  );
  return {
    channel,
    sendText,
    sendReaction: vi.fn(async () => undefined),
    sendTypingIndicator: vi.fn(async () => undefined),
    markRead: vi.fn(async () => undefined),
    sendMedia,
    supports(feature: ChannelFeature): boolean {
      switch (feature) {
        case 'typing_indicator':
        case 'read_receipt':
        case 'reaction':
        case 'reply_to':
        // media_send is wired at Stage 7 — all three live clients advertise it.
        case 'media_send':
          return true;
        case 'template':
          return channel === 'whatsapp';
        default:
          // The profile surfaces (persistent_menu/get_started/ice_breakers/
          // story_reply) are out of scope here.
          return false;
      }
    }
  };
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Signing + fixture helpers (same HMAC scheme as webhook-routing.test.ts)   */
/* ──────────────────────────────────────────────────────────────────────── */

function signBody(body: Buffer, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

/**
 * Load a fixture and RE-SERIALIZE it, so the byte sequence is deterministic and
 * the signature computed over the returned buffer exactly matches what
 * supertest sends as the request body.
 */
function loadFixtureBuffer(relativePath: string): Buffer {
  const raw = readFileSync(path.join(fixturesDir, relativePath), 'utf8');
  return Buffer.from(JSON.stringify(JSON.parse(raw)));
}

/**
 * POST a signed body to /webhook and, because `handleInbound` is fire-and-forget
 * from the route, yield a microtask tick so the agent has buffered the message
 * and armed its flush timer BEFORE the caller advances fake timers.
 */
async function postSigned(
  app: ReturnType<typeof createApp>,
  bodyBuf: Buffer,
  secret = APP_SECRET
): Promise<request.Response> {
  const res = await request(app)
    .post('/webhook')
    .set('Content-Type', 'application/json')
    .set('x-hub-signature-256', signBody(bodyBuf, secret))
    .send(bodyBuf.toString('utf8'));
  // Let the fire-and-forget handleInbound chain run up to scheduling the timer.
  await flushMicrotasks();
  return res;
}

/** Drain the microtask queue a few times so chained `await`s settle. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

const BUFFER_BASE_MS = defaultConversationConfig().bufferBaseTimeoutMs;

describe('end-to-end Stage 5 flow', () => {
  let logger: SpyPinoLogger;
  let config: Config;
  let store: InMemoryConversationStore;
  let scheduler: InMemoryBufferScheduler;
  let fakeChat: FakeChatClient;
  let adapters: Partial<Record<Channel, FakeAdapter>>;
  let agent: ConversationAgent;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.useFakeTimers();
    logger = makeSpyLogger();
    config = makeTestConfig();
    store = new InMemoryConversationStore({ dedupeTtlSeconds: config.conversation.dedupeTtlSeconds });
    scheduler = new InMemoryBufferScheduler();
    fakeChat = makeFakeChatClient();
    adapters = {
      whatsapp: makeFakeAdapter('whatsapp'),
      messenger: makeFakeAdapter('messenger'),
      instagram: makeFakeAdapter('instagram')
    };
    agent = new ConversationAgent({
      store,
      scheduler,
      chatClient: fakeChat,
      adapters: adapters as Partial<Record<Channel, ChannelAdapter>>,
      config,
      logger,
      // Pin jitter to 0 so the first flush fires at EXACTLY bufferBaseTimeoutMs:
      // calculateBufferTimeout uses (random()*2 - 1), and 0.5 → 0 deviation.
      random: () => 0.5,
      // No-op sleep so the typing-indicator delay before a text send never waits.
      sleep: async () => {}
    });
    app = createApp({ config, logger, agent });
  });

  afterEach(async () => {
    await agent.close();
    vi.useRealTimers();
  });

  /**
   * Advance fake timers past the buffer window and let the async flush → chat →
   * queue → send chain settle. `advanceTimersByTimeAsync` awaits timer-scheduled
   * promises; the extra microtask drains catch the trailing `await`s in sendNext.
   */
  async function flushBuffer(): Promise<void> {
    await vi.advanceTimersByTimeAsync(BUFFER_BASE_MS + 1);
    await flushMicrotasks();
  }

  it('drives a WhatsApp inbound through chat to the WhatsApp adapter send', async () => {
    const bodyBuf = loadFixtureBuffer('whatsapp/text-inbound.json');
    const res = await postSigned(app, bodyBuf);

    expect(res.status).toBe(200);
    expect(res.text).toBe('EVENT_RECEIVED');
    // Nothing should have been sent before the buffer window elapses.
    expect(fakeChat.complete).not.toHaveBeenCalled();

    await flushBuffer();

    // Chat endpoint called exactly once with the buffered turn.
    expect(fakeChat.complete).toHaveBeenCalledTimes(1);
    const req = fakeChat.complete.mock.calls[0][0];
    expect(req.channel).toBe('whatsapp');
    expect(req.conversationKey).toBe('whatsapp:200000000000002:15557654321');
    expect(req.messages[0].text).toBe('Hello from WhatsApp');
    // Capabilities are the adapter's supports() truth set.
    expect(req.capabilities).toEqual(
      expect.arrayContaining(['typing_indicator', 'read_receipt', 'reaction', 'reply_to', 'template'])
    );
    // The 24h window just opened from this inbound.
    expect(req.context.windowOpen).toBe(true);

    // The WhatsApp adapter sent the canned text. (WhatsApp advances on_status,
    // so after this first send it waits for a delivery status — but the send
    // itself, which is what we assert, has already happened.)
    const wa = adapters.whatsapp as FakeAdapter;
    expect(wa.sendText).toHaveBeenCalledTimes(1);
    expect(wa.sendText.mock.calls[0][0]).toBe('15557654321');
    expect(wa.sendText.mock.calls[0][1]).toBe('hi there');
  });

  it('drives a media chat action through to the adapter sendMedia (kind inferred from MIME)', async () => {
    // The chat endpoint returns a media action instead of text; after the flush
    // the WhatsApp adapter's sendMedia must be called with the inferred kind.
    fakeChat.complete.mockResolvedValue({
      actions: [{ type: 'media', url: 'https://cdn.example.com/pic.png', mimeType: 'image/png' }]
    } satisfies NormalizedChatResponse);

    const bodyBuf = loadFixtureBuffer('whatsapp/text-inbound.json');
    const res = await postSigned(app, bodyBuf);
    expect(res.status).toBe(200);

    await flushBuffer();

    expect(fakeChat.complete).toHaveBeenCalledTimes(1);

    const wa = adapters.whatsapp as FakeAdapter;
    // No text was sent — only a media attachment.
    expect(wa.sendText).not.toHaveBeenCalled();
    expect(wa.sendMedia).toHaveBeenCalledTimes(1);
    // image/png → kind 'image'; the url is forwarded as the media reference.
    expect(wa.sendMedia.mock.calls[0][0]).toBe('15557654321');
    expect(wa.sendMedia.mock.calls[0][1]).toEqual({
      kind: 'image',
      mediaIdOrUrl: 'https://cdn.example.com/pic.png'
    });
    // No handler error along the media path.
    expect(logger.mock.error).not.toHaveBeenCalled();
  });

  it('routes a Messenger inbound to the Messenger adapter, not WhatsApp', async () => {
    const bodyBuf = loadFixtureBuffer('messenger/text-message.json');
    const res = await postSigned(app, bodyBuf);
    expect(res.status).toBe(200);

    await flushBuffer();

    expect(fakeChat.complete).toHaveBeenCalledTimes(1);
    expect(fakeChat.complete.mock.calls[0][0].channel).toBe('messenger');

    const messenger = adapters.messenger as FakeAdapter;
    const wa = adapters.whatsapp as FakeAdapter;
    expect(messenger.sendText).toHaveBeenCalledTimes(1);
    expect(messenger.sendText.mock.calls[0][1]).toBe('hi there');
    // Per-channel adapter selection: WhatsApp must NOT have been touched.
    expect(wa.sendText).not.toHaveBeenCalled();
  });

  it('routes a WhatsApp status callback without error and ACKs 200', async () => {
    // The delivered-status fixture references a wamid we never sent, so it maps
    // to nothing in the store. handleStatus must no-op cleanly (no crash, no
    // adapter send) and the route must still ACK 200.
    const bodyBuf = loadFixtureBuffer('whatsapp/status-delivered.json');
    const res = await postSigned(app, bodyBuf);

    expect(res.status).toBe(200);
    expect(res.text).toBe('EVENT_RECEIVED');

    await flushBuffer();

    // A status carries no inbound message — the chat endpoint is never called,
    // and no adapter send happens for an unmapped status.
    expect(fakeChat.complete).not.toHaveBeenCalled();
    const wa = adapters.whatsapp as FakeAdapter;
    expect(wa.sendText).not.toHaveBeenCalled();
    // No handler logged an error (handleStatus stayed on its benign debug path).
    expect(logger.mock.error).not.toHaveBeenCalled();
  });

  it('dedupes the same inbound across two webhook deliveries (one chat call)', async () => {
    // Meta retries until it sees a 200, so the SAME inbound can arrive twice.
    // The store's SETNX dedupe must hold across separate HTTP requests so the
    // chat endpoint is called exactly once.
    const bodyBuf = loadFixtureBuffer('whatsapp/text-inbound.json');

    const first = await postSigned(app, bodyBuf);
    const second = await postSigned(app, bodyBuf);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    await flushBuffer();

    expect(fakeChat.complete).toHaveBeenCalledTimes(1);
    const wa = adapters.whatsapp as FakeAdapter;
    expect(wa.sendText).toHaveBeenCalledTimes(1);
  });

  it('multi-message webhook: BOTH messages in one body reach the chat call (per-key lock + ordered dispatch)', async () => {
    // END-TO-END proof of FIX 1 (per-key lock) + FIX 2 (sequential dispatch).
    // A single WhatsApp webhook routinely batches several messages for one
    // conversation (parser emits one IncomingMessage per messages[] entry). The
    // dispatcher routes them concurrently/in-order into the agent; without the
    // per-key lock the second buffer-append would clobber the first and a user
    // message would be silently lost. Here a single body carries TWO messages
    // for the SAME (phone_number_id, wa_id) conversation; after the flush the
    // chat endpoint must receive BOTH, in order.
    const body = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '100000000000001',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '15551234567',
                  phone_number_id: '200000000000002'
                },
                contacts: [{ profile: { name: 'Batch User' }, wa_id: '15557654321' }],
                messages: [
                  {
                    from: '15557654321',
                    id: 'wamid.BATCH.ONE',
                    timestamp: '1716000200',
                    type: 'text',
                    text: { body: 'first of two' }
                  },
                  {
                    from: '15557654321',
                    id: 'wamid.BATCH.TWO',
                    timestamp: '1716000201',
                    type: 'text',
                    text: { body: 'second of two' }
                  }
                ]
              }
            }
          ]
        }
      ]
    };
    const bodyBuf = Buffer.from(JSON.stringify(body));

    const res = await postSigned(app, bodyBuf);
    expect(res.status).toBe(200);

    // Two buffered messages push the flush delay to calculateBufferTimeout(2)
    // (> bufferBaseTimeoutMs), so advance well past the max window (12s ceiling)
    // rather than the single-message BUFFER_BASE_MS the shared helper uses.
    await vi.advanceTimersByTimeAsync(20_000);
    await flushMicrotasks();

    // ONE flush (the burst aggregates), and its chat request carries BOTH
    // messages in arrival order — neither was clobbered.
    expect(fakeChat.complete).toHaveBeenCalledTimes(1);
    const req = fakeChat.complete.mock.calls[0][0];
    expect(req.conversationKey).toBe('whatsapp:200000000000002:15557654321');
    expect(req.messages).toHaveLength(2);
    expect(req.messages.map((m: { channelMessageId: string }) => m.channelMessageId)).toEqual([
      'wamid.BATCH.ONE',
      'wamid.BATCH.TWO'
    ]);
    expect(req.messages.map((m: { text?: string }) => m.text)).toEqual(['first of two', 'second of two']);
    expect(req.message).toBe('first of two\nsecond of two');
  });

  it('keeps parse+log-only behavior when no agent is wired', async () => {
    // The agentless path is the contract the existing webhook-routing.test.ts
    // suite covers in full; this is a focused smoke check that createApp without
    // an agent still ACKs 200 and emits the channel-summary log (no routing).
    const agentlessLogger = makeSpyLogger();
    const agentlessApp = createApp({ config, logger: agentlessLogger });

    const bodyBuf = loadFixtureBuffer('whatsapp/text-inbound.json');
    const res = await postSigned(agentlessApp, bodyBuf);

    expect(res.status).toBe(200);
    expect(res.text).toBe('EVENT_RECEIVED');
    expect(agentlessLogger.mock.info).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'whatsapp',
        traceMarker: 'inbound.whatsapp',
        messageCount: 1
      }),
      'inbound webhook received'
    );
    // No agent → no send anywhere.
    expect(fakeChat.complete).not.toHaveBeenCalled();
  });
});
