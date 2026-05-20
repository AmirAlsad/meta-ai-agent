/**
 * Stage 3 — programmatic webhook registration.
 *
 * Composes the helpers from {@link ../lib/graph-api} to subscribe the Meta
 * App to webhook events for every configured channel. Designed to be:
 *  - reusable as a library (verify scripts import {@link registerAllWebhooks}
 *    and {@link inspectExistingSubscriptions}), and
 *  - runnable standalone via `npm run meta:webhooks`.
 *
 * Per-channel ergonomics:
 *  - WhatsApp: there is no per-WABA "subscribe app" endpoint usable from a
 *    setup script on the current Graph API — the per-phone-number
 *    `/subscribed_apps` POST behaves differently from Messenger's. We only call
 *    {@link setWebhookSubscriptionConfig} for `whatsapp_business_account`
 *    against `/{appId}/subscriptions` (app-level). Dashboard step is
 *    surfaced as `manual_required` with a remediation hint.
 *  - Messenger: app-level subscription config + per-page `subscribed_apps`
 *    POST so the app actually receives the Page's events.
 *  - Instagram: app-level config + per-IG-user `subscribed_apps` POST on
 *    `graph.instagram.com`. See base-URL note below.
 *
 * Idempotency: Meta's `/{appId}/subscriptions` POST is upsert-style — re-runs
 * return `success: true`. Page and IG `subscribed_apps` POSTs also return
 * success on repeat. We do not try to be cleverer than that; the helper
 * results pass through.
 *
 * NEVER log access tokens or app secrets.
 */

import 'dotenv/config';
import pino from 'pino';
import { loadConfig, type Config } from '../../src/config/loader.js';
import {
  MetaApiError,
  appAccessToken as _appAccessToken,
  setWebhookSubscriptionConfig,
  subscribeMessengerPageApp,
  subscribeInstagramApp,
  subscribeWhatsAppBusinessAccount,
  listWebhookSubscriptions,
  type GraphConfig,
  type WebhookSubscriptionResult,
  type WebhookSubscriptionListEntry
} from '../lib/graph-api.js';
import { info, success, warn, fail, divider, confirm, closePrompts, registerShutdown } from '../lib/console.js';

// Suppress unused warning — re-exported for downstream callers that want the
// canonical app-token helper without importing graph-api directly.
void _appAccessToken;

/* ────────────────────────────────────────────────────────────────────────── */
/* Public types                                                               */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * The exact subscribed-fields list per webhook object, derived from the
 * Stage 3 spec. Frozen so accidental mutation by callers does not drift the
 * registration target.
 */
export const SUBSCRIBED_FIELDS = {
  // WhatsApp Business Account fields. `messages` is the load-bearing one;
  // the rest are status / quality / review callbacks.
  whatsapp: Object.freeze([
    'messages',
    'message_template_status_update',
    'account_review_update',
    'phone_number_quality_update',
    'phone_number_name_update'
  ]),
  // Messenger Page object fields. Note: Meta's docs separately call this
  // surface "the page webhook"; the `object` value is `page`.
  // `message_echoes` is included so we receive deliveries of our OWN outbound
  // messages — useful for confirming round-trip wiring and reconciling sends
  // with their delivery status.
  messenger: Object.freeze([
    'messages',
    'messaging_postbacks',
    'message_deliveries',
    'message_reads',
    'messaging_optins',
    'messaging_referrals',
    'message_reactions',
    'message_echoes'
  ]),
  // Instagram Business messaging fields. `messaging_seen` is IG's name for
  // the read-receipt event (Messenger calls the equivalent `message_reads`).
  // `messaging_referral` is SINGULAR for Instagram (Meta's IG-specific field
  // name) — Messenger uses the plural `messaging_referrals`.
  // NOTE: `message_echoes` is NOT a valid Instagram field — it exists only on
  // the Messenger (`page`) object. Meta rejects the whole subscribe call with
  // HTTP 400 / code 100 if it's included. Verified against the live API on
  // 2026-05-20: the accepted IG set is {agent_messages, messages,
  // messaging_postbacks, messaging_seen, messaging_handover, messaging_referral,
  // messaging_optins, message_reactions, message_edit, standby, comments,
  // live_comments, mentions, story_insights, ...}. Echoes of our own outbound
  // are not available as an IG webhook field; outbound tracking on IG relies on
  // the Send API response, not an echo webhook.
  instagram: Object.freeze([
    'messages',
    'messaging_postbacks',
    'messaging_seen',
    'message_reactions',
    'messaging_referral'
  ])
} as const satisfies Record<'whatsapp' | 'messenger' | 'instagram', readonly string[]>;

export interface RegistrationContext {
  /** Loaded via {@link loadConfig}. `meta.appId` must be set. */
  config: Config;
  /**
   * Public HTTPS URL the script should register as the webhook callback.
   * Must already include the path (e.g. `https://abc.ngrok.app/webhook`) —
   * we do NOT append `/webhook` for the caller.
   */
  callbackUrl: string;
  /** Override the API version derived from `config.meta.graphApiVersion`. */
  apiVersion?: string;
  /** Defaults to a no-op pino logger if omitted. */
  logger?: pino.Logger;
}

export interface ChannelRegistrationResult {
  channel: 'whatsapp' | 'messenger' | 'instagram';
  /**
   * - `success`: the subscription is in place.
   * - `skipped`: credentials for this channel were not configured (config has
   *   no per-channel block) — script didn't try.
   * - `manual_required`: Meta refused programmatic config and the developer
   *   must complete the step in the App Dashboard.
   * - `failed`: an API call threw a {@link MetaApiError} we couldn't classify
   *   as success or manual.
   */
  status: 'success' | 'skipped' | 'manual_required' | 'failed';
  message: string;
  details?: unknown;
  /** Set for `manual_required` — concrete dashboard instructions. */
  remediation?: string;
}

export interface RegistrationSummary {
  results: ChannelRegistrationResult[];
  /** True iff every result that isn't `skipped` is `success`. */
  allSucceeded: boolean;
}

export interface InspectionResult {
  subscriptions: WebhookSubscriptionListEntry[];
  expectedFields: { whatsapp: string[]; messenger: string[]; instagram: string[] };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Internals                                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

function noopLogger(): pino.Logger {
  // pino with a stream that throws away writes — silent by default for
  // library callers that don't want startup noise in their own logs.
  return pino({ level: 'silent' });
}

function resolveGraphConfig(ctx: RegistrationContext): GraphConfig {
  return { apiVersion: ctx.apiVersion ?? ctx.config.meta.graphApiVersion };
}

function ensureAppId(ctx: RegistrationContext): string {
  const id = ctx.config.meta.appId;
  if (!id) {
    throw new Error(
      'META_APP_ID is not set. Webhook subscription requires the App ID to ' +
        'build the app-access token. Set META_APP_ID in your environment.'
    );
  }
  return id;
}

/**
 * Build a remediation hint when `setWebhookSubscriptionConfig` returns a
 * manualConfigurationRequired result. The helper already supplies a hint;
 * we wrap it with channel-specific context (e.g. which Dashboard tab).
 */
function buildManualHint(
  channel: 'whatsapp' | 'messenger' | 'instagram',
  callbackUrl: string,
  helperHint: string | undefined
): string {
  const dashboardPath: Record<typeof channel, string> = {
    whatsapp: 'App Dashboard → WhatsApp → Configuration → Webhook',
    messenger: 'App Dashboard → Messenger → Settings → Webhooks',
    instagram: 'App Dashboard → Instagram → Webhooks'
  };
  const base = `Configure ${dashboardPath[channel]}: set callback URL "${callbackUrl}" and the verify token.`;
  return helperHint ? `${base} (Meta said: ${helperHint})` : base;
}

interface ChannelRunner {
  channel: 'whatsapp' | 'messenger' | 'instagram';
  /**
   * Execute the per-channel registration. Returns a result instead of
   * throwing so the outer loop can keep going for the other channels.
   */
  run(): Promise<ChannelRegistrationResult>;
}

/**
 * Convert a thrown error from a Graph helper into a `failed` result. Surfaces
 * the structured Meta error fields (httpStatus, errorCode, fbtraceId) so the
 * console output is debuggable without grepping logs.
 */
function failureFromError(
  channel: 'whatsapp' | 'messenger' | 'instagram',
  operation: string,
  err: unknown
): ChannelRegistrationResult {
  if (err instanceof MetaApiError) {
    return {
      channel,
      status: 'failed',
      message: `${operation} failed: HTTP ${err.httpStatus}${
        err.errorCode !== undefined ? `, code ${err.errorCode}` : ''
      }${err.errorSubCode !== undefined ? `, subcode ${err.errorSubCode}` : ''}`,
      details: {
        operation: err.operation,
        httpStatus: err.httpStatus,
        errorCode: err.errorCode,
        errorSubCode: err.errorSubCode,
        fbtraceId: err.fbtraceId,
        responseBody: err.responseBody
      }
    };
  }
  const msg = err instanceof Error ? err.message : String(err);
  return {
    channel,
    status: 'failed',
    message: `${operation} threw an unexpected error: ${msg}`,
    details: { error: msg }
  };
}

/**
 * Generic helper for the app-level subscription step. WhatsApp uses this and
 * stops (no per-WABA subscribe endpoint), while Messenger / Instagram chain
 * a follow-up per-page / per-user subscribe call.
 *
 * Returns either a `manual_required` result (Meta said "do it in the
 * Dashboard"), or `undefined` to signal the caller can proceed with the
 * follow-up call.
 */
async function configureAppSubscription(
  ctx: RegistrationContext,
  channel: 'whatsapp' | 'messenger' | 'instagram',
  object: 'whatsapp_business_account' | 'page' | 'instagram',
  fields: readonly string[],
  appId: string
): Promise<{ kind: 'manual'; result: ChannelRegistrationResult } | { kind: 'ok'; raw: WebhookSubscriptionResult }> {
  const raw = await setWebhookSubscriptionConfig({
    appId,
    appSecret: ctx.config.meta.appSecret,
    callbackUrl: ctx.callbackUrl,
    verifyToken: ctx.config.meta.verifyToken,
    object,
    fields: [...fields],
    config: resolveGraphConfig(ctx)
  });

  if (raw.manualConfigurationRequired) {
    const remediation = buildManualHint(channel, ctx.callbackUrl, raw.manualConfigurationHint);
    return {
      kind: 'manual',
      result: {
        channel,
        status: 'manual_required',
        message: `Meta requires manual webhook configuration for ${channel}.`,
        details: raw,
        remediation
      }
    };
  }
  return { kind: 'ok', raw };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Per-channel runners                                                        */
/* ────────────────────────────────────────────────────────────────────────── */

function buildWhatsAppRunner(ctx: RegistrationContext, appId: string): ChannelRunner {
  // Suppress unused warning — `appId` is part of the runner signature for
  // symmetry with the other runners. We don't need it here because we skip
  // the `/{appId}/subscriptions` POST for whatsapp_business_account (see WHY
  // below). Keeping the parameter avoids a noisy signature divergence.
  void appId;
  return {
    channel: 'whatsapp',
    async run(): Promise<ChannelRegistrationResult> {
      // WHY we skip POST /{appId}/subscriptions for whatsapp_business_account:
      // Meta's `/{appId}/subscriptions` endpoint is only documented to accept
      // `object` values of `user`, `page`, `permissions`, and `payments`.
      // While the endpoint sometimes accepts `whatsapp_business_account`
      // depending on app activation state, this is NOT the supported path.
      // The load-bearing call for WhatsApp webhooks is the per-WABA
      // `POST /{WABA_ID}/subscribed_apps` (see H3 below). The Dashboard
      // callback URL + verify token must ALSO be configured manually under
      // App Dashboard → WhatsApp → Configuration → Webhook.
      //
      // WHY a WABA matters: a WhatsApp Business Account (WABA) is the
      // top-level "tenant" container in Meta Business that owns one or more
      // PHONE NUMBERS. The phone number is what your customers message; the
      // WABA is what receives webhook deliveries. `subscribed_apps` is keyed
      // on the WABA because a single WABA may host multiple numbers, and
      // Meta wires webhooks at the WABA scope. Without this per-WABA
      // subscription, the Dashboard callback URL is configured but no
      // webhooks actually deliver.
      const wabaId = ctx.config.whatsapp?.businessAccountId;
      const manualBase =
        `Configure callback URL + verify token in App Dashboard → WhatsApp → Configuration → Webhook. ` +
        `Subscribe to fields: ${SUBSCRIBED_FIELDS.whatsapp.join(', ')}.`;

      if (!wabaId) {
        // No WABA id available — we can't do the programmatic per-WABA
        // subscription. Surface manual_required with the env-var hint.
        return {
          channel: 'whatsapp',
          status: 'manual_required',
          message: 'WhatsApp app-level webhook subscription requires manual configuration.',
          remediation:
            `${manualBase} ` +
            `Optionally set WHATSAPP_BUSINESS_ACCOUNT_ID in .env to enable programmatic per-WABA ` +
            `subscription via this script.`
        };
      }

      try {
        // Per-WABA subscription is the load-bearing step that actually causes
        // Meta to deliver webhooks to our configured callback URL.
        const wabaResult = await subscribeWhatsAppBusinessAccount({
          wabaId,
          accessToken: ctx.config.whatsapp!.accessToken,
          config: resolveGraphConfig(ctx)
        });
        return {
          channel: 'whatsapp',
          status: 'success',
          message: `WhatsApp per-WABA subscription configured (WABA ${wabaId}, callback ${ctx.callbackUrl}).`,
          details: { waba: wabaResult }
        };
      } catch (err) {
        // If the per-WABA subscribe call fails (often a permissions error on
        // the access token), still surface manual_required — the developer
        // can complete it in the Dashboard. We attach the helper failure to
        // `details` so the failure mode is debuggable.
        const helperError =
          err instanceof MetaApiError
            ? {
                operation: err.operation,
                httpStatus: err.httpStatus,
                errorCode: err.errorCode,
                errorSubCode: err.errorSubCode,
                fbtraceId: err.fbtraceId,
                responseBody: err.responseBody
              }
            : { error: err instanceof Error ? err.message : String(err) };
        return {
          channel: 'whatsapp',
          status: 'manual_required',
          message: `WhatsApp per-WABA subscribed_apps POST failed; manual configuration required.`,
          details: { helperError },
          remediation: manualBase
        };
      }
    }
  };
}

function buildMessengerRunner(ctx: RegistrationContext, appId: string): ChannelRunner {
  return {
    channel: 'messenger',
    async run(): Promise<ChannelRegistrationResult> {
      // App-level config first; if that needs manual setup, surface that and
      // skip the per-page step (no point subscribing the page if Meta hasn't
      // accepted our callback URL).
      let appLevelDetails: WebhookSubscriptionResult;
      try {
        const outcome = await configureAppSubscription(
          ctx,
          'messenger',
          'page',
          SUBSCRIBED_FIELDS.messenger,
          appId
        );
        if (outcome.kind === 'manual') return outcome.result;
        appLevelDetails = outcome.raw;
      } catch (err) {
        return failureFromError('messenger', 'set_webhook_subscription_config(page)', err);
      }

      // Per-page subscription. The helper sends `subscribed_fields` as a
      // comma-separated string in the JSON body — Meta's API quirk
      // (documented in graph-api.ts and asserted by scripts-graph-api.test.ts).
      const messenger = ctx.config.messenger;
      if (!messenger) {
        // Defensive guard — shouldn't happen because the runner is only built
        // when messenger creds exist, but keep the type system happy.
        return {
          channel: 'messenger',
          status: 'skipped',
          message: 'Messenger credentials not present — skipping per-page subscription.'
        };
      }
      try {
        const pageResult = await subscribeMessengerPageApp({
          pageId: messenger.pageId,
          pageAccessToken: messenger.pageAccessToken,
          subscribedFields: [...SUBSCRIBED_FIELDS.messenger],
          config: resolveGraphConfig(ctx)
        });
        return {
          channel: 'messenger',
          status: 'success',
          message: `Messenger subscription configured: app-level + page ${messenger.pageId}.`,
          details: { appLevel: appLevelDetails, page: pageResult }
        };
      } catch (err) {
        return failureFromError('messenger', 'subscribe_messenger_page_app', err);
      }
    }
  };
}

function buildInstagramRunner(ctx: RegistrationContext, appId: string): ChannelRunner {
  // Suppress unused warning — `appId` is part of the runner signature for
  // symmetry with the Messenger runner. We do not POST to
  // `/{appId}/subscriptions` for `object=instagram` (see WHY below).
  void appId;
  return {
    channel: 'instagram',
    async run(): Promise<ChannelRegistrationResult> {
      // WHY we skip POST /{appId}/subscriptions for object=instagram:
      // Meta's `/{appId}/subscriptions` endpoint is only documented to accept
      // `object` values of `user`, `page`, `permissions`, and `payments`.
      // Instagram webhook configuration must happen in the App Dashboard
      // (callback URL + verify token + field selection). The load-bearing
      // call this script CAN make programmatically is the per-IG-user
      // `POST {userId}/subscribed_apps` on graph.instagram.com, which
      // associates this app with the Instagram User Access Token's account.
      const instagram = ctx.config.instagram;
      if (!instagram) {
        return {
          channel: 'instagram',
          status: 'skipped',
          message: 'Instagram credentials not present — skipping per-user subscription.'
        };
      }
      const manualHint =
        `Configure callback URL + verify token in App Dashboard → Instagram → Webhooks. ` +
        `Subscribe to fields: ${SUBSCRIBED_FIELDS.instagram.join(', ')}.`;
      try {
        // BASE URL DECISION (see file header): we always hit
        // graph.instagram.com here because the Instagram Business Login flow
        // (which is the supported path for Instagram messaging in v23+)
        // issues tokens scoped to that host. Legacy Facebook-Page-linked IG
        // accounts can in theory work against graph.facebook.com, but those
        // are deprecated and the dual-attempt logic adds more failure modes
        // than it solves. If a user has a legacy account, they can override
        // by setting ctx.apiVersion / forking the helper.
        const igResult = await subscribeInstagramApp({
          userId: instagram.userId,
          accessToken: instagram.accessToken,
          subscribedFields: [...SUBSCRIBED_FIELDS.instagram],
          config: resolveGraphConfig(ctx)
        });
        return {
          channel: 'instagram',
          status: 'success',
          message: `Instagram per-user subscription configured: user ${instagram.userId}.`,
          details: { user: igResult, manualHint }
        };
      } catch (err) {
        return failureFromError('instagram', 'subscribe_instagram_app', err);
      }
    }
  };
}

/**
 * Build a runner for every channel that has credentials configured. Channels
 * without credentials yield an immediate `skipped` result rather than a
 * runner — the caller still sees them in the summary.
 */
function buildRunners(
  ctx: RegistrationContext,
  appId: string
): Array<ChannelRunner | ChannelRegistrationResult> {
  const out: Array<ChannelRunner | ChannelRegistrationResult> = [];
  out.push(
    ctx.config.whatsapp
      ? buildWhatsAppRunner(ctx, appId)
      : {
          channel: 'whatsapp',
          status: 'skipped',
          message: 'WhatsApp credentials not configured (WHATSAPP_PHONE_NUMBER_ID + WHATSAPP_ACCESS_TOKEN missing).'
        }
  );
  out.push(
    ctx.config.messenger
      ? buildMessengerRunner(ctx, appId)
      : {
          channel: 'messenger',
          status: 'skipped',
          message: 'Messenger credentials not configured (MESSENGER_PAGE_ID + MESSENGER_PAGE_ACCESS_TOKEN missing).'
        }
  );
  out.push(
    ctx.config.instagram
      ? buildInstagramRunner(ctx, appId)
      : {
          channel: 'instagram',
          status: 'skipped',
          message: 'Instagram credentials not configured (INSTAGRAM_USER_ID + INSTAGRAM_ACCESS_TOKEN missing).'
        }
  );
  return out;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Public API                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Register webhooks for every configured channel. See file header for the
 * end-to-end flow.
 *
 * Per-channel failure is local — other channels still attempt their
 * registration. Partial success is reflected in the returned summary.
 */
export async function registerAllWebhooks(ctx: RegistrationContext): Promise<RegistrationSummary> {
  const logger = ctx.logger ?? noopLogger();
  const appId = ensureAppId(ctx);
  const runners = buildRunners(ctx, appId);

  const results: ChannelRegistrationResult[] = [];
  for (const entry of runners) {
    if ('status' in entry) {
      // Pre-computed skipped result.
      logger.debug({ channel: entry.channel, status: entry.status }, 'channel skipped');
      results.push(entry);
      continue;
    }
    logger.debug({ channel: entry.channel }, 'starting channel registration');
    const result = await entry.run();
    logger.debug({ channel: result.channel, status: result.status }, 'channel registration completed');
    results.push(result);
  }

  // allSucceeded: every non-skipped channel must be `success`. `manual_required`
  // and `failed` both flip this to false — the caller's exit-code policy can
  // still treat manual as a 0 outcome (no Meta-side error, just human work).
  const allSucceeded = results.every((r) => r.status === 'success' || r.status === 'skipped');
  return { results, allSucceeded };
}

/**
 * Pre-flight diagnostic. Lists existing app-level subscriptions and returns
 * the expected fields per channel for the caller to display.
 */
export async function inspectExistingSubscriptions(
  ctx: RegistrationContext
): Promise<InspectionResult> {
  const appId = ensureAppId(ctx);
  const subscriptions = await listWebhookSubscriptions(
    appId,
    ctx.config.meta.appSecret,
    resolveGraphConfig(ctx)
  );
  return {
    subscriptions,
    expectedFields: {
      whatsapp: [...SUBSCRIBED_FIELDS.whatsapp],
      messenger: [...SUBSCRIBED_FIELDS.messenger],
      instagram: [...SUBSCRIBED_FIELDS.instagram]
    }
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* CLI entry point                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

function parseArgs(argv: string[]): { callbackUrl?: string; inspect: boolean; help: boolean } {
  let callbackUrl: string | undefined;
  let inspect = false;
  let help = false;
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') help = true;
    else if (arg === '--inspect' || arg === '-i') inspect = true;
    else if (arg.startsWith('--callback-url=')) callbackUrl = arg.slice('--callback-url='.length);
  }
  return { callbackUrl, inspect, help };
}

function printHelp(): void {
  // Keep this short — the README / plan doc is the source of truth for the
  // full setup flow. This is a CLI quick-reference only.
  process.stdout.write(
    [
      'Usage: npm run meta:webhooks -- [options]',
      '',
      'Options:',
      '  --callback-url=<url>  Public HTTPS webhook URL (e.g. https://abc.ngrok.app/webhook).',
      '                        If omitted, PUBLIC_BASE_URL env var is used (with /webhook appended).',
      '  --inspect, -i         Print current subscriptions and exit without modifying anything.',
      '  --help, -h            Show this help.',
      ''
    ].join('\n')
  );
}

/**
 * Resolve the callback URL from CLI args / env. Exits the process with a
 * clear remediation if neither source supplies one.
 */
function resolveCallbackUrl(args: ReturnType<typeof parseArgs>, env: NodeJS.ProcessEnv): string {
  if (args.callbackUrl) return args.callbackUrl;
  const publicBase = env['PUBLIC_BASE_URL']?.trim();
  if (publicBase) {
    // Strip trailing slashes and append /webhook so callers don't have to.
    return `${publicBase.replace(/\/+$/, '')}/webhook`;
  }
  fail(
    'No callback URL resolved. Pass --callback-url=<https://...> or set PUBLIC_BASE_URL ' +
      '(e.g. PUBLIC_BASE_URL=https://abc.ngrok.app) before running this script. ' +
      'You can get a public URL quickly with ngrok: `ngrok http 3000`.'
  );
  process.exit(1);
}

function colorStatusLine(result: ChannelRegistrationResult): void {
  const label = result.channel.toUpperCase();
  switch (result.status) {
    case 'success':
      success(`${label}: ${result.message}`);
      break;
    case 'skipped':
      info(`${label} (skipped): ${result.message}`);
      break;
    case 'manual_required':
      warn(`${label}: ${result.message}`);
      if (result.remediation) warn(`        ${result.remediation}`);
      break;
    case 'failed':
      fail(`${label}: ${result.message}`);
      if (result.details) {
        // Print details as a single JSON line so it's grep-friendly.
        const d = result.details as Record<string, unknown>;
        const compact = Object.entries(d)
          .filter(([, v]) => v !== undefined && v !== null)
          .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
          .join(' ');
        if (compact) fail(`        ${compact}`);
      }
      break;
  }
}

async function runCli(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return 0;
  }

  // Route signal-driven exits through the central shutdown registry. This
  // script doesn't hold any expensive handles (no tunnel, no capture
  // server), but closing the readline ensures Ctrl-C during the confirm
  // prompt doesn't leave a dangling stdin listener for other test runs.
  registerShutdown(() => {
    closePrompts();
  });

  divider('meta-ai-agent: webhook registration');

  // Load config with a friendly error path. `loadConfig` is strict — it
  // throws on missing required vars (META_APP_SECRET, META_VERIFY_TOKEN,
  // CHAT_ENDPOINT_URL, etc.) and on half-configured channels.
  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(`Configuration error: ${msg}`);
    info(
      'Hint: ensure .env defines META_APP_ID, META_APP_SECRET, META_VERIFY_TOKEN, ' +
        'CHAT_ENDPOINT_URL, and credentials for at least one channel.'
    );
    return 1;
  }

  const callbackUrl = resolveCallbackUrl(args, process.env);

  const logger = pino({
    level: process.env['LOG_LEVEL'] ?? 'info',
    transport:
      config.nodeEnv === 'production'
        ? undefined
        : {
            target: 'pino-pretty',
            options: { translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' }
          }
  });

  const ctx: RegistrationContext = { config, callbackUrl, logger };

  // --inspect: read-only diagnostic, no mutations.
  if (args.inspect) {
    try {
      const inspection = await inspectExistingSubscriptions(ctx);
      info(`Found ${inspection.subscriptions.length} existing subscription(s):`);
      for (const sub of inspection.subscriptions) {
        const fieldNames = Array.isArray(sub.fields)
          ? sub.fields.map((f) => f?.name ?? '?').join(',')
          : '(none)';
        info(
          `  - object=${sub.object ?? '?'} active=${sub.active ?? '?'} ` +
            `callback_url=${sub.callback_url ?? '(unset)'} fields=[${fieldNames}]`
        );
      }
      divider('expected fields per channel');
      info(`  whatsapp:  ${inspection.expectedFields.whatsapp.join(', ')}`);
      info(`  messenger: ${inspection.expectedFields.messenger.join(', ')}`);
      info(`  instagram: ${inspection.expectedFields.instagram.join(', ')}`);
      return 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      fail(`Inspection failed: ${msg}`);
      return 1;
    }
  }

  // Print plan + confirm before doing anything destructive (idempotent, but
  // still touches Meta's subscription state).
  info(`Callback URL: ${callbackUrl}`);
  info(`Graph API: ${config.meta.graphApiVersion}`);
  const enabled = Object.entries(config.channels)
    .filter(([, on]) => on)
    .map(([k]) => k)
    .join(', ');
  info(`Configured channels: ${enabled || '(none)'}`);
  divider();

  let proceed: boolean;
  try {
    proceed = await confirm('Proceed with webhook registration?', false);
  } finally {
    // Don't leak the readline if the user just hit Enter — but keep it open
    // briefly so a Ctrl-C in the prompt still routes through the SIGINT
    // handler in console.ts.
  }
  if (!proceed) {
    info('Aborted by user.');
    closePrompts();
    return 0;
  }

  divider('registering subscriptions');
  const summary = await registerAllWebhooks(ctx);
  divider('results');
  for (const r of summary.results) colorStatusLine(r);

  divider();
  // Exit code policy:
  //   - any failed → exit 1
  //   - all skipped/success/manual_required → exit 0 (manual_required is a
  //     human-action signal, not a script bug)
  const anyFailed = summary.results.some((r) => r.status === 'failed');
  if (anyFailed) {
    fail('One or more channels failed to register. See above for details.');
    closePrompts();
    return 1;
  }
  if (summary.allSucceeded) {
    success('Webhook registration complete.');
  } else {
    warn('Webhook registration completed with manual steps required. Address them and re-run --inspect to confirm.');
  }
  closePrompts();
  return 0;
}

/**
 * Detect whether this module is being executed directly (i.e. `tsx
 * register-webhooks.ts`) vs. imported as a library. Node ESM has no
 * `require.main === module` analog; the conventional approach is to compare
 * the resolved URL of the entry point to this file's URL.
 */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  // import.meta.url is a file: URL; normalize argv[1] (which is a path) to
  // the same shape and compare suffixes — robust against symlinks / different
  // path styles on Windows.
  try {
    const entryUrl = new URL(`file://${entry}`).href;
    return import.meta.url === entryUrl || import.meta.url.endsWith(entry);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  runCli()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      fail(`Unexpected error: ${msg}`);
      process.exitCode = 1;
    });
}
