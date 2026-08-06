/**
 * Unit tests for the optional `CHAT_ENDPOINT_API_KEY` shared secret on the
 * three clients that call the developer's endpoints — `HttpChatClient`
 * (`src/chat/client.ts`), `CommentChatClient` (`src/comments/chat.ts`), and
 * `HttpIdentityResolver` (`src/identity/resolver.ts`).
 *
 * One cross-cutting concern (one env var, one header, three call sites), so the
 * coverage lives in one file rather than being split across the three per-client
 * suites. Each client is asserted on BOTH sides of the switch:
 *
 *  - `apiKey` configured  -> exactly one added header, `X-Social-Api-Key`,
 *    carrying the value verbatim, with the content-type header untouched.
 *  - `apiKey` absent      -> the header set is byte-identical to the
 *    pre-`CHAT_ENDPOINT_API_KEY` behavior.
 *
 * `toStrictEqual`, NOT `toEqual`, is load-bearing on the absent half: `toEqual`
 * treats `{ 'X-Social-Api-Key': undefined }` as equal to `{}`, so an
 * unconditionally-added header would pass it. That regression is real, not
 * theoretical — undici stringifies an undefined header value, so the endpoint
 * would receive a literal `X-Social-Api-Key: undefined` and reject the request.
 * (Verified by mutation: making the header unconditional survives `toEqual` and
 * fails `toStrictEqual`.)
 *
 * Injected `fetchImpl` mocks throughout; no network is touched.
 */
import { describe, expect, it, vi } from 'vitest';
import { HttpChatClient } from '../../src/chat/client.js';
import { CommentChatClient } from '../../src/comments/chat.js';
import { HttpIdentityResolver } from '../../src/identity/resolver.js';
import type { ChatRequest } from '../../src/chat/types.js';
import type { CommentChatRequest } from '../../src/meta/comments/types.js';
import type { IdentityLookupRequest } from '../../src/identity/resolver.js';

const API_KEY = 'shared-secret-value';
const HEADER = 'X-Social-Api-Key';
const TIMEOUT = 30_000;

const CHAT_URL = 'https://example.test/chat';
const COMMENT_URL = 'https://example.test/comment';
const LOOKUP_URL = 'https://example.test/identity';

/** Minimal `Response`-like stub matching what the three clients read. */
function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

/** The `headers` object handed to `fetch` on the single recorded call. */
function sentHeaders(fetchImpl: typeof fetch): Record<string, string> {
  const mock = fetchImpl as unknown as ReturnType<typeof vi.fn>;
  expect(mock).toHaveBeenCalledTimes(1);
  return mock.mock.calls[0][1].headers as Record<string, string>;
}

function chatRequest(): ChatRequest {
  return {
    channel: 'whatsapp',
    conversationKey: 'whatsapp:123:456',
    message: 'hello',
    messages: [],
    capabilities: ['media_send'],
    context: { windowOpen: true }
  };
}

function commentRequest(): CommentChatRequest {
  return {
    kind: 'comment',
    channel: 'messenger',
    accountName: 'default',
    capabilities: ['reply'],
    comment: { commentId: 'c-1', text: 'nice post', timestamp: 1_785_904_977_000 }
  };
}

function lookupRequest(): IdentityLookupRequest {
  return {
    channel: 'whatsapp',
    channelScopedUserId: '15551234567',
    channelScopedBusinessId: 'pn-1'
  };
}

describe('HttpChatClient — X-Social-Api-Key', () => {
  it('sends the header with the configured value when apiKey is set', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ message: 'hi back' })
    ) as unknown as typeof fetch;

    const client = new HttpChatClient({
      chatEndpointUrl: CHAT_URL,
      timeoutMs: TIMEOUT,
      apiKey: API_KEY,
      fetchImpl
    });
    await client.complete(chatRequest());

    expect(sentHeaders(fetchImpl)).toStrictEqual({
      'Content-Type': 'application/json',
      [HEADER]: API_KEY
    });
  });

  it('sends NO auth header when apiKey is absent', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ message: 'hi back' })
    ) as unknown as typeof fetch;

    const client = new HttpChatClient({
      chatEndpointUrl: CHAT_URL,
      timeoutMs: TIMEOUT,
      fetchImpl
    });
    await client.complete(chatRequest());

    expect(sentHeaders(fetchImpl)).toStrictEqual({ 'Content-Type': 'application/json' });
  });
});

describe('CommentChatClient — X-Social-Api-Key', () => {
  it('sends the header with the configured value when apiKey is set', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ silence: true })
    ) as unknown as typeof fetch;

    const client = new CommentChatClient({
      endpointUrl: COMMENT_URL,
      timeoutMs: TIMEOUT,
      apiKey: API_KEY,
      fetchImpl
    });
    await client.complete(commentRequest());

    // Lowercase `content-type` here is this client's existing casing — the
    // assertion pins the header set as-sent, not a normalized form.
    expect(sentHeaders(fetchImpl)).toStrictEqual({
      'content-type': 'application/json',
      [HEADER]: API_KEY
    });
  });

  it('sends NO auth header when apiKey is absent', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ silence: true })
    ) as unknown as typeof fetch;

    const client = new CommentChatClient({
      endpointUrl: COMMENT_URL,
      timeoutMs: TIMEOUT,
      fetchImpl
    });
    await client.complete(commentRequest());

    expect(sentHeaders(fetchImpl)).toStrictEqual({ 'content-type': 'application/json' });
  });
});

describe('HttpIdentityResolver — X-Social-Api-Key', () => {
  it('sends the header with the configured value when apiKey is set', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ firstName: 'Ada' })
    ) as unknown as typeof fetch;

    const resolver = new HttpIdentityResolver({
      lookupUrl: LOOKUP_URL,
      timeoutMs: TIMEOUT,
      apiKey: API_KEY,
      fetchImpl
    });
    await resolver.resolve(lookupRequest());

    expect(sentHeaders(fetchImpl)).toStrictEqual({
      'Content-Type': 'application/json',
      [HEADER]: API_KEY
    });
  });

  it('sends NO auth header when apiKey is absent', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ firstName: 'Ada' })
    ) as unknown as typeof fetch;

    const resolver = new HttpIdentityResolver({
      lookupUrl: LOOKUP_URL,
      timeoutMs: TIMEOUT,
      fetchImpl
    });
    await resolver.resolve(lookupRequest());

    expect(sentHeaders(fetchImpl)).toStrictEqual({ 'Content-Type': 'application/json' });
  });
});
