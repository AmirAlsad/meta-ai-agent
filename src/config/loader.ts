export type ConfigEnv = NodeJS.ProcessEnv;

export interface Channels {
  whatsapp: boolean;
  messenger: boolean;
  instagram: boolean;
}

export interface MetaConfig {
  appId: string | undefined;
  appSecret: string;
  verifyToken: string;
  graphApiVersion: string;
}

export interface WhatsAppConfig {
  phoneNumberId: string;
  accessToken: string;
  /**
   * Optional. The WhatsApp Business Account (WABA) ID — the top-level
   * Business Manager container that owns one or more phone numbers. When
   * provided, the webhook registration script can call
   * `POST /{WABA_ID}/subscribed_apps` to attach this app to the WABA, which
   * is the load-bearing step for receiving WhatsApp webhooks. Without it,
   * the registration script falls back to surfacing a `manual_required`
   * result.
   */
  businessAccountId?: string;
}

export interface MessengerConfig {
  pageId: string;
  pageAccessToken: string;
}

export interface InstagramConfig {
  userId: string;
  accessToken: string;
  /**
   * Optional. The Instagram product's own app secret (`INSTAGRAM_APP_SECRET`),
   * distinct from `META_APP_SECRET`. Instagram (`object: instagram`) webhooks
   * are signed with THIS secret, not the Meta App secret (proven against the
   * live API 2026-05-20). Needed only for INBOUND webhook signature
   * verification — NOT for the channel to be considered enabled (a channel is
   * enabled on `userId` + `accessToken` alone). When the Instagram channel is
   * enabled but this is absent, inbound IG webhooks will fail signature
   * verification; `createApp` warns about this at startup. Kept optional (not
   * thrown) so WhatsApp+Messenger-only setups that leave it unset are not
   * broken, and so partial pre-existing setups keep running.
   */
  appSecret?: string;
}

/**
 * Stage 5 tuning for inbound buffering, outbound typing indicators, read
 * receipts, and ordered delivery. Every field has a default; the loader
 * validates ranges and throws with the offending env var name on a malformed
 * value (fail-fast, no logging). Grouped into a nested section so downstream
 * code reads `config.conversation.bufferBaseTimeoutMs` etc. rather than a flat
 * soup of top-level knobs.
 */
export interface ConversationConfig {
  /** Initial buffer flush delay after the first inbound (ms). */
  bufferBaseTimeoutMs: number;
  /** Multiplier applied to the timeout on each rapid follow-up inbound (>= 1). */
  bufferGrowthFactor: number;
  /** Hard ceiling for the buffer flush delay (ms); always >= base. */
  bufferMaxTimeoutMs: number;
  /** Max fractional jitter (0..1) applied to the flush delay to avoid sync. */
  bufferNoiseMaxDeviation: number;
  /** Whether to emit outbound typing indicators before sending. */
  outboundTypingIndicatorsEnabled: boolean;
  /** How often a long-lived typing indicator is refreshed (ms). */
  typingRefreshIntervalMs: number;
  /** Absolute cap on how long typing is refreshed for one turn (ms). */
  typingRefreshMaxMs: number;
  /** Whether to mark inbound messages read (best-effort, channel-gated). */
  readReceiptsEnabled: boolean;
  /** How long to wait for a delivery/send confirmation before moving on (ms). */
  outboundDeliveryTimeoutMs: number;
  /** Timeout for the HTTP call to the developer's chat endpoint (ms). */
  chatEndpointTimeoutMs: number;
  /** TTL for the inbound dedupe key in the store (seconds). */
  dedupeTtlSeconds: number;
  /**
   * Timeout for the optional identity-enrichment HTTP call to
   * `USER_LOOKUP_URL` (ms). Lives in the conversation group alongside
   * `chatEndpointTimeoutMs` because, like the chat call, the lookup sits inline
   * on the inbound path. Always has a default; only consulted when
   * {@link Config.userLookupUrl} is set. Identity resolution is fail-open, so a
   * hit on this timeout drops enrichment rather than blocking the turn.
   */
  userLookupTimeoutMs: number;
  /**
   * OPT-IN inbound media hydration. When `true`, the transport downloads inbound
   * media on the flush path (it holds the per-channel access tokens the chat
   * endpoint does not) and attaches a base64 data URL to the chat request, so the
   * endpoint can actually "see" WhatsApp images (which arrive as a bare media id,
   * not a fetchable URL). DEFAULT `false`: base64 inflates every request body
   * carrying media (~33% over the raw bytes), so it stays off until explicitly
   * enabled. Lives in the conversation group because, like the chat call, the
   * download sits inline on the inbound→chat path.
   */
  inboundMediaDownload: boolean;
  /**
   * Hard cap (bytes) on a single piece of inbound media to hydrate. Media larger
   * than this is left as id/url (NOT base64-attached) and logged — protecting the
   * chat request from an unbounded base64 blob. DEFAULT 5 MiB. Only consulted
   * when {@link inboundMediaDownload} is `true`.
   */
  inboundMediaMaxBytes: number;
}

/**
 * Stage 10 Redis-backed persistence + BullMQ scheduler tuning. Only consulted
 * when REDIS_URL is set. Every field has a default; the loader validates ranges
 * and throws with the offending env var name on a malformed value (fail-fast,
 * no logging) — same posture as {@link ConversationConfig}.
 */
export interface PersistenceConfig {
  /** TTL (seconds) for Redis conversation records + outbound-handle mappings. Default 86400 (1 day). */
  conversationTtlSeconds: number;
  /** BullMQ queue name for the buffer-flush scheduler. Default 'meta-ai-buffer-timers'. */
  bufferQueueName: string;
  /**
   * BullMQ Worker concurrency for buffer-flush jobs. Default 10. WHY > 1: the
   * flush handler awaits the (slow) chat-endpoint call, and a concurrency of 1
   * would serialize EVERY conversation's flush behind one in-flight chat call —
   * unlike the in-memory scheduler, whose independent setTimeouts interleave
   * flushes across conversations. Parallel flushes are safe because each acquires
   * only its per-conversation key lock. Tune up for higher concurrent-conversation
   * throughput.
   */
  bufferWorkerConcurrency: number;
  /** Timeout (ms) for the GET /ready Redis ping. Default 2000. */
  readyRedisTimeoutMs: number;
}

/**
 * Stage 10 per-channel outbound rate limiting + transient retry. Pacing values
 * are non-negative (0 disables pacing for that channel); the retry knobs are
 * positive ints with a `base <= max` cross-field check.
 */
export interface LimitsConfig {
  /**
   * Outbound pacing (messages/sec) per channel. 0 disables pacing for that channel.
   * Defaults are conservative and well under Meta's documented per-channel send
   * caps (WhatsApp default throughput 80 mps → up to 1000; Messenger 300/s text;
   * Instagram 100/s text, 10/s media). The Instagram default (10) matches both the
   * IG media cap AND the InstagramClient's own ~10/s in-process pacer floor so the
   * two layers stay aligned — note 2/s is the *general* Graph baseline, NOT the
   * messaging limit, so it would over-throttle.
   */
  whatsappPerSecond: number;   // default 80
  messengerPerSecond: number;  // default 40
  instagramPerSecond: number;  // default 10
  /**
   * TRACK-ONLY per-hour / per-day outbound counters per channel. Unlike the
   * per-second pacing above, these NEVER gate a send — the tracker only
   * warn/error-logs as the line nears the cap, giving operators advance notice
   * before Meta starts server-side rejecting at the messaging-tier cap. `0`
   * disables that window (no logging).
   *
   * Defaults are deliberately conservative and Meta-aware. WhatsApp's caps are
   * conversation-based (tiered: 1K/10K/100K/unlimited unique recipients in 24h
   * AFTER business verification) rather than a flat message count, so a single
   * per-hour/per-day MESSAGE count is only an advisory proxy — we default to a
   * conservative WhatsApp 1000/h, 10000/d so an unverified or Tier-1 number gets
   * an early warning. Messenger/Instagram have no comparable published per-day
   * MESSAGE cap (their constraint is the 24h window + per-second throughput), so
   * they default to `0` (disabled) — set them only if an operator wants a custom
   * advisory ceiling. Per-hour MUST be <= per-day when both are > 0 (validated).
   */
  whatsappPerHour: number;     // default 1000
  whatsappPerDay: number;      // default 10000
  messengerPerHour: number;    // default 0 (disabled)
  messengerPerDay: number;     // default 0 (disabled)
  instagramPerHour: number;    // default 0 (disabled)
  instagramPerDay: number;     // default 0 (disabled)
  /** Max transient-retry attempts after the first send. Default 3. */
  transientRetryMaxAttempts: number;
  /** Base backoff (ms) for transient retry. Default 1000. */
  transientRetryBaseMs: number;
  /** Max backoff (ms) for transient retry. Default 60000. */
  transientRetryMaxMs: number;
}

export interface Config {
  meta: MetaConfig;
  whatsapp?: WhatsAppConfig;
  messenger?: MessengerConfig;
  instagram?: InstagramConfig;
  channels: Channels;
  conversation: ConversationConfig;
  persistence: PersistenceConfig;
  limits: LimitsConfig;
  chatEndpointUrl: string;
  /**
   * Optional. Developer-provided endpoint for identity enrichment — the
   * resolver POSTs `{ channel, channelScopedUserId, channelScopedBusinessId }`
   * and shapes the JSON response into a `Contact`. OPTIONAL because enrichment
   * is a fail-open add-on: when unset the agent runs a no-op resolver and every
   * conversation simply proceeds without contact info. When set it must parse
   * as a URL (validated at load time, like `chatEndpointUrl`); the per-call
   * timeout is `conversation.userLookupTimeoutMs`.
   */
  userLookupUrl?: string;
  redisUrl?: string;
  adminApiToken?: string;
  publicBaseUrl?: string;
  /**
   * Reserved static ngrok domain (bare hostname, e.g. `foo.ngrok-free.app`).
   *
   * REQUIRED rather than optional because the Meta App Dashboard anchors
   * three separate webhook callback URL registrations (WhatsApp, Messenger,
   * Instagram) plus the Instagram Business Login OAuth redirect URI to a
   * single public domain. Re-registering all four across the Dashboard every
   * time an ephemeral ngrok URL rotates is the dominant pain point of the
   * setup loop; pinning a free static domain (one is included on every ngrok
   * account at https://dashboard.ngrok.com/cloud-edge/domains) eliminates it.
   */
  ngrokDomain: string;
  agentAutostart: boolean;
  port: number;
  nodeEnv: string;
}

function trimmed(env: ConfigEnv, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const value = raw.trim();
  return value === '' ? undefined : value;
}

function requireEnv(env: ConfigEnv, name: string): string {
  const value = trimmed(env, name);
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// A channel is "configured" when ALL of its REQUIRED credentials are present.
// When only one of the pair is set we throw rather than silently disabling —
// a half-configured channel almost always means a typo or copy/paste mistake.
//
// `Required` is the type of the REQUIRED env vars (each maps to a non-optional
// string), and `Out` is the final exported config shape — which may layer in
// optional fields the `map` function reads directly from `env`.
function loadChannelCredentials<Required, Out = Required>(
  env: ConfigEnv,
  channel: string,
  fields: Record<keyof Required, string>,
  map: (values: Record<keyof Required, string>) => Out
): Out | undefined {
  const entries = Object.entries(fields) as Array<[keyof Required, string]>;
  const resolved: Partial<Record<keyof Required, string>> = {};
  const present: string[] = [];
  const missing: string[] = [];
  for (const [key, envName] of entries) {
    const value = trimmed(env, envName);
    if (value === undefined) {
      missing.push(envName);
    } else {
      resolved[key] = value;
      present.push(envName);
    }
  }
  if (present.length === 0) return undefined;
  if (missing.length > 0) {
    throw new Error(
      `Partial ${channel} configuration: ${present.join(', ')} set but missing ${missing.join(', ')}.`
    );
  }
  return map(resolved as Record<keyof Required, string>);
}

function loadGraphApiVersion(env: ConfigEnv): string {
  const raw = trimmed(env, 'META_GRAPH_API_VERSION');
  // Default tracks Meta's currently-supported set (Meta retires Graph API
  // versions on a ~24-month cadence). v25.0 is the latest stable as of this
  // package's release; bump when a newer version stabilizes.
  if (raw === undefined) return 'v25.0';
  if (!/^v\d+\.\d+$/.test(raw)) {
    throw new Error(
      `Invalid META_GRAPH_API_VERSION: ${raw}. Expected format "v<major>.<minor>" (e.g. v25.0).`
    );
  }
  return raw;
}

const NGROK_DOMAIN_MISSING_REMEDIATION =
  'Missing required NGROK_DOMAIN. Reserve a free static domain at ' +
  'https://dashboard.ngrok.com/cloud-edge/domains and set NGROK_DOMAIN to the ' +
  'bare hostname (e.g. NGROK_DOMAIN=foo.ngrok-free.app) — no https:// scheme.';

function loadNgrokDomain(env: ConfigEnv): string {
  const raw = trimmed(env, 'NGROK_DOMAIN');
  if (raw === undefined) {
    throw new Error(NGROK_DOMAIN_MISSING_REMEDIATION);
  }
  // The @ngrok/ngrok SDK accepts `domain` as a bare hostname only and
  // rejects values with a scheme or path. We surface that rejection at
  // config load time so the developer sees the actual remediation rather
  // than a generic "ngrok refused to start" error six layers deeper.
  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    throw new Error(
      `Invalid NGROK_DOMAIN: ${raw}. Use a bare hostname (no https:// scheme), e.g. foo.ngrok-free.app.`
    );
  }
  // No path or query segments — `domain` is a DNS name, not a URL.
  if (raw.includes('/') || raw.includes('?')) {
    throw new Error(
      `Invalid NGROK_DOMAIN: ${raw}. Use a bare hostname only — no path or query (e.g. foo.ngrok-free.app, not foo.ngrok-free.app/webhook).`
    );
  }
  // Must include a dot so we reject obvious typos like `myapp` (which would
  // pass any TLD-agnostic check). We intentionally do NOT pin a specific
  // TLD: free domains end in `.ngrok-free.app` or `.ngrok-free.dev`, paid
  // are `.ngrok.app`, and custom CNAMEs can use anything.
  if (!raw.includes('.')) {
    throw new Error(
      `Invalid NGROK_DOMAIN: ${raw}. Expected a fully-qualified hostname (e.g. foo.ngrok-free.app).`
    );
  }
  return raw;
}

function loadPort(env: ConfigEnv): number {
  const raw = trimmed(env, 'PORT');
  if (raw === undefined) return 3000;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || String(parsed) !== raw || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid PORT: ${raw}. Expected integer between 1 and 65535.`);
  }
  return parsed;
}

/**
 * Parse a boolean env var accepting `1`/`0`/`true`/`false` (case-insensitive).
 * Returns `fallback` when unset/empty; throws with the var name otherwise.
 * Factored out so every boolean knob parses identically.
 */
function loadBoolean(env: ConfigEnv, name: string, fallback: boolean): boolean {
  const raw = trimmed(env, name);
  if (raw === undefined) return fallback;
  const normalized = raw.toLowerCase();
  if (normalized === '1' || normalized === 'true') return true;
  if (normalized === '0' || normalized === 'false') return false;
  throw new Error(`Invalid ${name}: ${raw}. Expected one of "1", "0", "true", "false".`);
}

function loadAgentAutostart(env: ConfigEnv): boolean {
  // Delegates to the shared boolean parser; behavior + accepted tokens are
  // unchanged (the error message still names AGENT_AUTOSTART).
  return loadBoolean(env, 'AGENT_AUTOSTART', true);
}

/**
 * Parse a strictly-positive integer env var (value >= 1). Returns `fallback`
 * when unset/empty; throws with the var name on a non-integer or value < 1.
 */
function loadPositiveInt(env: ConfigEnv, name: string, fallback: number): number {
  const raw = trimmed(env, name);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || String(parsed) !== raw || parsed < 1) {
    throw new Error(`Invalid ${name}: ${raw}. Expected a positive integer (>= 1).`);
  }
  return parsed;
}

/**
 * Parse a non-negative integer env var (value >= 0). Returns `fallback` when
 * unset/empty; throws with the var name on a non-integer or negative value.
 * Used for the track-only per-hour/per-day MESSAGE-count caps, where 0 is a
 * meaningful value (disables that advisory window).
 */
function loadNonNegativeInt(env: ConfigEnv, name: string, fallback: number): number {
  const raw = trimmed(env, name);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || String(parsed) !== raw || parsed < 0) {
    throw new Error(`Invalid ${name}: ${raw}. Expected a non-negative integer (>= 0).`);
  }
  return parsed;
}

/**
 * Parse a float env var constrained to `[min, max]` (inclusive). Returns
 * `fallback` when unset/empty; throws with the var name on a non-finite value
 * or one outside the range.
 */
function loadFloatInRange(
  env: ConfigEnv,
  name: string,
  fallback: number,
  min: number,
  max: number
): number {
  const raw = trimmed(env, name);
  if (raw === undefined) return fallback;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid ${name}: ${raw}. Expected a number between ${min} and ${max}.`);
  }
  return parsed;
}

/**
 * Parse a non-negative float env var (value >= 0, finite). Returns `fallback`
 * when unset/empty; throws with the var name on a non-finite or negative value.
 * Used for the per-channel rate-limit pacing knobs, where 0 is a meaningful
 * value (disables pacing for that channel).
 */
function loadNonNegativeFloat(env: ConfigEnv, name: string, fallback: number): number {
  const raw = trimmed(env, name);
  if (raw === undefined) return fallback;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid ${name}: ${raw}. Expected a non-negative number (>= 0).`);
  }
  return parsed;
}

/**
 * Documented defaults for {@link ConversationConfig}. Kept as a single source
 * of truth so the loader fallbacks and {@link defaultConversationConfig} can
 * never drift, and so the values match `.env.example` and the plan (lines
 * 835-838 of the implementation plan).
 */
const CONVERSATION_DEFAULTS: ConversationConfig = {
  bufferBaseTimeoutMs: 2000,
  bufferGrowthFactor: 1.25,
  bufferMaxTimeoutMs: 8000,
  bufferNoiseMaxDeviation: 0.3,
  outboundTypingIndicatorsEnabled: true,
  typingRefreshIntervalMs: 5000,
  typingRefreshMaxMs: 120000,
  readReceiptsEnabled: false,
  outboundDeliveryTimeoutMs: 30000,
  chatEndpointTimeoutMs: 30000,
  dedupeTtlSeconds: 86400,
  userLookupTimeoutMs: 5000,
  // Opt-in: off by default so the base64 cost is never paid unless asked for.
  inboundMediaDownload: false,
  inboundMediaMaxBytes: 5_242_880 // 5 MiB
};

/**
 * The {@link ConversationConfig} defaults as a fresh object — handy for tests
 * and for callers assembling a `Config` without a full env. Returns a copy so
 * mutation cannot corrupt the shared constant.
 */
export function defaultConversationConfig(): ConversationConfig {
  return { ...CONVERSATION_DEFAULTS };
}

function loadConversationConfig(env: ConfigEnv): ConversationConfig {
  const d = CONVERSATION_DEFAULTS;
  const bufferBaseTimeoutMs = loadPositiveInt(env, 'BUFFER_BASE_TIMEOUT_MS', d.bufferBaseTimeoutMs);
  const bufferMaxTimeoutMs = loadPositiveInt(env, 'BUFFER_MAX_TIMEOUT_MS', d.bufferMaxTimeoutMs);
  // Cross-field check, matching the existing fail-fast philosophy: a max below
  // the base would let the growth math produce a window shorter than the first
  // flush, which is always a misconfiguration.
  if (bufferMaxTimeoutMs < bufferBaseTimeoutMs) {
    throw new Error(
      `Invalid BUFFER_MAX_TIMEOUT_MS: ${bufferMaxTimeoutMs} is less than BUFFER_BASE_TIMEOUT_MS (${bufferBaseTimeoutMs}). The max must be >= the base.`
    );
  }

  return {
    bufferBaseTimeoutMs,
    bufferGrowthFactor: loadFloatInRange(env, 'BUFFER_GROWTH_FACTOR', d.bufferGrowthFactor, 1, Number.MAX_VALUE),
    bufferMaxTimeoutMs,
    bufferNoiseMaxDeviation: loadFloatInRange(env, 'BUFFER_NOISE_MAX_DEVIATION', d.bufferNoiseMaxDeviation, 0, 1),
    outboundTypingIndicatorsEnabled: loadBoolean(env, 'OUTBOUND_TYPING_INDICATORS_ENABLED', d.outboundTypingIndicatorsEnabled),
    typingRefreshIntervalMs: loadPositiveInt(env, 'TYPING_REFRESH_INTERVAL_MS', d.typingRefreshIntervalMs),
    typingRefreshMaxMs: loadPositiveInt(env, 'TYPING_REFRESH_MAX_MS', d.typingRefreshMaxMs),
    readReceiptsEnabled: loadBoolean(env, 'READ_RECEIPTS_ENABLED', d.readReceiptsEnabled),
    outboundDeliveryTimeoutMs: loadPositiveInt(env, 'OUTBOUND_DELIVERY_TIMEOUT_MS', d.outboundDeliveryTimeoutMs),
    chatEndpointTimeoutMs: loadPositiveInt(env, 'CHAT_ENDPOINT_TIMEOUT_MS', d.chatEndpointTimeoutMs),
    dedupeTtlSeconds: loadPositiveInt(env, 'DEDUPE_TTL_SECONDS', d.dedupeTtlSeconds),
    userLookupTimeoutMs: loadPositiveInt(env, 'USER_LOOKUP_TIMEOUT_MS', d.userLookupTimeoutMs),
    inboundMediaDownload: loadBoolean(env, 'INBOUND_MEDIA_DOWNLOAD', d.inboundMediaDownload),
    inboundMediaMaxBytes: loadPositiveInt(env, 'INBOUND_MEDIA_MAX_BYTES', d.inboundMediaMaxBytes)
  };
}

/**
 * Documented defaults for {@link PersistenceConfig}. Single source of truth so
 * the loader fallbacks and {@link defaultPersistenceConfig} can never drift, and
 * so the values match `.env.example`.
 */
const PERSISTENCE_DEFAULTS: PersistenceConfig = {
  conversationTtlSeconds: 86400, // 1 day
  bufferQueueName: 'meta-ai-buffer-timers',
  bufferWorkerConcurrency: 10,
  readyRedisTimeoutMs: 2000
};

/**
 * The {@link PersistenceConfig} defaults as a fresh object — handy for tests and
 * for callers assembling a `Config` without a full env. Returns a copy so
 * mutation cannot corrupt the shared constant.
 */
export function defaultPersistenceConfig(): PersistenceConfig {
  return { ...PERSISTENCE_DEFAULTS };
}

function loadPersistenceConfig(env: ConfigEnv): PersistenceConfig {
  const d = PERSISTENCE_DEFAULTS;
  return {
    conversationTtlSeconds: loadPositiveInt(env, 'CONVERSATION_TTL_SECONDS', d.conversationTtlSeconds),
    bufferQueueName: trimmed(env, 'BUFFER_QUEUE_NAME') ?? d.bufferQueueName,
    bufferWorkerConcurrency: loadPositiveInt(env, 'BUFFER_WORKER_CONCURRENCY', d.bufferWorkerConcurrency),
    readyRedisTimeoutMs: loadPositiveInt(env, 'READY_REDIS_TIMEOUT_MS', d.readyRedisTimeoutMs)
  };
}

/**
 * Documented defaults for {@link LimitsConfig}. Single source of truth so the
 * loader fallbacks and {@link defaultLimitsConfig} can never drift, and so the
 * values match `.env.example`.
 */
const LIMITS_DEFAULTS: LimitsConfig = {
  whatsappPerSecond: 80,
  messengerPerSecond: 40,
  instagramPerSecond: 10,
  whatsappPerHour: 1000,
  whatsappPerDay: 10000,
  messengerPerHour: 0,
  messengerPerDay: 0,
  instagramPerHour: 0,
  instagramPerDay: 0,
  transientRetryMaxAttempts: 3,
  transientRetryBaseMs: 1000,
  transientRetryMaxMs: 60000
};

/**
 * The {@link LimitsConfig} defaults as a fresh object — handy for tests and for
 * callers assembling a `Config` without a full env. Returns a copy so mutation
 * cannot corrupt the shared constant.
 */
export function defaultLimitsConfig(): LimitsConfig {
  return { ...LIMITS_DEFAULTS };
}

function loadLimitsConfig(env: ConfigEnv): LimitsConfig {
  const d = LIMITS_DEFAULTS;
  const transientRetryBaseMs = loadPositiveInt(env, 'TRANSIENT_RETRY_BASE_MS', d.transientRetryBaseMs);
  const transientRetryMaxMs = loadPositiveInt(env, 'TRANSIENT_RETRY_MAX_MS', d.transientRetryMaxMs);
  // Cross-field check, matching the existing fail-fast philosophy (cf. the
  // buffer max>=base check): a base above the max would let backoff math start
  // beyond its own ceiling, which is always a misconfiguration.
  if (transientRetryBaseMs > transientRetryMaxMs) {
    throw new Error(
      `Invalid TRANSIENT_RETRY_BASE_MS: ${transientRetryBaseMs} is greater than TRANSIENT_RETRY_MAX_MS (${transientRetryMaxMs}). The base must be <= the max.`
    );
  }

  // Track-only per-hour / per-day MESSAGE-count caps (0 disables the window).
  const whatsappPerHour = loadNonNegativeInt(env, 'WHATSAPP_RATE_LIMIT_PER_HOUR', d.whatsappPerHour);
  const whatsappPerDay = loadNonNegativeInt(env, 'WHATSAPP_RATE_LIMIT_PER_DAY', d.whatsappPerDay);
  const messengerPerHour = loadNonNegativeInt(env, 'MESSENGER_RATE_LIMIT_PER_HOUR', d.messengerPerHour);
  const messengerPerDay = loadNonNegativeInt(env, 'MESSENGER_RATE_LIMIT_PER_DAY', d.messengerPerDay);
  const instagramPerHour = loadNonNegativeInt(env, 'INSTAGRAM_RATE_LIMIT_PER_HOUR', d.instagramPerHour);
  const instagramPerDay = loadNonNegativeInt(env, 'INSTAGRAM_RATE_LIMIT_PER_DAY', d.instagramPerDay);

  // Cross-field check per channel, mirroring the base<=max philosophy: an hourly
  // cap above the daily cap is always a misconfiguration (the hour window would
  // warn/error after the day window already did). Only enforced when BOTH are
  // > 0, since 0 means "that window is disabled".
  for (const { hourVar, hour, dayVar, day } of [
    { hourVar: 'WHATSAPP_RATE_LIMIT_PER_HOUR', hour: whatsappPerHour, dayVar: 'WHATSAPP_RATE_LIMIT_PER_DAY', day: whatsappPerDay },
    { hourVar: 'MESSENGER_RATE_LIMIT_PER_HOUR', hour: messengerPerHour, dayVar: 'MESSENGER_RATE_LIMIT_PER_DAY', day: messengerPerDay },
    { hourVar: 'INSTAGRAM_RATE_LIMIT_PER_HOUR', hour: instagramPerHour, dayVar: 'INSTAGRAM_RATE_LIMIT_PER_DAY', day: instagramPerDay }
  ]) {
    if (hour > 0 && day > 0 && hour > day) {
      throw new Error(
        `Invalid ${hourVar}: ${hour} is greater than ${dayVar} (${day}). The per-hour cap must be <= the per-day cap.`
      );
    }
  }

  return {
    whatsappPerSecond: loadNonNegativeFloat(env, 'WHATSAPP_RATE_LIMIT_PER_SECOND', d.whatsappPerSecond),
    messengerPerSecond: loadNonNegativeFloat(env, 'MESSENGER_RATE_LIMIT_PER_SECOND', d.messengerPerSecond),
    instagramPerSecond: loadNonNegativeFloat(env, 'INSTAGRAM_RATE_LIMIT_PER_SECOND', d.instagramPerSecond),
    whatsappPerHour,
    whatsappPerDay,
    messengerPerHour,
    messengerPerDay,
    instagramPerHour,
    instagramPerDay,
    transientRetryMaxAttempts: loadPositiveInt(env, 'TRANSIENT_RETRY_MAX_ATTEMPTS', d.transientRetryMaxAttempts),
    transientRetryBaseMs,
    transientRetryMaxMs
  };
}

function loadChatEndpointUrl(env: ConfigEnv): string {
  const raw = requireEnv(env, 'CHAT_ENDPOINT_URL');
  try {
    new URL(raw);
  } catch {
    throw new Error(`Invalid CHAT_ENDPOINT_URL: ${raw}. Expected a parseable URL.`);
  }
  return raw;
}

/**
 * Load the OPTIONAL `USER_LOOKUP_URL` for identity enrichment. Unset/blank ->
 * `undefined` (enrichment disabled; the agent uses a no-op resolver). When
 * present it must parse as a URL — we fail fast with the var name (same posture
 * as `CHAT_ENDPOINT_URL`) so a typo'd lookup endpoint is caught at boot rather
 * than silently swallowed by the resolver's fail-open path on every inbound.
 */
function loadUserLookupUrl(env: ConfigEnv): string | undefined {
  const raw = trimmed(env, 'USER_LOOKUP_URL');
  if (raw === undefined) return undefined;
  try {
    new URL(raw);
  } catch {
    throw new Error(`Invalid USER_LOOKUP_URL: ${raw}. Expected a parseable URL.`);
  }
  return raw;
}

/**
 * Load the OPTIONAL `REDIS_URL`. Unset/blank -> `undefined` (Stage 10 Redis
 * persistence disabled; the in-memory store/scheduler are used). When present it
 * must parse as a URL AND use the `redis:` or `rediss:` (TLS) protocol — we fail
 * fast with the var name so a typo'd or wrong-scheme URL (e.g. an http:// paste)
 * is caught at boot rather than surfacing as an opaque connection error deep in
 * the Stage 10 client. Returns the trimmed string on success.
 */
function loadRedisUrl(env: ConfigEnv): string | undefined {
  const raw = trimmed(env, 'REDIS_URL');
  if (raw === undefined) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid REDIS_URL: ${raw}. Expected a parseable redis:// or rediss:// URL.`);
  }
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw new Error(
      `Invalid REDIS_URL: ${raw}. Expected the redis:// or rediss:// scheme (got "${parsed.protocol}").`
    );
  }
  return raw;
}

function loadVerifyToken(env: ConfigEnv): string {
  const value = requireEnv(env, 'META_VERIFY_TOKEN');
  if (value.length < 16) {
    throw new Error(
      `Invalid META_VERIFY_TOKEN: must be at least 16 characters (got ${value.length}).`
    );
  }
  return value;
}

/**
 * Load the OPTIONAL `ADMIN_API_TOKEN`. Unset/blank -> `undefined` (the admin
 * routes simply don't mount — see `createApp`). When SET it gates PII-bearing
 * admin introspection (`/metrics`, `/admin/*`), so we enforce a 16-char floor —
 * the same minimum as `META_VERIFY_TOKEN` — and recommend >=32. A trivially
 * short bearer token guarding conversation PII is a foot-gun we fail fast on at
 * boot rather than ship.
 */
function loadAdminApiToken(env: ConfigEnv): string | undefined {
  const value = trimmed(env, 'ADMIN_API_TOKEN');
  if (value === undefined) return undefined;
  if (value.length < 16) {
    throw new Error(
      `Invalid ADMIN_API_TOKEN: must be at least 16 characters (got ${value.length}). ` +
        'This token guards PII-bearing admin routes; use a high-entropy secret of >=32 characters.'
    );
  }
  return value;
}

export function loadConfig(env: ConfigEnv = process.env): Config {
  const meta: MetaConfig = {
    appId: trimmed(env, 'META_APP_ID'),
    appSecret: requireEnv(env, 'META_APP_SECRET'),
    verifyToken: loadVerifyToken(env),
    graphApiVersion: loadGraphApiVersion(env)
  };

  const whatsapp = loadChannelCredentials<{ phoneNumberId: string; accessToken: string }, WhatsAppConfig>(
    env,
    'WhatsApp',
    { phoneNumberId: 'WHATSAPP_PHONE_NUMBER_ID', accessToken: 'WHATSAPP_ACCESS_TOKEN' },
    values => {
      // `WHATSAPP_BUSINESS_ACCOUNT_ID` is OPTIONAL — the channel is fully
      // considered configured without it (token + phone number id are enough
      // for runtime messaging). The WABA id only unlocks the programmatic
      // per-WABA webhook subscription path in `register-webhooks.ts`.
      const businessAccountId = trimmed(env, 'WHATSAPP_BUSINESS_ACCOUNT_ID');
      return {
        phoneNumberId: values.phoneNumberId,
        accessToken: values.accessToken,
        ...(businessAccountId !== undefined ? { businessAccountId } : {})
      };
    }
  );
  const messenger = loadChannelCredentials<MessengerConfig>(
    env,
    'Messenger',
    { pageId: 'MESSENGER_PAGE_ID', pageAccessToken: 'MESSENGER_PAGE_ACCESS_TOKEN' },
    values => ({ pageId: values.pageId, pageAccessToken: values.pageAccessToken })
  );
  const instagram = loadChannelCredentials<
    { userId: string; accessToken: string },
    InstagramConfig
  >(
    env,
    'Instagram',
    { userId: 'INSTAGRAM_USER_ID', accessToken: 'INSTAGRAM_ACCESS_TOKEN' },
    values => {
      // `INSTAGRAM_APP_SECRET` is OPTIONAL — the channel is fully considered
      // configured without it (userId + accessToken are enough for the channel
      // to be "enabled"). It is needed only to verify INBOUND Instagram webhook
      // signatures, which Meta signs with this secret rather than
      // `META_APP_SECRET`. We deliberately do NOT throw when it is missing on an
      // enabled IG channel (that would break WhatsApp+Messenger-only setups and
      // any partial pre-existing config); the loader is pure (no logging), so
      // it surfaces the value as `string | undefined` and lets `app.ts` warn at
      // startup. See the `InstagramConfig.appSecret` doc comment.
      const appSecret = trimmed(env, 'INSTAGRAM_APP_SECRET');
      return {
        userId: values.userId,
        accessToken: values.accessToken,
        ...(appSecret !== undefined ? { appSecret } : {})
      };
    }
  );

  const channels: Channels = {
    whatsapp: whatsapp !== undefined,
    messenger: messenger !== undefined,
    instagram: instagram !== undefined
  };

  if (!channels.whatsapp && !channels.messenger && !channels.instagram) {
    throw new Error(
      'No messaging channel configured. Set credentials for at least one of WhatsApp ' +
        '(WHATSAPP_PHONE_NUMBER_ID + WHATSAPP_ACCESS_TOKEN), Messenger ' +
        '(MESSENGER_PAGE_ID + MESSENGER_PAGE_ACCESS_TOKEN), or Instagram ' +
        '(INSTAGRAM_USER_ID + INSTAGRAM_ACCESS_TOKEN).'
    );
  }

  return {
    meta,
    whatsapp,
    messenger,
    instagram,
    channels,
    conversation: loadConversationConfig(env),
    persistence: loadPersistenceConfig(env),
    limits: loadLimitsConfig(env),
    chatEndpointUrl: loadChatEndpointUrl(env),
    userLookupUrl: loadUserLookupUrl(env),
    redisUrl: loadRedisUrl(env),
    adminApiToken: loadAdminApiToken(env),
    publicBaseUrl: trimmed(env, 'PUBLIC_BASE_URL'),
    ngrokDomain: loadNgrokDomain(env),
    agentAutostart: loadAgentAutostart(env),
    port: loadPort(env),
    nodeEnv: trimmed(env, 'NODE_ENV') ?? 'development'
  };
}

export interface TokenFormatWarning {
  field: string;
  message: string;
}

/**
 * Heuristic, NON-FATAL checks on Meta access-token shapes. Returns warnings, never throws —
 * Meta token formats vary and a false reject would break a working deploy, so these are
 * advisory only (createApp logs them at startup). Checks:
 *  - Messenger Page Access Token usually starts with 'EAA'.
 *  - Instagram (Business Login) user token usually starts with 'IGQ'.
 *  - WhatsApp access token should be a long (>=20 chars) token.
 * Each check fires ONLY when the channel is configured.
 *
 * Deliberately NOT called from `loadConfig` (which is pure and fail-fast) — the
 * loader stays logging-free; `createApp` consumes these and logs them.
 */
export function tokenFormatWarnings(config: Config): TokenFormatWarning[] {
  const warnings: TokenFormatWarning[] = [];

  if (config.whatsapp && config.whatsapp.accessToken.length < 20) {
    warnings.push({
      field: 'WHATSAPP_ACCESS_TOKEN',
      message:
        'WhatsApp access token looks unusually short (<20 chars). Expected a long ' +
        'System User / Cloud API token; double-check it was copied in full.'
    });
  }

  if (config.messenger && !config.messenger.pageAccessToken.startsWith('EAA')) {
    warnings.push({
      field: 'MESSENGER_PAGE_ACCESS_TOKEN',
      message:
        'Messenger Page Access Token does not start with "EAA". Page tokens minted ' +
        'via the Dashboard / Facebook Login for Business normally begin with "EAA"; ' +
        'verify you used a Page token (not an App or User token).'
    });
  }

  if (config.instagram && !config.instagram.accessToken.startsWith('IGQ')) {
    warnings.push({
      field: 'INSTAGRAM_ACCESS_TOKEN',
      message:
        'Instagram access token does not start with "IGQ". Instagram Business Login ' +
        'user tokens normally begin with "IGQ"; verify you used the long-lived IG ' +
        'token from the OAuth flow.'
    });
  }

  return warnings;
}
