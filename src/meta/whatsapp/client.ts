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
import type {
  ChannelAdapter,
  ChannelFeature,
  MediaSendInput,
  SendOptions,
  SendResult
} from '../shared/adapter.js';
import { uploadWhatsAppMedia } from '../shared/media.js';

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
  /**
   * Graph API version (e.g. `config.meta.graphApiVersion`, `'v25.0'`). Needed
   * ONLY by {@link WhatsAppClient.uploadMedia}, which calls the shared
   * {@link uploadWhatsAppMedia} (a multipart `fetch` that builds its own
   * versioned URL outside the {@link GraphClient}, whose `apiVersion` is
   * private). Optional so existing call sites that never upload keep working;
   * `uploadMedia` throws a clear error if it is invoked without this set.
   */
  apiVersion?: string;
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
  private readonly apiVersion?: string;
  private readonly logger?: Pick<pino.Logger, 'info' | 'warn' | 'debug'>;

  constructor(deps: WhatsAppClientDeps) {
    this.config = deps.config;
    this.graph = deps.graph;
    if (deps.apiVersion !== undefined) this.apiVersion = deps.apiVersion;
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
   * Send an image by media id or public URL, with an optional caption.
   *
   * `mediaIdOrUrl` is resolved by {@link mediaRef} — an `http(s)://` URL becomes
   * `{ link }` and anything else is treated as a pre-uploaded `{ id }`. The
   * caption key is omitted entirely when undefined (sending `caption: undefined`
   * would serialize the key away anyway, but we keep the body minimal/explicit).
   */
  async sendImage(to: string, mediaIdOrUrl: string, caption?: string): Promise<SendResult> {
    const image: Record<string, unknown> = { ...this.mediaRef(mediaIdOrUrl) };
    if (caption !== undefined) image['caption'] = caption;

    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'image',
      image
    };
    const raw = await this.send(body, 'whatsapp.sendImage');
    return this.toSendResult(to, raw);
  }

  /**
   * Send an audio clip by media id or public URL.
   *
   * WHY there is no `caption` parameter: WhatsApp's `audio` message object does
   * NOT support a caption field (unlike image / video / document). Including one
   * is rejected by the API, so this method deliberately omits it.
   */
  async sendAudio(to: string, mediaIdOrUrl: string): Promise<SendResult> {
    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'audio',
      audio: { ...this.mediaRef(mediaIdOrUrl) }
    };
    const raw = await this.send(body, 'whatsapp.sendAudio');
    return this.toSendResult(to, raw);
  }

  /** Send a video by media id or public URL, with an optional caption. */
  async sendVideo(to: string, mediaIdOrUrl: string, caption?: string): Promise<SendResult> {
    const video: Record<string, unknown> = { ...this.mediaRef(mediaIdOrUrl) };
    if (caption !== undefined) video['caption'] = caption;

    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'video',
      video
    };
    const raw = await this.send(body, 'whatsapp.sendVideo');
    return this.toSendResult(to, raw);
  }

  /**
   * Send a document by media id or public URL. `filename` sets the name the
   * recipient sees; `caption` is optional.
   */
  async sendDocument(
    to: string,
    mediaIdOrUrl: string,
    filename: string,
    caption?: string
  ): Promise<SendResult> {
    const document: Record<string, unknown> = { ...this.mediaRef(mediaIdOrUrl), filename };
    if (caption !== undefined) document['caption'] = caption;

    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'document',
      document
    };
    const raw = await this.send(body, 'whatsapp.sendDocument');
    return this.toSendResult(to, raw);
  }

  /**
   * {@link ChannelAdapter.sendMedia} — route a uniform media payload to the
   * typed per-kind method above based on `input.kind`. The agent uses this so it
   * can dispatch a media item without branching on channel or kind.
   *
   * WHY the document `filename` fallback: WhatsApp's document message REQUIRES a
   * `filename` (it is the name the recipient sees). The uniform input makes it
   * optional, so when absent we derive one from the URL's basename (e.g.
   * `https://cdn/x/report.pdf` → `report.pdf`), falling back to `'file'` for a
   * bare media_id or an unparseable URL. (`sendAudio` takes no caption — the
   * caption is intentionally dropped for audio, matching WhatsApp's API.)
   */
  async sendMedia(to: string, input: MediaSendInput): Promise<SendResult> {
    switch (input.kind) {
      case 'image':
        return this.sendImage(to, input.mediaIdOrUrl, input.caption);
      case 'audio':
        // WhatsApp audio has no caption field — drop it (see sendAudio).
        return this.sendAudio(to, input.mediaIdOrUrl);
      case 'video':
        return this.sendVideo(to, input.mediaIdOrUrl, input.caption);
      case 'document':
        return this.sendDocument(
          to,
          input.mediaIdOrUrl,
          input.filename ?? deriveFilename(input.mediaIdOrUrl),
          input.caption
        );
    }
  }

  /**
   * Upload media bytes and return the reusable `media_id` (convenience wrapper
   * over the shared {@link uploadWhatsAppMedia}). Pass the returned id to any of
   * the `send*` methods above.
   *
   * WHY it needs `apiVersion` injected separately: the upload is a multipart
   * `fetch` that constructs its OWN versioned URL (the shared {@link GraphClient}
   * is JSON-only and its `apiVersion` is private), so the version cannot be read
   * off `this.graph`. It is supplied via {@link WhatsAppClientDeps.apiVersion}
   * at construction; if absent we throw rather than guess a version.
   */
  async uploadMedia(
    data: Uint8Array | Buffer | Blob,
    mimeType: string,
    filename?: string
  ): Promise<string> {
    if (this.apiVersion === undefined) {
      throw new Error(
        'WhatsAppClient.uploadMedia requires `apiVersion` to be set on WhatsAppClientDeps (pass config.meta.graphApiVersion).'
      );
    }
    return uploadWhatsAppMedia({
      phoneNumberId: this.config.phoneNumberId,
      accessToken: this.config.accessToken,
      apiVersion: this.apiVersion,
      data,
      mimeType,
      ...(filename !== undefined ? { filename } : {})
    });
  }

  /**
   * Resolve a media reference for an outbound media message.
   *
   * WHY the regex test: WhatsApp accepts EITHER a previously-uploaded `media_id`
   * (`{ id }`) OR a publicly reachable `{ link }` it fetches itself. We treat
   * any value matching `http(s)://` as a public URL and everything else as a
   * media id — so callers can pass whichever they have without a separate flag.
   */
  private mediaRef(mediaIdOrUrl: string): { id: string } | { link: string } {
    return /^https?:\/\//i.test(mediaIdOrUrl) ? { link: mediaIdOrUrl } : { id: mediaIdOrUrl };
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
      // media_send is wired (Stage 7): `sendImage`/`sendAudio`/`sendVideo`/
      // `sendDocument` exist on this client (plus the `uploadMedia` convenience).
      case 'media_send':
        return true;
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

/**
 * Derive a document filename from a media reference for {@link
 * WhatsAppClient.sendMedia} when the caller supplied none. Returns the last
 * non-empty path segment of an `http(s)://` URL (query/hash stripped, URL-decoded),
 * else `'file'` (a bare media_id, an opaque URL, or any parse failure). Never
 * throws — WhatsApp requires SOME filename, so a sensible default beats erroring.
 */
function deriveFilename(mediaIdOrUrl: string): string {
  if (!/^https?:\/\//i.test(mediaIdOrUrl)) return 'file';
  try {
    const { pathname } = new URL(mediaIdOrUrl);
    const segments = pathname.split('/').filter(seg => seg.length > 0);
    const last = segments[segments.length - 1];
    if (last === undefined) return 'file';
    const decoded = decodeURIComponent(last);
    return decoded.length > 0 ? decoded : 'file';
  } catch {
    return 'file';
  }
}
