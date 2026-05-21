/**
 * Shared media subsystem for the per-channel send/receive clients.
 *
 * Three concerns live here, deliberately transport-adjacent and free of any
 * channel-specific message shapes:
 *
 *   1. {@link inferMediaKind} — pure MIME → send-kind mapping. The per-channel
 *      clients use it to decide whether an outbound media payload is an
 *      `image` / `audio` / `video` / `document` without re-implementing the
 *      same `startsWith('image/')` ladder three times.
 *   2. WhatsApp media UPLOAD ({@link uploadWhatsAppMedia}) — `POST
 *      /{phoneNumberId}/media` returns a reusable `media_id`. WhatsApp send can
 *      reference that id OR a public URL; uploading first is the way to attach
 *      bytes you generated locally.
 *   3. Media DOWNLOAD — the auth model differs by channel and that difference is
 *      the whole reason these are separate functions:
 *        - WhatsApp ({@link downloadWhatsAppMedia}): two hops. First resolve a
 *          short-lived CDN URL via the Graph API, THEN fetch that URL **with**
 *          the `Authorization: Bearer` token. WhatsApp's media CDN rejects an
 *          unauthenticated GET — the token is REQUIRED on the binary hop.
 *        - Messenger / Instagram ({@link downloadAttachmentUrl}): the webhook
 *          payload already carries a pre-signed CDN URL. Those URLs must NOT get
 *          the app token — they are already signed, and attaching a Bearer can
 *          be rejected or, worse, leak the token to a CDN origin we don't own.
 *
 * The JSON metadata hop reuses {@link GraphClient} (retry/backoff, redacted
 * logging). The multipart upload and the raw binary GETs use `fetch` directly:
 * `GraphClient.request` is JSON-only (it `JSON.stringify`s the body and
 * `response.text()`s the result), neither of which fits multipart bodies or
 * binary responses.
 *
 * NEVER log the access token or raw media bytes from this module.
 */

import type { GraphClient } from './graph-client.js';
import { MetaApiError } from './errors.js';

/** Coarse send-kind every channel understands for outbound media. */
export type MediaKind = 'image' | 'audio' | 'video' | 'document';

/**
 * Stable User-Agent for the raw binary media GETs.
 *
 * WHY: Meta's media CDN (`lookaside.fbsbx.com` and friends) frequently rejects
 * requests with no User-Agent, or a default `node` / `curl`-style one. Sending a
 * benign, stable UA avoids those spurious rejections on the download hop. Kept as
 * a constant so the string never drifts between the two download sites.
 */
const MEDIA_DOWNLOAD_USER_AGENT = 'meta-ai-agent/0.1';

/**
 * Infer the send-kind from a MIME type. `image/*` → `image`, `audio/*` →
 * `audio`, `video/*` → `video`, and everything else (including `undefined` and
 * `text/*`, `application/*`, etc.) → `document`.
 *
 * Pure: no I/O, no throwing. Matching is case-insensitive on the top-level type
 * since MIME types are case-insensitive per RFC 2045.
 */
export function inferMediaKind(mimeType?: string): MediaKind {
  if (mimeType === undefined) return 'document';
  const top = mimeType.toLowerCase().trim();
  if (top.startsWith('image/')) return 'image';
  if (top.startsWith('audio/')) return 'audio';
  if (top.startsWith('video/')) return 'video';
  // Documents are the catch-all: application/pdf, text/plain, octet-stream, …
  return 'document';
}

/* ────────────────────────────────────────────────────────────────────────── */
/* WhatsApp upload                                                             */
/* ────────────────────────────────────────────────────────────────────────── */

export interface UploadWhatsAppMediaInput {
  phoneNumberId: string;
  accessToken: string;
  /** Graph API version, e.g. `config.meta.graphApiVersion` (`'v25.0'`). */
  apiVersion: string;
  data: Uint8Array | Buffer | Blob;
  mimeType: string;
  /** Optional user-facing filename; WhatsApp uses it for the upload part name. */
  filename?: string;
  /** Injectable fetch (defaults to `globalThis.fetch`) — overridden in tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Upload media bytes to WhatsApp: `POST /{phoneNumberId}/media` as
 * `multipart/form-data` with `messaging_product=whatsapp`, `type=<mimeType>`,
 * and the bytes in the `file` part. Returns the reusable `media_id`.
 *
 * Uses raw `fetch` (not {@link GraphClient}) because the body is multipart.
 * Crucially we do NOT set `Content-Type` ourselves — letting `fetch` serialize
 * the `FormData` is the only way to get the correct `multipart/form-data;
 * boundary=…` header; a hand-set Content-Type omits the boundary and the server
 * rejects the body.
 */
export async function uploadWhatsAppMedia(input: UploadWhatsAppMediaInput): Promise<string> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  // Build the versioned URL directly — there is no GraphClient instance here and
  // the token rides in the Authorization header, never the URL.
  const url = `https://graph.facebook.com/${input.apiVersion}/${input.phoneNumberId}/media`;

  // Normalize the bytes into a Blob so FormData carries the correct part type.
  // A Blob passes straight through; Uint8Array/Buffer are wrapped with the MIME.
  const fileBlob =
    input.data instanceof Blob ? input.data : new Blob([input.data], { type: input.mimeType });

  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', input.mimeType);
  // Provide a filename so the multipart part has one (some servers require it).
  form.append('file', fileBlob, input.filename ?? 'file');

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      // Only the Authorization header — do NOT set Content-Type; fetch adds the
      // multipart boundary itself.
      headers: { authorization: `Bearer ${input.accessToken}` },
      body: form
    });
  } catch (err) {
    // Transport failure before any response → httpStatus 0 + cause.
    const causeMessage = err instanceof Error ? err.message : String(err);
    throw new MetaApiError({
      operation: 'whatsapp.uploadMedia',
      httpStatus: 0,
      responseBody: causeMessage,
      message: `Meta Graph API whatsapp.uploadMedia failed before response: ${causeMessage}`,
      cause: err
    });
  }

  const rawText = await response.text();
  const parsed = tryParseJson(rawText);

  if (!response.ok) {
    throw buildHttpError('whatsapp.uploadMedia', response.status, parsed, rawText);
  }

  const id = extractStringField(parsed, 'id');
  if (id === undefined) {
    // 2xx but no id is a contract violation — surface it rather than returning ''.
    throw new MetaApiError({
      operation: 'whatsapp.uploadMedia',
      httpStatus: response.status,
      responseBody: parsed ?? rawText,
      message: 'Meta Graph API whatsapp.uploadMedia succeeded but returned no media id'
    });
  }
  return id;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* WhatsApp media-URL resolution                                              */
/* ────────────────────────────────────────────────────────────────────────── */

export interface WhatsAppMediaUrlInfo {
  /** Short-lived, authenticated CDN URL for the media bytes. */
  url: string;
  mimeType?: string;
  fileSizeBytes?: number;
  sha256?: string;
}

/**
 * Resolve a WhatsApp media id to its (short-lived) download URL and metadata:
 * `GET /{mediaId}`. JSON response, so this goes through {@link GraphClient}
 * (retry/backoff, redacted logging). Maps Meta's snake_case (`mime_type`,
 * `file_size`) to our camelCase shape.
 */
export async function getWhatsAppMediaUrl(input: {
  mediaId: string;
  accessToken: string;
  graph: GraphClient;
}): Promise<WhatsAppMediaUrlInfo> {
  const meta = await input.graph.request<{
    url: string;
    mime_type?: string;
    file_size?: number;
    sha256?: string;
  }>({
    method: 'GET',
    path: input.mediaId,
    accessToken: input.accessToken,
    operation: 'whatsapp.getMediaUrl'
  });

  const info: WhatsAppMediaUrlInfo = { url: meta.url };
  if (meta.mime_type !== undefined) info.mimeType = meta.mime_type;
  if (meta.file_size !== undefined) info.fileSizeBytes = meta.file_size;
  if (meta.sha256 !== undefined) info.sha256 = meta.sha256;
  return info;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Download                                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

export interface DownloadedMedia {
  data: Uint8Array;
  mimeType?: string;
  contentLength?: number;
}

/**
 * Two-step WhatsApp download: resolve the media URL via
 * {@link getWhatsAppMediaUrl}, then fetch the bytes from that URL.
 *
 * WHY the Bearer token on the binary GET: WhatsApp's media CDN URLs are NOT
 * pre-signed — an unauthenticated GET returns 401. The same access token that
 * resolved the URL MUST be re-sent as `Authorization: Bearer` on the binary
 * hop. (Contrast with {@link downloadAttachmentUrl} for FB/IG, which must NOT
 * carry the token.)
 */
export async function downloadWhatsAppMedia(input: {
  mediaId: string;
  accessToken: string;
  graph: GraphClient;
  fetchImpl?: typeof fetch;
}): Promise<DownloadedMedia> {
  // Step 1 — resolve URL + metadata (throws MetaApiError 'whatsapp.getMediaUrl'
  // on failure; we let that propagate so the operation label is accurate).
  const meta = await getWhatsAppMediaUrl({
    mediaId: input.mediaId,
    accessToken: input.accessToken,
    graph: input.graph
  });

  // Step 2 — fetch the bytes from the resolved URL. Delegated to
  // {@link downloadWhatsAppMediaFromUrl} so a caller that ALREADY resolved the
  // metadata (e.g. the media hydrator's `file_size` pre-flight) can skip the
  // redundant `GET /{mediaId}` and download straight from `meta.url`.
  return downloadWhatsAppMediaFromUrl({
    url: meta.url,
    accessToken: input.accessToken,
    ...(meta.mimeType !== undefined ? { mimeType: meta.mimeType } : {}),
    ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {})
  });
}

/**
 * Fetch WhatsApp media bytes from an ALREADY-RESOLVED CDN URL (the second hop of
 * the two-step download). Carries the auth/redirect safety of
 * {@link downloadWhatsAppMedia} but skips the `GET /{mediaId}` metadata resolve,
 * so a caller that already has the metadata (e.g. the inbound media hydrator,
 * which resolves it once for its `file_size` pre-flight) does NOT pay for a
 * second authenticated Graph round-trip per attachment.
 *
 * The optional `mimeType` is the authoritative metadata MIME from
 * {@link getWhatsAppMediaUrl}; when present it is preferred over the binary
 * response's Content-Type (mirroring {@link downloadWhatsAppMedia}).
 */
export async function downloadWhatsAppMediaFromUrl(input: {
  url: string;
  accessToken: string;
  mimeType?: string;
  fetchImpl?: typeof fetch;
}): Promise<DownloadedMedia> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const meta = { url: input.url, mimeType: input.mimeType };

  // Fetch the actual bytes WITH the token (required by WhatsApp's CDN).
  //
  // WHY a User-Agent header: the lookaside CDN can reject requests bearing a
  // default `node`/`curl` (or absent) UA — see MEDIA_DOWNLOAD_USER_AGENT.
  //
  // TOKEN-LEAK-ON-REDIRECT: the URL `getWhatsAppMediaUrl` resolved is the
  // terminal lookaside URL; we do NOT expect a 3xx here. We use
  // `redirect: 'manual'` so the Bearer token is NEVER auto-forwarded across a
  // redirect — rather than relying on undici's (non-standard, version-dependent)
  // cross-origin `Authorization`-strip behavior. If the CDN ever does redirect,
  // we follow the Location ONCE WITHOUT the token (the target is a pre-signed URL
  // that doesn't need it), fully closing the leak.
  let response: Response;
  try {
    response = await fetchImpl(meta.url, {
      redirect: 'manual',
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        'user-agent': MEDIA_DOWNLOAD_USER_AGENT
      }
    });
  } catch (err) {
    const causeMessage = err instanceof Error ? err.message : String(err);
    throw new MetaApiError({
      operation: 'whatsapp.downloadMedia',
      httpStatus: 0,
      responseBody: causeMessage,
      message: `Meta Graph API whatsapp.downloadMedia failed before response: ${causeMessage}`,
      cause: err
    });
  }

  // Manual-redirect safety: follow at most one hop, and WITHOUT the Authorization
  // header, so the access token is never sent to a redirect target.
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    if (!location) {
      throw new MetaApiError({
        operation: 'whatsapp.downloadMedia',
        httpStatus: response.status,
        responseBody: 'redirect response without a Location header',
        message: 'Meta Graph API whatsapp.downloadMedia got a redirect with no Location header'
      });
    }
    try {
      response = await fetchImpl(location, {
        redirect: 'manual',
        headers: { 'user-agent': MEDIA_DOWNLOAD_USER_AGENT }
      });
    } catch (err) {
      const causeMessage = err instanceof Error ? err.message : String(err);
      throw new MetaApiError({
        operation: 'whatsapp.downloadMedia',
        httpStatus: 0,
        responseBody: causeMessage,
        message: `Meta Graph API whatsapp.downloadMedia failed following media redirect: ${causeMessage}`,
        cause: err
      });
    }
  }

  if (!response.ok) {
    // Read the (likely small) error body as text for diagnostics; bytes here are
    // an error envelope, not media.
    const rawText = await safeText(response);
    throw buildHttpError('whatsapp.downloadMedia', response.status, tryParseJson(rawText), rawText);
  }

  const data = new Uint8Array(await response.arrayBuffer());
  // Prefer the metadata MIME (authoritative for WhatsApp), fall back to the
  // response Content-Type.
  return buildDownloadedMedia(data, response, meta.mimeType);
}

/**
 * Sentinel returned by {@link downloadAttachmentUrl} when an EARLY size-cap
 * pre-flight rejects the download: the response's `Content-Length` already
 * exceeded `maxBytes`, so we never read the body. Distinct from a thrown error so
 * the caller (the fail-open hydrator) can treat it as a clean over-cap skip.
 */
export const MEDIA_OVER_CAP = Symbol('media-over-cap');

/**
 * Download a Messenger / Instagram attachment from the pre-signed CDN URL Meta
 * put in the webhook payload.
 *
 * WHY no Authorization header: these URLs are already signed by Meta. Sending
 * the app token is unnecessary and can be actively harmful — the CDN may reject
 * a Bearer it didn't expect, and a redirect to a third-party origin would leak
 * the token cross-origin. So this GET carries NO auth.
 *
 * EARLY SIZE CAP (`maxBytes`): when supplied, the `Content-Length` response
 * header is checked BEFORE `response.arrayBuffer()` reads (and buffers) the body.
 * An over-cap attachment is rejected with the {@link MEDIA_OVER_CAP} sentinel
 * having read nothing — so a huge blob is no longer fully buffered just to be
 * discarded. This mirrors the WhatsApp path's `file_size` pre-flight intent.
 * FAIL-OPEN: when the header is ABSENT (or `maxBytes` is omitted) we fall back to
 * the body read and let the caller's post-download check enforce the cap, exactly
 * as before.
 */
export async function downloadAttachmentUrl(input: {
  url: string;
  fetchImpl?: typeof fetch;
  /** Optional hard byte cap, checked against `Content-Length` before reading the body. */
  maxBytes?: number;
}): Promise<DownloadedMedia | typeof MEDIA_OVER_CAP> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;

  let response: Response;
  try {
    // Deliberately NO Authorization header — see the WHY note above. We DO send
    // a benign User-Agent: Meta's CDN can reject a default `node`/`curl`/absent
    // UA (see MEDIA_DOWNLOAD_USER_AGENT). A UA is not auth, so this stays a
    // token-free GET against the pre-signed URL.
    response = await fetchImpl(input.url, {
      headers: { 'user-agent': MEDIA_DOWNLOAD_USER_AGENT }
    });
  } catch (err) {
    const causeMessage = err instanceof Error ? err.message : String(err);
    throw new MetaApiError({
      operation: 'media.downloadAttachment',
      httpStatus: 0,
      responseBody: causeMessage,
      message: `Meta Graph API media.downloadAttachment failed before response: ${causeMessage}`,
      cause: err
    });
  }

  if (!response.ok) {
    const rawText = await safeText(response);
    throw buildHttpError('media.downloadAttachment', response.status, tryParseJson(rawText), rawText);
  }

  // EARLY REJECT: when we both know a cap and the server told us the size up
  // front, bail BEFORE reading the body so an over-cap blob is never buffered.
  // Cancel the body to release the socket promptly (best-effort).
  if (input.maxBytes !== undefined) {
    const contentLength = parseContentLength(response.headers.get('content-length'));
    if (contentLength !== undefined && contentLength > input.maxBytes) {
      try {
        await response.body?.cancel();
      } catch {
        /* best-effort: cancelling the unread body must not throw. */
      }
      return MEDIA_OVER_CAP;
    }
  }

  const data = new Uint8Array(await response.arrayBuffer());
  return buildDownloadedMedia(data, response, undefined);
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Internal helpers                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

/** Assemble a {@link DownloadedMedia}, deriving MIME / length from the response. */
function buildDownloadedMedia(
  data: Uint8Array,
  response: Response,
  preferredMimeType: string | undefined
): DownloadedMedia {
  const result: DownloadedMedia = { data };
  const mimeType = preferredMimeType ?? response.headers.get('content-type') ?? undefined;
  if (mimeType !== undefined) result.mimeType = mimeType;
  const contentLength = parseContentLength(response.headers.get('content-length'));
  // Fall back to the actual byte length when the header is absent/unparseable.
  result.contentLength = contentLength ?? data.byteLength;
  return result;
}

/** Build a MetaApiError from a non-2xx response, mirroring GraphClient's envelope parse. */
function buildHttpError(
  operation: string,
  httpStatus: number,
  parsed: unknown,
  rawText: string
): MetaApiError {
  const errorObj =
    typeof parsed === 'object' && parsed !== null
      ? ((parsed as { error?: unknown }).error as Record<string, unknown> | undefined)
      : undefined;
  const errorCode = typeof errorObj?.['code'] === 'number' ? (errorObj['code'] as number) : undefined;
  const errorSubCode =
    typeof errorObj?.['error_subcode'] === 'number' ? (errorObj['error_subcode'] as number) : undefined;
  const fbtraceId =
    typeof errorObj?.['fbtrace_id'] === 'string' ? (errorObj['fbtrace_id'] as string) : undefined;

  return new MetaApiError({
    operation,
    httpStatus,
    ...(errorCode !== undefined ? { errorCode } : {}),
    ...(errorSubCode !== undefined ? { errorSubCode } : {}),
    ...(fbtraceId !== undefined ? { fbtraceId } : {}),
    responseBody: parsed ?? rawText
  });
}

/** Pull a top-level string field out of a parsed JSON object, else undefined. */
function extractStringField(parsed: unknown, key: string): string | undefined {
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const value = (parsed as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function tryParseJson(raw: string): unknown {
  if (raw.length === 0) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** Read a response body as text, swallowing any read error (diagnostics only). */
async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function parseContentLength(header: string | null): number | undefined {
  if (header === null) return undefined;
  const trimmed = header.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  return Number.parseInt(trimmed, 10);
}
