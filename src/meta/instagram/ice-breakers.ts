/**
 * Instagram Ice Breakers management (setup-time conversation starters).
 *
 * Ice breakers are the tappable prompts shown to a user who opens a *new* DM
 * thread with the business before they've typed anything — Instagram's
 * equivalent of a "frequently asked questions" launcher. They are configured
 * ONCE at setup time (out-of-band of the live message loop), which is why this
 * is a standalone manager and not part of {@link InstagramClient}: the runtime
 * send client owns the per-message `/messages` surface and a rate pacer; this
 * manager owns the profile-configuration surface and is invoked by setup
 * scripts, not on the inbound hot path.
 *
 * WHY a SEPARATE class from the runtime client: ice breakers do not flow
 * through the per-account send pacer (they aren't messages and aren't
 * rate-limited the same way), and they need only the plain {@link GraphClient}
 * transport — no `recipient`/`sender_action` body shaping. Keeping them apart
 * means the runtime send client stays focused on `/messages`.
 *
 * ── ENDPOINT / HOST — FLAG FOR THE FIDELITY REVIEWER ───────────────────────
 * Instagram has NO Get Started button (that is a Messenger-only profile
 * surface); per the Stage-8 plan the only IG profile surface in scope is ice
 * breakers. We configure them via the messenger-profile surface ON THE
 * INSTAGRAM HOST: `POST|GET|DELETE {igUserId}/messenger_profile` on
 * `graph.instagram.com` (the Instagram-Login flavor this package issues tokens
 * for), with the access token in the `Authorization: Bearer` header (never the
 * URL). REVIEWER: please confirm against current Meta docs that IG ice breakers
 * live on `messenger_profile` (and not a differently-named IG path) and that
 * `graph.instagram.com` is the correct host for the Instagram-Login token —
 * Meta has historically served some IG profile config from
 * `graph.facebook.com/{IG_USER_ID}/...` under the Facebook-Login flavor. The
 * body shapes below match Meta's documented ice-breaker schema (localized
 * `ice_breakers[].call_to_actions[]`); only the host/path needs live
 * verification.
 *
 * Reference:
 * https://developers.facebook.com/docs/messenger-platform/instagram/features/ice-breakers
 */

import type pino from 'pino';
import type { InstagramConfig } from '../../config/loader.js';
import type { GraphClient } from '../shared/graph-client.js';

/** Host serving the Instagram-Login profile-configuration endpoints. */
const INSTAGRAM_GRAPH_HOST = 'graph.instagram.com' as const;

/** Profile surface path for the IG ice-breaker config (per-account). */
const MESSENGER_PROFILE_PATH = 'messenger_profile' as const;

/**
 * Platform discriminator required on the Instagram-Login messenger_profile
 * surface. Per Meta's "Instagram API with Instagram Login — ice breakers"
 * reference, every messenger_profile call for Instagram (set/get/delete) MUST
 * carry `platform: 'instagram'` — without it the call fails live (this surface
 * is shared in shape with Messenger, and the platform field selects the IG
 * variant). It is sent in the body for POST/DELETE and as a query param for GET.
 */
const INSTAGRAM_PLATFORM = 'instagram' as const;

/**
 * Maximum ice breakers Meta accepts PER LOCALE. Enforced locally so a too-long
 * list fails fast at the call site with a clear message rather than surfacing
 * as an opaque Graph API 400 at setup time.
 */
const MAX_ICE_BREAKERS_PER_LOCALE = 4;

/** A single tappable conversation starter (question shown + payload echoed back). */
export interface IceBreaker {
  /** The prompt text shown to the user (e.g. "What are your hours?"). */
  question: string;
  /**
   * Developer-defined string echoed back as a postback when the user taps the
   * starter — the webhook handler routes on this to produce a canned reply.
   */
  payload: string;
}

/**
 * Ice breakers for ONE locale. Instagram supports multi-locale ice breakers
 * (the `default` locale is the fallback when the user's locale has no entry);
 * each locale carries up to {@link MAX_ICE_BREAKERS_PER_LOCALE} starters.
 */
export interface LocalizedIceBreakers {
  /** Locale code, e.g. `'default'`, `'en_US'`, `'es_ES'`. */
  locale: string;
  /** The starters for this locale — at most {@link MAX_ICE_BREAKERS_PER_LOCALE}. */
  callToActions: IceBreaker[];
}

export interface InstagramIceBreakersDeps {
  /** Instagram credentials (IG user id + access token). */
  config: InstagramConfig;
  /** Shared Graph API transport — constructed once per process and injected. */
  graph: GraphClient;
  /** Optional structured logger. */
  logger?: Pick<pino.Logger, 'info' | 'warn' | 'debug'>;
}

export class InstagramIceBreakers {
  private readonly config: InstagramConfig;
  private readonly graph: GraphClient;
  private readonly logger?: Pick<pino.Logger, 'info' | 'warn' | 'debug'>;

  constructor(deps: InstagramIceBreakersDeps) {
    this.config = deps.config;
    this.graph = deps.graph;
    if (deps.logger) this.logger = deps.logger;
  }

  /**
   * Set (replace) the account's ice breakers via `POST {igUserId}/messenger_profile`.
   *
   * Each locale is mapped to Meta's wire shape:
   * `{ platform: 'instagram', ice_breakers: [{ locale, call_to_actions: [{ question, payload }] }] }`.
   * This is a full replace of the `ice_breakers` profile field — pass every
   * locale you want present in a single call. (`platform: 'instagram'` is
   * required on the IG-Login surface — see INSTAGRAM_PLATFORM.)
   *
   * Validates the per-locale cap ({@link MAX_ICE_BREAKERS_PER_LOCALE}) BEFORE
   * the call so an oversized list fails fast with a named error instead of an
   * opaque Graph 400.
   */
  async setIceBreakers(iceBreakers: LocalizedIceBreakers[]): Promise<void> {
    for (const localized of iceBreakers) {
      if (localized.callToActions.length > MAX_ICE_BREAKERS_PER_LOCALE) {
        throw new Error(
          `Instagram ice breakers: locale "${localized.locale}" has ` +
            `${localized.callToActions.length} starters but the maximum is ` +
            `${MAX_ICE_BREAKERS_PER_LOCALE} per locale.`
        );
      }
    }

    const body = {
      // IG-Login messenger_profile requires the platform discriminator (see
      // INSTAGRAM_PLATFORM) — the call fails live without it.
      platform: INSTAGRAM_PLATFORM,
      ice_breakers: iceBreakers.map(localized => ({
        locale: localized.locale,
        call_to_actions: localized.callToActions.map(cta => ({
          question: cta.question,
          payload: cta.payload
        }))
      }))
    };

    this.logger?.info(
      { locales: iceBreakers.map(l => l.locale) },
      'setting instagram ice breakers'
    );

    await this.graph.request<unknown>({
      method: 'POST',
      host: INSTAGRAM_GRAPH_HOST,
      path: `${this.config.userId}/${MESSENGER_PROFILE_PATH}`,
      body,
      accessToken: this.config.accessToken,
      operation: 'instagram.setIceBreakers'
    });
  }

  /**
   * Read the currently-configured ice breakers via
   * `GET {igUserId}/messenger_profile?platform=instagram&fields=ice_breakers`.
   *
   * Returns the raw Graph envelope (typically `{ data: [{ ice_breakers: [...] }] }`)
   * unmodified — the setup tooling inspects it directly, so we do not impose a
   * narrower shape here.
   */
  async getIceBreakers(): Promise<unknown> {
    return this.graph.request<unknown>({
      method: 'GET',
      host: INSTAGRAM_GRAPH_HOST,
      path: `${this.config.userId}/${MESSENGER_PROFILE_PATH}`,
      // platform=instagram is required on the IG-Login surface (see
      // INSTAGRAM_PLATFORM); the read fails live without it.
      query: { platform: INSTAGRAM_PLATFORM, fields: 'ice_breakers' },
      accessToken: this.config.accessToken,
      operation: 'instagram.getIceBreakers'
    });
  }

  /**
   * Delete all ice breakers via `DELETE {igUserId}/messenger_profile` with body
   * `{ platform: 'instagram', fields: ['ice_breakers'] }`.
   *
   * Per Meta's profile API, deletion targets the named field(s) in the request
   * body (NOT a query param) — so this clears only `ice_breakers` and leaves any
   * other profile fields untouched. The IG-Login surface additionally requires
   * the `platform` discriminator (see INSTAGRAM_PLATFORM).
   */
  async deleteIceBreakers(): Promise<void> {
    this.logger?.info('deleting instagram ice breakers');
    await this.graph.request<unknown>({
      method: 'DELETE',
      host: INSTAGRAM_GRAPH_HOST,
      path: `${this.config.userId}/${MESSENGER_PROFILE_PATH}`,
      // platform=instagram is required on the IG-Login surface (see
      // INSTAGRAM_PLATFORM); the delete fails live without it.
      body: { platform: INSTAGRAM_PLATFORM, fields: ['ice_breakers'] },
      accessToken: this.config.accessToken,
      operation: 'instagram.deleteIceBreakers'
    });
  }
}
