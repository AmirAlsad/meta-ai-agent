/**
 * Unit tests for the Stage 5 in-memory conversation store: record CRUD with the
 * load-bearing clone-on-read/write contract, SETNX-with-TTL inbound dedupe (and
 * its TTL expiry, driven by fake timers), the non-destructive peek, the
 * outbound-handle map, and conversation-key enumeration.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultConversationConfig } from '../../src/config/loader.js';
import { InMemoryConversationStore } from '../../src/conversation/store.js';
import { createIdleConversation } from '../../src/conversation/types.js';
import type { ConversationRecord, OutboundHandleMapping } from '../../src/conversation/types.js';

/** Store with the documented defaults (dedupeTtlSeconds = 86400). */
function makeStore(dedupeTtlSeconds = defaultConversationConfig().dedupeTtlSeconds): InMemoryConversationStore {
  return new InMemoryConversationStore({ dedupeTtlSeconds });
}

/** A minimal-but-realistic conversation record for CRUD assertions. */
function makeRecord(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  const base = createIdleConversation({
    key: 'whatsapp:pn-1:wa-1',
    channel: 'whatsapp',
    channelScopedUserId: 'wa-1',
    channelScopedBusinessId: 'pn-1',
    now: 1_700_000_000_000
  });
  return { ...base, ...overrides };
}

describe('InMemoryConversationStore — conversation CRUD', () => {
  it('set then get returns an equal record that is NOT the same reference', async () => {
    const store = makeStore();
    const record = makeRecord();
    await store.setConversation(record);

    const first = await store.getConversation(record.key);
    expect(first).toEqual(record);
    // Distinct object identity at the top level and on nested arrays.
    expect(first).not.toBe(record);
    expect(first!.inboundBuffer).not.toBe(record.inboundBuffer);
  });

  it('mutating the returned record does NOT change stored state (clone on read)', async () => {
    const store = makeStore();
    await store.setConversation(makeRecord());

    const got = await store.getConversation('whatsapp:pn-1:wa-1');
    got!.state = 'sending';
    got!.deliveredMessageIds.push('wamid.tampered');

    const again = await store.getConversation('whatsapp:pn-1:wa-1');
    expect(again!.state).toBe('idle');
    expect(again!.deliveredMessageIds).toEqual([]);
  });

  it('mutating the record AFTER set does NOT change stored state (clone on write)', async () => {
    const store = makeStore();
    const record = makeRecord();
    await store.setConversation(record);

    // Caller keeps mutating their copy after handing it to the store.
    record.state = 'processing';
    record.deliveredMessageIds.push('wamid.late');

    const got = await store.getConversation(record.key);
    expect(got!.state).toBe('idle');
    expect(got!.deliveredMessageIds).toEqual([]);
  });

  it('get for an unknown key returns undefined', async () => {
    const store = makeStore();
    expect(await store.getConversation('whatsapp:nope:nope')).toBeUndefined();
  });

  it('delete removes a stored record', async () => {
    const store = makeStore();
    await store.setConversation(makeRecord());
    expect(await store.getConversation('whatsapp:pn-1:wa-1')).toBeDefined();

    await store.deleteConversation('whatsapp:pn-1:wa-1');
    expect(await store.getConversation('whatsapp:pn-1:wa-1')).toBeUndefined();
  });
});

describe('InMemoryConversationStore — inbound dedupe (claim/peek)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('claimInboundHandle returns true the first time and false on a redelivery within TTL', async () => {
    const store = makeStore();
    expect(await store.claimInboundHandle('wamid.A')).toBe(true);
    expect(await store.claimInboundHandle('wamid.A')).toBe(false);
    // A different id is independent.
    expect(await store.claimInboundHandle('wamid.B')).toBe(true);
  });

  it('claim succeeds again after the TTL expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const ttlSeconds = 10;
    const store = makeStore(ttlSeconds);

    expect(await store.claimInboundHandle('wamid.A')).toBe(true);
    // Still within the TTL window -> duplicate.
    vi.setSystemTime((ttlSeconds - 1) * 1000);
    expect(await store.claimInboundHandle('wamid.A')).toBe(false);
    // Advance just past the expiry boundary -> claimable again.
    vi.setSystemTime(ttlSeconds * 1000 + 1);
    expect(await store.claimInboundHandle('wamid.A')).toBe(true);
  });

  it('peekInboundHandle reports present (with a positive ttl) after a claim', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const store = makeStore(100);
    await store.claimInboundHandle('wamid.A');

    const peek = await store.peekInboundHandle('wamid.A');
    expect(peek.present).toBe(true);
    expect(peek.ttlSeconds).toBeGreaterThan(0);
    expect(peek.ttlSeconds).toBeLessThanOrEqual(100);
  });

  it('peekInboundHandle does NOT claim (a later claim still succeeds)', async () => {
    const store = makeStore();
    expect(await store.peekInboundHandle('wamid.fresh')).toEqual({ present: false });
    // Peeking left no mark, so the first real claim is the FIRST sighting.
    expect(await store.claimInboundHandle('wamid.fresh')).toBe(true);
  });

  it('peekInboundHandle reports absent after the TTL expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const ttlSeconds = 5;
    const store = makeStore(ttlSeconds);
    await store.claimInboundHandle('wamid.A');

    vi.setSystemTime(ttlSeconds * 1000 + 1);
    expect(await store.peekInboundHandle('wamid.A')).toEqual({ present: false });
  });

  it('peekInboundHandle reports absent for an unknown handle', async () => {
    const store = makeStore();
    expect(await store.peekInboundHandle('wamid.unknown')).toEqual({ present: false });
  });
});

describe('InMemoryConversationStore — outbound handle mapping', () => {
  const mapping: OutboundHandleMapping = {
    conversationKey: 'whatsapp:pn-1:wa-1',
    messageIndex: 2,
    traceId: 'trace-xyz'
  };

  it('map then get returns an equal mapping that is NOT the same reference', async () => {
    const store = makeStore();
    await store.mapOutboundHandle('wamid.OUT', mapping);

    const got = await store.getOutboundHandleMapping('wamid.OUT');
    expect(got).toEqual(mapping);
    expect(got).not.toBe(mapping);
  });

  it('mutating the returned mapping does NOT change stored state', async () => {
    const store = makeStore();
    await store.mapOutboundHandle('wamid.OUT', mapping);

    const got = await store.getOutboundHandleMapping('wamid.OUT');
    got!.messageIndex = 99;

    const again = await store.getOutboundHandleMapping('wamid.OUT');
    expect(again!.messageIndex).toBe(2);
  });

  it('get for an unknown handle returns undefined', async () => {
    const store = makeStore();
    expect(await store.getOutboundHandleMapping('wamid.missing')).toBeUndefined();
  });

  it('delete removes the mapping', async () => {
    const store = makeStore();
    await store.mapOutboundHandle('wamid.OUT', mapping);
    await store.deleteOutboundHandleMapping('wamid.OUT');
    expect(await store.getOutboundHandleMapping('wamid.OUT')).toBeUndefined();
  });
});

describe('InMemoryConversationStore — listConversationKeys', () => {
  it('yields every set key', async () => {
    const store = makeStore();
    const keys = ['whatsapp:pn-1:wa-1', 'messenger:page-1:psid-1', 'instagram:ig-1:igsid-1'];
    for (const key of keys) {
      await store.setConversation(makeRecord({ key }));
    }

    const seen: string[] = [];
    for await (const key of store.listConversationKeys()) {
      seen.push(key);
    }
    expect(seen.sort()).toEqual([...keys].sort());
  });

  it('yields nothing for an empty store', async () => {
    const store = makeStore();
    const seen: string[] = [];
    for await (const key of store.listConversationKeys()) {
      seen.push(key);
    }
    expect(seen).toEqual([]);
  });
});
