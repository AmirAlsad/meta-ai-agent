import type {
  Channel,
  FlowResponseInfo,
  ForwardedInfo,
  IncomingMessage,
  MediaInfo,
  MessageType,
  ParseResult,
  PostbackInfo,
  ReactionInfo,
  ReferralInfo,
  StatusUpdate,
  StoryReplyInfo
} from './types.js';

/**
 * Per-channel parsers for Meta webhook payloads.
 *
 * Discipline:
 *  - Input is always `unknown`. Defensively narrow at each layer.
 *  - Malformed payloads never throw — return whatever parsed cleanly and drop
 *    the rest. Meta retries non-2xx deliveries for 7 days then permanently
 *    drops them (no replay API), so the handler is the dead-letter queue.
 *    Throwing here would corrupt that contract.
 *  - Per-payload dedupe on `channelMessageId` because Meta has been observed
 *    to batch identical message blocks across `entry[]` items. Global dedupe
 *    is the conversation agent's job (Stage 5).
 *  - Timestamps are NORMALIZED to milliseconds at this boundary. WhatsApp
 *    sends Unix seconds as a string; Messenger / Instagram send milliseconds
 *    as a number. See plan lines 31-35.
 */

/* ────────────────────────────────────────────────────────────────────────── */
/* Narrowing helpers                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function readString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === 'string' ? value : undefined;
}

function readNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const value = obj[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readBoolean(obj: Record<string, unknown>, key: string): boolean | undefined {
  const value = obj[key];
  return typeof value === 'boolean' ? value : undefined;
}

function readObject(
  obj: Record<string, unknown>,
  key: string
): Record<string, unknown> | undefined {
  const value = obj[key];
  return isObject(value) ? value : undefined;
}

function readArray(obj: Record<string, unknown>, key: string): unknown[] | undefined {
  const value = obj[key];
  return isArray(value) ? value : undefined;
}

/**
 * Normalize a Meta timestamp to milliseconds.
 *
 * WhatsApp ships Unix seconds as a string; Messenger / Instagram ship
 * milliseconds as a number. We accept both forms on both channels in case
 * Meta ever changes one of them. If neither form is parseable we fall back
 * to `Date.now()` — losing a parseable message because of a malformed
 * timestamp is worse than logging the moment we received it.
 */
function normalizeTimestamp(value: unknown, channel: Channel): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // WhatsApp tolerance: if we somehow receive seconds-as-a-number, upscale.
    if (channel === 'whatsapp' && value < 1e12) return value * 1000;
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      // WhatsApp documents seconds-as-string. Messenger/IG don't, but if we
      // ever see a string, treat values <1e12 as seconds and upscale.
      if (parsed < 1e12) return parsed * 1000;
      return parsed;
    }
  }
  // timestamp-fallback: prefer surfacing a parseable message with a
  // best-effort timestamp over dropping it entirely (Meta retries failed
  // deliveries; silently losing a valid message is permanent).
  return Date.now();
}

/**
 * In-place dedupe by `channelMessageId`, preserving first occurrence.
 *
 * Meta has been observed to batch identical message blocks across `entry[]`
 * items inside a single webhook delivery. Per-payload dedupe is cheap and
 * idempotent; global dedupe (across redelivery) lives in the conversation
 * agent (Stage 5).
 */
function dedupeById<T extends { channelMessageId: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item.channelMessageId)) continue;
    seen.add(item.channelMessageId);
    out.push(item);
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* WhatsApp                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Parse a WhatsApp Cloud API webhook payload into a normalized
 * {@link ParseResult}. Tolerant: never throws on malformed input.
 */
export function parseWhatsAppWebhook(payload: unknown): ParseResult {
  const messages: IncomingMessage[] = [];
  const statuses: StatusUpdate[] = [];
  if (!isObject(payload)) return { messages, statuses };

  const entries = readArray(payload, 'entry') ?? [];
  for (const entry of entries) {
    if (!isObject(entry)) continue;
    const changes = readArray(entry, 'changes') ?? [];
    for (const change of changes) {
      if (!isObject(change)) continue;
      const value = readObject(change, 'value');
      if (!value) continue;

      const metadata = readObject(value, 'metadata');
      const businessId = metadata ? readString(metadata, 'phone_number_id') : undefined;
      if (!businessId) continue;

      const msgList = readArray(value, 'messages') ?? [];
      for (const raw of msgList) {
        const parsed = parseWhatsAppMessage(raw, businessId);
        if (parsed) messages.push(parsed);
      }

      const statusList = readArray(value, 'statuses') ?? [];
      for (const raw of statusList) {
        const parsed = parseWhatsAppStatus(raw, businessId);
        if (parsed) statuses.push(parsed);
      }
    }
  }

  return { messages: dedupeById(messages), statuses: dedupeById(statuses) };
}

function parseWhatsAppMessage(
  raw: unknown,
  businessId: string
): IncomingMessage | undefined {
  if (!isObject(raw)) return undefined;
  const id = readString(raw, 'id');
  const from = readString(raw, 'from');
  if (!id || !from) return undefined;

  const type = readString(raw, 'type') ?? 'unknown';
  const context = readObject(raw, 'context');

  const message: IncomingMessage = {
    channel: 'whatsapp',
    channelMessageId: id,
    channelScopedUserId: from,
    channelScopedBusinessId: businessId,
    timestamp: normalizeTimestamp(raw['timestamp'], 'whatsapp'),
    type: 'unknown',
    raw
  };

  // Reply context: WhatsApp uses `context.message_id` for quoted replies and
  // `context.forwarded` / `context.frequently_forwarded` to flag forwarded
  // chains. Other `context.*` fields (`referred_product`, etc.) are
  // unrelated to either and remain reachable via `raw`.
  if (context) {
    const replyTo = readString(context, 'message_id');
    if (replyTo) message.replyTo = replyTo;
    const forwarded = readBoolean(context, 'forwarded');
    const frequentlyForwarded = readBoolean(context, 'frequently_forwarded');
    // Forwarded flags are a spam / misinformation signal worth surfacing
    // to the conversation agent even when no other context fields are set.
    if (forwarded !== undefined || frequentlyForwarded !== undefined) {
      const info: ForwardedInfo = { forwarded: forwarded ?? false };
      if (frequentlyForwarded !== undefined) info.frequentlyForwarded = frequentlyForwarded;
      message.forwarded = info;
    }
  }

  // Click-to-WhatsApp ad attribution: when a user taps a WA ad on FB/IG,
  // Meta attaches `referral` as a sibling of `messages[i]` (not under
  // `context`). Without this branch every CTWA ad → conversation link is
  // permanently lost.
  const referral = readObject(raw, 'referral');
  if (referral) {
    const referralInfo = buildWhatsAppReferralInfo(referral);
    if (referralInfo) message.referral = referralInfo;
  }

  switch (type) {
    case 'text': {
      const text = readObject(raw, 'text');
      message.type = 'text';
      if (text) {
        const body = readString(text, 'body');
        if (body !== undefined) message.text = body;
      }
      break;
    }
    case 'image':
    case 'audio':
    case 'video':
    case 'document':
    case 'sticker': {
      message.type = type;
      const block = readObject(raw, type);
      if (block) message.media = buildWhatsAppMedia(type, block);
      break;
    }
    case 'location': {
      message.type = 'location';
      const loc = readObject(raw, 'location');
      // Location has no media block, but a friendly `name` makes a useful
      // top-level `text` for downstream display / chat-endpoint consumers.
      if (loc) {
        const name = readString(loc, 'name');
        if (name) message.text = name;
      }
      break;
    }
    case 'reaction': {
      message.type = 'reaction';
      const reaction = readObject(raw, 'reaction');
      if (reaction) {
        const targetMessageId = readString(reaction, 'message_id');
        // WhatsApp encodes an unreact as `emoji: ''` (not omitted) — preserve
        // the empty string exactly so downstream can distinguish.
        const emoji = readString(reaction, 'emoji') ?? '';
        if (targetMessageId) {
          message.reaction = { emoji, targetMessageId };
        }
      }
      break;
    }
    case 'interactive': {
      message.type = 'interactive';
      const interactive = readObject(raw, 'interactive');
      if (interactive) {
        const interactiveType = readString(interactive, 'type');
        if (interactiveType === 'nfm_reply') {
          // WhatsApp Flows submission. Meta does NOT pre-parse `response_json`
          // — keep it verbatim so downstream can lazily JSON.parse against
          // its own flow schema. Dropping `response_json` would lose every
          // form submission the user makes via the Flow.
          const nfm = readObject(interactive, 'nfm_reply');
          if (nfm) {
            const body = readString(nfm, 'body');
            const name = readString(nfm, 'name');
            const responseJson = readString(nfm, 'response_json');
            if (body !== undefined) message.text = body;
            else if (name !== undefined) message.text = name;
            if (responseJson !== undefined) {
              const flow: FlowResponseInfo = { responseJson };
              if (name !== undefined) flow.name = name;
              if (body !== undefined) flow.bodyText = body;
              message.flowResponse = flow;
            }
          }
        } else {
          const buttonReply = readObject(interactive, 'button_reply');
          const listReply = readObject(interactive, 'list_reply');
          const reply = buttonReply ?? listReply;
          if (reply) {
            const title = readString(reply, 'title');
            if (title) message.text = title;
          }
        }
      }
      break;
    }
    case 'button': {
      // WhatsApp template button reply. The button-template flow keys on
      // `payload` for routing — putting it on the cross-channel `postback`
      // surface preserves that field; overwriting it with `text` would lose
      // the routing signal entirely.
      message.type = 'postback';
      const button = readObject(raw, 'button');
      if (button) {
        const text = readString(button, 'text');
        const payload = readString(button, 'payload');
        if (payload !== undefined) {
          const info: PostbackInfo = { payload };
          if (text !== undefined) info.title = text;
          message.postback = info;
        }
      }
      break;
    }
    case 'system': {
      // WhatsApp system messages: user changed number, group naming events,
      // etc. The body text lives under `messages[i].system.body`.
      message.type = 'system';
      const system = readObject(raw, 'system');
      if (system) {
        const body = readString(system, 'body');
        if (body !== undefined) message.text = body;
      }
      break;
    }
    default: {
      // Contacts / future types. Surface with the original id + sender +
      // timestamp so observability sees them; downstream can ignore. Never
      // drop silently — Meta retries non-2xx for 7 days.
      message.type = 'unknown';
      break;
    }
  }

  return message;
}

function buildWhatsAppMedia(
  type: string,
  block: Record<string, unknown>
): MediaInfo {
  const media: MediaInfo = {};
  const id = readString(block, 'id');
  const mimeType = readString(block, 'mime_type');
  const sha256 = readString(block, 'sha256');
  const caption = readString(block, 'caption');
  if (id) media.id = id;
  if (mimeType) media.mimeType = mimeType;
  if (sha256) media.sha256 = sha256;
  if (caption) media.caption = caption;
  if (type === 'audio') {
    const voice = readBoolean(block, 'voice');
    if (voice !== undefined) media.voice = voice;
  }
  if (type === 'document') {
    const filename = readString(block, 'filename');
    if (filename) media.filename = filename;
  }
  if (type === 'sticker') {
    const animated = readBoolean(block, 'animated');
    if (animated !== undefined) media.animated = animated;
  }
  return media;
}

function parseWhatsAppStatus(
  raw: unknown,
  businessId: string
): StatusUpdate | undefined {
  if (!isObject(raw)) return undefined;
  const id = readString(raw, 'id');
  const statusValue = readString(raw, 'status');
  if (!id || !statusValue) return undefined;

  const allowed: readonly string[] = ['sent', 'delivered', 'read', 'failed'];
  if (!allowed.includes(statusValue)) return undefined;

  const update: StatusUpdate = {
    channel: 'whatsapp',
    channelMessageId: id,
    channelScopedBusinessId: businessId,
    status: statusValue as StatusUpdate['status'],
    timestamp: normalizeTimestamp(raw['timestamp'], 'whatsapp'),
    raw
  };
  const recipientId = readString(raw, 'recipient_id');
  if (recipientId) update.channelScopedUserId = recipientId;

  const errors = readArray(raw, 'errors');
  if (errors && errors.length > 0 && isObject(errors[0])) {
    const first = errors[0];
    const code = readNumber(first, 'code');
    const title = readString(first, 'title');
    if (code !== undefined) update.errorCode = code;
    if (title) update.errorTitle = title;
  }
  return update;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Messenger / Instagram (shared structural parser, channel-tagged)           */
/* ────────────────────────────────────────────────────────────────────────── */

/** Parse a Messenger Platform webhook payload (`object: 'page'`). */
export function parseMessengerWebhook(payload: unknown): ParseResult {
  return parseFbStylePayload(payload, 'messenger');
}

/** Parse an Instagram messaging webhook payload (`object: 'instagram'`). */
export function parseInstagramWebhook(payload: unknown): ParseResult {
  return parseFbStylePayload(payload, 'instagram');
}

function parseFbStylePayload(payload: unknown, channel: Channel): ParseResult {
  const messages: IncomingMessage[] = [];
  const statuses: StatusUpdate[] = [];
  if (!isObject(payload)) return { messages, statuses };

  // Per-payload counter for synthesized ids on unknown messaging events. Two
  // opt-in / handover events landing at the same ms used to collapse to one
  // via the dedupe pass; a monotonic counter scoped to this call keeps them
  // distinct while still being stable within a single Meta delivery.
  const unknownEventState = { counter: 0 };

  const entries = readArray(payload, 'entry') ?? [];
  for (const entry of entries) {
    if (!isObject(entry)) continue;
    const entryId = readString(entry, 'id');
    const events = readArray(entry, 'messaging') ?? [];
    for (const event of events) {
      const result = parseFbStyleEvent(event, channel, entryId, unknownEventState);
      if (!result) continue;
      if (result.message) messages.push(result.message);
      for (const status of result.statuses) statuses.push(status);
    }
    // `entry[].changes` exists for non-messaging feed events on Messenger
    // (post comments, etc.). Stage 2 scope is messaging only — drop them.
  }

  return { messages: dedupeById(messages), statuses: dedupeById(statuses) };
}

interface FbEventResult {
  message?: IncomingMessage;
  statuses: StatusUpdate[];
}

interface UnknownEventState {
  counter: number;
}

function parseFbStyleEvent(
  raw: unknown,
  channel: Channel,
  entryId: string | undefined,
  unknownEventState: UnknownEventState
): FbEventResult | undefined {
  if (!isObject(raw)) return undefined;
  const sender = readObject(raw, 'sender');
  const recipient = readObject(raw, 'recipient');
  const senderId = sender ? readString(sender, 'id') : undefined;
  const recipientId = recipient ? readString(recipient, 'id') : undefined;
  const eventTimestamp = normalizeTimestamp(raw['timestamp'], channel);

  // Message events (text / attachments / echo / reply / quick reply).
  const message = readObject(raw, 'message');
  if (message) {
    const parsed = parseFbStyleMessage(
      raw,
      message,
      channel,
      senderId,
      recipientId,
      entryId,
      eventTimestamp
    );
    if (!parsed) return { statuses: [] };
    return { message: parsed, statuses: [] };
  }

  // Postback events.
  const postback = readObject(raw, 'postback');
  if (postback) {
    const parsed = parseFbStylePostback(
      raw,
      postback,
      channel,
      senderId,
      recipientId,
      eventTimestamp
    );
    return parsed ? { message: parsed, statuses: [] } : { statuses: [] };
  }

  // Referral events (m.me / ig.me).
  const referral = readObject(raw, 'referral');
  if (referral) {
    const parsed = parseFbStyleReferral(
      raw,
      referral,
      channel,
      senderId,
      recipientId,
      eventTimestamp
    );
    return parsed ? { message: parsed, statuses: [] } : { statuses: [] };
  }

  // Reaction events.
  const reaction = readObject(raw, 'reaction');
  if (reaction) {
    const parsed = parseFbStyleReaction(
      raw,
      reaction,
      channel,
      senderId,
      recipientId,
      eventTimestamp
    );
    return parsed ? { message: parsed, statuses: [] } : { statuses: [] };
  }

  // Read events. Messenger sends `read.watermark` (a timestamp — downstream
  // sweeps all outbound with timestamps <= watermark and marks `read`).
  // Instagram sends `read.mid` (the specific message id that was seen) on
  // its `messaging_seen` events. We surface either form: watermark stringified
  // when only that's available, otherwise the explicit mid.
  const read = readObject(raw, 'read');
  if (read) {
    const explicitMid = readString(read, 'mid');
    const watermark = readNumber(read, 'watermark');
    // No actionable status to record without either a mid or a watermark —
    // logging `channelMessageId: 'undefined'` would poison downstream status
    // sweeps. Drop the event entirely; Meta retries on non-2xx anyway and
    // there's nothing for the tracker to advance on.
    if (explicitMid === undefined && watermark === undefined) return { statuses: [] };
    if (recipientId === undefined && entryId === undefined) return { statuses: [] };
    // For read events, `sender.id` is the user who did the reading;
    // `recipient.id` is the business. Echo direction-flip does NOT apply to
    // read events — these are user→business signals by definition.
    const status: StatusUpdate = {
      channel,
      channelMessageId: explicitMid ?? String(watermark),
      channelScopedBusinessId: recipientId ?? entryId ?? '',
      status: 'read',
      timestamp: eventTimestamp,
      raw
    };
    if (senderId) status.channelScopedUserId = senderId;
    return { statuses: [status] };
  }

  // Delivery events (Messenger only — Instagram doesn't emit these in the
  // same shape). `delivery.mids[]` is an array; emit ONE StatusUpdate per
  // mid so the downstream tracker can advance each outbound independently.
  const delivery = readObject(raw, 'delivery');
  if (delivery) {
    const mids = readArray(delivery, 'mids') ?? [];
    const watermark = readNumber(delivery, 'watermark');
    const out: StatusUpdate[] = [];
    for (const mid of mids) {
      if (typeof mid !== 'string') continue;
      const status: StatusUpdate = {
        channel,
        channelMessageId: mid,
        channelScopedBusinessId: recipientId ?? entryId ?? '',
        status: 'delivered',
        timestamp: watermark ?? eventTimestamp,
        raw
      };
      if (senderId) status.channelScopedUserId = senderId;
      out.push(status);
    }
    return { statuses: out };
  }

  // Anything else (opt-in, account_linking, future events). Surface as
  // unknown so observability sees it; the conversation agent can ignore.
  // We need both ids to keep the record meaningful — drop if missing.
  if (!senderId || !recipientId) return { statuses: [] };
  // A bursty payload of N opt-in / handover events arriving at the same ms
  // used to collapse to a single record once the per-payload dedupe pass
  // ran. A monotonic counter scoped to this delivery keeps each event
  // distinct; cross-payload dedupe is the conversation agent's concern
  // (Stage 5+). Postback / referral synthetic ids deliberately stay
  // timestamp-only — those events have meaningful single-payload uniqueness
  // already and rewriting their id shape would churn fixtures unnecessarily.
  unknownEventState.counter += 1;
  const unknown: IncomingMessage = {
    channel,
    channelMessageId: `${entryId ?? recipientId}-${eventTimestamp}-unknown-${unknownEventState.counter}`,
    channelScopedUserId: senderId,
    channelScopedBusinessId: recipientId,
    timestamp: eventTimestamp,
    type: 'unknown',
    raw
  };
  return { message: unknown, statuses: [] };
}

function parseFbStyleMessage(
  rawEvent: unknown,
  message: Record<string, unknown>,
  channel: Channel,
  senderId: string | undefined,
  recipientId: string | undefined,
  entryId: string | undefined,
  timestamp: number
): IncomingMessage | undefined {
  const mid = readString(message, 'mid');
  if (!mid) return undefined;

  // Echo direction-flip: for `is_echo: true` events, `sender.id` is the
  // BUSINESS and `recipient.id` is the USER (Meta inverts the directions
  // because the business sent the message). Downstream code keys on
  // `channelScopedUserId` for the user side — we must always store the
  // USER id there regardless of which raw field carried it. This is
  // load-bearing across the conversation agent and identity resolver.
  const isEcho = readBoolean(message, 'is_echo') === true;
  const userId = isEcho ? recipientId : senderId;
  const businessId = isEcho ? senderId : recipientId;
  if (!userId || !businessId) return undefined;

  const attachments = readArray(message, 'attachments') ?? [];
  const text = readString(message, 'text');
  const replyTo = readObject(message, 'reply_to');

  const incoming: IncomingMessage = {
    channel,
    channelMessageId: mid,
    channelScopedUserId: userId,
    channelScopedBusinessId: businessId,
    timestamp,
    type: 'text',
    raw: rawEvent
  };

  if (isEcho) {
    incoming.isEcho = true;
    incoming.type = 'echo';
  }

  if (replyTo) {
    const replyMid = readString(replyTo, 'mid');
    if (replyMid) incoming.replyTo = replyMid;
    // Instagram-only: reply to a story you posted.
    const story = readObject(replyTo, 'story');
    if (story) {
      const id = readString(story, 'id');
      const url = readString(story, 'url');
      if (id) {
        const info: StoryReplyInfo = { id };
        if (url) info.url = url;
        incoming.storyReply = info;
      }
    }
  }

  if (text !== undefined) incoming.text = text;

  if (attachments.length > 0) {
    // Use the first attachment as the message type discriminator. Multi-
    // attachment messages are rare and downstream consumers see the full
    // attachments[] via `raw`. Echo type wins over media type — echo is
    // a direction flag, not a content type — keep `type: 'echo'`.
    const first = attachments[0];
    if (isObject(first)) {
      const attachmentType = readString(first, 'type');
      const payload = readObject(first, 'payload');
      const url = payload ? readString(payload, 'url') : undefined;
      const mappedType = mapFbAttachmentType(attachmentType);

      if (!isEcho && mappedType) incoming.type = mappedType;
      if (mappedType && mappedType !== 'echo' && mappedType !== 'text') {
        const media: MediaInfo = {};
        if (url) media.url = url;
        // Only attach a media block for genuine media types — story_mention
        // is structurally an attachment but lives on `storyMention`.
        if (
          mappedType === 'image' ||
          mappedType === 'audio' ||
          mappedType === 'video' ||
          mappedType === 'document' ||
          mappedType === 'sticker' ||
          mappedType === 'location'
        ) {
          if (url || Object.keys(media).length > 0) incoming.media = media;
        }
      }
      if (attachmentType === 'story_mention') {
        // Instagram-only. Distinct from `storyReply`: a mention is the user
        // tagging the business in their story; a reply is a DM responding
        // to a story the business posted.
        const info: StoryReplyInfo = { id: mid };
        if (url) info.url = url;
        incoming.storyMention = info;
        if (!isEcho) incoming.type = 'unknown';
        // We intentionally don't have a `story_mention` MessageType variant
        // — surface as 'unknown' so the conversation agent treats it as a
        // structured side-channel event via `storyMention`, not a normal
        // inbound text. Reconsider if/when we add a dedicated variant.
      } else if (!isEcho && !mappedType && text === undefined) {
        // Attachment type doesn't map to a known MessageType AND there's no
        // text to fall back on — without this branch `type` would leak as
        // the initialized `'text'` even though `text` is undefined. Future
        // Meta attachment types (and unmodeled ones like 'reel') land here.
        incoming.type = 'unknown';
      }
    }
  } else if (text === undefined && !isEcho) {
    // No text and no attachments — fall through as 'unknown' rather than
    // misrepresent as text.
    incoming.type = 'unknown';
  }

  // Quick replies arrive alongside `text` — preserve the payload on raw
  // (which we already keep). No dedicated field on IncomingMessage today.

  // Entry id sanity: if we somehow lost the business id but the entry
  // carries it, use the entry id as a last resort.
  if (!incoming.channelScopedBusinessId && entryId) {
    incoming.channelScopedBusinessId = entryId;
  }

  return incoming;
}

/**
 * Map raw Messenger/Instagram attachment `type` to the normalized
 * {@link MessageType}. Returns `undefined` for unknown types — caller falls
 * back to `'unknown'`.
 */
function mapFbAttachmentType(type: string | undefined): MessageType | undefined {
  switch (type) {
    case 'image':
      return 'image';
    case 'audio':
      return 'audio';
    case 'video':
      return 'video';
    case 'file':
      return 'document';
    case 'location':
      return 'location';
    case 'fallback':
    case 'template':
      // Fallback attachments are URL previews; templates are structured cards.
      // Neither maps cleanly to a media type — let caller fall back to text.
      return undefined;
    case 'story_mention':
      // Caller handles separately via `storyMention`.
      return undefined;
    default:
      return undefined;
  }
}

function parseFbStylePostback(
  rawEvent: unknown,
  postback: Record<string, unknown>,
  channel: Channel,
  senderId: string | undefined,
  recipientId: string | undefined,
  timestamp: number
): IncomingMessage | undefined {
  if (!senderId || !recipientId) return undefined;
  const payload = readString(postback, 'payload');
  if (!payload) return undefined;
  const mid = readString(postback, 'mid');

  const info: PostbackInfo = { payload };
  const title = readString(postback, 'title');
  if (title) info.title = title;

  const message: IncomingMessage = {
    channel,
    channelMessageId: mid ?? `${recipientId}-${timestamp}-postback`,
    channelScopedUserId: senderId,
    channelScopedBusinessId: recipientId,
    timestamp,
    type: 'postback',
    postback: info,
    raw: rawEvent
  };

  // Postbacks can carry a referral (e.g. Get Started clicked from an m.me
  // link with `ref`). Promote it so downstream sees both.
  const referral = readObject(postback, 'referral');
  if (referral) {
    const parsed = buildReferralInfo(referral);
    if (parsed) message.referral = parsed;
  }
  return message;
}

function parseFbStyleReferral(
  rawEvent: unknown,
  referral: Record<string, unknown>,
  channel: Channel,
  senderId: string | undefined,
  recipientId: string | undefined,
  timestamp: number
): IncomingMessage | undefined {
  if (!senderId || !recipientId) return undefined;
  const info = buildReferralInfo(referral);
  if (!info) return undefined;

  return {
    channel,
    // Referrals have no message id — synthesize a stable-ish one so dedupe
    // still works within a single payload.
    channelMessageId: `${recipientId}-${timestamp}-referral`,
    channelScopedUserId: senderId,
    channelScopedBusinessId: recipientId,
    timestamp,
    type: 'referral',
    referral: info,
    raw: rawEvent
  };
}

function buildReferralInfo(referral: Record<string, unknown>): ReferralInfo | undefined {
  const source = readString(referral, 'source');
  const type = readString(referral, 'type');
  if (!source || !type) return undefined;
  const info: ReferralInfo = { source, type };
  const ref = readString(referral, 'ref');
  if (ref) info.ref = ref;
  return info;
}

/**
 * Build a normalized {@link ReferralInfo} from a WhatsApp Click-to-WhatsApp
 * (CTWA) ad-attribution block. WhatsApp's `referral` shape diverges from
 * Messenger's: it uses `source_type` instead of `source`, has no `type`,
 * and carries the ad's source URL / headline / body / preview media plus
 * the CTWA click id. We collapse the channel-specific shape onto the
 * shared `ReferralInfo` and stash the WhatsApp-only fields on the optional
 * tail. Without this branch the entire ad attribution is silently dropped.
 */
function buildWhatsAppReferralInfo(
  referral: Record<string, unknown>
): ReferralInfo | undefined {
  const sourceType = readString(referral, 'source_type');
  const sourceUrl = readString(referral, 'source_url');
  const sourceId = readString(referral, 'source_id');
  const ctwaClid = readString(referral, 'ctwa_clid');
  const headline = readString(referral, 'headline');
  const body = readString(referral, 'body');
  // If there's truly nothing usable, drop. Otherwise surface with safe
  // defaults so the conversation agent still sees the click_to_whatsapp tag.
  if (
    !sourceType &&
    !sourceUrl &&
    !sourceId &&
    !ctwaClid &&
    !headline &&
    !body
  ) {
    return undefined;
  }
  const info: ReferralInfo = {
    source: sourceType ?? 'unknown',
    type: 'click_to_whatsapp'
  };
  if (ctwaClid) {
    info.ref = ctwaClid;
    info.ctwaClid = ctwaClid;
  }
  if (sourceUrl) info.sourceUrl = sourceUrl;
  if (sourceId) info.sourceId = sourceId;
  if (headline) info.headline = headline;
  if (body) info.body = body;
  return info;
}

function parseFbStyleReaction(
  rawEvent: unknown,
  reaction: Record<string, unknown>,
  channel: Channel,
  senderId: string | undefined,
  recipientId: string | undefined,
  timestamp: number
): IncomingMessage | undefined {
  if (!senderId || !recipientId) return undefined;
  const targetMessageId = readString(reaction, 'mid');
  if (!targetMessageId) return undefined;

  // Messenger/IG explicitly send `action: 'react' | 'unreact'`. Emoji is an
  // empty string for unreact. Preserve both verbatim so downstream can
  // distinguish without re-parsing `raw`.
  const action = readString(reaction, 'action');
  const emoji = readString(reaction, 'emoji') ?? '';
  const info: ReactionInfo = { emoji, targetMessageId };
  if (action === 'react' || action === 'unreact') info.action = action;

  return {
    channel,
    // Reaction events have no top-level mid — synthesize per (sender, target, action).
    // Timestamp is intentionally NOT in the id: Meta retries non-2xx for 7 days,
    // and batched events sometimes carry slightly-different timestamps for the
    // same logical reaction. Stable id collapses identical reaction events
    // across per-payload retries. Cross-payload dedupe is Stage 5+ territory.
    channelMessageId: `${senderId}-${targetMessageId}-${action ?? 'reaction'}`,
    channelScopedUserId: senderId,
    channelScopedBusinessId: recipientId,
    timestamp,
    type: 'reaction',
    reaction: info,
    raw: rawEvent
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Dispatcher                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Dispatch to the right per-channel parser based on the top-level `object`
 * field. Returns an empty {@link ParseResult} for unknown / missing values
 * — never throws.
 *
 * Note: GIFs and stickers on Instagram do NOT fire webhooks (Meta's docs
 * are explicit on this), so there's nothing to parse for those cases.
 * Tolerate silently.
 */
export function parseMetaWebhook(payload: unknown): ParseResult {
  if (!isObject(payload)) return { messages: [], statuses: [] };
  const object = readString(payload, 'object');
  if (object === 'whatsapp_business_account') return parseWhatsAppWebhook(payload);
  if (object === 'page') return parseMessengerWebhook(payload);
  if (object === 'instagram') return parseInstagramWebhook(payload);
  return { messages: [], statuses: [] };
}
