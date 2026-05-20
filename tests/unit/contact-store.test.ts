/**
 * Unit tests for the Stage 6 in-memory contact store (the identity-resolver
 * cache): set→get round-trip with the load-bearing clone-on-read/write contract
 * (mutation isolation), key replacement, delete, and the unknown-key miss.
 */
import { describe, expect, it } from 'vitest';
import { InMemoryContactStore } from '../../src/identity/contact-store.js';
import type { Contact } from '../../src/identity/types.js';

function makeContact(overrides: Partial<Contact> = {}): Contact {
  return {
    channel: 'whatsapp',
    channelScopedUserId: 'wa-1',
    firstName: 'Ada',
    lastName: 'Lovelace',
    tags: ['tier:gold'],
    customVariables: { plan: 'pro' },
    ...overrides
  };
}

describe('InMemoryContactStore', () => {
  it('set then get returns an equal contact', () => {
    const store = new InMemoryContactStore();
    const contact = makeContact();
    store.set(contact);
    expect(store.get('whatsapp', 'wa-1')).toEqual(contact);
  });

  it('get returns a CLONE — mutating it does not change stored state (clone on read)', () => {
    const store = new InMemoryContactStore();
    store.set(makeContact());

    const got = store.get('whatsapp', 'wa-1')!;
    // Distinct identity on the object and its nested array/map.
    const second = store.get('whatsapp', 'wa-1')!;
    expect(got).not.toBe(second);
    expect(got.tags).not.toBe(second.tags);

    got.firstName = 'TAMPERED';
    got.tags!.push('tampered');
    got.customVariables!.plan = 'tampered';

    const again = store.get('whatsapp', 'wa-1')!;
    expect(again.firstName).toBe('Ada');
    expect(again.tags).toEqual(['tier:gold']);
    expect(again.customVariables).toEqual({ plan: 'pro' });
  });

  it('mutating the contact AFTER set does not change stored state (clone on write)', () => {
    const store = new InMemoryContactStore();
    const contact = makeContact();
    store.set(contact);

    // Caller keeps mutating their copy after handing it to the store.
    contact.firstName = 'TAMPERED';
    contact.tags!.push('tampered');

    const got = store.get('whatsapp', 'wa-1')!;
    expect(got.firstName).toBe('Ada');
    expect(got.tags).toEqual(['tier:gold']);
  });

  it('set replaces an existing contact for the same key', () => {
    const store = new InMemoryContactStore();
    store.set(makeContact({ firstName: 'Old' }));
    store.set(makeContact({ firstName: 'New' }));
    expect(store.get('whatsapp', 'wa-1')!.firstName).toBe('New');
  });

  it('keys by (channel, channelScopedUserId) — same user id on a different channel is independent', () => {
    const store = new InMemoryContactStore();
    store.set(makeContact({ channel: 'whatsapp', firstName: 'WA' }));
    store.set(makeContact({ channel: 'messenger', firstName: 'FB' }));
    expect(store.get('whatsapp', 'wa-1')!.firstName).toBe('WA');
    expect(store.get('messenger', 'wa-1')!.firstName).toBe('FB');
  });

  it('get for an unknown key returns undefined', () => {
    const store = new InMemoryContactStore();
    expect(store.get('whatsapp', 'nope')).toBeUndefined();
  });

  it('delete removes a stored contact', () => {
    const store = new InMemoryContactStore();
    store.set(makeContact());
    expect(store.get('whatsapp', 'wa-1')).toBeDefined();

    store.delete('whatsapp', 'wa-1');
    expect(store.get('whatsapp', 'wa-1')).toBeUndefined();
  });

  it('delete of an unknown key is a no-op (does not throw)', () => {
    const store = new InMemoryContactStore();
    expect(() => store.delete('whatsapp', 'ghost')).not.toThrow();
  });
});
