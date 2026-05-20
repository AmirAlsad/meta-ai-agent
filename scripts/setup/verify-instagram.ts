/**
 * Interactive end-to-end verification for the Instagram (Business Login) channel.
 *
 * Steps:
 *   1. Config check. If INSTAGRAM_USER_ID / INSTAGRAM_ACCESS_TOKEN missing,
 *      direct the developer to run `npm run setup:oauth:instagram` first
 *      (we DO NOT invoke the OAuth script in-process — see WHY below).
 *   2. Token validity — `GET /me` against graph.instagram.com.
 *   3. Webhook subscription audit (`object: 'instagram'`).
 *   4. "Allow access to messages" reminder — the silent killer.
 *   5. Inbound test — send a DM from a personal IG to @{username}.
 *   6. Outbound reply — POST `graph.instagram.com/{userId}/messages`. Meta's
 *      200 + `message_id` is the authoritative success signal; we also
 *      best-effort wait for the `message_echoes` webhook as extra evidence.
 *   7. Optional reaction capture.
 *   8. Summary.
 *
 * Exports `runInstagramVerify(ctx)` for verify-all.ts.
 *
 * WHY IG OAuth must run separately (not invoked from this script): the OAuth
 * flow needs its OWN ngrok tunnel (the redirect_uri MUST be registered in
 * the Dashboard byte-for-byte; using a different tunnel URL than the verify
 * harness avoids constant Dashboard re-registration), its own Express server
 * (to receive the OAuth callback at /auth/instagram/callback), and an
 * interactive consent-screen flow. Hosting OAuth in-process with verify
 * would mean the verify script holds two tunnels open and races on stdin
 * during consent. The cleaner contract: OAuth is a one-time setup step,
 * captures tokens to .env, then the verify script reads them.
 *
 * WHY the "Allow access to messages" reminder exists as its own step: this
 * is the #1 silent killer on Instagram. When the Instagram account has
 * "Allow access to messages" OFF (under Settings → Messages and story
 * replies → Message controls), Meta accepts the webhook subscription and
 * returns 200 on all setup calls, but no webhooks ever fire. There is no
 * error. Surfacing this as an interactive checklist item saves hours of
 * "is my webhook subscription broken?" debugging.
 */

import 'dotenv/config';
import path from 'node:path';
import pino from 'pino';

import {
  bootstrapVerifyContext,
  captureExpectedWebhook,
  isInboundReaction,
  isInboundTextMessage,
  parseVerifyArgs,
  printVerifyHelp,
  printVerifySummary,
  VerifyBootstrapError,
  VerifyResultBuilder,
  type ChannelVerifyResult,
  type ParsedArgs,
  type VerifyContext
} from './verify-shared.js';
import { SUBSCRIBED_FIELDS } from './register-webhooks.js';
import {
  buildInstagramGraphUrl,
  getInstagramSubscribedApps,
  getInstagramUser,
  graphFetch,
  MetaApiError,
  type GraphConfig
} from '../lib/graph-api.js';
import { info, success, warn, fail, step, divider, confirm, closePrompts } from '../lib/console.js';

const SCRIPT_NAME = 'verify-instagram';

const REPLY_TEXT = 'Test reply from meta-ai-agent verify script.';

/* ────────────────────────────────────────────────────────────────────────── */
/* Public entrypoint reused by verify-all.ts                                  */
/* ────────────────────────────────────────────────────────────────────────── */

export async function runInstagramVerify(ctx: VerifyContext): Promise<ChannelVerifyResult> {
  const builder = new VerifyResultBuilder('instagram');
  divider('verify: Instagram');

  // ── Step 1: Config check ─────────────────────────────────────────────────
  step(1, 9, 'Config check');
  if (!ctx.config.instagram || !ctx.config.channels.instagram) {
    fail('INSTAGRAM_USER_ID / INSTAGRAM_ACCESS_TOKEN missing.');
    info('Run `npm run setup:oauth:instagram` first to capture a long-lived (~60d) Instagram User Access Token.');
    info('That script handles the OAuth code → short-lived → long-lived exchange and writes the credentials to .env.');
    builder.fail('config', 'Instagram credentials missing — run setup:oauth:instagram first.');
    return builder.build();
  }
  success(`Configured. User id: ${ctx.config.instagram.userId}.`);
  builder.pass('config');

  const graphConfig: GraphConfig = { apiVersion: ctx.config.meta.graphApiVersion };

  // ── Step 2: Token validity ───────────────────────────────────────────────
  step(2, 9, 'Token validity (GET https://graph.instagram.com/me)');
  let username: string | undefined;
  try {
    const me = await getInstagramUser(ctx.config.instagram.accessToken, graphConfig);
    username = typeof me.username === 'string' ? me.username : undefined;
    success(`User: @${username ?? '?'}  (user_id: ${me.user_id ?? '?'})`);
    builder.pass('token', `username=@${username ?? '?'}`);
  } catch (err) {
    const detail = formatMetaError(err, 'get_instagram_user');
    fail(detail);
    info('If this is a 401, the long-lived token may have expired (~60 day lifetime) — re-run setup:oauth:instagram.');
    builder.fail('token', detail);
    return builder.build();
  }

  // ── Step 3: Webhook subscription audit ───────────────────────────────────
  // WHY this checks the PER-USER endpoint, not app-level /{appId}/subscriptions:
  // Instagram subscriptions are attached to the IG user via
  // `graph.instagram.com/{userId}/subscribed_apps`, NOT the app-level
  // subscription list that WhatsApp/Messenger use. Auditing IG through the
  // app-level path always reports "not found" even when the subscription is
  // live (it produced a working inbound webhook). The per-user GET is the
  // correct source of truth. There is no callback_url in this response — the
  // callback is app-level Dashboard config, and its correctness is proven
  // implicitly when step 6's inbound test actually receives a webhook.
  step(3, 9, 'Webhook subscription audit');
  try {
    const ig = ctx.config.instagram;
    if (!ig) {
      builder.fail('webhook', 'Instagram channel not configured.');
    } else {
      const graphConfig: GraphConfig = { apiVersion: ctx.config.meta.graphApiVersion };
      const apps = await getInstagramSubscribedApps(ig.userId, ig.accessToken, graphConfig);
      if (apps.length === 0) {
        warn('No app subscribed to this IG user. Run without --skip-webhook-registration to retry.');
        builder.fail('webhook', 'No per-user Instagram subscription found.');
      } else {
        const fields = apps[0]?.subscribed_fields ?? [];
        success(`Instagram per-user subscription active (${apps.length} app(s) subscribed).`);
        info(
          `Subscribed fields: ${fields.length > 0 ? fields.join(', ') : SUBSCRIBED_FIELDS.instagram.join(', ')}`
        );
        builder.pass('webhook');
      }
    }
  } catch (err) {
    const detail = formatMetaError(err, 'get_instagram_subscribed_apps');
    fail(detail);
    builder.fail('webhook', detail);
  }

  // ── Step 4: "Allow access to messages" reminder ──────────────────────────
  step(4, 9, '"Allow access to messages" check (silent killer)');
  // WHY this manual checklist item: see file-level WHY-comment. There's no
  // API surface to read this setting — it lives in the IG mobile app's
  // privacy controls. Without it ON, no webhooks fire and there is NO
  // error to surface.
  warn(
    'On the official IG account\'s mobile app: Settings → Messages and story replies → ' +
      'Message controls → verify "Allow access to messages" is ON. ' +
      'When this is OFF, Meta accepts the subscription and ACKs 200 on all setup calls but NO webhook ever fires.'
  );
  let allowAccessConfirmed = false;
  try {
    allowAccessConfirmed = await confirm(
      'Confirmed: "Allow access to messages" is ON for the official IG account?',
      false
    );
  } catch {
    allowAccessConfirmed = false;
  }
  if (allowAccessConfirmed) {
    builder.pass('allow-access');
  } else {
    warn('Without this turned ON, the inbound test below will time out.');
    builder.skip('allow-access', 'User did not confirm "Allow access to messages" is ON.');
  }

  // ── Step 5: Instagram Tester registration reminder ───────────────────────
  // WHY: in Development mode, Instagram only fires messaging webhooks for DMs
  // sent from accounts registered as Instagram Testers on the Meta App — the
  // same Development-mode gate Messenger has, but Instagram keeps a SEPARATE
  // tester list (App Roles → Roles → Instagram Testers) distinct from the
  // Facebook app roles. Empirically (2026-05-20) BOTH the business account
  // AND the personal account sending the test DM must appear as accepted
  // Instagram Testers, or the inbound webhook silently never arrives (no error).
  // Critical gotcha: the tester INVITE can only be ACCEPTED on the web
  // (accountscenter.instagram.com / instagram.com account settings) — the
  // mobile app does not surface the invite-acceptance screen.
  step(5, 9, 'Instagram Tester registration check');
  warn(
    'In Development mode, Instagram only delivers webhooks for DMs from registered ' +
      'Instagram Testers. Add BOTH the business account (@' + (username ?? 'your_business') + ') ' +
      'AND the personal account you will DM from, under App Dashboard → App Roles → Roles → ' +
      'Instagram Testers.'
  );
  warn(
    'Accept each tester invite ON THE WEB (instagram.com → Settings → Apps and websites → ' +
      'Tester invites). The Instagram MOBILE app does NOT show the invite-acceptance screen.'
  );
  let testersConfirmed = false;
  try {
    testersConfirmed = await confirm(
      'Confirmed: both accounts are accepted Instagram Testers (checked on web)?',
      false
    );
  } catch {
    testersConfirmed = false;
  }
  if (testersConfirmed) {
    builder.pass('instagram-testers');
  } else {
    warn('Without both accounts registered + accepted as Instagram Testers, the inbound test will time out.');
    builder.skip('instagram-testers', 'User did not confirm Instagram Tester registration.');
  }

  // ── Step 6: Inbound test ─────────────────────────────────────────────────
  step(6, 9, 'Inbound test (send a DM to the business account)');
  const inboundPrompt = username
    ? `Send a DM from your PERSONAL Instagram account (not the business one) to @${username} now.`
    : `Send a DM from your PERSONAL Instagram account (not the business one) to the business account now.`;
  const inboundCap = await captureExpectedWebhook({
    capture: ctx.capture,
    channel: 'instagram',
    expect: (c) => isInboundTextMessage(c, 'instagram'),
    prompt: inboundPrompt,
    timeoutMs: 5 * 60 * 1000,
    saveAs: 'inbound-test-dm.json'
  });
  let senderId: string | undefined;
  if (inboundCap) {
    const msg = inboundCap.parsed.messages.find((m) => m.channel === 'instagram' && m.type === 'text');
    senderId = msg?.channelScopedUserId;
    success(`Inbound DM from IGSID ${senderId ?? '?'}: "${truncate(msg?.text ?? '', 80)}"`);
    builder.pass('inbound', `from=${senderId ?? '?'} signatureValid=${inboundCap.signatureValid}`);
  } else {
    warn('No inbound webhook arrived within timeout.');
    info('If you confirmed "Allow access to messages" above, the most common cause is a missing IG app permission.');
    builder.fail('inbound', 'No inbound DM webhook within 5 minutes.');
  }

  // ── Step 6: Outbound reply ───────────────────────────────────────────────
  step(7, 9, 'Outbound reply (POST graph.instagram.com/{userId}/messages)');
  if (ctx.cli.skipOutbound) {
    info('Skipped (--skip-outbound).');
    builder.skip('outbound', 'Skipped via --skip-outbound flag.');
  } else if (!senderId) {
    warn('No inbound captured — cannot derive recipient IGSID for reply.');
    builder.skip('outbound', 'No IGSID available (inbound step did not capture).');
  } else {
    try {
      info(`Sending reply to IGSID ${senderId}…`);
      const res = await sendInstagramTextReply({
        userId: ctx.config.instagram.userId,
        accessToken: ctx.config.instagram.accessToken,
        recipientId: senderId,
        text: REPLY_TEXT,
        config: graphConfig
      });
      const mid = res.message_id;
      success(`Reply POST accepted (mid: ${mid ?? '?'}).`);
      // WHY trust the API response over a human confirm: Meta's 200 + `message_id`
      // is the authoritative success signal. The previous "Did the reply arrive?"
      // prompt produced false negatives when stdin handling raced the spinner —
      // the script reported FAIL on outbound deliveries that actually succeeded.
      // If `message_id` is missing despite a 200 there's nothing to assert on,
      // so fall back to a skip.
      if (mid) {
        builder.pass('outbound', `mid=${mid}`);
        // NOTE: unlike Messenger, Instagram has NO `message_echoes` webhook
        // field (verified against the live API 2026-05-20 — it's rejected from
        // the IG subscribed_fields set). So there's no echo to wait for; the
        // Send API's 200 + message_id is the only outbound confirmation
        // available on Instagram. (Messenger's verify keeps its echo wait.)
      } else {
        warn('POST returned 200 but no message_id — treating outbound as skipped.');
        builder.skip('outbound', 'POST returned 200 but no message_id was present.');
      }
    } catch (err) {
      const detail = formatMetaError(err, 'send_instagram_reply');
      fail(detail);
      builder.fail('outbound', detail);
    }
  }

  // ── Step 7: Optional reaction capture ────────────────────────────────────
  step(8, 9, 'Optional: capture a reaction webhook');
  let captureReaction = false;
  try {
    captureReaction = await confirm('React to the most recent bot/business message with an emoji?', false);
  } catch {
    // Confirm aborts (Ctrl-D on the prompt) — treat as a skip.
    captureReaction = false;
  }
  if (!captureReaction) {
    info('Skipping reaction capture.');
    builder.skip('reaction', 'User opted out.');
  } else {
    const reactionCap = await captureExpectedWebhook({
      capture: ctx.capture,
      channel: 'instagram',
      expect: (c) => isInboundReaction(c, 'instagram'),
      prompt: 'Now react to a recent message and we will capture the webhook.',
      timeoutMs: 2 * 60 * 1000,
      saveAs: 'inbound-reaction.json'
    });
    if (reactionCap) {
      success('Captured reaction webhook.');
      builder.pass('reaction');
    } else {
      warn('No reaction webhook within 2 minutes.');
      builder.skip('reaction', 'No reaction webhook within timeout.');
    }
  }

  // ── Step 8: Summary marker ───────────────────────────────────────────────
  step(9, 9, 'Summary');
  info(`${builder.channel}: ${builder.build().ok ? 'OK so far' : 'FAILED — see steps above'}`);

  return builder.build();
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Internal helpers                                                           */
/* ────────────────────────────────────────────────────────────────────────── */

interface SendInstagramReplyArgs {
  userId: string;
  accessToken: string;
  recipientId: string;
  text: string;
  config: GraphConfig;
}

interface SendInstagramReplyResponse {
  recipient_id?: string;
  message_id?: string;
  [key: string]: unknown;
}

/**
 * Send a plain-text reply via `graph.instagram.com/{userId}/messages`. This
 * endpoint is on the Instagram Graph host (NOT graph.facebook.com); using
 * {@link buildInstagramGraphUrl} ensures the right base URL.
 *
 * WHY Authorization header (not `?access_token=`): proxies and CDNs
 * commonly log query strings, which would leak the IG User Access Token.
 * The header form is the documented alternative and omitted from typical
 * access-log formats.
 */
async function sendInstagramTextReply(args: SendInstagramReplyArgs): Promise<SendInstagramReplyResponse> {
  const url = buildInstagramGraphUrl(
    `${args.userId}/messages`,
    {},
    args.config
  );
  const body = {
    recipient: { id: args.recipientId },
    message: { text: args.text }
  };
  return graphFetch<SendInstagramReplyResponse>(
    url,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${args.accessToken}`
      },
      body: JSON.stringify(body)
    },
    'send_instagram_text_reply'
  );
}

function formatMetaError(err: unknown, operation: string): string {
  if (err instanceof MetaApiError) {
    const parts: string[] = [`HTTP ${err.httpStatus}`];
    if (err.errorCode !== undefined) parts.push(`code ${err.errorCode}`);
    if (err.errorSubCode !== undefined) parts.push(`subcode ${err.errorSubCode}`);
    if (err.fbtraceId) parts.push(`fbtrace_id ${err.fbtraceId}`);
    return `${operation} failed: ${parts.join(', ')} — ${err.message}`;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return `${operation} failed: ${msg}`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* CLI entry point                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  let cli: ParsedArgs;
  try {
    cli = parseVerifyArgs(process.argv.slice(2));
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    process.exitCode = 2;
    return;
  }

  if (cli.help) {
    printVerifyHelp(SCRIPT_NAME);
    return;
  }

  divider('meta-ai-agent: verify Instagram');

  const logger = pino({
    level: process.env['LOG_LEVEL'] ?? 'info',
    transport: process.stdout.isTTY
      ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' } }
      : undefined
  });

  let ctx: VerifyContext;
  try {
    ctx = await bootstrapVerifyContext({ channel: 'instagram', cli, logger });
  } catch (err) {
    if (err instanceof VerifyBootstrapError) {
      process.exitCode = 1;
      return;
    }
    fail(`Unexpected bootstrap error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  let result: ChannelVerifyResult;
  try {
    result = await runInstagramVerify(ctx);
  } catch (err) {
    fail(`Unexpected verify error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  } finally {
    await ctx.capture.close().catch(() => undefined);
    closePrompts();
  }

  printVerifySummary([result]);
  process.exitCode = result.ok ? 0 : 1;
}

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
  main().catch((err) => {
    fail(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = process.exitCode ?? 1;
  });
}
