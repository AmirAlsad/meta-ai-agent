import { describe, expect, it, vi } from 'vitest';
import { GraphClient } from '../../src/meta/shared/graph-client.js';
import { MetaApiError } from '../../src/meta/shared/errors.js';
import { InstagramClient } from '../../src/meta/instagram/client.js';
import type { InstagramConfig } from '../../src/config/loader.js';

/* ────────────────────────────────────────────────────────────────────────── */
/* Helpers                                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

const API_VERSION = 'v25.0';
const USER_ID = '17841400000000000';
const ACCESS_TOKEN = 'IGAA-super-secret-token';
const MESSAGES_URL = `https://graph.instagram.com/${API_VERSION}/${USER_ID}/messages`;

const CONFIG: InstagramConfig = {
  userId: USER_ID,
  accessToken: ACCESS_TOKEN
};

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  });
}

/** A recording sleep that resolves immediately — NO real delay in tests. */
function recordingSleep(): { fn: (ms: number) => Promise<void>; calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    fn: (ms: number) => {
      calls.push(ms);
      return Promise.resolve();
    }
  };
}

/** A clock whose value the test controls explicitly. */
function controllableClock(start = 0): { now: () => number; set: (t: number) => void; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    set: (v: number) => {
      t = v;
    },
    advance: (ms: number) => {
      t += ms;
    }
  };
}

/**
 * Build an InstagramClient over a GraphClient with an injected fetch mock.
 * The GraphClient's OWN retry sleep is a separate recorder from the client's
 * rate-pacer sleep so the two cannot be confused in assertions.
 */
function makeClient(
  fetchImpl: ReturnType<typeof vi.fn>,
  opts: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {}
) {
  const graph = new GraphClient({
    apiVersion: API_VERSION,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleep: recordingSleep().fn // GraphClient retry sleep — unused in these tests.
  });
  const client = new InstagramClient({
    config: CONFIG,
    graph,
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.sleep ? { sleep: opts.sleep } : {})
  });
  return { client, graph };
}

/** Pull the [url, init] of the Nth fetch call and parse its JSON body. */
function callAt(fetchImpl: ReturnType<typeof vi.fn>, index: number): { url: string; init: RequestInit; body: unknown } {
  const [url, init] = fetchImpl.mock.calls[index] ?? [];
  const reqInit = init as RequestInit;
  const body = typeof reqInit?.body === 'string' ? JSON.parse(reqInit.body) : undefined;
  return { url: String(url), init: reqInit, body };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* sendText                                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

describe('InstagramClient.sendText', () => {
  it('POSTs to graph.instagram.com /{userId}/messages with the recipient+message body', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, { recipient_id: '987', message_id: 'mid.IG_ABC' })
    );
    const { client } = makeClient(fetchImpl);

    const result = await client.sendText('987', 'hello there');

    expect(fetchImpl).toHaveBeenCalledOnce();
    const { url, init, body } = callAt(fetchImpl, 0);

    // Exact host + URL (graph.instagram.com, NOT graph.facebook.com).
    expect(url).toBe(MESSAGES_URL);
    expect(init.method).toBe('POST');

    // Exact request body.
    expect(body).toEqual({
      recipient: { id: '987' },
      message: { text: 'hello there' }
    });

    // Token is a Bearer header, NEVER in the URL.
    const headers = init.headers as Record<string, string>;
    expect(headers['authorization']).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(url).not.toContain(ACCESS_TOKEN);
    expect(url).not.toContain('access_token');

    // SendResult parsed from message_id.
    expect(result).toMatchObject({
      channel: 'instagram',
      messageId: 'mid.IG_ABC',
      recipientId: '987'
    });
    expect(typeof result.timestamp).toBe('number');
    expect(result.raw).toEqual({ recipient_id: '987', message_id: 'mid.IG_ABC' });
  });

  it('IGNORES opts.replyTo entirely — the body has NO reply_to / reply_to_message_id (the text still sends)', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { message_id: 'mid.IG_REPLY' }));
    const { client } = makeClient(fetchImpl);

    await client.sendText('987', 'a reply', { replyTo: 'someMid' });

    const { body } = callAt(fetchImpl, 0) as { body: Record<string, unknown> };
    // Instagram-Login Send API does not support outbound quoted replies (verified
    // 2026-05-20): replyTo is silently dropped, leaving a plain text-only body.
    // The conversation agent downgrades reply→message so the user still gets text.
    expect(body).toEqual({
      recipient: { id: '987' },
      message: { text: 'a reply' }
    });
    expect(body).not.toHaveProperty('reply_to');
    expect(body).not.toHaveProperty('reply_to_message_id');
    expect(body['message']).not.toHaveProperty('reply_to');
  });

  it('throws when a 2xx response carries no message_id', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { recipient_id: '987' }));
    const { client } = makeClient(fetchImpl);
    await expect(client.sendText('987', 'x')).rejects.toThrow(/no message id/i);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Typing indicator (separate request)                                         */
/* ────────────────────────────────────────────────────────────────────────── */

describe('InstagramClient typing indicator', () => {
  it('sendTypingOn sends a standalone sender_action: typing_on request', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, {}));
    const { client } = makeClient(fetchImpl);

    await client.sendTypingOn('987');

    expect(fetchImpl).toHaveBeenCalledOnce();
    const { url, body } = callAt(fetchImpl, 0);
    expect(url).toBe(MESSAGES_URL);
    // No `message` key — typing must NOT be combined with a message.
    expect(body).toEqual({ recipient: { id: '987' }, sender_action: 'typing_on' });
  });

  it('adapter sendTypingIndicator delegates to a typing_on request (messageId ignored)', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, {}));
    const { client } = makeClient(fetchImpl);

    await client.sendTypingIndicator('987', 'mid.IGNORED');

    const { body } = callAt(fetchImpl, 0);
    expect(body).toEqual({ recipient: { id: '987' }, sender_action: 'typing_on' });
  });

  it('sends typing as a SEPARATE request from a text message (two distinct fetches)', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, {})) // typing_on
      .mockResolvedValueOnce(jsonResponse(200, { message_id: 'mid.IG_TXT' })); // text
    // Use a non-blocking clock so pacing does not gate this ordering check.
    const clock = controllableClock(0);
    const sleep = recordingSleep();
    const { client } = makeClient(fetchImpl, { now: clock.now, sleep: sleep.fn });

    await client.sendTypingOn('987');
    clock.advance(1000); // simulate >500ms passing so the 2nd call is not paced
    await client.sendText('987', 'hi');

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(callAt(fetchImpl, 0).body).toEqual({ recipient: { id: '987' }, sender_action: 'typing_on' });
    expect(callAt(fetchImpl, 1).body).toEqual({ recipient: { id: '987' }, message: { text: 'hi' } });
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* mark_seen                                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

describe('InstagramClient mark seen', () => {
  it('markSeen sends a sender_action: mark_seen request', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, {}));
    const { client } = makeClient(fetchImpl);

    await client.markSeen('987');

    const { url, body } = callAt(fetchImpl, 0);
    expect(url).toBe(MESSAGES_URL);
    expect(body).toEqual({ recipient: { id: '987' }, sender_action: 'mark_seen' });
  });

  it('adapter markRead delegates to mark_seen (messageId ignored)', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, {}));
    const { client } = makeClient(fetchImpl);

    await client.markRead('987', 'mid.IGNORED');

    const { body } = callAt(fetchImpl, 0);
    expect(body).toEqual({ recipient: { id: '987' }, sender_action: 'mark_seen' });
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Reactions — sender_action react / unreact                                   */
/* ────────────────────────────────────────────────────────────────────────── */

describe('InstagramClient.sendReaction', () => {
  it('reacts via sender_action:react with the emoji nested inside payload', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, {}));
    const { client } = makeClient(fetchImpl);

    await client.sendReaction('987', 'mid.X', '❤️');

    expect(fetchImpl).toHaveBeenCalledOnce();
    const { url, body } = callAt(fetchImpl, 0);
    expect(url).toBe(MESSAGES_URL);
    // emoji lives INSIDE payload as `reaction`, not as a sibling field.
    expect(body).toEqual({
      recipient: { id: '987' },
      sender_action: 'react',
      payload: { message_id: 'mid.X', reaction: '❤️' }
    });
    // A sender_action must be a standalone request — never combined with a message.
    expect(body).not.toHaveProperty('message');
  });

  it('unreacts via sender_action:unreact with an empty emoji (no reaction key)', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, {}));
    const { client } = makeClient(fetchImpl);

    await client.sendReaction('987', 'mid.X', '');

    const { body } = callAt(fetchImpl, 0) as { body: Record<string, unknown> };
    expect(body).toEqual({
      recipient: { id: '987' },
      sender_action: 'unreact',
      payload: { message_id: 'mid.X' }
    });
    expect(body.payload).not.toHaveProperty('reaction');
    expect(body).not.toHaveProperty('message');
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Rate pacing (default 100ms floor — 10/sec media sub-limit), via injected clock */
/* ────────────────────────────────────────────────────────────────────────── */

describe('InstagramClient rate pacing', () => {
  it('paces a back-to-back burst: 2nd call sleeps the remaining ms to honor the 100ms floor', async () => {
    // Fresh Response per call: a Response body is a one-shot stream, so a
    // single shared instance would fail the second read.
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(200, { message_id: 'mid.IG' })));
    const clock = controllableClock(1000);
    const sleep = recordingSleep();
    const { client } = makeClient(fetchImpl, { now: clock.now, sleep: sleep.fn });

    // Two sends fired back-to-back at the SAME clock time (no time advances
    // between them) — the clock is frozen, modeling two near-simultaneous calls.
    await Promise.all([client.sendText('987', 'one'), client.sendText('987', 'two')]);

    // Both eventually fetched.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // First call: clock is at 1000, lastCallAt starts 0 → no wait.
    // Second call: reserved slot is firstSlot(1000) + 100 = 1100; now is still
    // 1000 → must sleep the remaining 100ms (the default floor).
    expect(sleep.calls).toEqual([100]);
  });

  it('honors a custom minIntervalMs override for the burst floor', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(200, { message_id: 'mid.IG' })));
    const clock = controllableClock(1000);
    const sleep = recordingSleep();
    const graph = new GraphClient({
      apiVersion: API_VERSION,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: recordingSleep().fn
    });
    const client = new InstagramClient({
      config: CONFIG,
      graph,
      now: clock.now,
      sleep: sleep.fn,
      minIntervalMs: 250
    });

    await Promise.all([client.sendText('987', 'one'), client.sendText('987', 'two')]);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // Second call's reserved slot is 1000 + 250 = 1250; now is still 1000 → 250ms.
    expect(sleep.calls).toEqual([250]);
  });

  it('does not sleep when enough time has already elapsed between calls', async () => {
    // Fresh Response per call (one-shot body stream — see note above).
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(200, { message_id: 'mid.IG' })));
    const clock = controllableClock(1000);
    const sleep = recordingSleep();
    const { client } = makeClient(fetchImpl, { now: clock.now, sleep: sleep.fn });

    await client.sendText('987', 'one');
    clock.advance(150); // > 100ms floor elapsed before the next call
    await client.sendText('987', 'two');

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep.calls).toEqual([]); // no pacing needed
  });

  it('serializes concurrent calls so the second fetch happens AFTER pacing', async () => {
    // Make fetch resolution observable in order: record the body at fetch time.
    const fetchOrder: string[] = [];
    const fetchImpl = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      const parsed = JSON.parse(init.body as string) as { message: { text: string } };
      fetchOrder.push(parsed.message.text);
      return Promise.resolve(jsonResponse(200, { message_id: 'mid.IG' }));
    });
    const clock = controllableClock(1000);
    // A sleep that advances the controllable clock by the slept amount, so the
    // serialized pacer's time bookkeeping stays consistent with "time passing".
    const sleep = (ms: number): Promise<void> => {
      clock.advance(ms);
      return Promise.resolve();
    };
    const { client } = makeClient(fetchImpl, { now: clock.now, sleep });

    await Promise.all([client.sendText('987', 'first'), client.sendText('987', 'second')]);

    // The second send must not jump ahead of the first — pacer serializes them.
    expect(fetchOrder).toEqual(['first', 'second']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Error path                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

describe('InstagramClient error handling', () => {
  it('surfaces a 400 Meta error as MetaApiError with the parsed error code', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(400, {
        error: {
          message: 'Invalid recipient',
          type: 'OAuthException',
          code: 100,
          error_subcode: 2534001,
          fbtrace_id: 'trace-ig-400'
        }
      })
    );
    const { client } = makeClient(fetchImpl);

    let caught: unknown;
    try {
      await client.sendText('987', 'x');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MetaApiError);
    const meta = caught as MetaApiError;
    expect(meta.operation).toBe('instagram.sendText');
    expect(meta.httpStatus).toBe(400);
    expect(meta.errorCode).toBe(100);
    expect(meta.errorSubCode).toBe(2534001);
    expect(meta.fbtraceId).toBe('trace-ig-400');
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* supports() matrix                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

describe('InstagramClient.supports', () => {
  it('advertises exactly the Stage-4 Instagram capability matrix', () => {
    const { client } = makeClient(vi.fn());
    expect(client.channel).toBe('instagram');

    expect(client.supports('typing_indicator')).toBe(true);
    expect(client.supports('read_receipt')).toBe(true);
    // reply_to is FALSE — Instagram-Login Send API has no working outbound quoted
    // reply (verified 2026-05-20); the agent downgrades reply→plain message.
    expect(client.supports('reply_to')).toBe(false);
    expect(client.supports('reaction')).toBe(true);

    expect(client.supports('template')).toBe(false);
    expect(client.supports('media_send')).toBe(false);
    expect(client.supports('story_reply')).toBe(false);
    expect(client.supports('ice_breakers')).toBe(false);
    expect(client.supports('persistent_menu')).toBe(false);
    expect(client.supports('get_started')).toBe(false);
  });
});
