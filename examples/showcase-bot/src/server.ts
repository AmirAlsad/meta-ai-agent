/**
 * The HTTP surface — the DEVELOPER'S side of the meta-ai-agent
 * `CHAT_ENDPOINT_URL` contract.
 *
 *   POST /        — reads a ChatRequest, returns a ChatResponse.
 *   GET  /health  — liveness (always 200).
 *
 * FAIL-SOFT: any error becomes HTTP 200 with a friendly `{ message }`. The
 * transport treats a non-2xx as a chat error and ends the turn silently, so a
 * 200 with a friendly line is strictly better UX. The route never throws out.
 */
import 'dotenv/config';
import express, { type Request, type Response } from 'express';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadConfig, type BotConfig } from './config.js';
import type { ChatRequest, ChatResponse } from './contract.js';
import { runTurn } from './llm.js';
import { log } from './logger.js';

const FRIENDLY_FAILURE = "Sorry, I'm having trouble right now. Please try again in a moment.";

/** Build the Express app WITHOUT calling listen (so it can be embedded/tested). */
export function createShowcaseApp(config: BotConfig): express.Express {
  const app = express();
  // Body limit must comfortably exceed the transport's INBOUND_MEDIA_DOWNLOAD
  // payload. The transport caps each inbound media at INBOUND_MEDIA_MAX_BYTES
  // (default 5 MiB RAW), then base64-inlines it as a `data:` URL — base64 adds
  // ~33% (5 MiB → ~7 MB) — and a single buffered turn can carry SEVERAL media.
  // A 5mb limit therefore 413s on a single near-cap video; 25mb leaves room for
  // a few hydrated media plus the rest of the ChatRequest JSON. Any chat
  // endpoint that enables inbound media download must size its parser similarly.
  app.use(express.json({ limit: '25mb' }));

  app.get('/health', (_req: Request, res: Response): void => {
    res.json({ ok: true, service: 'showcase-bot', model: config.model });
  });

  app.post('/', async (req: Request, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as ChatRequest;
    const conversationKey = body.conversationKey || `fallback:${body.channel ?? 'unknown'}`;

    const messages = Array.isArray(body.messages) ? body.messages : [];
    const hasContent = messages.length > 0 || (body.message ?? '').trim().length > 0;
    if (!hasContent) {
      log('warn', 'no inbound message content — silent', { conversationKey });
      res.json({ silence: true } satisfies ChatResponse);
      return;
    }

    log('info', 'turn starting', {
      conversationKey,
      channel: body.channel,
      inboundCount: messages.length,
      hasMedia: messages.some(m => m.media),
      windowOpen: body.context?.windowOpen,
      capabilities: body.capabilities
    });

    try {
      const result = await runTurn(config, body);

      log('info', 'turn complete', {
        conversationKey,
        latencyMs: result.latencyMs,
        actionTypes: result.actions.map(a => a.type),
        silent: result.silent,
        usage: result.usage
      });

      // Silence wins ONLY when there are genuinely no other actions. WHY this is
      // an `&&` (silent AND empty), not an `||`: if the model calls `stay_silent`
      // AND a content tool (e.g. `react_to_message`) in the SAME step, the tools'
      // `execute`s run in an arbitrary order. `stay_silent` sets `silent = true`
      // and clears `actions`, but a sibling tool running afterward re-pushes onto
      // the cleared array — leaving `silent === true` WITH a surviving action. An
      // `|| silent` here would short-circuit and drop that action. By gating on
      // `actions.length === 0` we honor silence only when nothing else survived,
      // independent of `execute` ordering. (When the model is truly silent,
      // `stay_silent` leaves `actions` empty, so this still returns silence.)
      if (result.actions.length === 0) {
        res.json({ silence: true } satisfies ChatResponse);
        return;
      }
      res.json({ actions: result.actions } satisfies ChatResponse);
    } catch (err) {
      // Fail-soft: log it, but answer 200 with a friendly line rather than a
      // non-2xx (which the transport would treat as a chat error and drop).
      const message = err instanceof Error ? err.message : String(err);
      log('error', `LLM turn failed: ${message}`, { conversationKey });
      res.json({ message: FRIENDLY_FAILURE } satisfies ChatResponse);
    }
  });

  return app;
}

/* ── Standalone-run guard: start a listener ONLY when this file is the entry ── */
const invokedAsScript = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    return resolve(entry) === resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedAsScript) {
  // loadConfig fails fast if the selected provider's key is missing — surface a
  // clean message and exit non-zero rather than crashing with a stack trace.
  let config: BotConfig;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`[showcase-bot] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const app = createShowcaseApp(config);
  app.listen(config.port, () => {
    log('info', `showcase-bot listening on http://localhost:${config.port}/`, { model: config.model });
    log('info', `point the transport at it: CHAT_ENDPOINT_URL=http://localhost:${config.port}`);
  });
}
