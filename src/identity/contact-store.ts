/**
 * Contact persistence: the {@link ContactStore} interface plus an in-memory
 * implementation used by the identity resolver as a lookup cache.
 *
 * The store caches resolved {@link Contact}s keyed by `${channel}:${userId}` so
 * a repeated inbound from the same sender does not re-hit the developer's
 * `USER_LOOKUP_URL` on every message. The resolver checks this BEFORE the HTTP
 * call (cache-then-fetch) and writes back on a successful enrichment.
 *
 * WHY in-memory only here: state lives in a plain `Map`, is per-process, and
 * disappears on restart — exactly like {@link InMemoryConversationStore}. It is
 * an UNBOUNDED in-process cache (no TTL, no eviction): acceptable for Stage 6
 * because enrichment is best-effort and the cardinality of distinct senders per
 * process is bounded in practice. A TTL/Redis-backed store (so the cache can be
 * shared across replicas and bounded/expired) is a deliberately deferred,
 * later concern — the interface below is the contract a future impl will honor.
 */

import type { Contact } from './types.js';

export interface ContactStore {
  /** Cache lookup for a resolved contact. `undefined` on a miss. */
  get(channel: string, channelScopedUserId: string): Contact | undefined;
  /** Store/replace the cached contact. Keyed off `contact.channel`/`channelScopedUserId`. */
  set(contact: Contact): void;
  /** Drop a cached contact (e.g. to force a re-resolution). */
  delete(channel: string, channelScopedUserId: string): void;
}

/**
 * Compose the cache key. A single helper so `get`/`set`/`delete` can never
 * disagree on the key shape. The `:` separator matches the conversation-key
 * convention used elsewhere in the package.
 */
function contactKey(channel: string, channelScopedUserId: string): string {
  return `${channel}:${channelScopedUserId}`;
}

/**
 * Deep-clone via JSON round-trip.
 *
 * WHY this is load-bearing: the {@link ContactStore} contract is pass-by-value,
 * not pass-by-reference (same posture as {@link InMemoryConversationStore}). A
 * caller that reads a cached contact and mutates it (appends a tag, edits a
 * custom variable) must NOT corrupt the cached copy in place — and a caller that
 * mutates the object it handed to `set` afterwards must not reach in either.
 * Cloning on both read and write isolates the caller's working copy from the
 * stored copy. {@link Contact} is JSON-safe (strings, string arrays, a
 * string→string map), so a JSON deep copy is sufficient and dependency-free.
 */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * In-memory {@link ContactStore} backed by a plain `Map`. For tests, local
 * smoke runs, and single-process deployments — see the file header for the
 * (deferred) shared/bounded production path.
 */
export class InMemoryContactStore implements ContactStore {
  private readonly contacts = new Map<string, Contact>();

  get(channel: string, channelScopedUserId: string): Contact | undefined {
    const contact = this.contacts.get(contactKey(channel, channelScopedUserId));
    // Clone on read so the caller can mutate freely without touching the cache.
    return contact ? clone(contact) : undefined;
  }

  set(contact: Contact): void {
    // Clone on write so a later caller-side mutation of `contact` can't reach in.
    this.contacts.set(contactKey(contact.channel, contact.channelScopedUserId), clone(contact));
  }

  delete(channel: string, channelScopedUserId: string): void {
    this.contacts.delete(contactKey(channel, channelScopedUserId));
  }
}
