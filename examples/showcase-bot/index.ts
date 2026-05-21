/**
 * REFERENCE IMPLEMENTATION — LLM-backed showcase chat endpoint for meta-ai-agent.
 *
 * This is the DEVELOPER'S side of the `CHAT_ENDPOINT_URL` contract: the HTTP
 * server the meta-ai-agent transport package POSTs each buffered inbound turn
 * to. The agent sends a {@link ChatRequest}; this endpoint calls Claude (via the
 * official Anthropic SDK) and returns a {@link ChatResponse} — plain text plus,
 * where the channel supports it, rich `actions[]` (reactions / threaded replies)
 * emitted through Claude TOOL USE.
 *
 * It is intentionally a SEPARATE npm package (`meta-ai-agent-showcase-bot`) with
 * its OWN dependencies: it brings `@anthropic-ai/sdk`, which the root
 * `meta-ai-agent` package must never pull in (the root stays model-provider-free
 * — see CLAUDE.md). It is excluded from the root typecheck/test and never
 * imported by `src/`. A real consumer would install `meta-ai-agent` and import
 * the contract types from it; for a self-contained example we define minimal
 * local copies of those interfaces below, matching the documented contract
 * field-for-field (see `docs/features/rich-chat-actions.md`).
 *
 * What it demonstrates:
 *  - multi-turn conversation history (per `conversationKey`, in-memory),
 *  - prompt caching on the system prompt (`cache_control: ephemeral`),
 *  - channel / capability-aware replies (only offers a reaction tool when the
 *    channel supports reactions; tells the model what the channel can do),
 *  - rich actions via tool use (reaction + threaded reply tools → ChatActions).
 *
 * Run: see README.md. Env: ANTHROPIC_API_KEY (required), SHOWCASE_MODEL,
 * MAX_TOKENS, PORT (default 4003).
 */
import 'dotenv/config';
import path from 'node:path';
import express, { type Request, type Response } from 'express';
import Anthropic from '@anthropic-ai/sdk';

/* ────────────────────────────────────────────────────────────────────────── */
/* Local copies of the meta-ai-agent chat contract                            */
/*                                                                            */
/* These mirror `src/chat/types.ts` field-for-field. A published consumer would */
/* `import type { ChatRequest, ChatResponse, ChatAction } from 'meta-ai-agent'`;*/
/* keeping local copies here keeps the example self-contained and decoupled    */
/* from the transport package's internals.                                     */
/* ────────────────────────────────────────────────────────────────────────── */

/** The channels meta-ai-agent speaks. */
type Channel = 'whatsapp' | 'messenger' | 'instagram';

/**
 * Capabilities the responding channel adapter advertises (`supports()` truth
 * set). The endpoint tailors its `actions[]` to what the channel can do — e.g.
 * `template` is WhatsApp-only; Instagram has no working `reply_to`.
 */
type ChannelFeature =
  | 'typing_indicator'
  | 'read_receipt'
  | 'reaction'
  | 'reply_to'
  | 'template'
  | 'persistent_menu'
  | 'get_started'
  | 'ice_breakers'
  | 'story_reply'
  | 'media_send';

/** One normalized inbound message in the buffered turn (a trimmed view of the contract's `IncomingMessage`). */
interface IncomingMessage {
  channel: Channel;
  /** `wamid.*` (WhatsApp) / `m_*` (Messenger) / IGSID-scoped id (Instagram). */
  channelMessageId: string;
  channelScopedUserId: string;
  channelScopedBusinessId: string;
  timestamp: number;
  /** `text` / `image` / `reaction` / ... — only `type` + `text` are load-bearing for this example. */
  type: string;
  text?: string;
  reaction?: { emoji?: string; targetMessageId?: string };
  replyTo?: string;
}

/** Resolved identity for the user, when available. */
interface Contact {
  channel: string;
  channelScopedUserId: string;
  firstName?: string;
  lastName?: string;
  displayName?: string;
  email?: string;
  tags?: string[];
  customVariables?: Record<string, string>;
  unifiedContactId?: string;
}

/** Payload POSTed to the chat endpoint for one (possibly buffered) inbound turn. */
interface ChatRequest {
  channel: Channel;
  conversationKey: string;
  /** Backward-compat aggregated text (the buffered message bodies, newline-joined). */
  message: string;
  /** Structured per-message array for the buffered turn, in arrival order. */
  messages: IncomingMessage[];
  /** Resolved identity for the user, when available. */
  contact?: Contact;
  /** The channel adapter's `supports()` truth set for this conversation. */
  capabilities: ChannelFeature[];
  context: {
    windowOpen: boolean;
    windowExpiresAt?: number;
  };
}

/** A single WhatsApp template component — opaque pass-through for this example. */
type TemplateComponent = Record<string, unknown>;

/**
 * One rich action the chat endpoint can ask the agent to perform. Unsupported
 * actions for a channel are skipped by the agent rather than erroring.
 */
type ChatAction =
  | { type: 'message'; text: string }
  | { type: 'typing'; durationMs?: number }
  | { type: 'reaction'; emoji: string; targetMessageId: string }
  | { type: 'reply'; text: string; targetMessageId: string }
  | { type: 'media'; url: string; caption?: string; mimeType?: string; filename?: string }
  | { type: 'template'; name: string; language: string; components?: TemplateComponent[] }
  | { type: 'silence' };

/**
 * Raw response from the chat endpoint. All fields optional — supports the legacy
 * `message` / `messages` / `silence` forms AND the rich `actions[]` form.
 */
interface ChatResponse {
  message?: string;
  messages?: string[];
  silence?: boolean;
  actions?: ChatAction[];
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Configuration                                                              */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Default to Claude Sonnet 4.6 — fast and capable, a good fit for a chat
 * showcase. Override with SHOWCASE_MODEL. The model ids in the Claude 4.x family
 * are e.g. `claude-sonnet-4-6`, `claude-opus-4-7`, `claude-haiku-4-5-20251001`.
 */
const MODEL = process.env.SHOWCASE_MODEL ?? 'claude-sonnet-4-6';
const MAX_TOKENS = Number(process.env.MAX_TOKENS ?? 1024);

/**
 * The bot persona. Kept STABLE (no per-request interpolation) so it sits at the
 * front of the prompt prefix and the `cache_control` breakpoint on it stays
 * valid across turns — see `client.messages.create` below. Per-turn, volatile
 * context (channel, capabilities, contact) goes into the USER turn instead, so
 * it never invalidates the cached system prefix.
 */
const SYSTEM_PROMPT = [
  'You are Ava, a warm, concise customer-support assistant for a small business.',
  'You talk to customers over messaging apps — WhatsApp, Facebook Messenger, and Instagram DMs.',
  '',
  'Style:',
  '- Keep replies SHORT and conversational, the way people actually text. One or two sentences is usually right; never write an essay.',
  '- To send more than one chat bubble, separate them with a blank line (a double newline). Use this sparingly.',
  '- Be friendly and helpful. You do not have access to real order/account systems, so do not invent order numbers, prices, or policies — offer to help or ask a clarifying question instead.',
  '',
  'Rich actions (only when it genuinely improves the reply):',
  '- If a `react_to_message` tool is available, you MAY react to the user\'s most recent message with a single emoji to acknowledge it (e.g. a quick 👍 or ❤️). Do not overuse it.',
  '- If a `reply_to_message` tool is available, you MAY thread your text as a quoted reply to a specific message when it removes ambiguity (e.g. answering one of several questions).',
  '- These tools are offered ONLY when the current channel supports them; if a tool is not in your tool list, the channel cannot do it — just answer with plain text.',
  '- A reaction is an ACKNOWLEDGEMENT, not a substitute for answering. If the user asked something, still answer in text.'
].join('\n');

/* ────────────────────────────────────────────────────────────────────────── */
/* Anthropic client (fail fast on missing key)                                */
/* ────────────────────────────────────────────────────────────────────────── */

function buildClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. Export it (e.g. `export ANTHROPIC_API_KEY=sk-ant-...`) before starting the showcase bot.'
    );
  }
  return new Anthropic({ apiKey });
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Per-conversation history                                                   */
/*                                                                            */
/* In-memory, keyed by `conversationKey`. NOTE: this is per-process and        */
/* unbounded — it grows for the life of the process and is lost on restart.    */
/* Fine for a demo; a real deployment would use a store with TTL/eviction      */
/* (and likely server-side context compaction for very long chats).           */
/* ────────────────────────────────────────────────────────────────────────── */

const histories = new Map<string, Anthropic.MessageParam[]>();

function getHistory(conversationKey: string): Anthropic.MessageParam[] {
  let h = histories.get(conversationKey);
  if (!h) {
    h = [];
    histories.set(conversationKey, h);
  }
  return h;
}

/**
 * Render the inbound turn as the text of a user message. We lead with a compact,
 * per-turn context line (channel + capabilities + known first name) so the model
 * can tailor its reply and decide which tools make sense — then the actual user
 * text. Non-text inbound messages (images, reactions) have no body, so we
 * substitute a short placeholder like `[user sent an image]` so the turn is
 * never empty and the model knows something arrived.
 */
function renderInboundUserText(req: ChatRequest): string {
  const lines: string[] = [];

  const caps = req.capabilities.length > 0 ? req.capabilities.join(', ') : 'none';
  const who = req.contact?.firstName ? ` The customer's first name is ${req.contact.firstName}.` : '';
  lines.push(
    `[context] channel=${req.channel}; channel capabilities: ${caps}.${who} ` +
      'Only use a rich-action tool if it is in your tool list for this turn.'
  );

  // Describe each buffered inbound message. Prefer the per-message structured
  // array; fall back to the aggregated `message` string if it is empty.
  const described = req.messages.map((m) => describeInbound(m)).filter((s) => s.length > 0);
  if (described.length > 0) {
    lines.push('', ...described);
  } else {
    const agg = (req.message ?? '').trim();
    lines.push('', agg.length > 0 ? agg : '[the customer sent a message with no text content]');
  }

  return lines.join('\n');
}

/** One human-readable line for an inbound message, tagged with its id so the model can target reactions/replies. */
function describeInbound(m: IncomingMessage): string {
  const text = (m.text ?? '').trim();
  if (text.length > 0) {
    return `(message id: ${m.channelMessageId}) ${text}`;
  }
  // Non-text inbound types — give the model a placeholder rather than nothing.
  switch (m.type) {
    case 'reaction': {
      const emoji = m.reaction?.emoji?.trim();
      return `(message id: ${m.channelMessageId}) [the customer reacted with ${emoji && emoji.length > 0 ? emoji : 'an emoji'}]`;
    }
    case 'image':
    case 'video':
    case 'audio':
    case 'document':
    case 'sticker':
      return `(message id: ${m.channelMessageId}) [the customer sent ${article(m.type)} ${m.type}]`;
    default:
      return `(message id: ${m.channelMessageId}) [the customer sent a ${m.type} message]`;
  }
}

function article(noun: string): 'an' | 'a' {
  return /^[aeiou]/i.test(noun) ? 'an' : 'a';
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Tools — gated on channel capabilities                                      */
/*                                                                            */
/* We expose at most two small tools, ONLY when the channel supports them:    */
/*   - react_to_message  → a `reaction` ChatAction  (needs `reaction`)        */
/*   - reply_to_message  → a `reply` ChatAction      (needs `reply_to`)        */
/* The point is to SHOW the pattern (model tool_use → rich ChatAction), not be */
/* exhaustive. Gating keeps us from offering, say, a reaction tool on a        */
/* channel that cannot react.                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

const REACT_TOOL_NAME = 'react_to_message';
const REPLY_TOOL_NAME = 'reply_to_message';

function buildTools(capabilities: ChannelFeature[]): Anthropic.Tool[] {
  const tools: Anthropic.Tool[] = [];

  if (capabilities.includes('reaction')) {
    tools.push({
      name: REACT_TOOL_NAME,
      description:
        'React to one of the customer\'s messages with a single emoji, as a lightweight acknowledgement. ' +
        'Use the message id from the [context]/message lines. This does NOT send text — if the customer asked ' +
        'something, you must still answer in your normal text reply.',
      input_schema: {
        type: 'object',
        properties: {
          emoji: { type: 'string', description: 'A single emoji to react with, e.g. 👍 or ❤️.' },
          targetMessageId: {
            type: 'string',
            description: 'The id of the message to react to (the "message id" shown for that message).'
          }
        },
        required: ['emoji', 'targetMessageId']
      }
    });
  }

  if (capabilities.includes('reply_to')) {
    tools.push({
      name: REPLY_TOOL_NAME,
      description:
        'Send your text as a quoted reply threaded to a specific message, instead of a plain message. ' +
        'Use this when threading removes ambiguity — e.g. when answering one of several questions the customer asked.',
      input_schema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The reply text to send.' },
          targetMessageId: {
            type: 'string',
            description: 'The id of the message to reply to (the "message id" shown for that message).'
          }
        },
        required: ['text', 'targetMessageId']
      }
    });
  }

  return tools;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Mapping Claude's response → ChatResponse                                    */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Translate a single Claude `tool_use` block into the corresponding ChatAction.
 *
 * DESIGN CHOICE — we translate the tool call DIRECTLY into an action and do NOT
 * run a second round-trip to "return a tool result and continue". These tools
 * have no data to feed back to the model (they are pure output side-effects:
 * "emit this reaction" / "send this threaded reply"), so a second model call
 * would add latency and cost for nothing. The transport package performs the
 * actual reaction/reply send when it processes the returned `actions[]`. Returns
 * `null` for an unknown tool or malformed input (we simply skip it).
 */
function toolUseToAction(block: Anthropic.ToolUseBlock): ChatAction | null {
  const input = (block.input ?? {}) as Record<string, unknown>;

  if (block.name === REACT_TOOL_NAME) {
    const emoji = typeof input.emoji === 'string' ? input.emoji : '';
    const targetMessageId = typeof input.targetMessageId === 'string' ? input.targetMessageId : '';
    if (emoji.length === 0 || targetMessageId.length === 0) return null;
    return { type: 'reaction', emoji, targetMessageId };
  }

  if (block.name === REPLY_TOOL_NAME) {
    const text = typeof input.text === 'string' ? input.text : '';
    const targetMessageId = typeof input.targetMessageId === 'string' ? input.targetMessageId : '';
    if (text.trim().length === 0 || targetMessageId.length === 0) return null;
    return { type: 'reply', text, targetMessageId };
  }

  return null;
}

/**
 * Collapse the assistant message's content blocks into a ChatResponse.
 *
 *  - `text` blocks are concatenated; if the joined text contains a blank-line
 *    separator we split it into multi-bubble `messages[]`, otherwise a single
 *    `message`. Text always rides as the FIRST action(s) when actions exist, so
 *    a reaction never replaces the answer.
 *  - each `tool_use` block becomes a rich ChatAction (reaction / reply).
 *
 * If a `reply` action carries the whole answer (the model chose to thread its
 * text), we don't ALSO emit that same text as a plain message — the reply action
 * is the text delivery. Otherwise plain text leads, then the actions follow.
 */
function buildResponse(message: Anthropic.Message): ChatResponse {
  const textParts: string[] = [];
  const actions: ChatAction[] = [];

  for (const block of message.content) {
    if (block.type === 'text') {
      if (block.text.trim().length > 0) textParts.push(block.text);
    } else if (block.type === 'tool_use') {
      const action = toolUseToAction(block);
      if (action) actions.push(action);
    }
  }

  const joined = textParts.join('').trim();
  const bubbles = joined.length > 0 ? splitBubbles(joined) : [];
  const hasReplyAction = actions.some((a) => a.type === 'reply');

  // No rich actions at all → the simple legacy path.
  if (actions.length === 0) {
    if (bubbles.length === 0) {
      // Model produced no text and no actions — say nothing rather than a blank.
      return { silence: true };
    }
    return bubbles.length === 1 ? { message: bubbles[0] } : { messages: bubbles };
  }

  // Rich path: text bubble(s) first (unless the text was delivered AS a reply
  // action), then the actions, in order. The agent's normalizer treats a
  // non-empty `actions[]` as authoritative.
  const ordered: ChatAction[] = [];
  if (!hasReplyAction) {
    for (const text of bubbles) ordered.push({ type: 'message', text });
  }
  ordered.push(...actions);
  return { actions: ordered };
}

/** Split assistant text into separate chat bubbles on blank lines (double newline). */
function splitBubbles(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/* ────────────────────────────────────────────────────────────────────────── */
/* The chat handler                                                           */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Handle one inbound turn: append it to history, call Claude (with the cached
 * system prompt + capability-gated tools), append the assistant turn, and return
 * the mapped ChatResponse.
 *
 * FAIL-SOFT: any Anthropic/SDK failure returns a friendly `{ message }` (HTTP
 * 200), never an exception out of here — the agent treats a non-2xx as a chat
 * error and ends the turn silently, so a 200 with a friendly line is strictly
 * better UX. Exported so it can be unit-tested / driven in-process.
 */
export async function handleChat(client: Anthropic, req: ChatRequest): Promise<ChatResponse> {
  const history = getHistory(req.conversationKey);

  // Append the inbound turn as a user message.
  history.push({ role: 'user', content: renderInboundUserText(req) });

  try {
    const message = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      // Prompt caching: mark the (stable) system block ephemeral so it is cached
      // and re-read on subsequent turns. The system prompt renders before the
      // messages, so this caches the persona once per ~5-minute window. (Note:
      // a short system prompt may fall under the model's minimum cacheable
      // prefix, in which case the API simply won't cache it — the marker is
      // still correct and free.)
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' }
        }
      ],
      tools: buildTools(req.capabilities),
      messages: history
    });

    // Persist the assistant turn (full content, so tool_use blocks are preserved
    // for multi-turn coherence) before mapping it to the response shape.
    history.push({ role: 'assistant', content: message.content });

    return buildResponse(message);
  } catch (err) {
    // Roll back the user turn we optimistically appended so a transient failure
    // doesn't leave a dangling user message that desyncs the next turn.
    history.pop();

    if (err instanceof Anthropic.APIError) {
      console.error(`[showcase-bot] Anthropic API error (status ${err.status}):`, err.message);
    } else {
      console.error('[showcase-bot] chat handler failed:', err);
    }
    // Friendly, in-band failure — returned as HTTP 200 by the route.
    return { message: "Sorry, I'm having trouble right now. Please try again in a moment." };
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Express app                                                                */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Build the Express app:
 *   - POST /        — the chat endpoint: reads a {@link ChatRequest}, returns a {@link ChatResponse}.
 *   - GET  /health  — liveness, always 200.
 *
 * Returns the app WITHOUT calling `listen` (the standalone-run guard below is
 * the only place that starts a listener), so it can be embedded/tested.
 */
export function createShowcaseApp(client: Anthropic): express.Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.post('/', async (req: Request, res: Response): Promise<void> => {
    const body = req.body as ChatRequest;
    // handleChat is fail-soft and never throws, so the chat endpoint always 200s.
    const response = await handleChat(client, body);
    res.json(response);
  });

  app.get('/health', (_req: Request, res: Response): void => {
    res.sendStatus(200);
  });

  return app;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Standalone-run guard                                                       */
/*                                                                            */
/* Start a listener ONLY when this file is the process entry point, so the     */
/* exports above can be imported (for tests / embedding) without booting a     */
/* server. Same convention as the other examples and `src/index.ts`.          */
/* ────────────────────────────────────────────────────────────────────────── */

const invokedAsScript = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    const thisFile = new URL(import.meta.url).pathname;
    return path.resolve(entry) === path.resolve(thisFile);
  } catch {
    return false;
  }
})();

if (invokedAsScript) {
  // buildClient throws (fail-fast) if ANTHROPIC_API_KEY is unset — surface a
  // clean message and exit non-zero rather than crashing with a stack trace.
  let client: Anthropic;
  try {
    client = buildClient();
  } catch (err) {
    console.error(`[showcase-bot] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const app = createShowcaseApp(client);
  const port = process.env.PORT ?? 4003;
  app.listen(port, () => {
    process.stdout.write(
      `meta-ai-agent showcase bot listening at http://localhost:${port}/ (model: ${MODEL})\n`
    );
  });
}
