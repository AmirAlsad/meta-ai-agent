/**
 * End-to-end Stage 8 proof: postback + referral inbound events reach the chat
 * endpoint.
 *
 * Same wiring as `end-to-end-flow.test.ts` — fakes ONLY at the two real-world
 * boundaries (the developer's chat endpoint and Meta's send API); everything
 * between (express app + signature verify, the parser, the in-memory store +
 * scheduler, the delivery queue, the ConversationAgent) is the REAL code:
 *
 *   signed POST → verify → parse → dispatchWebhook → agent.handleInbound
 *     → buffer flush (timer) → fake ChatClient.complete (captures ChatRequest)
 *
 * WHY a dedicated suite: postback/referral are NOT special-cased anywhere — they
 * are ordinary IncomingMessage variants that ride the SAME inbound buffer and
 * land in `ChatRequest.messages[]`. These tests POST the real signed fixtures
 * and assert the structured payload (postback payload / referral ref) survives
 * the full path to the chat endpoint, so an accidental drop of a non-text type
 * (over-broad echo filter, a text-only buffer guard) is caught here.
 */

import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import request from 'supertest';
import pino from 'pino';
import { createApp } from '../../src/http/app.js';
import type { Config } from '../../src/config/loader.js';
import { defaultConversationConfig } from '../../src/config/loader.js';
import { ConversationAgent } from '../../src/conversation/agent.js';
import { InMemoryConversationStore } from '../../src/conversation/store.js';
import { InMemoryBufferScheduler } from '../../src/conversation/scheduler.js';
import type { ChatClient } from '../../src/chat/client.js';
import type { ChatRequest, NormalizedChatResponse } from '../../src/chat/types.js';
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
// The IG fixture (`instagram/referral.json`) is signed with the Instagram app
// secret, NOT META_APP_SECRET — Instagram (`object: instagram`) webhooks are
// signed with the IG product secret (see InstagramConfig.appSecret). Set it so
// the signature verifies on the real app's verify middleware.
const INSTAGRAM_APP_SECRET = 'test-instagram-app-secret-1234567890';

function makeTestConfig(): Config {
  return {
    meta: {
      appId: undefined,
      appSecret: APP_SECRET,
      verifyToken: VERIFY_TOKEN,
      graphApiVersion: 'v25.0'
    },
    // pageId / userId match the ids in the Messenger/Instagram fixtures so the
    // parser's business id lines up with the configured channel.
    messenger: {
      pageId: '500000000000005',
      pageAccessToken: 'fake-messenger-page-access-token'
    },
    instagram: {
      userId: '17841400000000007',
      accessToken: 'fake-instagram-access-token',
      appSecret: INSTAGRAM_APP_SECRET
    },
    channels: { whatsapp: false, messenger: true, instagram: true },
    conversation: defaultConversationConfig(),
    chatEndpointUrl: 'http://localhost:9999/chat',
    ngrokDomain: 'test.ngrok-free.dev',
    agentAutostart: false,
    port: 3000,
    nodeEnv: 'test'
  };
}

/** A fake ChatClient capturing every ChatRequest it is called with. */
interface CapturingChatClient extends ChatClient {
  complete: Mock;
  calls: ChatRequest[];
}

function makeCapturingChatClient(): CapturingChatClient {
  const calls: ChatRequest[] = [];
  const response: NormalizedChatResponse = { actions: [{ type: 'message', text: 'hi there' }] };
  const complete = vi.fn(async (req: ChatRequest) => {
    calls.push(req);
    return response;
  });
  return { complete, calls };
}

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
        case 'media_send':
          return true;
        default:
          return false;
      }
    }
  };
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Signing + fixture helpers (same HMAC scheme as end-to-end-flow.test.ts)   */
/* ──────────────────────────────────────────────────────────────────────── */

function signBody(body: Buffer, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

/**
 * Load a fixture and RE-SERIALIZE it so the byte sequence is deterministic and
 * the signature computed over the returned buffer matches what supertest sends.
 */
function loadFixtureBuffer(relativePath: string): Buffer {
  const raw = readFileSync(path.join(fixturesDir, relativePath), 'utf8');
  return Buffer.from(JSON.stringify(JSON.parse(raw)));
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

const BUFFER_BASE_MS = defaultConversationConfig().bufferBaseTimeoutMs;

describe('postback / referral reach the chat endpoint (Stage 8 integration)', () => {
  let logger: pino.Logger;
  let config: Config;
  let store: InMemoryConversationStore;
  let scheduler: InMemoryBufferScheduler;
  let chat: CapturingChatClient;
  let adapters: Partial<Record<Channel, FakeAdapter>>;
  let agent: ConversationAgent;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.useFakeTimers();
    logger = pino({ level: 'silent' });
    config = makeTestConfig();
    store = new InMemoryConversationStore({ dedupeTtlSeconds: config.conversation.dedupeTtlSeconds });
    scheduler = new InMemoryBufferScheduler();
    chat = makeCapturingChatClient();
    adapters = {
      messenger: makeFakeAdapter('messenger'),
      instagram: makeFakeAdapter('instagram')
    };
    agent = new ConversationAgent({
      store,
      scheduler,
      chatClient: chat,
      adapters: adapters as Partial<Record<Channel, ChannelAdapter>>,
      config,
      logger,
      // Pin jitter to 0 so the first flush fires at exactly bufferBaseTimeoutMs.
      random: () => 0.5,
      sleep: async () => {}
    });
    app = createApp({ config, logger, agent });
  });

  afterEach(async () => {
    await agent.close();
    vi.useRealTimers();
  });

  /** POST a signed body, then drain microtasks so the fire-and-forget handler arms its timer. */
  async function postSigned(bodyBuf: Buffer, secret = APP_SECRET): Promise<request.Response> {
    const res = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('x-hub-signature-256', signBody(bodyBuf, secret))
      .send(bodyBuf.toString('utf8'));
    await flushMicrotasks();
    return res;
  }

  async function flushBuffer(): Promise<void> {
    await vi.advanceTimersByTimeAsync(BUFFER_BASE_MS + 1);
    await flushMicrotasks();
  }

  it('Messenger postback webhook → chat endpoint receives the postback (type + payload)', async () => {
    const bodyBuf = loadFixtureBuffer('messenger/postback.json');
    const res = await postSigned(bodyBuf);
    expect(res.status).toBe(200);
    expect(res.text).toBe('EVENT_RECEIVED');
    // Nothing dispatched before the buffer window elapses.
    expect(chat.complete).not.toHaveBeenCalled();

    await flushBuffer();

    expect(chat.complete).toHaveBeenCalledTimes(1);
    const req = chat.calls[0]!;
    expect(req.channel).toBe('messenger');
    // The structured postback survived parse → buffer → flush into messages[].
    const postbacks = req.messages.filter(m => m.type === 'postback');
    expect(postbacks).toHaveLength(1);
    expect(postbacks[0]!.postback).toEqual({
      title: 'Get Started',
      payload: 'GET_STARTED_PAYLOAD'
    });
  });

  it('Instagram referral webhook → chat endpoint receives the referral (with ref)', async () => {
    // IG fixtures are signed with the Instagram app secret, not META_APP_SECRET.
    const bodyBuf = loadFixtureBuffer('instagram/referral.json');
    const res = await postSigned(bodyBuf, INSTAGRAM_APP_SECRET);
    expect(res.status).toBe(200);
    expect(res.text).toBe('EVENT_RECEIVED');

    await flushBuffer();

    expect(chat.complete).toHaveBeenCalledTimes(1);
    const req = chat.calls[0]!;
    expect(req.channel).toBe('instagram');
    const referrals = req.messages.filter(m => m.type === 'referral');
    expect(referrals).toHaveLength(1);
    expect(referrals[0]!.referral).toMatchObject({
      source: 'IG_ME_LINK',
      type: 'OPEN_THREAD',
      ref: 'ig_campaign_ref_01'
    });
  });

  it('Messenger referral webhook → chat endpoint receives the referral (with ref)', async () => {
    const bodyBuf = loadFixtureBuffer('messenger/referral.json');
    const res = await postSigned(bodyBuf);
    expect(res.status).toBe(200);

    await flushBuffer();

    expect(chat.complete).toHaveBeenCalledTimes(1);
    const req = chat.calls[0]!;
    expect(req.channel).toBe('messenger');
    const referrals = req.messages.filter(m => m.type === 'referral');
    expect(referrals).toHaveLength(1);
    expect(referrals[0]!.referral).toMatchObject({
      source: 'ADS',
      type: 'OPEN_THREAD',
      ref: 'my_ref'
    });
  });
});
