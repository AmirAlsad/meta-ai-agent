/**
 * Unit tests for the identity-lookup example's PURE handler:
 *  - `lookupIdentity` (examples/identity-lookup)
 *
 * This is the `USER_LOOKUP_URL` stub, NOT a chat endpoint. We test only the pure
 * request→Contact function — no HTTP server. The known-user contacts are
 * hardcoded in the example; we assert the shape the agent's resolver would
 * receive (and coerce) for the two known ids, plus the `null` for an unknown id.
 */
import { describe, expect, it } from 'vitest';
import { lookupIdentity } from '../../examples/identity-lookup/index.js';

/** Build a minimal identity-lookup request for a given channel-scoped user id. */
function makeLookupRequest(
  channelScopedUserId: string,
  channel = 'whatsapp',
  channelScopedBusinessId = 'biz-1'
): { channel: string; channelScopedUserId: string; channelScopedBusinessId: string } {
  return { channel, channelScopedUserId, channelScopedBusinessId };
}

describe('lookupIdentity (identity-lookup)', () => {
  it('returns the WhatsApp contact (name/email/tags) for the first known id', () => {
    const contact = lookupIdentity(makeLookupRequest('447700900123', 'whatsapp'));
    expect(contact).toEqual({
      channel: 'whatsapp',
      channelScopedUserId: '447700900123',
      firstName: 'Alice',
      lastName: 'Anderson',
      email: 'alice@example.com',
      tags: ['tier:gold', 'beta'],
      unifiedContactId: 'crm-0001'
    });
  });

  it('returns the Messenger contact (displayName/customVariables) for the second known id', () => {
    const contact = lookupIdentity(makeLookupRequest('987654321098765', 'messenger'));
    expect(contact).toEqual({
      channel: 'messenger',
      channelScopedUserId: '987654321098765',
      displayName: 'Bob B.',
      customVariables: { plan: 'pro', locale: 'en-US' },
      unifiedContactId: 'crm-0002'
    });
  });

  it('stamps channel/channelScopedUserId from the REQUEST, not the directory entry', () => {
    // The directory keys on channelScopedUserId; the contact's channel + id come
    // from the request (mirroring how the resolver re-stamps them). So looking up
    // the known WhatsApp id on a different channel yields that channel back.
    const contact = lookupIdentity(makeLookupRequest('447700900123', 'instagram', 'biz-9'));
    expect(contact).not.toBeNull();
    expect(contact?.channel).toBe('instagram');
    expect(contact?.channelScopedUserId).toBe('447700900123');
  });

  it('returns null for an unknown id (agent fail-opens to no enrichment)', () => {
    expect(lookupIdentity(makeLookupRequest('000000000000'))).toBeNull();
  });

  it('returns a Contact carrying at least one recognized enrichment field', () => {
    // The agent's shapeContact returns undefined for a body with NO recognized
    // field, so a stub contact is only useful if it carries one. Assert each
    // known contact has a non-empty enrichment beyond the echoed channel/id.
    for (const id of ['447700900123', '987654321098765']) {
      const contact = lookupIdentity(makeLookupRequest(id));
      expect(contact).not.toBeNull();
      const { channel: _c, channelScopedUserId: _u, ...enrichment } = contact!;
      expect(Object.keys(enrichment).length).toBeGreaterThan(0);
    }
  });
});
