/**
 * Instagram OAuth token-capture script (Stage 3, Instagram Business Login).
 *
 * Runs a minimal local Express server that walks the developer through the
 * Instagram Business Login OAuth flow and captures a long-lived (~60d)
 * Instagram User Access Token. Two-step exchange:
 *
 *   1. authorize → `code` (browser flow)
 *   2. code      → short-lived token  (POST api.instagram.com/oauth/access_token)
 *   3. short     → long-lived token   (GET  graph.instagram.com/access_token)
 *
 * WHY two hostnames: Meta historically uses `api.instagram.com` for the OAuth
 * code-exchange endpoint and `graph.instagram.com` for the Graph API surface
 * (including the long-lived `ig_exchange_token` swap). The split is real and
 * intentional; both URLs are exactly as documented and changing them WILL
 * break the flow.
 *
 * WHY the redirect URI must be HTTPS and pre-registered: Instagram Business
 * Login requires a public HTTPS redirect URI registered in the App Dashboard
 * under Instagram → Instagram API Setup with Business Login → Business Login
 * Settings → OAuth redirect URIs. Localhost is NOT allowed for IG Business
 * Login (unlike Facebook Login, which permits localhost for dev). So the
 * default path here is `ngrok` → public URL → register that URL in the
 * Dashboard once.
 *
 * WHY tokens are masked by default: even on a dev terminal these grant
 * unbounded send/receive access to the Instagram account. The `--reveal` flag
 * is opt-in so a stray screenshot doesn't leak the token.
 *
 * WHY `process.exitCode = N; return;` (not `process.exit(N)`): we have a
 * tunnel + Express server + readline handle to tear down. Hard-exiting
 * orphans those resources and can leave the ngrok session open in your
 * account's "active tunnels" list.
 */
import 'dotenv/config';
import express, { type Request as ExpressRequest, type Response as ExpressResponse } from 'express';
import { appendFile, access, readFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Server } from 'node:http';

import {
  getInstagramUser,
  MetaApiError,
  graphFetch,
  type GraphConfig
} from '../lib/graph-api.js';
import {
  info,
  success,
  warn,
  fail,
  step,
  divider,
  confirm,
  closePrompts,
  registerShutdown
} from '../lib/console.js';
import { startTunnel, type ActiveTunnel } from '../lib/tunnel.js';

/* ────────────────────────────────────────────────────────────────────────── */
/* Constants                                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

// Code → short-lived token swap. Note the api.instagram.com host (NOT graph.*).
// The matching `https://www.instagram.com/oauth/authorize` host lives in the
// embed URL that ships via `INSTAGRAM_AUTHORIZE_URL` — we don't construct that
// URL anywhere in the script (parseAuthorizeUrl consumes it instead).
const TOKEN_HOST = 'https://api.instagram.com/oauth/access_token';
const CALLBACK_PATH = '/auth/instagram/callback';

/* ────────────────────────────────────────────────────────────────────────── */
/* Types                                                                      */
/* ────────────────────────────────────────────────────────────────────────── */

interface CliFlags {
  help: boolean;
  reveal: boolean;
}

interface ShortLivedTokenResponse {
  access_token: string;
  user_id: number;
  permissions?: string[];
}

interface LongLivedTokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Pure helpers (exported for tests)                                          */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Build the form body for the short-lived token exchange. Used as the POST
 * body to `api.instagram.com/oauth/access_token`.
 *
 * IMPORTANT: `redirect_uri` here MUST be byte-for-byte identical to the
 * `redirect_uri` used in the authorize step. Meta rejects exchange with a
 * generic "Invalid platform app" / "redirect_uri mismatch" if even a trailing
 * slash differs.
 */
export function buildShortLivedTokenBody(args: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
}): URLSearchParams {
  return new URLSearchParams({
    client_id: args.clientId,
    client_secret: args.clientSecret,
    grant_type: 'authorization_code',
    redirect_uri: args.redirectUri,
    code: args.code
  });
}

/**
 * Build the URL for the short→long token exchange.
 *
 * Hits `graph.instagram.com/access_token?grant_type=ig_exchange_token&...`.
 * Returns a token valid for ~60 days that can be refreshed via
 * `grant_type=ig_refresh_token` before expiry.
 *
 * WHY a literal URL (not `buildInstagramGraphUrl`): the IG long-lived swap
 * endpoint is UNVERSIONED — it's `/access_token` at the host root, with no
 * `/v{N.M}/` segment. `buildInstagramGraphUrl` injects a version prefix which
 * 404s here. See:
 * https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login
 */
export function buildLongLivedTokenUrl(args: {
  clientSecret: string;
  shortLivedToken: string;
}): string {
  const params = new URLSearchParams({
    grant_type: 'ig_exchange_token',
    client_secret: args.clientSecret,
    access_token: args.shortLivedToken
  });
  return `https://graph.instagram.com/access_token?${params.toString()}`;
}

/**
 * Generate a cryptographically random `state` value for CSRF protection.
 * 16 bytes hex == 32 chars; aligns with OAuth 2.0 BCP recommendations.
 */
export function generateState(): string {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Constant-time compare for state values to avoid leaking timing info.
 * Falls back to false if lengths differ (no need to compare further).
 */
export function verifyState(expected: string, received: string): boolean {
  if (expected.length !== received.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received));
  } catch {
    return false;
  }
}

/**
 * Mask a token: show first 10 + last 4 characters with ellipsis. Short
 * tokens (< 14 chars) are fully masked.
 */
export function maskToken(token: string): string {
  if (token.length < 14) return '*'.repeat(token.length);
  return `${token.slice(0, 10)}...${token.slice(-4)}`;
}

/** Pretty human-readable lifetime (e.g. `5184000s ≈ 60 days`). */
export function formatExpiresIn(seconds: number | undefined): string {
  if (!seconds || !Number.isFinite(seconds)) return 'unknown';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  if (days > 0) return `${seconds}s (~${days} day${days === 1 ? '' : 's'}${hours > 0 ? ` ${hours}h` : ''})`;
  return `${seconds}s`;
}

/**
 * True iff the .env contents already carry a non-empty value for
 * INSTAGRAM_USER_ID or INSTAGRAM_ACCESS_TOKEN. The trailing `\S` is load-bearing:
 * it lets us distinguish a real value from an empty placeholder copied from
 * `.env.example` (which would otherwise block a first-time OAuth capture).
 */
export function hasExistingInstagramValue(envContents: string): boolean {
  return /^\s*INSTAGRAM_(USER_ID|ACCESS_TOKEN)=\S/m.test(envContents);
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
 * Parse an Instagram authorize URL (the embed URL Meta provides in the App
 * Dashboard) and extract the fields the OAuth flow needs:
 *   - `clientId` — the *Instagram* app id (distinct from META_APP_ID; the
 *     Instagram product within a Meta App has its own credential pair).
 *   - `redirectUri` — where Meta will send the user back; the callback
 *     handler must listen at this exact path.
 *   - `state` — CSRF nonce. Meta's Dashboard embed URL does NOT include
 *     state; the developer is expected to add one. We surface it as
 *     optional here and the caller generates one if absent.
 *
 * Throws Error with a specific remediation if a hard-required field is
 * missing — we'd rather fail loudly at startup than mysteriously at
 * callback time.
 */
export function parseAuthorizeUrl(authorizeUrl: string): {
  clientId: string;
  redirectUri: string;
  state: string | undefined;
} {
  let parsed: URL;
  try {
    parsed = new URL(authorizeUrl);
  } catch {
    throw new Error(
      `INSTAGRAM_AUTHORIZE_URL is not a valid URL. Paste the full embed URL from ` +
        `the Meta App Dashboard → Instagram → API setup with Instagram Business Login.`
    );
  }
  const clientId = parsed.searchParams.get('client_id');
  if (!clientId) {
    throw new Error(
      `INSTAGRAM_AUTHORIZE_URL is missing the required client_id query parameter.`
    );
  }
  const redirectUri = parsed.searchParams.get('redirect_uri');
  if (!redirectUri) {
    throw new Error(
      `INSTAGRAM_AUTHORIZE_URL is missing the required redirect_uri query parameter.`
    );
  }
  const state = parsed.searchParams.get('state') ?? undefined;
  return { clientId, redirectUri, state };
}

/**
 * Append (or replace) the `state` query parameter on an authorize URL.
 * Used when Meta's embed URL didn't include one and we generated a fresh
 * CSRF nonce locally — we need the browser to send it back so the callback
 * handler can verify it.
 */
export function withState(authorizeUrl: string, state: string): string {
  const url = new URL(authorizeUrl);
  url.searchParams.set('state', state);
  return url.toString();
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Help text                                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

const HELP_TEXT = `
oauth-instagram — Capture a long-lived Instagram User Access Token.

Usage:
  npm run setup:oauth:instagram [-- --flag ...]
  npx tsx scripts/setup/oauth-instagram.ts [options]

Options:
  --reveal                Print the long-lived token unmasked. Default masks.
  --help, -h              Show this message.

Environment:
  INSTAGRAM_AUTHORIZE_URL    Required. Embed authorize URL copied from the Meta
                             App Dashboard → Instagram → API setup with
                             Instagram Business Login. Contains client_id,
                             redirect_uri, scope, response_type, and state —
                             the script parses client_id, redirect_uri, and
                             state out of it and never constructs an authorize
                             URL itself.
  INSTAGRAM_APP_SECRET       Required. The *Instagram* app secret (distinct
                             from META_APP_SECRET). Found in the same Dashboard
                             section as the embed URL, labeled "Instagram app
                             secret". Used for the short-lived AND long-lived
                             token exchanges.
  META_GRAPH_API_VERSION     Optional. Graph API version (default v25.0).
  PORT                       Optional. Local listener port (default 3000).
  NGROK_AUTHTOKEN            Required. ngrok auth token.
  NGROK_DOMAIN               Required. Reserved static ngrok domain (bare host).

Flow:
  1. Spins up an ngrok tunnel on NGROK_DOMAIN.
  2. Sanity-checks tunnel host matches the embed URL's redirect_uri.
  3. Prints INSTAGRAM_AUTHORIZE_URL — open it in your browser, approve consent.
  4. Meta redirects to {redirect_uri}?code=...&state=...
  5. Script validates state, exchanges the code → short-lived → long-lived (~60d) token.
  6. Verifies the token via /me, prints user_id + username.
  7. Offers to append INSTAGRAM_ACCESS_TOKEN / INSTAGRAM_USER_ID to .env.
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

  divider('Instagram OAuth Token Capture');

  // ── 1. Env validation ────────────────────────────────────────────────────
  // We don't go through loadConfig() because it requires verify_token /
  // chat_endpoint_url which are unrelated to this script. Read env directly
  // for the values we need and fail fast with a clear remediation.
  const igAppSecret = (process.env['INSTAGRAM_APP_SECRET'] ?? '').trim();
  const graphApiVersion = (process.env['META_GRAPH_API_VERSION'] ?? 'v25.0').trim();
  const port = parsePort(process.env['PORT']);
  const ngrokDomain = (process.env['NGROK_DOMAIN'] ?? '').trim();
  const authorizeUrl = (process.env['INSTAGRAM_AUTHORIZE_URL'] ?? '').trim();

  if (!authorizeUrl) {
    fail('INSTAGRAM_AUTHORIZE_URL must be set in .env.');
    info(
      'Paste the embed authorize URL from Meta App Dashboard → Instagram → ' +
        'API setup with Instagram Business Login → "Authorize this app for Instagram business". ' +
        'It includes client_id, redirect_uri, scope, response_type, and state — the script ' +
        'parses client_id, state, and redirect_uri from it so we never construct (and ' +
        'mis-construct) an authorize URL ourselves.'
    );
    process.exitCode = 1;
    return;
  }

  if (!igAppSecret) {
    fail('INSTAGRAM_APP_SECRET must be set in .env.');
    info(
      'The Instagram product inside a Meta App has its OWN credential pair, distinct from ' +
        'META_APP_ID / META_APP_SECRET. Find INSTAGRAM_APP_SECRET in the Meta App Dashboard → ' +
        'Instagram → API setup with Instagram Business Login → "Instagram app secret". The ' +
        'matching app id is parsed out of INSTAGRAM_AUTHORIZE_URL as `client_id`.'
    );
    process.exitCode = 1;
    return;
  }

  if (!ngrokDomain) {
    fail('NGROK_DOMAIN must be set in .env.');
    info(
      'Reserve a free static domain at https://dashboard.ngrok.com/cloud-edge/domains and set ' +
        'NGROK_DOMAIN to the bare hostname (e.g. foo.ngrok-free.app). A stable domain is ' +
        "load-bearing here because the embed URL's redirect_uri is registered in the Meta " +
        'Dashboard byte-for-byte — a rotating ephemeral hostname would force a re-paste ' +
        'every session.'
    );
    process.exitCode = 1;
    return;
  }

  // ── 2. Parse the embed URL ───────────────────────────────────────────────
  let igClientId: string;
  let redirectUri: string;
  let parsedState: string | undefined;
  try {
    ({ clientId: igClientId, redirectUri, state: parsedState } = parseAuthorizeUrl(authorizeUrl));
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  // Meta's Dashboard embed URL omits `state`; generate fresh CSRF nonce and
  // append it so the callback handler has something to validate against.
  const expectedState = parsedState ?? generateState();
  const effectiveAuthorizeUrl = parsedState ? authorizeUrl : withState(authorizeUrl, expectedState);
  if (!parsedState) {
    info('No state param in INSTAGRAM_AUTHORIZE_URL — generated one for CSRF protection.');
  }

  const graphConfig: GraphConfig = { apiVersion: graphApiVersion };

  // ── 3. Spin tunnel + sanity-check that it matches the embed URL's redirect_uri ─
  let tunnel: ActiveTunnel | undefined;
  try {
    step(1, 4, 'Starting ngrok tunnel');
    tunnel = await startTunnel({ port, domain: ngrokDomain });
    success(`ngrok tunnel: ${tunnel.url}`);

    // If the embed URL's redirect host doesn't match the tunnel host the
    // callback won't reach us — fail fast with a specific remediation
    // rather than letting the developer wait for a timeout that never resolves.
    const tunnelHost = new URL(tunnel.url).host;
    const redirectHost = new URL(redirectUri).host;
    if (tunnelHost !== redirectHost) {
      throw new Error(
        `Tunnel host (${tunnelHost}) does not match INSTAGRAM_AUTHORIZE_URL's ` +
          `redirect_uri host (${redirectHost}). Either re-generate the embed URL in the Meta ` +
          `Dashboard against your current NGROK_DOMAIN, or update NGROK_DOMAIN to match.`
      );
    }
    info(`OAuth redirect URI (parsed from embed URL): ${redirectUri}`);
  } catch (err) {
    fail(`Failed to set up tunnel: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  // ── 4. Print the embed URL + listen for callback ─────────────────────────
  step(2, 4, 'Open this URL in your browser, then sign in and approve:');
  process.stdout.write(`\n  ${effectiveAuthorizeUrl}\n\n`);
  info(`Waiting for Meta to redirect to ${redirectUri} …`);

  let server: Server | undefined;
  // Register a shutdown hook so Ctrl-C during the consent flow tears down
  // the tunnel + Express listener. Goes through the shared registry in
  // console.ts to play nice with the readline SIGINT path.
  registerShutdown(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    if (tunnel) {
      await tunnel.close().catch(() => undefined);
    }
  });

  try {
    const code = await waitForCallback({
      port,
      expectedState,
      timeoutMs: 10 * 60 * 1000,
      onServer: srv => {
        server = srv;
      }
    });

    // ── 4. Exchange code → short-lived token ───────────────────────────────
    // Uses the Instagram-product credentials (igClientId from the parsed
    // authorize URL + INSTAGRAM_APP_SECRET), NOT the parent Meta app's id/secret.
    step(3, 4, 'Exchanging code for short-lived token');
    const shortLived = await exchangeCodeForShortLived({
      clientId: igClientId,
      clientSecret: igAppSecret,
      redirectUri,
      code
    });
    success(`Short-lived token obtained (user_id=${shortLived.user_id}).`);

    // ── 5. Exchange short-lived → long-lived ───────────────────────────────
    step(4, 4, 'Exchanging short-lived for long-lived (~60 days) token');
    let longLived: LongLivedTokenResponse;
    try {
      longLived = await exchangeShortForLongLived({
        clientSecret: igAppSecret,
        shortLivedToken: shortLived.access_token
      });
    } catch (err) {
      // Salvage path: print the short-lived token so the developer can
      // continue manually rather than re-running the whole consent flow.
      fail(`Long-lived exchange failed: ${err instanceof Error ? err.message : String(err)}`);
      warn('Falling back to short-lived token (expires in ~1 hour).');
      printShortLivedFallback(shortLived, flags.reveal, igAppSecret);
      process.exitCode = 1;
      return;
    }
    success(`Long-lived token obtained (expires_in: ${formatExpiresIn(longLived.expires_in)}).`);

    // ── 6. Verify with /me and capture user_id + username ──────────────────
    let username: string | undefined;
    let userIdFromMe: string | undefined;
    try {
      const me = await getInstagramUser(longLived.access_token, graphConfig);
      username = typeof me.username === 'string' ? me.username : undefined;
      userIdFromMe = typeof me.user_id === 'string' ? me.user_id : undefined;
    } catch (err) {
      warn(
        `Token verification (/me) failed: ${err instanceof Error ? err.message : String(err)}. ` +
          'Token was issued but /me lookup did not return the expected fields; using user_id from the OAuth response.'
      );
    }

    const userId = userIdFromMe ?? String(shortLived.user_id);

    // ── 7. Print summary ───────────────────────────────────────────────────
    divider('Captured Credentials');
    info(`INSTAGRAM_USER_ID=${userId}`);
    info(
      `INSTAGRAM_ACCESS_TOKEN=${flags.reveal ? longLived.access_token : maskToken(longLived.access_token)}`
    );
    if (username) info(`username: @${username}`);
    info(`expires_in: ${formatExpiresIn(longLived.expires_in)}`);
    if (!flags.reveal) {
      info('(Token masked. Re-run with --reveal to print the full value.)');
    }

    // ── 8. Optional .env append ────────────────────────────────────────────
    await maybeAppendToEnv({ userId, accessToken: longLived.access_token });

    success('Done. The long-lived token is valid for ~60 days; refresh before expiry.');
  } catch (err) {
    handleFatalError(err);
    process.exitCode = process.exitCode ?? 1;
  } finally {
    // Tear down in reverse order: server, tunnel, prompts. swallow errors so
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
 * `/auth/instagram/callback`. Resolves with the `code` from the query, or
 * rejects on error / timeout / state mismatch.
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
        finish(
          new OAuthCancelled(`User or Meta rejected the OAuth flow: ${detail}`)
        );
        return;
      }
      if (!verifyState(args.expectedState, receivedState)) {
        res.status(400).send(renderResultPage('error', 'State mismatch — possible CSRF / stale browser tab.'));
        finish(new Error('OAuth callback state mismatch. Re-run the script and use a fresh browser tab.'));
        return;
      }
      if (!code) {
        res.status(400).send(renderResultPage('error', 'No code in callback.'));
        finish(new Error('OAuth callback missing "code" query parameter.'));
        return;
      }
      // 200 with a friendly page; the developer can close the tab and watch
      // the rest of the flow in the terminal.
      res.status(200).send(
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
    // to Instagram, possibly through 2FA, then approve consent.
    const timer = setTimeout(() => {
      finish(new Error(`Timed out after ${Math.round(args.timeoutMs / 1000)}s waiting for OAuth callback.`));
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
  // Inline-styled so this works even when stripped through proxies / privacy
  // extensions. Kept intentionally minimal.
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
/* Token exchanges                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

async function exchangeCodeForShortLived(args: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
}): Promise<ShortLivedTokenResponse> {
  const body = buildShortLivedTokenBody(args);
  // We don't reuse `graphFetch` here because the code-exchange endpoint has
  // a slightly different error envelope ({error_type, code, error_message})
  // than the graph.facebook.com one, and lives on a DIFFERENT host. Inline
  // fetch + a tailored MetaApiError keeps both error shapes clean.
  let response: Response;
  try {
    response = await fetch(TOKEN_HOST, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new MetaApiError({
      operation: 'instagram_oauth_short_lived',
      httpStatus: 0,
      responseBody: cause,
      message: `Instagram OAuth code-exchange failed before response: ${cause}`
    });
  }

  const rawText = await response.text();
  const parsed = tryParseJson(rawText);

  if (!response.ok) {
    throw new MetaApiError({
      operation: 'instagram_oauth_short_lived',
      httpStatus: response.status,
      responseBody: parsed ?? rawText
    });
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new MetaApiError({
      operation: 'instagram_oauth_short_lived',
      httpStatus: response.status,
      responseBody: rawText,
      message: 'Instagram OAuth code-exchange returned a non-JSON body.'
    });
  }
  const obj = parsed as Record<string, unknown>;
  const accessToken = typeof obj['access_token'] === 'string' ? (obj['access_token'] as string) : undefined;
  const userId = typeof obj['user_id'] === 'number' ? (obj['user_id'] as number) : undefined;
  if (!accessToken || userId === undefined) {
    throw new MetaApiError({
      operation: 'instagram_oauth_short_lived',
      httpStatus: response.status,
      responseBody: parsed,
      message: 'Instagram OAuth response missing access_token or user_id.'
    });
  }
  return {
    access_token: accessToken,
    user_id: userId,
    permissions: Array.isArray(obj['permissions']) ? (obj['permissions'] as string[]) : undefined
  };
}

async function exchangeShortForLongLived(args: {
  clientSecret: string;
  shortLivedToken: string;
}): Promise<LongLivedTokenResponse> {
  const url = buildLongLivedTokenUrl(args);
  return graphFetch<LongLivedTokenResponse>(
    url,
    { method: 'GET' },
    'instagram_oauth_long_lived'
  );
}

function tryParseJson(raw: string): unknown {
  if (raw.length === 0) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* .env writing                                                               */
/* ────────────────────────────────────────────────────────────────────────── */

async function maybeAppendToEnv(args: { userId: string; accessToken: string }): Promise<void> {
  const envPath = path.resolve(process.cwd(), '.env');
  const exists = await fileExists(envPath);
  const yes = await confirm(
    exists ? 'Append INSTAGRAM_* to .env now?' : '.env not found in cwd — create it now?',
    false
  );
  if (!yes) {
    info('Skipped .env update. Copy the values above into your environment manually.');
    return;
  }

  // Guard: refuse to clobber existing INSTAGRAM_USER_ID or INSTAGRAM_ACCESS_TOKEN.
  // The `=\S` requirement skips empty placeholder lines (e.g. `INSTAGRAM_USER_ID=`
  // copied verbatim from .env.example) — those should not block a fresh capture.
  if (exists) {
    const existing = await readFile(envPath, 'utf8');
    if (hasExistingInstagramValue(existing)) {
      fail(
        'Existing non-empty INSTAGRAM_USER_ID or INSTAGRAM_ACCESS_TOKEN line found in .env. ' +
          'Remove or clear those lines manually to avoid clobbering existing values.'
      );
      return;
    }
  }

  // Ensure a trailing newline before our block so we don't merge lines.
  const block =
    (exists ? '\n' : '') +
    `# Instagram Business Login (captured ${new Date().toISOString()})\n` +
    `INSTAGRAM_USER_ID=${args.userId}\n` +
    `INSTAGRAM_ACCESS_TOKEN=${args.accessToken}\n`;
  await appendFile(envPath, block, 'utf8');
  success(`Wrote INSTAGRAM_USER_ID and INSTAGRAM_ACCESS_TOKEN to ${envPath}.`);
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
        'Hint: this usually means the redirect URI sent to /oauth/access_token does not ' +
          'EXACTLY match the one registered in the Meta App Dashboard (Instagram → Business ' +
          'Login → OAuth redirect URIs). Trailing slashes and http vs https matter.'
      );
    }
    process.exitCode = 1;
    return;
  }
  fail(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}

function printShortLivedFallback(
  short: ShortLivedTokenResponse,
  reveal: boolean,
  appSecret: string
): void {
  divider('Short-Lived Token (fallback)');
  info(`INSTAGRAM_USER_ID=${short.user_id}`);
  info(`access_token (1h): ${reveal ? short.access_token : maskToken(short.access_token)}`);
  info(
    'To exchange manually:\n  curl -s -G "https://graph.instagram.com/access_token" ' +
      `--data-urlencode "grant_type=ig_exchange_token" ` +
      `--data-urlencode "client_secret=${reveal ? appSecret : '<INSTAGRAM_APP_SECRET>'}" ` +
      `--data-urlencode "access_token=${reveal ? short.access_token : '<short_lived_token>'}"`
  );
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
