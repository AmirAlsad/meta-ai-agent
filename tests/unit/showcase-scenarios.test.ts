/**
 * Unit tests for the PURE showcase helpers (`scripts/dev/showcase-scenarios.ts`)
 * and the showcase harness's pure flag parser.
 *
 * The harness itself (`scripts/dev/showcase.ts`) needs real Meta creds + ngrok +
 * a device and can't run in CI, but the scenario logic — selection, filtering,
 * the deterministic chat router, summary aggregation, and `--list` rendering — is
 * pure and tested here. The inbound-gesture cross-check keeps the showcase matrix
 * co-evolved with the guided-capture corpus.
 */
import { describe, expect, it } from 'vitest';
import {
  SHOWCASE_SCENARIOS,
  SHOWCASE_SCENARIOS_BY_CHANNEL,
  selectShowcaseScenarios,
  formatShowcaseScenarioList,
  inboundGestureMismatches,
  isSkipContent,
  buildShowcaseChatResponse,
  summarizeUnderstanding,
  summarizeShowcaseStep,
  aggregateSessionTotals,
  DEFAULT_SHOWCASE_MEDIA_URL,
  type ShowcaseScenario,
  type ShowcaseInboundEnvelope,
  type ShowcaseChatExchange,
  type ShowcaseOutboundCall
} from '../../scripts/dev/showcase-scenarios.js';
import { parseShowcaseFlags } from '../../scripts/dev/showcase.js';
import type { ChatRequest } from '../../src/chat/types.js';
import type { Channel, IncomingMessage } from '../../src/meta/types.js';

/* ────────────────────────────────────────────────────────────────────────── */
/* Fixtures                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

function msg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    channel: 'whatsapp',
    channelMessageId: 'wamid.X',
    channelScopedUserId: 'u1',
    channelScopedBusinessId: 'b1',
    timestamp: 1_700_000_000_000,
    type: 'text',
    text: 'hi',
    raw: {},
    ...overrides
  };
}

function req(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    channel: 'whatsapp',
    conversationKey: 'whatsapp:b1:u1',
    message: 'hi',
    messages: [msg()],
    capabilities: [],
    context: { windowOpen: true },
    ...overrides
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Scenario inventory                                                         */
/* ────────────────────────────────────────────────────────────────────────── */

describe('showcase scenario inventory', () => {
  it('covers the core matrix across the three channels', () => {
    // WhatsApp gets the template step on top of text/reply/reaction/typing/media.
    expect(SHOWCASE_SCENARIOS_BY_CHANNEL.whatsapp.map(s => s.id)).toEqual([
      'whatsapp:text',
      'whatsapp:reply',
      'whatsapp:reaction',
      'whatsapp:typing',
      'whatsapp:media',
      'whatsapp:template'
    ]);
    // Messenger: no template.
    expect(SHOWCASE_SCENARIOS_BY_CHANNEL.messenger.map(s => s.id)).toEqual([
      'messenger:text',
      'messenger:reply',
      'messenger:reaction',
      'messenger:typing',
      'messenger:media'
    ]);
    // Instagram: reply is the downgrade case (optional), no template.
    expect(SHOWCASE_SCENARIOS_BY_CHANNEL.instagram.map(s => s.id)).toEqual([
      'instagram:text',
      'instagram:reply',
      'instagram:reaction',
      'instagram:typing',
      'instagram:media'
    ]);
  });

  it('marks the Instagram reply step optional (no native quoted reply)', () => {
    const igReply = SHOWCASE_SCENARIOS_BY_CHANNEL.instagram.find(s => s.id === 'instagram:reply');
    expect(igReply?.optional).toBe(true);
    const waReply = SHOWCASE_SCENARIOS_BY_CHANNEL.whatsapp.find(s => s.id === 'whatsapp:reply');
    expect(waReply?.optional).toBeFalsy();
  });

  it('SHOWCASE_SCENARIOS is frozen', () => {
    expect(() => {
      (SHOWCASE_SCENARIOS as unknown as ShowcaseScenario[]).push({
        id: 'x',
        channel: 'whatsapp',
        title: '',
        instruction: '',
        expectedActions: []
      });
    }).toThrow();
  });

  it('every inbound-bearing scenario references a real guided-capture gesture', () => {
    expect(inboundGestureMismatches()).toEqual([]);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* selectShowcaseScenarios                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

describe('selectShowcaseScenarios', () => {
  it('returns all scenarios with no filter', () => {
    expect(selectShowcaseScenarios({})).toHaveLength(SHOWCASE_SCENARIOS.length);
  });

  it('scopes to a single channel', () => {
    const selected = selectShowcaseScenarios({ channel: 'messenger' });
    expect(selected.every(s => s.channel === 'messenger')).toBe(true);
    expect(selected).toHaveLength(SHOWCASE_SCENARIOS_BY_CHANNEL.messenger.length);
  });

  it('filters by --only ids, preserving requested order', () => {
    const selected = selectShowcaseScenarios({ only: ['whatsapp:media', 'whatsapp:text'] });
    expect(selected.map(s => s.id)).toEqual(['whatsapp:media', 'whatsapp:text']);
  });

  it('combines --channel scope with --only', () => {
    const selected = selectShowcaseScenarios({ channel: 'whatsapp', only: ['whatsapp:template'] });
    expect(selected.map(s => s.id)).toEqual(['whatsapp:template']);
  });

  it('throws when --only names an unknown id', () => {
    expect(() => selectShowcaseScenarios({ only: ['nope:nope'] })).toThrow(/Unknown showcase scenario id/);
  });

  it('throws when --only id is outside the --channel scope', () => {
    // whatsapp:template is not a messenger scenario.
    expect(() => selectShowcaseScenarios({ channel: 'messenger', only: ['whatsapp:template'] })).toThrow(
      /Unknown showcase scenario id/
    );
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* --list rendering                                                           */
/* ────────────────────────────────────────────────────────────────────────── */

describe('formatShowcaseScenarioList', () => {
  it('groups scenario ids by channel and tags optionals', () => {
    const lines = formatShowcaseScenarioList();
    expect(lines[0]).toMatch(/Available showcase scenarios/);
    const text = lines.join('\n');
    expect(text).toContain('whatsapp:');
    expect(text).toContain('messenger:');
    expect(text).toContain('instagram:');
    expect(text).toContain('whatsapp:template');
    expect(text).toContain('instagram:reply (optional)');
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Deterministic chat router                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

describe('buildShowcaseChatResponse', () => {
  it('echoes text with the buffered message count', () => {
    const res = buildShowcaseChatResponse(req({ message: 'hello world', messages: [msg({ text: 'hello world' })] }));
    expect(res.actions?.[0]).toMatchObject({ type: 'message' });
    const action = res.actions?.[0];
    expect(action && 'text' in action ? action.text : '').toContain('(1 msg)');
    expect(action && 'text' in action ? action.text : '').toContain('hello world');
  });

  it('routes "template" to a template action', () => {
    const res = buildShowcaseChatResponse(req({ message: 'template' }));
    expect(res.actions?.[0]).toMatchObject({ type: 'template', name: 'hello_world', language: 'en_US' });
  });

  it('routes "reply" to a reply action with the last alias target', () => {
    const res = buildShowcaseChatResponse(req({ message: 'reply' }));
    const action = res.actions?.[0];
    expect(action).toMatchObject({ type: 'reply' });
    expect(action && 'targetMessageId' in action ? action.targetMessageId : undefined).toEqual({ alias: 'last' });
  });

  it('routes "react" to a reaction action', () => {
    const res = buildShowcaseChatResponse(req({ message: 'react' }));
    expect(res.actions?.[0]).toMatchObject({ type: 'reaction', emoji: '👍' });
  });

  it('routes "typing" to a typing action then a message', () => {
    const res = buildShowcaseChatResponse(req({ message: 'typing' }));
    expect(res.actions?.map(a => a.type)).toEqual(['typing', 'message']);
  });

  it('routes "media" to a media action using the default url', () => {
    const res = buildShowcaseChatResponse(req({ message: 'media' }));
    expect(res.actions?.[0]).toMatchObject({ type: 'media', url: DEFAULT_SHOWCASE_MEDIA_URL });
  });

  it('honors a media url override', () => {
    const res = buildShowcaseChatResponse(req({ message: 'media' }), { mediaUrl: 'https://example.com/x.png' });
    const action = res.actions?.[0];
    expect(action && 'url' in action ? action.url : '').toBe('https://example.com/x.png');
  });

  it('returns silence for a "silence" keyword and for a skip reply', () => {
    expect(buildShowcaseChatResponse(req({ message: 'silence' }))).toEqual({ silence: true });
    expect(buildShowcaseChatResponse(req({ message: 'skip' }))).toEqual({ silence: true });
  });
});

describe('summarizeUnderstanding', () => {
  it('prefers the aggregated text', () => {
    expect(summarizeUnderstanding(req({ message: '  hi there  ' }))).toBe('hi there');
  });

  it('falls back to a reaction description', () => {
    const r = req({
      message: '',
      messages: [msg({ type: 'reaction', text: undefined, reaction: { emoji: '❤️', targetMessageId: 'wamid.T' } })]
    });
    expect(summarizeUnderstanding(r)).toContain('reaction');
  });

  it('falls back to a media description', () => {
    const r = req({
      message: '',
      messages: [msg({ type: 'image', text: undefined, media: { id: 'm1', mimeType: 'image/jpeg' } })]
    });
    expect(summarizeUnderstanding(r)).toContain('media');
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Summary aggregation                                                        */
/* ────────────────────────────────────────────────────────────────────────── */

function inbound(channel: Channel = 'whatsapp'): ShowcaseInboundEnvelope {
  return { at: new Date().toISOString(), channel, body: {}, signatureValid: true };
}
function outboundOk(): ShowcaseOutboundCall {
  return { at: new Date().toISOString(), channel: 'whatsapp', method: 'POST /m', recipientId: 'u1', ok: true };
}
function outboundFail(): ShowcaseOutboundCall {
  return {
    at: new Date().toISOString(),
    channel: 'whatsapp',
    method: 'POST /m',
    recipientId: 'u1',
    ok: false,
    error: 'HTTP 400'
  };
}
function exchange(messageCount = 1, understood = 'hi'): ShowcaseChatExchange {
  return {
    at: new Date().toISOString(),
    channel: 'whatsapp',
    messageCount,
    understood,
    request: req(),
    response: {}
  };
}

const textScenario = SHOWCASE_SCENARIOS_BY_CHANNEL.whatsapp[0]!;

describe('summarizeShowcaseStep', () => {
  it('marks a step matched when an inbound + a successful outbound are present', () => {
    const summary = summarizeShowcaseStep({
      scenario: textScenario,
      skipped: false,
      inbound: [inbound()],
      exchanges: [exchange(2, 'two msgs')],
      outbound: [outboundOk()]
    });
    expect(summary.matched).toBe(true);
    expect(summary.inboundCount).toBe(1);
    expect(summary.outboundSucceededCount).toBe(1);
    expect(summary.maxBufferedMessageCount).toBe(2);
    expect(summary.understood).toBe('two msgs');
  });

  it('is incomplete when the outbound failed', () => {
    const summary = summarizeShowcaseStep({
      scenario: textScenario,
      skipped: false,
      inbound: [inbound()],
      exchanges: [exchange()],
      outbound: [outboundFail()]
    });
    expect(summary.matched).toBe(false);
    expect(summary.outboundFailedCount).toBe(1);
    expect(summary.outboundSucceededCount).toBe(0);
  });

  it('honors the skipped flag', () => {
    const summary = summarizeShowcaseStep({
      scenario: textScenario,
      skipped: true,
      inbound: [],
      exchanges: [],
      outbound: []
    });
    expect(summary.skipped).toBe(true);
    expect(summary.matched).toBe(false);
  });
});

describe('aggregateSessionTotals', () => {
  it('rolls per-step summaries into session totals', () => {
    const steps = [
      summarizeShowcaseStep({
        scenario: textScenario,
        skipped: false,
        inbound: [inbound()],
        exchanges: [exchange()],
        outbound: [outboundOk()]
      }),
      summarizeShowcaseStep({
        scenario: textScenario,
        skipped: true,
        inbound: [],
        exchanges: [],
        outbound: []
      }),
      summarizeShowcaseStep({
        scenario: textScenario,
        skipped: false,
        inbound: [inbound()],
        exchanges: [exchange()],
        outbound: [outboundFail()]
      })
    ];
    expect(aggregateSessionTotals(steps)).toEqual({
      steps: 3,
      matched: 1,
      skipped: 1,
      incomplete: 1,
      outboundSucceeded: 1,
      outboundFailed: 1
    });
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* isSkipContent                                                              */
/* ────────────────────────────────────────────────────────────────────────── */

describe('isSkipContent', () => {
  it('matches skip variants case-insensitively', () => {
    for (const v of ['skip', 'SKIP', '  next  ', 'skip step', 'skip this']) {
      expect(isSkipContent(v)).toBe(true);
    }
  });
  it('does not match ordinary text or undefined', () => {
    expect(isSkipContent('hello')).toBe(false);
    expect(isSkipContent(undefined)).toBe(false);
    expect(isSkipContent('skipper')).toBe(false);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* parseShowcaseFlags                                                         */
/* ────────────────────────────────────────────────────────────────────────── */

describe('parseShowcaseFlags', () => {
  it('parses --channel and --only', () => {
    const flags = parseShowcaseFlags(['--channel=whatsapp', '--only=whatsapp:text,whatsapp:media']);
    expect(flags.channel).toBe('whatsapp');
    expect(flags.only).toEqual(['whatsapp:text', 'whatsapp:media']);
  });

  it('parses --list and --help', () => {
    expect(parseShowcaseFlags(['--list']).list).toBe(true);
    expect(parseShowcaseFlags(['--help']).help).toBe(true);
    expect(parseShowcaseFlags(['-h']).help).toBe(true);
  });

  it('parses --media-url, --timeout-ms, --settle-ms', () => {
    const flags = parseShowcaseFlags(['--media-url=https://x/y.png', '--timeout-ms=1000', '--settle-ms=200']);
    expect(flags.mediaUrl).toBe('https://x/y.png');
    expect(flags.timeoutMs).toBe(1000);
    expect(flags.settleMs).toBe(200);
  });

  it('rejects an invalid --channel', () => {
    expect(() => parseShowcaseFlags(['--channel=sms'])).toThrow(/Invalid --channel/);
  });

  it('rejects unknown flags', () => {
    expect(() => parseShowcaseFlags(['--bogus'])).toThrow(/Unknown flag/);
  });
});
