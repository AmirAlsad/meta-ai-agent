/**
 * Messenger Platform outbound send client.
 *
 * Implements the shared {@link ChannelAdapter} contract on top of the
 * transport-only {@link GraphClient}. Every call POSTs to
 * `{pageId}/messages` on `graph.facebook.com` with the Page access token sent
 * as an `Authorization: Bearer` header (the GraphClient does this — the token
 * is NEVER placed in the URL).
 *
 * This client owns the Messenger Send API body shapes (`recipient`,
 * `messaging_type`, `message`, `sender_action`, `tag`); the GraphClient knows
 * none of them.
 *
 * Reference: https://developers.facebook.com/docs/messenger-platform/reference/send-api
 *
 * NEVER log access tokens or full request bodies.
 */

import type pino from 'pino';
import type { MessengerConfig } from '../../config/loader.js';
import type { GraphClient } from '../shared/graph-client.js';
import type {
  ChannelAdapter,
  ChannelFeature,
  MediaSendInput,
  SendOptions,
  SendResult
} from '../shared/adapter.js';

export interface MessengerClientDeps {
  config: MessengerConfig;
  graph: GraphClient;
  logger?: Pick<pino.Logger, 'info' | 'warn' | 'debug'>;
}

/**
 * Per-media-send options. Messenger media is URL-based, so the only knob is
 * whether Meta should mint a reusable attachment id from the URL.
 */
export interface MediaSendOptions {
  /**
   * Ask Meta to return a reusable `attachment_id` for this asset (default
   * `false`). Leave unset for one-shot sends — see the WHY-comment on
   * {@link MessengerClient.sendAttachment}.
   */
  isReusable?: boolean;
}

/** Shape of the `{pageId}/messages` send response we care about. */
interface MessengerSendResponse {
  /** Outbound message id (`m_...`). */
  message_id?: string;
  /** PSID the message was delivered to (echoed back by the API). */
  recipient_id?: string;
}

export class MessengerClient implements ChannelAdapter {
  readonly channel = 'messenger' as const;

  private readonly config: MessengerConfig;
  private readonly graph: GraphClient;

  constructor(deps: MessengerClientDeps) {
    this.config = deps.config;
    this.graph = deps.graph;
  }

  /**
   * Send a text message via `POST {pageId}/messages`.
   *
   * Body shape:
   * `{ recipient: { id }, messaging_type, message: { text }, reply_to?, tag? }`.
   *
   * - `messaging_type` defaults to `RESPONSE` (a reply within the standard
   *   messaging window). Callers send `UPDATE` / `MESSAGE_TAG` via `opts`.
   * - `MESSAGE_TAG` REQUIRES a `tag` at the TOP LEVEL of the body (not nested
   *   under `message`) — we validate it is present and throw a clear error
   *   otherwise, since Meta would reject the call with an opaque error.
   * - `opts.replyTo` becomes a TOP-LEVEL `reply_to.mid` (thread reply) — a
   *   sibling of `message`, NOT nested inside it (Meta rejects `message.reply_to`
   *   with `(#100) Invalid keys "reply_to" were found in param "message"`).
   *
   * @throws Error when `messagingType === 'MESSAGE_TAG'` but no `tag` is set.
   * @throws {import('../shared/errors.js').MetaApiError} on a non-2xx response.
   */
  async sendText(recipientId: string, text: string, opts?: SendOptions): Promise<SendResult> {
    const messagingType = opts?.messagingType ?? 'RESPONSE';

    // A MESSAGE_TAG send is the out-of-window path; Meta requires the tag to
    // justify messaging outside the 24-hour window. Validate up front so the
    // failure is a clear local error rather than an opaque Meta rejection.
    if (messagingType === 'MESSAGE_TAG' && !opts?.tag) {
      throw new Error(
        "Messenger sendText with messagingType 'MESSAGE_TAG' requires opts.tag to be set"
      );
    }

    const message: { text: string } = { text };

    const body: Record<string, unknown> = {
      recipient: { id: recipientId },
      messaging_type: messagingType,
      message
    };
    if (opts?.replyTo !== undefined) {
      // top-level sibling, not inside message — Meta rejects message.reply_to
      // with (#100). FB/IG thread replies reference the prior message via
      // `reply_to.mid` (WhatsApp uses `context.message_id` instead — handled in
      // its client). The mid passes through verbatim (no prefix stripping).
      body['reply_to'] = { mid: opts.replyTo };
    }
    // `tag` is a TOP-LEVEL field, not nested under `message`.
    if (messagingType === 'MESSAGE_TAG' && opts?.tag) {
      body['tag'] = opts.tag;
    }

    const raw = await this.post(body, 'messenger.sendText');
    return this.toSendResult(recipientId, raw);
  }

  /**
   * Show the typing bubble: `{ recipient: { id }, sender_action: 'typing_on' }`.
   *
   * WHY a separate request from {@link sendText}: the Messenger Send API
   * REJECTS a body that combines a `sender_action` with a `message` in a
   * single call. The typing indicator and the text MUST be two distinct POSTs.
   * The conversation agent / delivery queue sequences them (typing → delay →
   * text) rather than merging them here.
   */
  async sendTypingOn(recipientId: string): Promise<void> {
    await this.post(
      { recipient: { id: recipientId }, sender_action: 'typing_on' },
      'messenger.sendTypingOn'
    );
  }

  /**
   * Hide the typing bubble: `{ recipient: { id }, sender_action: 'typing_off' }`.
   * Like {@link sendTypingOn}, this is a standalone `sender_action` call.
   */
  async sendTypingOff(recipientId: string): Promise<void> {
    await this.post(
      { recipient: { id: recipientId }, sender_action: 'typing_off' },
      'messenger.sendTypingOff'
    );
  }

  /**
   * Mark the thread seen: `{ recipient: { id }, sender_action: 'mark_seen' }`.
   *
   * Messenger has no per-message read receipt — `mark_seen` advances a
   * thread-level watermark that marks ALL prior inbound messages as read.
   */
  async markSeen(recipientId: string): Promise<void> {
    await this.post(
      { recipient: { id: recipientId }, sender_action: 'mark_seen' },
      'messenger.markSeen'
    );
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /* Media sends — message.attachment with a URL payload                        */
  /* ──────────────────────────────────────────────────────────────────────── */

  /**
   * Send an image: `message.attachment` with `type: 'image'` and a URL payload.
   * Delegates to {@link sendAttachment}.
   */
  async sendImage(recipientId: string, url: string, opts?: MediaSendOptions): Promise<SendResult> {
    return this.sendAttachment(recipientId, 'image', url, 'messenger.sendImage', opts);
  }

  /**
   * Send an audio clip: `message.attachment` with `type: 'audio'` and a URL
   * payload. Delegates to {@link sendAttachment}.
   */
  async sendAudio(recipientId: string, url: string, opts?: MediaSendOptions): Promise<SendResult> {
    return this.sendAttachment(recipientId, 'audio', url, 'messenger.sendAudio', opts);
  }

  /**
   * Send a video: `message.attachment` with `type: 'video'` and a URL payload.
   * Delegates to {@link sendAttachment}.
   */
  async sendVideo(recipientId: string, url: string, opts?: MediaSendOptions): Promise<SendResult> {
    return this.sendAttachment(recipientId, 'video', url, 'messenger.sendVideo', opts);
  }

  /**
   * Send a generic file/document: `message.attachment` with `type: 'file'` and a
   * URL payload. Delegates to {@link sendAttachment}.
   *
   * WHY this is `sendFile` (not `sendDocument`): Messenger's attachment type for
   * arbitrary documents is literally `'file'`, so the method mirrors the API.
   * (WhatsApp calls the same concept `sendDocument` — the uniform `sendMedia`
   * maps a `document` kind to this method so the agent stays channel-agnostic.)
   */
  async sendFile(recipientId: string, url: string, opts?: MediaSendOptions): Promise<SendResult> {
    return this.sendAttachment(recipientId, 'file', url, 'messenger.sendFile', opts);
  }

  /**
   * {@link ChannelAdapter.sendMedia} — route a uniform media payload to the
   * typed per-kind method above based on `input.kind`. `document` maps to
   * {@link MessengerClient.sendFile} (Messenger's document attachment type is
   * literally `'file'`); `image`/`audio`/`video` map to their matching methods.
   * Captions are not part of Messenger's URL-attachment body, so `input.caption`
   * / `input.filename` are intentionally unused here. The agent calls this so it
   * can dispatch a media item without branching on channel or kind.
   */
  async sendMedia(recipientId: string, input: MediaSendInput): Promise<SendResult> {
    switch (input.kind) {
      case 'image':
        return this.sendImage(recipientId, input.mediaIdOrUrl);
      case 'audio':
        return this.sendAudio(recipientId, input.mediaIdOrUrl);
      case 'video':
        return this.sendVideo(recipientId, input.mediaIdOrUrl);
      case 'document':
        return this.sendFile(recipientId, input.mediaIdOrUrl);
    }
  }

  /**
   * Shared media send: `POST {pageId}/messages` with
   * `{ recipient, messaging_type: 'RESPONSE', message: { attachment: { type,
   * payload: { url, is_reusable } } } }`.
   *
   * WHY URL-based (no upload step): Messenger fetches the asset from the supplied
   * URL itself — unlike WhatsApp, there is no separate `/media` upload to obtain
   * an id first. The caller is responsible for passing a publicly-reachable URL.
   *
   * WHY `is_reusable` defaults to `false`: these are one-shot sends. Setting
   * `is_reusable: true` would make Meta mint a persistent reusable attachment id
   * (to be cached and re-sent later) — needless server-side state for a single
   * outbound message. Callers that genuinely want a reusable id opt in via
   * `opts.isReusable`.
   *
   * NOTE: this PRIVATE helper is distinct from the public {@link
   * MessengerClient.sendMedia} (the {@link ChannelAdapter} entry point). This one
   * builds the attachment body for a Messenger attachment `type`; the public one
   * routes a uniform {@link MediaSendInput} to the per-kind method.
   */
  private sendAttachment(
    recipientId: string,
    type: 'image' | 'audio' | 'video' | 'file',
    url: string,
    operation: string,
    opts?: MediaSendOptions
  ): Promise<SendResult> {
    const body = {
      recipient: { id: recipientId },
      messaging_type: 'RESPONSE',
      message: {
        attachment: {
          type,
          payload: { url, is_reusable: opts?.isReusable ?? false }
        }
      }
    };
    return this.post(body, operation).then((raw) => this.toSendResult(recipientId, raw));
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /* ChannelAdapter surface (uniform cross-channel signatures)                 */
  /* ──────────────────────────────────────────────────────────────────────── */

  /**
   * Adapter entry point for the typing indicator. Delegates to
   * {@link sendTypingOn}.
   *
   * WHY `messageId` is unused: WhatsApp's typing indicator is anchored to a
   * specific inbound `message_id`, so the uniform adapter signature carries
   * one. Messenger's `typing_on` is thread-scoped and takes no message id —
   * the param is accepted (for a channel-agnostic caller) and ignored.
   */
  async sendTypingIndicator(recipientId: string, _messageId?: string): Promise<void> {
    await this.sendTypingOn(recipientId);
  }

  /**
   * Adapter entry point for read receipts. Delegates to {@link markSeen}.
   *
   * WHY `messageId` is unused: WhatsApp marks a SPECIFIC message read by id,
   * so the uniform signature requires one. Messenger marks the whole thread
   * seen via a watermark (`mark_seen`), so the per-message id is irrelevant
   * here and is intentionally ignored.
   */
  async markRead(recipientId: string, _messageId: string): Promise<void> {
    await this.markSeen(recipientId);
  }

  /**
   * React (or unreact) to a user's message via the Send API `sender_action`.
   *
   * Meta's Send API DOES let a Page react to a user's message:
   * - React (non-empty `emoji`): `sender_action: 'react'` with the emoji nested
   *   INSIDE `payload` as `payload.reaction` (NOT a sibling of `payload`), keyed
   *   to the target `payload.message_id`.
   * - Unreact (empty-string `emoji`): `sender_action: 'unreact'` with a `payload`
   *   carrying only `message_id` (no `reaction` key) — this removes the Page's
   *   prior reaction. Passing `''` is the documented unreact path, mirroring the
   *   WhatsApp empty-emoji convention.
   *
   * `recipientId` IS used here — it is the user whose message is being reacted
   * to, supplied as `recipient.id`.
   *
   * WHY a standalone request (no `message` key): like `typing_on` / `mark_seen`,
   * a `sender_action` MUST NOT be combined with a `message` in one call — Meta
   * rejects a body that carries both.
   */
  async sendReaction(recipientId: string, messageId: string, emoji: string): Promise<void> {
    // Empty emoji = unreact (remove the Page's reaction); otherwise react.
    const body =
      emoji === ''
        ? {
            recipient: { id: recipientId },
            sender_action: 'unreact',
            payload: { message_id: messageId }
          }
        : {
            recipient: { id: recipientId },
            sender_action: 'react',
            // The emoji goes INSIDE `payload` as `reaction`, not as a sibling.
            payload: { message_id: messageId, reaction: emoji }
          };
    await this.post(body, 'messenger.sendReaction');
  }

  /**
   * Capability matrix for Messenger. Stage 7 flipped `media_send` on; the
   * profile surfaces (persistent menu / get started / ice breakers) are now on
   * too — they are CONFIGURED OUT-OF-BAND via the Messenger Profile API
   * ({@link import('./profile.js').MessengerProfileClient}, hitting
   * `{pageId}/messenger_profile`), NOT sent per message. `supports()` advertises
   * that these surfaces EXIST for the channel so the conversation agent can
   * include them in its capability set; the actual setup lives in the profile
   * client.
   */
  supports(feature: ChannelFeature): boolean {
    switch (feature) {
      case 'typing_indicator':
        return true;
      case 'read_receipt':
        return true;
      case 'reply_to':
        return true;
      case 'reaction':
        // Supported for SENDING via `sender_action: react/unreact` (see sendReaction).
        return true;
      case 'template':
        // `template` here is the WhatsApp template concept. Messenger's own
        // message templates are a different feature and out of Stage-4 scope.
        return false;
      case 'media_send':
        // Stage 7: image/audio/video/file via `message.attachment` (URL payload)
        // — see sendImage/sendAudio/sendVideo/sendFile.
        return true;
      case 'persistent_menu':
      case 'get_started':
      case 'ice_breakers':
        // Configured out-of-band via the Messenger Profile API (see
        // MessengerProfileClient), not per message. The channel supports them.
        return true;
      case 'story_reply':
        return false; // Instagram-only concept.
      default:
        return false;
    }
  }

  /**
   * Shared POST helper. All Messenger sends hit `{pageId}/messages` with the
   * Page access token. `idempotent` is deliberately LEFT UNSET so the
   * GraphClient does NOT retry a 5xx on these POSTs — re-sending after an
   * ambiguous server error could double-send a message (429 and pre-response
   * network failures are still retried, which is safe; see GraphClient's
   * retry decision matrix).
   */
  private post(body: unknown, operation: string): Promise<unknown> {
    return this.graph.request({
      method: 'POST',
      path: `${this.config.pageId}/messages`,
      body,
      accessToken: this.config.pageAccessToken,
      operation
    });
  }

  /** Parse a `{pageId}/messages` response into the cross-channel {@link SendResult}. */
  private toSendResult(recipientId: string, raw: unknown): SendResult {
    const response = raw as MessengerSendResponse;
    const messageId = response.message_id;
    if (messageId === undefined) {
      // A 2xx with no message id is unexpected — surface it loudly rather than
      // returning an empty/garbage id downstream (matches WhatsApp / Instagram).
      throw new Error(`Messenger send returned no message id: ${JSON.stringify(raw)}`);
    }
    return {
      channel: this.channel,
      messageId,
      // Prefer the recipient id echoed by Meta; fall back to what we sent.
      recipientId: response.recipient_id ?? recipientId,
      timestamp: Date.now(),
      raw
    };
  }
}
