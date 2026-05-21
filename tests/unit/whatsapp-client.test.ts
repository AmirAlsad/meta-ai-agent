import { afterEach, describe, expect, it, vi } from 'vitest';
import { GraphClient } from '../../src/meta/shared/graph-client.js';
import { MetaApiError } from '../../src/meta/shared/errors.js';
import { WhatsAppClient } from '../../src/meta/whatsapp/client.js';
import type { WhatsAppConfig } from '../../src/config/loader.js';

/* ────────────────────────────────────────────────────────────────────────── */
/* Helpers                                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

const API_VERSION = 'v25.0';
const PHONE_NUMBER_ID = '123456789';
const ACCESS_TOKEN = 'super-secret-wa-token';
const MESSAGES_URL = `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/messages`;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

const CONFIG: WhatsAppConfig = {
  phoneNumberId: PHONE_NUMBER_ID,
  accessToken: ACCESS_TOKEN
};

/**
 * Build a WhatsAppClient over a GraphClient whose fetch is mocked. The sleep is
 * a no-op so any (unexpected) retry incurs no real delay. Returns the client,
 * the fetch mock, and a captured logger.
 */
function makeClient(fetchImpl: ReturnType<typeof vi.fn>) {
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  const graph = new GraphClient({
    apiVersion: API_VERSION,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleep: () => Promise.resolve()
  });
  const client = new WhatsAppClient({ config: CONFIG, graph, logger });
  return { client, fetchImpl, logger };
}

/** Pull the `[url, init]` pair for a given fetch call and parse the JSON body. */
function callAt(fetchImpl: ReturnType<typeof vi.fn>, index: number): { url: string; init: RequestInit; body: unknown } {
  const call = fetchImpl.mock.calls[index];
  if (!call) throw new Error(`no fetch call at index ${index}`);
  const [url, init] = call as [string, RequestInit];
  const rawBody = init.body;
  const body = typeof rawBody === 'string' ? JSON.parse(rawBody) : undefined;
  return { url: String(url), init, body };
}

function authHeader(init: RequestInit): string | undefined {
  const headers = init.headers as Record<string, string> | undefined;
  return headers?.['authorization'];
}

/* ────────────────────────────────────────────────────────────────────────── */
/* sendText                                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

describe('WhatsAppClient.sendText', () => {
  it('POSTs the correct URL, method, body, and Bearer auth; parses the wamid', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { messages: [{ id: 'wamid.TEXT1' }] }));
    const { client } = makeClient(fetchImpl);

    const before = Date.now();
    const result = await client.sendText('15551234567', 'hello world');
    const after = Date.now();

    expect(fetchImpl).toHaveBeenCalledOnce();
    const { url, init, body } = callAt(fetchImpl, 0);

    // Exact URL with version segment + phone number id; token NOT in the URL.
    expect(url).toBe(MESSAGES_URL);
    expect(url).not.toContain(ACCESS_TOKEN);
    expect(url).not.toContain('access_token');
    expect(init.method).toBe('POST');
    expect(authHeader(init)).toBe(`Bearer ${ACCESS_TOKEN}`);

    // Exact body shape — this is the contract with Meta.
    expect(body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '15551234567',
      type: 'text',
      text: { body: 'hello world', preview_url: false }
    });

    // SendResult parsed from messages[0].id.
    expect(result.channel).toBe('whatsapp');
    expect(result.messageId).toBe('wamid.TEXT1');
    expect(result.recipientId).toBe('15551234567');
    expect(result.timestamp).toBeGreaterThanOrEqual(before);
    expect(result.timestamp).toBeLessThanOrEqual(after);
    expect(result.raw).toEqual({ messages: [{ id: 'wamid.TEXT1' }] });
  });

  it('attaches context.message_id when replyTo is set', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { messages: [{ id: 'wamid.REPLY' }] }));
    const { client } = makeClient(fetchImpl);

    await client.sendText('15551234567', 'a reply', { replyTo: 'wamid.INBOUND' });

    const { body } = callAt(fetchImpl, 0);
    expect(body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '15551234567',
      type: 'text',
      text: { body: 'a reply', preview_url: false },
      context: { message_id: 'wamid.INBOUND' }
    });
  });

  it('omits context when no replyTo is provided', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { messages: [{ id: 'wamid.X' }] }));
    const { client } = makeClient(fetchImpl);
    await client.sendText('15551234567', 'no reply');
    const { body } = callAt(fetchImpl, 0);
    expect((body as Record<string, unknown>).context).toBeUndefined();
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* sendTypingIndicator                                                         */
/* ────────────────────────────────────────────────────────────────────────── */

describe('WhatsAppClient.sendTypingIndicator', () => {
  it('sends the combined read + typing_indicator body when given a messageId', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { success: true }));
    const { client } = makeClient(fetchImpl);

    await client.sendTypingIndicator('15551234567', 'wamid.INBOUND');

    expect(fetchImpl).toHaveBeenCalledOnce();
    const { url, body } = callAt(fetchImpl, 0);
    expect(url).toBe(MESSAGES_URL);
    expect(body).toEqual({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: 'wamid.INBOUND',
      typing_indicator: { type: 'text' }
    });
  });

  it('does NOT call the API and logs a warn when messageId is undefined', async () => {
    const fetchImpl = vi.fn();
    const { client, logger } = makeClient(fetchImpl);

    await client.sendTypingIndicator('15551234567');

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledOnce();
    const [meta, msg] = logger.warn.mock.calls[0] ?? [];
    expect(meta).toMatchObject({ channel: 'whatsapp', to: '15551234567' });
    expect(String(msg)).toContain('typing');
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* markRead                                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

describe('WhatsAppClient.markRead', () => {
  it('sends the status:read body keyed by the wamid', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { success: true }));
    const { client } = makeClient(fetchImpl);

    await client.markRead('15551234567', 'wamid.INBOUND');

    expect(fetchImpl).toHaveBeenCalledOnce();
    const { url, body } = callAt(fetchImpl, 0);
    expect(url).toBe(MESSAGES_URL);
    expect(body).toEqual({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: 'wamid.INBOUND'
    });
    // The `to` param must NOT leak into the WhatsApp body.
    expect((body as Record<string, unknown>).to).toBeUndefined();
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* sendReaction                                                                */
/* ────────────────────────────────────────────────────────────────────────── */

describe('WhatsAppClient.sendReaction', () => {
  it('sends a reaction body with the emoji', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { messages: [{ id: 'wamid.RX' }] }));
    const { client } = makeClient(fetchImpl);

    await client.sendReaction('15551234567', 'wamid.TARGET', '👍');

    const { url, body } = callAt(fetchImpl, 0);
    expect(url).toBe(MESSAGES_URL);
    expect(body).toEqual({
      messaging_product: 'whatsapp',
      to: '15551234567',
      type: 'reaction',
      reaction: { message_id: 'wamid.TARGET', emoji: '👍' }
    });
  });

  it('preserves an empty-string emoji (the documented unreact)', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { messages: [{ id: 'wamid.UNRX' }] }));
    const { client } = makeClient(fetchImpl);

    await client.sendReaction('15551234567', 'wamid.TARGET', '');

    const { body } = callAt(fetchImpl, 0);
    expect(body).toEqual({
      messaging_product: 'whatsapp',
      to: '15551234567',
      type: 'reaction',
      reaction: { message_id: 'wamid.TARGET', emoji: '' }
    });
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* sendTemplate                                                                */
/* ────────────────────────────────────────────────────────────────────────── */

describe('WhatsAppClient.sendTemplate', () => {
  it('sends the template body with components and parses the SendResult', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { messages: [{ id: 'wamid.TMPL' }] }));
    const { client } = makeClient(fetchImpl);

    const components = [
      { type: 'body', parameters: [{ type: 'text', text: 'Ada' }] }
    ];
    const result = await client.sendTemplate('15551234567', 'order_update', 'en_US', components);

    const { url, body } = callAt(fetchImpl, 0);
    expect(url).toBe(MESSAGES_URL);
    expect(body).toEqual({
      messaging_product: 'whatsapp',
      to: '15551234567',
      type: 'template',
      template: {
        name: 'order_update',
        language: { code: 'en_US' },
        components: [{ type: 'body', parameters: [{ type: 'text', text: 'Ada' }] }]
      }
    });
    expect(result.messageId).toBe('wamid.TMPL');
    expect(result.recipientId).toBe('15551234567');
    expect(result.channel).toBe('whatsapp');
  });

  it('omits components when none are provided', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { messages: [{ id: 'wamid.TMPL2' }] }));
    const { client } = makeClient(fetchImpl);

    await client.sendTemplate('15551234567', 'hello_world', 'en_US');

    const { body } = callAt(fetchImpl, 0);
    expect(body).toEqual({
      messaging_product: 'whatsapp',
      to: '15551234567',
      type: 'template',
      template: { name: 'hello_world', language: { code: 'en_US' } }
    });
    expect((((body as Record<string, unknown>).template) as Record<string, unknown>).components).toBeUndefined();
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* sendImage                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

describe('WhatsAppClient.sendImage', () => {
  it('sends image:{ id } for a media id (no caption) and parses the wamid', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { messages: [{ id: 'wamid.IMG1' }] }));
    const { client } = makeClient(fetchImpl);

    const result = await client.sendImage('15551234567', 'MEDIA_ID_123');

    expect(fetchImpl).toHaveBeenCalledOnce();
    const { url, init, body } = callAt(fetchImpl, 0);
    expect(url).toBe(MESSAGES_URL);
    expect(init.method).toBe('POST');
    expect(authHeader(init)).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '15551234567',
      type: 'image',
      image: { id: 'MEDIA_ID_123' }
    });
    // No caption key when none was supplied.
    expect((((body as Record<string, unknown>).image) as Record<string, unknown>).caption).toBeUndefined();

    expect(result.channel).toBe('whatsapp');
    expect(result.messageId).toBe('wamid.IMG1');
    expect(result.recipientId).toBe('15551234567');
  });

  it('sends image:{ link } for an https URL', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { messages: [{ id: 'wamid.IMG2' }] }));
    const { client } = makeClient(fetchImpl);

    await client.sendImage('15551234567', 'https://cdn.example.com/cat.jpg');

    const { body } = callAt(fetchImpl, 0);
    expect(body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '15551234567',
      type: 'image',
      image: { link: 'https://cdn.example.com/cat.jpg' }
    });
  });

  it('includes the caption when provided', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { messages: [{ id: 'wamid.IMG3' }] }));
    const { client } = makeClient(fetchImpl);

    await client.sendImage('15551234567', 'MEDIA_ID_123', 'a caption');

    const { body } = callAt(fetchImpl, 0);
    expect(body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '15551234567',
      type: 'image',
      image: { id: 'MEDIA_ID_123', caption: 'a caption' }
    });
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* sendAudio                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

describe('WhatsAppClient.sendAudio', () => {
  it('sends audio:{ id } with NO caption field', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { messages: [{ id: 'wamid.AUD1' }] }));
    const { client } = makeClient(fetchImpl);

    const result = await client.sendAudio('15551234567', 'AUDIO_MEDIA_ID');

    const { url, body } = callAt(fetchImpl, 0);
    expect(url).toBe(MESSAGES_URL);
    expect(body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '15551234567',
      type: 'audio',
      audio: { id: 'AUDIO_MEDIA_ID' }
    });
    // WhatsApp audio does not support a caption — make sure we never add one.
    expect((((body as Record<string, unknown>).audio) as Record<string, unknown>).caption).toBeUndefined();
    expect(result.messageId).toBe('wamid.AUD1');
  });

  it('sends audio:{ link } for an http URL', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { messages: [{ id: 'wamid.AUD2' }] }));
    const { client } = makeClient(fetchImpl);

    await client.sendAudio('15551234567', 'http://cdn.example.com/voice.ogg');

    const { body } = callAt(fetchImpl, 0);
    expect(body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '15551234567',
      type: 'audio',
      audio: { link: 'http://cdn.example.com/voice.ogg' }
    });
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* sendVideo                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

describe('WhatsAppClient.sendVideo', () => {
  it('sends video:{ link, caption } for a URL with a caption', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { messages: [{ id: 'wamid.VID1' }] }));
    const { client } = makeClient(fetchImpl);

    const result = await client.sendVideo('15551234567', 'https://cdn.example.com/clip.mp4', 'watch this');

    const { url, body } = callAt(fetchImpl, 0);
    expect(url).toBe(MESSAGES_URL);
    expect(body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '15551234567',
      type: 'video',
      video: { link: 'https://cdn.example.com/clip.mp4', caption: 'watch this' }
    });
    expect(result.messageId).toBe('wamid.VID1');
  });

  it('sends video:{ id } with no caption when omitted', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { messages: [{ id: 'wamid.VID2' }] }));
    const { client } = makeClient(fetchImpl);

    await client.sendVideo('15551234567', 'VIDEO_MEDIA_ID');

    const { body } = callAt(fetchImpl, 0);
    expect(body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '15551234567',
      type: 'video',
      video: { id: 'VIDEO_MEDIA_ID' }
    });
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* sendDocument                                                                */
/* ────────────────────────────────────────────────────────────────────────── */

describe('WhatsAppClient.sendDocument', () => {
  it('sends document:{ id, filename } (no caption)', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { messages: [{ id: 'wamid.DOC1' }] }));
    const { client } = makeClient(fetchImpl);

    const result = await client.sendDocument('15551234567', 'DOC_MEDIA_ID', 'invoice.pdf');

    const { url, body } = callAt(fetchImpl, 0);
    expect(url).toBe(MESSAGES_URL);
    expect(body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '15551234567',
      type: 'document',
      document: { id: 'DOC_MEDIA_ID', filename: 'invoice.pdf' }
    });
    expect(result.messageId).toBe('wamid.DOC1');
  });

  it('sends document:{ link, filename, caption } for a URL with a caption', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { messages: [{ id: 'wamid.DOC2' }] }));
    const { client } = makeClient(fetchImpl);

    await client.sendDocument(
      '15551234567',
      'https://cdn.example.com/report.pdf',
      'report.pdf',
      'Q2 report'
    );

    const { body } = callAt(fetchImpl, 0);
    expect(body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '15551234567',
      type: 'document',
      document: { link: 'https://cdn.example.com/report.pdf', filename: 'report.pdf', caption: 'Q2 report' }
    });
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* sendMedia (uniform ChannelAdapter entry point → per-kind body)              */
/* ────────────────────────────────────────────────────────────────────────── */

describe('WhatsAppClient.sendMedia', () => {
  it('image → image body with caption', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { messages: [{ id: 'wamid.M_IMG' }] }));
    const { client } = makeClient(fetchImpl);

    const result = await client.sendMedia('15551234567', {
      kind: 'image',
      mediaIdOrUrl: 'https://cdn.example.com/cat.jpg',
      caption: 'a cat'
    });

    const { url, body } = callAt(fetchImpl, 0);
    expect(url).toBe(MESSAGES_URL);
    expect(body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '15551234567',
      type: 'image',
      image: { link: 'https://cdn.example.com/cat.jpg', caption: 'a cat' }
    });
    expect(result.messageId).toBe('wamid.M_IMG');
  });

  it('audio → audio body and DROPS the caption (WhatsApp audio has none)', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { messages: [{ id: 'wamid.M_AUD' }] }));
    const { client } = makeClient(fetchImpl);

    await client.sendMedia('15551234567', {
      kind: 'audio',
      mediaIdOrUrl: 'AUDIO_MEDIA_ID',
      caption: 'should be dropped'
    });

    const { body } = callAt(fetchImpl, 0);
    expect(body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '15551234567',
      type: 'audio',
      audio: { id: 'AUDIO_MEDIA_ID' }
    });
    // The caption must NOT have leaked into the audio body.
    expect(JSON.stringify(body)).not.toContain('should be dropped');
  });

  it('video → video body with caption', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { messages: [{ id: 'wamid.M_VID' }] }));
    const { client } = makeClient(fetchImpl);

    await client.sendMedia('15551234567', {
      kind: 'video',
      mediaIdOrUrl: 'https://cdn.example.com/clip.mp4',
      caption: 'watch'
    });

    const { body } = callAt(fetchImpl, 0);
    expect(body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '15551234567',
      type: 'video',
      video: { link: 'https://cdn.example.com/clip.mp4', caption: 'watch' }
    });
  });

  it('document → document body using the supplied filename + caption', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { messages: [{ id: 'wamid.M_DOC' }] }));
    const { client } = makeClient(fetchImpl);

    await client.sendMedia('15551234567', {
      kind: 'document',
      mediaIdOrUrl: 'https://cdn.example.com/x/report.pdf',
      caption: 'Q2',
      filename: 'custom.pdf'
    });

    const { body } = callAt(fetchImpl, 0);
    expect(body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '15551234567',
      type: 'document',
      document: { link: 'https://cdn.example.com/x/report.pdf', filename: 'custom.pdf', caption: 'Q2' }
    });
  });

  it('document → derives the filename from the URL basename when none is supplied', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { messages: [{ id: 'wamid.M_DOC2' }] }));
    const { client } = makeClient(fetchImpl);

    await client.sendMedia('15551234567', {
      kind: 'document',
      mediaIdOrUrl: 'https://cdn.example.com/files/2026/report.pdf?token=abc'
    });

    const { body } = callAt(fetchImpl, 0);
    const document = (body as Record<string, unknown>).document as Record<string, unknown>;
    // Basename of the path (query stripped) is the derived filename.
    expect(document.filename).toBe('report.pdf');
    expect(document.link).toBe('https://cdn.example.com/files/2026/report.pdf?token=abc');
  });

  it('document → falls back to "file" for a bare media id (no URL to derive from)', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { messages: [{ id: 'wamid.M_DOC3' }] }));
    const { client } = makeClient(fetchImpl);

    await client.sendMedia('15551234567', { kind: 'document', mediaIdOrUrl: 'DOC_MEDIA_ID' });

    const { body } = callAt(fetchImpl, 0);
    expect(body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '15551234567',
      type: 'document',
      document: { id: 'DOC_MEDIA_ID', filename: 'file' }
    });
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* media send — error path                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

describe('WhatsAppClient media send — error handling', () => {
  it('throws MetaApiError on a 400 from sendImage', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(400, {
        error: {
          message: 'Invalid media id',
          type: 'OAuthException',
          code: 100,
          fbtrace_id: 'trace-wa-media-400'
        }
      })
    );
    const { client } = makeClient(fetchImpl);

    let caught: unknown;
    try {
      await client.sendImage('15551234567', 'BAD_MEDIA_ID');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(MetaApiError);
    const meta = caught as MetaApiError;
    expect(meta.httpStatus).toBe(400);
    expect(meta.errorCode).toBe(100);
    expect(meta.operation).toBe('whatsapp.sendImage');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* uploadMedia                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

describe('WhatsAppClient.uploadMedia', () => {
  // `uploadMedia` delegates to the shared `uploadWhatsAppMedia`, which uses
  // `globalThis.fetch` (it builds its own multipart URL outside the GraphClient).
  // So we stub the global here rather than the GraphClient's injected fetch.
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uploads via /media using the injected apiVersion and returns the id', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { id: 'UPLOADED_MEDIA_ID' }));
    vi.stubGlobal('fetch', fetchImpl);
    const graph = new GraphClient({ apiVersion: API_VERSION, sleep: () => Promise.resolve() });
    const client = new WhatsAppClient({ config: CONFIG, graph, apiVersion: API_VERSION });

    const id = await client.uploadMedia(new Uint8Array([1, 2, 3]), 'image/png', 'pic.png');

    expect(id).toBe('UPLOADED_MEDIA_ID');
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(`https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/media`);
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get('type')).toBe('image/png');
    expect((init.body as FormData).get('file')).toBeInstanceOf(Blob);
  });

  it('throws a clear error when apiVersion was not injected', async () => {
    const { client } = makeClient(vi.fn());
    await expect(client.uploadMedia(new Uint8Array([1]), 'image/png')).rejects.toThrow(/apiVersion/);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Error path                                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

describe('WhatsAppClient — error handling', () => {
  it('throws MetaApiError with the parsed error code on a 400', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(400, {
        error: {
          message: 'Invalid parameter',
          type: 'OAuthException',
          code: 100,
          error_subcode: 2494010,
          fbtrace_id: 'trace-wa-400'
        }
      })
    );
    const { client } = makeClient(fetchImpl);

    let caught: unknown;
    try {
      await client.sendText('15551234567', 'boom');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(MetaApiError);
    const meta = caught as MetaApiError;
    expect(meta.httpStatus).toBe(400);
    expect(meta.errorCode).toBe(100);
    expect(meta.errorSubCode).toBe(2494010);
    expect(meta.fbtraceId).toBe('trace-wa-400');
    expect(meta.operation).toBe('whatsapp.sendText');
    // 4xx is deterministic — exactly one attempt (no retry/double-send).
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* supports()                                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

describe('WhatsAppClient.supports', () => {
  it('returns the exact capability matrix', () => {
    const { client } = makeClient(vi.fn());
    expect(client.supports('typing_indicator')).toBe(true);
    expect(client.supports('read_receipt')).toBe(true);
    expect(client.supports('reaction')).toBe(true);
    expect(client.supports('reply_to')).toBe(true);
    expect(client.supports('template')).toBe(true);
    // Wired at Stage 7 (sendImage/sendAudio/sendVideo/sendDocument + uploadMedia).
    expect(client.supports('media_send')).toBe(true);
    // Messenger/Instagram-only profile surfaces — not applicable to WhatsApp.
    expect(client.supports('persistent_menu')).toBe(false);
    expect(client.supports('get_started')).toBe(false);
    expect(client.supports('ice_breakers')).toBe(false);
    expect(client.supports('story_reply')).toBe(false);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* channel                                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

describe('WhatsAppClient', () => {
  it('advertises the whatsapp channel', () => {
    const { client } = makeClient(vi.fn());
    expect(client.channel).toBe('whatsapp');
  });
});
