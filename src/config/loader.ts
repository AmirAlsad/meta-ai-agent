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
}

export interface Config {
  meta: MetaConfig;
  whatsapp?: WhatsAppConfig;
  messenger?: MessengerConfig;
  instagram?: InstagramConfig;
  channels: Channels;
  conversation: ConversationConfig;
  chatEndpointUrl: string;
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
  dedupeTtlSeconds: 86400
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
    dedupeTtlSeconds: loadPositiveInt(env, 'DEDUPE_TTL_SECONDS', d.dedupeTtlSeconds)
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

function loadVerifyToken(env: ConfigEnv): string {
  const value = requireEnv(env, 'META_VERIFY_TOKEN');
  if (value.length < 16) {
    throw new Error(
      `Invalid META_VERIFY_TOKEN: must be at least 16 characters (got ${value.length}).`
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
    chatEndpointUrl: loadChatEndpointUrl(env),
    redisUrl: trimmed(env, 'REDIS_URL'),
    adminApiToken: trimmed(env, 'ADMIN_API_TOKEN'),
    publicBaseUrl: trimmed(env, 'PUBLIC_BASE_URL'),
    ngrokDomain: loadNgrokDomain(env),
    agentAutostart: loadAgentAutostart(env),
    port: loadPort(env),
    nodeEnv: trimmed(env, 'NODE_ENV') ?? 'development'
  };
}
