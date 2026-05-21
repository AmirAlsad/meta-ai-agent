/**
 * Unit tests for `HttpChatClient` (`src/chat/client.ts`).
 *
 * Uses an injected `fetchImpl` mock so no real network is touched. Asserts the
 * request shape (URL / method / content-type / serialized body), normalized
 * happy path, non-2xx + network + timeout failure modes (all surfacing as
 * `ChatEndpointError`), and that `complete` returns an ALREADY-normalized
 * response.
 */
import { describe, expect, it, vi } from 'vitest';
import { HttpChatClient, ChatEndpointError } from '../../src/chat/client.js';
import type { ChatRequest } from '../../src/chat/types.js';

const URL_ = 'https://example.test/chat';
const TIMEOUT = 30_000;

function makeRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    channel: 'whatsapp',
    conversationKey: 'whatsapp:123:456',
    message: 'hello',
    messages: [],
    capabilities: ['media_send'],
    context: { windowOpen: true },
    ...overrides
  };
}

/** Minimal `Response`-like stub matching what `complete` reads (`ok`/`status`/`json`). */
function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body
  } as unknown as Response;
}

describe('HttpChatClient.complete — happy path', () => {
  it('POSTs the serialized ChatRequest and returns normalized actions', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ message: 'hi back' })
    ) as unknown as typeof fetch;

    const client = new HttpChatClient({ chatEndpointUrl: URL_, timeoutMs: TIMEOUT, fetchImpl });
    const request = makeRequest();
    const result = await client.complete(request);

    // Returns the normalized form, not the raw body.
    expect(result).toEqual({ actions: [{ type: 'message', text: 'hi back' }] });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(calledUrl).toBe(URL_);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(init.body).toBe(JSON.stringify(request));
    // An AbortSignal is wired up for the timeout.
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('normalizes rich actions end-to-end', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ actions: [{ type: 'silence' }] })
    ) as unknown as typeof fetch;
    const client = new HttpChatClient({ chatEndpointUrl: URL_, timeoutMs: TIMEOUT, fetchImpl });

    expect(await client.complete(makeRequest())).toEqual({ actions: [], silence: true });
  });

  it('logs a warning when the normalized response carries warnings', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ actions: [{ type: 'reply', text: 'no target' }] })
    ) as unknown as typeof fetch;
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const client = new HttpChatClient({ chatEndpointUrl: URL_, timeoutMs: TIMEOUT, fetchImpl, logger });

    const result = await client.complete(makeRequest());
    expect(result.warnings?.[0].code).toBe('invalid-action');
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe('HttpChatClient.complete — failure modes', () => {
  it('throws ChatEndpointError mentioning the status on non-2xx, without normalizing', async () => {
    const json = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json
    } as unknown as Response) as unknown as typeof fetch;

    const client = new HttpChatClient({ chatEndpointUrl: URL_, timeoutMs: TIMEOUT, fetchImpl });
    await expect(client.complete(makeRequest())).rejects.toThrow(ChatEndpointError);
    await expect(client.complete(makeRequest())).rejects.toThrow('failed with 500');
    // Body is never read on a non-2xx response.
    expect(json).not.toHaveBeenCalled();
  });

  it('wraps a network rejection as ChatEndpointError with cause set', async () => {
    const network = new Error('ECONNREFUSED');
    const fetchImpl = vi.fn().mockRejectedValue(network) as unknown as typeof fetch;
    const client = new HttpChatClient({ chatEndpointUrl: URL_, timeoutMs: TIMEOUT, fetchImpl });

    const error = await client.complete(makeRequest()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChatEndpointError);
    expect((error as ChatEndpointError).message).toBe('Chat endpoint request failed');
    expect((error as ChatEndpointError).cause).toBe(network);
  });

  it('wraps a JSON parse failure as ChatEndpointError with cause set', async () => {
    const parseError = new SyntaxError('Unexpected token');
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw parseError;
      }
    } as unknown as Response) as unknown as typeof fetch;
    const client = new HttpChatClient({ chatEndpointUrl: URL_, timeoutMs: TIMEOUT, fetchImpl });

    const error = await client.complete(makeRequest()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChatEndpointError);
    expect((error as ChatEndpointError).cause).toBe(parseError);
  });

  it('rethrows a contract rejection (malformed body) as ChatEndpointError', async () => {
    // A 200 with an unrecognized object -> normalizeChatResponse throws
    // ChatEndpointError, which must pass through unwrapped (no double-wrap).
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ foo: 1 })) as unknown as typeof fetch;
    const client = new HttpChatClient({ chatEndpointUrl: URL_, timeoutMs: TIMEOUT, fetchImpl });

    const error = await client.complete(makeRequest()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChatEndpointError);
    // Came straight from the normalizer, not the generic wrapper.
    expect((error as ChatEndpointError).message).toContain('did not include');
  });

  it('aborts on timeout and surfaces a ChatEndpointError', async () => {
    // Deterministic timeout: the fake fetch rejects with an AbortError as soon
    // as the AbortController fires, mirroring how the platform `fetch` behaves.
    const fetchImpl = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        })
    ) as unknown as typeof fetch;

    // Tiny timeout so the real setTimeout fires quickly; deterministic outcome.
    const client = new HttpChatClient({ chatEndpointUrl: URL_, timeoutMs: 5, fetchImpl });
    const error = await client.complete(makeRequest()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChatEndpointError);
    expect((error as ChatEndpointError).message).toBe('Chat endpoint request failed');
    expect(((error as ChatEndpointError).cause as Error).name).toBe('AbortError');
  });

  it('rejects with ChatEndpointError when the EXTERNAL abort signal fires', async () => {
    // The agent passes an external AbortController.signal to cancel an in-flight
    // chat call (interrupt/rebatch). A fake fetch that respects the signal must
    // reject as AbortError when the external controller aborts, surfacing as a
    // wrapped ChatEndpointError.
    const fetchImpl = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        })
    ) as unknown as typeof fetch;

    // Large timeout so ONLY the external signal can abort the call.
    const client = new HttpChatClient({ chatEndpointUrl: URL_, timeoutMs: 60_000, fetchImpl });
    const external = new AbortController();
    const promise = client.complete(makeRequest(), external.signal);
    external.abort();

    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChatEndpointError);
    expect(((error as ChatEndpointError).cause as Error).name).toBe('AbortError');
  });

  it('rejects immediately when given an already-aborted external signal', async () => {
    const fetchImpl = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        })
    ) as unknown as typeof fetch;
    const client = new HttpChatClient({ chatEndpointUrl: URL_, timeoutMs: 60_000, fetchImpl });

    const error = await client
      .complete(makeRequest(), AbortSignal.abort())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChatEndpointError);
  });

  it('clears the timeout after a successful call (no dangling timer)', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ message: 'ok' })) as unknown as typeof fetch;
    const client = new HttpChatClient({ chatEndpointUrl: URL_, timeoutMs: TIMEOUT, fetchImpl });

    await client.complete(makeRequest());
    expect(clearSpy).toHaveBeenCalled();
  });
});

describe('HttpChatClient — fetch default', () => {
  it('falls back to globalThis.fetch when no fetchImpl is injected', () => {
    // Construction alone must not throw; we are asserting the default wiring,
    // not making a real call.
    const client = new HttpChatClient({ chatEndpointUrl: URL_, timeoutMs: TIMEOUT });
    expect(client).toBeInstanceOf(HttpChatClient);
  });
});
