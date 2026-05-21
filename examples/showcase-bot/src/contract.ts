/**
 * Local copies of the meta-ai-agent chat contract.
 *
 * These mirror the transport package's `src/chat/types.ts` and the inbound
 * `src/meta/types.ts` field-for-field. A published consumer would
 * `import type { ChatRequest, ChatResponse, ChatAction } from 'meta-ai-agent'`;
 * keeping local copies here keeps this example self-contained and DECOUPLED from
 * the transport package's internals.
 *
 * CRITICAL field-name notes vs. the sendblue contract (this file is the Meta
 * one): actions use `text` (not `content`), reactions/replies carry `emoji` +
 * `targetMessageId` (not `reaction`/`messageHandle`), channels are
 * `whatsapp | messenger | instagram`, `conversationKey` is flat, capabilities is
 * a `ChannelFeature[]`, and per-turn context exposes `windowOpen`.
 */

/** The three channels meta-ai-agent speaks. */
export type Channel = 'whatsapp' | 'messenger' | 'instagram';

/**
 * Capabilities the responding channel adapter advertises (its `supports()`
 * truth set). The endpoint tailors its `actions[]` to what the channel can do —
 * e.g. `template` is WhatsApp-only; Instagram has no working `reply_to`.
 */
export type ChannelFeature =
  | 'typing_indicator'
  | 'read_receipt'
  | 'reaction'
  | 'reply_to'
  | 'template'
  | 'persistent_menu'
  | 'get_started'
  | 'ice_breakers'
  | 'story_reply'
  | 'media_send';

/** Discriminator for normalized inbound message types (subset we care about). */
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
  | 'system'
  | 'unknown';

/**
 * Inbound media descriptor — mirrors `MediaInfo` in `src/meta/types.ts`.
 *
 * Note `id` vs `url`: Messenger / Instagram attachments carry a pre-signed CDN
 * `url` directly. WhatsApp media is `id`-based — you must call the Graph API
 * with the WhatsApp access token to resolve a (short-lived) download URL, which
 * this standalone bot does not hold. The media-processor handles the id-only
 * case gracefully (see its WHY-comment).
 */
export interface MediaInfo {
  id?: string;
  url?: string;
  mimeType?: string;
  sha256?: string;
  caption?: string;
  filename?: string;
  voice?: boolean;
  animated?: boolean;
  /**
   * A `data:<mime>;base64,<...>` URI populated by the transport's OPT-IN inbound
   * media hydration (`INBOUND_MEDIA_DOWNLOAD=true`). Present only when the
   * transport downloaded the media (e.g. a WhatsApp image, which is otherwise
   * id-only and not fetchable without the WhatsApp token this bot lacks). When
   * set, the media-processor uses it directly — no fetch, no token needed.
   */
  dataUrl?: string;
}

/** Reaction payload normalized across channels. */
export interface ReactionInfo {
  emoji: string;
  targetMessageId: string;
  action?: 'react' | 'unreact';
}

/** One normalized inbound message in the buffered turn (trimmed `IncomingMessage`). */
export interface IncomingMessage {
  channel: Channel;
  /** `wamid.*` (WhatsApp) / `m_*` (Messenger) / base64-ish id (Instagram). */
  channelMessageId: string;
  channelScopedUserId: string;
  channelScopedBusinessId: string;
  timestamp: number;
  type: MessageType | string;
  text?: string;
  media?: MediaInfo;
  reaction?: ReactionInfo;
  /** Channel-scoped id of the referenced message (a quoted reply target). */
  replyTo?: string;
  raw?: unknown;
}

/** Resolved identity for the user, when available. */
export interface Contact {
  channel: string;
  channelScopedUserId: string;
  firstName?: string;
  lastName?: string;
  displayName?: string;
  email?: string;
  tags?: string[];
  customVariables?: Record<string, string>;
  unifiedContactId?: string;
}

/** A single WhatsApp template component — opaque pass-through for this example. */
export type TemplateComponent = Record<string, unknown>;

/** Payload POSTed to the chat endpoint for one (possibly buffered) inbound turn. */
export interface ChatRequest {
  channel: Channel;
  conversationKey: string;
  /** Backward-compat aggregated text (the buffered message bodies, newline-joined). */
  message?: string;
  /** Structured per-message array for the buffered turn, in arrival order. */
  messages: IncomingMessage[];
  /** Resolved identity for the user, when available. */
  contact?: Contact;
  /** The channel adapter's `supports()` truth set for this conversation. */
  capabilities: ChannelFeature[];
  context: {
    windowOpen: boolean;
    windowExpiresAt?: number;
  };
}

/**
 * One rich action the chat endpoint can ask the agent to perform. Unsupported
 * actions for a channel are skipped by the agent rather than erroring. Uses the
 * Meta field names (`text`, `emoji`, `targetMessageId`).
 */
export type ChatAction =
  | { type: 'message'; text: string }
  | { type: 'typing'; durationMs?: number }
  | { type: 'reaction'; emoji: string; targetMessageId: string }
  | { type: 'reply'; text: string; targetMessageId: string }
  | { type: 'media'; url: string; caption?: string; mimeType?: string; filename?: string }
  | { type: 'template'; name: string; language: string; components?: TemplateComponent[] }
  | { type: 'silence' };

/**
 * Raw response from the chat endpoint. All fields optional — supports the legacy
 * `message` / `messages` / `silence` forms AND the rich `actions[]` form.
 */
export interface ChatResponse {
  message?: string;
  messages?: string[];
  silence?: boolean;
  actions?: ChatAction[];
}
