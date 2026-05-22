/**
 * Pure symbolic target resolution.
 *
 * The chat endpoint references a message to reply/react to via a
 * {@link ChatActionTarget} — either a literal channel message id (a string) or
 * a symbolic {@link TargetRef}. {@link resolveTargetRef} maps that against the
 * turn's buffered inbound {@link IncomingMessage}[] to a concrete
 * `channelMessageId`. The natural target is a USER inbound message (you
 * react/reply to what the user said), so the candidate history is the buffered
 * inbound array for the turn — ordered oldest → newest, as the conversation
 * agent assembles it.
 *
 * Everything here is side-effect-free (no I/O, no clock, no randomness) so the
 * delivery queue stays pure. Mirrors the sibling sendblue resolver's outcome
 * semantics, adapted to Meta's id model (a `channelMessageId`, no `partIndex`).
 */

import type { IncomingMessage } from '../meta/types.js';
import type { ChatActionTarget, TargetRef } from './types.js';

/**
 * Discriminated resolution outcome. On success, `messageId` is the concrete
 * `channelMessageId` to thread the reply / target the reaction. On failure,
 * `reason` distinguishes WHY so the caller can choose a behavior:
 *  - `not_found` — no candidate matched (or the history was empty).
 *  - `ambiguous` — a `contentIncludes` matched more than one message and no
 *    `occurrence` was given to pick between them.
 *  - `invalid` — the target was structurally malformed (e.g. an empty literal
 *    id, an out-of-range `occurrence`, an unrecognized object shape).
 */
export type TargetResolution =
  | { ok: true; messageId: string }
  | { ok: false; reason: 'not_found' | 'ambiguous' | 'invalid' };

/**
 * Resolve a {@link ChatActionTarget} against the buffered inbound history.
 *
 * `history` is the turn's inbound {@link IncomingMessage}[] in arrival order
 * (oldest first). A literal-string or `{ messageId }` target passes through as
 * the concrete id WITHOUT requiring it to exist in `history` — the endpoint may
 * legitimately know an id from a prior turn the current buffer no longer holds,
 * and the channel adapter (not the resolver) is the authority on whether an id
 * is sendable.
 *
 * When `target` is omitted (or `undefined`), it defaults to `{ alias: 'last' }`
 * — the natural "react/reply to what the user just said" behavior, matching the
 * sibling. Symbolic resolution always requires non-empty history.
 */
export function resolveTargetRef(
  target: ChatActionTarget | undefined,
  history: IncomingMessage[]
): TargetResolution {
  // Literal forms resolve without consulting history (see doc comment): a bare
  // string and the explicit `{ messageId }` escape hatch are equivalent.
  if (typeof target === 'string') {
    return target.trim() === '' ? { ok: false, reason: 'invalid' } : { ok: true, messageId: target };
  }
  if (target && 'messageId' in target) {
    return typeof target.messageId === 'string' && target.messageId.trim() !== ''
      ? { ok: true, messageId: target.messageId }
      : { ok: false, reason: 'invalid' };
  }

  // Default (no target supplied) is the user's most recent message — the same
  // default the contract aliasing layer applies, kept here too so a direct
  // caller (e.g. the agent passing an absent target) gets it for free.
  const ref: TargetRef = target ?? { alias: 'last' };

  // Every symbolic form needs at least one candidate to resolve against.
  if (history.length === 0) return { ok: false, reason: 'not_found' };

  if ('alias' in ref) {
    return resolveAlias(ref.alias, history);
  }

  if ('content' in ref) {
    return resolveContent(ref.content, history);
  }

  if ('contentIncludes' in ref) {
    return resolveContentIncludes(ref.contentIncludes, ref.occurrence, history);
  }

  // An object that matched none of the known variants is malformed.
  return { ok: false, reason: 'invalid' };
}

/**
 * Positional aliases. `last` = most recent (end of the array), `first` =
 * oldest (start), `previous` = second-most-recent (needs ≥2 messages, else
 * `not_found`).
 */
function resolveAlias(alias: 'last' | 'previous' | 'first', history: IncomingMessage[]): TargetResolution {
  switch (alias) {
    case 'last':
      return { ok: true, messageId: history[history.length - 1].channelMessageId };
    case 'first':
      return { ok: true, messageId: history[0].channelMessageId };
    case 'previous':
      // No "previous" exists in a single-message turn.
      return history.length < 2
        ? { ok: false, reason: 'not_found' }
        : { ok: true, messageId: history[history.length - 2].channelMessageId };
    default:
      // The union forbids other strings, but a hand-built/aliased object could
      // still slip an unknown alias through at runtime — fail closed.
      return { ok: false, reason: 'invalid' };
  }
}

/** Exact (trim+lowercase) text match. Ambiguity is impossible to disambiguate
 *  for exact matches, but identical-text duplicates are vanishingly rare and
 *  any of them is an equally-correct target, so the FIRST match wins. */
function resolveContent(content: string, history: IncomingMessage[]): TargetResolution {
  const needle = normalize(content);
  if (needle === '') return { ok: false, reason: 'invalid' };
  const match = history.find(message => normalize(message.text ?? '') === needle);
  return match ? { ok: true, messageId: match.channelMessageId } : { ok: false, reason: 'not_found' };
}

/**
 * Substring match. `occurrence` is 1-based and selects among multiple matches
 * (in arrival order); without it, more than one match is `ambiguous` (we refuse
 * to silently pick one). An `occurrence` past the match count is `invalid`.
 */
function resolveContentIncludes(
  contentIncludes: string,
  occurrence: number | undefined,
  history: IncomingMessage[]
): TargetResolution {
  const needle = normalize(contentIncludes);
  if (needle === '') return { ok: false, reason: 'invalid' };

  const matches = history.filter(message => normalize(message.text ?? '').includes(needle));
  if (matches.length === 0) return { ok: false, reason: 'not_found' };

  if (occurrence !== undefined) {
    if (!Number.isInteger(occurrence) || occurrence < 1) return { ok: false, reason: 'invalid' };
    // 1-based index into the ordered match list. Out of range is invalid (the
    // endpoint asked for the Nth match and there is no Nth match).
    if (occurrence > matches.length) return { ok: false, reason: 'invalid' };
    return { ok: true, messageId: matches[occurrence - 1].channelMessageId };
  }

  if (matches.length > 1) return { ok: false, reason: 'ambiguous' };
  return { ok: true, messageId: matches[0].channelMessageId };
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}
