/**
 * Collapse a raw {@link ChatResponse} into a single normalized action list.
 *
 * The chat endpoint may answer in any of four overlapping forms: an explicit
 * `silence`, a rich `actions[]` array, the legacy top-level `message` string,
 * or the legacy `messages[]` array. {@link normalizeChatResponse} folds all of
 * them into one ordered {@link ChatAction}[] (plus an optional `silence` flag
 * and non-fatal {@link ChatContractWarning}s) so the delivery queue never has
 * to know which form the endpoint used.
 *
 * No XML tag parsing here — unlike the sibling sendblue package, this contract
 * is legacy (`message` / `messages` / `silence`) + rich `actions[]` only.
 */
import { ChatEndpointError } from './errors.js';
import type {
  ChatAction,
  ChatContractWarning,
  ChatResponse,
  NormalizedChatResponse
} from './types.js';

export function normalizeChatResponse(payload: unknown): NormalizedChatResponse {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new ChatEndpointError('Chat endpoint response must be an object');
  }

  const response = payload as ChatResponse;

  // Mixed silence + content is a contradiction: the endpoint asked us to both
  // stay silent AND send output. We drop the whole response rather than guess
  // which half was intended — sending conflicting output is worse than sending
  // nothing, and the warning lets operators spot the buggy endpoint.
  if (response.silence === true && hasContent(response)) {
    return {
      actions: [],
      warnings: [
        {
          code: 'mixed-silence-actions',
          message: 'Chat response set silence:true alongside message/messages/actions; dropping response'
        }
      ]
    };
  }

  // Explicit silence with no competing content: a deliberate no-reply turn.
  if (response.silence === true) {
    return { actions: [], silence: true };
  }

  // Rich actions take precedence over the legacy fields when present.
  if (Array.isArray(response.actions) && response.actions.length > 0) {
    return normalizeActions(response.actions);
  }

  const warnings: ChatContractWarning[] = [];
  const actions: ChatAction[] = [];

  // Precedence when BOTH legacy fields are present: `message` first, then each
  // `messages[]` entry. This is deterministic and matches the request shape,
  // where `message` is the aggregated text and `messages[]` the structured
  // per-message list — emitting the aggregate first preserves that ordering.
  const hasMessage = typeof response.message === 'string';
  const hasMessages = Array.isArray(response.messages);

  if (hasMessage) {
    const text = (response.message as string).trim();
    // Empty/whitespace `message` is treated as "nothing to say", not an error.
    if (text !== '') actions.push({ type: 'message', text });
  }

  if (hasMessages) {
    for (const entry of response.messages as unknown[]) {
      if (typeof entry !== 'string') continue;
      const text = entry.trim();
      if (text !== '') actions.push({ type: 'message', text });
    }
  }

  // None of message / messages / actions / silence were usable. An empty
  // `actions: []` or `messages: []` is still a recognized (if empty) shape, so
  // only throw when the payload had no contract field at all.
  if (!hasMessage && !hasMessages && !('actions' in response) && !('silence' in response)) {
    throw new ChatEndpointError(
      'Chat endpoint response did not include message, messages, actions, or silence'
    );
  }

  return withWarnings(actions, warnings);
}

/**
 * Validate a non-empty `actions[]` array: pass valid actions through, drop
 * malformed/unknown ones with an `invalid-action` warning. A lone surviving
 * `{type:'silence'}` collapses to an explicit silence; a `silence` action mixed
 * among real content is silently dropped (it is a no-op next to other output,
 * and the endpoint clearly intended to send something — no warning needed).
 */
function normalizeActions(rawActions: ChatAction[]): NormalizedChatResponse {
  const warnings: ChatContractWarning[] = [];
  const validated: ChatAction[] = [];

  for (let i = 0; i < rawActions.length; i++) {
    const result = validateAction(rawActions[i], `actions[${i}]`);
    if (result.action) validated.push(result.action);
    else if (result.warning) warnings.push(result.warning);
  }

  const nonSilence = validated.filter(action => action.type !== 'silence');

  // Only a bare silence survived -> treat the whole turn as explicit silence.
  if (nonSilence.length === 0 && validated.some(action => action.type === 'silence')) {
    return warnings.length > 0
      ? { actions: [], silence: true, warnings }
      : { actions: [], silence: true };
  }

  // Drop any silence actions sitting alongside real content (no-op, no warning).
  return withWarnings(nonSilence, warnings);
}

/** Attach warnings only when non-empty, matching the optional `warnings` field. */
function withWarnings(
  actions: ChatAction[],
  warnings: ChatContractWarning[]
): NormalizedChatResponse {
  return warnings.length > 0 ? { actions, warnings } : { actions };
}

interface ValidationResult {
  action?: ChatAction;
  warning?: ChatContractWarning;
}

function invalid(path: string, reason: string): ValidationResult {
  return { warning: { code: 'invalid-action', message: `${path}: ${reason}` } };
}

/**
 * Validate one raw action against the {@link ChatAction} union. Returns the
 * typed action when valid, or an `invalid-action` warning when not.
 */
function validateAction(value: unknown, path: string): ValidationResult {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return invalid(path, 'action must be an object with a string "type"');
  }

  switch (value.type) {
    case 'message': {
      const text = readNonEmptyString(value.text);
      if (text === undefined) return invalid(path, 'message action requires a non-empty "text"');
      return { action: { type: 'message', text } };
    }
    case 'reply': {
      const text = readNonEmptyString(value.text);
      const targetMessageId = readNonEmptyString(value.targetMessageId);
      if (text === undefined) return invalid(path, 'reply action requires a non-empty "text"');
      if (targetMessageId === undefined) {
        return invalid(path, 'reply action requires a non-empty "targetMessageId"');
      }
      return { action: { type: 'reply', text, targetMessageId } };
    }
    case 'reaction': {
      // An empty-string emoji is the documented "unreact" signal — the WhatsApp
      // and Messenger sendReaction paths both treat emoji === '' as
      // remove-reaction, and ChatAction.reaction types emoji as `string` (which
      // permits ''). Accept any string here; only a missing/non-string emoji is
      // invalid. readNonEmptyString would silently drop unreact before it ever
      // reached the adapter.
      const emoji = typeof value.emoji === 'string' ? value.emoji : undefined;
      const targetMessageId = readNonEmptyString(value.targetMessageId);
      if (emoji === undefined) {
        return invalid(path, 'reaction action requires a string "emoji" (use "" to remove a reaction)');
      }
      if (targetMessageId === undefined) {
        return invalid(path, 'reaction action requires a non-empty "targetMessageId"');
      }
      return { action: { type: 'reaction', emoji, targetMessageId } };
    }
    case 'media': {
      const url = readNonEmptyString(value.url);
      if (url === undefined) return invalid(path, 'media action requires a non-empty "url"');
      const caption = readNonEmptyString(value.caption);
      const mimeType = readNonEmptyString(value.mimeType);
      return {
        action: {
          type: 'media',
          url,
          ...(caption !== undefined ? { caption } : {}),
          ...(mimeType !== undefined ? { mimeType } : {})
        }
      };
    }
    case 'template': {
      const name = readNonEmptyString(value.name);
      const language = readNonEmptyString(value.language);
      if (name === undefined) return invalid(path, 'template action requires a non-empty "name"');
      if (language === undefined) {
        return invalid(path, 'template action requires a non-empty "language"');
      }
      // `components` is structurally opaque here (validated downstream by the
      // WhatsApp client); pass it through only when it is an array.
      const components = Array.isArray(value.components) ? value.components : undefined;
      return {
        action: {
          type: 'template',
          name,
          language,
          ...(components !== undefined ? { components } : {})
        }
      };
    }
    case 'typing': {
      const durationMs =
        typeof value.durationMs === 'number' && Number.isFinite(value.durationMs) && value.durationMs >= 0
          ? value.durationMs
          : undefined;
      return { action: durationMs !== undefined ? { type: 'typing', durationMs } : { type: 'typing' } };
    }
    case 'silence':
      return { action: { type: 'silence' } };
    default:
      return invalid(path, `unsupported action type "${value.type}"`);
  }
}

/** True when the response carries any outbound content (text/messages/actions). */
function hasContent(response: ChatResponse): boolean {
  if (typeof response.message === 'string' && response.message.trim() !== '') return true;
  if (
    Array.isArray(response.messages) &&
    response.messages.some(item => typeof item === 'string' && item.trim() !== '')
  ) {
    return true;
  }
  return Array.isArray(response.actions) && response.actions.length > 0;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
