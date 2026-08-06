/**
 * Comment chat endpoint client + response normalizer.
 *
 * Deliberately separate from the DM `HttpChatClient`: the request carries a
 * `kind: 'comment'` discriminator and a comment-shaped body, and the response
 * vocabulary is the comment action set (`reply` / `private_reply` / `like` /
 * `silence`) rather than the DM `ChatAction` union — running it through
 * `normalizeChatResponse` would silently drop every comment verb.
 */

import type pino from 'pino';
import type {
  CommentChatAction,
  CommentChatRequest,
  NormalizedCommentChatResponse
} from '../meta/comments/types.js';

export class CommentEndpointError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = 'CommentEndpointError';
  }
}

/**
 * Collapse a raw comment endpoint response into a validated action list.
 * Tolerant in the same spirit as the DM contract: malformed actions become
 * warnings rather than throws, a legacy bare `message` string is one public
 * reply, and an empty response is explicit silence (engage-nothing is the
 * expected common case for comments).
 */
export function normalizeCommentChatResponse(payload: unknown): NormalizedCommentChatResponse {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new CommentEndpointError('Comment endpoint response must be an object');
  }
  const response = payload as Record<string, unknown>;
  const warnings: string[] = [];
  const actions: CommentChatAction[] = [];

  if (Array.isArray(response.actions)) {
    for (let i = 0; i < response.actions.length; i++) {
      const raw = response.actions[i];
      if (typeof raw !== 'object' || raw === null || typeof (raw as Record<string, unknown>).type !== 'string') {
        warnings.push(`actions[${i}]: action must be an object with a string "type"`);
        continue;
      }
      const record = raw as Record<string, unknown>;
      switch (record.type) {
        case 'reply':
        case 'private_reply': {
          const text =
            typeof record.text === 'string' && record.text.trim() !== ''
              ? record.text
              : typeof record.content === 'string' && record.content.trim() !== ''
                ? record.content
                : undefined;
          if (text === undefined) {
            warnings.push(`actions[${i}]: ${record.type} requires a non-empty "text"`);
            continue;
          }
          actions.push({ type: record.type, text });
          break;
        }
        case 'like':
          actions.push({ type: 'like' });
          break;
        case 'silence':
          // Collapsed below — a lone silence is explicit silence; silence
          // beside real actions is a no-op.
          actions.push({ type: 'silence' });
          break;
        default:
          warnings.push(`actions[${i}]: unsupported comment action type "${String(record.type)}"`);
      }
    }
  } else if (typeof response.message === 'string' && response.message.trim() !== '') {
    // Legacy convenience: a bare message string is one public reply.
    actions.push({ type: 'reply', text: response.message.trim() });
  }

  const nonSilence = actions.filter(action => action.type !== 'silence');
  const explicitSilence =
    response.silence === true || (actions.length > 0 && nonSilence.length === 0);

  if (explicitSilence && nonSilence.length > 0) {
    // silence:true beside real actions is a contradiction — drop everything,
    // matching the DM contract's mixed-silence rule.
    return {
      actions: [],
      silence: true,
      warnings: [...warnings, 'silence:true alongside actions; dropping the actions']
    };
  }

  const result: NormalizedCommentChatResponse = {
    actions: nonSilence,
    ...(explicitSilence || nonSilence.length === 0 ? { silence: true } : {})
  };
  return warnings.length > 0 ? { ...result, warnings } : result;
}

export interface CommentChatClientDeps {
  endpointUrl: string;
  timeoutMs: number;
  /**
   * OPTIONAL shared secret (`CHAT_ENDPOINT_API_KEY`), sent as `X-Social-Api-Key`.
   * Same key and header as the DM client — the comment endpoint defaults to
   * CHAT_ENDPOINT_URL, so the two surfaces are commonly one service.
   */
  apiKey?: string;
  fetchImpl?: typeof fetch;
  logger?: Pick<pino.Logger, 'warn' | 'debug'>;
}

/** POST one {@link CommentChatRequest}; returns the normalized action list. */
export class CommentChatClient {
  private readonly endpointUrl: string;
  private readonly timeoutMs: number;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly logger?: Pick<pino.Logger, 'warn' | 'debug'>;

  constructor(deps: CommentChatClientDeps) {
    this.endpointUrl = deps.endpointUrl;
    this.timeoutMs = deps.timeoutMs;
    this.apiKey = deps.apiKey;
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.logger = deps.logger;
  }

  async complete(request: CommentChatRequest): Promise<NormalizedCommentChatResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      this.logger?.debug(
        { url: this.endpointUrl, commentId: request.comment.commentId, channel: request.channel },
        'posting comment chat request'
      );
      let response: Response;
      try {
        // Shared-secret auth on the otherwise-unauthenticated hop out to the
        // developer's endpoint; the receiving service enforces the key. Omitted
        // when unset so the request bytes are unchanged. See the fuller
        // rationale at the same site in `../chat/client.ts`.
        response = await this.fetchImpl(this.endpointUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(this.apiKey !== undefined ? { 'X-Social-Api-Key': this.apiKey } : {})
          },
          body: JSON.stringify(request),
          signal: controller.signal
        });
      } catch (cause) {
        throw new CommentEndpointError('Comment endpoint request failed', { cause });
      }
      if (!response.ok) {
        throw new CommentEndpointError(`Comment endpoint returned HTTP ${response.status}`);
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch (cause) {
        throw new CommentEndpointError('Comment endpoint returned non-JSON body', { cause });
      }
      return normalizeCommentChatResponse(body);
    } finally {
      clearTimeout(timeout);
    }
  }
}
