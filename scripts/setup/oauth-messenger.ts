/**
 * Messenger OAuth token-capture script (Facebook Login for Business → Page Token).
 *
 * Runs a minimal local Express server that walks the developer through the
 * Facebook Login for Business OAuth flow and captures a long-lived (effectively
 * permanent so long as the user retains Page admin) Page Access Token with
 * explicit scope control:
 *
 *   1. authorize         → `code`                    (browser flow)
 *   2. code              → User Access Token         (GET graph.facebook.com/v{N}/oauth/access_token)
 *   3. (defensive) short → long User Access Token    (GET .../oauth/access_token?grant_type=fb_exchange_token)
 *   4. user token        → /me/accounts              (lists managed Pages + their per-Page tokens)
 *   5. user picks Page   → Page Access Token         (data[i].access_token)
 *
 * WHY Facebook Login for Business + config_id over Dashboard "Generate Token":
 *   The App Dashboard's "Generate Token" button (Messenger → API Setup) mints a
 *   Page Access Token from the currently logged-in admin — convenient when the
 *   user's existing auth grant already covers every scope you need. But:
 *
 *     - The Dashboard cannot mint a token with scopes the user has not already
 *       granted to the app via a regular FB Login session. If you need
 *       `pages_read_engagement` or `pages_manage_metadata` and the user has
 *       only granted `pages_messaging`, "Generate Token" silently hands you a
 *       token missing those scopes — which then 200s the audit step in
 *       `verify-messenger` but fails `subscribe_messenger_page_app` with
 *       opaque "Subject not visible" (HTTP 403, code 210) errors.
 *
 *   Facebook Login for Business lets the developer pin a *configuration* (the
 *   `config_id` query param on the authorize URL) that bundles the EXACT scope
 *   set. Running this flow guarantees the resulting token carries those scopes
 *   regardless of the user's pre-existing grant — this is the canonical fix
 *   for the "Dashboard token has minimal scopes" failure mode surfaced during
 *   Stage 3 manual testing.
 *
 *   See https://developers.facebook.com/docs/facebook-login/facebook-login-for-business
 *   for the config-driven flow; the legacy scope-list authorize URL also still
 *   works but is being phased out.
 *
 * WHY /me/accounts is the path from User Token → Page Token:
 *   A User Access Token granted with `pages_show_list` + page-management scopes
 *   exposes `GET /me/accounts`, which returns one entry per Page the user
 *   admins (or has CREATE_CONTENT / MANAGE / MODERATE task on). Each entry
 *   carries an `access_token` field which IS a Page Access Token with the
 *   same scopes — that's the value we capture into MESSENGER_PAGE_ACCESS_TOKEN.
 *
 * WHY we may need to exchange short-lived → long-lived:
 *   Facebook Login for Business configurations can be created with either
 *   "Short-lived" (2h) or "Permanent" expiry. A short-lived flow yields a
 *   2-hour User Token; the `fb_exchange_token` grant swaps it for a ~60-day
 *   long-lived User Token. Page tokens DERIVED from a long-lived User Token
 *   are effectively non-expiring (Page tokens follow the issuing User Token's
 *   lifetime, and a long-lived User Token in turn yields permanent Page
 *   tokens). When the config_id is set to "Permanent", step 6 returns a
 *   `expires_in` of 0 or omits the field — we detect that and SKIP the
 *   short→long swap.
 *
 * WHY redirect_uri MUST be byte-for-byte identical to the Dashboard registration:
 *   Meta verifies the `redirect_uri` query parameter on BOTH the authorize step
 *   AND the code-exchange step against the "Valid OAuth Redirect URIs" list in
 *   Facebook Login for Business → Settings. A trailing slash, a missing one, or
 *   http vs https mismatch yields "Invalid redirect_uri" with no specific hint.
 *   We use `${NGROK_DOMAIN}/auth/messenger/callback` consistently and require
 *   the developer to register exactly that URL.
 *
 * WHY tokens are masked by default: as with the Instagram OAuth script, even
 * on a dev terminal a leaked Page Access Token grants unbounded send/receive
 * access to the Page. `--reveal` is opt-in so a stray screenshot doesn't leak.
 *
 * WHY `process.exitCode = N; return;` (not `process.exit(N)`): we have a
 * tunnel + Express server + readline handle to tear down. Hard-exiting orphans
 * those resources and can leave the ngrok session open in your account's
 * "active tunnels" list.
 */
import 'dotenv/config';
import express, { type Request as ExpressRequest, type Response as ExpressResponse } from 'express';
import { appendFile, access, readFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';

import {
  buildGraphUrl,
  graphFetch,
  MetaApiError,
  type GraphConfig
} from '../lib/graph-api.js';
import {
  info,
  success,
  warn,
  fail,
  step,
  divider,
  ask,
  confirm,
  closePrompts,
  registerShutdown
} from '../lib/console.js';
import { startTunnel, type ActiveTunnel } from '../lib/tunnel.js';
// Reuse pure helpers from the Instagram OAuth script rather than duplicating
// crypto.randomBytes / timingSafeEqual / mask / format logic. These functions
// are channel-agnostic — they don't care whether the token is an IG or FB one.
import {
  generateState,
  verifyState,
  maskToken,
  formatExpiresIn
} from './oauth-instagram.js';

/* ────────────────────────────────────────────────────────────────────────── */
/* Constants                                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

const CALLBACK_PATH = '/auth/messenger/callback';

/**
 * If a User Access Token reports more than this many seconds until expiry, we
 * treat it as "long-lived enough" and skip the fb_exchange_token swap.
 *
 * ~5,000,000s ≈ 58 days, slightly under the canonical 60-day long-lived
 * lifetime. The short-lived ceiling is ~2h (7200s), so the gap is huge: any
 * value above this threshold is a long-lived token already and re-exchanging
 * it is wasted round-trip. Configurations set to "Permanent" return
 * expires_in: 0 (or omit the field); we treat that the same as "no exchange
 * needed" — see step 6 in `main()`.
 */
const LONG_LIVED_THRESHOLD_SECONDS = 5_000_000;

/* ────────────────────────────────────────────────────────────────────────── */
/* Types                                                                      */
/* ────────────────────────────────────────────────────────────────────────── */

interface CliFlags {
  help: boolean;
  reveal: boolean;
}

interface UserAccessTokenResponse {
  access_token: string;
  token_type?: string;
  /**
   * Seconds until expiry. Omitted or 0 when the underlying FB Login for
   * Business configuration was created with "Permanent" duration.
   */
  expires_in?: number;
}

export interface PageEntry {
  id: string;
  name: string;
  access_token: string;
  category?: string;
  tasks?: string[];
}

interface MeAccountsResponse {
  data?: Array<{
    id?: unknown;
    name?: unknown;
    access_token?: unknown;
    category?: unknown;
    tasks?: unknown;
  }>;
  paging?: unknown;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Pure helpers (exported for tests)                                          */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Build the FB Login for Business authorize URL.
 *
 * Format (per Meta's current docs):
 *   `https://www.facebook.com/v{N}/dialog/oauth?client_id=...&config_id=...
 *    &redirect_uri=...&response_type=code&state=...`
 *
 * WHY `config_id` and NOT a `scope=` query param: Facebook Login for Business
 * stores the scope set (and other consent UX choices) server-side as a
 * "configuration" identified by `config_id`. The authorize URL points at the
 * configuration; Meta renders the consent screen from the stored config. This
 * is the documented replacement for the legacy `scope=a,b,c` parameter for
 * Business-product apps. Mixing `config_id` and `scope` is undefined behavior
 * and Meta has been observed to silently ignore one or the other depending on
 * App and config state — so we pass `config_id` only.
 *
 * https://developers.facebook.com/docs/facebook-login/facebook-login-for-business
 */
export function buildMessengerAuthorizeUrl(args: {
  apiVersion: string;
  clientId: string;
  configId: string;
  redirectUri: string;
  state: string;
}): string {
  // The version segment MUST include the `v` prefix per Meta's URL convention
  // (`v25.0`, not `25.0`). loadConfig already enforces this format on the
  // META_GRAPH_API_VERSION env var, but we don't go through loadConfig here —
  // belt-and-suspenders: rely on the caller to pass the prefix consistently.
  const params = new URLSearchParams({
    client_id: args.clientId,
    config_id: args.configId,
    redirect_uri: args.redirectUri,
    response_type: 'code',
    state: args.state
  });
  return `https://www.facebook.com/${args.apiVersion}/dialog/oauth?${params.toString()}`;
}

/**
 * Build the URL for the code → User Access Token exchange.
 *
 * Hits: `GET graph.facebook.com/v{N}/oauth/access_token?client_id=...
 *        &client_secret=...&redirect_uri=...&code=...`
 *
 * WHY a GET with query params (not a POST form): Meta's documented contract
 * for `/oauth/access_token` is GET-based on `graph.facebook.com`. This differs
 * from Instagram Business Login's code exchange which is a POST to
 * `api.instagram.com/oauth/access_token`. Don't unify the two — they really
 * are different shapes.
 *
 * IMPORTANT: `redirect_uri` here MUST be byte-for-byte identical to the
 * `redirect_uri` used in the authorize step AND to the entry registered in
 * App Dashboard → Facebook Login for Business → Settings → Valid OAuth
 * Redirect URIs. Even a trailing slash differs is fatal.
 */
export function buildMessengerCodeExchangeUrl(args: {
  apiVersion: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
}): string {
  // We construct the URL directly here (not via buildGraphUrl) because we want
  // explicit ordering and naming control on a load-bearing endpoint. The
  // resulting path/query are functionally identical to buildGraphUrl's.
  const params = new URLSearchParams({
    client_id: args.clientId,
    client_secret: args.clientSecret,
    redirect_uri: args.redirectUri,
    code: args.code
  });
  return `https://graph.facebook.com/${args.apiVersion}/oauth/access_token?${params.toString()}`;
}

/**
 * Build the URL for the short-lived → long-lived User Access Token swap.
 *
 * Hits: `GET graph.facebook.com/v{N}/oauth/access_token?
 *        grant_type=fb_exchange_token&client_id=...&client_secret=...
 *        &fb_exchange_token=<short-lived-token>`
 *
 * Returns a User Access Token valid for ~60 days. A Page Access Token derived
 * from a long-lived User Token is itself effectively non-expiring (Meta's
 * documented behavior is "Page tokens from long-lived User tokens never
 * expire as long as the requesting user retains a relevant role on the Page").
 *
 * https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived
 */
export function buildMessengerFbExchangeUrl(args: {
  apiVersion: string;
  clientId: string;
  clientSecret: string;
  shortLivedToken: string;
}): string {
  const params = new URLSearchParams({
    grant_type: 'fb_exchange_token',
    client_id: args.clientId,
    client_secret: args.clientSecret,
    fb_exchange_token: args.shortLivedToken
  });
  return `https://graph.facebook.com/${args.apiVersion}/oauth/access_token?${params.toString()}`;
}

/**
 * Build the `GET /me/accounts` URL — the documented path from a User Access
 * Token to the list of Pages the user manages, each carrying its OWN Page
 * Access Token.
 *
 * Uses `buildGraphUrl` since `/me/accounts` is a regular graph.facebook.com
 * endpoint with no special shape. `fields=id,name,access_token,category,tasks`
 * mirrors the doc's recommended field selection — `access_token` is the
 * load-bearing field (this IS the Page Access Token); `tasks` lets us surface
 * "the chosen Page allows messaging" diagnostics in the picker if needed.
 *
 * https://developers.facebook.com/docs/pages-api/getting-started/
 */
export function buildMeAccountsUrl(args: {
  apiVersion: string;
  accessToken: string;
}): string {
  return buildGraphUrl(
    'me/accounts',
    {
      fields: 'id,name,access_token,category,tasks',
      access_token: args.accessToken
    },
    { apiVersion: args.apiVersion }
  );
}

/** Parse `process.argv` slice into a typed flag bag. Throws on unknown flags. */
export function parseFlags(argv: readonly string[]): CliFlags {
  const flags: CliFlags = {
    help: false,
    reveal: false
  };
  for (const raw of argv) {
    if (raw === '--help' || raw === '-h') {
      flags.help = true;
      continue;
    }
    if (raw === '--reveal') {
      flags.reveal = true;
      continue;
    }
    throw new Error(`Unknown flag: ${raw}. Run with --help for usage.`);
  }
  return flags;
}

/**
 * True iff the .env contents already carry a non-empty value for
 * MESSENGER_PAGE_ACCESS_TOKEN. The trailing `\S` is load-bearing: it lets us
 * distinguish a real value from an empty placeholder copied from `.env.example`
 * (which would otherwise block a first-time OAuth capture).
 *
 * We deliberately do NOT check MESSENGER_PAGE_ID here — the user may have set
 * it manually before running OAuth (the user typically knows their Page id),
 * in which case the script will auto-select that Page. We only refuse to
 * clobber the TOKEN.
 */
export function hasExistingMessengerPageToken(envContents: string): boolean {
  return /^\s*MESSENGER_PAGE_ACCESS_TOKEN=\S/m.test(envContents);
}

/**
 * Pure Page selection logic — separated from the interactive ask() call so the
 * resolution rules can be unit-tested without spinning up readline.
 *
 * Selection rules:
 *   - If `targetPageId` is set AND matches one of the returned Pages → auto.
 *   - Else if exactly one Page is returned → auto.
 *   - Else → caller must prompt the user.
 *
 * Returns the entries unchanged so the caller can render the list verbatim.
 */
export function selectPage(
  pages: PageEntry[],
  targetPageId: string | undefined
): { mode: 'auto' | 'prompt'; selected?: PageEntry; pages: PageEntry[] } {
  if (pages.length === 0) {
    // Returning 'prompt' mode here is benign — the caller will short-circuit
    // before asking the user because there's nothing to pick from. We don't
    // throw because the caller wants to surface a remediation hint, not a
    // stack trace.
    return { mode: 'prompt', pages };
  }
  if (targetPageId !== undefined && targetPageId.trim() !== '') {
    const trimmed = targetPageId.trim();
    const match = pages.find(p => p.id === trimmed);
    if (match !== undefined) {
      return { mode: 'auto', selected: match, pages };
    }
    // targetPageId set but unmatched — fall through to prompt so the developer
    // can re-pick. We don't throw; the verify scripts may have set
    // MESSENGER_PAGE_ID against a different account, and forcing a re-pick
    // is safer than silently grabbing a wrong Page.
  }
  if (pages.length === 1) {
    // Safe: the user manages exactly one Page; pick it without prompting.
    return { mode: 'auto', selected: pages[0]!, pages };
  }
  return { mode: 'prompt', pages };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Help text                                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

const HELP_TEXT = `
oauth-messenger — Capture a Page Access Token via Facebook Login for Business.

Usage:
  npm run setup:oauth:messenger [-- --flag ...]
  npx tsx scripts/setup/oauth-messenger.ts [options]

Options:
  --reveal                Print the Page Access Token unmasked. Default masks.
  --help, -h              Show this message.

Environment:
  META_APP_ID                 Required. The Meta App id (App Settings → Basic).
  META_APP_SECRET             Required. The Meta App secret (same Dashboard section).
  MESSENGER_LOGIN_CONFIG_ID   Required. The Facebook Login for Business config id
                              that bundles the scope set you want on the Page
                              Access Token. Create one in App Dashboard →
                              Facebook Login for Business → Configurations.
                              Include pages_show_list, pages_messaging,
                              pages_manage_metadata, pages_read_engagement at a
                              minimum (more if you need them for app review or
                              future features). MUST be a config that grants
                              the same scopes you intend to use against the
                              Page Access Token.
  META_GRAPH_API_VERSION      Optional. Graph API version (default v25.0).
  NGROK_AUTHTOKEN             Required. ngrok auth token.
  NGROK_DOMAIN                Required. Reserved static ngrok domain (bare host).
  MESSENGER_PAGE_ID           Optional. If set and matches one of the Pages
                              returned by /me/accounts, the script auto-picks
                              that Page. Otherwise the script prompts.
  PORT                        Optional. Local listener port (default 3000).

Flow:
  1. Spins up an ngrok tunnel on NGROK_DOMAIN.
  2. Prints the FB Login for Business authorize URL — open it in your browser,
     approve consent for the configured scopes.
  3. Meta redirects to {NGROK_DOMAIN}/auth/messenger/callback?code=...&state=...
  4. Script validates state, exchanges code → User Access Token.
  5. Defensively swaps short-lived → long-lived if the User Token has a
     short expiry (skipped when the config is "Permanent").
  6. GETs /me/accounts to list Pages the user manages.
  7. Picks the target Page (auto if MESSENGER_PAGE_ID matches or only one
     Page is returned; prompts otherwise).
  8. Offers to append MESSENGER_PAGE_ACCESS_TOKEN (and MESSENGER_PAGE_ID if
     not already set) to .env.

Prerequisites (App Dashboard):
  - Create a Facebook Login for Business configuration in your Meta App and
    record its id as MESSENGER_LOGIN_CONFIG_ID.
  - Register {NGROK_DOMAIN}/auth/messenger/callback as a Valid OAuth Redirect
    URI under Facebook Login for Business → Settings. The URL MUST match
    byte-for-byte (trailing slashes matter).
`.trim();

/* ────────────────────────────────────────────────────────────────────────── */
/* Main                                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  let flags: CliFlags;
  try {
    flags = parseFlags(process.argv.slice(2));
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    process.exitCode = 2;
    return;
  }

  if (flags.help) {
    process.stdout.write(`${HELP_TEXT}\n`);
    return;
  }

  divider('Messenger OAuth Token Capture');

  // ── 1. Env validation ────────────────────────────────────────────────────
  // We don't go through loadConfig() because it requires verify_token /
  // chat_endpoint_url which are unrelated to this script. Read env directly
  // and fail fast with a clear remediation per missing field.
  const appId = (process.env['META_APP_ID'] ?? '').trim();
  const appSecret = (process.env['META_APP_SECRET'] ?? '').trim();
  const configId = (process.env['MESSENGER_LOGIN_CONFIG_ID'] ?? '').trim();
  const graphApiVersion = (process.env['META_GRAPH_API_VERSION'] ?? 'v25.0').trim();
  const port = parsePort(process.env['PORT']);
  const ngrokDomain = (process.env['NGROK_DOMAIN'] ?? '').trim();
  const targetPageId = (process.env['MESSENGER_PAGE_ID'] ?? '').trim();

  if (!appId) {
    fail('META_APP_ID must be set in .env.');
    info(
      'Find the Meta App id at https://developers.facebook.com/apps → your app → Settings → Basic. ' +
        'Unlike the Instagram OAuth flow which uses an Instagram-specific client_id, the Messenger ' +
        'flow authenticates as the Meta App itself.'
    );
    process.exitCode = 1;
    return;
  }

  if (!appSecret) {
    fail('META_APP_SECRET must be set in .env.');
    info(
      'Find the Meta App secret at https://developers.facebook.com/apps → your app → Settings → Basic. ' +
        'Used for the code-exchange and fb_exchange_token calls in this flow.'
    );
    process.exitCode = 1;
    return;
  }

  if (!configId) {
    fail('MESSENGER_LOGIN_CONFIG_ID must be set in .env.');
    info(
      'Create a Facebook Login for Business configuration at App Dashboard → Facebook Login for ' +
        'Business → Configurations → Create. Bundle the scopes you need (at minimum: ' +
        'pages_show_list, pages_messaging, pages_manage_metadata, pages_read_engagement). ' +
        'Copy the configuration id into .env as MESSENGER_LOGIN_CONFIG_ID. Why config_id and not ' +
        'a scope= param: FB Login for Business stores the scope set server-side; the authorize URL ' +
        'just points at the configuration.'
    );
    process.exitCode = 1;
    return;
  }

  if (!ngrokDomain) {
    fail('NGROK_DOMAIN must be set in .env.');
    info(
      'Reserve a free static domain at https://dashboard.ngrok.com/cloud-edge/domains and set ' +
        'NGROK_DOMAIN to the bare hostname (e.g. foo.ngrok-free.app). A stable domain is ' +
        "load-bearing here because the redirect URI registered in Facebook Login for Business → " +
        'Settings must match the tunnel hostname byte-for-byte — a rotating ephemeral hostname ' +
        'would force a re-registration every session.'
    );
    process.exitCode = 1;
    return;
  }

  const redirectUri = `https://${ngrokDomain}${CALLBACK_PATH}`;
  const state = generateState();
  const authorizeUrl = buildMessengerAuthorizeUrl({
    apiVersion: graphApiVersion,
    clientId: appId,
    configId,
    redirectUri,
    state
  });

  // ── 2. Spin tunnel ──────────────────────────────────────────────────────
  let tunnel: ActiveTunnel | undefined;
  try {
    step(1, 5, 'Starting ngrok tunnel');
    tunnel = await startTunnel({ port, domain: ngrokDomain });
    success(`ngrok tunnel: ${tunnel.url}`);
    info(`OAuth redirect URI: ${redirectUri}`);
    info(
      'Reminder: this exact URL must be registered in App Dashboard → Facebook Login for ' +
        'Business → Settings → Valid OAuth Redirect URIs. Trailing slashes matter.'
    );
  } catch (err) {
    fail(`Failed to set up tunnel: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  // ── 3. Print authorize URL + listen for callback ─────────────────────────
  step(2, 5, 'Open this URL in your browser, then sign in and approve:');
  process.stdout.write(`\n  ${authorizeUrl}\n\n`);
  info(`Waiting for Meta to redirect to ${redirectUri} …`);

  let server: Server | undefined;
  // Register a shutdown hook so Ctrl-C during the consent flow tears down
  // the tunnel + Express listener. Goes through the shared registry in
  // console.ts to play nice with the readline SIGINT path.
  registerShutdown(async () => {
    if (server) {
      await new Promise<void>(resolve => server!.close(() => resolve()));
    }
    if (tunnel) {
      await tunnel.close().catch(() => undefined);
    }
  });

  try {
    const code = await waitForCallback({
      port,
      expectedState: state,
      timeoutMs: 10 * 60 * 1000,
      onServer: srv => {
        server = srv;
      }
    });

    // ── 4. Exchange code → User Access Token ───────────────────────────────
    step(3, 5, 'Exchanging code for User Access Token');
    const userToken = await exchangeCodeForUserToken({
      apiVersion: graphApiVersion,
      clientId: appId,
      clientSecret: appSecret,
      redirectUri,
      code
    });
    success(
      `User token obtained (expires_in: ${formatExpiresIn(userToken.expires_in)}).`
    );

    // ── 5. (Defensive) short-lived → long-lived swap ───────────────────────
    // If the FB Login for Business configuration was created with "Permanent"
    // duration, the User Token already has effectively-no expiry and Meta
    // returns expires_in: 0 or omits the field. In that case re-exchanging is
    // wasted work. If the configuration was "Short-lived" the token has ~2h
    // life and we MUST swap to long-lived to derive a useful Page token from
    // it (Page tokens inherit User Token lifetime).
    let effectiveUserToken = userToken;
    const needsExchange =
      userToken.expires_in !== undefined &&
      userToken.expires_in > 0 &&
      userToken.expires_in <= LONG_LIVED_THRESHOLD_SECONDS;
    if (needsExchange) {
      step(4, 5, 'Exchanging short-lived for long-lived User Token');
      try {
        const longLived = await exchangeForLongLivedUserToken({
          apiVersion: graphApiVersion,
          clientId: appId,
          clientSecret: appSecret,
          shortLivedToken: userToken.access_token
        });
        effectiveUserToken = longLived;
        success(
          `Long-lived User Token obtained (expires_in: ${formatExpiresIn(longLived.expires_in)}).`
        );
      } catch (err) {
        // Salvage path: the short-lived User Token might still be usable for
        // /me/accounts — the Page Access Token it yields will inherit the
        // short-lived expiry, but that's fixable by re-running OAuth with a
        // Permanent configuration. Surface the error and continue.
        warn(
          `Long-lived swap failed: ${err instanceof Error ? err.message : String(err)}. ` +
            'Falling back to the short-lived User Token; the resulting Page Access Token ' +
            'will inherit the short expiry.'
        );
      }
    } else {
      step(4, 5, 'Skipping long-lived swap (token already long-lived or permanent)');
      info(
        userToken.expires_in === undefined || userToken.expires_in === 0
          ? 'expires_in omitted/0 — your FB Login for Business configuration is "Permanent".'
          : `expires_in > ${LONG_LIVED_THRESHOLD_SECONDS}s — already long-lived.`
      );
    }

    // ── 6. List Pages via /me/accounts ────────────────────────────────────
    step(5, 5, 'Fetching managed Pages via /me/accounts');
    const pages = await listManagedPages({
      apiVersion: graphApiVersion,
      accessToken: effectiveUserToken.access_token
    });

    if (pages.length === 0) {
      fail('No Pages returned by /me/accounts.');
      info(
        'The user you authenticated as does not appear to admin any Pages, or the configuration ' +
          'lacks pages_show_list. Double-check that:\n' +
          '  - The Facebook user you signed in as is an admin (or has CREATE_CONTENT/MANAGE/MODERATE ' +
          'task) on the target Page.\n' +
          '  - MESSENGER_LOGIN_CONFIG_ID points at a configuration that includes pages_show_list.'
      );
      process.exitCode = 1;
      return;
    }

    success(`Found ${pages.length} Page${pages.length === 1 ? '' : 's'}.`);

    // ── 7. Pick the target Page ───────────────────────────────────────────
    const selection = selectPage(pages, targetPageId || undefined);
    let chosen: PageEntry;
    if (selection.mode === 'auto' && selection.selected) {
      chosen = selection.selected;
      info(
        targetPageId
          ? `Auto-selected Page matching MESSENGER_PAGE_ID=${targetPageId}: ${chosen.name} (${chosen.id}).`
          : `Auto-selected the only available Page: ${chosen.name} (${chosen.id}).`
      );
    } else {
      chosen = await promptForPage(pages);
    }

    // ── 8. Print captured credentials ─────────────────────────────────────
    divider('Captured Credentials');
    info(`MESSENGER_PAGE_ID=${chosen.id}`);
    info(
      `MESSENGER_PAGE_ACCESS_TOKEN=${flags.reveal ? chosen.access_token : maskToken(chosen.access_token)}`
    );
    info(`Page: ${chosen.name}${chosen.category ? ` (${chosen.category})` : ''}`);
    if (chosen.tasks && chosen.tasks.length > 0) {
      info(`tasks: ${chosen.tasks.join(', ')}`);
    }
    if (!flags.reveal) {
      info('(Token masked. Re-run with --reveal to print the full value.)');
    }

    // ── 9. Optional .env append ───────────────────────────────────────────
    await maybeAppendToEnv({
      pageId: chosen.id,
      pageAccessToken: chosen.access_token,
      // Only write the page id line if .env doesn't already carry a non-empty one;
      // otherwise we'd risk clobbering or duplicating it.
      includePageIdLine: true
    });

    success(
      'Done. The Page Access Token is derived from a long-lived User Token; ' +
        'so long as you retain Page admin and the FB Login for Business configuration ' +
        'is Permanent, the token is effectively non-expiring.'
    );
  } catch (err) {
    handleFatalError(err);
    process.exitCode = process.exitCode ?? 1;
  } finally {
    // Tear down in reverse order: server, tunnel, prompts. Swallow errors so
    // the script always exits with the right code rather than throwing on
    // cleanup of a partially-initialized resource.
    if (server) {
      await new Promise<void>(resolve => server!.close(() => resolve()));
    }
    if (tunnel) {
      await tunnel.close().catch(() => undefined);
    }
    closePrompts();
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Express callback listener                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

interface WaitForCallbackArgs {
  port: number;
  expectedState: string;
  timeoutMs: number;
  onServer: (server: Server) => void;
}

/**
 * Boots an Express server on `port` that listens for ONE callback to
 * `/auth/messenger/callback`. Resolves with the `code` from the query, or
 * rejects on error / timeout / state mismatch.
 *
 * Mirror of the Instagram callback handler — the FB Login error envelope is
 * identical (error, error_reason, error_description). Could be unified later,
 * but the duplication is only ~50 LOC and keeps each channel's flow inspectable
 * in isolation.
 */
function waitForCallback(args: WaitForCallbackArgs): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const app = express();
    let settled = false;

    const finish = (err: Error | undefined, code?: string): void => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else if (code) resolve(code);
    };

    app.get(CALLBACK_PATH, (req: ExpressRequest, res: ExpressResponse) => {
      const error = typeof req.query['error'] === 'string' ? req.query['error'] : undefined;
      const errorReason =
        typeof req.query['error_reason'] === 'string' ? req.query['error_reason'] : undefined;
      const errorDescription =
        typeof req.query['error_description'] === 'string'
          ? req.query['error_description']
          : undefined;
      const receivedState = typeof req.query['state'] === 'string' ? req.query['state'] : '';
      const code = typeof req.query['code'] === 'string' ? req.query['code'] : undefined;

      if (error) {
        const detail = [errorReason, errorDescription].filter(Boolean).join(' — ') || error;
        res.status(400).send(renderResultPage('error', `OAuth error: ${detail}`));
        finish(new OAuthCancelled(`User or Meta rejected the OAuth flow: ${detail}`));
        return;
      }
      if (!verifyState(args.expectedState, receivedState)) {
        res
          .status(400)
          .send(renderResultPage('error', 'State mismatch — possible CSRF / stale browser tab.'));
        finish(
          new Error('OAuth callback state mismatch. Re-run the script and use a fresh browser tab.')
        );
        return;
      }
      if (!code) {
        res.status(400).send(renderResultPage('error', 'No code in callback.'));
        finish(new Error('OAuth callback missing "code" query parameter.'));
        return;
      }
      // 200 with a friendly page; the developer can close the tab and watch
      // the rest of the flow in the terminal.
      res
        .status(200)
        .send(
          renderResultPage(
            'ok',
            'Authorization complete. You can close this tab and return to the terminal.'
          )
        );
      finish(undefined, code);
    });

    // Anything else gets a 404 — keeps stray favicons / probes from polluting
    // logs while we wait for the real callback.
    app.use((_req, res) => {
      res.status(404).send('Not found');
    });

    const server = app.listen(args.port, () => {
      args.onServer(server);
    });
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        finish(
          new Error(
            `Port ${args.port} is already in use. Set PORT=<other> in your environment and re-run, ` +
              `or stop the process holding that port.`
          )
        );
        return;
      }
      finish(err);
    });

    // Hard timeout: 10 min default — generous because the user has to log in
    // to Facebook, possibly through 2FA, then approve consent.
    const timer = setTimeout(() => {
      finish(
        new Error(`Timed out after ${Math.round(args.timeoutMs / 1000)}s waiting for OAuth callback.`)
      );
    }, args.timeoutMs);
    timer.unref();
  });
}

class OAuthCancelled extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthCancelled';
  }
}

/** Minimal HTML page returned to the user's browser after callback. */
function renderResultPage(kind: 'ok' | 'error', detail: string): string {
  const color = kind === 'ok' ? '#16a34a' : '#dc2626';
  const heading = kind === 'ok' ? 'Authorization complete' : 'Authorization failed';
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${heading}</title></head>
<body style="font-family:system-ui,sans-serif;max-width:560px;margin:48px auto;padding:0 16px;line-height:1.5">
  <h1 style="color:${color};margin-bottom:8px">${heading}</h1>
  <p style="color:#374151">${escapeHtml(detail)}</p>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Graph API calls                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

async function exchangeCodeForUserToken(args: {
  apiVersion: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
}): Promise<UserAccessTokenResponse> {
  const url = buildMessengerCodeExchangeUrl(args);
  const result = await graphFetch<UserAccessTokenResponse>(
    url,
    { method: 'GET' },
    'messenger_oauth_code_exchange'
  );
  if (typeof result?.access_token !== 'string' || result.access_token.length === 0) {
    throw new MetaApiError({
      operation: 'messenger_oauth_code_exchange',
      httpStatus: 200,
      responseBody: result,
      message: 'Messenger OAuth code-exchange response missing access_token.'
    });
  }
  return result;
}

async function exchangeForLongLivedUserToken(args: {
  apiVersion: string;
  clientId: string;
  clientSecret: string;
  shortLivedToken: string;
}): Promise<UserAccessTokenResponse> {
  const url = buildMessengerFbExchangeUrl(args);
  const result = await graphFetch<UserAccessTokenResponse>(
    url,
    { method: 'GET' },
    'messenger_oauth_fb_exchange_token'
  );
  if (typeof result?.access_token !== 'string' || result.access_token.length === 0) {
    throw new MetaApiError({
      operation: 'messenger_oauth_fb_exchange_token',
      httpStatus: 200,
      responseBody: result,
      message: 'Messenger OAuth fb_exchange_token response missing access_token.'
    });
  }
  return result;
}

async function listManagedPages(args: {
  apiVersion: string;
  accessToken: string;
}): Promise<PageEntry[]> {
  const url = buildMeAccountsUrl(args);
  const result = await graphFetch<MeAccountsResponse>(
    url,
    { method: 'GET' },
    'messenger_oauth_me_accounts'
  );
  const data = Array.isArray(result?.data) ? result.data : [];
  // Filter to entries that have BOTH an id and an access_token — anything
  // missing those is unusable for this script's purpose and would surface as
  // confusing partial entries in the picker.
  const pages: PageEntry[] = [];
  for (const raw of data) {
    if (typeof raw.id !== 'string' || raw.id.length === 0) continue;
    if (typeof raw.access_token !== 'string' || raw.access_token.length === 0) continue;
    pages.push({
      id: raw.id,
      name: typeof raw.name === 'string' ? raw.name : '(unnamed Page)',
      access_token: raw.access_token,
      ...(typeof raw.category === 'string' ? { category: raw.category } : {}),
      ...(Array.isArray(raw.tasks) ? { tasks: raw.tasks.filter((t): t is string => typeof t === 'string') } : {})
    });
  }
  return pages;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Interactive Page picker                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

async function promptForPage(pages: PageEntry[]): Promise<PageEntry> {
  divider('Select a Page');
  pages.forEach((p, idx) => {
    const tail = p.category ? ` — ${p.category}` : '';
    process.stdout.write(`  [${idx + 1}] ${p.name} (id: ${p.id})${tail}\n`);
  });
  // Loop until we get a valid selection — typos shouldn't make the user
  // restart the whole OAuth flow.
  for (;;) {
    const answer = await ask(`Enter the number of the Page to use [1-${pages.length}]:`, '1');
    const n = Number.parseInt(answer, 10);
    if (Number.isFinite(n) && n >= 1 && n <= pages.length) {
      return pages[n - 1]!;
    }
    warn(`Invalid selection: ${answer}. Enter a number between 1 and ${pages.length}.`);
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* .env writing                                                               */
/* ────────────────────────────────────────────────────────────────────────── */

async function maybeAppendToEnv(args: {
  pageId: string;
  pageAccessToken: string;
  includePageIdLine: boolean;
}): Promise<void> {
  const envPath = path.resolve(process.cwd(), '.env');
  const exists = await fileExists(envPath);
  const yes = await confirm(
    exists ? 'Append MESSENGER_PAGE_ACCESS_TOKEN to .env now?' : '.env not found in cwd — create it now?',
    false
  );
  if (!yes) {
    info('Skipped .env update. Copy the values above into your environment manually.');
    return;
  }

  // Guard: refuse to clobber an existing non-empty MESSENGER_PAGE_ACCESS_TOKEN
  // line. The `=\S` requirement skips empty placeholder lines (e.g.
  // `MESSENGER_PAGE_ACCESS_TOKEN=` copied verbatim from .env.example) — those
  // should not block a fresh capture. We do NOT guard against an existing
  // MESSENGER_PAGE_ID because the user may have set it intentionally before
  // running OAuth (to auto-select the right Page from /me/accounts).
  let hasExistingPageId = false;
  if (exists) {
    const existing = await readFile(envPath, 'utf8');
    if (hasExistingMessengerPageToken(existing)) {
      fail(
        'Existing non-empty MESSENGER_PAGE_ACCESS_TOKEN line found in .env. ' +
          'Remove or clear that line manually to avoid clobbering an existing value.'
      );
      return;
    }
    // Don't duplicate MESSENGER_PAGE_ID if it already carries a non-empty value
    // (the user-supplied one and the OAuth-picked one match by construction —
    // selectPage() auto-picked precisely because they matched).
    hasExistingPageId = /^\s*MESSENGER_PAGE_ID=\S/m.test(existing);
  }

  const pageIdLine =
    args.includePageIdLine && !hasExistingPageId ? `MESSENGER_PAGE_ID=${args.pageId}\n` : '';
  const block =
    (exists ? '\n' : '') +
    `# Messenger Page Access Token (captured ${new Date().toISOString()} via FB Login for Business)\n` +
    pageIdLine +
    `MESSENGER_PAGE_ACCESS_TOKEN=${args.pageAccessToken}\n`;
  await appendFile(envPath, block, 'utf8');
  success(
    pageIdLine
      ? `Wrote MESSENGER_PAGE_ID and MESSENGER_PAGE_ACCESS_TOKEN to ${envPath}.`
      : `Wrote MESSENGER_PAGE_ACCESS_TOKEN to ${envPath} (MESSENGER_PAGE_ID already present, skipped).`
  );
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Misc                                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

function parsePort(raw: string | undefined): number {
  if (!raw) return 3000;
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n) || n < 1 || n > 65535) {
    warn(`Ignoring invalid PORT=${raw}; using default 3000.`);
    return 3000;
  }
  return n;
}

function handleFatalError(err: unknown): void {
  if (err instanceof OAuthCancelled) {
    fail(err.message);
    info('Re-run the script when ready to retry consent.');
    process.exitCode = 1;
    return;
  }
  if (err instanceof MetaApiError) {
    fail(`Meta API error (${err.operation}): ${err.message}`);
    if (err.fbtraceId) info(`fbtrace_id: ${err.fbtraceId}`);
    // Common diagnostic: redirect URI mismatch. Surface a clear hint.
    const body = err.responseBody;
    const serverMsg =
      typeof body === 'object' && body !== null && 'error' in body
        ? String((body as { error?: { message?: unknown } }).error?.message ?? '')
        : typeof body === 'string'
          ? body
          : '';
    if (/redirect[_ ]?uri/i.test(serverMsg) || /Invalid platform app/i.test(serverMsg)) {
      info(
        'Hint: this usually means the redirect URI sent to /oauth/access_token does not EXACTLY ' +
          'match the URL registered in App Dashboard → Facebook Login for Business → Settings → ' +
          'Valid OAuth Redirect URIs. Trailing slashes and http vs https matter.'
      );
    }
    if (/config[_ ]?id/i.test(serverMsg)) {
      info(
        'Hint: this suggests MESSENGER_LOGIN_CONFIG_ID is invalid, was deleted, or belongs to a ' +
          "different Meta App. Confirm it in App Dashboard → Facebook Login for Business → " +
          'Configurations.'
      );
    }
    process.exitCode = 1;
    return;
  }
  fail(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Entry point                                                                */
/* ────────────────────────────────────────────────────────────────────────── */

// Detect "run as script" vs. "imported by a test" so the tests can pull in
// the exported helpers without booting the OAuth flow.
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
  main().catch(err => {
    handleFatalError(err);
    process.exitCode = process.exitCode ?? 1;
  });
}
