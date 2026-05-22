/**
 * Chat contract types.
 *
 * The request shape sent to the developer's `CHAT_ENDPOINT_URL` and the
 * response shapes it may return. Mirrors the SendBlue repo's contract:
 * preserve the legacy top-level `message` string plus `messages[]` / `silence`
 * forms for backward compatibility, with all rich behavior expressed through
 * `actions[]`. The HTTP client and the `normalizeChatResponse` collapser land
 * later in Stage 5 (`src/chat/client.ts`, `src/chat/contract.ts`).
 */

import type { Channel, IncomingMessage } from '../meta/types.js';
import type { ChannelFeature } from '../meta/shared/adapter.js';
// `TemplateComponent` lives in the shared transport-contract module, not the
// WhatsApp client — importing it from `../meta/whatsapp/client.js` would couple
// `chat` to a concrete transport client. See `src/meta/shared/adapter.ts`.
import type { TemplateComponent } from '../meta/shared/adapter.js';
import type { Contact } from '../identity/types.js';

/**
 * Payload POSTed to the chat endpoint for one (possibly buffered) inbound turn.
 *
 * `message` is the backward-compat aggregated text (the buffered message bodies
 * concatenated); `messages` is the structured per-message array. `capabilities`
 * is the responding adapter's `supports()` truth set so the endpoint can tailor
 * its `actions[]` to what the channel can actually do.
 */
export interface ChatRequest {
  channel: Channel;
  conversationKey: string;
  /** Backward-compat aggregated text (concatenated message bodies). */
  message: string;
  /** Structured per-message array for the buffered turn. */
  messages: IncomingMessage[];
  /** Resolved identity for the user, when available. */
  contact?: Contact;
  /** The channel adapter's `supports()` truth set for this conversation. */
  capabilities: ChannelFeature[];
  context: {
    /** Whether the 24h customer-service window is currently open. */
    windowOpen: boolean;
    /** Unix milliseconds the window closes, when known. */
    windowExpiresAt?: number;
    /**
     * Set true ONLY when the agent re-prompts after a WhatsApp send failed
     * because the 24h messaging window is closed; signals the endpoint to reply
     * with a `template` action (a free-form text will fail again). Absent on a
     * normal turn.
     */
    requiresTemplate?: boolean;
  };
}

/**
 * Symbolic selector for an inbound message in the buffered turn.
 *
 * An LLM chat endpoint almost never knows the literal channel message id (a
 * WhatsApp `wamid`, a Messenger `m_*`, an Instagram base64-ish id) verbatim, so
 * `reply` / `reaction` targets accept this symbolic form instead of (or
 * alongside) a literal id. {@link resolveTargetRef} in
 * `src/chat/target-resolver.ts` maps a `TargetRef` against the turn's buffered
 * inbound {@link IncomingMessage}[] (the natural target — you react/reply to
 * what the USER said) to a concrete `channelMessageId`.
 *
 * Variants:
 *  - `alias` — positional: `'last'` (most recent inbound), `'first'` (oldest),
 *    `'previous'` (second-most-recent).
 *  - `contentIncludes` — substring match against message text; `occurrence`
 *    (1-based) disambiguates when several messages match. Ambiguous (>1 match,
 *    no `occurrence`) is a resolve failure.
 *  - `content` — exact (trim+lowercase) text match.
 *  - `messageId` — an explicit literal channel message id, escape-hatch form
 *    (equivalent to passing a bare string, but self-documenting).
 *
 * Mirrors the sibling sendblue package's `TargetRef`, adapted to Meta: there is
 * no `partIndex` (Meta has no message-part splitting) and the literal form uses
 * `messageId` (a `channelMessageId`) rather than Sendblue's Apple-GUID
 * `messageHandle`.
 */
export type TargetRef =
  | { alias: 'last' | 'previous' | 'first' }
  | { contentIncludes: string; occurrence?: number }
  | { content: string }
  | { messageId: string };

/**
 * Reply / reaction target as it arrives on a {@link ChatAction}: EITHER a
 * literal channel message id (a plain string — the legacy, backward-compatible
 * form) OR a symbolic {@link TargetRef} the agent resolves against the turn's
 * inbound messages. A bare string is treated exactly like `{ messageId }`.
 */
export type ChatActionTarget = string | TargetRef;

/**
 * One rich action the chat endpoint can ask the agent to perform. Unsupported
 * actions for a channel are skipped by the agent rather than erroring.
 *
 * `reaction` / `reply` `targetMessageId` accepts either a literal channel
 * message id string (backward compatible) or a symbolic {@link TargetRef}; the
 * delivery queue resolves the latter against the buffered inbound messages.
 */
export type ChatAction =
  | { type: 'message'; text: string }
  | { type: 'typing'; durationMs?: number }
  | { type: 'reaction'; emoji: string; targetMessageId: ChatActionTarget }
  | { type: 'reply'; text: string; targetMessageId: ChatActionTarget }
  | { type: 'media'; url: string; caption?: string; mimeType?: string; filename?: string }
  | { type: 'template'; name: string; language: string; components?: TemplateComponent[] }
  | { type: 'silence' };

/**
 * Raw response from the chat endpoint. All fields optional — supports the
 * legacy `message` / `messages` / `silence` forms AND the rich `actions[]`
 * form. `normalizeChatResponse` (Stage 5) collapses these into a single
 * {@link NormalizedChatResponse}.
 */
export interface ChatResponse {
  message?: string;
  messages?: string[];
  silence?: boolean;
  actions?: ChatAction[];
}

/** A non-fatal issue raised while normalizing a {@link ChatResponse}. */
export interface ChatContractWarning {
  code: string;
  message: string;
}

/**
 * The collapsed, silence-resolved form of a {@link ChatResponse}. `silence` is
 * `true` only when the response was an explicit silence (no outbound actions);
 * otherwise `actions` holds the ordered work for the delivery queue.
 */
export interface NormalizedChatResponse {
  /** Collapsed, silence-resolved ordered actions. */
  actions: ChatAction[];
  /** True when the response was an explicit silence. */
  silence?: boolean;
  /** Non-fatal normalization issues (unknown action types, mixed silence, etc.). */
  warnings?: ChatContractWarning[];
}
