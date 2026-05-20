/**
 * PII redaction for admin introspection responses.
 *
 * WHY admin endpoints redact by DEFAULT: a {@link ConversationRecord} is a
 * goldmine of personal data — the user's channel-scoped id (a `wa_id` is the
 * user's phone number; PSID/IGSID identify a real person), the resolved
 * {@link Contact} (name, email, phone-like fields), and the verbatim text of
 * every buffered inbound and queued outbound message. An operator hitting
 * `GET /admin/conversations/:key` to debug a stuck queue should NOT incidentally
 * dump message bodies and phone numbers into their terminal / logs. So the
 * default is masked; the route only sets `reveal: true` when the operator
 * explicitly asks for it AND is authenticated (`validateAdminToken`).
 *
 * WHY ALLOW-LIST (fail-closed): the inbound/outbound/record redactors do NOT
 * spread the source object and then mask a deny-list of known fields. That
 * approach fails OPEN — any field added to {@link IncomingMessage} /
 * {@link OutboundItem} / {@link ConversationRecord} later (a new PII-bearing
 * surface like `referral.ctwaClid` or `flowResponse.responseJson`) leaks
 * verbatim until someone remembers to add it to the deny-list. Instead each
 * redactor builds a NEW object copying ONLY explicitly allow-listed structural
 * (non-PII) fields, masks the known content fields, and drops everything else.
 * A future field is therefore OMITTED from the masked view unless someone
 * deliberately allow-lists it — new PII fails CLOSED. `reveal: true` is the
 * escape hatch that returns the source untouched for an authenticated operator.
 *
 * Adapted from the SendBlue repo's redaction module to Meta's identifiers
 * (`channelScopedUserId` instead of `phoneNumber`/`lineNumber`, the unified
 * {@link Contact} instead of SendBlue's `identity`, and `text` on
 * {@link IncomingMessage}/{@link OutboundItem} instead of `content`).
 *
 * Structural / non-PII fields (channel, state, timestamps, counts, OUR message
 * ids) are intentionally allow-listed so the masked view stays useful for
 * debugging delivery and state-machine issues.
 */

import type { ConversationRecord } from '../conversation/types.js';
import type { Contact } from '../identity/types.js';
import type { IncomingMessage } from '../meta/types.js';
import type { OutboundItem } from '../delivery/types.js';
import type { StatusRecord } from '../status/types.js';

export interface RedactionOptions {
  reveal?: boolean;
}

/** Sentinel substituted for dropped content/URL/raw fields in masked output. */
const REDACTED = '[redacted]';

/**
 * Mask an identifier, keeping a short trailing suffix so it stays
 * distinguishable in a debug view while the bulk is hidden. e.g.
 * `447700900123` -> `…0123`. Short values (<= suffix) collapse to `…` so we
 * never echo a whole short id. Undefined-safe; non-strings return `''`.
 */
export function maskId(value: string): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (trimmed === '') return '';
  const SUFFIX = 4;
  if (trimmed.length <= SUFFIX) return '…';
  return `…${trimmed.slice(-SUFFIX)}`;
}

/**
 * Mask free-form text (message bodies). By DEFAULT emits a length-only sentinel
 * `[redacted N chars]` and reveals NO content at all — even a short body must
 * not leak (a 5-char message → `[redacted 5 chars]`, not the body). An operator
 * can still correlate "the long one" / "the empty one" by length without ever
 * reading the text. The optional `prefix` length (default 0 = no prefix) opts
 * INTO leaking a short leading slice for callers that explicitly want it; it is
 * never used by the admin redactors. Undefined-safe; non-strings return `''`.
 */
export function maskText(value: string, prefix = 0): string {
  if (typeof value !== 'string') return '';
  if (value === '') return '[redacted 0 chars]';
  const len = value.length;
  const prefixLen = Math.max(0, prefix);
  // Default (prefix=0) and short strings leak nothing — length only.
  if (prefixLen === 0 || len <= prefixLen) return `[redacted ${len} chars]`;
  return `${value.slice(0, prefixLen)}… [redacted ${len} chars]`;
}

/**
 * Mask an email, preserving the first character of the local part and the full
 * domain so it stays recognizable (`alice@example.com` -> `a***@example.com`).
 * A malformed value with no `@` is treated as an opaque id via {@link maskId}.
 * Undefined-safe; non-strings return `''`.
 */
export function maskEmail(value: string): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (trimmed === '') return '';
  const at = trimmed.indexOf('@');
  if (at <= 0) {
    // No local part (or no `@` at all) — don't pretend it's an email.
    return maskId(trimmed);
  }
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  const first = local[0] ?? '';
  return `${first}***@${domain}`;
}

/** Mask a name-like field: keep the first character, hide the rest. */
function maskName(value: string): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (trimmed === '') return '';
  return `${trimmed[0]}***`;
}

/**
 * Mask the user segment of a conversation key. The key is
 * `{channel}:{business}:{user}` — the third segment is the user id (a `wa_id`
 * IS the user's phone number). We replace ONLY that segment with `maskId(...)`
 * so the key no longer leaks the raw user id while `channel:business` stays
 * intact for operability (looking up the record, grouping by business). Keys
 * with an unexpected shape (no `:` / extra segments) are left as-is rather than
 * mangled — better to keep a debuggable opaque key than to corrupt it. Used by
 * both the conversation and status admin routes so the masking is identical.
 */
export function maskConversationKey(key: string): string {
  if (typeof key !== 'string' || key === '') return key;
  const segments = key.split(':');
  // Only mask the canonical `channel:business:user` shape; the user is the LAST
  // segment. Anything else (fewer/more segments) is left untouched.
  if (segments.length < 3) return key;
  const last = segments.length - 1;
  segments[last] = maskId(segments[last] ?? '');
  return segments.join(':');
}

/**
 * Redact a {@link Contact} for admin output. Masks the channel-scoped user id,
 * name fields, and email; leaves structural fields (channel) and developer-
 * supplied opaque ids/labels intact. `reveal: true` returns the contact as-is.
 * Never throws on missing/oddly-typed fields.
 *
 * NOTE: this one intentionally spreads — `tags`/`customVariables`/
 * `unifiedContactId` are developer-supplied operational metadata (not Meta user
 * PII the way name/email/user-id are), so keeping unknown contact fields is the
 * desired behavior here.
 */
export function redactContact(contact: Contact, opts?: RedactionOptions): unknown {
  if (opts?.reveal) return contact;
  if (!contact || typeof contact !== 'object') return contact;

  const out: Record<string, unknown> = { ...contact };

  if (typeof contact.channelScopedUserId === 'string') {
    out.channelScopedUserId = maskId(contact.channelScopedUserId);
  }
  if (typeof contact.firstName === 'string') out.firstName = maskName(contact.firstName);
  if (typeof contact.lastName === 'string') out.lastName = maskName(contact.lastName);
  if (typeof contact.displayName === 'string') out.displayName = maskName(contact.displayName);
  if (typeof contact.email === 'string') out.email = maskEmail(contact.email);
  // channel, tags, customVariables, unifiedContactId are developer-defined and
  // not inherently PII the way name/email/user-id are — left intact so the
  // masked contact stays useful (e.g. `tier:gold`). `reveal` is the escape
  // hatch if an operator needs the raw record.

  return out;
}

/**
 * Copy a property from `src` onto `dst` under the same key ONLY when present.
 * Keeps the allow-list builders terse and undefined-safe (a field absent on the
 * source stays absent on the masked object, not `undefined`).
 */
function keep(dst: Record<string, unknown>, src: Record<string, unknown>, key: string): void {
  if (src[key] !== undefined) dst[key] = src[key];
}

/**
 * Redact a buffered inbound {@link IncomingMessage} via ALLOW-LIST. Builds a
 * fresh object copying only structural (non-PII) fields, masks the known
 * content fields, and drops the rest (so any future field fails CLOSED). See
 * the module docstring for the fail-closed rationale. `reveal: true` returns the
 * message untouched. Never throws on missing/oddly-typed fields.
 */
export function redactIncomingMessage(message: IncomingMessage, opts?: RedactionOptions): unknown {
  if (opts?.reveal) return message;
  if (!message || typeof message !== 'object') return message;
  const src = message as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  // ── Kept verbatim: structural / non-PII routing + delivery metadata. ──
  keep(out, src, 'channel');
  keep(out, src, 'type');
  keep(out, src, 'timestamp');
  keep(out, src, 'channelMessageId');
  // OUR business-side id (phone_number_id / page id / ig user id) — not user PII.
  keep(out, src, 'channelScopedBusinessId');
  keep(out, src, 'isEcho');
  // `replyTo` is a referenced MESSAGE id, not user content.
  keep(out, src, 'replyTo');
  keep(out, src, 'forwarded');

  // ── Masked: the user-side id and any user-authored free text. ──
  if (typeof message.channelScopedUserId === 'string') {
    out.channelScopedUserId = maskId(message.channelScopedUserId);
  }
  if (typeof message.text === 'string') out.text = maskText(message.text);

  // ── Sub-objects: rebuilt field-by-field, only when present on the source. ──
  if (message.media && typeof message.media === 'object') {
    const m = message.media as unknown as Record<string, unknown>;
    const media: Record<string, unknown> = {};
    // Kept: non-PII media metadata (mime/id/hash/flags).
    keep(media, m, 'mimeType');
    keep(media, m, 'id');
    keep(media, m, 'sha256');
    keep(media, m, 'voice');
    keep(media, m, 'animated');
    // Masked: caption can carry arbitrary user text.
    if (typeof m.caption === 'string') media.caption = maskText(m.caption);
    // Dropped: a direct media URL and the user-facing filename are PII-adjacent
    // (the URL is a downloadable artifact; the filename is user-chosen).
    if (m.url !== undefined) media.url = REDACTED;
    if (m.filename !== undefined) media.filename = REDACTED;
    out.media = media;
  }

  if (message.reaction && typeof message.reaction === 'object') {
    const r = message.reaction as unknown as Record<string, unknown>;
    const reaction: Record<string, unknown> = {};
    // Both are non-PII: a target message id and an emoji codepoint.
    keep(reaction, r, 'targetMessageId');
    keep(reaction, r, 'emoji');
    keep(reaction, r, 'action');
    out.reaction = reaction;
  }

  if (message.storyReply && typeof message.storyReply === 'object') {
    const s = message.storyReply as unknown as Record<string, unknown>;
    const storyReply: Record<string, unknown> = {};
    keep(storyReply, s, 'id');
    // The story URL points at the user's story media — drop it.
    if (s.url !== undefined) storyReply.url = REDACTED;
    out.storyReply = storyReply;
  }

  if (message.storyMention && typeof message.storyMention === 'object') {
    const s = message.storyMention as unknown as Record<string, unknown>;
    const storyMention: Record<string, unknown> = {};
    keep(storyMention, s, 'id');
    if (s.url !== undefined) storyMention.url = REDACTED;
    out.storyMention = storyMention;
  }

  if (message.postback && typeof message.postback === 'object') {
    const p = message.postback as unknown as Record<string, unknown>;
    const postback: Record<string, unknown> = {};
    // `title` is the button's UI label (developer-defined), not user PII — keep.
    keep(postback, p, 'title');
    // `payload` can carry arbitrary developer-encoded data — mask it.
    if (typeof p.payload === 'string') postback.payload = maskText(p.payload);
    out.postback = postback;
  }

  if (message.referral && typeof message.referral === 'object') {
    const r = message.referral as unknown as Record<string, unknown>;
    const referral: Record<string, unknown> = {};
    // Kept: ad routing tokens (not user PII).
    keep(referral, r, 'source');
    keep(referral, r, 'type');
    keep(referral, r, 'ref');
    keep(referral, r, 'sourceId');
    // Dropped: CTWA click id ties back to the user's ad attribution; the source
    // URL / headline / body are ad-creative content captured against the user's
    // click — drop them from the masked view.
    if (r.ctwaClid !== undefined) referral.ctwaClid = REDACTED;
    if (r.sourceUrl !== undefined) referral.sourceUrl = REDACTED;
    if (r.headline !== undefined) referral.headline = REDACTED;
    if (r.body !== undefined) referral.body = REDACTED;
    out.referral = referral;
  }

  if (message.flowResponse && typeof message.flowResponse === 'object') {
    const f = message.flowResponse as unknown as Record<string, unknown>;
    const flowResponse: Record<string, unknown> = {};
    // `name` is the flow's name (developer-defined), not user PII — keep.
    keep(flowResponse, f, 'name');
    // `bodyText` is a convenience label that can echo user input — mask it.
    if (typeof f.bodyText === 'string') flowResponse.bodyText = maskText(f.bodyText);
    // `responseJson` is the user's serialized FORM SUBMISSION — the single
    // highest-PII field on the message. Always drop it.
    if (f.responseJson !== undefined) flowResponse.responseJson = REDACTED;
    out.flowResponse = flowResponse;
  }

  // `raw` is the verbatim per-message webhook payload (names, bodies, the user's
  // number) — never surface it, even masked.
  if ('raw' in src) out.raw = REDACTED;

  return out;
}

/**
 * Redact a queued outbound {@link OutboundItem} via ALLOW-LIST. Keeps the LOCAL
 * id, kind, OUR send id, timestamps, and skip/template bookkeeping; masks the
 * agent-authored body + media caption; drops the media URL and template
 * components (which may carry user-specific params). Any future field fails
 * CLOSED. `reveal: true` returns the item untouched.
 */
export function redactOutboundItem(item: OutboundItem, opts?: RedactionOptions): unknown {
  if (opts?.reveal) return item;
  if (!item || typeof item !== 'object') return item;
  const src = item as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  // ── Kept verbatim: ids, kind, delivery + template bookkeeping (non-PII). ──
  keep(out, src, 'id');
  keep(out, src, 'kind');
  keep(out, src, 'channelMessageId');
  keep(out, src, 'sentAt');
  keep(out, src, 'targetMessageId');
  keep(out, src, 'emoji');
  keep(out, src, 'durationMs');
  keep(out, src, 'templateName');
  keep(out, src, 'templateLanguage');
  keep(out, src, 'skipReason');
  keep(out, src, 'skippedAt');

  // ── Masked: agent-authored free text. ──
  if (typeof item.text === 'string') out.text = maskText(item.text);
  if (typeof item.mediaCaption === 'string') out.mediaCaption = maskText(item.mediaCaption);

  // ── Dropped: a media URL is a downloadable artifact; template components can
  // embed user-specific parameter values. ──
  if (src.mediaUrl !== undefined) out.mediaUrl = REDACTED;
  if (src.templateComponents !== undefined) out.templateComponents = REDACTED;

  return out;
}

/**
 * Redact a {@link ConversationRecord} for admin output via ALLOW-LIST. Keeps the
 * structural fields (channel, state, OUR business id, indices, OUR message ids,
 * timestamps, counts, traceId), masks `channelScopedUserId`, masks the USER
 * segment of `key` (so the key doesn't leak the raw user id while
 * `channel:business` stays usable), redacts the embedded {@link Contact}, and
 * maps the inbound/outbound buffers through their per-item redactors. Any future
 * top-level field fails CLOSED. `reveal: true` returns the record untouched.
 * Never throws on missing/oddly-typed fields.
 */
export function redactConversationRecord(
  record: ConversationRecord,
  opts?: RedactionOptions
): unknown {
  if (opts?.reveal) return record;
  if (!record || typeof record !== 'object') return record;
  const src = record as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  // ── Kept verbatim: structural / non-PII state-machine + delivery fields. ──
  keep(out, src, 'channel');
  keep(out, src, 'state');
  // OUR business-side id — not user PII.
  keep(out, src, 'channelScopedBusinessId');
  keep(out, src, 'currentOutboundIndex');
  // OUR send ids (in-flight + delivered) — non-PII.
  keep(out, src, 'currentOutboundMessageId');
  keep(out, src, 'deliveredMessageIds');
  keep(out, src, 'lastInboundMessageId');
  // Timestamps + window + activity + trace — all structural.
  keep(out, src, 'lastInboundAt');
  keep(out, src, 'lastOutboundAt');
  keep(out, src, 'windowExpiresAt');
  keep(out, src, 'lastActivity');
  keep(out, src, 'traceId');

  // ── Masked PII: the user-side id and the user segment of the key. ──
  if (typeof record.channelScopedUserId === 'string') {
    out.channelScopedUserId = maskId(record.channelScopedUserId);
  }
  // The key embeds the raw user id as its third segment — mask just that part.
  if (typeof record.key === 'string') out.key = maskConversationKey(record.key);

  // Resolved contact — names / email / user-id.
  if (record.contact !== undefined) {
    out.contact = redactContact(record.contact, opts);
  }

  // Both buffers carry user/agent content — route every item through its
  // per-item allow-list redactor.
  if (Array.isArray(record.inboundBuffer)) {
    out.inboundBuffer = record.inboundBuffer.map(m => redactIncomingMessage(m, opts));
  }
  if (Array.isArray(record.outboundQueue)) {
    out.outboundQueue = record.outboundQueue.map(i => redactOutboundItem(i, opts));
  }

  return out;
}

/**
 * Redact a {@link StatusRecord} for the `GET /admin/status/:messageId` route via
 * ALLOW-LIST. Keeps the OUR-side ids, channel, the status enum + history (status
 * values, timestamps, error codes — no PII), and the first/last-seen
 * timestamps; masks the `recipientId` (the user side) and the user segment of
 * `conversationKey` (same helper as the conversation route). `reveal: true`
 * returns the record untouched. Never throws on missing/oddly-typed fields.
 */
export function redactStatusRecord(record: StatusRecord, opts?: RedactionOptions): unknown {
  if (opts?.reveal) return record;
  if (!record || typeof record !== 'object') return record;
  const src = record as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  // ── Kept verbatim: OUR send id, channel, the status timeline (no PII). ──
  keep(out, src, 'channelMessageId');
  keep(out, src, 'channel');
  keep(out, src, 'current');
  // `history` is status enums + timestamps + WhatsApp error codes/titles — no
  // PII — so it's allow-listed verbatim.
  keep(out, src, 'history');
  keep(out, src, 'firstSeenAt');
  keep(out, src, 'lastUpdatedAt');

  // ── Masked PII: the recipient (user) id and the key's user segment. ──
  if (typeof record.recipientId === 'string') out.recipientId = maskId(record.recipientId);
  if (typeof record.conversationKey === 'string') {
    out.conversationKey = maskConversationKey(record.conversationKey);
  }

  return out;
}
