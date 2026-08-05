/**
 * EXAMPLE: a comment-aware developer endpoint.
 *
 * With `COMMENTS_ENABLED=true`, the transport POSTs every fresh inbound
 * comment to `COMMENT_ENDPOINT_URL` (default: your `CHAT_ENDPOINT_URL`) as a
 * {@link CommentChatRequest} — distinguishable from a DM turn by
 * `kind: 'comment'`. This example shows one server handling BOTH surfaces,
 * and demonstrates the posture that matters on public comments:
 * **selective engagement**. Full-coverage identical replying is the exact
 * signature platform spam systems key on, so the default answer here is
 * silence, engagement is varied, and only substantive comments get words.
 *
 * See `docs/features/comments.md` for the contract and
 * `examples/multi-channel-router` for the DM side this composes with.
 */
import path from 'node:path';
import express, { type Request, type Response } from 'express';
import type { ChatRequest, ChatResponse } from '../../src/chat/types.js';
import type {
  CommentChatRequest,
  CommentChatResponse
} from '../../src/meta/comments/types.js';

/* ────────────────────────────────────────────────────────────────────────── */
/* Pure handler                                                                */
/* ────────────────────────────────────────────────────────────────────────── */

/** Emoji-only / one-word / pure-tag comments: acknowledge at most, never reply. */
const LOW_SIGNAL_RE = /^(\s|[\p{Emoji}\p{Emoji_Presentation}️]|@\w+)*$|^\s*\S+\s*$/u;

/** A question mark (or question-shaped opener) marks a comment worth words. */
const QUESTION_RE = /\?|^(how|what|why|when|where|does|can|is|are)\b/i;

/**
 * Decide what to do with one comment. Deliberately boring logic — the point
 * is the SHAPE of the decision, not its sophistication:
 *  - low-signal comments (emoji, one word, tags): like when the channel can
 *    (Facebook), otherwise silence. Engagement without words.
 *  - questions: a public reply (your real endpoint would generate one).
 *  - everything else: silence by default. Selective > exhaustive.
 */
export function commentResponse(req: CommentChatRequest): CommentChatResponse {
  const text = (req.comment.text ?? '').trim();

  if (text === '' || LOW_SIGNAL_RE.test(text)) {
    // 'like' is only offered where it exists (Facebook) — the capabilities
    // list is the adapter's truth set, never assume beyond it.
    if (req.capabilities.includes('like')) {
      return { actions: [{ type: 'like' }] };
    }
    return { silence: true };
  }

  if (QUESTION_RE.test(text)) {
    // Vary the wording in a real implementation — static fallback strings on
    // a public surface read as automation to both people and platforms.
    return {
      actions: [
        {
          type: 'reply',
          text: `Good question — short answer coming up. (account: ${req.accountName}, channel: ${req.channel})`
        }
      ]
    };
  }

  return { silence: true };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Express wiring: one endpoint, both surfaces                                 */
/* ────────────────────────────────────────────────────────────────────────── */

/** True when a request body is a comment dispatch rather than a DM turn. */
function isCommentRequest(body: unknown): body is CommentChatRequest {
  return (
    typeof body === 'object' &&
    body !== null &&
    (body as { kind?: unknown }).kind === 'comment'
  );
}

export function createCommentEndpoint(): express.Express {
  const app = express();
  app.use(express.json({ limit: '5mb' }));

  app.post('/chat', (req: Request, res: Response) => {
    if (isCommentRequest(req.body)) {
      res.json(commentResponse(req.body));
      return;
    }
    // The DM side of the shared endpoint — a stand-in echo; compose with the
    // multi-channel-router example for the real thing.
    const dm = req.body as ChatRequest;
    const response: ChatResponse = { message: `Echo (${dm.accountName ?? 'default'}): ${dm.message}` };
    res.json(response);
  });

  return app;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* CLI entry point                                                             */
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
  const port = Number.parseInt(process.env.PORT ?? '8081', 10);
  createCommentEndpoint().listen(port, () => {
    process.stdout.write(`comment-endpoint example listening on :${port} (POST /chat)\n`);
  });
}
