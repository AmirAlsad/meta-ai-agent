/**
 * Unit tests for the OPT-IN inbound media hydrator
 * ({@link HttpMediaHydrator} / {@link NoopMediaHydrator}).
 *
 * The WhatsApp path is a 2-hop download: a JSON `GET /{mediaId}` (through the
 * {@link GraphClient}) to resolve the CDN url + metadata, then a binary GET of
 * those bytes WITH the Bearer token. We give the GraphClient and the hydrator the
 * SAME mocked fetch and sequence the responses (metadata JSON, then binary). The
 * Messenger/IG path is a single token-free binary GET of the pre-signed url.
 *
 * Everything here is FAIL-OPEN: a download error, timeout, or over-cap result is
 * an `undefined` return, NEVER a throw.
 */
import { describe, expect, it, vi } from 'vitest';
import { GraphClient } from '../../src/meta/shared/graph-client.js';
import { HttpMediaHydrator, NoopMediaHydrator } from '../../src/meta/shared/media-hydrator.js';
import type { IncomingMessage } from '../../src/meta/types.js';

const API_VERSION = 'v25.0';
const WA_TOKEN = 'super-secret-wa-token';
const MEDIA_ID = 'MEDIA_ID_42';
const WA_MEDIA_URL = 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=abc&token=cdnsig';
const ATTACHMENT_URL = 'https://scontent.xx.fbcdn.net/v/attachment.jpg?oh=presigned';

const IMAGE_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x10, 0x20, 0x30]);

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  });
}

function binaryResponse(bytes: Uint8Array, headers: Record<string, string> = {}): Response {
  return new Response(bytes, { status: 200, headers });
}

function makeGraph(fetchImpl: ReturnType<typeof vi.fn>): GraphClient {
  return new GraphClient({
    apiVersion: API_VERSION,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleep: () => Promise.resolve()
  });
}

function whatsAppImage(overrides: Partial<IncomingMessage['media']> = {}): IncomingMessage {
  return {
    channel: 'whatsapp',
    channelMessageId: 'wamid.1',
    channelScopedUserId: 'user-1',
    channelScopedBusinessId: 'biz-1',
    timestamp: 1,
    type: 'image',
    media: { id: MEDIA_ID, mimeType: 'image/jpeg', ...overrides },
    raw: {}
  };
}

function messengerImage(overrides: Partial<IncomingMessage['media']> = {}): IncomingMessage {
  return {
    channel: 'messenger',
    channelMessageId: 'm_1',
    channelScopedUserId: 'psid-1',
    channelScopedBusinessId: 'page-1',
    timestamp: 1,
    type: 'image',
    media: { url: ATTACHMENT_URL, mimeType: 'image/png', ...overrides },
    raw: {}
  };
}

/** Decode a `data:<mime>;base64,<...>` URL into { mimeType, bytes }. */
function decodeDataUrl(dataUrl: string): { mimeType: string; bytes: Uint8Array } {
  const match = /^data:([^;]+);base64,(.*)$/.exec(dataUrl);
  if (!match) throw new Error(`not a base64 data URL: ${dataUrl.slice(0, 24)}`);
  return { mimeType: match[1]!, bytes: new Uint8Array(Buffer.from(match[2]!, 'base64')) };
}

describe('HttpMediaHydrator — WhatsApp (2-hop authenticated download)', () => {
  it('resolves the media URL then downloads bytes with Bearer and returns a base64 data URL', async () => {
    const fetchImpl = vi.fn();
    const metaResponse = (): Response =>
      jsonResponse(200, { url: WA_MEDIA_URL, mime_type: 'image/jpeg', file_size: IMAGE_BYTES.byteLength });
    // FINDING 3: the hydrator resolves metadata ONCE (for the size pre-flight),
    // then downloads straight from the resolved url via
    // downloadWhatsAppMediaFromUrl — NO second metadata resolve. So the sequence
    // is: metadata JSON, then the binary GET.
    fetchImpl.mockResolvedValueOnce(metaResponse()); // pre-flight metadata (only resolve)
    fetchImpl.mockResolvedValueOnce(binaryResponse(IMAGE_BYTES, { 'content-type': 'image/jpeg' })); // binary

    const graph = makeGraph(fetchImpl);
    const hydrator = new HttpMediaHydrator({
      graph,
      whatsAppAccessToken: WA_TOKEN,
      maxBytes: 1_000_000,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    const dataUrl = await hydrator.hydrate(whatsAppImage());
    expect(dataUrl).toBeDefined();
    const decoded = decodeDataUrl(dataUrl!);
    expect(decoded.mimeType).toBe('image/jpeg');
    expect(Array.from(decoded.bytes)).toEqual(Array.from(IMAGE_BYTES));

    // The metadata URL targets the id; the binary hop (last call) carried Bearer.
    const [metaUrl] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(String(metaUrl)).toContain(MEDIA_ID);
    const [binUrl, binInit] = fetchImpl.mock.calls.at(-1) as [string, RequestInit];
    expect(String(binUrl)).toBe(WA_MEDIA_URL);
    const binHeaders = (binInit.headers ?? {}) as Record<string, string>;
    expect(binHeaders['authorization']).toBe(`Bearer ${WA_TOKEN}`);
  });

  it('FINDING 3: under-cap hydrate resolves the /{media_id} metadata endpoint EXACTLY ONCE', async () => {
    // Before the fix the under-cap path resolved metadata twice: once for the
    // hydrator's file_size pre-flight and again inside downloadWhatsAppMedia. The
    // fix downloads from the already-resolved url, so the authenticated
    // `GET /{media_id}` Graph hop happens only once. We count the metadata GETs by
    // matching the media id in the requested URL and asserting exactly one.
    const fetchImpl = vi.fn();
    fetchImpl.mockResolvedValueOnce(
      jsonResponse(200, { url: WA_MEDIA_URL, mime_type: 'image/jpeg', file_size: IMAGE_BYTES.byteLength })
    ); // metadata resolve (must be the ONLY one)
    fetchImpl.mockResolvedValueOnce(binaryResponse(IMAGE_BYTES, { 'content-type': 'image/jpeg' })); // binary

    const hydrator = new HttpMediaHydrator({
      graph: makeGraph(fetchImpl),
      whatsAppAccessToken: WA_TOKEN,
      maxBytes: 1_000_000,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    const dataUrl = await hydrator.hydrate(whatsAppImage());
    expect(dataUrl).toBeDefined(); // the under-cap path completed the download

    // Count fetches whose URL targets the `/{media_id}` metadata endpoint. The
    // binary hop targets the resolved CDN url (WA_MEDIA_URL), not the media id.
    const metadataGets = fetchImpl.mock.calls.filter(([url]) =>
      String(url).includes(MEDIA_ID)
    );
    expect(metadataGets).toHaveLength(1);
    // Total of two fetches: one metadata resolve + one binary GET (no redundant hop).
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('returns undefined (no download) when no WhatsApp access token is configured', async () => {
    const fetchImpl = vi.fn();
    const hydrator = new HttpMediaHydrator({
      graph: makeGraph(fetchImpl),
      maxBytes: 1_000_000,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    expect(await hydrator.hydrate(whatsAppImage())).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('skips download when the metadata file_size exceeds maxBytes (no over-large fetch)', async () => {
    const fetchImpl = vi.fn();
    // Only the metadata hop is hit; the over-cap size aborts before the binary GET.
    fetchImpl.mockResolvedValueOnce(
      jsonResponse(200, { url: WA_MEDIA_URL, mime_type: 'image/jpeg', file_size: 9_999_999 })
    );

    const hydrator = new HttpMediaHydrator({
      graph: makeGraph(fetchImpl),
      whatsAppAccessToken: WA_TOKEN,
      maxBytes: 1000,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    expect(await hydrator.hydrate(whatsAppImage())).toBeUndefined();
    // Exactly ONE fetch (metadata); the binary download never happened.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('returns undefined (fail-open) when the binary download fails', async () => {
    const fetchImpl = vi.fn();
    fetchImpl.mockResolvedValueOnce(
      jsonResponse(200, { url: WA_MEDIA_URL, mime_type: 'image/jpeg', file_size: IMAGE_BYTES.byteLength })
    );
    fetchImpl.mockRejectedValueOnce(new Error('ECONNRESET'));

    const hydrator = new HttpMediaHydrator({
      graph: makeGraph(fetchImpl),
      whatsAppAccessToken: WA_TOKEN,
      maxBytes: 1_000_000,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    await expect(hydrator.hydrate(whatsAppImage())).resolves.toBeUndefined();
  });

  it('returns undefined (fail-open) when the operation times out', async () => {
    const fetchImpl = vi.fn();
    // Metadata hop never resolves → the whole op hits the timeout.
    fetchImpl.mockReturnValueOnce(new Promise(() => {}));

    const hydrator = new HttpMediaHydrator({
      graph: makeGraph(fetchImpl),
      whatsAppAccessToken: WA_TOKEN,
      maxBytes: 1_000_000,
      timeoutMs: 5,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    await expect(hydrator.hydrate(whatsAppImage())).resolves.toBeUndefined();
  });
});

describe('HttpMediaHydrator — Messenger/Instagram (pre-signed url, token-free)', () => {
  it('downloads the attachment url and returns a base64 data URL (no Bearer)', async () => {
    const fetchImpl = vi.fn();
    fetchImpl.mockResolvedValueOnce(binaryResponse(IMAGE_BYTES, { 'content-type': 'image/png' }));

    const hydrator = new HttpMediaHydrator({
      graph: makeGraph(vi.fn()),
      maxBytes: 1_000_000,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    const dataUrl = await hydrator.hydrate(messengerImage());
    expect(dataUrl).toBeDefined();
    const decoded = decodeDataUrl(dataUrl!);
    expect(decoded.mimeType).toBe('image/png');
    expect(Array.from(decoded.bytes)).toEqual(Array.from(IMAGE_BYTES));

    // A single token-free GET of the pre-signed URL.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(ATTACHMENT_URL);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers['authorization']).toBeUndefined();
  });

  it('returns undefined when the downloaded bytes exceed maxBytes (post-download check)', async () => {
    const fetchImpl = vi.fn();
    // No Content-Length header → size only known after download → post-check rejects.
    fetchImpl.mockResolvedValueOnce(binaryResponse(IMAGE_BYTES, { 'content-type': 'image/png' }));

    const hydrator = new HttpMediaHydrator({
      graph: makeGraph(vi.fn()),
      maxBytes: 3, // smaller than IMAGE_BYTES
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    expect(await hydrator.hydrate(messengerImage())).toBeUndefined();
  });

  it('EARLY-rejects (no body buffered) when Content-Length exceeds maxBytes', async () => {
    // FIX 3: a huge attachment whose Content-Length is over the cap must be skipped
    // BEFORE the body is read. We spy on the response's arrayBuffer() to prove the
    // over-cap blob was never buffered.
    const response = binaryResponse(IMAGE_BYTES, {
      'content-type': 'image/png',
      'content-length': '9000000'
    });
    const arrayBufferSpy = vi.spyOn(response, 'arrayBuffer');
    const fetchImpl = vi.fn().mockResolvedValueOnce(response);

    const hydrator = new HttpMediaHydrator({
      graph: makeGraph(vi.fn()),
      maxBytes: 1000, // far below the advertised 9 MB
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    expect(await hydrator.hydrate(messengerImage())).toBeUndefined();
    // The body was never read — the early reject fired off the Content-Length.
    expect(arrayBufferSpy).not.toHaveBeenCalled();
  });
});

describe('HttpMediaHydrator — generic behaviors', () => {
  it('returns undefined when the message has no media', async () => {
    const hydrator = new HttpMediaHydrator({ graph: makeGraph(vi.fn()), maxBytes: 1_000_000 });
    const msg: IncomingMessage = {
      channel: 'whatsapp',
      channelMessageId: 'wamid.x',
      channelScopedUserId: 'u',
      channelScopedBusinessId: 'b',
      timestamp: 1,
      type: 'text',
      text: 'hi',
      raw: {}
    };
    expect(await hydrator.hydrate(msg)).toBeUndefined();
  });

  it('is idempotent: returns the existing dataUrl without re-downloading', async () => {
    const fetchImpl = vi.fn();
    const hydrator = new HttpMediaHydrator({
      graph: makeGraph(fetchImpl),
      whatsAppAccessToken: WA_TOKEN,
      maxBytes: 1_000_000,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    const existing = 'data:image/jpeg;base64,QUJD';
    const dataUrl = await hydrator.hydrate(whatsAppImage({ dataUrl: existing }));
    expect(dataUrl).toBe(existing);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('falls back to the descriptor mimeType when the download supplies none', async () => {
    const fetchImpl = vi.fn();
    // No content-type on the binary hop; metadata also omits mime_type.
    // FINDING 3: ONE metadata resolve (pre-flight) then the binary — no second resolve.
    const noMimeMeta = (): Response => jsonResponse(200, { url: WA_MEDIA_URL, file_size: IMAGE_BYTES.byteLength });
    fetchImpl.mockResolvedValueOnce(noMimeMeta());
    fetchImpl.mockResolvedValueOnce(binaryResponse(IMAGE_BYTES));

    const hydrator = new HttpMediaHydrator({
      graph: makeGraph(fetchImpl),
      whatsAppAccessToken: WA_TOKEN,
      maxBytes: 1_000_000,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    const dataUrl = await hydrator.hydrate(whatsAppImage({ mimeType: 'image/jpeg' }));
    expect(decodeDataUrl(dataUrl!).mimeType).toBe('image/jpeg');
  });
});

describe('NoopMediaHydrator', () => {
  it('always returns undefined', async () => {
    const hydrator = new NoopMediaHydrator();
    expect(await hydrator.hydrate(whatsAppImage())).toBeUndefined();
    expect(await hydrator.hydrate(messengerImage())).toBeUndefined();
  });
});
