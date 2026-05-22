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
  ChatActionTarget,
  ChatContractWarning,
  ChatResponse,
  NormalizedChatResponse,
  TargetRef
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
 *
 * Field reading goes through {@link readAliasedString} / {@link readTarget} so
 * we tolerate the common JSON drift an LLM endpoint produces: `content` for
 * `text`, `media_url`/`url` for the media url, and snake_case spellings of
 * camelCase fields (`target_message_id`, `mime_type`). The aliasing is
 * permissive about INPUT spelling but always emits the canonical
 * {@link ChatAction} shape — downstream code never sees an alias. We do NOT
 * port the sibling's reaction-emoji-synonym coercion (heart→love etc.): that is
 * iMessage Tapback-specific and has no Meta meaning. Unknown action TYPES still
 * become warnings (not throws), preserving the strict-but-forgiving spirit.
 */
function validateAction(value: unknown, path: string): ValidationResult {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return invalid(path, 'action must be an object with a string "type"');
  }

  switch (value.type) {
    case 'message': {
      // `content` is the most common LLM alias for the message body.
      const text = readAliasedString(value, ['text', 'content']);
      if (text === undefined) return invalid(path, 'message action requires a non-empty "text"');
      return { action: { type: 'message', text } };
    }
    case 'reply': {
      const text = readAliasedString(value, ['text', 'content']);
      const targetMessageId = readTarget(value);
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
      // invalid. readAliasedString would silently drop unreact before it ever
      // reached the adapter.
      const emoji = typeof value.emoji === 'string' ? value.emoji : undefined;
      const targetMessageId = readTarget(value);
      if (emoji === undefined) {
        return invalid(path, 'reaction action requires a string "emoji" (use "" to remove a reaction)');
      }
      if (targetMessageId === undefined) {
        return invalid(path, 'reaction action requires a non-empty "targetMessageId"');
      }
      return { action: { type: 'reaction', emoji, targetMessageId } };
    }
    case 'media': {
      // `media_url` and `url` are common aliases the endpoint may emit; `url`
      // is the canonical field, so it is listed first.
      const url = readAliasedString(value, ['url', 'media_url']);
      if (url === undefined) return invalid(path, 'media action requires a non-empty "url"');
      const caption = readNonEmptyString(value.caption);
      const mimeType = readAliasedString(value, ['mimeType', 'mime_type']);
      // `filename` (for documents) is optional; carry it through only when it is
      // a non-empty string. A non-string filename is simply ignored (not an
      // error) — the rest of the media action is still deliverable, and the
      // WhatsApp client derives a sensible default when none is supplied.
      const filename = readNonEmptyString(value.filename);
      return {
        action: {
          type: 'media',
          url,
          ...(caption !== undefined ? { caption } : {}),
          ...(mimeType !== undefined ? { mimeType } : {}),
          ...(filename !== undefined ? { filename } : {})
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

/**
 * Read the first non-empty string among a list of candidate keys, in priority
 * order. The canonical key is listed first so it always wins when both it and
 * an alias are present. Used to absorb LLM field-name drift (`content`↔`text`,
 * `media_url`↔`url`, `mime_type`↔`mimeType`) without scattering `?? value.alias`
 * chains through `validateAction`.
 */
function readAliasedString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const found = readNonEmptyString(record[key]);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Read a reply/reaction target, tolerating the snake_case
 * `target_message_id` alias and accepting EITHER a literal id string OR a
 * symbolic {@link TargetRef} object (the queue resolves the latter against the
 * turn's inbound messages — see `src/chat/target-resolver.ts`). A bare empty
 * string or an unrecognized object shape yields `undefined` (treated as a
 * missing target by the caller). The canonical `targetMessageId` key wins over
 * the alias when both are present.
 */
function readTarget(record: Record<string, unknown>): ChatActionTarget | undefined {
  // Prefer the canonical key, then the snake_case alias; under each, accept a
  // literal string or a structured TargetRef.
  for (const key of ['targetMessageId', 'target_message_id']) {
    const raw = record[key];
    const literal = readNonEmptyString(raw);
    if (literal !== undefined) return literal;
    const ref = readTargetRef(raw);
    if (ref !== undefined) return ref;
  }
  return undefined;
}

/**
 * Validate a structured {@link TargetRef} object. Returns the typed ref only
 * when it matches one of the union variants with a usable value; anything else
 * (a non-object, an empty alias/content, a non-integer/`<1` occurrence) yields
 * `undefined`. The variants are checked most-specific first so e.g. a
 * `messageId` literal-escape-hatch wins over an incidental `content` field.
 */
function readTargetRef(value: unknown): TargetRef | undefined {
  if (!isRecord(value)) return undefined;

  const messageId = readNonEmptyString(value.messageId);
  if (messageId !== undefined) return { messageId };

  if (typeof value.alias === 'string') {
    const alias = value.alias.trim().toLowerCase();
    if (alias === 'last' || alias === 'previous' || alias === 'first') return { alias };
    return undefined;
  }

  const contentIncludes = readNonEmptyString(value.contentIncludes);
  if (contentIncludes !== undefined) {
    // `occurrence` is an optional 1-based selector; carry it through only when
    // it is a positive integer, else drop it (an ambiguous match then surfaces
    // at resolve time rather than here).
    const occurrence =
      typeof value.occurrence === 'number' && Number.isInteger(value.occurrence) && value.occurrence >= 1
        ? value.occurrence
        : undefined;
    return occurrence !== undefined ? { contentIncludes, occurrence } : { contentIncludes };
  }

  const content = readNonEmptyString(value.content);
  if (content !== undefined) return { content };

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
