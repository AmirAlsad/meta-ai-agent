import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import request from 'supertest';
import type pino from 'pino';
import { createApp } from '../../src/http/app.js';
import type { Config } from '../../src/config/loader.js';
import { defaultConversationConfig } from '../../src/config/loader.js';
import * as parserModule from '../../src/meta/parser.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(here, '../fixtures/meta');

const APP_SECRET = 'test-app-secret-1234567890';
const VERIFY_TOKEN = 'test-verify-token-1234567890';

interface SpyLogger {
  info: Mock;
  warn: Mock;
  error: Mock;
  debug: Mock;
  fatal: Mock;
  trace: Mock;
}

type SpyPinoLogger = pino.Logger & { mock: SpyLogger };

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
    chatEndpointUrl: 'http://localhost:9999/chat',
    ngrokDomain: 'test.ngrok-free.dev',
    agentAutostart: false,
    port: 3000,
    nodeEnv: 'test'
  };
  return { ...base, ...overrides };
}

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

function signBody(body: Buffer, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

function loadFixtureBuffer(relativePath: string): Buffer {
  const raw = readFileSync(path.join(fixturesDir, relativePath), 'utf8');
  const parsed = JSON.parse(raw);
  // Re-serialize so the byte sequence is deterministic and the signature
  // computed over `bodyBuf` exactly matches what supertest sends as the body.
  return Buffer.from(JSON.stringify(parsed));
}

describe('webhook routing integration', () => {
  let logger: SpyPinoLogger;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    logger = makeSpyLogger();
    app = createApp({ config: makeTestConfig(), logger });
  });

  it('routes POST /webhook with whatsapp_business_account object to the whatsapp channel', async () => {
    const bodyBuf = loadFixtureBuffer('whatsapp/text-inbound.json');
    const signature = signBody(bodyBuf, APP_SECRET);

    const res = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('x-hub-signature-256', signature)
      .send(bodyBuf.toString('utf8'));

    expect(res.status).toBe(200);
    expect(res.text).toBe('EVENT_RECEIVED');
    // Channel-level summary log: the Stage 1 contract, now also carrying
    // messageCount/statusCount derived from the parser.
    expect(logger.mock.info).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'whatsapp',
        traceMarker: 'inbound.whatsapp',
        messageCount: 1,
        statusCount: 0
      }),
      'inbound webhook received'
    );
    // Per-message log emitted by the parser dispatcher.
    expect(logger.mock.info).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'whatsapp',
        traceMarker: 'inbound.message',
        messageType: 'text'
      }),
      'inbound message parsed'
    );
  });

  it('routes POST /webhook with page object to the messenger channel', async () => {
    const bodyBuf = loadFixtureBuffer('messenger/text-message.json');
    const signature = signBody(bodyBuf, APP_SECRET);

    const res = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('x-hub-signature-256', signature)
      .send(bodyBuf.toString('utf8'));

    expect(res.status).toBe(200);
    expect(res.text).toBe('EVENT_RECEIVED');
    expect(logger.mock.info).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'messenger',
        traceMarker: 'inbound.messenger',
        messageCount: 1,
        statusCount: 0
      }),
      'inbound webhook received'
    );
    expect(logger.mock.info).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'messenger',
        traceMarker: 'inbound.message',
        messageType: 'text'
      }),
      'inbound message parsed'
    );
  });

  it('routes POST /webhook with instagram object to the instagram channel', async () => {
    const bodyBuf = loadFixtureBuffer('instagram/text-dm.json');
    const signature = signBody(bodyBuf, APP_SECRET);

    const res = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('x-hub-signature-256', signature)
      .send(bodyBuf.toString('utf8'));

    expect(res.status).toBe(200);
    expect(res.text).toBe('EVENT_RECEIVED');
    expect(logger.mock.info).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'instagram',
        traceMarker: 'inbound.instagram',
        messageCount: 1,
        statusCount: 0
      }),
      'inbound webhook received'
    );
    expect(logger.mock.info).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'instagram',
        traceMarker: 'inbound.message',
        messageType: 'text'
      }),
      'inbound message parsed'
    );
  });

  it('emits an inbound.status log for a WhatsApp delivered-status payload', async () => {
    const bodyBuf = loadFixtureBuffer('whatsapp/status-delivered.json');
    const signature = signBody(bodyBuf, APP_SECRET);

    const res = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('x-hub-signature-256', signature)
      .send(bodyBuf.toString('utf8'));

    expect(res.status).toBe(200);
    expect(res.text).toBe('EVENT_RECEIVED');
    // Status payload carries no inbound message — only a StatusUpdate.
    expect(logger.mock.info).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'whatsapp',
        traceMarker: 'inbound.status',
        status: 'delivered'
      }),
      'inbound status update'
    );
    expect(logger.mock.info).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'whatsapp',
        traceMarker: 'inbound.whatsapp',
        messageCount: 0,
        statusCount: 1
      }),
      'inbound webhook received'
    );
  });

  it('emits an inbound.status log for a WhatsApp read-status payload', async () => {
    const bodyBuf = loadFixtureBuffer('whatsapp/status-read.json');
    const signature = signBody(bodyBuf, APP_SECRET);

    const res = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('x-hub-signature-256', signature)
      .send(bodyBuf.toString('utf8'));

    expect(res.status).toBe(200);
    expect(logger.mock.info).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'whatsapp',
        traceMarker: 'inbound.status',
        status: 'read'
      }),
      'inbound status update'
    );
  });

  it('still emits the channel-summary log when the WhatsApp payload is malformed (entry not an array)', async () => {
    // Parser is contractually non-throwing on malformed input — it must return
    // an empty ParseResult and the dispatcher must still emit the summary log.
    const bodyBuf = Buffer.from(
      JSON.stringify({ object: 'whatsapp_business_account', entry: 'not-an-array' })
    );
    const signature = signBody(bodyBuf, APP_SECRET);

    const res = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('x-hub-signature-256', signature)
      .send(bodyBuf.toString('utf8'));

    expect(res.status).toBe(200);
    expect(res.text).toBe('EVENT_RECEIVED');
    expect(logger.mock.info).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'whatsapp',
        traceMarker: 'inbound.whatsapp',
        messageCount: 0,
        statusCount: 0
      }),
      'inbound webhook received'
    );
    // No per-message or per-status logs should have fired.
    const allInfoMarkers = logger.mock.info.mock.calls
      .map((call) => (call[0] as { traceMarker?: unknown } | undefined)?.traceMarker)
      .filter((m): m is string => typeof m === 'string');
    expect(allInfoMarkers).not.toContain('inbound.message');
    expect(allInfoMarkers).not.toContain('inbound.status');
    // The dispatcher's defensive catch must not have fired.
    expect(logger.mock.error).not.toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'whatsapp' }),
      'dispatcher parse failed unexpectedly'
    );
  });

  it('emits the messenger summary log without per-message logs for an empty entry array', async () => {
    const bodyBuf = Buffer.from(JSON.stringify({ object: 'page', entry: [] }));
    const signature = signBody(bodyBuf, APP_SECRET);

    const res = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('x-hub-signature-256', signature)
      .send(bodyBuf.toString('utf8'));

    expect(res.status).toBe(200);
    expect(logger.mock.info).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'messenger',
        traceMarker: 'inbound.messenger',
        messageCount: 0,
        statusCount: 0,
        entryCount: 0
      }),
      'inbound webhook received'
    );
    const allMarkers = [
      ...logger.mock.info.mock.calls,
      ...logger.mock.warn.mock.calls
    ]
      .map((call) => (call[0] as { traceMarker?: unknown } | undefined)?.traceMarker)
      .filter((m): m is string => typeof m === 'string');
    expect(allMarkers).not.toContain('inbound.message');
    expect(allMarkers).not.toContain('inbound.status');
  });

  it('routes POST /webhook with an unknown object to the unknown channel via warn log', async () => {
    const bodyBuf = Buffer.from(JSON.stringify({ object: 'unknown_thing', entry: [] }));
    const signature = signBody(bodyBuf, APP_SECRET);

    const res = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('x-hub-signature-256', signature)
      .send(bodyBuf.toString('utf8'));

    expect(res.status).toBe(200);
    expect(res.text).toBe('EVENT_RECEIVED');
    expect(logger.mock.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'unknown',
        traceMarker: 'inbound.unknown',
        messageCount: 0,
        statusCount: 0
      }),
      'inbound webhook with unknown object field'
    );
  });

  it('rejects POST /webhook with 401 when the signature was computed with the wrong secret', async () => {
    const bodyBuf = loadFixtureBuffer('whatsapp/text-inbound.json');
    const signature = signBody(bodyBuf, 'wrong-secret');

    const res = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('x-hub-signature-256', signature)
      .send(bodyBuf.toString('utf8'));

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'invalid_signature' });

    // The dispatch path must not have logged any inbound.* trace marker.
    const allCalls = [
      ...logger.mock.info.mock.calls,
      ...logger.mock.warn.mock.calls,
      ...logger.mock.error.mock.calls
    ];
    for (const call of allCalls) {
      const firstArg = call[0] as { traceMarker?: unknown } | undefined;
      const marker = firstArg?.traceMarker;
      if (typeof marker === 'string') {
        expect(marker.startsWith('inbound.')).toBe(false);
      }
    }
  });

  it('rejects POST /webhook with 401 when the x-hub-signature-256 header is missing', async () => {
    const bodyBuf = loadFixtureBuffer('whatsapp/text-inbound.json');

    const res = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .send(bodyBuf.toString('utf8'));

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'invalid_signature' });
  });

  it('echoes the challenge as plain text on GET /webhook with subscribe + correct token', async () => {
    const res = await request(app)
      .get('/webhook')
      .query({
        'hub.mode': 'subscribe',
        'hub.verify_token': VERIFY_TOKEN,
        'hub.challenge': '12345'
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type'] ?? '').toMatch(/^text\/plain/);
    expect(res.text).toBe('12345');
  });

  it('returns 403 on GET /webhook with an incorrect verify_token', async () => {
    const res = await request(app)
      .get('/webhook')
      .query({
        'hub.mode': 'subscribe',
        'hub.verify_token': 'wrong-token-1234567890',
        'hub.challenge': '12345'
      });

    expect(res.status).toBe(403);
  });

  it('returns 403 on GET /webhook with mode=unsubscribe even when the token is correct', async () => {
    const res = await request(app)
      .get('/webhook')
      .query({
        'hub.mode': 'unsubscribe',
        'hub.verify_token': VERIFY_TOKEN,
        'hub.challenge': '12345'
      });

    expect(res.status).toBe(403);
  });

  it('reports liveness on GET /health with status, version, and nodeVersion', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok' });
    expect(typeof res.body.version).toBe('string');
    expect((res.body as { version: string }).version.length).toBeGreaterThan(0);
    expect(typeof res.body.nodeVersion).toBe('string');
    expect(typeof res.body.uptimeSeconds).toBe('number');
  });

  describe('dispatchWebhook defensive catch', () => {
    afterEach(() => {
      // Restore the spy after each test so subsequent tests see the real
      // parser. Without this restore, suite-order would matter and a single
      // failure could cascade.
      vi.restoreAllMocks();
    });

    it('logs dispatcher parse failed unexpectedly and still ACKs 200 when parseMetaWebhook throws', async () => {
      // The parser is documented as non-throwing; the dispatcher wraps it in
      // a try/catch as a safety net. This test exercises that safety net.
      const spy = vi
        .spyOn(parserModule, 'parseMetaWebhook')
        .mockImplementationOnce(() => {
          throw new Error('synthetic parser explosion');
        });

      const bodyBuf = loadFixtureBuffer('whatsapp/text-inbound.json');
      const signature = signBody(bodyBuf, APP_SECRET);

      const res = await request(app)
        .post('/webhook')
        .set('Content-Type', 'application/json')
        .set('x-hub-signature-256', signature)
        .send(bodyBuf.toString('utf8'));

      // ACK happens before dispatch — 200 is load-bearing for Meta retry.
      expect(res.status).toBe(200);
      expect(res.text).toBe('EVENT_RECEIVED');
      expect(spy).toHaveBeenCalledTimes(1);

      expect(logger.mock.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        'dispatcher parse failed unexpectedly'
      );

      // No per-message or per-status logs should have fired in this call.
      const markers = [
        ...logger.mock.info.mock.calls,
        ...logger.mock.warn.mock.calls
      ]
        .map((call) => (call[0] as { traceMarker?: unknown } | undefined)?.traceMarker)
        .filter((m): m is string => typeof m === 'string');
      expect(markers).not.toContain('inbound.message');
      expect(markers).not.toContain('inbound.status');
    });
  });
});
