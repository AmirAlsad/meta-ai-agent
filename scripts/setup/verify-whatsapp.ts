/**
 * Interactive end-to-end verification for the WhatsApp channel.
 *
 * Walks the developer through:
 *   1. Config check — required env vars present + `channels.whatsapp = true`.
 *   2. Token validity — `GET /{phoneNumberId}` confirms the access token works.
 *   3. Webhook subscription audit. WhatsApp webhook configuration is partially
 *      restricted (see WHY-comment below); we surface the Dashboard values to
 *      paste and run `inspectExistingSubscriptions` to confirm the app-level
 *      subscription is in place.
 *   4. Outbound test (skippable) — send the `hello_world` template message
 *      to `E2E_TEST_WHATSAPP_NUMBER`, wait for a `sent`/`delivered` webhook.
 *   5. Inbound test — prompt the developer to send a real text from their
 *      personal WhatsApp to the business number. Wait for the webhook.
 *   6. Optional reaction capture.
 *   7. Summary table.
 *
 * Both `main()` (for `npm run setup:whatsapp`) and `runWhatsAppVerify(ctx)`
 * (for `verify-all.ts`) are exported. `runWhatsAppVerify` returns a
 * {@link ChannelVerifyResult} and never throws — bootstrap errors are the
 * caller's responsibility, channel-specific failures populate the result.
 *
 * WHY WhatsApp webhook config needs Dashboard interaction (used in the step
 * messaging): Meta's `/{appId}/subscriptions` POST for
 * `object: 'whatsapp_business_account'` is partially programmatic, but the
 * initial product setup (Webhooks → Add Subscription → product=WhatsApp)
 * must be done in the App Dashboard. After that one-time step, our
 * programmatic POST upserts the callback URL + verify token. We surface the
 * exact paste-in values whenever the audit shows the subscription is missing.
 */

import 'dotenv/config';
import path from 'node:path';
import pino from 'pino';

import {
  bootstrapVerifyContext,
  captureExpectedWebhook,
  isInboundReaction,
  isInboundTextMessage,
  isOutboundStatus,
  parseVerifyArgs,
  printVerifyHelp,
  printVerifySummary,
  VerifyBootstrapError,
  VerifyResultBuilder,
  type ChannelVerifyResult,
  type ParsedArgs,
  type VerifyContext
} from './verify-shared.js';
import {
  inspectExistingSubscriptions,
  SUBSCRIBED_FIELDS
} from './register-webhooks.js';
import {
  buildGraphUrl,
  getWhatsAppPhoneNumber,
  graphFetch,
  MetaApiError,
  type GraphConfig
} from '../lib/graph-api.js';
import { info, success, warn, fail, step, divider, confirm, closePrompts } from '../lib/console.js';

const SCRIPT_NAME = 'verify-whatsapp';

/* ────────────────────────────────────────────────────────────────────────── */
/* Public entrypoint reused by verify-all.ts                                  */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Channel-specific verifier. Idempotent — running it twice in a row should
 * produce the same result. Never throws (uses a try/catch around every step
 * so a single failure doesn't shadow downstream check results).
 */
export async function runWhatsAppVerify(ctx: VerifyContext): Promise<ChannelVerifyResult> {
  const builder = new VerifyResultBuilder('whatsapp');
  divider('verify: WhatsApp');

  // ── Step 1: Config check ─────────────────────────────────────────────────
  step(1, 6, 'Config check');
  if (!ctx.config.whatsapp || !ctx.config.channels.whatsapp) {
    fail('WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN missing.');
    builder.fail('config', 'WhatsApp credentials not configured in environment.');
    return builder.build();
  }
  if (!ctx.config.meta.appSecret || !ctx.config.meta.verifyToken) {
    fail('META_APP_SECRET / META_VERIFY_TOKEN missing.');
    builder.fail('config', 'Meta app credentials missing.');
    return builder.build();
  }
  success(`Configured. Phone number id: ${ctx.config.whatsapp.phoneNumberId}.`);
  builder.pass('config');

  const graphConfig: GraphConfig = { apiVersion: ctx.config.meta.graphApiVersion };

  // ── Step 2: Token validity ───────────────────────────────────────────────
  step(2, 6, 'Token validity (GET /{phone_number_id})');
  let displayPhone: string | undefined;
  try {
    const phone = await getWhatsAppPhoneNumber(
      ctx.config.whatsapp.phoneNumberId,
      ctx.config.whatsapp.accessToken,
      graphConfig
    );
    displayPhone = typeof phone.display_phone_number === 'string' ? phone.display_phone_number : undefined;
    success(
      `Phone: ${phone.display_phone_number ?? '?'}  Name: ${phone.verified_name ?? '?'}  Quality: ${phone.quality_rating ?? '?'}`
    );
    builder.pass('token', `display_phone_number=${phone.display_phone_number ?? '?'}`);
  } catch (err) {
    const detail = formatMetaError(err, 'get_whatsapp_phone_number');
    fail(detail);
    builder.fail('token', detail);
    // No point continuing — every downstream step needs a valid token.
    return builder.build();
  }

  // ── Step 3: Webhook subscription audit ───────────────────────────────────
  step(3, 6, 'Webhook subscription audit');
  info(`Expected callback URL: ${ctx.callbackUrl}`);
  info(`Expected verify token: ${ctx.config.meta.verifyToken}`);
  info(`Expected fields: ${SUBSCRIBED_FIELDS.whatsapp.join(', ')}`);
  try {
    const inspection = await inspectExistingSubscriptions({
      config: ctx.config,
      callbackUrl: ctx.callbackUrl,
      logger: ctx.logger
    });
    const wabaSub = inspection.subscriptions.find((s) => s.object === 'whatsapp_business_account');
    if (!wabaSub) {
      warn('No `whatsapp_business_account` subscription found.');
      // WHY this manual hint: see file-level WHY-comment. We can't fully
      // automate the initial Dashboard add-subscription step, so we coach
      // the developer through it.
      warn(
        'Open App Dashboard → WhatsApp → Configuration → Webhook, click ' +
          `"Configure" and paste the callback URL + verify token shown above. ` +
          `Subscribe to fields: ${SUBSCRIBED_FIELDS.whatsapp.join(', ')}.`
      );
      builder.fail('webhook', 'No whatsapp_business_account subscription in App settings.');
    } else if (wabaSub.callback_url !== ctx.callbackUrl) {
      warn(`Subscription callback URL drift: dashboard=${wabaSub.callback_url ?? '?'} expected=${ctx.callbackUrl}`);
      warn('Update the callback URL in the Dashboard, or pass --ngrok-domain=<stable> next run.');
      builder.fail(
        'webhook',
        `callback URL mismatch (dashboard=${wabaSub.callback_url ?? '?'} expected=${ctx.callbackUrl}).`
      );
    } else {
      success('whatsapp_business_account subscription is active and points at this tunnel.');
      builder.pass('webhook');
    }
  } catch (err) {
    const detail = formatMetaError(err, 'inspect_subscriptions');
    fail(detail);
    builder.fail('webhook', detail);
  }

  // ── Step 4: Outbound test ────────────────────────────────────────────────
  step(4, 6, 'Outbound test (hello_world template)');
  const testNumber = trimEnv(process.env['E2E_TEST_WHATSAPP_NUMBER']);
  if (ctx.cli.skipOutbound) {
    info('Skipped (--skip-outbound).');
    builder.skip('outbound', 'Skipped via --skip-outbound flag.');
  } else if (!testNumber) {
    info('E2E_TEST_WHATSAPP_NUMBER not set — skipping outbound smoke test.');
    builder.skip('outbound', 'E2E_TEST_WHATSAPP_NUMBER not set.');
  } else {
    try {
      // Best-effort send: a failure here might mean the template isn't approved
      // for this account; we surface the Meta error rather than swallowing it.
      info(`Sending hello_world template to ${testNumber} (E.164 without "+")…`);
      const sendResult = await sendHelloWorldTemplate({
        phoneNumberId: ctx.config.whatsapp.phoneNumberId,
        accessToken: ctx.config.whatsapp.accessToken,
        to: testNumber,
        config: graphConfig
      });
      const sentMessageId = extractMessageId(sendResult);
      success(`Template POST accepted (wamid: ${sentMessageId ?? '?'}). Waiting for delivery status webhook…`);
      const cap = await captureExpectedWebhook({
        capture: ctx.capture,
        channel: 'whatsapp',
        expect: (c) => isOutboundStatus(c, 'whatsapp'),
        prompt: 'Watching for the outbound status webhook from Meta…',
        timeoutMs: 2 * 60 * 1000,
        saveAs: 'outbound-test-template.json'
      });
      if (cap) {
        const status = cap.parsed.statuses[0]?.status ?? '?';
        success(`Received status: ${status}`);
        builder.pass('outbound', `status=${status} (wamid=${sentMessageId ?? '?'}).`);
      } else {
        warn('No outbound status webhook arrived within timeout.');
        builder.fail('outbound', 'Outbound status webhook did not arrive within 2 minutes.');
      }
    } catch (err) {
      const detail = formatMetaError(err, 'send_template');
      fail(detail);
      builder.fail('outbound', detail);
    }
  }

  // ── Step 5: Inbound test ─────────────────────────────────────────────────
  step(5, 6, 'Inbound test (send a text from your personal WhatsApp)');
  const inboundPrompt = displayPhone
    ? `Send a text message from your personal WhatsApp to ${displayPhone} now.`
    : `Send a text message from your personal WhatsApp to the business number now.`;
  const inboundCap = await captureExpectedWebhook({
    capture: ctx.capture,
    channel: 'whatsapp',
    expect: (c) => isInboundTextMessage(c, 'whatsapp'),
    prompt: inboundPrompt,
    timeoutMs: 5 * 60 * 1000,
    saveAs: 'inbound-test-text.json'
  });
  if (inboundCap) {
    const msg = inboundCap.parsed.messages.find((m) => m.channel === 'whatsapp' && m.type === 'text');
    success(`Inbound text from ${msg?.channelScopedUserId ?? '?'}: "${truncate(msg?.text ?? '', 80)}"`);
    builder.pass('inbound', `from=${msg?.channelScopedUserId ?? '?'} signatureValid=${inboundCap.signatureValid}`);
  } else {
    warn('No inbound text webhook arrived within timeout.');
    builder.fail('inbound', 'No inbound text webhook within 5 minutes.');
  }

  // ── Step 6: Optional reaction capture ────────────────────────────────────
  step(6, 6, 'Optional: capture a reaction webhook');
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
      channel: 'whatsapp',
      expect: (c) => isInboundReaction(c, 'whatsapp'),
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

  return builder.build();
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Internal helpers                                                           */
/* ────────────────────────────────────────────────────────────────────────── */

interface SendTemplateArgs {
  phoneNumberId: string;
  accessToken: string;
  to: string;
  config: GraphConfig;
}

interface SendTemplateResponse {
  messaging_product?: string;
  contacts?: Array<{ input?: string; wa_id?: string }>;
  messages?: Array<{ id?: string; message_status?: string }>;
}

/**
 * Send the `hello_world` template — a Meta-approved global template available
 * to every WhatsApp Business Account, so this works without custom template
 * approval. Body is JSON; access token in an Authorization: Bearer header.
 *
 * WHY Authorization header (not `?access_token=`): proxies and CDNs commonly
 * log query strings in access logs, which would leak the System User token.
 * The Authorization header is omitted from typical access-log formats and
 * is the documented Meta-supported alternative. GET introspection calls
 * still pass the token in the query (lower risk + would break the existing
 * tests); outbound POSTs use the header path.
 */
async function sendHelloWorldTemplate(args: SendTemplateArgs): Promise<SendTemplateResponse> {
  const url = buildGraphUrl(
    `${args.phoneNumberId}/messages`,
    {},
    args.config
  );
  const body = {
    messaging_product: 'whatsapp',
    to: args.to,
    type: 'template',
    template: {
      name: 'hello_world',
      language: { code: 'en_US' }
    }
  };
  return graphFetch<SendTemplateResponse>(
    url,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${args.accessToken}`
      },
      body: JSON.stringify(body)
    },
    'send_whatsapp_hello_world_template'
  );
}

function extractMessageId(res: SendTemplateResponse): string | undefined {
  return res.messages?.[0]?.id;
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

function trimEnv(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
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

  divider('meta-ai-agent: verify WhatsApp');

  const logger = pino({
    level: process.env['LOG_LEVEL'] ?? 'info',
    transport: process.stdout.isTTY
      ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' } }
      : undefined
  });

  let ctx: VerifyContext;
  try {
    ctx = await bootstrapVerifyContext({ channel: 'whatsapp', cli, logger });
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
    result = await runWhatsAppVerify(ctx);
  } catch (err) {
    // runWhatsAppVerify should never throw, but if a bug slips through we want
    // a clean console line rather than an unhandled rejection.
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

// Detect "run as script" — see the convention in oauth-instagram.ts / register-webhooks.ts.
// Resolves both `argv[1]` and `import.meta.url` to absolute paths so a
// `node --import tsx scripts/setup/verify-whatsapp.ts` invocation matches
// regardless of relative-path quirks.
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
