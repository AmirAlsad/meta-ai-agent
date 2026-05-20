/**
 * WhatsApp Cloud API outbound send client.
 *
 * Implements the shared {@link ChannelAdapter} so the conversation agent can
 * dispatch outbound WhatsApp messages without branching on the channel. All
 * sends go through the injected {@link GraphClient} (the shared transport that
 * owns retry/backoff and Bearer-header auth); this client owns only the
 * WhatsApp-specific request body shapes (`messaging_product`, message `type`,
 * the read/typing coupling, etc.).
 *
 * Endpoint for every method here is `POST {phoneNumberId}/messages` on
 * `graph.facebook.com` (the default host). The access token is supplied per
 * request from {@link WhatsAppConfig.accessToken} and the transport puts it in
 * the `Authorization: Bearer` header — never the URL.
 *
 * DOUBLE-SEND SAFETY: every send is a POST and we deliberately leave
 * `idempotent` unset on `this.graph.request(...)`. The transport then does NOT
 * retry a 5xx for these POSTs, because a 5xx after a send is ambiguous — Meta
 * may have already accepted and delivered the message before the error
 * surfaced, so a retry could double-send. (429 / pre-response network failures
 * are still retried by the transport; those never reached Meta.)
 *
 * Reference: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
 */

import type pino from 'pino';
import type { WhatsAppConfig } from '../../config/loader.js';
import type { GraphClient } from '../shared/graph-client.js';
import type { ChannelAdapter, ChannelFeature, SendOptions, SendResult } from '../shared/adapter.js';

// `TemplateComponent` / `TemplateParameter` were relocated to the shared
// transport-contract module (`../shared/adapter.js`) so type-only consumers
// (the chat contract, the delivery queue) can reference them without importing
// this concrete client. Re-exported here so existing `whatsapp/client.js`
// importers keep working unchanged.
export type { TemplateComponent, TemplateParameter } from '../shared/adapter.js';
import type { TemplateComponent } from '../shared/adapter.js';

export interface WhatsAppClientDeps {
  /** WhatsApp credentials (phone number id + access token). */
  config: WhatsAppConfig;
  /** Shared Graph API transport — constructed once per process and injected. */
  graph: GraphClient;
  /** Optional structured logger. */
  logger?: Pick<pino.Logger, 'info' | 'warn' | 'debug'>;
}

/** Shape of the WhatsApp `/messages` success envelope we read the wamid from. */
interface WhatsAppSendResponse {
  messages?: Array<{ id?: string }>;
}

export class WhatsAppClient implements ChannelAdapter {
  readonly channel = 'whatsapp' as const;

  private readonly config: WhatsAppConfig;
  private readonly graph: GraphClient;
  private readonly logger?: Pick<pino.Logger, 'info' | 'warn' | 'debug'>;

  constructor(deps: WhatsAppClientDeps) {
    this.config = deps.config;
    this.graph = deps.graph;
    if (deps.logger) this.logger = deps.logger;
  }

  /**
   * Send a plain-text message via `POST {phoneNumberId}/messages`.
   *
   * Sets `preview_url: false` so URLs in the body do NOT auto-expand into a
   * link preview (the agent controls link presentation explicitly). When
   * `opts.replyTo` is set we attach `context.message_id` so the message renders
   * as a threaded reply to that inbound wamid.
   */
  async sendText(to: string, text: string, opts?: SendOptions): Promise<SendResult> {
    const body: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body: text, preview_url: false }
    };
    // WhatsApp threads a reply by referencing the quoted message's wamid.
    if (opts?.replyTo !== undefined) {
      body['context'] = { message_id: opts.replyTo };
    }

    const raw = await this.send(body, 'whatsapp.sendText');
    return this.toSendResult(to, raw);
  }

  /**
   * Show a typing indicator to the user.
   *
   * WHY this requires the inbound message id and is COUPLED with marking the
   * message read: WhatsApp's Cloud API has no standalone "typing on" call like
   * Messenger's `sender_action`. The only documented way to surface a typing
   * bubble is to mark a specific inbound message as read AND attach a
   * `typing_indicator` to that same `status: "read"` request. The typing bubble
   * is therefore anchored to an inbound wamid — without one there is nothing to
   * mark read and no way to trigger typing. So `messageId` is REQUIRED here even
   * though the {@link ChannelAdapter} signature makes it optional (other
   * channels can type without a target). When it is absent we cannot make the
   * call: log a warn and return rather than sending a malformed request.
   */
  async sendTypingIndicator(to: string, messageId?: string): Promise<void> {
    if (messageId === undefined) {
      this.logger?.warn(
        { channel: this.channel, to },
        'whatsapp typing indicator skipped: requires an inbound message_id (typing is coupled with mark-read)'
      );
      return;
    }

    const body = {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
      typing_indicator: { type: 'text' }
    };
    await this.send(body, 'whatsapp.sendTypingIndicator');
  }

  /**
   * Mark an inbound message as read (blue ticks).
   *
   * WHY `to` is unused: on WhatsApp the inbound wamid (`messageId`) fully
   * identifies the conversation, so the recipient is implicit. We keep the
   * param only to satisfy the uniform {@link ChannelAdapter.markRead} signature
   * shared with Messenger / Instagram.
   */
  async markRead(to: string, messageId: string): Promise<void> {
    void to; // unused on WhatsApp — the wamid identifies the conversation.
    const body = {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId
    };
    await this.send(body, 'whatsapp.markRead');
  }

  /**
   * React to a previous message with an emoji.
   *
   * WHY an empty-string `emoji` is preserved verbatim: WhatsApp's documented
   * "unreact" mechanism is to send a reaction with `emoji: ""` — that REMOVES
   * the existing reaction. We deliberately do not coerce/skip an empty string,
   * so callers can remove a reaction by passing `''`.
   */
  async sendReaction(to: string, messageId: string, emoji: string): Promise<void> {
    const body = {
      messaging_product: 'whatsapp',
      to,
      type: 'reaction',
      reaction: { message_id: messageId, emoji }
    };
    await this.send(body, 'whatsapp.sendReaction');
  }

  /**
   * Send a pre-approved message template — the only way to message a user
   * OUTSIDE the 24-hour customer-service window.
   *
   * `components` (header / body / button substitutions) is forwarded verbatim
   * when supplied and omitted entirely otherwise (templates with no variables
   * take no components).
   */
  async sendTemplate(
    to: string,
    templateName: string,
    languageCode: string,
    components?: TemplateComponent[]
  ): Promise<SendResult> {
    const template: Record<string, unknown> = {
      name: templateName,
      language: { code: languageCode }
    };
    if (components !== undefined) {
      template['components'] = components;
    }

    const body = {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template
    };

    const raw = await this.send(body, 'whatsapp.sendTemplate');
    return this.toSendResult(to, raw);
  }

  /**
   * Capability matrix advertised to the conversation agent. Returns `true`
   * ONLY for features actually wired at Stage 4.
   */
  supports(feature: ChannelFeature): boolean {
    switch (feature) {
      case 'typing_indicator':
      case 'read_receipt':
      case 'reaction':
      case 'reply_to':
      case 'template':
        return true;
      // media_send lands in Stage 7 (media upload + send) — a later stage flips
      // this to true once `sendImage`/`sendDocument`/etc. exist on this client.
      case 'media_send':
        return false;
      // Messenger/Instagram-only profile surfaces — not applicable to WhatsApp.
      case 'persistent_menu':
      case 'get_started':
      case 'ice_breakers':
      case 'story_reply':
        return false;
      default:
        return false;
    }
  }

  /**
   * Shared POST to `{phoneNumberId}/messages`. `idempotent` is intentionally
   * left unset (see the double-send note in the class doc) so a 5xx is not
   * retried for these sends.
   */
  private async send(body: unknown, operation: string): Promise<WhatsAppSendResponse> {
    return this.graph.request<WhatsAppSendResponse>({
      method: 'POST',
      path: `${this.config.phoneNumberId}/messages`,
      body,
      accessToken: this.config.accessToken,
      operation
    });
  }

  /** Parse a `/messages` response into the cross-channel {@link SendResult}. */
  private toSendResult(to: string, raw: WhatsAppSendResponse): SendResult {
    const messageId = raw.messages?.[0]?.id;
    if (messageId === undefined) {
      // A 2xx with no wamid is unexpected — surface it loudly rather than
      // returning an empty/garbage id downstream.
      throw new Error(
        `WhatsApp send returned no message id: ${JSON.stringify(raw)}`
      );
    }
    return {
      channel: this.channel,
      messageId,
      recipientId: to,
      timestamp: Date.now(),
      raw
    };
  }
}
