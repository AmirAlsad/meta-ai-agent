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
  it('advertises the exact Stage-4 capability matrix', () => {
    const client = makeClient(vi.fn());

    expect(client.supports('typing_indicator')).toBe(true);
    expect(client.supports('read_receipt')).toBe(true);
    expect(client.supports('reply_to')).toBe(true);
    expect(client.supports('reaction')).toBe(true);

    expect(client.supports('template')).toBe(false);
    expect(client.supports('media_send')).toBe(false);
    expect(client.supports('persistent_menu')).toBe(false);
    expect(client.supports('get_started')).toBe(false);
    expect(client.supports('ice_breakers')).toBe(false);
    expect(client.supports('story_reply')).toBe(false);
  });

  it('exposes channel = "messenger"', () => {
    const client = makeClient(vi.fn());
    expect(client.channel).toBe('messenger');
  });
});
