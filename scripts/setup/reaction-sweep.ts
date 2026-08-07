/**
 * REACTION EMOJI SWEEP — the device probe for "which emoji can the Page
 * actually send as a reaction?"
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * `sendReaction` puts whatever string it is given into `payload.reaction` on
 * the Send API. NOTHING in this package validates it, and Meta publishes no
 * accepted-value list for either DM channel — Instagram's messaging reference
 * documents `"love"` and stops. A consumer (Delirio's SocialEngine) now lets a
 * coach emit an ARBITRARY emoji, sometimes INSTEAD of a text reply. So a
 * silently-rejected emoji is not a cosmetic loss: the person receives nothing
 * at all on that turn.
 *
 * This sweep answers the question empirically, against the live API, on a real
 * device. It is dev tooling — never run in CI, never part of the published
 * package.
 *
 * ── Why the operator has to be in the loop ──────────────────────────────────
 * There are THREE distinct outcomes and only two of them are visible to code:
 *
 *   1. Graph rejects (4xx)              → visible here, recorded with the code.
 *   2. Graph accepts AND it renders     → indistinguishable from (3) via API.
 *   3. Graph accepts and NOTHING shows  → THE failure mode we are hunting.
 *
 * A 200 is not proof of delivery. So each emoji is confirmed by a human looking
 * at the phone. `--sweep-no-prompt` reduces this to the API-only half, which is
 * strictly weaker and is labelled `unverified` in the report rather than
 * `as-sent` — never conflate the two.
 *
 * ── Why an unreact precedes every react ─────────────────────────────────────
 * A Page holds at most ONE reaction per message, so a second react REPLACES the
 * first. Without clearing, "nothing changed on screen" is ambiguous between
 * "the new emoji was silently dropped" (outcome 3) and "it rendered but looks
 * like the last one". Clearing first makes an empty bubble unambiguous. The
 * unreact's own result is recorded separately — if the CLEAR fails, that
 * emoji's verdict is untrustworthy and it is marked as such.
 *
 * @module scripts/setup/reaction-sweep
 */

import type { Channel } from '../../src/meta/types.js';
import { MetaApiError } from '../../src/meta/shared/errors.js';
import { ask, info, warn, fail, success } from '../lib/console.js';

/* ────────────────────────────────────────────────────────────────────────── */
/* Candidate lists (pure data — unit-tested)                                  */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * The four the coach is taught by name, in `NAMED_REACTION_EMOJI` order.
 *
 * `‼️` is the one to watch: iMessage has a native "emphasize" tapback and Meta
 * does not, so `‼️` is OUR choice standing in for a platform primitive the
 * channel never had. It is also multi-codepoint (U+203C U+FE0F), which is
 * exactly the shape most likely to be refused.
 */
export const NAMED_REACTION_EMOJI = ['❤️', '👍', '😆', '‼️'] as const;

/**
 * Messenger's own reaction palette as the client UI offers it. If the Send API
 * enforces an allowlist at all, this is the most likely allowlist — so a sweep
 * where ONLY these survive is a strong signal that the answer is "palette only,
 * no custom emoji".
 */
export const MESSENGER_PALETTE = ['❤️', '😆', '😮', '😢', '😠', '👍', '👎'] as const;

/**
 * Emoji a coach would plausibly reach for that are NOT in any palette. These
 * are the actual product question — `<react emoji="🔥"/>` is the grammar we
 * shipped, and 🔥 is the single likeliest thing a fitness coach sends.
 */
export const COACH_CANDIDATES = ['🔥', '💪', '🎯', '👏', '🙌', '💯', '🫡', '😅'] as const;

/**
 * Shape-stress cases. Each probes a DIFFERENT encoding property, which is why
 * they are worth their runtime even though no coach would send `👍🏽` today:
 *   `👍🏽`   — base + skin-tone modifier (surrogate pair + U+1F3FD)
 *   `🏋️‍♀️`  — ZWJ sequence (the shape a scanner is most likely to mangle)
 *   `🇺🇸`   — regional-indicator pair (two codepoints, no ZWJ)
 *   `❤`    — the UNQUALIFIED heart (no U+FE0F). If this is accepted where `❤️`
 *            is not, the fix is a normalization step, not a smaller vocabulary.
 */
export const SHAPE_STRESS = ['👍🏽', '🏋️‍♀️', '🇺🇸', '❤'] as const;

/**
 * Named presets. `standard` is the recommended run: it answers the shipped
 * grammar's question (do the four named + a realistic custom set work?) without
 * spending the operator's attention on encoding trivia.
 */
export const SWEEP_PRESETS: Readonly<Record<string, readonly string[]>> = {
  /** The four named reactions only — the minimum that must pass to ship anything. */
  named: NAMED_REACTION_EMOJI,
  /** Named + the coach's realistic custom set. The default. */
  standard: [...NAMED_REACTION_EMOJI, ...COACH_CANDIDATES],
  /** Everything, including the palette control group and the encoding stress cases. */
  full: [
    ...NAMED_REACTION_EMOJI,
    ...MESSENGER_PALETTE.filter((e) => !NAMED_REACTION_EMOJI.includes(e as never)),
    ...COACH_CANDIDATES,
    ...SHAPE_STRESS
  ]
};

export const DEFAULT_SWEEP_PRESET = 'standard';

/**
 * Resolve the `--emoji-sweep` value into a candidate list.
 *
 * Accepts a preset name or a comma-separated literal list. Duplicates are
 * dropped WITHOUT reordering (a repeated emoji is a typo, and re-reacting with
 * the same value would produce a meaningless "no change" reading).
 *
 * Throws on an unknown preset and on an empty list rather than falling back to
 * a default — a probe that silently sweeps something other than what was asked
 * for produces a result table nobody can trust.
 */
export function parseSweepList(raw: string | undefined): string[] {
  const value = (raw ?? DEFAULT_SWEEP_PRESET).trim();
  if (value === '') {
    throw new Error(
      `--emoji-sweep requires a preset (${Object.keys(SWEEP_PRESETS).join(' | ')}) or a comma-separated emoji list.`
    );
  }

  const preset = SWEEP_PRESETS[value];
  if (preset) return [...preset];

  // Not a preset. If it has no comma and looks like a word, it is far more
  // likely a mistyped preset than a one-emoji sweep — say so explicitly.
  if (!value.includes(',') && /^[a-z][a-z-]*$/i.test(value)) {
    throw new Error(
      `--emoji-sweep: unknown preset "${value}". Valid presets: ${Object.keys(SWEEP_PRESETS).join(', ')}. ` +
        `To sweep literal emoji, pass them comma-separated (e.g. --emoji-sweep=🔥,💪).`
    );
  }

  const parts = value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) {
    throw new Error('--emoji-sweep: the list resolved to zero emoji.');
  }

  const seen = new Set<string>();
  const list: string[] = [];
  for (const part of parts) {
    if (seen.has(part)) continue;
    seen.add(part);
    list.push(part);
  }
  return list;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Outcome model                                                              */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * What the human saw. Deliberately NOT a boolean:
 *   `as-sent`    — the exact emoji is under the message.
 *   `substituted`— something rendered, but not what we sent (Meta coerced it).
 *   `nothing`    — the bubble is bare. The silent-drop we are hunting.
 *   `unverified` — nobody looked (`--sweep-no-prompt`), or the pre-clear failed
 *                  so the reading would have been ambiguous anyway.
 */
export type RenderVerdict = 'as-sent' | 'substituted' | 'nothing' | 'unverified';

export interface SweepOutcome {
  emoji: string;
  /** Codepoints, e.g. `U+1F44D U+1F3FD` — the identity that survives a copy/paste. */
  codepoints: string;
  /** Did the Graph API accept the react call? */
  apiAccepted: boolean;
  /** Meta error code when rejected. */
  errorCode?: number;
  /** HTTP status when rejected. */
  httpStatus?: number;
  /** Server-side message when rejected. */
  errorMessage?: string;
  /** Whether the pre-react unreact succeeded (a failed clear makes the reading ambiguous). */
  clearedFirst: boolean;
  /** What the operator reported. */
  rendered: RenderVerdict;
  /** Free-text the operator typed when the verdict was `substituted`. */
  note?: string;
}

/** `👍🏽` → `U+1F44D U+1F3FD`. The one identity that survives a terminal, a doc, and a copy/paste. */
export function toCodepoints(emoji: string): string {
  return [...emoji]
    .map((ch) => `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`)
    .join(' ');
}

/**
 * The single question the whole probe exists to answer, per emoji: did the
 * person actually receive it?
 *
 * An API accept with `rendered: 'nothing'` is the WORST outcome — worse than a
 * rejection, because a rejection is at least observable in production logs.
 */
export function isDeliverable(o: SweepOutcome): boolean {
  return o.apiAccepted && o.rendered === 'as-sent';
}

/* ────────────────────────────────────────────────────────────────────────── */
/* The sweep                                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

/** The subset of a channel client this sweep needs. */
export interface ReactionSender {
  sendReaction(recipientId: string, messageId: string, emoji: string): Promise<void>;
}

export interface SweepArgs {
  channel: Channel;
  client: ReactionSender;
  recipientId: string;
  /** The inbound message id every reaction in this sweep targets. */
  targetMessageId: string;
  emojis: readonly string[];
  /** Skip the per-emoji operator prompt (API-only sweep). */
  noPrompt: boolean;
  /** Pause between sends, ms. Keeps us clear of the per-second ceiling and gives the device time to paint. */
  pacingMs: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests — defaults to the console `ask`. */
  prompt?: (question: string) => Promise<string>;
}

const DEFAULT_PACING_MS = 1200;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sweep one channel's candidate list against ONE captured inbound message.
 *
 * Every emoji targets the SAME message on purpose: the operator watches a
 * single bubble and reports what changes, instead of scrolling a thread and
 * matching reactions to sends from memory.
 */
export async function runReactionSweep(args: SweepArgs): Promise<SweepOutcome[]> {
  const { channel, client, recipientId, targetMessageId, emojis } = args;
  const sleep = args.sleep ?? defaultSleep;
  const prompt = args.prompt ?? ((q: string) => ask(q));
  const pacingMs = args.pacingMs > 0 ? args.pacingMs : DEFAULT_PACING_MS;

  // Defense in depth behind the caller's own TTY check: with no injected prompt
  // and no interactive stdin, `ask` resolves to an empty line, which this
  // function reads as "yes, exactly as sent". Downgrading to unverified records
  // the truth (nobody looked) instead of a wall of fabricated confirmations.
  const canPrompt = args.prompt !== undefined || process.stdin.isTTY === true;
  const noPrompt = args.noPrompt || !canPrompt;
  if (args.noPrompt === false && !canPrompt) {
    warn(`${channel}: stdin is not interactive — sweeping without device confirmation; every row will read "unverified".`);
  }

  const outcomes: SweepOutcome[] = [];

  info(
    `${channel}: sweeping ${emojis.length} emoji against one message. ` +
      (noPrompt
        ? 'No-prompt mode — API results only; nothing is confirmed on the device.'
        : 'Watch the message you just sent; each reaction replaces the last.')
  );

  for (let i = 0; i < emojis.length; i += 1) {
    const emoji = emojis[i] as string;
    const codepoints = toCodepoints(emoji);

    // Clear first so a bare bubble is unambiguous (see the module header).
    let clearedFirst = true;
    try {
      await client.sendReaction(recipientId, targetMessageId, '');
      await sleep(pacingMs);
    } catch (err) {
      clearedFirst = false;
      warn(
        `${channel}: could not clear the prior reaction before ${emoji} (${codepoints}) — ` +
          `${err instanceof Error ? err.message : String(err)}. This emoji's on-screen reading is untrustworthy.`
      );
    }

    let apiAccepted = true;
    let errorCode: number | undefined;
    let httpStatus: number | undefined;
    let errorMessage: string | undefined;
    try {
      await client.sendReaction(recipientId, targetMessageId, emoji);
    } catch (err) {
      apiAccepted = false;
      if (err instanceof MetaApiError) {
        errorCode = err.errorCode;
        httpStatus = err.httpStatus;
        errorMessage = err.message;
      } else {
        errorMessage = err instanceof Error ? err.message : String(err);
      }
    }

    const label = `[${i + 1}/${emojis.length}] ${emoji}  ${codepoints}`;
    if (apiAccepted) success(`${label} — API accepted`);
    else fail(`${label} — API REJECTED${errorCode !== undefined ? ` (code ${errorCode})` : ''}: ${errorMessage ?? ''}`);

    let rendered: RenderVerdict = 'unverified';
    let note: string | undefined;

    if (!apiAccepted) {
      // A rejected send cannot have rendered. Recording `nothing` here (rather
      // than leaving it unverified) keeps the report's "did the person receive
      // it?" column complete without asking the operator a question whose
      // answer is already known.
      rendered = 'nothing';
    } else if (!noPrompt && clearedFirst) {
      const answer = (
        await prompt(
          `    What is under your message now? [y]=exactly ${emoji} · [n]=nothing · or type what you actually see`
        )
      ).trim();
      if (answer === '' || /^(y|yes)$/i.test(answer)) {
        rendered = 'as-sent';
      } else if (/^(n|no|nothing|none)$/i.test(answer)) {
        rendered = 'nothing';
      } else {
        rendered = 'substituted';
        note = answer;
      }
    }

    outcomes.push({
      emoji,
      codepoints,
      apiAccepted,
      ...(errorCode !== undefined ? { errorCode } : {}),
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      ...(errorMessage !== undefined ? { errorMessage } : {}),
      clearedFirst,
      rendered,
      ...(note !== undefined ? { note } : {})
    });

    await sleep(pacingMs);
  }

  // Leave the thread tidy — a probe should not leave a stray 🇺🇸 under someone's
  // message. Failure here is cosmetic, so it is warned and never thrown.
  try {
    await client.sendReaction(recipientId, targetMessageId, '');
  } catch {
    warn(`${channel}: could not clear the final reaction; remove it by hand if it bothers you.`);
  }

  return outcomes;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Reporting (pure — unit-tested)                                             */
/* ────────────────────────────────────────────────────────────────────────── */

export interface ChannelSweep {
  channel: Channel;
  outcomes: SweepOutcome[];
}

/**
 * The verdict a consumer actually needs: which emoji are safe to put in a
 * coach's vocabulary on this channel, and which are safe ONLY as a decoration
 * beside real text.
 */
export function summarizeSweep(sweeps: readonly ChannelSweep[]): {
  deliverableEverywhere: string[];
  partial: string[];
  neverDeliverable: string[];
  silentDrops: Array<{ channel: Channel; emoji: string }>;
} {
  const byEmoji = new Map<string, { ok: number; total: number }>();
  const silentDrops: Array<{ channel: Channel; emoji: string }> = [];

  for (const { channel, outcomes } of sweeps) {
    for (const o of outcomes) {
      const entry = byEmoji.get(o.emoji) ?? { ok: 0, total: 0 };
      entry.total += 1;
      if (isDeliverable(o)) entry.ok += 1;
      byEmoji.set(o.emoji, entry);
      // An API accept that rendered nothing: the failure this probe exists for.
      if (o.apiAccepted && o.rendered === 'nothing') silentDrops.push({ channel, emoji: o.emoji });
    }
  }

  const deliverableEverywhere: string[] = [];
  const partial: string[] = [];
  const neverDeliverable: string[] = [];
  for (const [emoji, { ok, total }] of byEmoji) {
    if (ok === total) deliverableEverywhere.push(emoji);
    else if (ok === 0) neverDeliverable.push(emoji);
    else partial.push(emoji);
  }

  return { deliverableEverywhere, partial, neverDeliverable, silentDrops };
}

/** Render the sweep as a Markdown report — the artifact that outlives the terminal. */
export function formatSweepMarkdown(sweeps: readonly ChannelSweep[], sessionId: string): string {
  const lines: string[] = [];
  lines.push(`# Reaction emoji sweep — ${sessionId}`);
  lines.push('');
  lines.push(
    'Each row is one `sender_action: react` call against a live inbound message. ' +
      '**Delivered** is the only column that matters — an API accept that rendered nothing ' +
      'is a silent drop, and is worse than a rejection because production would never see it.'
  );
  lines.push('');

  for (const { channel, outcomes } of sweeps) {
    lines.push(`## ${channel}`);
    lines.push('');
    lines.push('| Emoji | Codepoints | API | Rendered | Delivered | Detail |');
    lines.push('|---|---|---|---|---|---|');
    for (const o of outcomes) {
      const api = o.apiAccepted ? 'accepted' : `rejected${o.errorCode !== undefined ? ` (${o.errorCode})` : ''}`;
      const detail = [
        o.note,
        o.errorMessage,
        o.clearedFirst ? undefined : 'pre-clear failed — reading untrustworthy'
      ]
        .filter(Boolean)
        .join('; ');
      lines.push(
        `| ${o.emoji} | \`${o.codepoints}\` | ${api} | ${o.rendered} | ${isDeliverable(o) ? 'yes' : 'NO'} | ${detail || '—'} |`
      );
    }
    lines.push('');
  }

  const summary = summarizeSweep(sweeps);
  lines.push('## Verdict');
  lines.push('');
  lines.push(`- **Deliverable on every channel swept:** ${summary.deliverableEverywhere.join(' ') || '(none)'}`);
  lines.push(`- **Deliverable on some but not all:** ${summary.partial.join(' ') || '(none)'}`);
  lines.push(`- **Never deliverable:** ${summary.neverDeliverable.join(' ') || '(none)'}`);
  lines.push('');
  if (summary.silentDrops.length > 0) {
    lines.push(
      `- **Silent drops (API said 200, nothing rendered): ${summary.silentDrops
        .map((d) => `${d.emoji} on ${d.channel}`)
        .join(', ')}.** These are the dangerous ones — a coach that reacts INSTEAD of replying ` +
        'sends the person nothing at all, and no log line records it.'
    );
  } else {
    lines.push('- **No silent drops observed.** Every API accept rendered on the device.');
  }
  lines.push('');
  return lines.join('\n');
}
