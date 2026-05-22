/**
 * Unit tests for the pure symbolic target resolver (`src/chat/target-resolver.ts`).
 *
 * Covers the literal-string and `{ messageId }` passthrough, every alias
 * (`last` / `first` / `previous`), `content` exact match, `contentIncludes`
 * substring match with/without `occurrence`, ambiguity, not-found, empty
 * history, and the invalid-shape paths.
 */
import { describe, expect, it } from 'vitest';
import { resolveTargetRef } from '../../src/chat/target-resolver.js';
import type { IncomingMessage } from '../../src/meta/types.js';

/** Build a minimal inbound message with the fields the resolver inspects. */
function msg(id: string, text?: string): IncomingMessage {
  return {
    channel: 'whatsapp',
    channelMessageId: id,
    channelScopedUserId: 'u1',
    channelScopedBusinessId: 'b1',
    timestamp: 0,
    type: 'text',
    ...(text !== undefined ? { text } : {}),
    raw: {}
  };
}

/** A three-message turn, oldest → newest, for the positional/alias cases. */
const HISTORY: IncomingMessage[] = [
  msg('wamid.1', 'first hello'),
  msg('wamid.2', 'middle message'),
  msg('wamid.3', 'last goodbye')
];

describe('resolveTargetRef — literal passthrough', () => {
  it('passes a bare string through as the concrete id (no history needed)', () => {
    expect(resolveTargetRef('wamid.literal', [])).toEqual({ ok: true, messageId: 'wamid.literal' });
  });

  it('passes a { messageId } escape-hatch through unchanged', () => {
    expect(resolveTargetRef({ messageId: 'wamid.x' }, HISTORY)).toEqual({
      ok: true,
      messageId: 'wamid.x'
    });
  });

  it('does NOT require a literal id to exist in history', () => {
    // The endpoint may legitimately know an id the current buffer no longer holds.
    expect(resolveTargetRef('wamid.from-a-prior-turn', HISTORY)).toEqual({
      ok: true,
      messageId: 'wamid.from-a-prior-turn'
    });
  });

  it('rejects an empty / whitespace literal string as invalid', () => {
    expect(resolveTargetRef('', HISTORY)).toEqual({ ok: false, reason: 'invalid' });
    expect(resolveTargetRef('   ', HISTORY)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects an empty { messageId } as invalid', () => {
    expect(resolveTargetRef({ messageId: '' }, HISTORY)).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('resolveTargetRef — aliases', () => {
  it('last resolves to the most recent inbound', () => {
    expect(resolveTargetRef({ alias: 'last' }, HISTORY)).toEqual({ ok: true, messageId: 'wamid.3' });
  });

  it('first resolves to the oldest inbound', () => {
    expect(resolveTargetRef({ alias: 'first' }, HISTORY)).toEqual({ ok: true, messageId: 'wamid.1' });
  });

  it('previous resolves to the second-most-recent inbound', () => {
    expect(resolveTargetRef({ alias: 'previous' }, HISTORY)).toEqual({
      ok: true,
      messageId: 'wamid.2'
    });
  });

  it('previous on a single-message turn is not_found (no "previous" exists)', () => {
    expect(resolveTargetRef({ alias: 'previous' }, [msg('wamid.only', 'solo')])).toEqual({
      ok: false,
      reason: 'not_found'
    });
  });

  it('last on a single-message turn resolves to that one message', () => {
    expect(resolveTargetRef({ alias: 'last' }, [msg('wamid.only', 'solo')])).toEqual({
      ok: true,
      messageId: 'wamid.only'
    });
  });
});

describe('resolveTargetRef — default (no target)', () => {
  it('undefined defaults to alias:last (the user\'s most recent message)', () => {
    expect(resolveTargetRef(undefined, HISTORY)).toEqual({ ok: true, messageId: 'wamid.3' });
  });
});

describe('resolveTargetRef — content (exact)', () => {
  it('matches an exact message body (case/space-insensitive)', () => {
    expect(resolveTargetRef({ content: '  Middle Message ' }, HISTORY)).toEqual({
      ok: true,
      messageId: 'wamid.2'
    });
  });

  it('returns not_found when no body matches exactly', () => {
    expect(resolveTargetRef({ content: 'middle' }, HISTORY)).toEqual({
      ok: false,
      reason: 'not_found'
    });
  });

  it('rejects an empty content as invalid', () => {
    expect(resolveTargetRef({ content: '   ' }, HISTORY)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('picks the FIRST match when duplicate bodies exist', () => {
    const dup = [msg('wamid.a', 'same'), msg('wamid.b', 'same')];
    expect(resolveTargetRef({ content: 'same' }, dup)).toEqual({ ok: true, messageId: 'wamid.a' });
  });
});

describe('resolveTargetRef — contentIncludes (substring)', () => {
  it('matches a unique substring', () => {
    expect(resolveTargetRef({ contentIncludes: 'goodbye' }, HISTORY)).toEqual({
      ok: true,
      messageId: 'wamid.3'
    });
  });

  it('is ambiguous when more than one message matches and no occurrence is given', () => {
    const h = [msg('wamid.1', 'order coffee'), msg('wamid.2', 'order tea')];
    expect(resolveTargetRef({ contentIncludes: 'order' }, h)).toEqual({
      ok: false,
      reason: 'ambiguous'
    });
  });

  it('occurrence (1-based) disambiguates among multiple matches in arrival order', () => {
    const h = [msg('wamid.1', 'order coffee'), msg('wamid.2', 'order tea'), msg('wamid.3', 'order water')];
    expect(resolveTargetRef({ contentIncludes: 'order', occurrence: 1 }, h)).toEqual({
      ok: true,
      messageId: 'wamid.1'
    });
    expect(resolveTargetRef({ contentIncludes: 'order', occurrence: 2 }, h)).toEqual({
      ok: true,
      messageId: 'wamid.2'
    });
    expect(resolveTargetRef({ contentIncludes: 'order', occurrence: 3 }, h)).toEqual({
      ok: true,
      messageId: 'wamid.3'
    });
  });

  it('occurrence past the match count is invalid', () => {
    const h = [msg('wamid.1', 'order coffee'), msg('wamid.2', 'order tea')];
    expect(resolveTargetRef({ contentIncludes: 'order', occurrence: 3 }, h)).toEqual({
      ok: false,
      reason: 'invalid'
    });
  });

  it('occurrence < 1 or non-integer is invalid', () => {
    const h = [msg('wamid.1', 'order coffee')];
    expect(resolveTargetRef({ contentIncludes: 'order', occurrence: 0 }, h)).toEqual({
      ok: false,
      reason: 'invalid'
    });
    expect(resolveTargetRef({ contentIncludes: 'order', occurrence: 1.5 }, h)).toEqual({
      ok: false,
      reason: 'invalid'
    });
  });

  it('returns not_found when nothing contains the substring', () => {
    expect(resolveTargetRef({ contentIncludes: 'nope' }, HISTORY)).toEqual({
      ok: false,
      reason: 'not_found'
    });
  });

  it('rejects an empty contentIncludes as invalid', () => {
    expect(resolveTargetRef({ contentIncludes: '' }, HISTORY)).toEqual({
      ok: false,
      reason: 'invalid'
    });
  });
});

describe('resolveTargetRef — empty history', () => {
  it('any symbolic target against empty history is not_found', () => {
    expect(resolveTargetRef({ alias: 'last' }, [])).toEqual({ ok: false, reason: 'not_found' });
    expect(resolveTargetRef({ content: 'x' }, [])).toEqual({ ok: false, reason: 'not_found' });
    expect(resolveTargetRef({ contentIncludes: 'x' }, [])).toEqual({
      ok: false,
      reason: 'not_found'
    });
    expect(resolveTargetRef(undefined, [])).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('resolveTargetRef — content matching ignores text-less messages', () => {
  it('a message with no text never matches a content/contentIncludes target', () => {
    // A media-only inbound has no `text`; it should never satisfy a substring
    // search (the resolver treats absent text as the empty string).
    const h = [msg('wamid.media'), msg('wamid.text', 'has words')];
    expect(resolveTargetRef({ contentIncludes: 'words' }, h)).toEqual({
      ok: true,
      messageId: 'wamid.text'
    });
    // An empty needle would be invalid before it could match the text-less one.
    expect(resolveTargetRef({ contentIncludes: '' }, h)).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('resolveTargetRef — malformed object', () => {
  it('an object matching no known variant is invalid', () => {
    // Cast through unknown: this is the runtime "LLM sent garbage" path.
    expect(resolveTargetRef({ foo: 'bar' } as never, HISTORY)).toEqual({
      ok: false,
      reason: 'invalid'
    });
  });
});
