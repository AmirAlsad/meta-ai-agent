/**
 * `GET /stats/daily` integration test — the DM-volume read surface, and the
 * token separation that is the reason it exists.
 *
 * Builds a `createApp` with BOTH credentials configured (`adminApiToken` and a
 * DIFFERENT `statsApiToken`) over real in-memory implementations, so the whole
 * matrix can be asserted from one app:
 *
 *   GET /stats/daily                        — mount guard, auth, 400s, 500, shape
 *   stats token → /admin/* and /metrics      — REJECTED
 *   admin token → /stats/daily               — REJECTED
 *
 * That cross-rejection is the whole security claim: the identity that pulls
 * counts on a schedule must not be able to read conversation transcripts, and
 * the admin identity gains nothing here. Modelled on observability-routes.test.ts
 * (the same spy logger, config builder and supertest style).
 */

import { describe, expect, it, vi, type Mock } from 'vitest';
import request from 'supertest';
import type pino from 'pino';
import express from 'express';
import { createApp } from '../../src/http/app.js';
import type { Config } from '../../src/config/loader.js';
import {
  defaultConversationConfig,
  defaultLimitsConfig,
  defaultPersistenceConfig
} from '../../src/config/loader.js';
import { InMemoryConversationStore } from '../../src/conversation/store.js';
import { InMemoryBufferScheduler } from '../../src/conversation/scheduler.js';
import { InMemoryMetricsCollector } from '../../src/metrics/collector.js';
import { createAgentMetrics } from '../../src/metrics/registry.js';
import { InMemoryStatusTracker } from '../../src/status/tracker.js';
import { createIdleConversation, type ConversationRecord } from '../../src/conversation/types.js';
import { InMemoryStatsStore, MAX_RANGE_DAYS, type StatsStore } from '../../src/stats/store.js';

const APP_SECRET = 'test-app-secret-1234567890';
const VERIFY_TOKEN = 'test-verify-token-1234567890';
const ADMIN_TOKEN = 'admin-secret-token-1234567890';
const STATS_TOKEN = 'stats-secret-token-1234567890';

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
    whatsapp: { phoneNumberId: '200000000000002', accessToken: 'fake-whatsapp-access-token' },
    channels: { whatsapp: true, messenger: false, instagram: false },
    conversation: defaultConversationConfig(),
    persistence: defaultPersistenceConfig(),
    limits: defaultLimitsConfig(),
    chatEndpointUrl: 'http://localhost:9999/chat',
    adminApiToken: ADMIN_TOKEN,
    statsApiToken: STATS_TOKEN,
    statsRetentionDays: 400,
    ngrokDomain: 'test.ngrok-free.dev',
    agentAutostart: false,
    port: 3000,
    nodeEnv: 'test'
  };
  return { ...base, ...overrides };
}

/** A conversation record so the admin route has something real to refuse to serve. */
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

function buildApp(opts?: {
  configOverrides?: Partial<Config>;
  /** Replace the stats store (e.g. one whose `range` rejects). */
  statsStore?: StatsStore;
  /** Omit the stats store entirely, to exercise the registration guard. */
  noStatsStore?: boolean;
}): {
  app: express.Express;
  store: InMemoryConversationStore;
  statsStore: StatsStore;
  statusTracker: InMemoryStatusTracker;
  logger: SpyPinoLogger;
} {
  const logger = makeSpyLogger();
  const config = makeTestConfig(opts?.configOverrides);
  const store = new InMemoryConversationStore({ dedupeTtlSeconds: config.conversation.dedupeTtlSeconds });
  const scheduler = new InMemoryBufferScheduler();
  scheduler.setHandler(async () => {});
  const metricsCollector = new InMemoryMetricsCollector({ logger });
  const metrics = createAgentMetrics(metricsCollector);
  metrics.agentUp.set(undefined, 1);
  const statusTracker = new InMemoryStatusTracker();
  const statsStore = opts?.statsStore ?? new InMemoryStatsStore({ retentionDays: 400 });
  const app = createApp({
    config,
    logger,
    metrics,
    metricsCollector,
    statusTracker,
    store,
    scheduler,
    ...(opts?.noStatsStore ? {} : { statsStore })
  });
  return { app, store, statsStore, statusTracker, logger };
}

/** Seed counts for two accounts on one day, through the real store's own writer. */
async function seedCounts(statsStore: StatsStore, dayIso: string): Promise<void> {
  const at = Date.parse(`${dayIso}T12:00:00.000Z`);
  await statsStore.increment('reed', 'instagram', 'conversations_started', at);
  await statsStore.increment('reed', 'instagram', 'messages_in', at);
  await statsStore.increment('reed', 'instagram', 'messages_in', at);
  await statsStore.increment('reed', 'instagram', 'messages_out', at);
  await statsStore.increment('iris', 'messenger', 'messages_in', at);
}

const DAY = '2026-08-10';

describe('GET /stats/daily', () => {
  describe('mounting and auth', () => {
    it('returns 200 with the day rows for a correct token', async () => {
      const { app, statsStore } = buildApp();
      await seedCounts(statsStore, DAY);
      const res = await request(app)
        .get('/stats/daily')
        .query({ since: DAY, until: DAY })
        .set('Authorization', `Bearer ${STATS_TOKEN}`);
      expect(res.status).toBe(200);
      expect(res.body.days).toEqual([
        {
          date: DAY,
          account: 'iris',
          channel: 'messenger',
          conversations_started: 0,
          messages_in: 1,
          messages_out: 0
        },
        {
          date: DAY,
          account: 'reed',
          channel: 'instagram',
          conversations_started: 1,
          messages_in: 2,
          messages_out: 1
        }
      ]);
    });

    it('accepts the x-stats-api-token header form too', async () => {
      const { app, statsStore } = buildApp();
      await seedCounts(statsStore, DAY);
      const res = await request(app)
        .get('/stats/daily')
        .query({ since: DAY, until: DAY })
        .set('x-stats-api-token', STATS_TOKEN);
      expect(res.status).toBe(200);
      expect(res.body.days).toHaveLength(2);
    });

    it('returns an empty days array for a span that counted nothing', async () => {
      const { app } = buildApp();
      const res = await request(app)
        .get('/stats/daily')
        .query({ since: '2026-01-01', until: '2026-01-31' })
        .set('Authorization', `Bearer ${STATS_TOKEN}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ days: [] });
    });

    it('defaults `until` to today (UTC) when it is omitted', async () => {
      const { app, statsStore } = buildApp();
      const today = new Date().toISOString().slice(0, 10);
      await seedCounts(statsStore, today);
      const res = await request(app)
        .get('/stats/daily')
        .query({ since: today })
        .set('Authorization', `Bearer ${STATS_TOKEN}`);
      expect(res.status).toBe(200);
      expect(res.body.days).toHaveLength(2);
      expect(res.body.days[0].date).toBe(today);
    });

    it('returns 401 without a token', async () => {
      const { app } = buildApp();
      const res = await request(app).get('/stats/daily').query({ since: DAY });
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'unauthorized' });
    });

    it('returns 401 with the wrong token', async () => {
      const { app } = buildApp();
      const res = await request(app)
        .get('/stats/daily')
        .query({ since: DAY })
        .set('Authorization', 'Bearer wrong-token-9999999999');
      expect(res.status).toBe(401);
    });

    it('401s BEFORE validating the dates (auth is the first gate)', async () => {
      const { app } = buildApp();
      const res = await request(app).get('/stats/daily').query({ since: 'nonsense' });
      expect(res.status).toBe(401);
    });

    it('is NOT mounted (404) when statsApiToken is unset', async () => {
      // GUARDED AT REGISTRATION, like the admin routes: an unconfigured deploy
      // 404s rather than 401ing, so it never advertises that the surface exists.
      const { app } = buildApp({ configOverrides: { statsApiToken: undefined } });
      const res = await request(app)
        .get('/stats/daily')
        .query({ since: DAY })
        .set('Authorization', `Bearer ${STATS_TOKEN}`);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'not_found' });
    });

    it('is NOT mounted (404) when no stats store is wired', async () => {
      const { app } = buildApp({ noStatsStore: true });
      const res = await request(app)
        .get('/stats/daily')
        .query({ since: DAY })
        .set('Authorization', `Bearer ${STATS_TOKEN}`);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'not_found' });
    });
  });

  describe('date validation (400, never a silent full-range scan)', () => {
    const bad = async (query: Record<string, string>): Promise<request.Response> => {
      const { app } = buildApp();
      return request(app)
        .get('/stats/daily')
        .query(query)
        .set('Authorization', `Bearer ${STATS_TOKEN}`);
    };

    it('400s when `since` is missing entirely', async () => {
      const res = await bad({});
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/since must be a YYYY-MM-DD date/);
    });

    it('400s on a malformed `since`', async () => {
      const res = await bad({ since: '10-08-2026' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/since must be a YYYY-MM-DD date/);
    });

    it('400s on a malformed `until`', async () => {
      const res = await bad({ since: DAY, until: 'yesterday' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/until must be a YYYY-MM-DD date/);
    });

    it('400s on a well-shaped but impossible calendar date', async () => {
      // Date.parse would roll 2026-02-30 into March; parseIsoDate round-trips.
      const res = await bad({ since: '2026-02-30' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/not a real calendar date/);
    });

    it('400s when `until` is before `since`', async () => {
      const res = await bad({ since: '2026-08-10', until: '2026-08-01' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/is before since/);
    });

    it(`400s on a span longer than ${MAX_RANGE_DAYS} days`, async () => {
      const res = await bad({ since: '2020-01-01', until: '2026-08-10' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(new RegExp(`exceeds the ${MAX_RANGE_DAYS}-day maximum`));
    });

    it('accepts a span of exactly one day (since === until)', async () => {
      const res = await bad({ since: DAY, until: DAY });
      expect(res.status).toBe(200);
    });
  });

  describe('store failure', () => {
    it('returns 500 with a JSON body (does not hang) when range rejects', async () => {
      const failing: StatsStore = {
        async increment(): Promise<void> {
          /* no-op */
        },
        async range(): Promise<never> {
          throw new Error('redis is on fire');
        }
      };
      const { app, logger } = buildApp({ statsStore: failing });
      const res = await request(app)
        .get('/stats/daily')
        .query({ since: DAY, until: DAY })
        .set('Authorization', `Bearer ${STATS_TOKEN}`);
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'internal_error' });
      expect(logger.mock.error).toHaveBeenCalled();
    });
  });

  /* ────────────────────────────────────────────────────────────────────── */
  /* The security claim: two tokens, and neither opens the other's door.    */
  /* ────────────────────────────────────────────────────────────────────── */

  describe('token separation', () => {
    it('REJECTS the admin token on /stats/daily', async () => {
      const { app } = buildApp();
      const bearer = await request(app)
        .get('/stats/daily')
        .query({ since: DAY, until: DAY })
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
      expect(bearer.status).toBe(401);
      const header = await request(app)
        .get('/stats/daily')
        .query({ since: DAY, until: DAY })
        .set('x-admin-api-token', ADMIN_TOKEN);
      expect(header.status).toBe(401);
    });

    it('REJECTS the stats token on /admin/conversations/:key', async () => {
      // The point of the whole exercise: the daily counts reader cannot read a
      // conversation transcript. Seeded so a leak would actually return content.
      const { app, store } = buildApp();
      await seedConversation(store);
      const bearer = await request(app)
        .get(`/admin/conversations/${SEEDED_KEY}`)
        .set('Authorization', `Bearer ${STATS_TOKEN}`);
      expect(bearer.status).toBe(401);
      expect(JSON.stringify(bearer.body)).not.toContain(SEEDED_USER_ID);
      const header = await request(app)
        .get(`/admin/conversations/${SEEDED_KEY}`)
        .set('x-stats-api-token', STATS_TOKEN);
      expect(header.status).toBe(401);
    });

    it('REJECTS the stats token on /admin/status/:messageId', async () => {
      const { app, statusTracker } = buildApp();
      statusTracker.applyStatusUpdate({
        channelMessageId: 'wamid.STATS.SEP.1',
        channel: 'whatsapp',
        status: 'delivered',
        timestamp: 1_716_000_000,
        conversationKey: SEEDED_KEY,
        recipientId: SEEDED_USER_ID
      });
      const bearer = await request(app)
        .get('/admin/status/wamid.STATS.SEP.1')
        .set('Authorization', `Bearer ${STATS_TOKEN}`);
      expect(bearer.status).toBe(401);
      expect(JSON.stringify(bearer.body)).not.toContain(SEEDED_USER_ID);
      const header = await request(app)
        .get('/admin/status/wamid.STATS.SEP.1')
        .set('x-stats-api-token', STATS_TOKEN);
      expect(header.status).toBe(401);
    });

    it('REJECTS the stats token on /metrics', async () => {
      const { app } = buildApp();
      const bearer = await request(app)
        .get('/metrics')
        .set('Authorization', `Bearer ${STATS_TOKEN}`);
      expect(bearer.status).toBe(401);
      expect(bearer.body).toEqual({ error: 'unauthorized' });
      const header = await request(app).get('/metrics').set('x-stats-api-token', STATS_TOKEN);
      expect(header.status).toBe(401);
    });

    it('REJECTS the stats token on /admin/queue and /admin/dedupe', async () => {
      const { app } = buildApp();
      const queue = await request(app)
        .get('/admin/queue')
        .set('Authorization', `Bearer ${STATS_TOKEN}`);
      expect(queue.status).toBe(401);
      const dedupe = await request(app)
        .get('/admin/dedupe')
        .query({ messageId: 'wamid.x' })
        .set('Authorization', `Bearer ${STATS_TOKEN}`);
      expect(dedupe.status).toBe(401);
    });

    it('still serves each surface to ITS OWN token', async () => {
      // The rejections above must be about the credential, not about a route
      // that stopped working.
      const { app, store, statsStore } = buildApp();
      await seedConversation(store);
      await seedCounts(statsStore, DAY);
      const stats = await request(app)
        .get('/stats/daily')
        .query({ since: DAY, until: DAY })
        .set('Authorization', `Bearer ${STATS_TOKEN}`);
      expect(stats.status).toBe(200);
      const admin = await request(app)
        .get(`/admin/conversations/${SEEDED_KEY}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
      expect(admin.status).toBe(200);
      const metrics = await request(app)
        .get('/metrics')
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
      expect(metrics.status).toBe(200);
    });
  });
});
