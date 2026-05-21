/**
 * Outbound send adapter contract.
 *
 * Every per-channel client (WhatsApp / Messenger / Instagram) implements
 * {@link ChannelAdapter} so the conversation agent can dispatch outbound
 * messages without branching on `channel === 'whatsapp'`. Capability
 * differences between channels are surfaced at runtime via {@link
 * ChannelAdapter.supports} rather than by throwing — e.g.
 * `instagramAdapter.supports('template')` returns `false`.
 */

import type { Channel } from '../types.js';
import type { MediaKind } from './media.js';

/**
 * Result of a successful outbound send. Shared across all three channels so
 * the delivery queue and status tracker can key off `messageId` uniformly.
 */
export interface SendResult {
  channel: Channel;
  /** Channel-scoped outbound message id: `wamid.*` (WA), `m_*` (Messenger), `mid.*` (IG). */
  messageId: string;
  recipientId: string;
  /** Milliseconds since epoch — set by the client at send time. */
  timestamp: number;
  /** The raw API response, for debugging. */
  raw?: unknown;
}

/** Per-send options. Channels ignore fields they do not support. */
export interface SendOptions {
  /** Referenced channel message id (WhatsApp `context.message_id` / FB-IG `reply_to.mid`). */
  replyTo?: string;
  /** Messenger / Instagram messaging type. Ignored by WhatsApp. */
  messagingType?: 'RESPONSE' | 'UPDATE' | 'MESSAGE_TAG';
  /** Messenger / Instagram message tag (used when `messagingType === 'MESSAGE_TAG'`). */
  tag?: string;
}

/**
 * Capabilities a channel may advertise. The conversation agent checks these
 * via {@link ChannelAdapter.supports} before attempting a feature, so an
 * unsupported request is skipped cleanly instead of erroring.
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

/**
 * A single WhatsApp template component (header / body / button block).
 *
 * Lives here in the shared transport-contract module — NOT in the WhatsApp
 * client — so type-only consumers (the chat contract, the delivery queue) can
 * reference it without importing the concrete WhatsApp client, which would
 * create an awkward `chat → whatsapp/client` dependency. The WhatsApp client
 * re-exports both `TemplateComponent` and `TemplateParameter` for backward
 * compatibility.
 *
 * Kept deliberately structural rather than a faithful reproduction of Meta's
 * full template schema: the conversation agent only needs to forward the
 * caller-supplied components verbatim into the request body. `type` is the
 * component kind (`'header' | 'body' | 'button'`); `parameters` carries the
 * per-component substitution values (text / currency / date_time / image /
 * payload, etc.). Button components additionally carry `sub_type` and `index`.
 * Extra fields are tolerated so a richer caller payload passes through
 * untouched.
 *
 * Reference: https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-message-templates
 */
export interface TemplateComponent {
  type: 'header' | 'body' | 'button' | string;
  /** Button-only: which button kind this targets (`quick_reply` / `url` / etc.). */
  sub_type?: string;
  /** Button-only: the button position (0-based). */
  index?: number;
  /** Substitution values for the component. Shape varies by parameter `type`. */
  parameters?: TemplateParameter[];
}

/** One substitution parameter inside a {@link TemplateComponent}. */
export interface TemplateParameter {
  type: string;
  text?: string;
  payload?: string;
  /** Other parameter kinds (currency / date_time / image / document / video) pass through. */
  [key: string]: unknown;
}

/**
 * Uniform input for the cross-channel {@link ChannelAdapter.sendMedia}.
 *
 * `kind` is the resolved {@link MediaKind} (the agent infers it from the chat
 * action's MIME type via `inferMediaKind`); `mediaIdOrUrl` is a publicly
 * reachable URL (all channels fetch the asset themselves) or, for WhatsApp, a
 * pre-uploaded `media_id`. `caption` applies to image/video/document (WhatsApp
 * audio drops it — see its `sendAudio`); `filename` names the document the
 * recipient sees.
 */
export interface MediaSendInput {
  /** Resolved send-kind: `'image' | 'audio' | 'video' | 'document'`. */
  kind: MediaKind;
  /** Public URL (every channel) or a WhatsApp pre-uploaded `media_id`. */
  mediaIdOrUrl: string;
  /** Optional caption (image / video / document; ignored where unsupported). */
  caption?: string;
  /** Optional document filename (used by `kind: 'document'`). */
  filename?: string;
}

export interface ChannelAdapter {
  readonly channel: Channel;
  sendText(recipientId: string, text: string, opts?: SendOptions): Promise<SendResult>;
  sendTypingIndicator(recipientId: string, messageId?: string): Promise<void>;
  markRead(recipientId: string, messageId: string): Promise<void>;
  /**
   * Send a reaction to a previous message.
   *
   * WHY `recipientId` is part of the uniform signature: WhatsApp's reaction
   * send REQUIRES the recipient `to` in the request body, whereas Messenger /
   * Instagram derive the target from `messageId` alone and do not need it.
   * Rather than diverge the signature per channel, every adapter takes
   * `recipientId` — the channels that don't need it simply ignore the param.
   * A uniform signature keeps the conversation agent's dispatch code
   * channel-agnostic.
   */
  sendReaction(recipientId: string, messageId: string, emoji: string): Promise<void>;
  /**
   * Send a media attachment (image / audio / video / document) by URL (or, for
   * WhatsApp, a pre-uploaded `media_id`).
   *
   * WHY a single `sendMedia` instead of four interface methods (sendImage /
   * sendAudio / sendVideo / sendDocument): the per-channel clients already
   * expose typed, channel-shaped media methods, but they DIVERGE — Messenger's
   * document method is `sendFile` (its attachment type is literally `'file'`),
   * WhatsApp's `sendDocument` requires a `filename`, WhatsApp `sendAudio` takes
   * no caption, and Instagram's document is a `file` attachment that is PDF-only
   * (~25MB) with no caption/filename in the body. Putting the per-kind switch on
   * the INTERFACE would force the conversation agent to branch on channel + kind
   * before every send. Instead each client implements one `sendMedia` that
   * switches on `input.kind` and routes to its own typed method internally, so
   * the agent dispatches a media item with ZERO channel branching. A send Meta
   * rejects (e.g. a non-PDF / oversized Instagram `file`) throws; the agent
   * catches that and skips the item (fail-soft), exactly like any other send
   * error.
   */
  sendMedia(recipientId: string, input: MediaSendInput): Promise<SendResult>;
  supports(feature: ChannelFeature): boolean;
}
