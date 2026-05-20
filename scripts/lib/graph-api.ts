/**
 * Setup-time Graph API helper.
 *
 * Scope discipline: this file is the SETUP-script surface (verify token,
 * register webhook subscription, fetch display info for the console). The
 * RUNTIME client that Stage 4 will build under `src/meta/shared/graph-client.ts`
 * is intentionally separate — different concerns (retry / backoff / rate
 * limits / send adapters), different consumers. Don't bloat this file with
 * runtime-shaped surface; setup scripts should be lightweight.
 *
 * All non-2xx responses throw {@link MetaApiError} with parsed Meta error JSON
 * (error.code / error.error_subcode / error.fbtrace_id) so callers can branch
 * on documented codes without regex-matching error.message strings.
 *
 * NEVER log access tokens or app secrets. Log redacted shapes only.
 */

export type Channel = 'whatsapp' | 'messenger' | 'instagram';

export interface GraphConfig {
  /** e.g. `'v25.0'` from `loadConfig().meta.graphApiVersion`. */
  apiVersion: string;
  /**
   * Base URL. Defaults to `https://graph.facebook.com` for WhatsApp /
   * Messenger. Most Instagram Business Login endpoints live on
   * `https://graph.instagram.com` — use {@link buildInstagramGraphUrl} for
   * those, or pass `baseUrl` here per-call.
   */
  baseUrl?: string;
}

const DEFAULT_BASE_URL = 'https://graph.facebook.com';
const INSTAGRAM_BASE_URL = 'https://graph.instagram.com';

/* ────────────────────────────────────────────────────────────────────────── */
/* URL builders                                                               */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Build a Graph API URL: `${baseUrl}/${version}/${path}?${query}`.
 *
 * `path` must NOT start with a slash. Query values of `undefined` are
 * dropped; numbers stringify. Use this for WhatsApp / Messenger / app-level
 * endpoints on `graph.facebook.com`.
 */
export function buildGraphUrl(
  path: string,
  query: Record<string, string | number | undefined>,
  config: GraphConfig
): string {
  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const trimmedPath = path.replace(/^\/+/, '');
  const qs = buildQueryString(query);
  return qs.length > 0
    ? `${baseUrl}/${config.apiVersion}/${trimmedPath}?${qs}`
    : `${baseUrl}/${config.apiVersion}/${trimmedPath}`;
}

/**
 * Same as {@link buildGraphUrl} but targets `graph.instagram.com` — required
 * for Instagram Business Login `/me` and OAuth long-lived-token exchange.
 */
export function buildInstagramGraphUrl(
  path: string,
  query: Record<string, string | number | undefined>,
  config: GraphConfig
): string {
  return buildGraphUrl(path, query, { ...config, baseUrl: INSTAGRAM_BASE_URL });
}

function buildQueryString(query: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    params.append(key, typeof value === 'number' ? String(value) : value);
  }
  return params.toString();
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Errors                                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

export interface MetaApiErrorArgs {
  operation: string;
  httpStatus: number;
  errorCode?: number;
  errorSubCode?: number;
  fbtraceId?: string;
  responseBody: unknown;
  message?: string;
  /**
   * Underlying error (e.g. the original network exception from fetch).
   * Passed to `Error`'s `cause` option so `.cause` is exposed on instances
   * and the V8 stack chain preserves the inner trace. JavaScript's Error
   * spec accepts `unknown` for `cause`; we preserve that flexibility.
   */
  cause?: unknown;
}

/**
 * Thrown by {@link graphFetch} on non-2xx responses (and on transport
 * failures with `httpStatus: 0`). Carries enough structured detail for
 * callers to branch on documented Meta error codes without parsing
 * `error.message` strings.
 */
export class MetaApiError extends Error {
  readonly operation: string;
  readonly httpStatus: number;
  readonly errorCode?: number;
  readonly errorSubCode?: number;
  readonly fbtraceId?: string;
  readonly responseBody: unknown;

  constructor(args: MetaApiErrorArgs) {
    // Pass `cause` through to `Error`'s constructor so the V8 stack chain
    // links to the underlying transport exception (e.g. ECONNREFUSED). Only
    // forward `cause` when explicitly supplied — undefined `cause` would
    // still set `this.cause = undefined`, which is harmless but noisier.
    super(args.message ?? formatMessage(args), args.cause !== undefined ? { cause: args.cause } : undefined);
    this.name = 'MetaApiError';
    this.operation = args.operation;
    this.httpStatus = args.httpStatus;
    if (args.errorCode !== undefined) this.errorCode = args.errorCode;
    if (args.errorSubCode !== undefined) this.errorSubCode = args.errorSubCode;
    if (args.fbtraceId !== undefined) this.fbtraceId = args.fbtraceId;
    this.responseBody = args.responseBody;
  }
}

function formatMessage(args: MetaApiErrorArgs): string {
  const parts: string[] = [];
  parts.push(`Meta Graph API error during ${args.operation}`);
  parts.push(`(HTTP ${args.httpStatus}`);
  if (args.errorCode !== undefined) parts.push(`, code ${args.errorCode}`);
  if (args.errorSubCode !== undefined) parts.push(`, subcode ${args.errorSubCode}`);
  parts.push(')');
  if (args.fbtraceId) parts.push(` [fbtrace_id: ${args.fbtraceId}]`);
  // Surface the server-side error.message when we have it; falls back to a
  // truncated dump of the response body for full-context debugging.
  const inline = extractServerMessage(args.responseBody) ?? stringifyResponseBody(args.responseBody);
  if (inline) parts.push(`: ${inline}`);
  return parts.join('');
}

function extractServerMessage(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const err = (body as { error?: unknown }).error;
  if (typeof err !== 'object' || err === null) return undefined;
  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' ? message : undefined;
}

function stringifyResponseBody(body: unknown): string {
  if (body === null || body === undefined) return '';
  if (typeof body === 'string') return body.length > 200 ? `${body.slice(0, 200)}…` : body;
  try {
    const json = JSON.stringify(body);
    return json.length > 200 ? `${json.slice(0, 200)}…` : json;
  } catch {
    return '<unserializable response body>';
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Fetch wrapper                                                              */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Thin fetch wrapper. Returns the parsed JSON body on 2xx; throws
 * {@link MetaApiError} on non-2xx with Meta's error JSON parsed when possible.
 *
 * `operation` is a free-form label (e.g. `'get_whatsapp_phone_number'`) used
 * in error messages and logs.
 *
 * Uses Node 20's built-in `fetch`; no extra HTTP dep required.
 */
export async function graphFetch<T = unknown>(
  url: string,
  init: RequestInit,
  operation: string
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (err) {
    // Network failure / DNS / TLS error before we got a response. Wrap with
    // httpStatus: 0 so callers can detect "didn't reach Meta" distinct from
    // "Meta returned an error". The underlying error is preserved as
    // `cause` so V8 prints the inner stack alongside the wrapping
    // MetaApiError when the error is logged.
    const causeMessage = err instanceof Error ? err.message : String(err);
    throw new MetaApiError({
      operation,
      httpStatus: 0,
      responseBody: causeMessage,
      message: `Meta Graph API ${operation} failed before response: ${causeMessage}`,
      cause: err
    });
  }

  // Pull the body as text first so we can attempt JSON parse on any status
  // code without losing the raw bytes if parsing fails.
  const rawText = await response.text();
  const parsed = tryParseJson(rawText);

  if (response.ok) {
    // 2xx — assume JSON. If Meta ever returns 2xx with a non-JSON body the
    // caller will see `parsed === undefined`; document that contract here.
    return (parsed === undefined ? null : parsed) as T;
  }

  // Non-2xx: extract Meta error fields if present. The shape is consistent
  // across products: { error: { message, type, code, error_subcode, fbtrace_id } }.
  const errorObj =
    typeof parsed === 'object' && parsed !== null
      ? ((parsed as { error?: unknown }).error as Record<string, unknown> | undefined)
      : undefined;
  const errorCode = typeof errorObj?.['code'] === 'number' ? (errorObj['code'] as number) : undefined;
  const errorSubCode =
    typeof errorObj?.['error_subcode'] === 'number'
      ? (errorObj['error_subcode'] as number)
      : undefined;
  const fbtraceId =
    typeof errorObj?.['fbtrace_id'] === 'string'
      ? (errorObj['fbtrace_id'] as string)
      : undefined;

  throw new MetaApiError({
    operation,
    httpStatus: response.status,
    ...(errorCode !== undefined ? { errorCode } : {}),
    ...(errorSubCode !== undefined ? { errorSubCode } : {}),
    ...(fbtraceId !== undefined ? { fbtraceId } : {}),
    // If JSON parsing succeeded, hand back the parsed object so error.error
    // fields are directly inspectable. Otherwise hand back the raw text.
    responseBody: parsed ?? rawText
  });
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
/* Common operations                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * App access token format: `${appId}|${appSecret}`. This is the documented
 * Meta convention for app-level operations (Webhooks /subscriptions, debug
 * tokens, etc.) where you authenticate as the app itself instead of as a
 * user / page / business.
 *
 * https://developers.facebook.com/docs/facebook-login/guides/access-tokens#apptokens
 */
export function appAccessToken(appId: string, appSecret: string): string {
  return `${appId}|${appSecret}`;
}

export interface WhatsAppPhoneNumberInfo {
  id?: string;
  display_phone_number?: string;
  verified_name?: string;
  quality_rating?: string;
  [key: string]: unknown;
}

/**
 * Fetch metadata for a WhatsApp phone number.
 *
 * Hits: `GET /{phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`
 * on `graph.facebook.com`. Used to confirm the access token is valid and
 * surface a friendly display string to the developer.
 */
export async function getWhatsAppPhoneNumber(
  phoneNumberId: string,
  accessToken: string,
  config: GraphConfig
): Promise<WhatsAppPhoneNumberInfo> {
  const url = buildGraphUrl(
    phoneNumberId,
    { fields: 'display_phone_number,verified_name,quality_rating', access_token: accessToken },
    config
  );
  return graphFetch<WhatsAppPhoneNumberInfo>(url, { method: 'GET' }, 'get_whatsapp_phone_number');
}

export interface MessengerPageInfo {
  id?: string;
  name?: string;
  [key: string]: unknown;
}

/**
 * Fetch metadata for a Facebook Page (Messenger inbox).
 *
 * Hits: `GET /{pageId}?fields=name,id` on `graph.facebook.com`.
 */
export async function getMessengerPage(
  pageId: string,
  accessToken: string,
  config: GraphConfig
): Promise<MessengerPageInfo> {
  const url = buildGraphUrl(pageId, { fields: 'name,id', access_token: accessToken }, config);
  return graphFetch<MessengerPageInfo>(url, { method: 'GET' }, 'get_messenger_page');
}

export interface InstagramUserInfo {
  user_id?: string;
  username?: string;
  [key: string]: unknown;
}

/**
 * Fetch metadata for an Instagram Business account.
 *
 * Hits: `GET /me?fields=user_id,username` on `graph.instagram.com`. NOTE:
 * this endpoint lives on the Instagram Graph host, NOT `graph.facebook.com`.
 */
export async function getInstagramUser(
  accessToken: string,
  config: GraphConfig
): Promise<InstagramUserInfo> {
  const url = buildInstagramGraphUrl(
    'me',
    { fields: 'user_id,username', access_token: accessToken },
    config
  );
  return graphFetch<InstagramUserInfo>(url, { method: 'GET' }, 'get_instagram_user');
}

export interface SubscribeMessengerPageAppArgs {
  pageId: string;
  pageAccessToken: string;
  subscribedFields: string[];
  config: GraphConfig;
}

/**
 * Subscribe the current app to a Page's messaging webhook fields.
 *
 * Hits: `POST /{pageId}/subscribed_apps?subscribed_fields=...&access_token=...`
 * with no JSON body. Returns `{ success: true }` on success.
 *
 * WHY query params (not a JSON body): Meta's documentation specifies
 * `subscribed_fields` as a URL parameter for this endpoint, and the
 * Instagram counterpart already uses query-string params. Keeping both
 * helpers consistent matches Meta's documented contract and avoids the
 * "sometimes form-encoded, sometimes JSON" inconsistency that previously
 * lived in this file.
 */
export async function subscribeMessengerPageApp(
  args: SubscribeMessengerPageAppArgs
): Promise<{ success?: boolean; [key: string]: unknown }> {
  const url = buildGraphUrl(
    `${args.pageId}/subscribed_apps`,
    {
      subscribed_fields: args.subscribedFields.join(','),
      access_token: args.pageAccessToken
    },
    args.config
  );
  return graphFetch(
    url,
    { method: 'POST' },
    'subscribe_messenger_page_app'
  );
}

export interface SubscribeInstagramAppArgs {
  /** Instagram User Id (the business account). */
  userId: string;
  accessToken: string;
  subscribedFields: string[];
  config: GraphConfig;
}

/**
 * Subscribe the current app to an Instagram Business account's messaging
 * webhook fields.
 *
 * Hits: `POST /{userId}/subscribed_apps?subscribed_fields=...&access_token=...`.
 * Defaults to `graph.instagram.com`. Some legacy IG accounts (linked via a
 * Facebook Page) need `graph.facebook.com` instead — callers can override
 * via `config.baseUrl`. Test both during dev to confirm which works for the
 * authenticated account.
 */
export async function subscribeInstagramApp(
  args: SubscribeInstagramAppArgs
): Promise<{ success?: boolean; [key: string]: unknown }> {
  const url = buildInstagramGraphUrl(
    `${args.userId}/subscribed_apps`,
    {
      subscribed_fields: args.subscribedFields.join(','),
      access_token: args.accessToken
    },
    args.config
  );
  return graphFetch(url, { method: 'POST' }, 'subscribe_instagram_app');
}

export interface InstagramSubscribedApp {
  id: string;
  subscribed_fields?: string[];
  [key: string]: unknown;
}

/**
 * List the apps subscribed to an Instagram Business account's webhooks.
 *
 * Hits: `GET /{userId}/subscribed_apps?access_token=...` on graph.instagram.com.
 *
 * WHY this exists separately from `listWebhookSubscriptions`: Instagram
 * subscriptions are PER-USER (attached to the IG user via this endpoint), not
 * app-level. The app-level `GET /{appId}/subscriptions` never surfaces an IG
 * subscription, so auditing IG via that path always reports "not found" even
 * when the per-user subscription is live. Use THIS to verify an IG account is
 * actually subscribed. A non-empty `data` array (queried with the app's own
 * token) means this app is subscribed to that user.
 */
export async function getInstagramSubscribedApps(
  userId: string,
  accessToken: string,
  config: GraphConfig
): Promise<InstagramSubscribedApp[]> {
  const url = buildInstagramGraphUrl(
    `${userId}/subscribed_apps`,
    { access_token: accessToken },
    config
  );
  const body = await graphFetch<{ data?: InstagramSubscribedApp[] }>(
    url,
    { method: 'GET' },
    'get_instagram_subscribed_apps'
  );
  return Array.isArray(body.data) ? body.data : [];
}

export interface SubscribeWhatsAppBusinessAccountArgs {
  /**
   * The WhatsApp Business Account (WABA) id. A WABA is the top-level
   * Business Manager container that owns one or more PHONE NUMBERS — it is
   * NOT the same as `phone_number_id`. Phone numbers are what your end
   * customers message; the WABA is the tenant that webhooks deliver
   * against. Per-WABA `subscribed_apps` is the load-bearing step that wires
   * webhook deliveries to your app — without it, configuring the callback
   * URL in the Dashboard yields a working verify handshake but zero actual
   * deliveries.
   */
  wabaId: string;
  /**
   * System User access token (or a WABA-scoped token) with the
   * `whatsapp_business_management` scope. Token is sent as a query
   * parameter per Meta's documented contract for this endpoint.
   */
  accessToken: string;
  /**
   * Optional override for the callback URL stored against the WABA. Meta
   * accepts this body field as a per-WABA override — usually unnecessary
   * because the Dashboard callback URL applies, but useful in multi-tenant
   * scenarios where each WABA points at a different listener.
   */
  overrideCallbackUri?: string;
  /** Optional override for the verify token. Mirrors `overrideCallbackUri`. */
  verifyToken?: string;
  config: GraphConfig;
}

/**
 * Subscribe the current app to a WhatsApp Business Account (WABA) so the
 * WABA emits webhook deliveries to the app's configured callback URL.
 *
 * Hits: `POST {graph.facebook.com}/{version}/{wabaId}/subscribed_apps`
 * with `access_token` in the query string. Body fields are optional per
 * Meta's documented contract — only `override_callback_uri` and
 * `verify_token` are supported and only included when provided.
 *
 * Returns `{ success: true }` on success. Throws {@link MetaApiError} on
 * non-2xx; common failure modes are missing `whatsapp_business_management`
 * scope on the token, or a token that isn't authorized for the WABA.
 *
 * https://developers.facebook.com/docs/graph-api/reference/whats-app-business-account/subscribed_apps/
 */
export async function subscribeWhatsAppBusinessAccount(
  args: SubscribeWhatsAppBusinessAccountArgs
): Promise<{ success?: boolean; [key: string]: unknown }> {
  const url = buildGraphUrl(
    `${args.wabaId}/subscribed_apps`,
    { access_token: args.accessToken },
    args.config
  );
  // Only send a body when there's an override to convey — many callers
  // just want to attach the app to the WABA with no per-WABA overrides.
  const bodyParts: Record<string, string> = {};
  if (args.overrideCallbackUri !== undefined) bodyParts['override_callback_uri'] = args.overrideCallbackUri;
  if (args.verifyToken !== undefined) bodyParts['verify_token'] = args.verifyToken;

  const init: RequestInit =
    Object.keys(bodyParts).length > 0
      ? {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(bodyParts).toString()
        }
      : { method: 'POST' };

  return graphFetch(url, init, 'subscribe_whatsapp_business_account');
}

export interface SetWebhookSubscriptionConfigArgs {
  appId: string;
  appSecret: string;
  callbackUrl: string;
  verifyToken: string;
  /** Webhook subscription `object` — `'page'` (Messenger), `'instagram'`, `'whatsapp_business_account'`. */
  object: 'page' | 'instagram' | 'whatsapp_business_account';
  /** Field names to subscribe to, e.g. `['messages','message_deliveries']`. */
  fields: string[];
  config: GraphConfig;
}

export interface WebhookSubscriptionResult {
  success?: boolean;
  /** Set when Meta requires Dashboard-side completion (e.g. WhatsApp). */
  manualConfigurationRequired?: boolean;
  /** Human-readable hint surfaced to the developer when manual config is needed. */
  manualConfigurationHint?: string;
  [key: string]: unknown;
}

/**
 * Set the app-level webhook subscription config (callback URL + verify
 * token + subscribed fields) for a product.
 *
 * Hits: `POST /{appId}/subscriptions` authenticated with the app access
 * token (`${appId}|${appSecret}`). Body: `{ object, callback_url,
 * verify_token, fields }`.
 *
 * IMPORTANT: WhatsApp webhook configuration is partially restricted —
 * Meta requires Dashboard interaction for the initial product setup, and
 * this endpoint sometimes returns `"App is not active"` or similar even
 * after Dashboard config is complete. When that happens we surface a
 * `manualConfigurationRequired: true` result instead of throwing, so the
 * caller can print a clean instruction to the user.
 */
export async function setWebhookSubscriptionConfig(
  args: SetWebhookSubscriptionConfigArgs
): Promise<WebhookSubscriptionResult> {
  const url = buildGraphUrl(
    `${args.appId}/subscriptions`,
    { access_token: appAccessToken(args.appId, args.appSecret) },
    args.config
  );
  try {
    const body = new URLSearchParams({
      object: args.object,
      callback_url: args.callbackUrl,
      verify_token: args.verifyToken,
      fields: args.fields.join(',')
    });
    return await graphFetch<WebhookSubscriptionResult>(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      },
      'set_webhook_subscription_config'
    );
  } catch (err) {
    if (err instanceof MetaApiError && shouldFallBackToManual(err)) {
      return {
        manualConfigurationRequired: true,
        manualConfigurationHint:
          `Meta refused programmatic webhook config for ${args.object} (HTTP ${err.httpStatus}` +
          (err.errorCode !== undefined ? `, code ${err.errorCode}` : '') +
          `). Configure callback URL "${args.callbackUrl}" and the verify token in the App Dashboard ` +
          `under the ${args.object} product, then re-run this script.`,
        error: {
          code: err.errorCode,
          subcode: err.errorSubCode,
          fbtraceId: err.fbtraceId
        }
      };
    }
    throw err;
  }
}

function shouldFallBackToManual(err: MetaApiError): boolean {
  // Meta returns different shapes for "do this in the Dashboard" depending
  // on product. We narrow to ONLY the documented manual-required signals:
  //   - errorCode === 200 && errorSubCode === 33 ("Application does not have
  //     permission" — the documented manual-required code/subcode)
  //   - server message contains "App is not active" (app not in active mode)
  //   - server message contains "not supported for this object" (the new
  //     v23-era refusal when the endpoint rejects the chosen `object`).
  // PREVIOUSLY this matched any 400 whose server message contained
  // "permission", which over-classified genuine permission errors (missing
  // scope, expired token) as manual-required. A generic `(#10) User does not
  // have permission to access this object` should propagate as a real error
  // so the developer can see the missing scope, not silently get routed to
  // a Dashboard hint that won't fix it.
  if (err.errorCode === 200 && err.errorSubCode === 33) return true;
  const serverMessage = extractServerMessage(err.responseBody) ?? '';
  if (serverMessage.includes('App is not active')) return true;
  if (serverMessage.includes('not supported for this object')) return true;
  return false;
}

export interface WebhookSubscriptionListEntry {
  object?: string;
  callback_url?: string;
  fields?: Array<{ name?: string; version?: string }>;
  active?: boolean;
  [key: string]: unknown;
}

/**
 * List the app's current webhook subscriptions — used for diagnostics
 * (e.g. confirming that the WhatsApp subscription points at the current
 * tunnel URL).
 *
 * Hits: `GET /{appId}/subscriptions` with the app access token.
 */
export async function listWebhookSubscriptions(
  appId: string,
  appSecret: string,
  config: GraphConfig
): Promise<WebhookSubscriptionListEntry[]> {
  const url = buildGraphUrl(
    `${appId}/subscriptions`,
    { access_token: appAccessToken(appId, appSecret) },
    config
  );
  const result = await graphFetch<{ data?: WebhookSubscriptionListEntry[] }>(
    url,
    { method: 'GET' },
    'list_webhook_subscriptions'
  );
  return Array.isArray(result?.data) ? result.data : [];
}
