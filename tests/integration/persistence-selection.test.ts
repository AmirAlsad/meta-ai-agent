/**
 * Stage 10 persistence-selection integration test.
 *
 * Verifies `buildRuntime`'s dual-path store/scheduler selection end-to-end via
 * the wired Express app (supertest hitting GET /ready):
 *
 *   - DEFAULT / in-memory branch (no REDIS_URL): the in-memory trio is wired,
 *     the returned object exposes `close`, and /ready reports the in-memory
 *     scheduler + redis `not_configured`. HARDWARE-FREE — always runs.
 *
 *   - REDIS branch (gated on TEST_REDIS_URL): a real Redis client backs the
 *     conversation store + limit-counter store and a BullMQ scheduler; /ready
 *     pings Redis (`ok`) and reports the `bullmq` scheduler. SKIPPED unless
 *     TEST_REDIS_URL is set, so CI stays hardware-free.
 *
 * `buildRuntime` is the SUT here (not `createApp` directly) — this is the only
 * test that exercises the runtime's persistence selection + the new `close`.
 */

import { describe, expect, it } from 'vitest';
import request from 'supertest';
import pino from 'pino';
import { buildRuntime } from '../../src/index.js';
import { loadConfig, type Config } from '../../src/config/loader.js';

const BASE_ENV: Record<string, string> = {
  META_APP_SECRET: 'test-app-secret-1234567890',
  META_VERIFY_TOKEN: 'test-verify-token-1234567890',
  CHAT_ENDPOINT_URL: 'http://localhost:9999/chat',
  NGROK_DOMAIN: 'test.ngrok-free.dev',
  WHATSAPP_PHONE_NUMBER_ID: '200000000000002',
  WHATSAPP_ACCESS_TOKEN: 'fake-whatsapp-access-token-long-enough'
};

const logger = pino({ level: 'silent' });

function makeConfig(extraEnv?: Record<string, string>): Config {
  return loadConfig({ ...BASE_ENV, ...extraEnv });
}

describe('buildRuntime persistence selection', () => {
  describe('default / in-memory branch (no REDIS_URL)', () => {
    it('wires the in-memory trio, exposes close, and /ready reports redis not_configured', async () => {
      const config = makeConfig();
      expect(config.redisUrl).toBeUndefined();

      const runtime = buildRuntime(config, logger);
      try {
        expect(typeof runtime.close).toBe('function');

        const res = await request(runtime.app).get('/ready');
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('ready');
        // No REDIS_URL → presence-only "not_configured" (no ping).
        expect(res.body.checks.redis).toEqual({ status: 'not_configured' });
        // The in-memory scheduler is the one wired on this path.
        expect(res.body.checks.scheduler.status).toBe('ok');
        expect(res.body.checks.scheduler.kind).toBe('in_memory');
      } finally {
        await runtime.close();
      }
    });
  });

  // Gate the live-Redis branch on TEST_REDIS_URL so CI stays hardware-free.
  const describeRedis = process.env.TEST_REDIS_URL ? describe : describe.skip;
  describeRedis('redis branch (REDIS_URL set)', () => {
    it('wires the Redis store + BullMQ scheduler, and /ready pings Redis ok', async () => {
      const config = makeConfig({ REDIS_URL: process.env.TEST_REDIS_URL as string });
      expect(config.redisUrl).toBeDefined();

      const runtime = buildRuntime(config, logger);
      try {
        const res = await request(runtime.app).get('/ready');
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('ready');
        expect(res.body.checks.redis.status).toBe('ok');
        expect(res.body.checks.scheduler.status).toBe('ok');
        expect(res.body.checks.scheduler.kind).toBe('bullmq');
      } finally {
        await runtime.close();
      }
    });
  });
});
