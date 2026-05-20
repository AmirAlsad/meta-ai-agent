/**
 * Optional identity resolution (Stage 6).
 *
 * An {@link IdentityResolver} enriches an inbound conversation with contact info
 * (name / email / tags / custom variables / a cross-channel unified id) pulled
 * from the developer-provided `USER_LOOKUP_URL`. It is layered IN FRONT of the
 * chat call so the resolved {@link Contact} can ride on the chat request.
 *
 * FAIL-OPEN is the load-bearing contract: enrichment is best-effort. A missing
 * `USER_LOOKUP_URL`, a non-2xx response, a network error, a timeout, or a
 * malformed body must NEVER throw and NEVER block message delivery — every
 * failure mode resolves to `undefined` ("no enrichment, proceed"). Unlike a
 * transport client that surfaces failures as exceptions for the agent to catch,
 * this resolver swallows them internally so a single misbehaving lookup endpoint
 * cannot stall the conversation pipeline. Callers therefore treat `undefined`
 * uniformly as "no contact available" regardless of WHY.
 *
 * PII-SAFE LOGGING is the second load-bearing rule: the lookup response can
 * carry names, emails, and phone-derived ids. This module logs only a boolean
 * `enriched` flag, the channel, and a REDACTED user-id hint (last 4 chars) — it
 * never logs the raw contact body, name, or email.
 */
import type pino from 'pino';
import type { Channel } from '../meta/types.js';
import type { Contact } from './types.js';
import type { ContactStore } from './contact-store.js';

export interface IdentityLookupRequest {
  channel: Channel;
  /** The OTHER party — `wa_id` / PSID / IGSID. */
  channelScopedUserId: string;
  /** Your side — `phone_number_id` / page id / ig user id. */
  channelScopedBusinessId: string;
}

export interface IdentityResolver {
  /** Resolve a contact for an inbound sender. Returns undefined when no enrichment is available. NEVER throws (fail-open). */
  resolve(req: IdentityLookupRequest): Promise<Contact | undefined>;
}

/**
 * No-op resolver used when `USER_LOOKUP_URL` is unset. Always returns
 * `undefined`, so the agent can hold a non-null resolver reference and call
 * `resolve` unconditionally without a `if (enabled)` branch at every call site.
 */
export class NoopIdentityResolver implements IdentityResolver {
  async resolve(_req: IdentityLookupRequest): Promise<Contact | undefined> {
    return undefined;
  }
}

export interface HttpIdentityResolverDeps {
  lookupUrl: string;
  timeoutMs: number;
  /** Injectable for tests; defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  logger?: Pick<pino.Logger, 'warn' | 'debug'>;
  /** Optional cache. When present, a hit short-circuits the HTTP call. */
  contactStore?: ContactStore;
}

/**
 * Redact a channel-scoped user id for logging — keep only the last 4 chars so a
 * log line is correlatable to a sender without exposing the full id (which for
 * WhatsApp is a phone number). Short ids collapse to `****` entirely.
 */
function redactUserId(id: string): string {
  return id.length <= 4 ? '****' : `****${id.slice(-4)}`;
}

/** A non-empty trimmed string, or undefined. Drops blanks/non-strings silently. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** A non-empty array of non-blank strings, or undefined. Filters junk entries. */
function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const filtered = value.filter(
    (entry): entry is string => typeof entry === 'string' && entry.trim() !== ''
  );
  return filtered.length > 0 ? filtered : undefined;
}

/** A string→string map dropping non-string values, or undefined when empty. */
function stringMap(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') out[key] = entry;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Normalize a JSON payload from `USER_LOOKUP_URL` into a {@link Contact}.
 *
 * `channel`/`channelScopedUserId` are stamped from the REQUEST (the identity of
 * who we looked up), not the body, so a resolver cannot accidentally re-key the
 * contact onto a different sender. Every enrichment field is optional and
 * leniently coerced — unknown/extra fields are ignored, wrong-typed fields are
 * dropped rather than throwing (fail-open posture extends to the body shape).
 *
 * Returns `undefined` when the body contributes NONE of the recognized
 * enrichment fields: a contact with only the echoed channel/user id carries no
 * information the agent didn't already have, so there is nothing to enrich.
 */
function shapeContact(req: IdentityLookupRequest, payload: unknown): Contact | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;

  const firstName = nonEmptyString(record.firstName);
  const lastName = nonEmptyString(record.lastName);
  const displayName = nonEmptyString(record.displayName);
  const email = nonEmptyString(record.email);
  const tags = stringArray(record.tags);
  const customVariables = stringMap(record.customVariables);
  const unifiedContactId = nonEmptyString(record.unifiedContactId);

  // Nothing recognized -> no enrichment. (The bare {channel, userId} adds nothing.)
  if (
    firstName === undefined &&
    lastName === undefined &&
    displayName === undefined &&
    email === undefined &&
    tags === undefined &&
    customVariables === undefined &&
    unifiedContactId === undefined
  ) {
    return undefined;
  }

  return {
    channel: req.channel,
    channelScopedUserId: req.channelScopedUserId,
    ...(firstName !== undefined ? { firstName } : {}),
    ...(lastName !== undefined ? { lastName } : {}),
    ...(displayName !== undefined ? { displayName } : {}),
    ...(email !== undefined ? { email } : {}),
    ...(tags !== undefined ? { tags } : {}),
    ...(customVariables !== undefined ? { customVariables } : {}),
    ...(unifiedContactId !== undefined ? { unifiedContactId } : {})
  };
}

/**
 * HTTP-based {@link IdentityResolver} over the developer's `USER_LOOKUP_URL`.
 *
 * Flow (cache-then-fetch):
 *  1. If a {@link ContactStore} is wired, check it first — a hit returns the
 *     cached contact WITHOUT any HTTP call (the caller/metrics treat this as
 *     `cached`).
 *  2. Otherwise POST `{ channel, channelScopedUserId, channelScopedBusinessId }`
 *     as JSON with an {@link AbortController} timeout.
 *  3. On 2xx, shape the body into a {@link Contact}; cache it on success.
 *  4. On ANY failure (non-2xx, network, timeout, JSON parse, unrecognized body)
 *     return `undefined` — never throw (FAIL-OPEN).
 */
export class HttpIdentityResolver implements IdentityResolver {
  private readonly lookupUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly logger?: Pick<pino.Logger, 'warn' | 'debug'>;
  private readonly contactStore?: ContactStore;

  constructor(deps: HttpIdentityResolverDeps) {
    this.lookupUrl = deps.lookupUrl;
    this.timeoutMs = deps.timeoutMs;
    // Bind to `globalThis` so the default `fetch` keeps its correct receiver.
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.logger = deps.logger;
    this.contactStore = deps.contactStore;
  }

  async resolve(req: IdentityLookupRequest): Promise<Contact | undefined> {
    // 1. Cache-then-fetch: a hit avoids re-burning the lookup endpoint on every
    //    inbound from the same sender. PII-safe debug line (no contact body).
    const cached = this.contactStore?.get(req.channel, req.channelScopedUserId);
    if (cached) {
      this.logger?.debug(
        { channel: req.channel, user: redactUserId(req.channelScopedUserId), enriched: true, cached: true },
        'identity lookup served from cache'
      );
      return cached;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(this.lookupUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel: req.channel,
          channelScopedUserId: req.channelScopedUserId,
          channelScopedBusinessId: req.channelScopedBusinessId
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        // Non-2xx is a definitive failure. FAIL-OPEN: log + return undefined, do
        // NOT throw — a flaky lookup endpoint must not block the conversation.
        this.logger?.warn(
          { channel: req.channel, user: redactUserId(req.channelScopedUserId), status: response.status },
          'identity lookup returned non-2xx; proceeding without enrichment'
        );
        return undefined;
      }

      // JSON parse is inside the try so a malformed body is caught by the
      // fail-open path below rather than rejecting `resolve`.
      const payload = await response.json();
      const contact = shapeContact(req, payload);

      // PII-SAFE: log only the boolean outcome + channel + redacted id hint.
      // NEVER log the raw body, name, or email.
      this.logger?.debug(
        {
          channel: req.channel,
          user: redactUserId(req.channelScopedUserId),
          enriched: contact !== undefined,
          cached: false
        },
        'identity lookup completed'
      );

      // Cache only a real enrichment. (A miss is not cached so a later-populated
      // upstream record can still be picked up on the next inbound.)
      if (contact && this.contactStore) {
        this.contactStore.set(contact);
      }

      return contact;
    } catch (error) {
      // Network failure, AbortError from the timeout, or a JSON parse error.
      // FAIL-OPEN: warn (no PII) and return undefined. Never rethrow.
      this.logger?.warn(
        {
          channel: req.channel,
          user: redactUserId(req.channelScopedUserId),
          err: (error as Error).name
        },
        'identity lookup failed; proceeding without enrichment'
      );
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  }
}
