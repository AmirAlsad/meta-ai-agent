import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express, { type Request, type Response, type NextFunction } from 'express';
import type pino from 'pino';
import type { Config } from '../config/loader.js';
import { tokenFormatWarnings } from '../config/loader.js';
import { createMetaSignatureVerifier } from './security.js';
import { traceMiddleware, requestContextFromLocals } from './trace.js';
import { validateAdminToken } from './auth.js';
import { redactConversationRecord, redactStatusRecord } from './redaction.js';
import { parseMetaWebhook } from '../meta/parser.js';
import type { IncomingMessage, ParseResult, StatusUpdate } from '../meta/types.js';
import type { ConversationAgent } from '../conversation/agent.js';
import type { AgentMetrics } from '../metrics/registry.js';
import type { MetricsCollector } from '../metrics/collector.js';
import { renderPrometheus, PROMETHEUS_CONTENT_TYPE } from '../metrics/prometheus.js';
import type { StatusTracker } from '../status/tracker.js';
import type { ConversationStore } from '../conversation/store.js';
import type { BufferScheduler } from '../conversation/scheduler.js';

/**
 * Minimal structural shape of an ioredis client for the GET /ready ping. Defined
 * here (rather than importing ioredis's `Redis` into this module) so app.ts stays
 * free of the ioredis dependency — ioredis's `Redis` is structurally assignable.
 */
export interface RedisPinger {
  ping(): Promise<unknown>;
}

export interface AppDeps {
  config: Config;
  logger: pino.Logger;
  /**
   * Stage 5 conversation agent. OPTIONAL so existing unit/integration tests can
   * construct the app with parse+log behavior only (no agent). When present,
   * every parsed inbound message/status is routed into it after logging — see
   * {@link dispatchWebhook}.
   */
  agent?: ConversationAgent;
  /**
   * Stage 6 observability deps — ALL OPTIONAL so the Stage 5 call sites
   * (`createApp({config, logger})` / `createApp({config, logger, agent})`) keep
   * compiling and behaving exactly as before. Each one independently gates a
   * piece of the observability surface:
   *  - `metrics`          → webhook counters on the POST /webhook path.
   *  - `metricsCollector` → required (with adminApiToken) to MOUNT GET /metrics.
   *  - `statusTracker`    → required (with adminApiToken) to MOUNT GET /admin/status.
   *  - `store`            → required (with adminApiToken) to MOUNT GET /admin/conversations.
   *  - `scheduler`        → drives the GET /ready dependency check.
   *  - `redisClient`      → when supplied (the Redis persistence path), GET /ready
   *                         PINGS it; absent ⇒ the redis check is presence-only.
   */
  metrics?: AgentMetrics;
  metricsCollector?: MetricsCollector;
  statusTracker?: StatusTracker;
  store?: ConversationStore;
  scheduler?: BufferScheduler;
  redisClient?: RedisPinger;
}

/**
 * Channel union used by the route-level summary log. Wider than the parser's
 * `Channel` because we still log `'unknown'` at the channel-summary level for
 * payloads with no recognized `object` discriminator.
 */
export type Channel = 'whatsapp' | 'messenger' | 'instagram' | 'unknown';

type RawBodyRequest = Request & { rawBody?: Buffer };

export const PACKAGE_VERSION: string = (() => {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.resolve(here, '../../package.json');
    const raw = readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : '0.1.0';
  } catch {
    return '0.1.0';
  }
})();

export function objectToChannel(object: unknown): Channel {
  if (object === 'whatsapp_business_account') return 'whatsapp';
  if (object === 'page') return 'messenger';
  if (object === 'instagram') return 'instagram';
  return 'unknown';
}

/**
 * Parse the webhook body and emit structured logs for the dispatcher.
 *
 * Emits three log shapes:
 *  1. One per-channel summary log (`inbound.{channel}`) — backwards-compat
 *     with the Stage 1 integration tests and the only log shape that fires
 *     for unknown / empty payloads.
 *  2. One per-message log (`inbound.message`) for every parsed `IncomingMessage`.
 *  3. One per-status log (`inbound.status`) for every parsed `StatusUpdate`.
 *
 * When an {@link ConversationAgent} is supplied, each parsed message/status is
 * additionally routed into it AFTER the per-message/per-status logs — the agent
 * path is purely additive, so the log shapes the existing integration tests
 * assert on are unchanged. With no agent (the parse+log-only callers, e.g. the
 * webhook-routing tests) the routing block is skipped and behavior is identical
 * to before.
 *
 * The agent calls are AWAITED in a SEQUENTIAL loop so a single webhook's
 * messages reach the conversation in arrival ORDER (a webhook routinely batches
 * several messages for one conversation). The agent's per-key lock already
 * prevents the read-modify-write clobber; awaiting here preserves ordering on
 * top of that. This is still fire-and-forget FROM THE ROUTE — the handler ACKs
 * 200 first, then does `void dispatchWebhook(...)`, so this awaiting never
 * affects the response. Every `handle*` is fail-soft (logs and swallows
 * internally; never throws out), so the loop cannot reject.
 *
 * Returns the {@link ParseResult} so callers (unit tests) can act on it. The
 * HTTP route handler discards the (promised) return value after ACKing 200 —
 * Meta retries non-2xx for 7 days so we ACK before we parse.
 *
 * `opts.metrics` (OPTIONAL) increments the webhook counters here, keyed on the
 * channel summary: `webhook_received_total{result:'accepted'|'parse_error'}` and
 * (on the defensive parse catch) `webhook_parse_failures_total`. `opts.traceId`/
 * `opts.requestLogger` carry the trace context the HTTP layer stamped — when a
 * request logger is supplied it REPLACES the base logger for this dispatch (so
 * every log line, including the agent's, shares the request's traceId) and the
 * traceId is threaded into the agent's handle* calls.
 */
export async function dispatchWebhook(
  body: unknown,
  logger: pino.Logger,
  _config: Config,
  agent?: ConversationAgent,
  opts?: { metrics?: AgentMetrics; traceId?: string; requestLogger?: pino.Logger }
): Promise<ParseResult> {
  // Prefer the request-scoped child logger (carries traceId + route) when the
  // HTTP layer supplied one, so this dispatch's logs correlate to the webhook.
  const log = opts?.requestLogger ?? logger;
  const metrics = opts?.metrics;
  const objectField =
    body !== null && typeof body === 'object'
      ? (body as { object?: unknown }).object
      : undefined;
  const entry =
    body !== null && typeof body === 'object'
      ? (body as { entry?: unknown }).entry
      : undefined;
  const entryCount = Array.isArray(entry) ? entry.length : 0;
  const channel = objectToChannel(objectField);

  // The parser is documented as non-throwing — defensive try/catch is here as
  // a safety net only. If it ever fires we've already ACKed 200, so we can't
  // re-throw without crashing the process. Surface as `error` and move on.
  let result: ParseResult;
  try {
    result = parseMetaWebhook(body);
  } catch (err) {
    log.error({ err, channel }, 'dispatcher parse failed unexpectedly');
    // A defensive-catch parse failure: count both the failure (with a reason)
    // and the webhook with a `parse_error` disposition. Optional-chained so the
    // metric-less callers (parse+log-only tests) are unaffected.
    metrics?.webhookParseFailures.inc({ channel, reason: 'exception' });
    metrics?.webhookReceived.inc({ channel, result: 'parse_error' });
    result = { messages: [], statuses: [] };
    return result;
  }
  // Parsed successfully (the parser returns an empty result for malformed-but-
  // recognized payloads rather than throwing). Count one accepted webhook per
  // channel summary.
  metrics?.webhookReceived.inc({ channel, result: 'accepted' });

  // Per-message logs. Use `warn` for `type: 'unknown'` so unmodeled inbounds
  // surface in observability; `info` for everything else.
  for (const msg of result.messages) {
    logIncomingMessage(log, msg);
  }

  // Per-status logs are always `info` — status updates are routine.
  for (const status of result.statuses) {
    logStatusUpdate(log, status);
  }

  // Channel-level summary log. Kept as the FINAL emit so its position in the
  // log stream remains stable for downstream log-driven assertions / tooling.
  // Unknown channel logs at `warn`; everything else at `info`.
  const summaryFields = {
    channel,
    entryCount,
    messageCount: result.messages.length,
    statusCount: result.statuses.length,
    traceMarker: `inbound.${channel}` as const
  };

  if (channel === 'unknown') {
    log.warn({ ...summaryFields, objectField }, 'inbound webhook with unknown object field');
  } else {
    log.info(summaryFields, 'inbound webhook received');
  }

  // Route parsed messages/statuses into the conversation agent when one is
  // wired. ADDITIVE to the logging above — the log shapes are unchanged so the
  // parse+log-only tests keep passing. Skipped entirely when `agent` is absent.
  if (agent) {
    // SEQUENTIAL await: the route handler has already ACKed 200 (Meta retries
    // non-2xx for 7 days) and dispatched this via `void`, so awaiting here does
    // NOT affect the response — it only preserves intra-webhook ORDER so a
    // conversation sees its batched messages in arrival order. The agent's
    // per-key lock independently prevents the read-modify-write clobber. Every
    // `handle*` is fail-soft (logs and swallows internally; never throws out),
    // so the loop cannot reject.
    //
    // Stage 6: thread the request-scoped trace context (set by traceMiddleware
    // and pulled off res.locals in the POST handler) into every handle* call so
    // the agent's log lines — and the traceId it persists on the conversation
    // record — chain back to the originating webhook. Both are optional: omitted
    // entirely when the HTTP layer didn't supply them (e.g. unit-test callers).
    const handleOpts =
      opts?.traceId !== undefined || opts?.requestLogger !== undefined
        ? {
            ...(opts?.traceId !== undefined ? { traceId: opts.traceId } : {}),
            ...(opts?.requestLogger !== undefined ? { logger: opts.requestLogger } : {})
          }
        : undefined;
    for (const msg of result.messages) {
      // Reactions ARE IncomingMessages (type: 'reaction') and `handleReaction`
      // just delegates to `handleInbound`, so routing every message through
      // `handleInbound` keeps a single ordered writer per conversation.
      await agent.handleInbound(msg, handleOpts);
    }
    for (const status of result.statuses) {
      await agent.handleStatus(status, handleOpts);
    }
  }

  return result;
}

function logIncomingMessage(logger: pino.Logger, msg: IncomingMessage): void {
  const fields = {
    channel: msg.channel,
    traceMarker: 'inbound.message' as const,
    messageType: msg.type,
    channelMessageId: msg.channelMessageId,
    // KNOWN GAP: the dispatch logs still emit the full user id at `info` so the
    // wiring stays debuggable end-to-end. Stage 6 only redacts the ADMIN-route
    // OUTPUT (see redaction.ts), not these per-dispatch logs. Gating dispatch-log
    // PII (e.g. on config.nodeEnv / a log-redaction serializer) is deferred to
    // Stage 10 — left here as an accepted gap, not an unfulfilled TODO.
    channelScopedUserId: msg.channelScopedUserId,
    channelScopedBusinessId: msg.channelScopedBusinessId,
    timestamp: msg.timestamp,
    isEcho: msg.isEcho ?? false,
    hasMedia: msg.media !== undefined,
    hasReplyTo: msg.replyTo !== undefined
  };
  // `unknown` types surface at `warn` so unmodeled inbounds get attention.
  if (msg.type === 'unknown') {
    logger.warn(fields, 'inbound message parsed');
  } else {
    logger.info(fields, 'inbound message parsed');
  }
}

function logStatusUpdate(logger: pino.Logger, status: StatusUpdate): void {
  const fields: Record<string, unknown> = {
    channel: status.channel,
    traceMarker: 'inbound.status',
    channelMessageId: status.channelMessageId,
    status: status.status,
    timestamp: status.timestamp
  };
  if (status.errorCode !== undefined) fields.errorCode = status.errorCode;
  if (status.errorTitle !== undefined) fields.errorTitle = status.errorTitle;
  logger.info(fields, 'inbound status update');
}

/** Shape of one readiness sub-check in the GET /ready response. */
type ReadinessCheck = { status: string; [field: string]: unknown };

/**
 * Build the GET /ready dependency report. NEVER throws — each check is wrapped so
 * a thrown/rejected check degrades to `{ status: 'error' }` for THAT check (and
 * fails overall readiness) rather than 500ing the route.
 *
 * Stage 6 checks:
 *  - `scheduler`: call `getStats()` — healthy if it resolves; the report carries
 *    the impl `kind` + the returned stats. A missing scheduler is reported as
 *    `not_configured` (still ready — Stage 5 apps may run without one wired here).
 *  - `redis` (Stage 10):
 *      • `config.redisUrl` unset                  → `not_configured` (ready).
 *      • set but no `redisClient` handed in       → `configured` (ready —
 *        presence-only; the client wasn't injected, so there is nothing to ping).
 *      • set WITH a `redisClient`                 → race `ping()` against
 *        `config.persistence.readyRedisTimeoutMs`. A resolved ping → `ok`; a
 *        rejection OR timeout → `error` and overall readiness fails. The timeout
 *        timer is cleared so it can't leak. The whole check sits inside a
 *        defensive try/catch so a throw degrades THIS check, never 500s the route.
 */
async function buildReadinessReport(deps: {
  scheduler?: BufferScheduler;
  config: Config;
  redisClient?: RedisPinger;
}): Promise<{ ready: boolean; checks: Record<string, ReadinessCheck> }> {
  const checks: Record<string, ReadinessCheck> = {};
  let ready = true;

  // scheduler check
  if (!deps.scheduler) {
    checks.scheduler = { status: 'not_configured' };
  } else {
    try {
      const stats = deps.scheduler.getStats ? await deps.scheduler.getStats() : undefined;
      checks.scheduler = { status: 'ok', kind: deps.scheduler.kind, ...(stats ? { stats } : {}) };
    } catch (err) {
      ready = false;
      checks.scheduler = { status: 'error', error: (err as Error).message };
    }
  }

  // redis check (Stage 10): presence-only when not configured / no client, else
  // a real timeout-bounded PING.
  if (!deps.config.redisUrl) {
    checks.redis = { status: 'not_configured' };
  } else if (!deps.redisClient) {
    checks.redis = { status: 'configured' };
  } else {
    const client = deps.redisClient;
    try {
      // Race the ping against a cleared-on-settle timeout so neither a hung Redis
      // nor a dangling timer can wedge the probe.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutMs = deps.config.persistence.readyRedisTimeoutMs;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`redis ping timed out after ${timeoutMs}ms`)), timeoutMs);
      });
      try {
        await Promise.race([client.ping(), timeout]);
        checks.redis = { status: 'ok' };
      } finally {
        if (timer) clearTimeout(timer);
      }
    } catch (err) {
      ready = false;
      checks.redis = { status: 'error', error: (err as Error).message };
    }
  }

  return { ready, checks };
}

export function createApp(deps: AppDeps): express.Express {
  const { config, logger, agent, metrics, metricsCollector, statusTracker, store, scheduler, redisClient } =
    deps;
  const app = express();
  const startedAtMs = Date.now();

  app.use(
    express.json({
      limit: '5mb',
      verify: (req, _res, buf) => {
        (req as RawBodyRequest).rawBody = Buffer.isBuffer(buf) ? Buffer.from(buf) : Buffer.alloc(0);
      }
    })
  );

  // Trace middleware is mounted AFTER express.json (so the raw-body `verify`
  // hook still captures req.rawBody for signature verification — the verify hook
  // only runs inside the json parser) and BEFORE every route, so each handler
  // can pull the request-scoped traceId + child logger off res.locals via
  // requestContextFromLocals(res). It also stamps the `x-trace-id` response
  // header (echoing a valid inbound one, else a fresh uuid).
  app.use(traceMiddleware({ logger }));

  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({
      status: 'ok',
      uptimeSeconds: Math.floor((Date.now() - startedAtMs) / 1000),
      version: PACKAGE_VERSION,
      nodeVersion: process.version
    });
  });

  // GET /ready — readiness probe. Always mounted, NO auth (like /health). Runs
  // each dependency check defensively (a thrown check fails that check rather
  // than 500ing the route) and returns 503 if ANY check fails, 200 otherwise.
  app.get('/ready', (_req: Request, res: Response) => {
    void buildReadinessReport({ scheduler, config, ...(redisClient ? { redisClient } : {}) })
      .then(({ ready, checks }) => {
        res
          .status(ready ? 200 : 503)
          .json({ status: ready ? 'ready' : 'not_ready', checks });
      })
      .catch((err: unknown) => {
        // buildReadinessReport is documented never-throwing (each check is
        // wrapped), so this is defensive insurance against a future change —
        // a rejection here must still answer the probe rather than hang it.
        logger.error({ err }, 'ready check failed unexpectedly');
        if (!res.headersSent) res.status(503).json({ status: 'not_ready', checks: {} });
      });
  });

  // GET /metrics — Prometheus exposition, token-gated. GUARDED AT REGISTRATION:
  // mounted ONLY when an admin token is configured AND a collector is wired. When
  // adminApiToken is unset the route is never registered, so it 404s — we never
  // expose metrics on an unauthenticated endpoint (a 401-on-unmounted approach
  // would still advertise the route's existence). See the security note below.
  if (config.adminApiToken && metricsCollector) {
    const adminToken = config.adminApiToken;
    const collector = metricsCollector;
    app.get('/metrics', (req: Request, res: Response) => {
      if (!validateAdminToken(req, adminToken)) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      res.type(PROMETHEUS_CONTENT_TYPE).send(renderPrometheus(collector.snapshot()));
    });
  }

  app.get('/webhook', (req: Request, res: Response) => {
    const mode = typeof req.query['hub.mode'] === 'string' ? req.query['hub.mode'] : undefined;
    const verifyToken =
      typeof req.query['hub.verify_token'] === 'string' ? req.query['hub.verify_token'] : undefined;
    const challenge =
      typeof req.query['hub.challenge'] === 'string' ? req.query['hub.challenge'] : undefined;
    const tokenMatches = verifyToken === config.meta.verifyToken;

    if (mode === 'subscribe' && tokenMatches) {
      logger.info(
        { mode, hasChallenge: challenge !== undefined, tokenMatches: true },
        'meta webhook verification accepted'
      );
      res.status(200).type('text/plain').send(challenge ?? '');
      return;
    }

    logger.warn(
      { mode, hasChallenge: challenge !== undefined, tokenMatches },
      'meta webhook verification rejected'
    );
    res.status(403).end();
  });

  // Build the candidate secret set for inbound signature verification. WhatsApp
  // and Messenger webhooks are signed with META_APP_SECRET; Instagram webhooks
  // are signed with INSTAGRAM_APP_SECRET (proven against the live API
  // 2026-05-20). The verifier accepts a signature that matches ANY configured
  // secret — see src/http/security.ts for the try-all rationale.
  const signatureSecrets = [config.meta.appSecret];
  if (config.instagram?.appSecret && !signatureSecrets.includes(config.instagram.appSecret)) {
    signatureSecrets.push(config.instagram.appSecret);
  }

  // Foot-gun guard: an enabled Instagram channel WITHOUT its app secret means
  // every inbound IG webhook will fail signature verification (401) silently
  // from the developer's perspective. We don't throw at config load (so
  // WhatsApp+Messenger-only and partial setups keep running), but we surface it
  // loudly at startup so the cause is discoverable.
  if (config.channels.instagram && !config.instagram?.appSecret) {
    logger.warn(
      { channel: 'instagram' },
      'Instagram channel enabled but INSTAGRAM_APP_SECRET not set — inbound Instagram webhooks will fail signature verification.'
    );
  }

  // Advisory token-shape warnings (Stage 10): heuristic checks that catch common
  // copy-paste mistakes (e.g. a Page token pasted into the WhatsApp slot, or a
  // truncated token). These NEVER throw — token formats vary, so a false reject
  // would break a working deploy. One warn line per returned warning, with the
  // env var `field` so the cause is discoverable.
  for (const warning of tokenFormatWarnings(config)) {
    logger.warn({ field: warning.field }, warning.message);
  }

  const verifier = createMetaSignatureVerifier(signatureSecrets, logger);
  app.post('/webhook', verifier, (req: Request, res: Response) => {
    // ACK before parsing — Meta retries non-2xx for 7 days then drops, so the
    // 200 is load-bearing. The dispatcher parses + logs and (when an agent is
    // wired) routes each message/status into it (now async: it awaits the agent
    // calls sequentially to preserve intra-webhook order). The ParseResult
    // return value is discarded on the route path but kept unit-testable via
    // dispatchWebhook. The dispatcher is fail-soft internally; the trailing
    // `.catch` is belt-and-suspenders so a fire-and-forget rejection can never
    // become a process-killing unhandled rejection.
    //
    // Pull the request-scoped trace context (set by traceMiddleware) and pass it
    // — plus the metrics handle for the webhook counters — into the dispatcher.
    // The verifier 401s an invalid signature BEFORE this handler, so the
    // webhook_received counter only counts signature-valid requests here; see
    // the security.ts note re: signature-rejection metrics being deferred.
    const ctx = requestContextFromLocals(res);
    res.status(200).send('EVENT_RECEIVED');
    void dispatchWebhook(req.body, logger, config, agent, {
      ...(metrics !== undefined ? { metrics } : {}),
      ...(ctx?.traceId !== undefined ? { traceId: ctx.traceId } : {}),
      ...(ctx?.logger !== undefined ? { requestLogger: ctx.logger } : {})
    }).catch(err => {
      logger.error({ err }, 'dispatchWebhook rejected unexpectedly');
    });
  });

  // ── Admin introspection routes (token-gated, GUARDED AT REGISTRATION) ──────
  // SECURITY: these are registered ONLY when config.adminApiToken is set AND the
  // backing dep is present. When the token is unset the routes do not exist at
  // all (they 404), rather than being mounted and returning 401 — never advertise
  // an admin surface on a deploy that hasn't configured a token. /health and
  // /ready (above) are the only always-on, unauthenticated routes.
  if (config.adminApiToken && store) {
    const adminToken = config.adminApiToken;
    const conversationStore = store;
    // GET /admin/conversations/:key — PII-redacted by default (the record holds
    // the user's phone-number-like id and message bodies). `?reveal=true` returns
    // the raw record, gated behind the same token.
    app.get('/admin/conversations/:key', (req: Request, res: Response) => {
      if (!validateAdminToken(req, adminToken)) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      // `:key` is a single named segment, so it's a string at runtime; the
      // Express 5 types widen it to `string | string[]`, so coerce defensively.
      const key = String(req.params.key);
      // The floating promise needs its own .catch(): a rejection (e.g. a
      // throw from the Stage 10 Redis store) would otherwise be swallowed by
      // `void`, never reach the Express error handler, and leave the client
      // hanging with no response.
      void conversationStore
        .getConversation(key)
        .then(record => {
          if (record === undefined) {
            res.status(404).json({ error: 'not_found' });
            return;
          }
          res.json(redactConversationRecord(record, { reveal: req.query.reveal === 'true' }));
        })
        .catch((err: unknown) => {
          logger.error({ err, method: req.method, path: req.path }, 'admin conversations route error');
          if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
        });
    });
  }

  if (config.adminApiToken && statusTracker) {
    const adminToken = config.adminApiToken;
    const tracker = statusTracker;
    // GET /admin/status/:messageId — delivery-status history for one outbound id.
    // PII-redacted by default: a StatusRecord carries the user-side `recipientId`
    // and a `conversationKey` whose third segment embeds the raw user id, so the
    // redactor masks both. `?reveal=true` returns the raw record, gated behind
    // the same token (mirrors /admin/conversations).
    app.get('/admin/status/:messageId', (req: Request, res: Response) => {
      if (!validateAdminToken(req, adminToken)) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      // `:messageId` is a single named segment (string at runtime); coerce
      // defensively against the Express 5 `string | string[]` param typing.
      const rec = tracker.getStatus(String(req.params.messageId));
      if (rec === undefined) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.json(redactStatusRecord(rec, { reveal: req.query.reveal === 'true' }));
    });
  }

  app.use((req: Request, res: Response) => {
    logger.debug({ method: req.method, path: req.path, traceMarker: '404' }, 'no route matched');
    res.status(404).json({ error: 'not_found' });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    logger.error(
      { err, method: req.method, path: req.path },
      'unhandled error in express pipeline'
    );
    if (res.headersSent) return;
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
