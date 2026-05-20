/**
 * Meta webhook payload types — both the raw shapes Meta sends per channel
 * (WhatsApp Cloud API, Messenger Platform, Instagram Business Login) and the
 * normalized cross-channel shapes (`IncomingMessage`, `StatusUpdate`,
 * `ParseResult`) the rest of this package consumes.
 *
 * Raw types model what Meta documents, with `unknown` placeholders for fields
 * we don't yet model rigorously. Normalized types intentionally collapse
 * per-channel differences so the conversation agent never branches on
 * `channel === 'whatsapp'` for routing concerns the parser can hide.
 *
 * Reference:
 *  - WhatsApp Cloud API: https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples
 *  - Messenger Platform: https://developers.facebook.com/docs/messenger-platform/webhooks
 *  - Instagram Messaging: https://developers.facebook.com/docs/instagram-platform/webhooks
 */

/* ────────────────────────────────────────────────────────────────────────── */
/* WhatsApp raw payload                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

/** Top-level WhatsApp webhook envelope. `object` is the routing discriminator. */
export interface WhatsAppWebhookPayload {
  object: 'whatsapp_business_account';
  entry: WhatsAppEntry[];
}

/** Per-WABA (WhatsApp Business Account) bucket inside a webhook payload. */
export interface WhatsAppEntry {
  /** WABA id, NOT the phone number id (which lives in `value.metadata`). */
  id: string;
  changes: WhatsAppChange[];
}

/** A single field change within an entry; for messaging this is always `field: 'messages'`. */
export interface WhatsAppChange {
  field: string;
  value: WhatsAppChangeValue;
}

/**
 * Body of a WhatsApp change. Holds the actual messages / statuses /
 * contacts / errors arrays plus the business identity metadata.
 */
export interface WhatsAppChangeValue {
  messaging_product?: 'whatsapp';
  metadata: WhatsAppMetadata;
  contacts?: WhatsAppContact[];
  messages?: WhatsAppMessage[];
  statuses?: WhatsAppStatus[];
  errors?: WhatsAppError[];
}

/** Business-side identity for the WhatsApp number that received the event. */
export interface WhatsAppMetadata {
  /** Phone-number id — the OUTBOUND target id you POST messages to. */
  phone_number_id: string;
  /** Display phone number (E.164 without `+`, sometimes with). */
  display_phone_number: string;
}

/** Inbound sender's WhatsApp identity card. */
export interface WhatsAppContact {
  profile?: { name?: string };
  /** Sender's `wa_id` (E.164 without `+`). */
  wa_id: string;
}

/** Discriminator for the per-message-type fields Meta nests under `messages[]`. */
export type WhatsAppMessageType =
  | 'text'
  | 'image'
  | 'audio'
  | 'video'
  | 'document'
  | 'sticker'
  | 'location'
  | 'reaction'
  | 'interactive'
  | 'button'
  | 'contacts'
  | 'system'
  | 'unknown';

/** Reply context attached to a WhatsApp message when the user quoted a previous message. */
export interface WhatsAppMessageContext {
  /** wamid of the referenced message. */
  message_id?: string;
  /** Forwarded-from chain marker. */
  from?: string;
  /** Reply context can include unrelated `referred_product`/`forwarded` fields — preserved as unknown. */
  [key: string]: unknown;
}

/** One inbound WhatsApp message. Field union covers all documented `type` variants. */
export interface WhatsAppMessage {
  /** Sender's `wa_id` (E.164 without `+`). */
  from: string;
  /** Message id (`wamid.*`). */
  id: string;
  /** Unix seconds as a string. Tolerate numeric form too in case Meta changes. */
  timestamp: string | number;
  type: WhatsAppMessageType | string;
  context?: WhatsAppMessageContext;
  text?: { body?: string };
  image?: WhatsAppMediaPayload;
  audio?: WhatsAppMediaPayload & { voice?: boolean };
  video?: WhatsAppMediaPayload;
  document?: WhatsAppMediaPayload & { filename?: string };
  sticker?: WhatsAppMediaPayload & { animated?: boolean };
  location?: {
    latitude?: number;
    longitude?: number;
    name?: string;
    address?: string;
  };
  reaction?: { message_id?: string; emoji?: string };
  interactive?: WhatsAppInteractive;
  button?: { payload?: string; text?: string };
  contacts?: unknown;
  system?: unknown;
  errors?: WhatsAppError[];
  /** Tolerate unmodeled fields without throwing. */
  [key: string]: unknown;
}

/** Shared media payload shape for WhatsApp image/audio/video/document/sticker types. */
export interface WhatsAppMediaPayload {
  id?: string;
  mime_type?: string;
  sha256?: string;
  caption?: string;
}

/** Interactive (button/list) reply payload. */
export interface WhatsAppInteractive {
  type?: 'button_reply' | 'list_reply' | string;
  button_reply?: { id?: string; title?: string };
  list_reply?: { id?: string; title?: string; description?: string };
}

/** Documented outbound-status values WhatsApp emits in `statuses[]`. */
export type WhatsAppStatusValue = 'sent' | 'delivered' | 'read' | 'failed';

/** One delivery-status update for a previously-sent outbound message. */
export interface WhatsAppStatus {
  /** wamid of the OUTBOUND message this status refers to. */
  id: string;
  status: WhatsAppStatusValue | string;
  /** Unix seconds as a string. */
  timestamp: string | number;
  /** Recipient `wa_id` (the user; the business is `metadata.phone_number_id`). */
  recipient_id: string;
  conversation?: unknown;
  pricing?: unknown;
  errors?: WhatsAppError[];
}

/** WhatsApp error envelope shape (appears on `messages[]`, `statuses[]`, and top-level `errors[]`). */
export interface WhatsAppError {
  code?: number;
  title?: string;
  message?: string;
  href?: string;
  error_data?: { details?: string };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Messenger raw payload                                                      */
/* ────────────────────────────────────────────────────────────────────────── */

/** Top-level Messenger webhook envelope. */
export interface MessengerWebhookPayload {
  object: 'page';
  entry: MessengerEntry[];
}

/**
 * Per-page bucket. Stage 2 scope is messaging only, so `messaging[]` is the
 * primary surface. Feed-style events arrive as `changes[]` — modeled as
 * `unknown[]` until we have a fixture and a concrete use case.
 */
export interface MessengerEntry {
  /** Page id. */
  id: string;
  /** Unix milliseconds. */
  time: number;
  messaging?: MessengerMessagingEvent[];
  /** Non-messaging feed events (post comments, etc.). Out of scope for Stage 2. */
  changes?: unknown[];
}

/** A single Messenger messaging event — exactly one of message/postback/etc. is set. */
export interface MessengerMessagingEvent {
  /** Sender id. For inbound this is the user PSID; for echoes this is the Page id. */
  sender: { id: string };
  /** Recipient id. For inbound this is the Page id; for echoes this is the user PSID. */
  recipient: { id: string };
  /** Unix milliseconds. */
  timestamp?: number;
  message?: MessengerMessage;
  postback?: MessengerPostback;
  referral?: MessengerReferral;
  reaction?: MessengerReaction;
  read?: { watermark?: number; seq?: number };
  delivery?: { mids?: string[]; watermark?: number; seq?: number };
  optin?: unknown;
  account_linking?: unknown;
  /** Tolerate unmodeled fields. */
  [key: string]: unknown;
}

/** Inbound (or echoed outbound) Messenger message. */
export interface MessengerMessage {
  /** Message id (`m_*`). */
  mid: string;
  text?: string;
  attachments?: MessengerAttachment[];
  /** Reply-to: presence of `reply_to.mid` means this is a thread reply. */
  reply_to?: { mid?: string };
  /** Quick-reply payload selected by the user. */
  quick_reply?: { payload?: string };
  /** True iff this message is a business-sent message echoed back to the page. */
  is_echo?: boolean;
  /** App that sent the echoed message; only present on `is_echo: true`. */
  app_id?: number;
  metadata?: string;
}

/** Messenger attachment envelope. `type` discriminates `image`/`audio`/`video`/`file`/`location`/`fallback`/`template`. */
export interface MessengerAttachment {
  type: string;
  payload?: MessengerAttachmentPayload;
  title?: string;
  url?: string;
}

/** Attachment payload — fields populated depend on `type`. */
export interface MessengerAttachmentPayload {
  url?: string;
  sticker_id?: number;
  /** Location attachments use lat/long. */
  coordinates?: { lat?: number; long?: number };
  /** Templates use a `template_type` discriminator. */
  template_type?: string;
  [key: string]: unknown;
}

/** Postback event triggered by a button click or Get Started. */
export interface MessengerPostback {
  /** Message id of the postback itself (`m_*`). */
  mid?: string;
  title?: string;
  payload: string;
  referral?: MessengerReferral;
}

/** m.me referral event from an ad click or link with `ref` parameter. */
export interface MessengerReferral {
  source: string;
  type: string;
  ref?: string;
  ad_id?: string;
  referer_uri?: string;
  ads_context_data?: unknown;
}

/** Reaction event. Messenger sends `action: 'react' | 'unreact'`. */
export interface MessengerReaction {
  /** Message id the reaction targets (`m_*`). */
  mid: string;
  action: 'react' | 'unreact' | string;
  /** Emoji is empty string when `action === 'unreact'`. */
  emoji?: string;
  /** Symbolic reaction name (`love`, `like`, etc.) — Messenger sends this alongside the emoji. */
  reaction?: string;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Instagram raw payload                                                      */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Top-level Instagram webhook envelope. Identical structure to Messenger
 * but distinguished by `object: 'instagram'` when using the Business Login
 * path (not the legacy Page-linked flow).
 */
export interface InstagramWebhookPayload {
  object: 'instagram';
  entry: InstagramEntry[];
}

/** Per-IG-account bucket. Mirrors `MessengerEntry`. */
export interface InstagramEntry {
  /** Instagram User Id (the business account). */
  id: string;
  /** Unix milliseconds. */
  time: number;
  messaging?: InstagramMessagingEvent[];
  /** Non-messaging feed events. Out of scope for Stage 2. */
  changes?: unknown[];
}

/** Instagram messaging event. Shape matches Messenger's but adds story-related reply fields. */
export interface InstagramMessagingEvent {
  /** For inbound this is the user IGSID; for echoes this is the business IG user id. */
  sender: { id: string };
  /** For inbound this is the business IG user id; for echoes this is the user IGSID. */
  recipient: { id: string };
  /** Unix milliseconds. */
  timestamp?: number;
  message?: InstagramMessage;
  postback?: InstagramPostback;
  referral?: InstagramReferral;
  reaction?: InstagramReaction;
  read?: { mid?: string };
  /** Tolerate unmodeled fields (e.g. messaging_seen variations). */
  [key: string]: unknown;
}

/** Inbound Instagram message. Adds story-reply / story-mention surfaces. */
export interface InstagramMessage {
  /** Message id. Instagram emits a base64-flavored id distinct from `m_*`. */
  mid: string;
  text?: string;
  attachments?: InstagramAttachment[];
  reply_to?: {
    mid?: string;
    /** Set when the user replied to a story you posted (Instagram only). */
    story?: { id?: string; url?: string };
  };
  is_echo?: boolean;
  app_id?: number;
}

/** Instagram attachment. `type: 'story_mention'` is the load-bearing IG-only variant. */
export interface InstagramAttachment {
  type: string;
  payload?: { url?: string; [key: string]: unknown };
}

/** Instagram postback. Less common than Messenger's but documented. */
export interface InstagramPostback {
  mid?: string;
  title?: string;
  payload: string;
}

/** ig.me referral event from an ad click or link with `ref` parameter. */
export interface InstagramReferral {
  source: string;
  type: string;
  ref?: string;
  ad_id?: string;
  ads_context_data?: unknown;
}

/** Instagram reaction event. Same shape as Messenger's. */
export interface InstagramReaction {
  mid: string;
  action: 'react' | 'unreact' | string;
  emoji?: string;
  reaction?: string;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Normalized cross-channel types                                             */
/* ────────────────────────────────────────────────────────────────────────── */

/** The three channels this package handles under a single Meta App. */
export type Channel = 'whatsapp' | 'messenger' | 'instagram';

// Re-export the outbound adapter contract for discoverability — the Stage 4
// send adapters and the conversation agent can import these alongside the
// inbound types from a single module. The definitions live in
// `./shared/adapter.ts` (transport-adjacent), here we just surface them.
export type {
  SendResult,
  SendOptions,
  ChannelFeature,
  ChannelAdapter
} from './shared/adapter.js';

/**
 * Discriminator for normalized inbound message types.
 *
 * Note: `read` is intentionally NOT in this union — read receipts are
 * StatusUpdate events, not IncomingMessage events.
 */
export type MessageType =
  | 'text'
  | 'image'
  | 'audio'
  | 'video'
  | 'document'
  | 'sticker'
  | 'location'
  | 'reaction'
  | 'interactive'
  | 'postback'
  | 'referral'
  | 'echo'
  // WhatsApp-only: e.g. user changed their number, group naming events, etc.
  // Body lives at `messages[i].system.body` — preserved as `text`.
  | 'system'
  | 'unknown';

/** Media descriptor attached to image/audio/video/document/sticker inbounds. */
export interface MediaInfo {
  /** Meta media id. WhatsApp uses this to download via Graph API; FB/IG attachments usually carry `url` directly. */
  id?: string;
  /** Direct URL when Meta provides one (Messenger / Instagram attachments). */
  url?: string;
  mimeType?: string;
  /** WhatsApp-only integrity hash for downloaded media. */
  sha256?: string;
  caption?: string;
  /** Documents (WhatsApp) carry a user-facing filename. */
  filename?: string;
  /** WhatsApp distinguishes voice notes from regular audio. */
  voice?: boolean;
  /** WhatsApp animated-sticker flag. */
  animated?: boolean;
}

/** Reaction payload normalized across channels. */
export interface ReactionInfo {
  /** Emoji codepoint. WhatsApp encodes an unreact as empty string — preserved exactly. */
  emoji: string;
  /** Channel message id the reaction targets. */
  targetMessageId: string;
  /** Messenger / Instagram send 'react' or 'unreact' explicitly; WhatsApp infers from empty emoji. */
  action?: 'react' | 'unreact';
}

/** Instagram story reference attached to story-reply / story-mention inbounds. */
export interface StoryReplyInfo {
  id: string;
  url?: string;
}

/** Messenger / Instagram postback payload (button click, Get Started, Ice Breaker). */
export interface PostbackInfo {
  title?: string;
  payload: string;
}

/** Referral event for m.me / ig.me link clicks (ad ref params, etc.). */
export interface ReferralInfo {
  source: string;
  type: string;
  ref?: string;
  // CTWA = Click-to-WhatsApp. When a user taps a WhatsApp ad on FB/IG, Meta
  // attaches a `referral` block to the very first inbound carrying the ad's
  // source URL, headline, body, optional preview media, and a CTWA click id
  // (`ctwa_clid`) that ties the conversation back to the ad attribution
  // pipeline. None of these surface anywhere else, so dropping them on the
  // floor permanently loses the ad → conversation linkage.
  ctwaClid?: string;
  sourceUrl?: string;
  sourceId?: string;
  headline?: string;
  body?: string;
}

/**
 * WhatsApp Flow response payload (`interactive.type === 'nfm_reply'`).
 *
 * `responseJson` is the user's serialized form submission as a JSON string —
 * Meta does not pre-parse it. Downstream consumers parse it lazily so the
 * parser stays schema-agnostic. `bodyText` and `name` are convenience labels.
 */
export interface FlowResponseInfo {
  name?: string;
  bodyText?: string;
  responseJson: string;
}

/**
 * WhatsApp forwarded-message metadata. `context.forwarded` is set whenever
 * the user forwarded a message; `frequently_forwarded` is the stricter flag
 * Meta surfaces for "many-times forwarded" chains — useful as a spam /
 * misinformation signal that the conversation agent may want to react to.
 */
export interface ForwardedInfo {
  forwarded: boolean;
  frequentlyForwarded?: boolean;
}

/**
 * Normalized inbound message used by every downstream stage (conversation
 * agent, status tracker, chat client, send adapters).
 *
 * `channelScopedUserId` is ALWAYS the OTHER party (the user) regardless of
 * direction — for echoes, `sender`/`recipient` are flipped in the raw payload
 * and the parser unflips them here. `channelScopedBusinessId` is ALWAYS your
 * side (phone_number_id / page id / ig user id).
 */
export interface IncomingMessage {
  channel: Channel;
  /** `wamid.*` for WhatsApp, `m_*` for Messenger, base64-ish for Instagram. */
  channelMessageId: string;
  /** The OTHER party — `wa_id` / PSID / IGSID. */
  channelScopedUserId: string;
  /** Your side — `phone_number_id` / page id / ig user id. */
  channelScopedBusinessId: string;
  /** Unix milliseconds. Normalized at the parser boundary (WhatsApp is seconds in raw). */
  timestamp: number;
  type: MessageType;
  text?: string;
  media?: MediaInfo;
  reaction?: ReactionInfo;
  /** Channel-scoped id of the referenced message (WA `context.message_id`, FB/IG `reply_to.mid`). */
  replyTo?: string;
  /** Instagram story-reply target. */
  storyReply?: StoryReplyInfo;
  /** Instagram story-mention target (`attachments[].type === 'story_mention'`). Distinct from storyReply. */
  storyMention?: StoryReplyInfo;
  /** Messenger / Instagram postback button payload. */
  postback?: PostbackInfo;
  /** Messenger / Instagram referral metadata. */
  referral?: ReferralInfo;
  /** Business-sent message echoed back to us. The conversation agent filters these (Stage 5). */
  isEcho?: boolean;
  /** WhatsApp Flow response — only set when `interactive.type === 'nfm_reply'`. */
  flowResponse?: FlowResponseInfo;
  /** WhatsApp forwarded-from flags pulled from `messages[i].context`. */
  forwarded?: ForwardedInfo;
  /**
   * The per-message raw payload (e.g. `messages[i]` or the `messaging[]`
   * entry) — NOT the entire webhook envelope. For downstream debugging only.
   */
  raw: unknown;
}

/** Cross-channel delivery status enum. WhatsApp produces all four; Messenger/IG produce read/delivered via watermark. */
export type DeliveryStatus = 'sent' | 'delivered' | 'read' | 'failed';

/**
 * Normalized status update for a previously-sent outbound message.
 *
 * For WhatsApp every status event maps 1:1 to a wamid via `statuses[].id`.
 * For Messenger/IG, `read.watermark` and `delivery.mids[]` populate this —
 * read events use the watermark string as `channelMessageId` (downstream
 * code sweeps all outbound with timestamps <= watermark).
 */
export interface StatusUpdate {
  channel: Channel;
  /** Channel-scoped id of the OUTBOUND message this status refers to (or the watermark for FB/IG read events). */
  channelMessageId: string;
  /** The user side. WhatsApp provides this; Messenger/IG derive from `messaging[].sender.id` on read. */
  channelScopedUserId?: string;
  channelScopedBusinessId: string;
  status: DeliveryStatus;
  /** Unix milliseconds. */
  timestamp: number;
  /** WhatsApp-only: documented error code on `failed`. */
  errorCode?: number;
  /** WhatsApp-only: short error title. */
  errorTitle?: string;
  /**
   * The per-status raw payload (e.g. `statuses[i]` or the `messaging[]`
   * entry) — NOT the entire webhook envelope.
   */
  raw: unknown;
}

/**
 * Return value from every per-channel parser. Holds both the inbound
 * messages and the status updates extracted from a single webhook delivery.
 */
export interface ParseResult {
  messages: IncomingMessage[];
  statuses: StatusUpdate[];
}
