/**
 * Hardware-free unit coverage for {@link RedisConversationStore} using a minimal
 * in-memory fake that implements only the ioredis surface the store calls
 * (get/set/del/ttl/scan). This pins the key-prefix scheme, JSON
 * serialization/round-trip, SET NX dedupe semantics, defensive parse, and the
 * SCAN prefix-stripping logic without needing a real Redis. Substantive
 * round-trip coverage against a real server lives in the redis-gated integration
 * test.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { RedisConversationStore } from '../../src/conversation/redis-store.js';
import { createIdleConversation } from '../../src/conversation/types.js';
import type { OutboundHandleMapping } from '../../src/conversation/types.js';

/** Minimal in-memory stand-in for the ioredis methods the store invokes. */
class FakeRedis {
  private readonly store = new Map<string, string>();
  private readonly expiry = new Map<string, number>();

  async get(key: string): Promise<string | null> {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }

  // Supports both `set(k, v, 'EX', n)` and `set(k, v, 'EX', n, 'NX')`.
  async set(key: string, value: string, ..._rest: unknown[]): Promise<'OK' | null> {
    const nx = _rest[_rest.length - 1] === 'NX';
    if (nx && this.store.has(key)) return null;
    this.store.set(key, value);
    const exIdx = _rest.indexOf('EX');
    if (exIdx >= 0) {
      const seconds = _rest[exIdx + 1] as number;
      this.expiry.set(key, seconds);
    }
    return 'OK';
  }

  async del(key: string): Promise<number> {
    const had = this.store.delete(key);
    this.expiry.delete(key);
    return had ? 1 : 0;
  }

  async ttl(key: string): Promise<number> {
    if (!this.store.has(key)) return -2;
    return this.expiry.has(key) ? (this.expiry.get(key) as number) : -1;
  }

  // Single-pass SCAN good enough for tests: always returns cursor '0'.
  async scan(_cursor: string, _match: 'MATCH', pattern: string, _count: 'COUNT', _n: number) {
    const re = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    const keys = [...this.store.keys()].filter((k) => re.test(k));
    return ['0', keys] as [string, string[]];
  }
}

function makeStore(redis: FakeRedis) {
  return new RedisConversationStore({
    redis: redis as unknown as Redis,
    dedupeTtlSeconds: 60,
    conversationTtlSeconds: 3600
  });
}

describe('RedisConversationStore (fake redis)', () => {
  it('round-trips a conversation record under the prefixed key', async () => {
    const fake = new FakeRedis();
    const store = makeStore(fake);
    const record = createIdleConversation({
      key: 'whatsapp:biz:user',
      channel: 'whatsapp',
      channelScopedUserId: 'user',
      channelScopedBusinessId: 'biz'
    });

    await store.setConversation(record);
    expect(await fake.get('meta-ai-agent:conversation:whatsapp:biz:user')).toBe(
      JSON.stringify(record)
    );

    const got = await store.getConversation('whatsapp:biz:user');
    expect(got).toEqual(record);

    await store.deleteConversation('whatsapp:biz:user');
    expect(await store.getConversation('whatsapp:biz:user')).toBeUndefined();
  });

  it('getConversation returns undefined for an absent key', async () => {
    const store = makeStore(new FakeRedis());
    expect(await store.getConversation('nope')).toBeUndefined();
  });

  it('claimInboundHandle is SET NX: first claim true, duplicate false', async () => {
    const store = makeStore(new FakeRedis());
    expect(await store.claimInboundHandle('wamid.1')).toBe(true);
    expect(await store.claimInboundHandle('wamid.1')).toBe(false);
    expect(await store.claimInboundHandle('wamid.2')).toBe(true);
  });

  it('peekInboundHandle reports presence + ttl semantics', async () => {
    const fake = new FakeRedis();
    const store = makeStore(fake);
    expect(await store.peekInboundHandle('absent')).toEqual({ present: false });

    await store.claimInboundHandle('present');
    expect(await store.peekInboundHandle('present')).toEqual({ present: true, ttlSeconds: 60 });
  });

  it('peekInboundHandle: present without expiry yields undefined ttlSeconds', async () => {
    const fake = new FakeRedis();
    // Write a dedupe key with no EX (ttl -> -1).
    await fake.set('meta-ai-agent:dedupe:inbound:noexp', '1');
    const store = makeStore(fake);
    expect(await store.peekInboundHandle('noexp')).toEqual({ present: true, ttlSeconds: undefined });
  });

  it('outbound-handle map round-trips and deletes', async () => {
    const fake = new FakeRedis();
    const store = makeStore(fake);
    const mapping: OutboundHandleMapping = {
      conversationKey: 'whatsapp:biz:user',
      messageIndex: 2,
      traceId: 'trace-abc'
    };

    await store.mapOutboundHandle('wamid.out', mapping);
    expect(await fake.get('meta-ai-agent:outbound:wamid.out')).toBe(JSON.stringify(mapping));
    expect(await store.getOutboundHandleMapping('wamid.out')).toEqual(mapping);
    expect(await store.getOutboundHandleMapping('missing')).toBeUndefined();

    await store.deleteOutboundHandleMapping('wamid.out');
    expect(await store.getOutboundHandleMapping('wamid.out')).toBeUndefined();
  });

  it('listConversationKeys yields BARE keys (prefix stripped), only conversation:*', async () => {
    const fake = new FakeRedis();
    const store = makeStore(fake);
    for (const k of ['whatsapp:b:u1', 'messenger:p:u2', 'instagram:i:u3']) {
      await store.setConversation(
        createIdleConversation({
          key: k,
          channel: 'whatsapp',
          channelScopedUserId: 'u',
          channelScopedBusinessId: 'b'
        })
      );
    }
    // Decoys that must NOT be enumerated.
    await store.claimInboundHandle('dedupe-decoy');
    await store.mapOutboundHandle('outbound-decoy', {
      conversationKey: 'x',
      messageIndex: 0
    });

    const collected: string[] = [];
    for await (const key of store.listConversationKeys()) collected.push(key);

    expect(collected.sort()).toEqual(['instagram:i:u3', 'messenger:p:u2', 'whatsapp:b:u1']);
  });

  it('defensive parse: corrupt JSON logs warn and returns undefined', async () => {
    const fake = new FakeRedis();
    await fake.set('meta-ai-agent:conversation:bad', '{not valid json');
    const warn = vi.fn();
    const store = new RedisConversationStore({
      redis: fake as unknown as Redis,
      dedupeTtlSeconds: 60,
      conversationTtlSeconds: 3600,
      logger: { warn } as never
    });

    expect(await store.getConversation('bad')).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('close() is a no-op and does NOT disconnect the injected client', async () => {
    const fake = new FakeRedis();
    const disconnect = vi.fn();
    (fake as unknown as { disconnect: () => void }).disconnect = disconnect;
    const store = makeStore(fake);
    await store.close();
    expect(disconnect).not.toHaveBeenCalled();
  });
});
