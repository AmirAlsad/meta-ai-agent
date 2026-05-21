/**
 * Messenger Profile API client — the SETUP-TIME conversation-entry config that
 * lives on a Page's messenger profile: the Get Started button, the greeting
 * (welcome) text, the persistent menu, and ice breakers.
 *
 * WHY this is a SEPARATE client from {@link import('./client.js').MessengerClient}:
 * these are NOT per-message sends. They are configured ONCE (or whenever the
 * setup changes) against `{pageId}/messenger_profile` and then apply to every
 * conversation thread out-of-band. The send client owns `{pageId}/messages`
 * (one POST per outbound message); this client owns the profile surface. Keeping
 * them apart stops the per-message hot path from carrying setup concerns and
 * keeps the {@link import('../shared/adapter.js').ChannelAdapter} surface focused
 * on sends. The `MessengerClient.supports()` flags (`get_started` /
 * `persistent_menu` / `ice_breakers`) advertise that these surfaces EXIST for the
 * channel; this client is how they are actually configured.
 *
 * Every call hits `{pageId}/messenger_profile` on `graph.facebook.com` with the
 * Page access token sent as an `Authorization: Bearer` header (the GraphClient
 * does this — the token is NEVER placed in the URL).
 *
 * This client owns the messenger_profile body shapes (`get_started`, `greeting`,
 * `persistent_menu`, `ice_breakers`); the GraphClient knows none of them. The
 * public TypeScript inputs are camelCase (idiomatic TS); Meta's JSON is
 * snake_case — every method maps camelCase → snake_case before the request so
 * callers never have to think in Meta's wire casing.
 *
 * Reference: https://developers.facebook.com/docs/messenger-platform/reference/messenger-profile-api
 *
 * NEVER log access tokens or full request bodies.
 */

import type pino from 'pino';
import type { MessengerConfig } from '../../config/loader.js';
import type { GraphClient } from '../shared/graph-client.js';
import { MetaApiError } from '../shared/errors.js';

/**
 * A single greeting (welcome) text entry. `locale` is either `'default'` (the
 * fallback shown when no localized variant matches the user) or a Meta locale
 * code such as `'en_US'`. Meta requires a `'default'` entry to exist; this
 * client passes the array through verbatim and lets Meta validate that rule so
 * we do not duplicate (and risk drifting from) Meta's locale bookkeeping.
 */
export interface Greeting {
  locale: string;
  text: string;
}

/** A single ice breaker: a tappable starter `question` and its postback `payload`. */
export interface IceBreaker {
  question: string;
  payload: string;
}

/**
 * Ice breakers for one locale (the LOCALIZED form of the ice_breakers config).
 * `locale` is `'default'` or e.g. `'en_US'`; `callToActions` is the list of
 * starter questions for that locale (Meta caps this at 4 per locale — see
 * {@link MessengerProfileClient.setIceBreakers}).
 */
export interface LocalizedIceBreakers {
  locale: string;
  callToActions: IceBreaker[];
}

/**
 * A persistent-menu (or nested) item. Two kinds Meta supports at this surface:
 * - `postback` — taps fire a webhook `postback` with `payload`.
 * - `web_url` — taps open `url`, optionally in a webview of a given height.
 *
 * (Meta also supports a `nested` type for sub-menus; it is intentionally NOT
 * modeled here — the agent's menus are flat. A caller needing nesting can extend
 * this union later.)
 */
export type CallToAction =
  | { type: 'postback'; title: string; payload: string }
  | { type: 'web_url'; title: string; url: string; webviewHeightRatio?: 'compact' | 'tall' | 'full' };

/** The persistent menu for one locale. */
export interface PersistentMenuLocale {
  locale: string;
  /** When true, the user cannot type free text — only the menu drives the thread. */
  composerInputDisabled?: boolean;
  /** Up to 20 top-level actions (Meta's cap); passed through for Meta to validate. */
  callToActions: CallToAction[];
}

export interface MessengerProfileClientDeps {
  config: MessengerConfig;
  graph: GraphClient;
  logger?: Pick<pino.Logger, 'info' | 'warn' | 'debug'>;
}

/**
 * Error code for "you must set a Get Started button before a persistent menu".
 * Setting a `persistent_menu` while no `get_started` exists is rejected with
 * 2018145. We surface a CLEAR, actionable error for that specific case (see
 * {@link MessengerProfileClient.setPersistentMenu}) so the operator gets the
 * real remediation ("call setGetStartedButton first") rather than an opaque code.
 *
 * WHY this value is fragile: Meta DOCUMENTS the requirement (Get Started must
 * precede a persistent menu) but does NOT publish the numeric code — 2018145 is
 * EMPIRICALLY-OBSERVED, not from the docs. It is isolated here as a named
 * constant so a future Meta change is easy to spot/update. It can surface as
 * EITHER `errorCode` or `errorSubCode`, so the match below checks both; any
 * other (unrelated) error must still pass through unchanged.
 */
const GET_STARTED_REQUIRED_ERROR_CODE = 2018145;

/** Meta's hard cap on ice breakers per locale. */
const MAX_ICE_BREAKERS_PER_LOCALE = 4;

export class MessengerProfileClient {
  private readonly config: MessengerConfig;
  private readonly graph: GraphClient;
  private readonly logger?: Pick<pino.Logger, 'info' | 'warn' | 'debug'>;

  constructor(deps: MessengerProfileClientDeps) {
    this.config = deps.config;
    this.graph = deps.graph;
    if (deps.logger) this.logger = deps.logger;
  }

  /**
   * Set the Get Started button: `POST { get_started: { payload } }`.
   *
   * `payload` is the postback string delivered to the webhook when a brand-new
   * user taps "Get Started" — it is how the agent recognizes a first contact.
   *
   * WHY this matters for ordering: the Get Started button MUST exist before a
   * persistent menu can be set (see {@link setPersistentMenu}). In a setup
   * sequence, call this first.
   */
  async setGetStartedButton(payload: string): Promise<void> {
    await this.post({ get_started: { payload } }, 'messenger.setGetStarted');
  }

  /**
   * Set the greeting (welcome) text: `POST { greeting: [{ locale, text }, ...] }`.
   *
   * The greeting is the message shown on the welcome screen before a user starts
   * the conversation. Meta requires a `'default'` locale entry; we pass the
   * array through and let Meta validate localization rules.
   */
  async setGreetingText(greetings: Greeting[]): Promise<void> {
    // 1:1 passthrough — Greeting is already { locale, text } (Meta's snake_case
    // here happens to match), but we rebuild the objects so an extra field on a
    // caller's object never leaks into the wire body.
    const greeting = greetings.map((g) => ({ locale: g.locale, text: g.text }));
    await this.post({ greeting }, 'messenger.setGreetingText');
  }

  /**
   * Set the persistent menu:
   * `POST { persistent_menu: [{ locale, composer_input_disabled?, call_to_actions:
   *   [{ type, title, payload? | url?, webview_height_ratio? }] }] }`.
   *
   * Maps the camelCase TS input to Meta's snake_case JSON:
   * `composerInputDisabled` → `composer_input_disabled`, `callToActions` →
   * `call_to_actions`, `webviewHeightRatio` → `webview_height_ratio`. Only the
   * fields valid for each action `type` are emitted (`postback` → `payload`;
   * `web_url` → `url` + optional `webview_height_ratio`).
   *
   * WHY GET-STARTED-BEFORE-MENU: Meta REQUIRES the Get Started button to be set
   * BEFORE a persistent menu — a `persistent_menu` POST with no existing
   * `get_started` is rejected with error code {@link
   * GET_STARTED_REQUIRED_ERROR_CODE} (2018145, empirically-observed — see the
   * constant). We catch THAT specific code (as either `errorCode` OR
   * `errorSubCode`, since Meta may surface it as either) and re-throw a clear,
   * actionable error telling the operator to call {@link setGetStartedButton}
   * first; any other error propagates unchanged.
   *
   * Meta also caps the menu at 20 top-level `call_to_actions`; we pass the list
   * through and let Meta validate the count (its error names the exact limit).
   */
  async setPersistentMenu(menu: PersistentMenuLocale[]): Promise<void> {
    const persistent_menu = menu.map((locale) => {
      const call_to_actions = locale.callToActions.map(mapCallToAction);
      return {
        locale: locale.locale,
        // Emit composer_input_disabled only when explicitly set, so the wire
        // body stays minimal and Meta applies its own default otherwise.
        ...(locale.composerInputDisabled !== undefined
          ? { composer_input_disabled: locale.composerInputDisabled }
          : {}),
        call_to_actions
      };
    });

    try {
      await this.post({ persistent_menu }, 'messenger.setPersistentMenu');
    } catch (err) {
      // 2018145 is empirically-observed (not documented by Meta) and may surface
      // as errorCode OR errorSubCode — match either; unrelated errors fall through
      // to the re-throw below unchanged (preserving the original error + cause).
      if (
        err instanceof MetaApiError &&
        (err.errorCode === GET_STARTED_REQUIRED_ERROR_CODE ||
          err.errorSubCode === GET_STARTED_REQUIRED_ERROR_CODE)
      ) {
        throw new MetaApiError({
          operation: 'messenger.setPersistentMenu',
          httpStatus: err.httpStatus,
          ...(err.errorCode !== undefined ? { errorCode: err.errorCode } : {}),
          ...(err.errorSubCode !== undefined ? { errorSubCode: err.errorSubCode } : {}),
          ...(err.fbtraceId !== undefined ? { fbtraceId: err.fbtraceId } : {}),
          responseBody: err.responseBody,
          message:
            'Cannot set a persistent menu before the Get Started button exists. ' +
            'Call setGetStartedButton(payload) first, then setPersistentMenu(...) ' +
            `(Meta error code ${GET_STARTED_REQUIRED_ERROR_CODE}).`,
          cause: err
        });
      }
      throw err;
    }
  }

  /**
   * Set ice breakers (LOCALIZED form):
   * `POST { ice_breakers: [{ locale, call_to_actions: [{ question, payload }] }] }`.
   *
   * Maps `callToActions` → `call_to_actions`; each ice breaker is `{ question,
   * payload }` (no casing change needed inside an item).
   *
   * WHY the ≤4 cap is validated locally: Meta caps ice breakers at
   * {@link MAX_ICE_BREAKERS_PER_LOCALE} (4) PER LOCALE. We validate up front and
   * throw a clear, local error naming the offending locale rather than letting
   * Meta reject the whole call with a less specific message — the same fail-fast
   * posture the send client uses for MESSAGE_TAG. (We only enforce the count;
   * everything else, e.g. duplicate locales, is left for Meta to validate.)
   *
   * @throws Error when any locale carries more than 4 ice breakers (no request
   *   is made).
   */
  async setIceBreakers(iceBreakers: LocalizedIceBreakers[]): Promise<void> {
    for (const entry of iceBreakers) {
      if (entry.callToActions.length > MAX_ICE_BREAKERS_PER_LOCALE) {
        throw new Error(
          `Messenger ice breakers for locale "${entry.locale}" exceed the limit of ` +
            `${MAX_ICE_BREAKERS_PER_LOCALE} per locale (got ${entry.callToActions.length}).`
        );
      }
    }

    const ice_breakers = iceBreakers.map((entry) => ({
      locale: entry.locale,
      call_to_actions: entry.callToActions.map((ib) => ({
        question: ib.question,
        payload: ib.payload
      }))
    }));
    await this.post({ ice_breakers }, 'messenger.setIceBreakers');
  }

  /**
   * Read back the current profile:
   * `GET {pageId}/messenger_profile?fields=<comma-joined>`.
   *
   * `fields` are the messenger_profile field names to fetch (e.g.
   * `['get_started', 'persistent_menu', 'greeting', 'ice_breakers']`). Returns
   * Meta's raw response (`{ data: [...] }`) untyped — callers inspect what they
   * asked for. The Profile API requires an explicit `fields` list (there is no
   * implicit "all"), so we comma-join the provided names.
   */
  async getMessengerProfile(fields: string[]): Promise<unknown> {
    return this.graph.request({
      method: 'GET',
      path: `${this.config.pageId}/messenger_profile`,
      query: { fields: fields.join(',') },
      accessToken: this.config.pageAccessToken,
      operation: 'messenger.getMessengerProfile'
    });
  }

  /**
   * Delete profile fields: `DELETE {pageId}/messenger_profile` with body
   * `{ fields: [...] }`.
   *
   * The Profile API deletes by listing the field names to remove in the request
   * BODY (e.g. `{ fields: ['persistent_menu'] }`) — NOT via a query string. This
   * tears down a configured surface (e.g. removing the persistent menu) without
   * touching the others.
   */
  async deleteMessengerProfileFields(fields: string[]): Promise<void> {
    await this.graph.request({
      method: 'DELETE',
      path: `${this.config.pageId}/messenger_profile`,
      body: { fields },
      accessToken: this.config.pageAccessToken,
      operation: 'messenger.deleteMessengerProfileFields'
    });
  }

  /**
   * Shared POST helper for the write surfaces. All profile writes hit
   * `{pageId}/messenger_profile` with the Page access token. `idempotent` is
   * deliberately LEFT UNSET (defaults to false for POST) so the GraphClient does
   * NOT retry a 5xx — a profile write is a configuration mutation and re-applying
   * it after an ambiguous server error is needless; the operator can simply
   * re-run setup. (429 and pre-response network failures are still retried, which
   * is safe — see GraphClient's retry decision matrix.)
   */
  private post(body: unknown, operation: string): Promise<unknown> {
    // Setup-time configs are infrequent; a debug breadcrumb (operation only —
    // NEVER the body, which can carry payloads/titles) helps trace which profile
    // surface a setup run touched without leaking content.
    this.logger?.debug({ operation }, 'messenger profile write');
    return this.graph.request({
      method: 'POST',
      path: `${this.config.pageId}/messenger_profile`,
      body,
      accessToken: this.config.pageAccessToken,
      operation
    });
  }
}

/**
 * Map a single {@link CallToAction} (camelCase, discriminated by `type`) to
 * Meta's snake_case wire object, emitting only the fields valid for that type.
 * Kept as a free function so the persistent-menu mapper stays readable and the
 * per-type field discipline lives in one place.
 */
function mapCallToAction(action: CallToAction): Record<string, unknown> {
  if (action.type === 'postback') {
    return { type: 'postback', title: action.title, payload: action.payload };
  }
  // web_url
  return {
    type: 'web_url',
    title: action.title,
    url: action.url,
    ...(action.webviewHeightRatio !== undefined
      ? { webview_height_ratio: action.webviewHeightRatio }
      : {})
  };
}
