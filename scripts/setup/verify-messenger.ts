/**
 * Interactive end-to-end verification for the Messenger (Facebook Page) channel.
 *
 * Steps:
 *   1. Config check — Messenger credentials + Meta basics.
 *   2. Token validity — `GET /{pageId}?fields=name,id` confirms Page + token.
 *   3. Webhook subscription audit. Messenger CAN be subscribed programmatically
 *      (we call `registerAllWebhooks` in bootstrap); this step confirms the
 *      app-level `page` subscription is present and the per-Page
 *      `subscribed_apps` POST succeeded.
 *   4. Tester role reminder. Until the app is in Live mode, only people with a
 *      Tester / Admin / Developer role on the Meta App can DM the Page. This
 *      is the most common "I'm getting nothing" pitfall — can't fully automate
 *      it, so we prompt the developer to confirm.
 *   5. Inbound test — send a message to the Page from a personal account, wait
 *      for the webhook.
 *   6. Outbound reply (skippable) — POST `/{pageId}/messages` echoing back to
 *      `sender.id`. We trust Meta's 200 + `message_id` as the success signal
 *      and best-effort wait for a `message_echoes` webhook as extra evidence.
 *   7. Optional reaction capture.
 *   8. Summary.
 *
 * Exports `runMessengerVerify(ctx)` for verify-all.ts.
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
import type { CapturedWebhook } from '../lib/capture-server.js';
import { inspectExistingSubscriptions, SUBSCRIBED_FIELDS } from './register-webhooks.js';
import {
  buildGraphUrl,
  getMessengerPage,
  graphFetch,
  MetaApiError,
  type GraphConfig
} from '../lib/graph-api.js';
import { info, success, warn, fail, step, divider, confirm, closePrompts } from '../lib/console.js';

const SCRIPT_NAME = 'verify-messenger';

const REPLY_TEXT = 'Test reply from meta-ai-agent verify script.';

/* ────────────────────────────────────────────────────────────────────────── */
/* Public entrypoint reused by verify-all.ts                                  */
/* ────────────────────────────────────────────────────────────────────────── */

export async function runMessengerVerify(ctx: VerifyContext): Promise<ChannelVerifyResult> {
  const builder = new VerifyResultBuilder('messenger');
  divider('verify: Messenger');

  // ── Step 1: Config check ─────────────────────────────────────────────────
  step(1, 8, 'Config check');
  if (!ctx.config.messenger || !ctx.config.channels.messenger) {
    fail('MESSENGER_PAGE_ID / MESSENGER_PAGE_ACCESS_TOKEN missing.');
    builder.fail('config', 'Messenger credentials not configured in environment.');
    return builder.build();
  }
  success(`Configured. Page id: ${ctx.config.messenger.pageId}.`);
  builder.pass('config');

  const graphConfig: GraphConfig = { apiVersion: ctx.config.meta.graphApiVersion };

  // ── Step 2: Token validity ───────────────────────────────────────────────
  step(2, 8, 'Token validity (GET /{pageId})');
  let pageName: string | undefined;
  try {
    const page = await getMessengerPage(
      ctx.config.messenger.pageId,
      ctx.config.messenger.pageAccessToken,
      graphConfig
    );
    pageName = typeof page.name === 'string' ? page.name : undefined;
    success(`Page: ${page.name ?? '?'}  (id: ${page.id ?? '?'})`);
    builder.pass('token', `page=${page.name ?? '?'}`);
  } catch (err) {
    const detail = formatMetaError(err, 'get_messenger_page');
    fail(detail);
    builder.fail('token', detail);
    return builder.build();
  }

  // ── Step 3: Webhook subscription audit ───────────────────────────────────
  step(3, 8, 'Webhook subscription audit');
  try {
    const inspection = await inspectExistingSubscriptions({
      config: ctx.config,
      callbackUrl: ctx.callbackUrl,
      logger: ctx.logger
    });
    const pageSub = inspection.subscriptions.find((s) => s.object === 'page');
    if (!pageSub) {
      warn('No `page` subscription found. Run without --skip-webhook-registration to retry.');
      builder.fail('webhook', 'No page subscription in App settings.');
    } else if (pageSub.callback_url !== ctx.callbackUrl) {
      warn(`Subscription callback URL drift: dashboard=${pageSub.callback_url ?? '?'} expected=${ctx.callbackUrl}`);
      builder.fail(
        'webhook',
        `callback URL mismatch (dashboard=${pageSub.callback_url ?? '?'} expected=${ctx.callbackUrl}).`
      );
    } else {
      success(`page subscription points at ${ctx.callbackUrl}.`);
      info(`Subscribed fields: ${SUBSCRIBED_FIELDS.messenger.join(', ')}`);
      builder.pass('webhook');
    }
  } catch (err) {
    const detail = formatMetaError(err, 'inspect_subscriptions');
    fail(detail);
    builder.fail('webhook', detail);
  }

  // ── Step 4: Tester role reminder ─────────────────────────────────────────
  step(4, 8, 'Tester role reminder');
  // WHY this manual step: while the app is in Dev mode, ONLY people with a
  // Tester / Admin / Developer role on the Meta App can interact with the
  // Page over Messenger. We can't programmatically introspect app roles
  // from a setup script; the developer has to confirm.
  warn(
    'Until the app is in Live mode, ONLY personal Facebook accounts with a Tester/Admin/Developer role ' +
      'on the Meta App can DM the Page. Check App Dashboard → App Roles → Roles.'
  );
  let roleConfirmed = false;
  try {
    roleConfirmed = await confirm(
      'Confirmed: your personal Facebook account has a Tester/Admin/Developer role?',
      false
    );
  } catch {
    roleConfirmed = false;
  }
  if (roleConfirmed) {
    builder.pass('tester-role');
  } else {
    warn('Skipping the inbound + outbound tests would be safer until the role is set up.');
    builder.skip('tester-role', 'User did not confirm tester role; proceeding anyway.');
  }

  // ── Step 5: Inbound test ─────────────────────────────────────────────────
  step(5, 8, 'Inbound test (send a message to the Page)');
  const inboundPrompt = pageName
    ? `Open Messenger and send a text message to the Page "${pageName}" from your personal Facebook account.`
    : `Open Messenger and send a text message to the Page from your personal Facebook account.`;
  const inboundCap = await captureExpectedWebhook({
    capture: ctx.capture,
    channel: 'messenger',
    expect: (c) => isInboundTextMessage(c, 'messenger'),
    prompt: inboundPrompt,
    timeoutMs: 5 * 60 * 1000,
    saveAs: 'inbound-test-text.json'
  });
  let senderId: string | undefined;
  if (inboundCap) {
    const msg = inboundCap.parsed.messages.find((m) => m.channel === 'messenger' && m.type === 'text');
    senderId = msg?.channelScopedUserId;
    success(`Inbound text from PSID ${senderId ?? '?'}: "${truncate(msg?.text ?? '', 80)}"`);
    builder.pass('inbound', `from=${senderId ?? '?'} signatureValid=${inboundCap.signatureValid}`);
  } else {
    warn('No inbound webhook arrived within timeout.');
    builder.fail('inbound', 'No inbound text webhook within 5 minutes.');
  }

  // ── Step 6: Outbound reply ───────────────────────────────────────────────
  step(6, 8, 'Outbound reply (POST /{pageId}/messages)');
  if (ctx.cli.skipOutbound) {
    info('Skipped (--skip-outbound).');
    builder.skip('outbound', 'Skipped via --skip-outbound flag.');
  } else if (!senderId) {
    warn('No inbound captured — cannot derive recipient PSID for reply.');
    builder.skip('outbound', 'No PSID available (inbound step did not capture).');
  } else {
    try {
      info(`Sending reply to PSID ${senderId}…`);
      const res = await sendMessengerTextReply({
        pageId: ctx.config.messenger.pageId,
        pageAccessToken: ctx.config.messenger.pageAccessToken,
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
        // Best-effort secondary signal: wait briefly for the `message_echoes`
        // webhook that mirrors our outbound back. Subscription propagation can
        // take a few minutes after a fresh subscribed_apps call, so timing out
        // is informational — never fails the step.
        await waitForEchoBestEffort(ctx.capture, 'messenger', mid);
      } else {
        warn('POST returned 200 but no message_id — treating outbound as skipped.');
        builder.skip('outbound', 'POST returned 200 but no message_id was present.');
      }
    } catch (err) {
      const detail = formatMetaError(err, 'send_messenger_reply');
      fail(detail);
      builder.fail('outbound', detail);
    }
  }

  // ── Step 7: Optional reaction capture ────────────────────────────────────
  step(7, 8, 'Optional: capture a reaction webhook');
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
      channel: 'messenger',
      expect: (c) => isInboundReaction(c, 'messenger'),
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

  // ── Step 8: Summary marker (no real action — summary printed by caller) ─
  step(8, 8, 'Summary');
  info(`${builder.channel}: ${builder.build().ok ? 'OK so far' : 'FAILED — see steps above'}`);

  return builder.build();
}

/**
 * Best-effort wait for the `message_echoes` webhook that mirrors a just-sent
 * outbound back to us. Logs success or a benign timeout note; never fails the
 * outbound step. The echo subscription can take a few minutes to propagate
 * after a fresh `subscribed_apps` POST, so absence does not imply a problem.
 */
async function waitForEchoBestEffort(
  capture: VerifyContext['capture'],
  channel: 'messenger' | 'instagram',
  mid: string
): Promise<void> {
  const isEchoFor = (m: string) => (cap: CapturedWebhook): boolean =>
    cap.parsed.messages.some(
      (msg) => msg.isEcho === true && msg.channelMessageId === m
    );
  const cap = await captureExpectedWebhook({
    capture,
    channel,
    expect: isEchoFor(mid),
    prompt: 'Waiting briefly for the message_echoes webhook (best-effort)…',
    description: 'waiting for message_echoes webhook (best-effort)',
    timeoutMs: 30 * 1000
  });
  if (cap) {
    success(`Echo confirmed: ${mid}`);
  } else {
    info('note: no echo received within 30s — not necessarily a problem.');
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Internal helpers                                                           */
/* ────────────────────────────────────────────────────────────────────────── */

interface SendMessengerReplyArgs {
  pageId: string;
  pageAccessToken: string;
  recipientId: string;
  text: string;
  config: GraphConfig;
}

interface SendMessengerReplyResponse {
  recipient_id?: string;
  message_id?: string;
  [key: string]: unknown;
}

/**
 * Send a plain-text reply via `/{pageId}/messages` with `messaging_type=RESPONSE`.
 * RESPONSE is the right type for replying to a user-initiated thread within
 * the 24h messaging window; UPDATE / MESSAGE_TAG variants exist but require
 * additional permissions.
 *
 * WHY Authorization header (not `?access_token=`): proxies and CDNs
 * commonly log query strings, which would leak the Page Access Token.
 * The header form is the documented alternative and omitted from typical
 * access-log formats.
 */
async function sendMessengerTextReply(args: SendMessengerReplyArgs): Promise<SendMessengerReplyResponse> {
  const url = buildGraphUrl(
    `${args.pageId}/messages`,
    {},
    args.config
  );
  const body = {
    recipient: { id: args.recipientId },
    message: { text: args.text },
    messaging_type: 'RESPONSE'
  };
  return graphFetch<SendMessengerReplyResponse>(
    url,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${args.pageAccessToken}`
      },
      body: JSON.stringify(body)
    },
    'send_messenger_text_reply'
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

  divider('meta-ai-agent: verify Messenger');

  const logger = pino({
    level: process.env['LOG_LEVEL'] ?? 'info',
    transport: process.stdout.isTTY
      ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' } }
      : undefined
  });

  let ctx: VerifyContext;
  try {
    ctx = await bootstrapVerifyContext({ channel: 'messenger', cli, logger });
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
    result = await runMessengerVerify(ctx);
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
