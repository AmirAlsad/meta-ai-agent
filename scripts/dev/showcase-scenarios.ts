/**
 * Pure helpers for the scripted live showcase harness (`scripts/dev/showcase.ts`).
 *
 * Everything here is SIDE-EFFECT-FREE and unit-tested
 * (`tests/unit/showcase-scenarios.test.ts`): scenario definitions, the
 * `--channel` / `--only` filter, the deterministic scenario-aware chat-endpoint
 * response router, per-step summary aggregation, and the `--list` rendering. The
 * I/O — booting the runtime, the tunnel, webhook registration, prompting the
 * operator — lives in `showcase.ts`, which imports from here.
 *
 * WHY a separate module: the harness needs real Meta creds + ngrok + a device to
 * run end-to-end and can't execute in CI, but the SCENARIO LOGIC (what each step
 * expects, how the chat endpoint should respond, how a step is scored) is pure
 * and worth testing. Keeping it here lets `showcase.ts` stay a thin orchestrator.
 *
 * Relationship to guided-capture: the inbound user gestures we drive (text,
 * image, reaction, reply, …) are the SAME matrix the guided-capture walker
 * captures. We import {@link SCENARIOS_BY_CHANNEL} from there as the source of
 * truth for which inbound gestures each channel supports, then layer the
 * showcase-specific bits on top — the operator instruction, the keyword the
 * operator types to trigger an OUTBOUND action (typing/template/media), and the
 * outbound action the deterministic chat endpoint produces in response.
 */
import type { Channel, IncomingMessage } from '../../src/meta/types.js';
import type { ChatRequest, ChatResponse, ChatAction } from '../../src/chat/types.js';
import { SCENARIOS_BY_CHANNEL, ALL_CHANNELS } from '../capture/guided-capture.js';

/* ────────────────────────────────────────────────────────────────────────── */
/* Scenario model                                                             */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * One scripted showcase step. The `id` is GLOBALLY UNIQUE (channel-prefixed,
 * e.g. `whatsapp:text`) so `--only` can target a single channel's variant
 * unambiguously. `keyword`, when present, is the literal text the operator types
 * to trigger an outbound action (the chat endpoint matches on it). `inbound`,
 * when present, names the matching guided-capture gesture (so the inbound matrix
 * stays co-evolved with the capture corpus).
 */
export interface ShowcaseScenario {
  /** Channel-prefixed unique id, e.g. `whatsapp:reaction`. */
  id: string;
  channel: Channel;
  /** Short human title shown in the step header + summary. */
  title: string;
  /** Operator instruction printed when the step activates. */
  instruction: string;
  /**
   * The name of the matching guided-capture inbound gesture, when this step is
   * driven by a user gesture (text/image/reaction/reply/…). Cross-checked
   * against {@link SCENARIOS_BY_CHANNEL} so a typo here fails the unit tests.
   */
  inbound?: string;
  /**
   * The literal keyword the operator types to trigger the OUTBOUND action under
   * test (typing / template / media). The deterministic chat endpoint matches on
   * it. Absent for pure-inbound-understanding steps (text/reaction/reply).
   */
  keyword?: string;
  /** Outbound action types the chat endpoint emits for this step (for scoring). */
  expectedActions: ChatAction['type'][];
  /** Optional steps can be `skip`-ped without counting as a failure. */
  optional?: boolean;
}

/**
 * Build the showcase scenario list for one channel. Order is intentional: the
 * core matrix runs first (text → reply → reaction → typing → media), then the
 * WhatsApp-only template step. Inbound-gesture steps reference a guided-capture
 * scenario name; outbound-action steps carry a `keyword`.
 */
function scenariosFor(channel: Channel): ShowcaseScenario[] {
  const replySupported = channel !== 'instagram'; // IG-Login has no outbound quoted reply.
  // The guided-capture text gesture is named `text-dm` on Instagram, `text`
  // elsewhere — keep the cross-check (inboundGestureMismatches) honest.
  const textGesture = channel === 'instagram' ? 'text-dm' : 'text';
  const list: ShowcaseScenario[] = [
    {
      id: `${channel}:text`,
      channel,
      title: 'Text echo',
      inbound: textGesture,
      instruction: 'Send one short text message. I will echo back the text I understood.',
      expectedActions: ['message']
    }
  ];

  if (replySupported) {
    list.push({
      id: `${channel}:reply`,
      channel,
      title: 'Quoted reply',
      keyword: 'reply',
      instruction:
        'Send the word "reply". I will respond with a quoted reply targeting your message.',
      expectedActions: ['reply']
    });
  } else {
    // Instagram: no native outbound reply — the agent downgrades reply→message.
    list.push({
      id: `${channel}:reply`,
      channel,
      title: 'Reply downgrade (IG has no quoted reply)',
      keyword: 'reply',
      optional: true,
      instruction:
        'Send the word "reply". Instagram-Login has no outbound quoted reply, so the agent downgrades it to a plain message — you should still get the text.',
      expectedActions: ['reply']
    });
  }

  list.push(
    {
      id: `${channel}:reaction`,
      channel,
      title: 'Reaction',
      keyword: 'react',
      instruction: 'Send the word "react". I will react to your message with a 👍.',
      expectedActions: ['reaction']
    },
    {
      id: `${channel}:typing`,
      channel,
      title: 'Typing indicator then message',
      keyword: 'typing',
      instruction:
        'Send the word "typing". I will show a typing indicator for a few seconds, then send a message.',
      expectedActions: ['typing', 'message']
    },
    {
      id: `${channel}:media`,
      channel,
      title: 'Outbound media',
      keyword: 'media',
      instruction: 'Send the word "media". I will send an image with a caption.',
      expectedActions: ['media']
    }
  );

  if (channel === 'whatsapp') {
    list.push({
      id: `${channel}:template`,
      channel,
      title: 'WhatsApp template (hello_world)',
      keyword: 'template',
      instruction:
        'Send the word "template". I will send the pre-approved hello_world template (WhatsApp-only).',
      expectedActions: ['template']
    });
  }

  return list;
}

/** All showcase scenarios across every channel, in channel order. */
export const SHOWCASE_SCENARIOS: readonly ShowcaseScenario[] = Object.freeze(
  ALL_CHANNELS.flatMap(channel => scenariosFor(channel))
);

/** Channel-keyed showcase scenarios. */
export const SHOWCASE_SCENARIOS_BY_CHANNEL: Record<Channel, readonly ShowcaseScenario[]> = {
  whatsapp: SHOWCASE_SCENARIOS.filter(s => s.channel === 'whatsapp'),
  messenger: SHOWCASE_SCENARIOS.filter(s => s.channel === 'messenger'),
  instagram: SHOWCASE_SCENARIOS.filter(s => s.channel === 'instagram')
};

/* ────────────────────────────────────────────────────────────────────────── */
/* Scenario selection (--channel / --only)                                    */
/* ────────────────────────────────────────────────────────────────────────── */

export interface ShowcaseSelection {
  channel?: Channel;
  /** Scenario ids (channel-prefixed) to run; undefined ⇒ all for the channel. */
  only?: string[];
}

/**
 * Resolve the scenarios to run from `--channel` + `--only`. PURE so it can be
 * unit-tested. Rules:
 *  - `--channel` scopes to that channel's scenarios (default: all channels).
 *  - `--only=a,b,c` keeps only those ids (matched WITHIN the channel scope), in
 *    the order they were requested.
 *  - An unknown `--only` id throws (fail loud — a typo should not silently run
 *    nothing).
 */
export function selectShowcaseScenarios(selection: ShowcaseSelection): ShowcaseScenario[] {
  const scoped = selection.channel
    ? SHOWCASE_SCENARIOS.filter(s => s.channel === selection.channel)
    : [...SHOWCASE_SCENARIOS];

  if (!selection.only || selection.only.length === 0) return scoped;

  const byId = new Map(scoped.map(s => [s.id, s]));
  const out: ShowcaseScenario[] = [];
  const unknown: string[] = [];
  for (const id of selection.only) {
    const found = byId.get(id);
    if (found) out.push(found);
    else unknown.push(id);
  }
  if (unknown.length > 0) {
    const available = scoped.map(s => s.id).join(', ');
    throw new Error(
      `Unknown showcase scenario id(s): ${unknown.join(', ')}. ` +
        `Available${selection.channel ? ` for ${selection.channel}` : ''}: ${available}. ` +
        `Run with --list to see all ids.`
    );
  }
  return out;
}

/**
 * Render the scenario inventory for `--list`: one section per channel, listing
 * each scenario's id + title (and an `(optional)` tag). PURE — returns lines so
 * the caller decides where they go and so it's unit-testable.
 */
export function formatShowcaseScenarioList(
  registry: Record<Channel, readonly ShowcaseScenario[]> = SHOWCASE_SCENARIOS_BY_CHANNEL
): string[] {
  const lines: string[] = ['Available showcase scenarios (by channel):'];
  for (const channel of ALL_CHANNELS) {
    lines.push(`  ${channel}:`);
    for (const scenario of registry[channel]) {
      const optional = scenario.optional ? ' (optional)' : '';
      lines.push(`    - ${scenario.id}${optional}: ${scenario.title}`);
    }
  }
  return lines;
}

/**
 * Cross-check that every `inbound`-bearing showcase scenario names a real
 * guided-capture gesture for its channel. Returns the list of mismatches (empty
 * = consistent). Used by the unit tests to keep the two scenario sets co-evolved
 * — if guided-capture renames a gesture, this surfaces it.
 */
export function inboundGestureMismatches(): string[] {
  const mismatches: string[] = [];
  for (const scenario of SHOWCASE_SCENARIOS) {
    if (scenario.inbound === undefined) continue;
    const names = SCENARIOS_BY_CHANNEL[scenario.channel].map(s => s.name);
    if (!names.includes(scenario.inbound)) {
      mismatches.push(`${scenario.id} → inbound "${scenario.inbound}" not in ${scenario.channel}`);
    }
  }
  return mismatches;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Skip handling                                                              */
/* ────────────────────────────────────────────────────────────────────────── */

/** True when the aggregated inbound text is a "skip this step" request. */
export function isSkipContent(content: string | undefined): boolean {
  return /^\s*(skip|skip this|skip step|next)\s*$/i.test(content ?? '');
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Deterministic scenario-aware chat endpoint                                 */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Map a buffered inbound turn to a deterministic {@link ChatResponse} for the
 * showcase. This is the scenario-aware sibling of `dev/test-chat-endpoint.ts`'s
 * keyword router: it picks the outbound action by scanning the aggregated text
 * for the showcase keywords (reply / react / typing / media / template /
 * silence), and otherwise echoes what it understood. PURE — `showcase.ts` wraps
 * it in an Express server.
 *
 * `mediaUrl` lets the harness override the demo image URL (e.g. from
 * SHOWCASE_MEDIA_URL); it defaults to a small public sample so the media step
 * works out of the box on WhatsApp/Messenger (Instagram media is more
 * restrictive and may be rejected by Meta — that's surfaced as a skipped item).
 */
export function buildShowcaseChatResponse(
  req: ChatRequest,
  options: { mediaUrl?: string } = {}
): ChatResponse {
  const text = (req.message ?? '').toLowerCase();
  const understood = summarizeUnderstanding(req);
  // Reply / reaction target the LAST inbound of the buffered turn — the message
  // the user most recently sent, so it reads naturally on the device. Use the
  // symbolic 'last' alias so the agent resolves it against the buffered inbounds.
  const lastTarget = { alias: 'last' as const };
  const mediaUrl = options.mediaUrl ?? DEFAULT_SHOWCASE_MEDIA_URL;

  if (isSkipContent(req.message) || text.includes('silence')) {
    return { silence: true };
  }
  if (text.includes('template')) {
    return { actions: [{ type: 'template', name: 'hello_world', language: 'en_US' }] };
  }
  if (text.includes('reply')) {
    return {
      actions: [{ type: 'reply', text: `↩️ quoted reply — understood: ${understood}`, targetMessageId: lastTarget }]
    };
  }
  if (text.includes('react')) {
    return { actions: [{ type: 'reaction', emoji: '👍', targetMessageId: lastTarget }] };
  }
  if (text.includes('typing')) {
    return {
      actions: [
        { type: 'typing', durationMs: 3000 },
        { type: 'message', text: `done typing — understood: ${understood}` }
      ]
    };
  }
  if (text.includes('media')) {
    return { actions: [{ type: 'media', url: mediaUrl, caption: 'showcase sample', mimeType: 'image/jpeg' }] };
  }

  // Default / echo. Surface the buffered message COUNT so a multi-message burst
  // makes buffering visible (a 3-message burst shows "(3 msg)").
  return {
    actions: [{ type: 'message', text: `echo [${req.channel}] (${req.messages.length} msg): ${understood}` }]
  };
}

/** A small public sample image — works for WhatsApp/Messenger outbound media. */
export const DEFAULT_SHOWCASE_MEDIA_URL = 'https://www.gstatic.com/webp/gallery/1.jpg';

/**
 * Summarize what the agent understood from a buffered turn for the operator-
 * facing echo + the summary. Prefers the aggregated text; falls back to a
 * media/reaction description so non-text gestures still read sensibly.
 */
export function summarizeUnderstanding(req: ChatRequest): string {
  const text = (req.message ?? '').trim();
  if (text) return text;
  const last = req.messages.at(-1);
  if (last) {
    if (last.type === 'reaction' && last.reaction) {
      return `reaction ${last.reaction.emoji ?? ''}`.trim();
    }
    if (last.media) return `media (${last.type})`;
    return `${last.type} message`;
  }
  return 'empty turn';
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Outbound instrumentation + summary aggregation                             */
/* ────────────────────────────────────────────────────────────────────────── */

/** One recorded outbound Graph send attempt (instrumented in showcase.ts). */
export interface ShowcaseOutboundCall {
  at: string;
  channel: Channel;
  /** The adapter method invoked (sendText / sendReaction / sendMedia / …). */
  method: string;
  recipientId: string;
  /** True when the send returned a SendResult; false when it threw. */
  ok: boolean;
  /** Channel message id, on success. */
  messageId?: string;
  /** Error message, on failure. */
  error?: string;
}

/** One recorded chat-endpoint exchange (request + response). */
export interface ShowcaseChatExchange {
  at: string;
  scenarioId?: string;
  channel: Channel;
  /** Buffered message count for the turn — surfaces the buffer width. */
  messageCount: number;
  understood: string;
  request: ChatRequest;
  response: ChatResponse;
}

/** One captured raw inbound webhook envelope. */
export interface ShowcaseInboundEnvelope {
  at: string;
  scenarioId?: string;
  /** Channel inferred from the `object` discriminator. */
  channel: Channel | 'unknown';
  /** The raw JSON body Meta posted (bit-faithful). */
  body: unknown;
  /** True when the candidate-secret signature check passed. */
  signatureValid: boolean;
}

/** Per-step summary, mirroring the sibling sendblue showcase's summary shape. */
export interface ShowcaseStepSummary {
  scenarioId: string;
  title: string;
  channel: Channel;
  optional: boolean;
  skipped: boolean;
  matched: boolean;
  inboundCount: number;
  chatRequestCount: number;
  maxBufferedMessageCount: number;
  outboundCount: number;
  outboundSucceededCount: number;
  outboundFailedCount: number;
  expectedActions: ChatAction['type'][];
  understood?: string;
}

/**
 * Aggregate one step's captured activity into a {@link ShowcaseStepSummary}.
 * PURE so it's unit-testable. `matched` means at least one inbound arrived AND at
 * least one outbound succeeded (or it was an explicit silence step — none here).
 */
export function summarizeShowcaseStep(args: {
  scenario: ShowcaseScenario;
  skipped: boolean;
  inbound: ShowcaseInboundEnvelope[];
  exchanges: ShowcaseChatExchange[];
  outbound: ShowcaseOutboundCall[];
}): ShowcaseStepSummary {
  const outboundSucceeded = args.outbound.filter(c => c.ok).length;
  const outboundFailed = args.outbound.filter(c => !c.ok).length;
  const maxBuffered = args.exchanges.reduce((max, ex) => Math.max(max, ex.messageCount), 0);
  const matched = !args.skipped && args.inbound.length > 0 && outboundSucceeded > 0;

  return {
    scenarioId: args.scenario.id,
    title: args.scenario.title,
    channel: args.scenario.channel,
    optional: args.scenario.optional ?? false,
    skipped: args.skipped,
    matched,
    inboundCount: args.inbound.length,
    chatRequestCount: args.exchanges.length,
    maxBufferedMessageCount: maxBuffered,
    outboundCount: args.outbound.length,
    outboundSucceededCount: outboundSucceeded,
    outboundFailedCount: outboundFailed,
    expectedActions: args.scenario.expectedActions,
    understood: args.exchanges.at(-1)?.understood
  };
}

/** Roll per-step summaries up into the session totals written to summary.json. */
export interface ShowcaseSessionTotals {
  steps: number;
  matched: number;
  skipped: number;
  incomplete: number;
  outboundSucceeded: number;
  outboundFailed: number;
}

export function aggregateSessionTotals(steps: ShowcaseStepSummary[]): ShowcaseSessionTotals {
  let matched = 0;
  let skipped = 0;
  let incomplete = 0;
  let outboundSucceeded = 0;
  let outboundFailed = 0;
  for (const step of steps) {
    if (step.skipped) skipped += 1;
    else if (step.matched) matched += 1;
    else incomplete += 1;
    outboundSucceeded += step.outboundSucceededCount;
    outboundFailed += step.outboundFailedCount;
  }
  return { steps: steps.length, matched, skipped, incomplete, outboundSucceeded, outboundFailed };
}

/**
 * Best-effort: extract the aggregated inbound text from a captured webhook body
 * so the harness can detect a `skip` reply WITHOUT depending on the parser. Pure
 * + defensive (tolerates any shape). Used only for skip-detection convenience.
 */
export function readInboundTextFromMessages(messages: IncomingMessage[]): string {
  return messages
    .map(m => m.text ?? '')
    .filter(Boolean)
    .join(' ')
    .trim();
}
