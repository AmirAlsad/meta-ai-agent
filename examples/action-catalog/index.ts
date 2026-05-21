/**
 * EXAMPLE: an "every response shape" catalog chat endpoint.
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
 * Where the minimal example just echoes and the router branches on channel, THIS
 * example is a keyword-routed reference for EVERY {@link ChatAction} shape. Send
 * a keyword as the first word of your message and the endpoint returns the
 * matching action — so you can see, in one place, the exact JSON the transport
 * expects for each capability. There is NO LLM here: it is a pure `switch` over
 * the inbound keyword. Each branch ALWAYS gates on `req.capabilities` (the
 * adapter's `supports()` truth set) and degrades to a plain message when the
 * channel can't do the rich thing — the central teaching point of the contract.
 *
 * Two exports:
 *  - {@link catalogResponse} — the pure handler (unit-tested + imported by the
 *    REPL).
 *  - {@link createCatalogChatEndpoint} — builds the Express app exposing it.
 *
 * This is reference / teaching code, so it favors clarity over cleverness: each
 * branch is spelled out with a comment naming the action it demonstrates plus
 * the capability it checks.
 */
import path from 'node:path';
import express, { type Request, type Response } from 'express';
import type { ChatRequest, ChatResponse } from '../../src/chat/types.js';

/* ────────────────────────────────────────────────────────────────────────── */
/* Pure handler                                                                */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Placeholder target id for `reaction` / `reply` actions when the inbound turn
 * carried no message id (e.g. a synthetic REPL turn). A real channel always
 * supplies a `channelMessageId`; this just keeps the example from emitting an
 * action with an empty target.
 */
const FALLBACK_TARGET_ID = 'unknown-message-id';

/** The keywords this catalog understands, surfaced by the `help` branch. */
const KEYWORDS = ['silence', 'multi', 'react', 'reply', 'media', 'template', 'typing', 'help'] as const;

/**
 * Route an inbound {@link ChatRequest} to a {@link ChatResponse} demonstrating
 * one {@link ChatAction} shape, chosen by the FIRST WORD of the inbound text
 * (case-insensitive). Every rich branch checks `req.capabilities` first and
 * falls back to a plain `message` when the channel lacks the capability.
 *
 * Exported for tests and for the REPL to call directly.
 */
export function catalogResponse(req: ChatRequest): ChatResponse {
  const text = (req.message ?? '').trim();
  // The keyword is the first whitespace-delimited token, lower-cased so "REACT"
  // and "react" both match.
  const keyword = text.split(/\s+/)[0]?.toLowerCase() ?? '';

  // Rich actions that reference a prior message (`reaction`, `reply`) target the
  // LAST message of the buffered turn — the one the user most recently sent — so
  // they read naturally on the device. Fall back to a placeholder when absent.
  const lastMessageId = req.messages.at(-1)?.channelMessageId ?? FALLBACK_TARGET_ID;

  switch (keyword) {
    // ── silence ──────────────────────────────────────────────────────────────
    // The canonical "send nothing" turn. The agent acknowledges the inbound but
    // produces no outbound. This is the explicit, contract-blessed form (a lone
    // `{ silence: true }` with no competing content).
    case 'silence':
      return { silence: true };

    // ── multi ────────────────────────────────────────────────────────────────
    // The legacy `messages[]` form: an ordered array of plain-text bubbles. The
    // delivery layer sends them in order. (Equivalent to two `message` actions —
    // shown here as the simpler legacy shape on purpose.)
    case 'multi':
      return { messages: ['First bubble.', 'Second bubble.'] };

    // ── react ────────────────────────────────────────────────────────────────
    // A `reaction` action drops an emoji on a prior message. Reactions are
    // supported on WhatsApp / Messenger / Instagram but NOT every channel/turn,
    // so we gate on `capabilities.includes('reaction')`. Here we also pair the
    // reaction with a confirming `message` to show actions composing in order.
    case 'react':
      if (req.capabilities.includes('reaction')) {
        return {
          actions: [
            { type: 'reaction', emoji: '👍', targetMessageId: lastMessageId },
            { type: 'message', text: 'Reacted 👍' }
          ]
        };
      }
      // Degrade gracefully: no reaction support → just say so in plain text.
      return { message: 'Reactions are not supported on this channel.' };

    // ── reply ────────────────────────────────────────────────────────────────
    // A `reply` action threads `text` onto `targetMessageId`. Threading needs
    // the `reply_to` capability. NOTE: even without it the transport DOWNGRADES
    // a reply to a plain message (text still delivered, threading lost) — but to
    // make the degrade explicit in this teaching example we return a plain
    // `message` ourselves when `reply_to` is absent.
    case 'reply':
      if (req.capabilities.includes('reply_to')) {
        return { actions: [{ type: 'reply', text: 'Threaded reply.', targetMessageId: lastMessageId }] };
      }
      return {
        message: 'Threaded reply (sent as a normal message — this channel has no reply_to).'
      };

    // ── media ────────────────────────────────────────────────────────────────
    // A `media` action sends an attachment by public URL; the channel fetches
    // it at send time. `mimeType` lets the agent infer the send-kind (image /
    // video / document). Gate on `media_send` (all three channels support it,
    // but the gate is the pattern to copy).
    case 'media':
      if (req.capabilities.includes('media_send')) {
        return {
          actions: [
            { type: 'media', url: 'https://example.com/sample.jpg', caption: 'A sample image', mimeType: 'image/jpeg' }
          ]
        };
      }
      return { message: 'Media sending is not supported on this channel.' };

    // ── template ───────────────────────────────────────────────────────────
    // A `template` action sends an approved WhatsApp template — the only way to
    // (re)open a conversation outside the 24h window. Templates are WhatsApp-ONLY,
    // so `capabilities.includes('template')` is true for WhatsApp turns only.
    case 'template':
      if (req.capabilities.includes('template')) {
        return { actions: [{ type: 'template', name: 'hello_world', language: 'en_US' }] };
      }
      return { message: 'Templates are WhatsApp-only; here is a normal message instead.' };

    // ── typing ───────────────────────────────────────────────────────────────
    // A `typing` action shows a typing indicator for `durationMs`, then the
    // paired `message` lands. Gate on `typing_indicator`. When unsupported we
    // skip the indicator and just send the message.
    case 'typing':
      if (req.capabilities.includes('typing_indicator')) {
        return {
          actions: [
            { type: 'typing', durationMs: 2000 },
            { type: 'message', text: 'Done typing!' }
          ]
        };
      }
      return { message: 'Done typing!' };

    // ── help / default ─────────────────────────────────────────────────────
    // Anything unrecognized (including the literal `help`) lists the keywords.
    // This is also the "nothing matched" fallback so the user always gets a hint.
    default:
      return {
        message: `Send a keyword to see the matching action. Try: ${KEYWORDS.join(', ')}.`
      };
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Express app                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Build an Express app exposing the chat endpoint.
 *
 *  - `POST /`        — the chat endpoint: reads the {@link ChatRequest} body and
 *    responds with {@link catalogResponse}.
 *  - `GET /health`   — a trivial liveness check.
 *
 * Returns the app WITHOUT calling `listen`, so the REPL can boot it in-process.
 * The standalone-run guard at the bottom of this file is the only place that
 * starts a listener.
 */
export function createCatalogChatEndpoint(): express.Express {
  const app = express();
  app.use(express.json());

  app.post('/', (req: Request, res: Response): void => {
    const body = req.body as ChatRequest;
    res.json(catalogResponse(body));
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
 * the REPL imports {@link createCatalogChatEndpoint} from this module to boot the
 * endpoint in-process; without this check that import would also start a second
 * standalone listener. Resolve both `argv[1]` and `import.meta.url` to absolute
 * paths so the match holds regardless of relative-path quirks — same convention
 * as `src/index.ts`. Uses a distinct default port so it can run alongside the
 * other examples.
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
  const app = createCatalogChatEndpoint();
  const port = process.env.PORT ?? 4003;
  app.listen(port, () => {
    process.stdout.write(`action-catalog chat endpoint listening at http://localhost:${port}/\n`);
  });
}
