/**
 * Inbound media hydration — the transport-side bridge that lets the chat
 * endpoint "see" inbound media it could not fetch itself.
 *
 * WHY this exists: a WhatsApp inbound image arrives as a bare `media.id` with no
 * fetchable URL — downloading it needs a 2-hop AUTHENTICATED Graph call with the
 * WhatsApp access token. The chat endpoint holds no token, so it cannot do this.
 * The transport DOES hold the token, so it downloads the media here, on the
 * inbound→chat path, and attaches the bytes as a base64 `data:` URL on the
 * message's {@link MediaInfo.dataUrl}. The endpoint then hands that straight to
 * an LLM with no token and no second fetch.
 *
 * OPT-IN + base64 cost: base64 inflates the request body by ~33% over the raw
 * bytes, so this is constructed (as {@link HttpMediaHydrator}) only when
 * `config.conversation.inboundMediaDownload` is true; otherwise the agent gets no
 * hydrator (or a {@link NoopMediaHydrator}) and behaves exactly as before.
 *
 * FAIL-OPEN: {@link InboundMediaHydrator.hydrate} NEVER throws. Any download
 * failure, timeout, or over-cap result returns `undefined` — the agent stays
 * fail-soft and the turn proceeds with the raw id/url, never blocked or dropped.
 *
 * NEVER log the media bytes or the access token from this module.
 */

import type pino from 'pino';
import type { GraphClient } from './graph-client.js';
import type { IncomingMessage } from '../types.js';
import {
  downloadAttachmentUrl,
  downloadWhatsAppMedia,
  getWhatsAppMediaUrl,
  MEDIA_OVER_CAP,
  type DownloadedMedia
} from './media.js';

/** Default ceiling for the whole hydrate operation (URL-resolve + binary GET). */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Fallback MIME when neither the download nor the inbound metadata supplies one. */
const FALLBACK_MIME_TYPE = 'application/octet-stream';

export interface InboundMediaHydrator {
  /** Best-effort: return a data URL for a message's media, or undefined. NEVER throws. */
  hydrate(message: IncomingMessage): Promise<string | undefined>;
}

export interface HttpMediaHydratorDeps {
  graph: GraphClient;
  /** WhatsApp access token (`config.whatsapp?.accessToken`). Absent ⇒ WhatsApp media not hydratable. */
  whatsAppAccessToken?: string;
  /** Hard cap (bytes) on a single attachment to hydrate; over-cap ⇒ undefined. */
  maxBytes: number;
  /** Whole-operation timeout (default ~10s). */
  timeoutMs?: number;
  /** Injectable fetch (defaults to `globalThis.fetch`) — overridden in tests. */
  fetchImpl?: typeof fetch;
  logger?: Pick<pino.Logger, 'warn' | 'debug'>;
}

/**
 * Downloads inbound media via the Stage 7 media utilities and returns it as a
 * base64 `data:` URL. Per-channel behavior mirrors the auth model in `media.ts`:
 * WhatsApp goes through the authenticated 2-hop download; Messenger / Instagram
 * fetch their pre-signed CDN URL token-free.
 */
export class HttpMediaHydrator implements InboundMediaHydrator {
  private readonly graph: GraphClient;
  private readonly whatsAppAccessToken?: string;
  private readonly maxBytes: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly logger?: Pick<pino.Logger, 'warn' | 'debug'>;

  constructor(deps: HttpMediaHydratorDeps) {
    this.graph = deps.graph;
    if (deps.whatsAppAccessToken !== undefined) this.whatsAppAccessToken = deps.whatsAppAccessToken;
    this.maxBytes = deps.maxBytes;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // Bind to globalThis so the default fetch keeps its correct `this`.
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
    if (deps.logger) this.logger = deps.logger;
  }

  async hydrate(message: IncomingMessage): Promise<string | undefined> {
    const media = message.media;
    if (!media) return undefined;
    // Idempotent: a reprocessed turn re-runs hydration on the same message
    // objects (the interrupt/rebatch flow). Return the existing data URL rather
    // than re-downloading.
    if (media.dataUrl !== undefined) return media.dataUrl;

    try {
      // Bound the WHOLE operation (URL-resolve + binary GET) with one timeout.
      // We race a timeout against the download rather than threading an
      // AbortController through the (token-careful) media.ts fetches — fail-open
      // means a hung download is simply abandoned and reported as undefined.
      return await this.withTimeout(this.download(message), message.channel);
    } catch (err) {
      // FAIL-OPEN: any failure (download error, over-cap throw, timeout) drops
      // hydration for this message. The turn proceeds with the raw id/url.
      this.logger?.warn(
        { channel: message.channel, err: errSummary(err) },
        'inbound media hydration failed; proceeding without data URL'
      );
      return undefined;
    }
  }

  /** Per-channel download → size-check → data URL. Throws on any failure (caught by hydrate). */
  private async download(message: IncomingMessage): Promise<string | undefined> {
    const media = message.media!;

    let downloaded: DownloadedMedia;
    if (message.channel === 'whatsapp' && media.id !== undefined && media.url === undefined) {
      if (this.whatsAppAccessToken === undefined) {
        // No token ⇒ cannot do the authenticated 2-hop WhatsApp download.
        this.logger?.debug(
          { channel: message.channel },
          'inbound WhatsApp media not hydrated: no WhatsApp access token configured'
        );
        return undefined;
      }
      // Pre-flight the size cap from the media metadata BEFORE pulling bytes:
      // WhatsApp's `GET /{mediaId}` reports `file_size`, so an over-cap blob is
      // skipped without ever downloading the (potentially large) binary. The
      // cost is one extra cheap JSON GET on the UNDER-cap path —
      // `downloadWhatsAppMedia` re-resolves the URL internally — which we accept
      // to reuse its token-leak-on-redirect safety rather than reimplementing the
      // authenticated binary hop here. The OVER-cap path does just this one GET.
      const meta = await getWhatsAppMediaUrl({
        mediaId: media.id,
        accessToken: this.whatsAppAccessToken,
        graph: this.graph
      });
      if (this.overCap(meta.fileSizeBytes)) {
        this.logCapSkip(message.channel, meta.fileSizeBytes);
        return undefined;
      }
      downloaded = await downloadWhatsAppMedia({
        mediaId: media.id,
        accessToken: this.whatsAppAccessToken,
        graph: this.graph,
        fetchImpl: this.fetchImpl
      });
    } else if (media.url !== undefined) {
      // Messenger / Instagram (and any channel that already carries a fetchable
      // URL): download the pre-signed CDN URL token-free. Pass `maxBytes` so the
      // download EARLY-rejects (via Content-Length) before buffering an over-cap
      // body — mirroring WhatsApp's `file_size` pre-flight. Header-absent falls
      // back to the post-download check below.
      const result = await downloadAttachmentUrl({
        url: media.url,
        fetchImpl: this.fetchImpl,
        maxBytes: this.maxBytes
      });
      if (result === MEDIA_OVER_CAP) {
        // The Content-Length pre-flight already rejected this attachment without
        // buffering the body — log + skip exactly like the post-download cap path.
        this.logCapSkip(message.channel, undefined);
        return undefined;
      }
      downloaded = result;
    } else {
      // Nothing fetchable (e.g. WhatsApp media with neither id nor url).
      return undefined;
    }

    // Post-download cap check covers channels whose Content-Length was absent at
    // pre-flight (Messenger/IG) or where the metadata under-reported the size.
    if (this.overCap(downloaded.data.byteLength)) {
      this.logCapSkip(message.channel, downloaded.data.byteLength);
      return undefined;
    }

    const mimeType = downloaded.mimeType ?? media.mimeType ?? FALLBACK_MIME_TYPE;
    const base64 = Buffer.from(downloaded.data).toString('base64');
    return `data:${mimeType};base64,${base64}`;
  }

  /** True when a known byte count exceeds the configured cap. Unknown size ⇒ not over (checked post-download). */
  private overCap(byteCount: number | undefined): boolean {
    return byteCount !== undefined && byteCount > this.maxBytes;
  }

  private logCapSkip(channel: string, byteCount: number | undefined): void {
    this.logger?.warn(
      { channel, byteCount, maxBytes: this.maxBytes },
      'inbound media over size cap; not hydrated'
    );
  }

  /** Race a promise against the operation timeout (fail-open: timeout ⇒ reject ⇒ undefined). */
  private withTimeout<T>(promise: Promise<T>, channel: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`inbound media hydration timed out after ${this.timeoutMs}ms (${channel})`)),
        this.timeoutMs
      );
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }
}

/**
 * No-op hydrator: always returns `undefined`. Handy as an explicit "hydration
 * disabled" wiring — equivalent to passing no hydrator at all.
 */
export class NoopMediaHydrator implements InboundMediaHydrator {
  // Accepts the message to satisfy the interface, but ignores it — always undefined.
  async hydrate(_message: IncomingMessage): Promise<string | undefined> {
    return undefined;
  }
}

/** Compact, token/byte-free error summary for logs. */
function errSummary(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
