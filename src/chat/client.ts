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
  complete(request: ChatRequest): Promise<NormalizedChatResponse>;
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

  async complete(request: ChatRequest): Promise<NormalizedChatResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

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
    }
  }
}
