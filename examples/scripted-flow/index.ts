/**
 * EXAMPLE: a deterministic, in-memory conversational flow (no LLM).
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
 * This example walks a small, realistic arc — a coffee pickup order — through a
 * hand-written state machine keyed by `req.conversationKey`. There is NO LLM:
 * each step inspects the current state, advances it, and returns the next
 * prompt. Along the way it exercises the rich action types NATURALLY (not as a
 * keyword catalog — see `examples/action-catalog` for that):
 *  - a `reaction` ack on an early step (capability-gated),
 *  - a `reply` for disambiguation (capability-gated),
 *  - a capability-gated `template` re-engagement when the 24h window is closed,
 *  - `silence` on a duplicate inbound message id (dedupe demo).
 * Saying "restart" at any point resets the flow.
 *
 * Three exports:
 *  - {@link scriptedFlowResponse} — the pure-ish handler. It accepts an
 *    injectable {@link FlowStore} (default: a module-level in-memory store) so
 *    tests can hand it a fresh store per case.
 *  - {@link createScriptedFlowChatEndpoint} — builds the Express app exposing it.
 *  - {@link FlowStore} — the small state-store interface (+ in-memory default).
 *
 * Reference / teaching code: each transition is commented with the step it moves
 * to and the action(s) it emits.
 */
import path from 'node:path';
import express, { type Request, type Response } from 'express';
import type { ChatRequest, ChatResponse } from '../../src/chat/types.js';

/* ────────────────────────────────────────────────────────────────────────── */
/* State + store                                                               */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * The ordered steps of the coffee-order arc. `greet` is the implicit starting
 * point for a conversation we have never seen.
 *
 *   greet → size → milk → name → done
 */
export type FlowStep = 'greet' | 'size' | 'milk' | 'name' | 'done';

/** Per-conversation flow state. Accumulates the user's answers as it advances. */
export interface FlowState {
  /** The step we are WAITING on input for (i.e. the next thing to collect). */
  step: FlowStep;
  /** Chosen drink size, captured at the `size` step. */
  size?: string;
  /** Chosen milk, captured at the `milk` step. */
  milk?: string;
  /** Name for the order, captured at the `name` step. */
  name?: string;
  /**
   * Inbound `channelMessageId`s we have already processed for this conversation.
   * Used to `silence` exact duplicates (dedupe demo). A real bot would bound
   * this; we keep all ids for simplicity in a teaching example.
   */
  seenMessageIds: string[];
}

/**
 * Minimal state store the handler reads/writes. Exposed so tests can inject a
 * FRESH store per case (the module default persists for the process lifetime,
 * which is what you want for a real standalone run but not across tests).
 */
export interface FlowStore {
  /** Current state for a conversation, or undefined if we have never seen it. */
  get(key: string): FlowState | undefined;
  /** Persist the (mutated) state for a conversation. */
  set(key: string, state: FlowState): void;
  /**
   * Has `msgId` already been processed for `key`? Records it as seen as a side
   * effect when it is new, and returns `false` for that first sighting. A blank
   * id is never treated as a duplicate (synthetic turns may omit it).
   */
  seen(key: string, msgId: string): boolean;
}

/** Build a brand-new flow state at the start of the arc. */
function freshState(): FlowState {
  return { step: 'greet', seenMessageIds: [] };
}

/**
 * The default in-memory {@link FlowStore}. Backed by a `Map` keyed by
 * `conversationKey`; state lives for the process lifetime and resets on restart.
 * Exported as a factory so a standalone run gets one shared instance and tests
 * can each construct their own.
 */
export function createInMemoryFlowStore(): FlowStore {
  const states = new Map<string, FlowState>();
  return {
    get(key) {
      return states.get(key);
    },
    set(key, state) {
      states.set(key, state);
    },
    seen(key, msgId) {
      // Blank ids can't be deduped — treat every one as new.
      if (!msgId) return false;
      const state = states.get(key);
      if (!state) return false;
      if (state.seenMessageIds.includes(msgId)) return true;
      state.seenMessageIds.push(msgId);
      return false;
    }
  };
}

/** Module-level store used by the standalone server + the REPL. */
const defaultStore: FlowStore = createInMemoryFlowStore();

/* ────────────────────────────────────────────────────────────────────────── */
/* Pure handler                                                                */
/* ────────────────────────────────────────────────────────────────────────── */

/** Placeholder target id for reaction/reply when the turn carried no id. */
const FALLBACK_TARGET_ID = 'unknown-message-id';

/** Matches a "start over" request at any point in the arc (case-insensitive). */
const RESTART_RE = /^(restart|reset|start over)\b/i;

/**
 * Advance the coffee-order state machine for one inbound turn and return the
 * next {@link ChatResponse}. Pure-ish: all state lives in the injected
 * {@link FlowStore} (default the module store), so calling it repeatedly with
 * the same `conversationKey` walks the arc.
 *
 * Exported for tests and for the REPL to call directly.
 */
export function scriptedFlowResponse(req: ChatRequest, store: FlowStore = defaultStore): ChatResponse {
  const key = req.conversationKey;
  const text = (req.message ?? '').trim();
  const lastMessageId = req.messages.at(-1)?.channelMessageId ?? '';
  const target = lastMessageId || FALLBACK_TARGET_ID;

  // Load (or create) this conversation's state.
  let state = store.get(key);
  if (!state) {
    state = freshState();
    store.set(key, state);
  }

  // ── Dedupe demo ──────────────────────────────────────────────────────────
  // If we have already processed this exact inbound message id for this
  // conversation, stay silent. The transport dedupes inbound webhooks too; this
  // shows the endpoint-side `{ silence: true }` path. `seen()` records new ids.
  if (store.seen(key, lastMessageId)) {
    return { silence: true };
  }

  // ── Restart ──────────────────────────────────────────────────────────────
  // "restart" (etc.) wipes the collected answers and drops the user back at the
  // `size` step (we have already greeted), regardless of where they were. We
  // keep the seen-ids we just recorded so the restart turn itself can't loop.
  if (RESTART_RE.test(text)) {
    const seenMessageIds = state.seenMessageIds;
    state = { ...freshState(), step: 'size', seenMessageIds };
    store.set(key, state);
    return { message: 'Starting over. What size coffee would you like? (small, medium, large)' };
  }

  // ── Window re-engagement ─────────────────────────────────────────────────
  // If the 24h customer-service window is CLOSED, the only way to reach the user
  // is an approved WhatsApp template. Gate on `template` (WhatsApp-only); other
  // channels degrade to a plain message. We do this BEFORE the step machine so a
  // closed window always re-engages first.
  if (req.context.windowOpen === false) {
    if (req.capabilities.includes('template')) {
      // Send the re-engagement template; the step machine resumes on the user's
      // next (in-window) reply.
      return { actions: [{ type: 'template', name: 'hello_world', language: 'en_US' }] };
    }
    return { message: 'We could not reach you in time — message us again to pick up where we left off.' };
  }

  // ── State machine ─────────────────────────────────────────────────────────
  // Each branch reads the step we were WAITING on, records the answer, advances
  // the step, and returns the next prompt. State is persisted via `store.set`.
  switch (state.step) {
    // greet → size: first contact. Greet and ask for the drink size.
    case 'greet': {
      state.step = 'size';
      store.set(key, state);
      return { message: 'Welcome to Bean There! What size coffee would you like? (small, medium, large)' };
    }

    // size → milk: capture the size. Ack with a `reaction` when supported, then
    // ask about milk. When reactions are unsupported there is nothing to compose
    // with, so we degrade to a bare `message` (the simpler shape).
    case 'size': {
      state.size = text;
      state.step = 'milk';
      store.set(key, state);
      const followUp = `Great — a ${state.size}. What milk? (whole, oat, none)`;
      if (req.capabilities.includes('reaction')) {
        // Quick thumbs-up ack on the size message before the follow-up question.
        return {
          actions: [
            { type: 'reaction', emoji: '👍', targetMessageId: target },
            { type: 'message', text: followUp }
          ]
        };
      }
      return { message: followUp };
    }

    // milk → name: capture the milk. Use a `reply` to disambiguate (thread the
    // question onto the user's milk message) when `reply_to` is supported;
    // otherwise a plain message.
    case 'milk': {
      state.milk = text;
      state.step = 'name';
      store.set(key, state);
      const question = `Got it — ${state.milk} milk. What name should we put on the order?`;
      if (req.capabilities.includes('reply_to')) {
        return { actions: [{ type: 'reply', text: question, targetMessageId: target }] };
      }
      return { message: question };
    }

    // name → done: capture the name and confirm the pickup. Arc complete.
    case 'name': {
      state.name = text;
      state.step = 'done';
      store.set(key, state);
      return {
        message: `Thanks, ${state.name}! Your ${state.size} coffee with ${state.milk} milk will be ready for pickup shortly. Say "restart" to order again.`
      };
    }

    // done: the order is placed. Nudge the user to "restart" for a new order.
    case 'done':
    default:
      return { message: 'Your order is in! Say "restart" to place another.' };
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Express app                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Build an Express app exposing the chat endpoint.
 *
 *  - `POST /`        — the chat endpoint: reads the {@link ChatRequest} body and
 *    responds with {@link scriptedFlowResponse} (using the module-level store).
 *  - `GET /health`   — a trivial liveness check.
 *
 * Returns the app WITHOUT calling `listen`, so the REPL can boot it in-process.
 * The standalone-run guard at the bottom of this file is the only place that
 * starts a listener.
 */
export function createScriptedFlowChatEndpoint(): express.Express {
  const app = express();
  app.use(express.json());

  app.post('/', (req: Request, res: Response): void => {
    const body = req.body as ChatRequest;
    // No store argument → the shared module-level store, so state persists across
    // requests for the life of the server (what a standalone run wants).
    res.json(scriptedFlowResponse(body));
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
 * the REPL imports {@link createScriptedFlowChatEndpoint} from this module to
 * boot the endpoint in-process; without this check that import would also start
 * a second standalone listener. Resolve both `argv[1]` and `import.meta.url` to
 * absolute paths so the match holds regardless of relative-path quirks — same
 * convention as `src/index.ts`. Uses a distinct default port so it can run
 * alongside the other examples.
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
  const app = createScriptedFlowChatEndpoint();
  const port = process.env.PORT ?? 4004;
  app.listen(port, () => {
    process.stdout.write(`scripted-flow chat endpoint listening at http://localhost:${port}/\n`);
  });
}
