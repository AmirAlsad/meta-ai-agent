/**
 * EXAMPLE: the smallest possible developer-provided chat endpoint.
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
 * This bot just echoes the inbound text back. Two exports:
 *  - {@link echoResponse} — the pure handler (unit-tested + imported in-process
 *    by the REPL).
 *  - {@link createEchoChatEndpoint} — builds the Express app exposing it (also
 *    imported by the REPL so it can boot the endpoint in-process).
 */
import path from 'node:path';
import express, { type Request, type Response } from 'express';
import type { ChatRequest, ChatResponse } from '../../src/chat/types.js';

/* ────────────────────────────────────────────────────────────────────────── */
/* Pure handler                                                                */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Echo the aggregated inbound text back to the sender.
 *
 * `req.message` is the backward-compat aggregated text (the buffered message
 * bodies newline-joined). When it's empty there is genuinely nothing to echo —
 * e.g. a reaction-only or media-only turn, where the inbound carried no text —
 * so we return an explicit `{ silence: true }` rather than echoing an empty
 * string (which would send a blank message).
 *
 * Exported for tests and for the REPL to call directly.
 */
export function echoResponse(req: ChatRequest): ChatResponse {
  const text = (req.message ?? '').trim();
  // Nothing to echo (reaction-only / media-only turn) → stay silent.
  if (text.length === 0) {
    return { silence: true };
  }
  return { message: req.message };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Express app                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Build an Express app exposing the chat endpoint.
 *
 *  - `POST /`        — the chat endpoint: reads the {@link ChatRequest} body and
 *    responds with {@link echoResponse}.
 *  - `GET /health`   — a trivial liveness check.
 *
 * Returns the app WITHOUT calling `listen`, so the REPL can boot it in-process
 * (e.g. mount it on its own server). The standalone-run guard at the bottom of
 * this file is the only place that starts a listener.
 */
export function createEchoChatEndpoint(): express.Express {
  const app = express();
  app.use(express.json());

  app.post('/', (req: Request, res: Response): void => {
    const body = req.body as ChatRequest;
    res.json(echoResponse(body));
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
 * the REPL imports {@link createEchoChatEndpoint} from this module to boot the
 * endpoint in-process; without this check that import would also start a second
 * standalone listener. Resolve both `argv[1]` and `import.meta.url` to absolute
 * paths so the match holds regardless of relative-path quirks — same convention
 * as `src/index.ts`.
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
  const app = createEchoChatEndpoint();
  const port = process.env.PORT ?? 4001;
  app.listen(port, () => {
    process.stdout.write(`minimal echo chat endpoint listening at http://localhost:${port}/\n`);
  });
}
