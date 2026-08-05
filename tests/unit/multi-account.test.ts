/**
 * Multi-account transport tests: the {@link AdapterRegistry} resolution
 * contract, the `__<name>`-suffixed env account collections in `loadConfig`,
 * and the conversation agent's registry-based outbound adapter selection
 * (including `accountName` threading into the chat request).
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import {
  loadConfig,
  configuredAccounts,
  tokenFormatWarnings,
  defaultConversationConfig,
  defaultPersistenceConfig,
  defaultLimitsConfig,
  type Config
} from '../../src/config/loader.js';
import { AdapterRegistry } from '../../src/meta/shared/registry.js';
import type { ChannelAdapter, SendResult } from '../../src/meta/shared/adapter.js';
import type { Channel, IncomingMessage } from '../../src/meta/types.js';
import type { ChatClient } from '../../src/chat/client.js';
import type { ChatRequest } from '../../src/chat/types.js';
import type { NormalizedChatResponse } from '../../src/chat/types.js';
import { ConversationAgent } from '../../src/conversation/agent.js';
import { InMemoryConversationStore } from '../../src/conversation/store.js';
import { InMemoryBufferScheduler } from '../../src/conversation/scheduler.js';

const silentLogger = pino({ level: 'silent' });
const FIXED_NOW = 1_700_000_000_000;

/* ──────────────────────────────────────────────────────────────────────── */
/* Env helpers                                                              */
/* ──────────────────────────────────────────────────────────────────────── */

/** Minimal env satisfying the loader's required vars, Messenger-only default. */
function baseEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {
    META_APP_SECRET: 'fake-app-secret',
    META_VERIFY_TOKEN: 'verify-token-1234567890',
    CHAT_ENDPOINT_URL: 'https://chat.example.com/agent',
    MESSENGER_PAGE_ID: 'page-default',
    MESSENGER_PAGE_ACCESS_TOKEN: 'EAAdefaulttoken',
    NGROK_DOMAIN: 'foo.ngrok-free.app',
    ...overrides
  };
  for (const key of Object.keys(env)) {
    if (env[key] === undefined) delete env[key];
  }
  return env as NodeJS.ProcessEnv;
}

/* ──────────────────────────────────────────────────────────────────────── */
/* AdapterRegistry                                                          */
/* ──────────────────────────────────────────────────────────────────────── */

function fakeAdapter(channel: Channel): ChannelAdapter {
  const sendResult = (recipientId: string): SendResult => ({
    channel,
    messageId: `${channel}-m1`,
    recipientId,
    timestamp: FIXED_NOW
  });
  return {
    channel,
    supports: () => false,
    sendText: vi.fn(async (recipientId: string) => sendResult(recipientId)),
    sendTypingIndicator: vi.fn(async () => undefined),
    markRead: vi.fn(async () => undefined),
    sendReaction: vi.fn(async () => undefined),
    sendMedia: vi.fn(async (recipientId: string) => sendResult(recipientId))
  };
}

describe('AdapterRegistry', () => {
  it('resolves an exact channel:businessId match on a multi-account channel', () => {
    const registry = new AdapterRegistry();
    const a = fakeAdapter('messenger');
    const b = fakeAdapter('messenger');
    registry.register({ channel: 'messenger', accountName: 'official', businessId: 'page-1', adapter: a });
    registry.register({ channel: 'messenger', accountName: 'reed', businessId: 'page-2', adapter: b });

    expect(registry.resolve('messenger', 'page-2')?.adapter).toBe(b);
    expect(registry.resolve('messenger', 'page-2')?.accountName).toBe('reed');
    expect(registry.resolve('messenger', 'page-1')?.accountName).toBe('official');
  });

  it('returns undefined for an unknown businessId when the channel has several accounts', () => {
    const registry = new AdapterRegistry();
    registry.register({ channel: 'messenger', accountName: 'a', businessId: 'p1', adapter: fakeAdapter('messenger') });
    registry.register({ channel: 'messenger', accountName: 'b', businessId: 'p2', adapter: fakeAdapter('messenger') });
    expect(registry.resolve('messenger', 'p-unknown')).toBeUndefined();
    expect(registry.resolve('messenger')).toBeUndefined();
  });

  it('falls back to the sole account on a single-account channel, for any or no businessId', () => {
    const registry = new AdapterRegistry();
    const only = fakeAdapter('instagram');
    registry.register({ channel: 'instagram', accountName: 'default', businessId: 'ig-1', adapter: only });
    expect(registry.resolve('instagram', 'ig-1')?.adapter).toBe(only);
    expect(registry.resolve('instagram', 'somebody-else')?.adapter).toBe(only);
    expect(registry.resolve('instagram')?.adapter).toBe(only);
  });

  it('throws on a duplicate channel:businessId registration', () => {
    const registry = new AdapterRegistry();
    registry.register({ channel: 'messenger', accountName: 'a', businessId: 'p1', adapter: fakeAdapter('messenger') });
    expect(() =>
      registry.register({ channel: 'messenger', accountName: 'b', businessId: 'p1', adapter: fakeAdapter('messenger') })
    ).toThrow(/Duplicate adapter registration/);
  });

  it('fromChannelMap wraps the legacy map as single-account fallbacks', () => {
    const wa = fakeAdapter('whatsapp');
    const registry = AdapterRegistry.fromChannelMap({ whatsapp: wa });
    expect(registry.resolve('whatsapp', 'any-biz-id')?.adapter).toBe(wa);
    expect(registry.resolve('whatsapp', 'any-biz-id')?.accountName).toBe('default');
    expect(registry.resolve('messenger', 'p1')).toBeUndefined();
    expect(registry.hasChannel('whatsapp')).toBe(true);
    expect(registry.hasChannel('messenger')).toBe(false);
  });
});

/* ──────────────────────────────────────────────────────────────────────── */
/* loadConfig: named account collections                                    */
/* ──────────────────────────────────────────────────────────────────────── */

describe('loadConfig: multi-account env collections', () => {
  it('discovers __<name> accounts and merges them after the bare default', () => {
    const config = loadConfig(
      baseEnv({
        MESSENGER_PAGE_ID__reed: 'page-reed',
        MESSENGER_PAGE_ACCESS_TOKEN__reed: 'EAAreedtoken',
        MESSENGER_PAGE_ID__iris: 'page-iris',
        MESSENGER_PAGE_ACCESS_TOKEN__iris: 'EAAiristoken'
      })
    );
    expect(config.accounts?.messenger.map(a => a.accountName)).toEqual(['default', 'iris', 'reed']);
    expect(config.accounts?.messenger.find(a => a.accountName === 'reed')?.pageId).toBe('page-reed');
    // The legacy single-account field still carries the bare-var account.
    expect(config.messenger?.pageId).toBe('page-default');
    expect(config.channels.messenger).toBe(true);
  });

  it('supports suffixed-only channels (no bare vars) and still flags the channel enabled', () => {
    const config = loadConfig(
      baseEnv({
        INSTAGRAM_USER_ID__reed: 'ig-reed',
        INSTAGRAM_ACCESS_TOKEN__reed: 'IGAAreedtoken',
        INSTAGRAM_APP_SECRET: 'ig-app-secret'
      })
    );
    expect(config.instagram).toBeUndefined();
    expect(config.channels.instagram).toBe(true);
    expect(config.accounts?.instagram).toHaveLength(1);
    // App-level secret is inherited by named accounts.
    expect(config.accounts?.instagram[0]?.appSecret).toBe('ig-app-secret');
  });

  it('throws on a half-configured named account, naming the suffixed vars', () => {
    expect(() => loadConfig(baseEnv({ MESSENGER_PAGE_ID__reed: 'page-reed' }))).toThrow(
      /Messenger account "reed".*MESSENGER_PAGE_ACCESS_TOKEN__reed/s
    );
  });

  it('throws on an invalid account name (underscores)', () => {
    expect(() =>
      loadConfig(
        baseEnv({
          MESSENGER_PAGE_ID__bad_name: 'p',
          MESSENGER_PAGE_ACCESS_TOKEN__bad_name: 't'
        })
      )
    ).toThrow(/Invalid account name "bad_name"/);
  });

  it('throws on the reserved name "default"', () => {
    expect(() =>
      loadConfig(
        baseEnv({
          MESSENGER_PAGE_ID__default: 'p',
          MESSENGER_PAGE_ACCESS_TOKEN__default: 't'
        })
      )
    ).toThrow(/reserved/);
  });

  it('throws when two accounts share a business id', () => {
    expect(() =>
      loadConfig(
        baseEnv({
          MESSENGER_PAGE_ID__reed: 'page-default', // collides with the bare account
          MESSENGER_PAGE_ACCESS_TOKEN__reed: 'EAAreedtoken'
        })
      )
    ).toThrow(/Duplicate Messenger business id page-default/);
  });

  it('tokenFormatWarnings names the suffixed var for a named account', () => {
    const config = loadConfig(
      baseEnv({
        MESSENGER_PAGE_ID__reed: 'page-reed',
        MESSENGER_PAGE_ACCESS_TOKEN__reed: 'not-a-page-token'
      })
    );
    const warnings = tokenFormatWarnings(config);
    expect(warnings.map(w => w.field)).toContain('MESSENGER_PAGE_ACCESS_TOKEN__reed');
    // The bare account's token starts with EAA — no warning for it.
    expect(warnings.map(w => w.field)).not.toContain('MESSENGER_PAGE_ACCESS_TOKEN');
  });

  it('configuredAccounts derives the default account from legacy-shaped configs', () => {
    const legacy = {
      meta: { appId: undefined, appSecret: 's', verifyToken: 'x'.repeat(16), graphApiVersion: 'v25.0' },
      messenger: { pageId: 'p-legacy', pageAccessToken: 'EAAlegacy' },
      channels: { whatsapp: false, messenger: true, instagram: false },
      conversation: defaultConversationConfig(),
      persistence: defaultPersistenceConfig(),
      limits: defaultLimitsConfig(),
      chatEndpointUrl: 'https://example.test/chat',
      ngrokDomain: 'foo.ngrok-free.app',
      agentAutostart: false,
      port: 3000,
      nodeEnv: 'test'
    } as Config;
    const accounts = configuredAccounts(legacy);
    expect(accounts.messenger).toEqual([
      { accountName: 'default', pageId: 'p-legacy', pageAccessToken: 'EAAlegacy' }
    ]);
    expect(accounts.instagram).toEqual([]);
  });
});

/* ──────────────────────────────────────────────────────────────────────── */
/* ConversationAgent: registry-based outbound selection                     */
/* ──────────────────────────────────────────────────────────────────────── */

function makeAgentConfig(): Config {
  return {
    meta: { appId: undefined, appSecret: 's', verifyToken: 'x'.repeat(16), graphApiVersion: 'v25.0' },
    channels: { whatsapp: false, messenger: true, instagram: false },
    conversation: defaultConversationConfig(),
    persistence: defaultPersistenceConfig(),
    limits: defaultLimitsConfig(),
    chatEndpointUrl: 'https://example.test/chat',
    ngrokDomain: 'foo.ngrok-free.app',
    agentAutostart: false,
    port: 3000,
    nodeEnv: 'test'
  } as Config;
}

function makeChatClient(response: NormalizedChatResponse): ChatClient & { calls: ChatRequest[] } {
  const calls: ChatRequest[] = [];
  return {
    calls,
    complete: vi.fn(async (request: ChatRequest) => {
      calls.push(request);
      return response;
    })
  };
}

function messengerInbound(businessId: string, overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    channel: 'messenger',
    channelMessageId: `m_${Math.random().toString(36).slice(2)}`,
    channelScopedUserId: 'psid-user-1',
    channelScopedBusinessId: businessId,
    timestamp: FIXED_NOW,
    type: 'text',
    text: 'hello there',
    raw: {},
    ...overrides
  };
}

describe('ConversationAgent: multi-account adapter selection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeMultiAccountHarness(): {
    agent: ConversationAgent;
    chat: ChatClient & { calls: ChatRequest[] };
    official: ChannelAdapter;
    reed: ChannelAdapter;
  } {
    const registry = new AdapterRegistry();
    const official = fakeAdapter('messenger');
    const reed = fakeAdapter('messenger');
    registry.register({ channel: 'messenger', accountName: 'official', businessId: 'page-official', adapter: official });
    registry.register({ channel: 'messenger', accountName: 'reed', businessId: 'page-reed', adapter: reed });
    const chat = makeChatClient({ actions: [{ type: 'message', text: 'hi from the coach' }] });
    const config = makeAgentConfig();
    const agent = new ConversationAgent({
      store: new InMemoryConversationStore({ dedupeTtlSeconds: config.conversation.dedupeTtlSeconds }),
      scheduler: new InMemoryBufferScheduler(),
      chatClient: chat,
      adapters: registry,
      config,
      logger: silentLogger,
      random: () => 0.5,
      now: () => FIXED_NOW,
      sleep: async () => undefined
    });
    return { agent, chat, official, reed };
  }

  it("routes the reply through the adapter registered for the inbound's businessId", async () => {
    const h = makeMultiAccountHarness();
    await h.agent.handleInbound(messengerInbound('page-reed'));
    await vi.advanceTimersByTimeAsync(20_000);

    expect(h.reed.sendText).toHaveBeenCalledTimes(1);
    expect(h.official.sendText).not.toHaveBeenCalled();
  });

  it('threads the resolved accountName into the chat request', async () => {
    const h = makeMultiAccountHarness();
    await h.agent.handleInbound(messengerInbound('page-reed'));
    await vi.advanceTimersByTimeAsync(20_000);

    expect(h.chat.calls).toHaveLength(1);
    expect(h.chat.calls[0]?.accountName).toBe('reed');
    expect(h.chat.calls[0]?.channel).toBe('messenger');
  });

  it('drops the turn (no chat call, no send) for a businessId no account claims', async () => {
    const h = makeMultiAccountHarness();
    await h.agent.handleInbound(messengerInbound('page-stranger'));
    await vi.advanceTimersByTimeAsync(20_000);

    expect(h.chat.calls).toHaveLength(0);
    expect(h.official.sendText).not.toHaveBeenCalled();
    expect(h.reed.sendText).not.toHaveBeenCalled();
  });

  it('legacy channel-map construction still answers for any businessId (single-account fallback)', async () => {
    const adapter = fakeAdapter('messenger');
    const chat = makeChatClient({ actions: [{ type: 'message', text: 'hello' }] });
    const config = makeAgentConfig();
    const agent = new ConversationAgent({
      store: new InMemoryConversationStore({ dedupeTtlSeconds: config.conversation.dedupeTtlSeconds }),
      scheduler: new InMemoryBufferScheduler(),
      chatClient: chat,
      adapters: { messenger: adapter },
      config,
      logger: silentLogger,
      random: () => 0.5,
      now: () => FIXED_NOW,
      sleep: async () => undefined
    });
    await agent.handleInbound(messengerInbound('page-anything'));
    await vi.advanceTimersByTimeAsync(20_000);

    expect(adapter.sendText).toHaveBeenCalledTimes(1);
    expect(chat.calls[0]?.accountName).toBe('default');
  });
});
