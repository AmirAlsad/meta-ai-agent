/**
 * Turn an inbound Meta `MediaInfo` into model-ready content parts.
 *
 *   image     → fetched + attached as a multimodal image part
 *   audio     → fetched + transcribed via STT (src/stt) → transcript text
 *   document  → fetched + `pdf-parse` (PDFs) → extracted text; others described
 *   other     → a short textual description
 *
 * GRACEFUL BY DESIGN: any fetch/parse/transcribe error falls back to a textual
 * description and NEVER throws — a bad attachment must not sink the turn.
 *
 * WHY the WhatsApp id-only branch (Meta-specific): in the sendblue showcase
 * every inbound media arrived with a ready-to-fetch `media_url`. Meta differs by
 * channel — Messenger / Instagram attachments carry a pre-signed CDN `url`, but
 * WhatsApp media is `id`-based: you must call the Graph API WITH the WhatsApp
 * access token to resolve a short-lived (~5 min) download URL. This standalone
 * showcase bot does not hold that token (it is the transport package's job).
 *
 * SOURCE PREFERENCE (`dataUrl` over `url`): when the transport's OPT-IN inbound
 * media hydration is on (`INBOUND_MEDIA_DOWNLOAD=true`), it downloads the media
 * itself and attaches a base64 `data:` URL on `media.dataUrl`. We prefer that —
 * it needs no token and no second network hop, so a WhatsApp image becomes
 * processable here. We fall back to a pre-signed `media.url` (Messenger / IG, or
 * a deployment that hydrated url-side). Only when NEITHER is present (an id-only
 * WhatsApp block with hydration off) do we describe the media textually.
 * `fetchBytes` accepts both `data:` and `https:` sources (Node's fetch handles
 * the `data:` scheme), so the per-kind processors are source-agnostic.
 */
import type { TextPart, ImagePart } from 'ai';
import { log } from './logger.js';
import type { MediaInfo, MessageType } from './contract.js';
import { createSttProvider, type SttProvider } from './stt/index.js';

export type MediaContent = Array<TextPart | ImagePart>;

/** Broad media kind, used to route to the right per-kind processor. */
type MediaKind = 'image' | 'audio' | 'video' | 'document' | 'unknown';

export interface MediaProcessResult {
  content: MediaContent;
  transcription?: string;
}

let sttProvider: SttProvider | null | undefined;

function getSttProvider(): SttProvider | null {
  if (sttProvider === undefined) {
    sttProvider = createSttProvider();
    if (sttProvider) {
      log('info', `STT provider initialized: ${sttProvider.name}`);
    } else {
      log('warn', 'No STT provider configured (GROQ_API_KEY unset) — audio transcription disabled');
    }
  }
  return sttProvider;
}

/** Wrap a caption + a bracketed note into a single text part. */
function describe(caption: string, note: string): MediaProcessResult {
  return { content: [{ type: 'text', text: caption ? `${caption}\n\n${note}` : note }] };
}

export async function buildMediaContent(media: MediaInfo, messageType?: MessageType | string): Promise<MediaProcessResult> {
  const caption = (media.caption ?? '').trim();
  // Prefer the hydrated data URL (token-free, already downloaded) over a
  // pre-signed CDN url. Either one is a fetchable source for the per-kind
  // processors below.
  const source = media.dataUrl ?? media.url;
  // The MIME may live on the descriptor OR be encoded in the data URL prefix
  // (`data:<mime>;base64,...`). Prefer the descriptor; fall back to the data URL.
  // It can be EMPTY for a Messenger/IG attachment, whose parser sets `media.url`
  // and the message `type` but no precise MIME (see classifyKind below).
  let mimeType = media.mimeType ?? dataUrlMimeType(media.dataUrl) ?? '';

  // No fetchable source: an id-only WhatsApp block with hydration off — the bot
  // holds no WhatsApp token, so describe it textually instead of failing.
  // (Messenger/IG attachments carry `url`; hydration supplies `dataUrl`.)
  if (!source) {
    const kind = mimeType.split('/')[0] || 'file';
    return describe(
      caption,
      `[customer sent ${article(kind)} ${kind} — id only, not downloadable without the WhatsApp token. ` +
        'Acknowledge receipt and, if relevant, ask the customer to describe it or send text.]'
    );
  }

  // Classify the media KIND robustly, in priority order. The sendblue reference
  // could rely on an always-present `mediaType`; Meta's Messenger payload omits a
  // precise MIME, so we lead with the inbound message `type` (which the parser
  // DOES set, e.g. `type: 'image'`) and only sniff the HTTP content-type as a
  // last resort. The sniffed content-type also fills in a missing image MIME so
  // the AI SDK image part can be built.
  let kind = classifyKind(messageType, mimeType);
  if (kind === 'unknown') {
    const sniffed = await sniffContentType(source);
    if (sniffed) {
      mimeType = sniffed;
      kind = classifyKind(undefined, sniffed);
    }
  } else if (kind === 'image' && !mimeType) {
    // Known to be an image (from the message type) but no MIME yet — sniff so
    // processImage gets a concrete `image/*` to attach to the model.
    const sniffed = await sniffContentType(source);
    if (sniffed) mimeType = sniffed;
  }

  if (kind === 'image') return processImage(source, mimeType, caption);
  if (kind === 'document' && mimeType === 'application/pdf') return processPdf(source, caption);
  if (kind === 'audio') return processAudio(source, mimeType, caption);

  if (kind === 'video') {
    return describe(caption, '[Video received — video processing is not supported. Acknowledge receipt.]');
  }
  if (kind === 'document') {
    return describe(
      caption,
      `[Document received${mimeType ? ` (${mimeType})` : ''} — text extraction is not supported for this format. Acknowledge receipt.]`
    );
  }
  return describe(caption, `[Media received${mimeType ? ` (${mimeType})` : ''} — unsupported format. Acknowledge receipt.]`);
}

/**
 * Determine the broad media {@link MediaKind} from (in priority) the inbound
 * message `type` and the MIME prefix. Returns `'unknown'` when neither is
 * conclusive so the caller can sniff the HTTP content-type.
 */
function classifyKind(messageType: MessageType | string | undefined, mimeType: string): MediaKind {
  // 1. The inbound message `type` — set by the parser for Messenger/IG
  //    attachments even when no precise MIME is present.
  switch (messageType) {
    case 'image':
    case 'sticker':
      return 'image';
    case 'audio':
      return 'audio';
    case 'video':
      return 'video';
    case 'document':
      return 'document';
  }
  // 2/3. The MIME prefix (from the data URL or the descriptor).
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType === 'application/pdf' || mimeType.startsWith('application/') || mimeType.startsWith('text/')) {
    return 'document';
  }
  return 'unknown';
}

/**
 * Last-resort kind hint: fetch the source and read its HTTP `content-type`.
 * Best-effort — returns undefined on any failure so the caller falls back to a
 * textual description. A `data:` URL carries its MIME in the prefix, so this
 * only does a network call for `https:` sources.
 */
async function sniffContentType(source: string): Promise<string | undefined> {
  if (source.startsWith('data:')) return dataUrlMimeType(source);
  try {
    const response = await fetch(source);
    if (!response.ok) return undefined;
    const ct = response.headers.get('content-type');
    if (!ct) return undefined;
    // Strip any `; charset=...` parameter, lowercase for stable matching.
    return ct.split(';')[0]!.trim().toLowerCase() || undefined;
  } catch (err) {
    log('warn', `Failed to sniff content-type from ${sourceLabel(source)}: ${err}`);
    return undefined;
  }
}

async function processImage(url: string, mimeType: string, caption: string): Promise<MediaProcessResult> {
  // Only the AI SDK's documented image MIME types are guaranteed to round-trip to
  // provider APIs. Some clients deliver image/heic, which most providers reject —
  // fall back to text so the bot can at least acknowledge the image.
  const SUPPORTED = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
  if (!SUPPORTED.has(mimeType)) {
    return describe(
      caption,
      `[Image received (${mimeType}) — format not supported by the model. Acknowledge receipt and ask the customer to send a JPEG or PNG.]`
    );
  }
  try {
    const buffer = await fetchBytes(url);
    // Claude rejects an image whose base64 source exceeds ~5 MiB. base64 inflates
    // raw bytes ~33%, so a ~4 MB raw image (e.g. a large animated GIF) becomes a
    // ~5.8 MB source and the API errors out — failing the ENTIRE turn. Cap the RAW
    // image at ~3.75 MB (→ ~5 MB base64) and, beyond that, describe it textually
    // so the bot still responds. (A production bot would downscale here, e.g. with
    // `sharp`; this example degrades gracefully instead of adding a native dep.)
    const MAX_IMAGE_RAW_BYTES = 3_750_000;
    if (buffer.length > MAX_IMAGE_RAW_BYTES) {
      const mb = (buffer.length / 1_000_000).toFixed(1);
      return describe(
        caption,
        `[Image received (${mimeType}, ${mb} MB) — too large for me to view (limit ~3.7 MB). Acknowledge receipt and ask the customer to send a smaller version.]`
      );
    }
    const parts: MediaContent = [
      { type: 'image', image: buffer, mediaType: mimeType },
      { type: 'text', text: caption || '[Customer sent an image]' }
    ];
    return { content: parts };
  } catch (err) {
    log('warn', `Failed to fetch image from ${sourceLabel(url)}: ${err}`);
    return describe(caption, '[Image received but could not be loaded. Acknowledge receipt.]');
  }
}

async function processPdf(url: string, caption: string): Promise<MediaProcessResult> {
  let parser: { getText: () => Promise<unknown>; destroy?: () => Promise<void> } | undefined;
  try {
    const bytes = await fetchBytes(url);
    const buffer = Buffer.from(bytes);
    const { PDFParse } = await import('pdf-parse');
    parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    const text = (result as { text: string }).text.trim();
    if (text) {
      const preamble = caption ? `${caption}\n\n[PDF Document — extracted text below]\n` : '[PDF Document — extracted text below]\n';
      return { content: [{ type: 'text', text: `${preamble}${text}` }] };
    }
    return describe(caption, '[PDF received but no text could be extracted. Acknowledge receipt.]');
  } catch (err) {
    log('warn', `Failed to parse PDF from ${sourceLabel(url)}: ${err}`);
    return describe(caption, '[PDF received but could not be read. Acknowledge receipt.]');
  } finally {
    // pdf-parse v2: always destroy() after getText() to free the worker.
    if (parser?.destroy) {
      try {
        await parser.destroy();
      } catch {
        // best-effort cleanup
      }
    }
  }
}

async function processAudio(url: string, mimeType: string, caption: string): Promise<MediaProcessResult> {
  const provider = getSttProvider();
  if (!provider) {
    return describe(
      caption,
      '[Voice note received — no transcription provider configured. Acknowledge receipt and ask the customer to send a text message instead.]'
    );
  }
  try {
    const bytes = await fetchBytes(url);
    const buffer = Buffer.from(bytes);
    log('info', `Transcribing audio (${mimeType}, ${buffer.length} bytes) via ${provider.name}`);
    const result = await provider.transcribe(buffer, mimeType);
    if (!result.text.trim()) {
      return describe(caption, '[Voice note received but transcription returned empty text. Acknowledge receipt and ask the customer to try again.]');
    }
    log('info', `Transcription complete (${result.durationSeconds?.toFixed(1)}s, lang=${result.language})`);
    const label = caption ? `${caption}\n\n[Voice note transcript]: ${result.text}` : `[Voice note transcript]: ${result.text}`;
    return { content: [{ type: 'text', text: label }], transcription: result.text };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('warn', `Audio transcription failed: ${msg}`);
    return describe(caption, `[Voice note received but transcription failed. Acknowledge receipt of the voice note.]`);
  }
}

/**
 * Resolve a media SOURCE into a Uint8Array. A `data:` URL (from the transport's
 * hydration) is decoded LOCALLY — no network hop — straight from its base64
 * payload; an `https:` URL is fetched, throwing on a non-2xx so callers fall
 * back to text.
 */
async function fetchBytes(source: string): Promise<Uint8Array> {
  if (source.startsWith('data:')) {
    return decodeDataUrl(source);
  }
  const response = await fetch(source);
  if (!response.ok) {
    throw new Error(`fetch ${sourceLabel(source)} returned HTTP ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/** Decode the base64 payload of a `data:<mime>;base64,<...>` URL into bytes. */
function decodeDataUrl(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',');
  if (comma === -1) throw new Error('malformed data URL: no comma separator');
  const meta = dataUrl.slice(5, comma); // strip leading "data:"
  const payload = dataUrl.slice(comma + 1);
  if (!meta.includes('base64')) {
    throw new Error('unsupported data URL encoding (expected base64)');
  }
  return new Uint8Array(Buffer.from(payload, 'base64'));
}

/**
 * Short, log-safe label for a media source. A `data:` URL can be megabytes of
 * base64 — NEVER log the bytes; emit a marker (with MIME) instead.
 */
function sourceLabel(source: string): string {
  if (source.startsWith('data:')) {
    return `data URL (${dataUrlMimeType(source) ?? 'unknown mime'})`;
  }
  return source;
}

function article(noun: string): 'an' | 'a' {
  return /^[aeiou]/i.test(noun) ? 'an' : 'a';
}

/** Pull the MIME type out of a `data:<mime>;base64,...` URL, else undefined. */
function dataUrlMimeType(dataUrl: string | undefined): string | undefined {
  if (!dataUrl) return undefined;
  const match = /^data:([^;,]+)[;,]/.exec(dataUrl);
  return match ? match[1] : undefined;
}
