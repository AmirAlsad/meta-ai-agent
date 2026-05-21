import { describe, expect, it, vi } from 'vitest';
import { GraphClient } from '../../src/meta/shared/graph-client.js';
import { MetaApiError } from '../../src/meta/shared/errors.js';
import {
  inferMediaKind,
  uploadWhatsAppMedia,
  getWhatsAppMediaUrl,
  downloadWhatsAppMedia,
  downloadAttachmentUrl
} from '../../src/meta/shared/media.js';

/* ────────────────────────────────────────────────────────────────────────── */
/* Helpers                                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

const API_VERSION = 'v25.0';
const PHONE_NUMBER_ID = '123456789';
const ACCESS_TOKEN = 'super-secret-wa-token';
const MEDIA_ID = 'MEDIA_ID_42';
const MEDIA_URL = 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=abc&token=cdnsig';
const ATTACHMENT_URL = 'https://scontent.xx.fbcdn.net/v/attachment.jpg?oh=presigned';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  });
}

function binaryResponse(
  status: number,
  bytes: Uint8Array,
  headers: Record<string, string> = {}
): Response {
  // `new Response(Uint8Array)` is valid under Node's undici types.
  return new Response(bytes, { status, headers });
}

/** Build a GraphClient whose fetch is mocked and whose sleep is a no-op. */
function makeGraph(fetchImpl: ReturnType<typeof vi.fn>): GraphClient {
  return new GraphClient({
    apiVersion: API_VERSION,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleep: () => Promise.resolve()
  });
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  return (init?.headers as Record<string, string> | undefined) ?? {};
}

/* ────────────────────────────────────────────────────────────────────────── */
/* inferMediaKind                                                              */
/* ────────────────────────────────────────────────────────────────────────── */

describe('inferMediaKind', () => {
  it('maps image/* → image', () => {
    expect(inferMediaKind('image/jpeg')).toBe('image');
    expect(inferMediaKind('image/png')).toBe('image');
  });

  it('maps audio/* → audio', () => {
    expect(inferMediaKind('audio/ogg')).toBe('audio');
  });

  it('maps video/* → video', () => {
    expect(inferMediaKind('video/mp4')).toBe('video');
  });

  it('maps application/* → document', () => {
    expect(inferMediaKind('application/pdf')).toBe('document');
  });

  it('maps text/* → document', () => {
    expect(inferMediaKind('text/plain')).toBe('document');
  });

  it('maps undefined → document', () => {
    expect(inferMediaKind(undefined)).toBe('document');
  });

  it('is case-insensitive on the top-level type', () => {
    expect(inferMediaKind('IMAGE/JPEG')).toBe('image');
    expect(inferMediaKind('Audio/OGG')).toBe('audio');
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* uploadWhatsAppMedia                                                         */
/* ────────────────────────────────────────────────────────────────────────── */

describe('uploadWhatsAppMedia', () => {
  const UPLOAD_URL = `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/media`;

  it('POSTs multipart form-data to /{apiVersion}/{phoneNumberId}/media and returns the id', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { id: MEDIA_ID }));

    const id = await uploadWhatsAppMedia({
      phoneNumberId: PHONE_NUMBER_ID,
      accessToken: ACCESS_TOKEN,
      apiVersion: API_VERSION,
      data: new Uint8Array([1, 2, 3, 4]),
      mimeType: 'image/jpeg',
      filename: 'photo.jpg',
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    expect(id).toBe(MEDIA_ID);
    expect(fetchImpl).toHaveBeenCalledOnce();

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    // Exact URL with version segment; token NOT in the URL.
    expect(String(url)).toBe(UPLOAD_URL);
    expect(String(url)).not.toContain(ACCESS_TOKEN);
    expect(String(url)).not.toContain('access_token');
    expect(init.method).toBe('POST');

    // A FormData body was sent (lets fetch set the multipart boundary).
    expect(init.body).toBeInstanceOf(FormData);

    // Authorization header present; Content-Type NOT set manually (fetch adds it
    // with the boundary).
    const headers = headersOf(init);
    expect(headers['authorization']).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(headers['content-type']).toBeUndefined();
    expect(headers['Content-Type']).toBeUndefined();
  });

  it('carries messaging_product, type, and file in the FormData body', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { id: MEDIA_ID }));

    await uploadWhatsAppMedia({
      phoneNumberId: PHONE_NUMBER_ID,
      accessToken: ACCESS_TOKEN,
      apiVersion: API_VERSION,
      data: new Uint8Array([9, 9, 9]),
      mimeType: 'audio/ogg',
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const form = init.body as FormData;
    expect(form.get('messaging_product')).toBe('whatsapp');
    expect(form.get('type')).toBe('audio/ogg');
    // The file part is a Blob/File with the right MIME type.
    const file = form.get('file');
    expect(file).toBeInstanceOf(Blob);
    expect((file as Blob).type).toBe('audio/ogg');
  });

  it('accepts a Blob directly without re-wrapping', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { id: MEDIA_ID }));
    const blob = new Blob([new Uint8Array([1, 2])], { type: 'video/mp4' });

    const id = await uploadWhatsAppMedia({
      phoneNumberId: PHONE_NUMBER_ID,
      accessToken: ACCESS_TOKEN,
      apiVersion: API_VERSION,
      data: blob,
      mimeType: 'video/mp4',
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    expect(id).toBe(MEDIA_ID);
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const file = (init.body as FormData).get('file');
    expect((file as Blob).type).toBe('video/mp4');
  });

  it('throws MetaApiError with operation whatsapp.uploadMedia on a non-2xx response', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(400, { error: { message: 'bad media', code: 100 } }));

    const promise = uploadWhatsAppMedia({
      phoneNumberId: PHONE_NUMBER_ID,
      accessToken: ACCESS_TOKEN,
      apiVersion: API_VERSION,
      data: new Uint8Array([1]),
      mimeType: 'image/jpeg',
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    await expect(promise).rejects.toBeInstanceOf(MetaApiError);
    await expect(promise).rejects.toMatchObject({
      operation: 'whatsapp.uploadMedia',
      httpStatus: 400,
      errorCode: 100
    });
  });

  it('throws MetaApiError (httpStatus 0) on a transport failure', async () => {
    const fetchImpl = vi.fn().mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const promise = uploadWhatsAppMedia({
      phoneNumberId: PHONE_NUMBER_ID,
      accessToken: ACCESS_TOKEN,
      apiVersion: API_VERSION,
      data: new Uint8Array([1]),
      mimeType: 'image/jpeg',
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    await expect(promise).rejects.toMatchObject({
      operation: 'whatsapp.uploadMedia',
      httpStatus: 0
    });
  });

  it('throws when a 2xx response carries no media id', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { not_id: 'x' }));

    const promise = uploadWhatsAppMedia({
      phoneNumberId: PHONE_NUMBER_ID,
      accessToken: ACCESS_TOKEN,
      apiVersion: API_VERSION,
      data: new Uint8Array([1]),
      mimeType: 'image/jpeg',
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    await expect(promise).rejects.toBeInstanceOf(MetaApiError);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* getWhatsAppMediaUrl                                                         */
/* ────────────────────────────────────────────────────────────────────────── */

describe('getWhatsAppMediaUrl', () => {
  it('GETs /{mediaId} and maps the snake_case metadata to camelCase', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        url: MEDIA_URL,
        mime_type: 'image/jpeg',
        file_size: 2048,
        sha256: 'deadbeef'
      })
    );
    const graph = makeGraph(fetchImpl);

    const info = await getWhatsAppMediaUrl({ mediaId: MEDIA_ID, accessToken: ACCESS_TOKEN, graph });

    expect(info).toEqual({
      url: MEDIA_URL,
      mimeType: 'image/jpeg',
      fileSizeBytes: 2048,
      sha256: 'deadbeef'
    });

    // GET to /{apiVersion}/{mediaId} with the Bearer header; token NOT in URL.
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(`https://graph.facebook.com/${API_VERSION}/${MEDIA_ID}`);
    expect(String(url)).not.toContain(ACCESS_TOKEN);
    expect(init.method).toBe('GET');
    expect(headersOf(init)['authorization']).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  it('omits optional fields when the metadata lacks them', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { url: MEDIA_URL }));
    const graph = makeGraph(fetchImpl);

    const info = await getWhatsAppMediaUrl({ mediaId: MEDIA_ID, accessToken: ACCESS_TOKEN, graph });
    expect(info).toEqual({ url: MEDIA_URL });
  });

  it('throws MetaApiError with operation whatsapp.getMediaUrl on failure', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(404, { error: { message: 'no such media', code: 100 } }));
    const graph = makeGraph(fetchImpl);

    const promise = getWhatsAppMediaUrl({ mediaId: MEDIA_ID, accessToken: ACCESS_TOKEN, graph });
    await expect(promise).rejects.toMatchObject({
      operation: 'whatsapp.getMediaUrl',
      httpStatus: 404
    });
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* downloadWhatsAppMedia                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

describe('downloadWhatsAppMedia', () => {
  it('does the 2-step download; the binary GET carries the Bearer token; returns bytes + mimeType', async () => {
    const bytes = new Uint8Array([10, 20, 30, 40, 50]);
    const fetchImpl = vi
      .fn()
      // Step 1: metadata (via GraphClient).
      .mockResolvedValueOnce(jsonResponse(200, { url: MEDIA_URL, mime_type: 'image/png', file_size: 5 }))
      // Step 2: the binary bytes (raw fetch).
      .mockResolvedValueOnce(binaryResponse(200, bytes, { 'content-type': 'image/png' }));
    const graph = makeGraph(fetchImpl);

    const result = await downloadWhatsAppMedia({
      mediaId: MEDIA_ID,
      accessToken: ACCESS_TOKEN,
      graph,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    expect(Array.from(result.data)).toEqual([10, 20, 30, 40, 50]);
    expect(result.mimeType).toBe('image/png');
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    // Step 1 hit the Graph metadata endpoint.
    const [metaUrl] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(String(metaUrl)).toBe(`https://graph.facebook.com/${API_VERSION}/${MEDIA_ID}`);

    // Step 2 hit the resolved CDN URL WITH the Bearer token (WhatsApp requires it)
    // AND a benign User-Agent (the lookaside CDN rejects default/absent UAs).
    const [binUrl, binInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(String(binUrl)).toBe(MEDIA_URL);
    const binHeaders = headersOf(binInit);
    expect(binHeaders['authorization']).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(binHeaders['user-agent']).toBeTruthy();
  });

  it('uses redirect:manual on the authed GET and follows a 3xx Location WITHOUT the token', async () => {
    const REDIRECT_URL = 'https://cdn.example.com/signed/blob';
    const bytes = new Uint8Array([7, 8, 9]);
    const fetchImpl = vi
      .fn()
      // Step 1: metadata (via GraphClient).
      .mockResolvedValueOnce(jsonResponse(200, { url: MEDIA_URL, mime_type: 'image/jpeg' }))
      // Step 2: the authed binary GET returns a redirect (NOT auto-followed).
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: REDIRECT_URL } }))
      // Step 3: the followed Location returns the bytes.
      .mockResolvedValueOnce(binaryResponse(200, bytes, { 'content-type': 'image/jpeg' }));
    const graph = makeGraph(fetchImpl);

    const result = await downloadWhatsAppMedia({
      mediaId: MEDIA_ID,
      accessToken: ACCESS_TOKEN,
      graph,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    expect(Array.from(result.data)).toEqual([7, 8, 9]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    // The authed binary GET set redirect:'manual' so the token is never
    // auto-forwarded across a redirect; it still carries the Bearer.
    const [, binInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(binInit.redirect).toBe('manual');
    expect(headersOf(binInit)['authorization']).toBe(`Bearer ${ACCESS_TOKEN}`);

    // The followed Location carried NO Authorization header (token not leaked to
    // the redirect target), only the User-Agent.
    const [redirUrl, redirInit] = fetchImpl.mock.calls[2] as [string, RequestInit];
    expect(String(redirUrl)).toBe(REDIRECT_URL);
    expect(headersOf(redirInit)['authorization']).toBeUndefined();
    expect(headersOf(redirInit)['user-agent']).toBeTruthy();
  });

  it('errors on a redirect with no Location header (does not hang or leak)', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { url: MEDIA_URL }))
      .mockResolvedValueOnce(new Response(null, { status: 302 }));
    const graph = makeGraph(fetchImpl);
    await expect(
      downloadWhatsAppMedia({
        mediaId: MEDIA_ID,
        accessToken: ACCESS_TOKEN,
        graph,
        fetchImpl: fetchImpl as unknown as typeof fetch
      })
    ).rejects.toThrow(/Location/i);
  });

  it('falls back to the response Content-Type when metadata has no mime_type', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { url: MEDIA_URL }))
      .mockResolvedValueOnce(binaryResponse(200, bytes, { 'content-type': 'application/pdf' }));
    const graph = makeGraph(fetchImpl);

    const result = await downloadWhatsAppMedia({
      mediaId: MEDIA_ID,
      accessToken: ACCESS_TOKEN,
      graph,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(result.mimeType).toBe('application/pdf');
  });

  it('throws MetaApiError (operation whatsapp.getMediaUrl) when the metadata step fails', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(404, { error: { message: 'gone' } }));
    const graph = makeGraph(fetchImpl);

    const promise = downloadWhatsAppMedia({
      mediaId: MEDIA_ID,
      accessToken: ACCESS_TOKEN,
      graph,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    await expect(promise).rejects.toMatchObject({
      operation: 'whatsapp.getMediaUrl',
      httpStatus: 404
    });
  });

  it('throws MetaApiError (operation whatsapp.downloadMedia) when the binary step fails', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { url: MEDIA_URL, mime_type: 'image/png' }))
      .mockResolvedValueOnce(jsonResponse(401, { error: { message: 'unauthorized' } }));
    const graph = makeGraph(fetchImpl);

    const promise = downloadWhatsAppMedia({
      mediaId: MEDIA_ID,
      accessToken: ACCESS_TOKEN,
      graph,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    await expect(promise).rejects.toMatchObject({
      operation: 'whatsapp.downloadMedia',
      httpStatus: 401
    });
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* downloadAttachmentUrl                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

describe('downloadAttachmentUrl', () => {
  it('GETs the pre-signed URL with NO Authorization header; returns bytes + mimeType', async () => {
    const bytes = new Uint8Array([7, 7, 7, 7]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(binaryResponse(200, bytes, { 'content-type': 'image/jpeg' }));

    const result = await downloadAttachmentUrl({
      url: ATTACHMENT_URL,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    expect(Array.from(result.data)).toEqual([7, 7, 7, 7]);
    expect(result.mimeType).toBe('image/jpeg');
    expect(fetchImpl).toHaveBeenCalledOnce();

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit | undefined];
    expect(String(url)).toBe(ATTACHMENT_URL);
    // The whole point: NO auth header is attached to FB/IG CDN URLs.
    const headers = headersOf(init);
    expect(headers['authorization']).toBeUndefined();
    expect(headers['Authorization']).toBeUndefined();
    // A benign User-Agent IS sent though — Meta's CDN rejects default/absent UAs.
    // (A UA is not auth, so this stays a token-free GET.)
    expect(headers['user-agent']).toBeTruthy();
  });

  it('throws MetaApiError with operation media.downloadAttachment on a non-2xx response', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(403, { error: { message: 'expired' } }));

    const promise = downloadAttachmentUrl({
      url: ATTACHMENT_URL,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    await expect(promise).rejects.toMatchObject({
      operation: 'media.downloadAttachment',
      httpStatus: 403
    });
  });

  it('throws MetaApiError (httpStatus 0) on a transport failure', async () => {
    const fetchImpl = vi.fn().mockRejectedValueOnce(new Error('ETIMEDOUT'));

    const promise = downloadAttachmentUrl({
      url: ATTACHMENT_URL,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    await expect(promise).rejects.toMatchObject({
      operation: 'media.downloadAttachment',
      httpStatus: 0
    });
  });
});
