/**
 * Stage 10 GET /ready Redis-ping integration test (HARDWARE-FREE).
 *
 * Builds `createApp` directly with `config.redisUrl` set to a dummy URL and an
 * INJECTED fake `redisClient` (the minimal {@link RedisPinger} shape), so the
 * /ready redis check exercises the real timeout-bounded `ping()` race WITHOUT a
 * live Redis. Three behaviors:
 *   - ping resolves       → 200, checks.redis.status === 'ok'
 *   - ping rejects        → 503, checks.redis.status === 'error'
 *   - ping never settles  → 503, checks.redis.status === 'error' (timeout fires)
 *
 * Config is built via `loadConfig` with a crafted env (matching the rest of the
 * integration suite's loader-driven construction), then overridden where needed
 * (e.g. a tiny readyRedisTimeoutMs for the hang case).
 */

import { describe, expect, it } from 'vitest';
import request from 'supertest';
import pino from 'pino';
import { createApp, type RedisPinger } from '../../src/http/app.js';
import { loadConfig, type Config } from '../../src/config/loader.js';

const BASE_ENV: Record<string, string> = {
  META_APP_SECRET: 'test-app-secret-1234567890',
  META_VERIFY_TOKEN: 'test-verify-token-1234567890',
  CHAT_ENDPOINT_URL: 'http://localhost:9999/chat',
  NGROK_DOMAIN: 'test.ngrok-free.dev',
  WHATSAPP_PHONE_NUMBER_ID: '200000000000002',
  WHATSAPP_ACCESS_TOKEN: 'fake-whatsapp-access-token-long-enough',
  REDIS_URL: 'redis://localhost:6379'
};

function makeConfig(overrides?: Partial<Config>): Config {
  const config = loadConfig({ ...BASE_ENV });
  return { ...config, ...overrides };
}

const logger = pino({ level: 'silent' });

/** A fake RedisPinger whose ping() resolves with a 'PONG'-like value. */
const resolvingClient: RedisPinger = {
  ping: () => Promise.resolve('PONG')
};

/** A fake RedisPinger whose ping() rejects (connection refused, etc.). */
const rejectingClient: RedisPinger = {
  ping: () => Promise.reject(new Error('ECONNREFUSED'))
};

/** A fake RedisPinger whose ping() never settles — exercises the timeout race. */
const hangingClient: RedisPinger = {
  ping: () => new Promise<unknown>(() => {})
};

describe('GET /ready Redis ping (injected fake client, hardware-free)', () => {
  it('returns 200 ok when the ping resolves', async () => {
    const app = createApp({ config: makeConfig(), logger, redisClient: resolvingClient });
    const res = await request(app).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
    expect(res.body.checks.redis).toEqual({ status: 'ok' });
  });

  it('returns 503 error when the ping rejects', async () => {
    const app = createApp({ config: makeConfig(), logger, redisClient: rejectingClient });
    const res = await request(app).get('/ready');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('not_ready');
    expect(res.body.checks.redis.status).toBe('error');
    expect(typeof res.body.checks.redis.error).toBe('string');
  });

  it('returns 503 error when the ping never settles (timeout fires)', async () => {
    // Tiny readyRedisTimeoutMs so the never-settling ping loses the race quickly.
    const base = makeConfig();
    const config: Config = {
      ...base,
      persistence: { ...base.persistence, readyRedisTimeoutMs: 50 }
    };
    const app = createApp({ config, logger, redisClient: hangingClient });
    const res = await request(app).get('/ready');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('not_ready');
    expect(res.body.checks.redis.status).toBe('error');
    expect(String(res.body.checks.redis.error)).toContain('timed out');
  });

  it('reports configured (no ping) when REDIS_URL is set but no client is injected', async () => {
    // Presence-only: a Redis URL is configured but the runtime did not hand a
    // client to createApp, so /ready can only report presence, not health.
    const app = createApp({ config: makeConfig(), logger });
    const res = await request(app).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body.checks.redis).toEqual({ status: 'configured' });
  });
});
