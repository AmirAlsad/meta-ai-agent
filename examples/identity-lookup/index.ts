/**
 * EXAMPLE: a stub for the `USER_LOOKUP_URL` identity-lookup contract.
 *
 * IMPORTANT: this is NOT a chat endpoint. It is YOUR side of the
 * `USER_LOOKUP_URL` contract — the optional, fail-open identity-enrichment hook
 * the meta-ai-agent calls BEFORE the chat call. The agent POSTs the inbound
 * sender's identity; you return a {@link Contact} (name / email / tags / custom
 * variables / a cross-channel `unifiedContactId`). The resolved contact then
 * rides on the {@link ChatRequest} so your chat endpoint sees it. See
 * `docs/features/identity-resolution.md` for the full contract.
 *
 * Because it answers a DIFFERENT contract from the chat endpoint (a lookup
 * request, not a `ChatRequest`), this example is NOT a target for the chat
 * runners (`npm run example:chat` / `example:dev`). Run it ALONGSIDE a chat
 * example: point `USER_LOOKUP_URL` here and `CHAT_ENDPOINT_URL` at a chat
 * endpoint, and you'll watch the resolved `contact` block appear inside each
 * `ChatRequest`.
 *
 * What the agent's `HttpIdentityResolver` (`src/identity/resolver.ts`) sends:
 *
 *   POST <USER_LOOKUP_URL>
 *   { "channel": "whatsapp",
 *     "channelScopedUserId": "447700900123",   // the OTHER party (wa_id/PSID/IGSID)
 *     "channelScopedBusinessId": "1112223334" } // your side (phone_number_id/page/ig id)
 *
 * Two exports:
 *  - {@link lookupIdentity} — the pure handler (unit-tested): maps a lookup
 *    request to a {@link Contact} for a couple of hardcoded users, `null`
 *    otherwise.
 *  - {@link createIdentityLookupEndpoint} — builds the Express app exposing it.
 */
import path from 'node:path';
import express, { type Request, type Response } from 'express';

/* ────────────────────────────────────────────────────────────────────────── */
/* Contract type                                                               */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Local mirror of the package's `Contact` shape (`src/identity/types.ts`),
 * decoupled on purpose — like the other examples that re-declare `ChatRequest`
 * fields rather than import them. A real consumer installs the package and
 * imports it instead: `import type { Contact } from 'meta-ai-agent'`.
 *
 * Keep this field-for-field in sync with `src/identity/types.ts`. The agent's
 * resolver leniently coerces the body: every field is optional, wrong-typed
 * fields are dropped, and `channel` / `channelScopedUserId` are re-stamped from
 * the REQUEST (not the body), so you cannot accidentally re-key a contact onto a
 * different sender.
 */
interface Contact {
  /** Originating channel, e.g. `whatsapp` / `messenger` / `instagram`. */
  channel: string;
  /** Channel-scoped id of the user — `wa_id` / PSID / IGSID. */
  channelScopedUserId: string;
  firstName?: string;
  lastName?: string;
  displayName?: string;
  email?: string;
  /** Free-form labels (e.g. `["tier:gold"]`). */
  tags?: string[];
  /** Arbitrary string-valued metadata the resolver wants to surface. */
  customVariables?: Record<string, string>;
  /** Stable cross-channel id linking the same person across channels. */
  unifiedContactId?: string;
}

/** The lookup request body the agent's resolver POSTs to `USER_LOOKUP_URL`. */
interface IdentityLookupRequest {
  /** `whatsapp` / `messenger` / `instagram`. */
  channel: string;
  /** The OTHER party — `wa_id` / PSID / IGSID. */
  channelScopedUserId: string;
  /** Your side — `phone_number_id` / page id / ig user id. */
  channelScopedBusinessId: string;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Hardcoded directory                                                         */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Two sample contacts, keyed by `channelScopedUserId`. In a real lookup you'd
 * query your CRM/auth store by the (channel, channelScopedUserId) pair; this
 * stub just hardcodes a couple so the enrichment path is observable end to end.
 *
 *  - A WhatsApp user enriched with `firstName` / `lastName` / `tags`.
 *  - A Messenger user enriched with `displayName` / `customVariables` plus a
 *    `unifiedContactId` (the cross-channel link the package never synthesizes
 *    itself — see `docs/features/identity-resolution.md`).
 *
 * `channel` / `channelScopedUserId` are filled from the REQUEST in
 * {@link lookupIdentity}, mirroring how the resolver re-stamps them — so the
 * values here are illustrative defaults, not the source of truth.
 */
const CONTACTS: Record<string, Omit<Contact, 'channel' | 'channelScopedUserId'>> = {
  // WhatsApp `wa_id` (a phone number without the +).
  '447700900123': {
    firstName: 'Alice',
    lastName: 'Anderson',
    email: 'alice@example.com',
    tags: ['tier:gold', 'beta'],
    unifiedContactId: 'crm-0001'
  },
  // Messenger PSID (page-scoped id).
  '987654321098765': {
    displayName: 'Bob B.',
    customVariables: { plan: 'pro', locale: 'en-US' },
    unifiedContactId: 'crm-0002'
  }
};

/* ────────────────────────────────────────────────────────────────────────── */
/* Pure handler                                                                */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Resolve a lookup request to a {@link Contact}, or `null` when the user is
 * unknown.
 *
 * `channel` and `channelScopedUserId` on the returned contact are taken from the
 * REQUEST — this matches what the agent's `shapeContact` does (it ignores those
 * fields in the body and stamps the looked-up identity), so the stub stays
 * honest about whose contact it is.
 *
 * Exported for tests and for callers that want to reuse the directory logic
 * without an HTTP hop.
 */
export function lookupIdentity(req: IdentityLookupRequest): Contact | null {
  const enrichment = CONTACTS[req.channelScopedUserId];
  if (!enrichment) {
    // Unknown user → no enrichment. The agent is fail-open: returning nothing
    // here simply means the conversation proceeds without a contact.
    return null;
  }
  return {
    channel: req.channel,
    channelScopedUserId: req.channelScopedUserId,
    ...enrichment
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Express app                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Build an Express app exposing the identity-lookup endpoint.
 *
 *  - `POST /`      — the lookup: reads the {@link IdentityLookupRequest} body and
 *    returns the {@link Contact} JSON (200) for a known user, or `404` for an
 *    unknown one (see below).
 *  - `GET /health` — a trivial liveness check.
 *
 * WHY 404 (not 200-with-null) for an unknown user: the agent's
 * `HttpIdentityResolver` (`src/identity/resolver.ts`) is FAIL-OPEN. Its
 * `!response.ok` branch treats ANY non-2xx as "no enrichment, proceed" and
 * returns `undefined` without throwing — so a 404 cleanly and explicitly maps
 * to "no contact found". (A `200` with `null` / `{}` would ALSO work, because
 * `shapeContact` returns `undefined` for a body that contributes no recognized
 * field — but 404 is the more honest status for "not found" and is the path the
 * resolver's own tests exercise.) Either way the conversation is never blocked.
 *
 * Returns the app WITHOUT calling `listen`, so it can be booted in-process. The
 * standalone-run guard at the bottom of this file is the only place that starts
 * a listener — same convention as the chat examples.
 */
export function createIdentityLookupEndpoint(): express.Express {
  const app = express();
  app.use(express.json());

  app.post('/', (req: Request, res: Response): void => {
    const body = req.body as IdentityLookupRequest;
    const contact = lookupIdentity(body);
    if (contact === null) {
      // Non-2xx → resolver fail-opens to "no enrichment". (See doc comment.)
      res.sendStatus(404);
      return;
    }
    res.json(contact);
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
 * this module exports {@link createIdentityLookupEndpoint} so it can be booted
 * in-process; without this check, importing it would also start a standalone
 * listener. Resolve both `argv[1]` and `import.meta.url` to absolute paths so
 * the match holds regardless of relative-path quirks — same convention as
 * `src/index.ts` and the chat examples. Default port 4010 stays clear of the
 * chat examples' 4001 / 4002 / 4003 so this can run side by side with one.
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
  const app = createIdentityLookupEndpoint();
  const port = process.env.PORT ?? 4010;
  app.listen(port, () => {
    process.stdout.write(`identity-lookup endpoint listening at http://localhost:${port}/\n`);
    process.stdout.write(`point the agent at it with USER_LOOKUP_URL=http://localhost:${port}\n`);
  });
}
