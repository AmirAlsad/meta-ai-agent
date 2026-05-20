/**
 * Error thrown by the chat-endpoint client and the response normalizer.
 *
 * Wraps every failure mode of calling the developer's `CHAT_ENDPOINT_URL`:
 * non-2xx responses, network/abort/JSON-parse failures (carried via `cause`),
 * and malformed response payloads rejected by {@link normalizeChatResponse}.
 * Callers (the ConversationAgent) catch this single type rather than branching
 * on `fetch` vs. parse vs. contract errors.
 */
export class ChatEndpointError extends Error {
  // Forward `cause` to the native `Error` constructor (ES2022) so stack
  // traces and `error.cause` chaining work without a custom property.
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ChatEndpointError';
  }
}
