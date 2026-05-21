import { describe, expect, it, vi } from 'vitest';
import { GraphClient } from '../../src/meta/shared/graph-client.js';
import { MetaApiError } from '../../src/meta/shared/errors.js';
import { MessengerClient } from '../../src/meta/messenger/client.js';
import type { MessengerConfig } from '../../src/config/loader.js';

/* ────────────────────────────────────────────────────────────────────────── */
/* Helpers                                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

const API_VERSION = 'v25.0';
const PAGE_ID = '1112223334';
const PAGE_ACCESS_TOKEN = 'page-access-token-xyz';
const RECIPIENT = 'psid-9988776655';
const MESSAGES_URL = `https://graph.facebook.com/${API_VERSION}/${PAGE_ID}/messages`;

const config: MessengerConfig = { pageId: PAGE_ID, pageAccessToken: PAGE_ACCESS_TOKEN };

/** A real `Response` so GraphClient's `.text()` / `.headers.get()` work. */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

/** Build a MessengerClient wired to an injected fetch mock + no-op sleep. */
function makeClient(fetchImpl: ReturnType<typeof vi.fn>) {
  const graph = new GraphClient({
    apiVersion: API_VERSION,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    // No-op sleep so any (unexpected) retry incurs zero real delay.
    sleep: () => Promise.resolve()
  });
  return new MessengerClient({ config, graph });
}

/** Parse the JSON body from a recorded fetch call's RequestInit. */
function bodyOf(fetchImpl: ReturnType<typeof vi.fn>, callIndex = 0): Record<string, unknown> {
  const init = fetchImpl.mock.calls[callIndex]![1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

/** Read a header from a recorded fetch call (headers are a plain object here). */
function headersOf(fetchImpl: ReturnType<typeof vi.fn>, callIndex = 0): Record<string, string> {
  const init = fetchImpl.mock.calls[callIndex]![1] as RequestInit;
  return init.headers as Record<string, string>;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* sendText                                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

describe('MessengerClient.sendText', () => {
  it('POSTs to {pageId}/messages with RESPONSE type and returns a SendResult from message_id', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { recipient_id: RECIPIENT, message_id: 'm_AbC123' }));
    const client = makeClient(fetchImpl);

    const before = Date.now();
    const result = await client.sendText(RECIPIENT, 'hello there');
    const after = Date.now();

    // URL is the versioned page-messages endpoint.
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]![0]).toBe(MESSAGES_URL);

    // Exact body contract.
    expect(bodyOf(fetchImpl)).toEqual({
      recipient: { id: RECIPIENT },
      messaging_type: 'RESPONSE',
      message: { text: 'hello there' }
    });

    // Token is an Authorization: Bearer header, NOT in the URL.
    expect(headersOf(fetchImpl)['authorization']).toBe(`Bearer ${PAGE_ACCESS_TOKEN}`);
    expect(fetchImpl.mock.calls[0]![0]).not.toContain(PAGE_ACCESS_TOKEN);
    expect(fetchImpl.mock.calls[0]![0]).not.toContain('access_token');

    // SendResult parsed from the response.
    expect(result.channel).toBe('messenger');
    expect(result.messageId).toBe('m_AbC123');
    expect(result.recipientId).toBe(RECIPIENT);
    expect(result.timestamp).toBeGreaterThanOrEqual(before);
    expect(result.timestamp).toBeLessThanOrEqual(after);
    expect(result.raw).toEqual({ recipient_id: RECIPIENT, message_id: 'm_AbC123' });
  });

  it('honors an explicit messagingType of UPDATE', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { message_id: 'm_upd' }));
    const client = makeClient(fetchImpl);

    await client.sendText(RECIPIENT, 'an update', { messagingType: 'UPDATE' });

    expect(bodyOf(fetchImpl)).toEqual({
      recipient: { id: RECIPIENT },
      messaging_type: 'UPDATE',
      message: { text: 'an update' }
    });
  });

  it('adds a TOP-LEVEL reply_to.mid (sibling of message, not nested) when replyTo is set', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { message_id: 'm_reply' }));
    const client = makeClient(fetchImpl);

    await client.sendText(RECIPIENT, 'replying', { replyTo: 'm_original_42' });

    const body = bodyOf(fetchImpl);
    // reply_to is a top-level body sibling — Meta rejects message.reply_to with (#100).
    expect(body).toEqual({
      recipient: { id: RECIPIENT },
      messaging_type: 'RESPONSE',
      message: { text: 'replying' },
      reply_to: { mid: 'm_original_42' }
    });
    // Critical: reply_to must NOT be nested inside message.
    expect(body['message']).not.toHaveProperty('reply_to');
  });

  it('puts tag at the top level for a MESSAGE_TAG send', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { message_id: 'm_tag' }));
    const client = makeClient(fetchImpl);

    await client.sendText(RECIPIENT, 'your appointment is soon', {
      messagingType: 'MESSAGE_TAG',
      tag: 'CONFIRMED_EVENT_UPDATE'
    });

    expect(bodyOf(fetchImpl)).toEqual({
      recipient: { id: RECIPIENT },
      messaging_type: 'MESSAGE_TAG',
      message: { text: 'your appointment is soon' },
      tag: 'CONFIRMED_EVENT_UPDATE'
    });
  });

  it('throws when MESSAGE_TAG is requested without a tag, and never calls fetch', async () => {
    const fetchImpl = vi.fn();
    const client = makeClient(fetchImpl);

    await expect(
      client.sendText(RECIPIENT, 'no tag provided', { messagingType: 'MESSAGE_TAG' })
    ).rejects.toThrow(/MESSAGE_TAG.*requires opts\.tag/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects when a 2xx response carries no message_id', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { recipient_id: RECIPIENT }));
    const client = makeClient(fetchImpl);

    await expect(client.sendText(RECIPIENT, 'will get an empty id')).rejects.toThrow(/no message id/i);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Typing indicators — separate-request constraint                             */
/* ────────────────────────────────────────────────────────────────────────── */

describe('MessengerClient typing indicators', () => {
  it('sendTypingOn POSTs a standalone sender_action with NO message key', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { recipient_id: RECIPIENT }));
    const client = makeClient(fetchImpl);

    await client.sendTypingOn(RECIPIENT);

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]![0]).toBe(MESSAGES_URL);
    const body = bodyOf(fetchImpl);
    expect(body).toEqual({ recipient: { id: RECIPIENT }, sender_action: 'typing_on' });
    // Critical: typing must not be combined with a message.
    expect(body).not.toHaveProperty('message');
  });

  it('sendTypingOff POSTs sender_action typing_off', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, {}));
    const client = makeClient(fetchImpl);

    await client.sendTypingOff(RECIPIENT);

    expect(bodyOf(fetchImpl)).toEqual({ recipient: { id: RECIPIENT }, sender_action: 'typing_off' });
  });

  it('sendTypingIndicator delegates to typing_on and ignores the messageId param', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, {}));
    const client = makeClient(fetchImpl);

    // messageId is part of the uniform signature but unused on Messenger.
    await client.sendTypingIndicator(RECIPIENT, 'm_some_inbound_id');

    const body = bodyOf(fetchImpl);
    expect(body).toEqual({ recipient: { id: RECIPIENT }, sender_action: 'typing_on' });
    expect(body).not.toHaveProperty('message');
    expect(JSON.stringify(body)).not.toContain('m_some_inbound_id');
  });

  it('keeps typing as a SEPARATE call from sendText (two distinct POSTs)', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, {})) // typing_on
      .mockResolvedValueOnce(jsonResponse(200, { message_id: 'm_after_typing' })); // text
    const client = makeClient(fetchImpl);

    await client.sendTypingOn(RECIPIENT);
    await client.sendText(RECIPIENT, 'now the actual text');

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // First call: typing only, no message.
    expect(bodyOf(fetchImpl, 0)).toEqual({ recipient: { id: RECIPIENT }, sender_action: 'typing_on' });
    // Second call: message only, no sender_action.
    const textBody = bodyOf(fetchImpl, 1);
    expect(textBody).not.toHaveProperty('sender_action');
    expect(textBody).toMatchObject({ message: { text: 'now the actual text' } });
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* mark_seen / markRead                                                         */
/* ────────────────────────────────────────────────────────────────────────── */

describe('MessengerClient read receipts', () => {
  it('markSeen POSTs sender_action mark_seen', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { recipient_id: RECIPIENT }));
    const client = makeClient(fetchImpl);

    await client.markSeen(RECIPIENT);

    expect(fetchImpl.mock.calls[0]![0]).toBe(MESSAGES_URL);
    expect(bodyOf(fetchImpl)).toEqual({ recipient: { id: RECIPIENT }, sender_action: 'mark_seen' });
  });

  it('markRead delegates to mark_seen and ignores the messageId', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, {}));
    const client = makeClient(fetchImpl);

    await client.markRead(RECIPIENT, 'm_specific_message');

    const body = bodyOf(fetchImpl);
    expect(body).toEqual({ recipient: { id: RECIPIENT }, sender_action: 'mark_seen' });
    expect(JSON.stringify(body)).not.toContain('m_specific_message');
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Reactions — sender_action react / unreact                                   */
/* ────────────────────────────────────────────────────────────────────────── */

describe('MessengerClient.sendReaction', () => {
  it('reacts via sender_action:react with the emoji nested inside payload', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { recipient_id: RECIPIENT }));
    const client = makeClient(fetchImpl);

    await client.sendReaction(RECIPIENT, 'm_target', '👍');

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]![0]).toBe(MESSAGES_URL);
    const body = bodyOf(fetchImpl);
    // emoji lives INSIDE payload as `reaction`, not as a sibling field.
    expect(body).toEqual({
      recipient: { id: RECIPIENT },
      sender_action: 'react',
      payload: { message_id: 'm_target', reaction: '👍' }
    });
    // A sender_action must be a standalone request — never combined with a message.
    expect(body).not.toHaveProperty('message');
  });

  it('unreacts via sender_action:unreact with an empty emoji (no reaction key)', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { recipient_id: RECIPIENT }));
    const client = makeClient(fetchImpl);

    await client.sendReaction(RECIPIENT, 'm_target', '');

    const body = bodyOf(fetchImpl);
    expect(body).toEqual({
      recipient: { id: RECIPIENT },
      sender_action: 'unreact',
      payload: { message_id: 'm_target' }
    });
    expect(body.payload).not.toHaveProperty('reaction');
    expect(body).not.toHaveProperty('message');
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Media sends — message.attachment with a URL payload                         */
/* ────────────────────────────────────────────────────────────────────────── */

describe('MessengerClient media sends', () => {
  const IMAGE_URL = 'https://cdn.example.com/pic.jpg';
  const AUDIO_URL = 'https://cdn.example.com/clip.mp3';
  const VIDEO_URL = 'https://cdn.example.com/movie.mp4';
  const FILE_URL = 'https://cdn.example.com/report.pdf';

  /** Expected attachment body for a given media type + url (is_reusable:false). */
  function attachmentBody(type: string, url: string) {
    return {
      recipient: { id: RECIPIENT },
      messaging_type: 'RESPONSE',
      message: { attachment: { type, payload: { url, is_reusable: false } } }
    };
  }

  it('sendImage POSTs an image attachment and returns a SendResult from message_id', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { recipient_id: RECIPIENT, message_id: 'm_img1' }));
    const client = makeClient(fetchImpl);

    const before = Date.now();
    const result = await client.sendImage(RECIPIENT, IMAGE_URL);
    const after = Date.now();

    // Versioned page-messages endpoint.
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]![0]).toBe(MESSAGES_URL);

    // Exact body contract: attachment type + payload.url + is_reusable:false.
    expect(bodyOf(fetchImpl)).toEqual(attachmentBody('image', IMAGE_URL));

    // Token is an Authorization: Bearer header, NOT in the URL.
    expect(headersOf(fetchImpl)['authorization']).toBe(`Bearer ${PAGE_ACCESS_TOKEN}`);
    expect(fetchImpl.mock.calls[0]![0]).not.toContain(PAGE_ACCESS_TOKEN);
    expect(fetchImpl.mock.calls[0]![0]).not.toContain('access_token');

    // SendResult parsed from the response.
    expect(result.channel).toBe('messenger');
    expect(result.messageId).toBe('m_img1');
    expect(result.recipientId).toBe(RECIPIENT);
    expect(result.timestamp).toBeGreaterThanOrEqual(before);
    expect(result.timestamp).toBeLessThanOrEqual(after);
    expect(result.raw).toEqual({ recipient_id: RECIPIENT, message_id: 'm_img1' });
  });

  it('sendAudio POSTs an audio attachment with is_reusable:false', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { message_id: 'm_aud1' }));
    const client = makeClient(fetchImpl);

    const result = await client.sendAudio(RECIPIENT, AUDIO_URL);

    expect(fetchImpl.mock.calls[0]![0]).toBe(MESSAGES_URL);
    expect(bodyOf(fetchImpl)).toEqual(attachmentBody('audio', AUDIO_URL));
    expect(headersOf(fetchImpl)['authorization']).toBe(`Bearer ${PAGE_ACCESS_TOKEN}`);
    expect(result.messageId).toBe('m_aud1');
  });

  it('sendVideo POSTs a video attachment with is_reusable:false', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { message_id: 'm_vid1' }));
    const client = makeClient(fetchImpl);

    const result = await client.sendVideo(RECIPIENT, VIDEO_URL);

    expect(fetchImpl.mock.calls[0]![0]).toBe(MESSAGES_URL);
    expect(bodyOf(fetchImpl)).toEqual(attachmentBody('video', VIDEO_URL));
    expect(result.messageId).toBe('m_vid1');
  });

  it('sendFile POSTs a file attachment (type:file, not document) with is_reusable:false', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { message_id: 'm_file1' }));
    const client = makeClient(fetchImpl);

    const result = await client.sendFile(RECIPIENT, FILE_URL);

    expect(fetchImpl.mock.calls[0]![0]).toBe(MESSAGES_URL);
    // Messenger's document attachment type is literally 'file'.
    expect(bodyOf(fetchImpl)).toEqual(attachmentBody('file', FILE_URL));
    expect(result.messageId).toBe('m_file1');
  });

  it('defaults is_reusable to false but honors opts.isReusable = true', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { message_id: 'm_reuse' }));
    const client = makeClient(fetchImpl);

    await client.sendImage(RECIPIENT, IMAGE_URL, { isReusable: true });

    expect(bodyOf(fetchImpl)).toEqual({
      recipient: { id: RECIPIENT },
      messaging_type: 'RESPONSE',
      message: { attachment: { type: 'image', payload: { url: IMAGE_URL, is_reusable: true } } }
    });
  });

  it('wraps a 400 from a media send in MetaApiError (no retry)', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(400, {
        error: {
          message: 'Invalid attachment url.',
          type: 'OAuthException',
          code: 100,
          fbtrace_id: 'MediaTrace'
        }
      })
    );
    const client = makeClient(fetchImpl);

    let thrown: unknown;
    try {
      await client.sendImage(RECIPIENT, IMAGE_URL);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(MetaApiError);
    const apiError = thrown as MetaApiError;
    expect(apiError.operation).toBe('messenger.sendImage');
    expect(apiError.httpStatus).toBe(400);
    expect(apiError.errorCode).toBe(100);
    // 400 is a deterministic client error — not retried (single fetch call).
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* sendMedia (uniform ChannelAdapter entry point → per-kind attachment body)   */
/* ────────────────────────────────────────────────────────────────────────── */

describe('MessengerClient.sendMedia', () => {
  const URL_ = 'https://cdn.example.com/asset.bin';

  /** Expected attachment body for a given Messenger attachment type. */
  function attachmentBody(type: string) {
    return {
      recipient: { id: RECIPIENT },
      messaging_type: 'RESPONSE',
      message: { attachment: { type, payload: { url: URL_, is_reusable: false } } }
    };
  }

  it.each([
    ['image', 'image'],
    ['audio', 'audio'],
    ['video', 'video']
  ] as const)('kind %s → attachment type %s', async (kind, type) => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { message_id: `m_${kind}` }));
    const client = makeClient(fetchImpl);

    const result = await client.sendMedia(RECIPIENT, { kind, mediaIdOrUrl: URL_ });

    expect(fetchImpl.mock.calls[0]![0]).toBe(MESSAGES_URL);
    expect(bodyOf(fetchImpl)).toEqual(attachmentBody(type));
    expect(result.messageId).toBe(`m_${kind}`);
  });

  it('kind document → routes to sendFile (attachment type "file", NOT "document")', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { message_id: 'm_doc' }));
    const client = makeClient(fetchImpl);

    const result = await client.sendMedia(RECIPIENT, {
      kind: 'document',
      mediaIdOrUrl: URL_,
      filename: 'ignored-by-messenger.pdf'
    });

    // Messenger's document attachment type is literally 'file'.
    expect(bodyOf(fetchImpl)).toEqual(attachmentBody('file'));
    expect(result.messageId).toBe('m_doc');
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Error path                                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

describe('MessengerClient error handling', () => {
  it('wraps a 400 Meta error JSON in MetaApiError with the parsed errorCode', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(400, {
        error: {
          message: 'Invalid OAuth access token.',
          type: 'OAuthException',
          code: 190,
          error_subcode: 463,
          fbtrace_id: 'AbCdEfTrace'
        }
      })
    );
    const client = makeClient(fetchImpl);

    let thrown: unknown;
    try {
      await client.sendText(RECIPIENT, 'will fail');
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(MetaApiError);
    const apiError = thrown as MetaApiError;
    expect(apiError.operation).toBe('messenger.sendText');
    expect(apiError.httpStatus).toBe(400);
    expect(apiError.errorCode).toBe(190);
    expect(apiError.errorSubCode).toBe(463);
    expect(apiError.fbtraceId).toBe('AbCdEfTrace');
    // 400 is a deterministic client error — not retried (single fetch call).
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* supports() capability matrix                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

describe('MessengerClient.supports', () => {
  it('advertises the exact capability matrix', () => {
    const client = makeClient(vi.fn());

    expect(client.supports('typing_indicator')).toBe(true);
    expect(client.supports('read_receipt')).toBe(true);
    expect(client.supports('reply_to')).toBe(true);
    expect(client.supports('reaction')).toBe(true);
    // Stage 7: media send is now supported.
    expect(client.supports('media_send')).toBe(true);
    // Profile surfaces are configured out-of-band via the Messenger Profile API
    // (MessengerProfileClient) and are now advertised as supported.
    expect(client.supports('persistent_menu')).toBe(true);
    expect(client.supports('get_started')).toBe(true);
    expect(client.supports('ice_breakers')).toBe(true);

    expect(client.supports('template')).toBe(false);
    expect(client.supports('story_reply')).toBe(false);
  });

  it('exposes channel = "messenger"', () => {
    const client = makeClient(vi.fn());
    expect(client.channel).toBe('messenger');
  });
});
