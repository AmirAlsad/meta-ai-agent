/**
 * EXAMPLE: a channel-aware developer-provided chat endpoint.
 *
 * This is YOUR side of the `CHAT_ENDPOINT_URL` contract — the HTTP server the
 * meta-ai-agent POSTs each buffered inbound turn to. The agent sends a
 * {@link ChatRequest}; you return a {@link ChatResponse}. See
 * `docs/features/rich-chat-actions.md` for the full contract.
 *
 * A real consumer installs the package and imports the contract types from
 * `meta-ai-agent` (e.g. `import type { ChatRequest } from 'meta-ai-agent'`).
 * Because this example lives inside the repo, it imports them by relative path
 * instead.
 *
 * Where the minimal example just echoes, this one demonstrates the two things
 * that make the contract useful:
 *  - **channel-aware** responses (`req.channel`), and
 *  - **capability-driven** behavior — tailoring `actions[]` to what the channel
 *    can actually do via `req.capabilities` (the adapter's `supports()` truth
 *    set). A WhatsApp turn includes `'template'`; Messenger / Instagram do not.
 *
 * Two exports:
 *  - {@link routerResponse} — the pure handler (unit-tested + imported by the
 *    REPL).
 *  - {@link createRouterChatEndpoint} — builds the Express app exposing it.
 *
 * This is reference / teaching code, so it favors clarity over cleverness: each
 * branch is spelled out with a comment explaining the part of the contract it
 * exercises.
 */
import path from 'node:path';
import express, { type Request, type Response } from 'express';
import type { ChatRequest, ChatResponse } from '../../src/chat/types.js';
import type { Channel } from '../../src/meta/types.js';

/* ────────────────────────────────────────────────────────────────────────── */
/* Pure handler                                                                */
/* ────────────────────────────────────────────────────────────────────────── */

/** Looks-like-a-greeting matcher (case-insensitive): "hi", "hello", "hey", "start". */
const GREETING_RE = /^(hi|hello|hey|start)\b/i;

/** Per-channel greeting copy, so the bot introduces itself in the right voice. */
const GREETINGS: Record<Channel, string> = {
  whatsapp: 'Welcome to our WhatsApp line! How can we help?',
  messenger: 'Hi from our Facebook Page! What can we do for you?',
  instagram: 'Hey there on Instagram! How can we help?'
};

/**
 * Map an inbound {@link ChatRequest} to a {@link ChatResponse}, demonstrating
 * channel-aware + capability-driven routing. Branches are checked top to bottom;
 * the first match wins.
 */
export function routerResponse(req: ChatRequest): ChatResponse {
  const text = (req.message ?? '').trim();

  // The reaction / template actions below target the LAST message of the
  // buffered turn — the message the user most recently sent — so they read
  // naturally on the device.
  const lastMessage = req.messages.at(-1);
  const lastMid = lastMessage?.channelMessageId ?? '';

  // ── Branch 1: reaction demo ──────────────────────────────────────────────
  // If the latest inbound is itself a reaction AND this channel supports sending
  // reactions, react back. We check `capabilities` so we never emit an action
  // the channel would just skip. The reaction's own target (the message the user
  // reacted to) is preferred; otherwise fall back to the last message id.
  if (lastMessage?.type === 'reaction' && req.capabilities.includes('reaction')) {
    const targetMessageId = lastMessage.reaction?.targetMessageId ?? lastMid;
    return { actions: [{ type: 'reaction', emoji: '👍', targetMessageId }] };
  }

  // ── Branch 2: channel-specific greeting ──────────────────────────────────
  // When the inbound text looks like a greeting, respond with copy tailored to
  // the channel it arrived on.
  if (GREETING_RE.test(text)) {
    return { message: GREETINGS[req.channel] };
  }

  // ── Branch 3: capability-driven template ─────────────────────────────────
  // A template is the right tool when we need to (re)open a conversation outside
  // the 24h customer-service window, OR when the user explicitly asks for one.
  // But templates are WhatsApp-only — so we gate on the capability set. This is
  // the key teaching point: we ALWAYS check `req.capabilities.includes(...)`
  // before returning a channel-specific action, and fall back to plain text when
  // the channel can't do it.
  const wantsTemplate = /template/i.test(text) || req.context.windowOpen === false;
  if (wantsTemplate) {
    if (req.capabilities.includes('template')) {
      // WhatsApp: send the approved `hello_world` template.
      return { actions: [{ type: 'template', name: 'hello_world', language: 'en_US' }] };
    }
    // Messenger / Instagram: no templates — degrade gracefully to plain text.
    return { message: 'Thanks for reaching out! A team member will be with you shortly.' };
  }

  // ── Branch 4: default echo, tagged with the channel ──────────────────────
  // Nothing special matched — echo the text back, prefixed with the channel so
  // it's obvious which line the turn came in on.
  return { message: `[${req.channel}] You said: ${req.message}` };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Express app                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Build an Express app exposing the chat endpoint.
 *
 *  - `POST /`        — the chat endpoint: reads the {@link ChatRequest} body and
 *    responds with {@link routerResponse}.
 *  - `GET /health`   — a trivial liveness check.
 *
 * Returns the app WITHOUT calling `listen`, so the REPL can boot it in-process.
 * The standalone-run guard at the bottom of this file is the only place that
 * starts a listener.
 */
export function createRouterChatEndpoint(): express.Express {
  const app = express();
  app.use(express.json());

  app.post('/', (req: Request, res: Response): void => {
    const body = req.body as ChatRequest;
    res.json(routerResponse(body));
  });

  app.get('/health', (_req: Request, res: Response): void => {
    res.sendStatus(200);
  });

  return app;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Standalone-run guard                                                        */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Run a listener ONLY when this file is the process entry point. WHY the guard:
 * the REPL imports {@link createRouterChatEndpoint} from this module to boot the
 * endpoint in-process; without this check that import would also start a second
 * standalone listener. Resolve both `argv[1]` and `import.meta.url` to absolute
 * paths so the match holds regardless of relative-path quirks — same convention
 * as `src/index.ts`. Uses a different default port from the minimal example so
 * both can run side by side.
 */
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
  const app = createRouterChatEndpoint();
  const port = process.env.PORT ?? 4002;
  app.listen(port, () => {
    process.stdout.write(`multi-channel router chat endpoint listening at http://localhost:${port}/\n`);
  });
}
