/**
 * Pure Meta-webhook payload BUILDERS for local tooling (the Stage 9 REPL).
 *
 * These construct the raw webhook payload OBJECTS Meta would POST to
 * `/webhook` — one set per channel (WhatsApp / Messenger / Instagram), covering
 * text / image / reaction / status. They are the inbound half of the contract:
 * every builder's output is fed straight through {@link parseMetaWebhook}
 * (see webhook-builders.test.ts), so the shapes here MUST mirror the real
 * fixtures under `tests/fixtures/meta/**` exactly or the parser drops fields.
 *
 * Discipline:
 *  - PURE. No I/O, no signing, no timestamps-from-the-clock surprises beyond an
 *    explicit `Date.now()` default. The REPL signs + POSTs; these only shape.
 *  - Timestamp encodings differ by channel and that difference is load-bearing:
 *    WhatsApp ships Unix SECONDS as a STRING; Messenger / Instagram ship Unix
 *    MILLISECONDS as a NUMBER. The parser normalizes both to ms, but emitting
 *    the wrong form here would mean the builders don't match what Meta sends.
 *  - Message-id formats mirror Meta's: `wamid.*` (WhatsApp), `m_*` (Messenger),
 *    a base64-flavored id (Instagram). When the caller omits an id we generate a
 *    random-ish one in the right shape so repeated sends don't collide on the
 *    parser's per-payload dedupe.
 *
 * Reference fixtures:
 *  - WhatsApp:   tests/fixtures/meta/whatsapp/{text,image,reaction,status-*}.json
 *  - Messenger:  tests/fixtures/meta/messenger/{text-message,image-attachment,reaction,message-read}.json
 *  - Instagram:  tests/fixtures/meta/instagram/{text-dm,image-attachment,reaction}.json
 */

import { randomBytes } from 'node:crypto';
import type {
  InstagramWebhookPayload,
  MessengerWebhookPayload,
  WhatsAppWebhookPayload
} from '../../src/meta/types.js';

/* ────────────────────────────────────────────────────────────────────────── */
/* Id / timestamp helpers                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

/** URL-safe base64 of `n` random bytes — the alphabet Meta's ids use. */
function randomToken(n: number): string {
  return randomBytes(n).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A `wamid.*`-shaped WhatsApp message id (base64-ish tail, like the fixtures). */
function randomWamid(): string {
  return `wamid.${randomToken(24)}`;
}

/** An `m_*`-shaped Messenger message id. */
function randomMessengerMid(): string {
  return `m_${randomToken(33)}`;
}

/** A base64-flavored Instagram message id (no `m_` prefix — distinct from Messenger). */
function randomInstagramMid(): string {
  return randomToken(36);
}

/** Current Unix time in SECONDS, as a string (WhatsApp's timestamp encoding). */
function nowSecondsString(timestampSec?: number): string {
  return String(timestampSec ?? Math.floor(Date.now() / 1000));
}

/** Current Unix time in MILLISECONDS, as a number (Messenger / Instagram encoding). */
function nowMillis(timestampMs?: number): number {
  return timestampMs ?? Date.now();
}

/* ────────────────────────────────────────────────────────────────────────── */
/* WhatsApp builders                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Wrap a single WhatsApp `change.value` body in the full
 * `whatsapp_business_account` envelope. The business id the parser keys on lives
 * inside `value.metadata.phone_number_id` (set by the callers); the entry `id`
 * here is the WABA id, NOT the phone number id, so it's a fixed placeholder the
 * parser ignores for the business id.
 */
function whatsAppEnvelope(value: Record<string, unknown>): WhatsAppWebhookPayload {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        // WABA id placeholder — distinct from phoneNumberId, mirroring fixtures.
        id: '100000000000001',
        changes: [{ field: 'messages', value: value as never }]
      }
    ]
  };
}

/** Shared WhatsApp `metadata` + `contacts` block for an inbound from `waId`. */
function whatsAppInboundCommon(phoneNumberId: string, waId: string) {
  return {
    messaging_product: 'whatsapp' as const,
    metadata: {
      // Display number is cosmetic; the parser only reads phone_number_id.
      display_phone_number: '15551234567',
      phone_number_id: phoneNumberId
    },
    contacts: [{ profile: { name: 'REPL User' }, wa_id: waId }]
  };
}

export function buildWhatsAppTextWebhook(o: {
  phoneNumberId: string;
  waId: string;
  text: string;
  messageId?: string;
  timestampSec?: number;
}): WhatsAppWebhookPayload {
  return whatsAppEnvelope({
    ...whatsAppInboundCommon(o.phoneNumberId, o.waId),
    messages: [
      {
        from: o.waId,
        id: o.messageId ?? randomWamid(),
        timestamp: nowSecondsString(o.timestampSec),
        type: 'text',
        text: { body: o.text }
      }
    ]
  });
}

export function buildWhatsAppImageWebhook(o: {
  phoneNumberId: string;
  waId: string;
  mediaId: string;
  mimeType?: string;
  caption?: string;
  messageId?: string;
}): WhatsAppWebhookPayload {
  return whatsAppEnvelope({
    ...whatsAppInboundCommon(o.phoneNumberId, o.waId),
    messages: [
      {
        from: o.waId,
        id: o.messageId ?? randomWamid(),
        timestamp: nowSecondsString(),
        type: 'image',
        image: {
          id: o.mediaId,
          mime_type: o.mimeType ?? 'image/jpeg',
          // Caption is optional — only included when provided (matches Meta).
          ...(o.caption !== undefined ? { caption: o.caption } : {})
        }
      }
    ]
  });
}

export function buildWhatsAppReactionWebhook(o: {
  phoneNumberId: string;
  waId: string;
  emoji: string;
  targetMessageId: string;
  messageId?: string;
}): WhatsAppWebhookPayload {
  return whatsAppEnvelope({
    ...whatsAppInboundCommon(o.phoneNumberId, o.waId),
    messages: [
      {
        from: o.waId,
        id: o.messageId ?? randomWamid(),
        timestamp: nowSecondsString(),
        type: 'reaction',
        reaction: { message_id: o.targetMessageId, emoji: o.emoji }
      }
    ]
  });
}

export function buildWhatsAppStatusWebhook(o: {
  phoneNumberId: string;
  waId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  messageId: string;
}): WhatsAppWebhookPayload {
  // Status payloads carry NO `contacts`/`messages` — only `metadata` + `statuses`.
  const value: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    metadata: {
      display_phone_number: '15551234567',
      phone_number_id: o.phoneNumberId
    },
    statuses: [
      {
        id: o.messageId,
        status: o.status,
        timestamp: nowSecondsString(),
        recipient_id: o.waId,
        // A `failed` status carries an error envelope on the real API; include a
        // representative one so the parser's errorCode/errorTitle path is exercised.
        ...(o.status === 'failed'
          ? {
              errors: [
                {
                  code: 131_026,
                  title: 'Message undeliverable',
                  message: 'Message undeliverable'
                }
              ]
            }
          : {})
      }
    ]
  };
  return whatsAppEnvelope(value);
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Messenger builders (object 'page', entry[].messaging[])                    */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Wrap one Messenger `messaging[]` event in the full `page` envelope. `pageId`
 * is both the entry `id` and the inbound `recipient.id` (the business side);
 * `psid` is the user `sender.id`.
 */
function messengerEnvelope(
  pageId: string,
  event: Record<string, unknown>,
  timestampMs: number
): MessengerWebhookPayload {
  return {
    object: 'page',
    entry: [
      {
        id: pageId,
        time: timestampMs,
        messaging: [event as never]
      }
    ]
  };
}

/** Sender/recipient/timestamp scaffold shared by every inbound Messenger event. */
function fbStyleEnvelopePieces(businessId: string, userId: string, timestampMs: number) {
  return {
    // Inbound direction: sender = user, recipient = business (page/IG account).
    sender: { id: userId },
    recipient: { id: businessId },
    timestamp: timestampMs
  };
}

export function buildMessengerTextWebhook(o: {
  pageId: string;
  psid: string;
  text: string;
  messageId?: string;
}): MessengerWebhookPayload {
  const ts = nowMillis();
  return messengerEnvelope(
    o.pageId,
    {
      ...fbStyleEnvelopePieces(o.pageId, o.psid, ts),
      message: { mid: o.messageId ?? randomMessengerMid(), text: o.text }
    },
    ts
  );
}

export function buildMessengerImageWebhook(o: {
  pageId: string;
  psid: string;
  url: string;
  messageId?: string;
}): MessengerWebhookPayload {
  const ts = nowMillis();
  return messengerEnvelope(
    o.pageId,
    {
      ...fbStyleEnvelopePieces(o.pageId, o.psid, ts),
      message: {
        mid: o.messageId ?? randomMessengerMid(),
        attachments: [{ type: 'image', payload: { url: o.url } }]
      }
    },
    ts
  );
}

export function buildMessengerReactionWebhook(o: {
  pageId: string;
  psid: string;
  emoji: string;
  targetMessageId: string;
}): MessengerWebhookPayload {
  const ts = nowMillis();
  return messengerEnvelope(
    o.pageId,
    {
      ...fbStyleEnvelopePieces(o.pageId, o.psid, ts),
      // Messenger reactions carry an explicit action + a symbolic `reaction` name
      // alongside the emoji (see the reaction fixture).
      reaction: { mid: o.targetMessageId, action: 'react', emoji: o.emoji, reaction: 'love' }
    },
    ts
  );
}

export function buildMessengerReadWebhook(o: {
  pageId: string;
  psid: string;
  watermark?: number;
}): MessengerWebhookPayload {
  const ts = nowMillis();
  // Messenger reads are a WATERMARK timestamp ("everything sent at/before this
  // ms has been read"), NOT a per-message id. Default the watermark to slightly
  // before `now` so it plausibly covers an already-sent outbound.
  const watermark = o.watermark ?? ts - 1;
  return messengerEnvelope(
    o.pageId,
    {
      ...fbStyleEnvelopePieces(o.pageId, o.psid, ts),
      read: { watermark }
    },
    ts
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Instagram builders (object 'instagram', same messaging[] shape)            */
/* ────────────────────────────────────────────────────────────────────────── */

/** Wrap one Instagram `messaging[]` event in the full `instagram` envelope. */
function instagramEnvelope(
  igUserId: string,
  event: Record<string, unknown>,
  timestampMs: number
): InstagramWebhookPayload {
  return {
    object: 'instagram',
    entry: [
      {
        id: igUserId,
        time: timestampMs,
        messaging: [event as never]
      }
    ]
  };
}

export function buildInstagramTextWebhook(o: {
  igUserId: string;
  igsid: string;
  text: string;
  messageId?: string;
}): InstagramWebhookPayload {
  const ts = nowMillis();
  return instagramEnvelope(
    o.igUserId,
    {
      ...fbStyleEnvelopePieces(o.igUserId, o.igsid, ts),
      message: { mid: o.messageId ?? randomInstagramMid(), text: o.text }
    },
    ts
  );
}

export function buildInstagramImageWebhook(o: {
  igUserId: string;
  igsid: string;
  url: string;
  messageId?: string;
}): InstagramWebhookPayload {
  const ts = nowMillis();
  return instagramEnvelope(
    o.igUserId,
    {
      ...fbStyleEnvelopePieces(o.igUserId, o.igsid, ts),
      message: {
        mid: o.messageId ?? randomInstagramMid(),
        attachments: [{ type: 'image', payload: { url: o.url } }]
      }
    },
    ts
  );
}

export function buildInstagramReactionWebhook(o: {
  igUserId: string;
  igsid: string;
  emoji: string;
  targetMessageId: string;
}): InstagramWebhookPayload {
  const ts = nowMillis();
  return instagramEnvelope(
    o.igUserId,
    {
      ...fbStyleEnvelopePieces(o.igUserId, o.igsid, ts),
      reaction: { mid: o.targetMessageId, action: 'react', emoji: o.emoji, reaction: 'love' }
    },
    ts
  );
}

export function buildInstagramReadWebhook(o: {
  igUserId: string;
  igsid: string;
  watermark?: number;
}): InstagramWebhookPayload {
  const ts = nowMillis();
  // Instagram read receipts can carry either an explicit `read.mid` or a
  // watermark. The parser accepts both; we stringify a watermark into
  // channelMessageId (matching the Messenger watermark path), so emit the
  // watermark form for symmetry with buildMessengerReadWebhook.
  const watermark = o.watermark ?? ts - 1;
  return instagramEnvelope(
    o.igUserId,
    {
      ...fbStyleEnvelopePieces(o.igUserId, o.igsid, ts),
      read: { watermark }
    },
    ts
  );
}
