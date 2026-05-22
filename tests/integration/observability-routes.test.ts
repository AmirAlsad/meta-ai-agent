/**
 * Stage 6 observability-routes integration test.
 *
 * Builds a `createApp` with the FULL Stage 6 dependency graph wired up against
 * REAL in-memory implementations (metrics collector + registry, status tracker,
 * conversation store seeded with a record, buffer scheduler) and a config WITH
 * `adminApiToken` set. Exercises every operational route end-to-end through the
 * express pipeline (via supertest):
 *
 *   GET /health, GET /ready                 — always-on, unauthenticated
 *   GET /metrics                            — token-gated, mounted-when-configured
 *   GET /admin/conversations/:key           — token-gated, PII-redacted by default
 *   GET /admin/status/:messageId            — token-gated
 *   x-trace-id header behavior              — minted + echoed
 *   webhook metrics                         — counted on a signed POST /webhook
 *
 * The signature/HMAC helpers mirror webhook-routing.test.ts so the signed-webhook
 * assertion uses the exact same scheme the rest of the suite proves.
 */

import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi, type Mock } from 'vitest';
import request from 'supertest';
import type pino from 'pino';
import { createApp } from '../../src/http/app.js';
import type { Config } from '../../src/config/loader.js';
import { defaultConversationConfig, defaultLimitsConfig, defaultPersistenceConfig } from '../../src/config/loader.js';
import { InMemoryConversationStore } from '../../src/conversation/store.js';
import { InMemoryBufferScheduler } from '../../src/conversation/scheduler.js';
import { InMemoryMetricsCollector } from '../../src/metrics/collector.js';
import { createAgentMetrics } from '../../src/metrics/registry.js';
import { InMemoryStatusTracker } from '../../src/status/tracker.js';
import { createIdleConversation, type ConversationRecord } from '../../src/conversation/types.js';
import type { IncomingMessage } from '../../src/meta/types.js';
import type { OutboundItem } from '../../src/delivery/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(here, '../fixtures/meta');

const APP_SECRET = 'test-app-secret-1234567890';
const VERIFY_TOKEN = 'test-verify-token-1234567890';
const ADMIN_TOKEN = 'admin-secret-token-1234567890';

interface SpyLogger {
  info: Mock;
  warn: Mock;
  error: Mock;
  debug: Mock;
  fatal: Mock;
  trace: Mock;
}

type SpyPinoLogger = pino.Logger & { mock: SpyLogger };

function makeSpyLogger(): SpyPinoLogger {
  const mock: SpyLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn()
  };
  const logger: Record<string, unknown> = {
    info: mock.info,
    warn: mock.warn,
    error: mock.error,
    debug: mock.debug,
    fatal: mock.fatal,
    trace: mock.trace,
    silent: vi.fn(),
    level: 'info',
    child(): SpyPinoLogger {
      return logger as unknown as SpyPinoLogger;
    },
    bindings(): Record<string, unknown> {
      return {};
    },
    flush(): void {
      /* no-op */
    },
    isLevelEnabled(): boolean {
      return true;
    }
  };
  logger.mock = mock;
  return logger as unknown as SpyPinoLogger;
}

function makeTestConfig(overrides?: Partial<Config>): Config {
  const base: Config = {
    meta: {
      appId: undefined,
      appSecret: APP_SECRET,
      verifyToken: VERIFY_TOKEN,
      graphApiVersion: 'v25.0'
    },
    whatsapp: {
      phoneNumberId: '200000000000002',
      accessToken: 'fake-whatsapp-access-token'
    },
    messenger: {
      pageId: '500000000000005',
      pageAccessToken: 'fake-messenger-page-access-token'
    },
    instagram: {
      userId: '17841400000000007',
      accessToken: 'fake-instagram-access-token'
    },
    channels: { whatsapp: true, messenger: true, instagram: true },
    conversation: defaultConversationConfig(),
    persistence: defaultPersistenceConfig(),
    limits: defaultLimitsConfig(),
    chatEndpointUrl: 'http://localhost:9999/chat',
    adminApiToken: ADMIN_TOKEN,
    ngrokDomain: 'test.ngrok-free.dev',
    agentAutostart: false,
    port: 3000,
    nodeEnv: 'test'
  };
  return { ...base, ...overrides };
}

function signBody(body: Buffer, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

function loadFixtureBuffer(relativePath: string): Buffer {
  const raw = readFileSync(path.join(fixturesDir, relativePath), 'utf8');
  return Buffer.from(JSON.stringify(JSON.parse(raw)));
}

/** A seeded conversation record carrying a PII-bearing channelScopedUserId. */
const SEEDED_KEY = 'whatsapp:200000000000002:15557654321';
const SEEDED_USER_ID = '15557654321';

function seedConversation(store: InMemoryConversationStore): Promise<void> {
  const record: ConversationRecord = createIdleConversation({
    key: SEEDED_KEY,
    channel: 'whatsapp',
    channelScopedUserId: SEEDED_USER_ID,
    channelScopedBusinessId: '200000000000002'
  });
  return store.setConversation(record);
}

/**
 * PII strings embedded in the rich-seeded record's content surfaces — the
 * redaction assertions below check none of these appear in clear in a no-reveal
 * response.
 */
const RICH_PII = {
  flowResponseJson: '{"email":"buyer@example.com","phone":"15557654321"}',
  referralCtwaClid: 'ctwa-click-id-abcdef',
  mediaUrl: 'https://lookaside.fbcdn.net/seeded-secret-media.jpg',
  outboundMediaUrl: 'https://cdn.example.com/seeded-statement.pdf'
} as const;

/**
 * Seed a record whose inbound buffer + outbound queue carry the high-risk PII
 * surfaces FIX 1 added to the allow-list (a flowResponse form submission, a CTWA
 * referral, an inbound media URL, and an outbound media URL).
 */
function seedRichConversation(store: InMemoryConversationStore): Promise<void> {
  const record: ConversationRecord = createIdleConversation({
    key: SEEDED_KEY,
    channel: 'whatsapp',
    channelScopedUserId: SEEDED_USER_ID,
    channelScopedBusinessId: '200000000000002'
  });
  const inbound: IncomingMessage = {
    channel: 'whatsapp',
    channelMessageId: 'wamid.RICH.IN',
    channelScopedUserId: SEEDED_USER_ID,
    channelScopedBusinessId: '200000000000002',
    timestamp: 1_716_000_000_000,
    type: 'image',
    text: 'here are my details',
    media: {
      id: 'media-seed-1',
      mimeType: 'image/jpeg',
      url: RICH_PII.mediaUrl,
      caption: 'photo of my id'
    },
    referral: {
      source: 'ADS',
      type: 'OPEN_THREAD',
      ctwaClid: RICH_PII.referralCtwaClid,
      sourceUrl: 'https://fb.example/ad'
    },
    flowResponse: {
      name: 'lead_gen',
      responseJson: RICH_PII.flowResponseJson
    },
    raw: { from: SEEDED_USER_ID }
  };
  const outbound: OutboundItem = {
    id: 'local-rich-out',
    kind: 'media',
    mediaUrl: RICH_PII.outboundMediaUrl,
    mediaCaption: 'your statement',
    channelMessageId: 'wamid.RICH.OUT'
  };
  record.inboundBuffer = [inbound];
  record.outboundQueue = [outbound];
  return store.setConversation(record);
}

/**
 * Build the full Stage 6 app + the real deps it was constructed from, so a test
 * can both hit the routes (via the app) and inspect the underlying state (via
 * the returned deps — e.g. metricsCollector.snapshot()).
 */
function buildApp(configOverrides?: Partial<Config>): {
  app: ReturnType<typeof createApp>;
  store: InMemoryConversationStore;
  scheduler: InMemoryBufferScheduler;
  metricsCollector: InMemoryMetricsCollector;
  metrics: ReturnType<typeof createAgentMetrics>;
  statusTracker: InMemoryStatusTracker;
  logger: SpyPinoLogger;
} {
  const logger = makeSpyLogger();
  const config = makeTestConfig(configOverrides);
  const store = new InMemoryConversationStore({ dedupeTtlSeconds: config.conversation.dedupeTtlSeconds });
  const scheduler = new InMemoryBufferScheduler();
  // The scheduler is consulted by /ready via getStats(); a handler is not needed
  // for that path but set a no-op so the scheduler is in a realistic state.
  scheduler.setHandler(async () => {});
  const metricsCollector = new InMemoryMetricsCollector({ logger });
  const metrics = createAgentMetrics(metricsCollector);
  metrics.agentUp.set(undefined, 1);
  const statusTracker = new InMemoryStatusTracker();
  const app = createApp({
    config,
    logger,
    metrics,
    metricsCollector,
    statusTracker,
    store,
    scheduler
  });
  return { app, store, scheduler, metricsCollector, metrics, statusTracker, logger };
}

describe('Stage 6 observability routes', () => {
  describe('GET /health (always on, unauthenticated)', () => {
    it('returns 200 with status ok and a version', async () => {
      const { app } = buildApp();
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'ok' });
      expect(typeof res.body.version).toBe('string');
      expect((res.body as { version: string }).version.length).toBeGreaterThan(0);
    });
  });

  describe('GET /ready (always on, unauthenticated)', () => {
    it('returns 200 ready with a scheduler check and redis not_configured', async () => {
      const { app } = buildApp();
      const res = await request(app).get('/ready');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ready');
      expect(res.body.checks.scheduler).toBeDefined();
      expect(res.body.checks.scheduler.status).toBe('ok');
      expect(res.body.checks.scheduler.kind).toBe('in_memory');
      // Redis ping is deferred to Stage 10; with no REDIS_URL it reports
      // not_configured and does NOT fail readiness.
      expect(res.body.checks.redis).toEqual({ status: 'not_configured' });
    });

    it('reports redis configured (no ping yet) when REDIS_URL is set', async () => {
      const { app } = buildApp({ redisUrl: 'redis://localhost:6379' });
      const res = await request(app).get('/ready');
      expect(res.status).toBe(200);
      expect(res.body.checks.redis).toEqual({ status: 'configured' });
    });
  });

  describe('GET /metrics (token-gated, mounted-when-configured)', () => {
    it('returns 200 Prometheus exposition with a known metric for a correct token', async () => {
      const { app } = buildApp();
      const res = await request(app)
        .get('/metrics')
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type'] ?? '').toMatch(/version=0\.0\.4/);
      // agent_up was set to 1 at construction; webhook_received_total is
      // registered by createAgentMetrics. Either proves the exposition rendered.
      expect(res.text).toContain('agent_up');
      expect(res.text).toContain('webhook_received_total');
    });

    it('accepts the x-admin-api-token header form too', async () => {
      const { app } = buildApp();
      const res = await request(app).get('/metrics').set('x-admin-api-token', ADMIN_TOKEN);
      expect(res.status).toBe(200);
    });

    it('returns 401 without a token', async () => {
      const { app } = buildApp();
      const res = await request(app).get('/metrics');
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'unauthorized' });
    });

    it('returns 401 with the wrong token', async () => {
      const { app } = buildApp();
      const res = await request(app)
        .get('/metrics')
        .set('Authorization', 'Bearer wrong-token-9999999999');
      expect(res.status).toBe(401);
    });

    it('is NOT mounted (404) when adminApiToken is unset', async () => {
      // GUARDED AT REGISTRATION: with no admin token the route is never
      // registered, so it 404s through the catch-all rather than 401ing.
      const { app } = buildApp({ adminApiToken: undefined });
      const res = await request(app)
        .get('/metrics')
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'not_found' });
    });
  });

  describe('GET /admin/conversations/:key (token-gated, PII-redacted)', () => {
    it('returns 200 with the user id MASKED by default', async () => {
      const { app, store } = buildApp();
      await seedConversation(store);
      const res = await request(app)
        .get(`/admin/conversations/${SEEDED_KEY}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
      expect(res.status).toBe(200);
      // The raw phone-number-like id must NOT leak; the redactor masks it to a
      // short suffix (…NNNN).
      expect(res.body.channelScopedUserId).not.toBe(SEEDED_USER_ID);
      expect(res.body.channelScopedUserId).toBe('…4321');
    });

    it('returns the UNMASKED user id with ?reveal=true', async () => {
      const { app, store } = buildApp();
      await seedConversation(store);
      const res = await request(app)
        .get(`/admin/conversations/${SEEDED_KEY}`)
        .query({ reveal: 'true' })
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
      expect(res.status).toBe(200);
      expect(res.body.channelScopedUserId).toBe(SEEDED_USER_ID);
    });

    it('does NOT leak flowResponse / referral / media URLs in clear by default', async () => {
      const { app, store } = buildApp();
      await seedRichConversation(store);
      const res = await request(app)
        .get(`/admin/conversations/${SEEDED_KEY}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
      expect(res.status).toBe(200);
      // Allow-list / fail-closed: none of the high-risk content surfaces appear
      // verbatim anywhere in the serialized masked response.
      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain(RICH_PII.flowResponseJson);
      expect(serialized).not.toContain(RICH_PII.referralCtwaClid);
      expect(serialized).not.toContain(RICH_PII.mediaUrl);
      expect(serialized).not.toContain(RICH_PII.outboundMediaUrl);
      // The key user-segment is masked too.
      expect(res.body.key).toBe('whatsapp:200000000000002:…4321');
      // Spot-check the structural shape survives so the view stays debuggable.
      const inbound = res.body.inboundBuffer[0];
      expect(inbound.media.url).toBe('[redacted]');
      expect(inbound.flowResponse.responseJson).toBe('[redacted]');
      expect(inbound.referral.ctwaClid).toBe('[redacted]');
      expect(inbound.referral.source).toBe('ADS'); // non-PII routing token kept
      expect(res.body.outboundQueue[0].mediaUrl).toBe('[redacted]');
    });

    it('returns flowResponse / referral / media URLs in clear with ?reveal=true', async () => {
      const { app, store } = buildApp();
      await seedRichConversation(store);
      const res = await request(app)
        .get(`/admin/conversations/${SEEDED_KEY}`)
        .query({ reveal: 'true' })
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
      expect(res.status).toBe(200);
      const inbound = res.body.inboundBuffer[0];
      expect(inbound.media.url).toBe(RICH_PII.mediaUrl);
      expect(inbound.flowResponse.responseJson).toBe(RICH_PII.flowResponseJson);
      expect(inbound.referral.ctwaClid).toBe(RICH_PII.referralCtwaClid);
      expect(res.body.outboundQueue[0].mediaUrl).toBe(RICH_PII.outboundMediaUrl);
      expect(res.body.key).toBe(SEEDED_KEY);
    });

    it('returns 401 without a token (even for a seeded key)', async () => {
      const { app, store } = buildApp();
      await seedConversation(store);
      const res = await request(app).get(`/admin/conversations/${SEEDED_KEY}`);
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'unauthorized' });
    });

    it('returns 404 for an unknown key', async () => {
      const { app } = buildApp();
      const res = await request(app)
        .get('/admin/conversations/whatsapp:nope:nobody')
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'not_found' });
    });

    it('returns 500 (does not hang) when the store rejects', async () => {
      // Guards the .catch() on the floating getConversation promise: a store
      // rejection must answer the request, not leave the client hanging.
      const { app, store } = buildApp();
      vi.spyOn(store, 'getConversation').mockRejectedValue(new Error('store boom'));
      const res = await request(app)
        .get(`/admin/conversations/${SEEDED_KEY}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'internal_error' });
    });

    it('is NOT mounted (404) when adminApiToken is unset', async () => {
      const { app, store } = buildApp({ adminApiToken: undefined });
      await seedConversation(store);
      const res = await request(app)
        .get(`/admin/conversations/${SEEDED_KEY}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'not_found' });
    });
  });

  describe('GET /admin/status/:messageId (token-gated)', () => {
    const WAMID = 'wamid.OUTBOUND.TEST.1';

    function applyStatus(tracker: InMemoryStatusTracker): void {
      tracker.applyStatusUpdate({
        channelMessageId: WAMID,
        channel: 'whatsapp',
        status: 'delivered',
        timestamp: 1716000000,
        conversationKey: SEEDED_KEY,
        recipientId: SEEDED_USER_ID
      });
    }

    it('returns 200 with the status record for a seeded id', async () => {
      const { app, statusTracker } = buildApp();
      applyStatus(statusTracker);
      const res = await request(app)
        .get(`/admin/status/${WAMID}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
      expect(res.status).toBe(200);
      expect(res.body.channelMessageId).toBe(WAMID);
      expect(res.body.current).toBe('delivered');
      expect(res.body.channel).toBe('whatsapp');
    });

    it('masks recipientId + key user-segment by default (FIX 2)', async () => {
      const { app, statusTracker } = buildApp();
      applyStatus(statusTracker);
      const res = await request(app)
        .get(`/admin/status/${WAMID}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
      expect(res.status).toBe(200);
      expect(res.body.recipientId).not.toBe(SEEDED_USER_ID);
      expect(res.body.recipientId).toBe('…4321');
      expect(res.body.conversationKey).toBe('whatsapp:200000000000002:…4321');
      // The raw user id must not survive anywhere in the masked response.
      expect(JSON.stringify(res.body)).not.toContain(SEEDED_USER_ID);
      // Non-PII status timeline is intact.
      expect(res.body.current).toBe('delivered');
      expect(Array.isArray(res.body.history)).toBe(true);
    });

    it('returns the UNMASKED recipientId with ?reveal=true', async () => {
      const { app, statusTracker } = buildApp();
      applyStatus(statusTracker);
      const res = await request(app)
        .get(`/admin/status/${WAMID}`)
        .query({ reveal: 'true' })
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
      expect(res.status).toBe(200);
      expect(res.body.recipientId).toBe(SEEDED_USER_ID);
      expect(res.body.conversationKey).toBe(SEEDED_KEY);
    });

    it('returns 404 for an unknown message id', async () => {
      const { app } = buildApp();
      const res = await request(app)
        .get('/admin/status/wamid.DOES.NOT.EXIST')
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'not_found' });
    });

    it('returns 401 without a token', async () => {
      const { app, statusTracker } = buildApp();
      applyStatus(statusTracker);
      const res = await request(app).get(`/admin/status/${WAMID}`);
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'unauthorized' });
    });
  });

  describe('GET /admin/queue (token-gated, no PII)', () => {
    it('returns 200 with { kind, stats } for a correct token', async () => {
      const { app } = buildApp();
      const res = await request(app)
        .get('/admin/queue')
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
      expect(res.status).toBe(200);
      // The in-memory scheduler reports its kind + a `pending` count (0 here, no
      // timers armed). No PII — only counts.
      expect(res.body.kind).toBe('in_memory');
      expect(res.body.stats).toMatchObject({ pending: 0 });
    });

    it('reflects pending timers after a flush is scheduled', async () => {
      const { app, scheduler } = buildApp();
      await scheduler.schedule('whatsapp:biz:user', 60_000);
      const res = await request(app)
        .get('/admin/queue')
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
      expect(res.status).toBe(200);
      expect(res.body.stats.pending).toBe(1);
      await scheduler.close();
    });

    it('accepts the x-admin-api-token header form too', async () => {
      const { app } = buildApp();
      const res = await request(app).get('/admin/queue').set('x-admin-api-token', ADMIN_TOKEN);
      expect(res.status).toBe(200);
    });

    it('returns 401 without a token', async () => {
      const { app } = buildApp();
      const res = await request(app).get('/admin/queue');
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'unauthorized' });
    });

    it('returns 401 with the wrong token', async () => {
      const { app } = buildApp();
      const res = await request(app)
        .get('/admin/queue')
        .set('Authorization', 'Bearer wrong-token-9999999999');
      expect(res.status).toBe(401);
    });

    it('returns 500 (does not hang) when getStats rejects', async () => {
      const { app, scheduler } = buildApp();
      vi.spyOn(scheduler, 'getStats').mockRejectedValue(new Error('stats boom'));
      const res = await request(app)
        .get('/admin/queue')
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'internal_error' });
    });

    it('is NOT mounted (404) when adminApiToken is unset', async () => {
      const { app } = buildApp({ adminApiToken: undefined });
      const res = await request(app)
        .get('/admin/queue')
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'not_found' });
    });
  });

  describe('GET /admin/dedupe (token-gated, no PII)', () => {
    it('returns present:false for an id never claimed', async () => {
      const { app } = buildApp();
      const res = await request(app)
        .get('/admin/dedupe')
        .query({ messageId: 'wamid.NEVER.SEEN' })
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ messageId: 'wamid.NEVER.SEEN', present: false });
    });

    it('returns present:true with a ttl after the id was claimed', async () => {
      const { app, store } = buildApp();
      const claimed = await store.claimInboundHandle('wamid.CLAIMED.1');
      expect(claimed).toBe(true);
      const res = await request(app)
        .get('/admin/dedupe')
        .query({ messageId: 'wamid.CLAIMED.1' })
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
      expect(res.status).toBe(200);
      expect(res.body.messageId).toBe('wamid.CLAIMED.1');
      expect(res.body.present).toBe(true);
      expect(typeof res.body.ttlSeconds).toBe('number');
      expect(res.body.ttlSeconds).toBeGreaterThan(0);
    });

    it('returns 400 when the messageId query param is missing', async () => {
      const { app } = buildApp();
      const res = await request(app)
        .get('/admin/dedupe')
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'messageId query parameter is required' });
    });

    it('returns 400 when messageId is empty/whitespace', async () => {
      const { app } = buildApp();
      const res = await request(app)
        .get('/admin/dedupe')
        .query({ messageId: '   ' })
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'messageId query parameter is required' });
    });

    it('returns 401 without a token (and before the 400 param check)', async () => {
      const { app } = buildApp();
      const res = await request(app).get('/admin/dedupe');
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'unauthorized' });
    });

    it('returns 500 (does not hang) when peekInboundHandle rejects', async () => {
      const { app, store } = buildApp();
      vi.spyOn(store, 'peekInboundHandle').mockRejectedValue(new Error('peek boom'));
      const res = await request(app)
        .get('/admin/dedupe')
        .query({ messageId: 'wamid.X' })
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'internal_error' });
    });

    it('is NOT mounted (404) when adminApiToken is unset', async () => {
      const { app } = buildApp({ adminApiToken: undefined });
      const res = await request(app)
        .get('/admin/dedupe')
        .query({ messageId: 'wamid.X' })
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'not_found' });
    });
  });

  describe('webhook signature-rejection metrics', () => {
    it('increments webhook_secret_rejections_total{reason:"mismatch"} on a bad signature', async () => {
      const { app, metricsCollector } = buildApp();
      const bodyBuf = loadFixtureBuffer('whatsapp/text-inbound.json');
      const res = await request(app)
        .post('/webhook')
        .set('Content-Type', 'application/json')
        .set('x-hub-signature-256', signBody(bodyBuf, 'wrong-secret'))
        .send(bodyBuf.toString('utf8'));
      expect(res.status).toBe(401);

      const snapshot = metricsCollector.snapshot();
      const rejections = snapshot.metrics.find(m => m.name === 'webhook_secret_rejections_total');
      expect(rejections).toBeDefined();
      const mismatch = rejections?.series.find(s => s.labels.reason === 'mismatch');
      expect((mismatch as { value: number }).value).toBeGreaterThanOrEqual(1);
    });

    it('increments webhook_secret_rejections_total{reason:"missing_signature"} when no header is sent', async () => {
      const { app, metricsCollector } = buildApp();
      const bodyBuf = loadFixtureBuffer('whatsapp/text-inbound.json');
      const res = await request(app)
        .post('/webhook')
        .set('Content-Type', 'application/json')
        .send(bodyBuf.toString('utf8'));
      expect(res.status).toBe(401);

      const rejections = metricsCollector
        .snapshot()
        .metrics.find(m => m.name === 'webhook_secret_rejections_total');
      const missing = rejections?.series.find(s => s.labels.reason === 'missing_signature');
      expect((missing as { value: number }).value).toBeGreaterThanOrEqual(1);
    });
  });

  describe('trace id propagation', () => {
    it('stamps an x-trace-id header on any response', async () => {
      const { app } = buildApp();
      const res = await request(app).get('/health');
      expect(res.headers['x-trace-id']).toBeDefined();
      expect((res.headers['x-trace-id'] as string).length).toBeGreaterThan(0);
    });

    it('echoes a valid inbound x-trace-id back', async () => {
      const { app } = buildApp();
      const traceId = 'trace-abc-123';
      const res = await request(app).get('/health').set('x-trace-id', traceId);
      expect(res.headers['x-trace-id']).toBe(traceId);
    });
  });

  describe('webhook metrics', () => {
    it('increments webhook_received_total after a signed POST /webhook', async () => {
      const { app, metricsCollector } = buildApp();
      const bodyBuf = loadFixtureBuffer('whatsapp/text-inbound.json');
      const res = await request(app)
        .post('/webhook')
        .set('Content-Type', 'application/json')
        .set('x-hub-signature-256', signBody(bodyBuf, APP_SECRET))
        .send(bodyBuf.toString('utf8'));
      expect(res.status).toBe(200);
      // Let the fire-and-forget dispatch (which increments the counter) settle.
      for (let i = 0; i < 5; i++) await Promise.resolve();

      const snapshot = metricsCollector.snapshot();
      const webhookReceived = snapshot.metrics.find(m => m.name === 'webhook_received_total');
      expect(webhookReceived).toBeDefined();
      const accepted = webhookReceived?.series.find(
        s => s.labels.channel === 'whatsapp' && s.labels.result === 'accepted'
      );
      expect(accepted).toBeDefined();
      expect((accepted as { value: number }).value).toBeGreaterThanOrEqual(1);
    });

    it('surfaces the incremented counter through GET /metrics', async () => {
      const { app } = buildApp();
      const bodyBuf = loadFixtureBuffer('whatsapp/text-inbound.json');
      await request(app)
        .post('/webhook')
        .set('Content-Type', 'application/json')
        .set('x-hub-signature-256', signBody(bodyBuf, APP_SECRET))
        .send(bodyBuf.toString('utf8'));
      for (let i = 0; i < 5; i++) await Promise.resolve();

      const res = await request(app)
        .get('/metrics')
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
      expect(res.status).toBe(200);
      expect(res.text).toMatch(/webhook_received_total\{[^}]*channel="whatsapp"[^}]*result="accepted"[^}]*\} [1-9]/);
    });
  });
});
