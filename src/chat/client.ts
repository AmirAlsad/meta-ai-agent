/**
 * HTTP client for the developer's chat endpoint.
 *
 * {@link HttpChatClient.complete} POSTs a {@link ChatRequest} to
 * `CHAT_ENDPOINT_URL`, enforces a hard timeout via an {@link AbortController},
 * and returns an already-normalized {@link NormalizedChatResponse} (it runs
 * {@link normalizeChatResponse} on the body before resolving). Every failure
 * mode — non-2xx, network error, abort/timeout, JSON parse, malformed payload
 * — surfaces as a single {@link ChatEndpointError}, so the ConversationAgent
 * catches one type instead of branching on transport vs. contract failures.
 */
import type pino from 'pino';
import type { ChatRequest, NormalizedChatResponse } from './types.js';
import { normalizeChatResponse } from './contract.js';
import { ChatEndpointError } from './errors.js';

// Re-export for convenience so callers can `import { ChatClient,
// normalizeChatResponse, ChatEndpointError } from '../chat/client.js'`.
export { normalizeChatResponse } from './contract.js';
export { ChatEndpointError } from './errors.js';

export interface ChatClient {
  /**
   * Dispatch one chat request. An OPTIONAL external `signal` lets the caller
   * abort an in-flight call (the ConversationAgent uses this to cancel a flush's
   * chat call when a late message arrives, so the two can be rebatched into one
   * response). When the external signal aborts, `complete` rejects (a
   * {@link ChatEndpointError} wrapping the AbortError) — the agent catches it and
   * routes to its reprocess path.
   */
  complete(request: ChatRequest, signal?: AbortSignal): Promise<NormalizedChatResponse>;
}

export interface HttpChatClientDeps {
  chatEndpointUrl: string;
  timeoutMs: number;
  /** Injectable for tests; defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  logger?: Pick<pino.Logger, 'warn' | 'debug'>;
}

export class HttpChatClient implements ChatClient {
  private readonly chatEndpointUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly logger?: Pick<pino.Logger, 'warn' | 'debug'>;

  constructor(deps: HttpChatClientDeps) {
    this.chatEndpointUrl = deps.chatEndpointUrl;
    this.timeoutMs = deps.timeoutMs;
    // Bind to `globalThis` so the default `fetch` keeps its correct receiver.
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.logger = deps.logger;
  }

  async complete(request: ChatRequest, signal?: AbortSignal): Promise<NormalizedChatResponse> {
    // The fetch is aborted if EITHER the internal timeout fires OR the optional
    // external signal aborts. We combine them onto one controller manually rather
    // than relying on AbortSignal.any (keeps the floor at plain Node 20 without a
    // version probe). The external listener is removed in `finally` so a settled
    // call never leaves a dangling listener on a long-lived caller signal.
    // Already-aborted external signal: short-circuit before allocating a timer or
    // touching the network. Real `fetch` rejects immediately on a pre-aborted
    // signal, so we mirror that as a wrapped AbortError (no fetch impl required to
    // model it).
    if (signal?.aborted) {
      throw new ChatEndpointError('Chat endpoint request aborted', {
        cause: Object.assign(new Error('aborted'), { name: 'AbortError' })
      });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let onExternalAbort: (() => void) | undefined;
    if (signal) {
      onExternalAbort = () => controller.abort();
      signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    try {
      this.logger?.debug(
        { url: this.chatEndpointUrl, conversationKey: request.conversationKey, channel: request.channel },
        'calling chat endpoint'
      );

      const response = await this.fetchImpl(this.chatEndpointUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: controller.signal
      });

      if (!response.ok) {
        // Non-2xx is a definitive failure — do not attempt to normalize a body
        // that the endpoint never promised would be a valid chat response.
        throw new ChatEndpointError(`Chat endpoint failed with ${response.status}`);
      }

      const normalized = normalizeChatResponse(await response.json());
      if (normalized.warnings && normalized.warnings.length > 0) {
        this.logger?.warn(
          { conversationKey: request.conversationKey, warnings: normalized.warnings },
          'chat endpoint response had normalization warnings'
        );
      }
      return normalized;
    } catch (error) {
      // ChatEndpointError (non-2xx above, or a contract rejection from the
      // normalizer) is already the right type — rethrow unchanged.
      if (error instanceof ChatEndpointError) throw error;
      // Everything else (network failure, AbortError from the timeout, JSON
      // parse error) is wrapped so callers see one error type with the
      // original failure preserved on `cause`.
      throw new ChatEndpointError('Chat endpoint request failed', { cause: error });
    } finally {
      clearTimeout(timeout);
      if (signal && onExternalAbort) signal.removeEventListener('abort', onExternalAbort);
    }
  }
}
