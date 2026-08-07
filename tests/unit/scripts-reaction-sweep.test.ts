/**
 * Unit tests for the PURE + injectable halves of scripts/setup/reaction-sweep.ts.
 *
 * The sweep's VALUE is manual (a human confirming what rendered on a phone), so
 * these tests cover the parts that must not be wrong when that human is
 * mid-probe and won't notice: list resolution, the codepoint identity, the
 * clear-then-react send sequence, and — most of all — the verdict logic, since
 * a probe that quietly scores a silent drop as a pass is worse than no probe.
 *
 * `runReactionSweep` takes injectable `sleep` and `prompt`, so it runs here with
 * a fake client and zero real time.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  parseSweepList,
  runReactionSweep,
  runBatchSweep,
  applyBatchAnswers,
  parseBatchAnswers,
  summarizeSweep,
  formatSweepMarkdown,
  isDeliverable,
  toCodepoints,
  SWEEP_PRESETS,
  NAMED_REACTION_EMOJI,
  type SweepOutcome
} from '../../scripts/setup/reaction-sweep.js';
import { MetaApiError } from '../../src/meta/shared/errors.js';

/* ────────────────────────────────────────────────────────────────────────── */
/* parseSweepList                                                             */
/* ────────────────────────────────────────────────────────────────────────── */

describe('parseSweepList', () => {
  it('defaults to the standard preset', () => {
    expect(parseSweepList(undefined)).toEqual([...SWEEP_PRESETS.standard!]);
  });

  it('resolves each named preset', () => {
    for (const [name, list] of Object.entries(SWEEP_PRESETS)) {
      expect(parseSweepList(name)).toEqual([...list]);
    }
  });

  it('every preset contains the four named reactions — they are the ship gate', () => {
    for (const [name, list] of Object.entries(SWEEP_PRESETS)) {
      for (const emoji of NAMED_REACTION_EMOJI) {
        expect(list, `preset "${name}" is missing ${emoji}`).toContain(emoji);
      }
    }
  });

  it('parses a literal comma-separated list', () => {
    expect(parseSweepList('🔥,💪,🎯')).toEqual(['🔥', '💪', '🎯']);
  });

  it('drops duplicates without reordering', () => {
    // A repeated emoji would re-react with the same value and read as "no
    // change on screen" — a meaningless row in the report.
    expect(parseSweepList('🔥,💪,🔥')).toEqual(['🔥', '💪']);
  });

  it('rejects an unknown preset word rather than sweeping it as one literal emoji', () => {
    expect(() => parseSweepList('standrd')).toThrow(/unknown preset "standrd"/);
  });

  it('rejects an empty value', () => {
    expect(() => parseSweepList('')).toThrow(/requires a preset/);
  });

  it('rejects a list that resolves to nothing', () => {
    expect(() => parseSweepList(',, ,')).toThrow(/zero emoji/);
  });

  it('the full preset does not repeat the named reactions it shares with the palette', () => {
    const full = SWEEP_PRESETS.full!;
    expect(new Set(full).size).toBe(full.length);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* toCodepoints                                                               */
/* ────────────────────────────────────────────────────────────────────────── */

describe('toCodepoints', () => {
  it('expands a surrogate pair as ONE codepoint, not two', () => {
    // Iterating a string by index would print U+D83D U+44D here. That would make
    // the report's identity column wrong for every emoji above the BMP.
    expect(toCodepoints('👍')).toBe('U+1F44D');
  });

  it('keeps the variation selector visible — the ❤️ vs ❤ distinction the sweep exists to test', () => {
    expect(toCodepoints('❤️')).toBe('U+2764 U+FE0F');
    expect(toCodepoints('❤')).toBe('U+2764');
  });

  it('expands a ZWJ sequence', () => {
    expect(toCodepoints('🏋️‍♀️')).toContain('U+200D');
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* isDeliverable — the verdict                                                */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * `codepoints` is DERIVED from the final emoji rather than defaulted, so an
 * override can't leave a row claiming 🔥's codepoints under a ❤️ — the fixture
 * would then agree with a report that mislabels every substituted emoji.
 */
function outcome(over: Partial<SweepOutcome> = {}): SweepOutcome {
  const emoji = over.emoji ?? '🔥';
  return {
    apiAccepted: true,
    clearedFirst: true,
    rendered: 'as-sent',
    ...over,
    emoji,
    codepoints: over.codepoints ?? toCodepoints(emoji)
  };
}

describe('isDeliverable', () => {
  it('an API accept that RENDERED is deliverable', () => {
    expect(isDeliverable(outcome())).toBe(true);
  });

  it('an API accept that rendered NOTHING is not deliverable — the silent drop', () => {
    // The single most important assertion in this file. If this ever returns
    // true, the probe reports a pass for an emoji that reaches nobody.
    expect(isDeliverable(outcome({ rendered: 'nothing' }))).toBe(false);
  });

  it('a substitution is not deliverable — the coach said a different thing', () => {
    expect(isDeliverable(outcome({ rendered: 'substituted', note: 'a thumbs up' }))).toBe(false);
  });

  it('unverified is not deliverable — nobody looked', () => {
    expect(isDeliverable(outcome({ rendered: 'unverified' }))).toBe(false);
  });

  it('an API rejection is not deliverable', () => {
    expect(isDeliverable(outcome({ apiAccepted: false, rendered: 'nothing' }))).toBe(false);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* runReactionSweep                                                           */
/* ────────────────────────────────────────────────────────────────────────── */

interface Call {
  recipient: string;
  target: string;
  emoji: string;
}

function fakeClient(reject?: (emoji: string) => Error | undefined) {
  const calls: Call[] = [];
  return {
    calls,
    async sendReaction(recipient: string, target: string, emoji: string): Promise<void> {
      calls.push({ recipient, target, emoji });
      const err = reject?.(emoji);
      if (err) throw err;
    }
  };
}

const BASE = {
  channel: 'messenger' as const,
  recipientId: 'PSID',
  targetMessageId: 'm_abc',
  noPrompt: true,
  pacingMs: 0,
  sleep: async () => {}
};

describe('runReactionSweep', () => {
  it('clears before every react and clears once at the end', async () => {
    const client = fakeClient();
    await runReactionSweep({ ...BASE, client, emojis: ['🔥', '💪'] });
    // clear, 🔥, clear, 💪, final clear
    expect(client.calls.map((c) => c.emoji)).toEqual(['', '🔥', '', '💪', '']);
  });

  it('targets the SAME message for every emoji', async () => {
    const client = fakeClient();
    await runReactionSweep({ ...BASE, client, emojis: ['🔥', '💪', '🎯'] });
    expect(new Set(client.calls.map((c) => c.target))).toEqual(new Set(['m_abc']));
  });

  it('records the Meta error code on a rejection and keeps sweeping', async () => {
    const client = fakeClient((emoji) =>
      emoji === '💪'
        ? new MetaApiError({
            operation: 'messenger.sendReaction',
            httpStatus: 400,
            errorCode: 100,
            responseBody: { error: { message: 'Invalid reaction' } }
          })
        : undefined
    );
    const results = await runReactionSweep({ ...BASE, client, emojis: ['🔥', '💪', '🎯'] });

    expect(results).toHaveLength(3);
    expect(results[1]!.apiAccepted).toBe(false);
    expect(results[1]!.errorCode).toBe(100);
    expect(results[1]!.httpStatus).toBe(400);
    // A rejection cannot have rendered — the report's Delivered column must be
    // complete without asking the operator a question already answered.
    expect(results[1]!.rendered).toBe('nothing');
    // The sweep continued past it.
    expect(results[2]!.emoji).toBe('🎯');
    expect(results[2]!.apiAccepted).toBe(true);
  });

  it('a failed CLEAR marks the reading untrustworthy but still sends the react', async () => {
    const client = fakeClient((emoji) => (emoji === '' ? new Error('clear boom') : undefined));
    const results = await runReactionSweep({ ...BASE, client, emojis: ['🔥'] });
    expect(results[0]!.clearedFirst).toBe(false);
    expect(results[0]!.apiAccepted).toBe(true);
    expect(client.calls.some((c) => c.emoji === '🔥')).toBe(true);
  });

  it('no-prompt mode never claims a render it did not observe', async () => {
    const client = fakeClient();
    const results = await runReactionSweep({ ...BASE, client, emojis: ['🔥'] });
    expect(results[0]!.rendered).toBe('unverified');
    expect(isDeliverable(results[0]!)).toBe(false);
  });

  it('prompt mode: empty answer or "y" means as-sent', async () => {
    const client = fakeClient();
    const prompt = vi.fn().mockResolvedValueOnce('').mockResolvedValueOnce('y');
    const results = await runReactionSweep({
      ...BASE,
      client,
      emojis: ['🔥', '💪'],
      noPrompt: false,
      prompt
    });
    expect(results.map((r) => r.rendered)).toEqual(['as-sent', 'as-sent']);
  });

  it('prompt mode: "n" means nothing rendered — the silent drop is recorded', async () => {
    const client = fakeClient();
    const prompt = vi.fn().mockResolvedValue('n');
    const results = await runReactionSweep({ ...BASE, client, emojis: ['🔥'], noPrompt: false, prompt });
    expect(results[0]!.apiAccepted).toBe(true);
    expect(results[0]!.rendered).toBe('nothing');
    expect(isDeliverable(results[0]!)).toBe(false);
  });

  it('prompt mode: free text is captured as a substitution', async () => {
    const client = fakeClient();
    const prompt = vi.fn().mockResolvedValue('a thumbs up instead');
    const results = await runReactionSweep({ ...BASE, client, emojis: ['🔥'], noPrompt: false, prompt });
    expect(results[0]!.rendered).toBe('substituted');
    expect(results[0]!.note).toBe('a thumbs up instead');
  });

  it('does not prompt when the pre-clear failed — the answer would be ambiguous', async () => {
    const client = fakeClient((emoji) => (emoji === '' ? new Error('clear boom') : undefined));
    const prompt = vi.fn().mockResolvedValue('y');
    const results = await runReactionSweep({ ...BASE, client, emojis: ['🔥'], noPrompt: false, prompt });
    expect(prompt).not.toHaveBeenCalled();
    expect(results[0]!.rendered).toBe('unverified');
  });

  it('downgrades to unverified when prompting was asked for but stdin is not interactive', async () => {
    // The bug this pins: with no injected prompt and a non-TTY stdin (a piped
    // run, or this test file), `ask` resolves to an empty line, which the
    // answer parser reads as "yes, exactly as sent". Every row came back
    // as-sent and the summary reported a clean pass for reactions nobody had
    // looked at. Recording `unverified` is the honest reading.
    const client = fakeClient();
    const results = await runReactionSweep({
      ...BASE,
      client,
      emojis: ['🔥'],
      noPrompt: false,
      prompt: undefined // force the real `ask` path — the one that misreads a pipe
    });
    expect(results[0]!.rendered).toBe('unverified');
    expect(isDeliverable(results[0]!)).toBe(false);
  });

  it('a final-clear failure does not lose the results', async () => {
    // The tidy-up is cosmetic; throwing there would discard a sweep the
    // operator just spent ten minutes confirming.
    let seen = 0;
    const client = {
      async sendReaction(_r: string, _t: string, emoji: string): Promise<void> {
        if (emoji === '') {
          seen += 1;
          if (seen > 1) throw new Error('final clear boom');
        }
      }
    };
    const results = await runReactionSweep({ ...BASE, client, emojis: ['🔥'] });
    expect(results).toHaveLength(1);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Batch sweep                                                                */
/* ────────────────────────────────────────────────────────────────────────── */

describe('runBatchSweep', () => {
  const BATCH_BASE = {
    channel: 'instagram' as const,
    recipientId: 'IGSID',
    pacingMs: 0,
    sleep: async () => {}
  };

  function targets(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      targetMessageId: `m_${i + 1}`,
      text: String(i + 1)
    }));
  }

  it('pairs emoji to messages POSITIONALLY, one each', async () => {
    const client = fakeClient();
    await runBatchSweep({ ...BATCH_BASE, client, targets: targets(3), emojis: ['❤️', '👍', '😆'] });
    expect(client.calls).toEqual([
      { recipient: 'IGSID', target: 'm_1', emoji: '❤️' },
      { recipient: 'IGSID', target: 'm_2', emoji: '👍' },
      { recipient: 'IGSID', target: 'm_3', emoji: '😆' }
    ]);
  });

  it('never clears — every reaction must coexist', async () => {
    // A clear here would wipe the previous message's reaction and defeat the
    // entire point of the mode: one screenshot showing all of them.
    const client = fakeClient();
    await runBatchSweep({ ...BATCH_BASE, client, targets: targets(3), emojis: ['❤️', '👍', '😆'] });
    expect(client.calls.some((c) => c.emoji === '')).toBe(false);
  });

  it('stops at the number of messages captured and leaves the rest untested', async () => {
    const client = fakeClient();
    const results = await runBatchSweep({
      ...BATCH_BASE,
      client,
      targets: targets(2),
      emojis: ['❤️', '👍', '😆', '‼️']
    });
    // Only what could actually be tested is reported. Reporting four rows off
    // two messages would be a fabricated result.
    expect(results).toHaveLength(2);
    expect(client.calls).toHaveLength(2);
  });

  it('carries the message text so the operator can map row → bubble', async () => {
    const client = fakeClient();
    const results = await runBatchSweep({ ...BATCH_BASE, client, targets: targets(2), emojis: ['❤️', '👍'] });
    expect(results.map((r) => r.targetText)).toEqual(['1', '2']);
  });

  it('leaves accepted rows UNVERIFIED — a batch run is half a result', async () => {
    const client = fakeClient();
    const results = await runBatchSweep({ ...BATCH_BASE, client, targets: targets(1), emojis: ['❤️'] });
    expect(results[0]!.apiAccepted).toBe(true);
    expect(results[0]!.rendered).toBe('unverified');
    expect(isDeliverable(results[0]!)).toBe(false);
  });

  it('records a rejection as nothing-rendered and keeps going', async () => {
    const client = fakeClient((emoji) =>
      emoji === '👍'
        ? new MetaApiError({ operation: 'instagram.sendReaction', httpStatus: 400, errorCode: 100, responseBody: {} })
        : undefined
    );
    const results = await runBatchSweep({ ...BATCH_BASE, client, targets: targets(3), emojis: ['❤️', '👍', '😆'] });
    expect(results.map((r) => r.apiAccepted)).toEqual([true, false, true]);
    expect(results[1]!.rendered).toBe('nothing');
  });
});

describe('parseBatchAnswers', () => {
  it('parses row=answer pairs', () => {
    expect([...parseBatchAnswers('1=y,2=n,3=a thumbs up')]).toEqual([
      [1, 'y'],
      [2, 'n'],
      [3, 'a thumbs up']
    ]);
  });

  it('allows = inside the answer text', () => {
    expect(parseBatchAnswers('1=looks like 2=3').get(1)).toBe('looks like 2=3');
  });

  it('rejects a duplicate row rather than letting the last one win', () => {
    // Silently overwriting would discard a reading the operator actually made.
    expect(() => parseBatchAnswers('1=y,1=n')).toThrow(/row 1 answered twice/);
  });

  it('rejects malformed and non-positive rows', () => {
    expect(() => parseBatchAnswers('y')).toThrow(/not <row>=<answer>/);
    expect(() => parseBatchAnswers('0=y')).toThrow(/non-positive-integer/);
    expect(() => parseBatchAnswers('x=y')).toThrow(/non-positive-integer/);
  });

  it('rejects an empty spec', () => {
    expect(() => parseBatchAnswers(' , ')).toThrow(/zero answers/);
  });
});

describe('applyBatchAnswers', () => {
  const rows = [
    outcome({ emoji: '❤️', rendered: 'unverified' }),
    outcome({ emoji: '👍', rendered: 'unverified' }),
    outcome({ emoji: '😆', rendered: 'unverified' }),
    outcome({ emoji: '‼️', apiAccepted: false, rendered: 'nothing' })
  ];

  it('maps y / n / free text onto the three verdicts', () => {
    const applied = applyBatchAnswers(rows, new Map([[1, 'y'], [2, 'n'], [3, 'a thumbs up']]));
    expect(applied.map((r) => r.rendered)).toEqual(['as-sent', 'nothing', 'substituted', 'nothing']);
    expect(applied[2]!.note).toBe('a thumbs up');
  });

  it('leaves an UNANSWERED row unverified — silence is not confirmation', () => {
    const applied = applyBatchAnswers(rows, new Map([[1, 'y']]));
    expect(applied[1]!.rendered).toBe('unverified');
    expect(isDeliverable(applied[1]!)).toBe(false);
  });

  it('ignores an answer on a REJECTED row — a typo must not manufacture a delivery', () => {
    const applied = applyBatchAnswers(rows, new Map([[4, 'y']]));
    expect(applied[3]!.rendered).toBe('nothing');
    expect(isDeliverable(applied[3]!)).toBe(false);
  });

  it('does not mutate the input', () => {
    applyBatchAnswers(rows, new Map([[1, 'y']]));
    expect(rows[0]!.rendered).toBe('unverified');
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* summarizeSweep + formatSweepMarkdown                                       */
/* ────────────────────────────────────────────────────────────────────────── */

describe('summarizeSweep', () => {
  const sweeps = [
    {
      channel: 'messenger' as const,
      outcomes: [
        outcome({ emoji: '❤️' }),
        outcome({ emoji: '🔥' }),
        outcome({ emoji: '🇺🇸', apiAccepted: false, rendered: 'nothing' })
      ]
    },
    {
      channel: 'instagram' as const,
      outcomes: [
        outcome({ emoji: '❤️' }),
        // Accepted by the API, invisible on the phone.
        outcome({ emoji: '🔥', rendered: 'nothing' }),
        outcome({ emoji: '🇺🇸', apiAccepted: false, rendered: 'nothing' })
      ]
    }
  ];

  it('partitions by how many channels actually delivered', () => {
    const s = summarizeSweep(sweeps);
    expect(s.deliverableEverywhere).toEqual(['❤️']);
    expect(s.partial).toEqual(['🔥']);
    expect(s.neverDeliverable).toEqual(['🇺🇸']);
  });

  it('flags the silent drop separately from the honest rejection', () => {
    const s = summarizeSweep(sweeps);
    // 🇺🇸 was REJECTED — visible in prod logs. 🔥 on instagram returned 200 and
    // showed nothing, which no log line would ever record. Only the second is a
    // silent drop, and conflating them would bury the finding.
    expect(s.silentDrops).toEqual([{ channel: 'instagram', emoji: '🔥' }]);
  });

  it('reports no silent drops when every accept rendered', () => {
    const clean = [{ channel: 'messenger' as const, outcomes: [outcome({ emoji: '❤️' })] }];
    expect(summarizeSweep(clean).silentDrops).toEqual([]);
  });

  it('the markdown carries the verdict, the codepoints, and the silent-drop warning', () => {
    const md = formatSweepMarkdown(sweeps, 'test-session');
    expect(md).toContain('# Reaction emoji sweep — test-session');
    expect(md).toContain('## messenger');
    expect(md).toContain('## instagram');
    expect(md).toContain('U+2764 U+FE0F');
    expect(md).toContain('Silent drops');
    // The Delivered column must read NO for the silent drop.
    const igSection = md.slice(md.indexOf('## instagram'));
    const fireRow = igSection.split('\n').find((l) => l.startsWith('| 🔥'));
    expect(fireRow).toBeDefined();
    expect(fireRow).toContain('| NO |');
  });
});
