import { createHmac } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import request from 'supertest';
import type pino from 'pino';
import {
  startCaptureServer,
  type CaptureServerHandle,
  type CapturedWebhook
} from '../../scripts/lib/capture-server.js';
import type { Config } from '../../src/config/loader.js';

const APP_SECRET = 'test-app-secret-1234567890';
const VERIFY_TOKEN = 'test-verify-token-1234567890';

interface SpyLogger {
  info: Mock;
  warn: Mock;
  error: Mock;
  debug: Mock;
}

function makeSpyLogger(): pino.Logger & { mock: SpyLogger } {
  const mock: SpyLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  };
  const logger: Record<string, unknown> = {
    info: mock.info,
    warn: mock.warn,
    error: mock.error,
    debug: mock.debug,
    fatal: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
    level: 'info',
    child(): unknown {
      return logger;
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
  return logger as unknown as pino.Logger & { mock: SpyLogger };
}

function makeConfig(): Config {
  return {
    meta: {
      appId: '111',
      appSecret: APP_SECRET,
      verifyToken: VERIFY_TOKEN,
      graphApiVersion: 'v25.0'
    },
    whatsapp: {
      phoneNumberId: '200000000000002',
      accessToken: 'wa-token'
    },
    channels: { whatsapp: true, messenger: false, instagram: false },
    chatEndpointUrl: 'http://localhost:9999/chat',
    ngrokDomain: 'test.ngrok-free.dev',
    agentAutostart: false,
    port: 0, // Bind to a random free port for tests.
    nodeEnv: 'test'
  };
}

function fakeTunnel(): { url: string; close: Mock } {
  const close = vi.fn(async () => {
    /* no-op */
  });
  return { url: 'https://fake-tunnel.ngrok.app', close };
}

function signBody(body: Buffer, secret: string = APP_SECRET): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

function whatsAppPayload(): unknown {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '100',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '15551234567',
                phone_number_id: '200000000000002'
              },
              messages: [
                {
                  from: '15557654321',
                  id: 'wamid.abc',
                  timestamp: '1716000000',
                  type: 'text',
                  text: { body: 'Hi from test' }
                }
              ]
            }
          }
        ]
      }
    ]
  };
}

describe('startCaptureServer', () => {
  let handle: CaptureServerHandle | undefined;
  let tmpCapturesDir: string;
  let tunnel: ReturnType<typeof fakeTunnel>;
  let logger: ReturnType<typeof makeSpyLogger>;

  beforeEach(async () => {
    tmpCapturesDir = await mkdtemp(path.join(tmpdir(), 'meta-ai-agent-captures-'));
    tunnel = fakeTunnel();
    logger = makeSpyLogger();
  });

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = undefined;
    }
    await rm(tmpCapturesDir, { recursive: true, force: true });
  });

  it('exposes the tunnel URL and the bound localPort, and never calls real ngrok when tunnelOverride is set', async () => {
    handle = await startCaptureServer({
      config: makeConfig(),
      tunnelOverride: tunnel,
      capturesDir: tmpCapturesDir,
      logger
    });
    expect(handle.url).toBe('https://fake-tunnel.ngrok.app');
    expect(typeof handle.localPort).toBe('number');
    expect(handle.localPort).toBeGreaterThan(0);
    expect(tunnel.close).not.toHaveBeenCalled();
  });

  it('captures a valid-signature WhatsApp payload, fires the subscriber, and saveCapture writes to the right channel dir', async () => {
    handle = await startCaptureServer({
      config: makeConfig(),
      tunnelOverride: tunnel,
      capturesDir: tmpCapturesDir,
      logger
    });
    const received: CapturedWebhook[] = [];
    handle.onWebhook((cap) => received.push(cap));

    const body = Buffer.from(JSON.stringify(whatsAppPayload()));
    const res = await request(`http://127.0.0.1:${handle.localPort}`)
      .post('/webhook')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', signBody(body))
      .send(body.toString('utf8'));

    expect(res.status).toBe(200);
    expect(res.text).toBe('EVENT_RECEIVED');
    expect(received).toHaveLength(1);
    const cap = received[0]!;
    expect(cap.channelHint).toBe('whatsapp');
    expect(cap.signatureValid).toBe(true);
    expect(cap.parsed.messages).toHaveLength(1);
    expect(cap.parsed.messages[0]?.type).toBe('text');
    // Signature header redacted to length-only.
    expect(cap.headers['x-hub-signature-256']).toMatch(/^\[redacted, length=\d+\]$/);

    const filePath = await handle.saveCapture(cap);
    expect(filePath).toContain(path.join(tmpCapturesDir, 'whatsapp'));
    const onDisk = JSON.parse(await readFile(filePath, 'utf8'));
    expect(onDisk.channelHint).toBe('whatsapp');
    expect(onDisk.parsed.messages[0].type).toBe('text');
  });

  it('appends a numeric suffix when saveCapture is called with the same filename twice', async () => {
    handle = await startCaptureServer({
      config: makeConfig(),
      tunnelOverride: tunnel,
      capturesDir: tmpCapturesDir,
      logger
    });

    const fakeCap: CapturedWebhook = {
      receivedAt: Date.now(),
      channelHint: 'whatsapp',
      rawBody: {},
      parsed: { messages: [], statuses: [] },
      signatureValid: true,
      headers: {}
    };
    const first = await handle.saveCapture(fakeCap, { filename: 'fixed.json' });
    const second = await handle.saveCapture(fakeCap, { filename: 'fixed.json' });
    expect(first).not.toBe(second);
    expect(second).toMatch(/fixed-1\.json$/);
  });

  it('rejects with 401 (strict mode default) when signature is invalid and does NOT capture the body', async () => {
    handle = await startCaptureServer({
      config: makeConfig(),
      tunnelOverride: tunnel,
      capturesDir: tmpCapturesDir,
      logger
    });
    const received: CapturedWebhook[] = [];
    handle.onWebhook((cap) => received.push(cap));

    const body = Buffer.from(JSON.stringify(whatsAppPayload()));
    const res = await request(`http://127.0.0.1:${handle.localPort}`)
      .post('/webhook')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', signBody(body, 'wrong-secret'))
      .send(body.toString('utf8'));

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'invalid_signature' });
    // Strict mode: subscriber must NOT have been fired for invalid sig.
    expect(received).toHaveLength(0);
    // The buffer must also be empty.
    expect(handle.getRecentCaptures()).toHaveLength(0);
  });

  it('accepts invalid signatures when acceptInvalidSignatures=true, marks signatureValid=false, ACKs 200', async () => {
    handle = await startCaptureServer({
      config: makeConfig(),
      tunnelOverride: tunnel,
      capturesDir: tmpCapturesDir,
      acceptInvalidSignatures: true,
      logger
    });
    const received: CapturedWebhook[] = [];
    handle.onWebhook((cap) => received.push(cap));

    const body = Buffer.from(JSON.stringify(whatsAppPayload()));
    const res = await request(`http://127.0.0.1:${handle.localPort}`)
      .post('/webhook')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', signBody(body, 'wrong-secret'))
      .send(body.toString('utf8'));

    expect(res.status).toBe(200);
    expect(res.text).toBe('EVENT_RECEIVED');
    expect(received).toHaveLength(1);
    expect(received[0]?.signatureValid).toBe(false);
    expect(received[0]?.parsed.messages).toHaveLength(1);
  });

  it('responds 200 with the challenge for GET /webhook verification with correct token', async () => {
    handle = await startCaptureServer({
      config: makeConfig(),
      tunnelOverride: tunnel,
      capturesDir: tmpCapturesDir,
      logger
    });
    const res = await request(`http://127.0.0.1:${handle.localPort}`)
      .get('/webhook')
      .query({
        'hub.mode': 'subscribe',
        'hub.verify_token': VERIFY_TOKEN,
        'hub.challenge': 'CHAL_12345'
      });
    expect(res.status).toBe(200);
    expect(res.text).toBe('CHAL_12345');
  });

  it('responds 403 for GET /webhook verification with wrong token', async () => {
    handle = await startCaptureServer({
      config: makeConfig(),
      tunnelOverride: tunnel,
      capturesDir: tmpCapturesDir,
      logger
    });
    const res = await request(`http://127.0.0.1:${handle.localPort}`)
      .get('/webhook')
      .query({
        'hub.mode': 'subscribe',
        'hub.verify_token': 'wrong-token-1234567890',
        'hub.challenge': 'CHAL_12345'
      });
    expect(res.status).toBe(403);
  });

  it('getRecentCaptures returns most-recent-last and respects the limit argument', async () => {
    handle = await startCaptureServer({
      config: makeConfig(),
      tunnelOverride: tunnel,
      capturesDir: tmpCapturesDir,
      logger
    });

    for (let i = 0; i < 3; i++) {
      const body = Buffer.from(
        JSON.stringify({
          ...(whatsAppPayload() as object),
          // Vary the inner message id so parser doesn't dedupe across requests.
          entry: [
            {
              ...((whatsAppPayload() as { entry: unknown[] }).entry[0] as object),
              id: `entry-${i}`
            }
          ]
        })
      );
      await request(`http://127.0.0.1:${handle.localPort}`)
        .post('/webhook')
        .set('content-type', 'application/json')
        .set('x-hub-signature-256', signBody(body))
        .send(body.toString('utf8'));
    }

    expect(handle.getRecentCaptures()).toHaveLength(3);
    expect(handle.getRecentCaptures(2)).toHaveLength(2);
  });

  it('onWebhook returns an unsubscribe function that detaches the callback', async () => {
    handle = await startCaptureServer({
      config: makeConfig(),
      tunnelOverride: tunnel,
      capturesDir: tmpCapturesDir,
      logger
    });

    const received: CapturedWebhook[] = [];
    const unsubscribe = handle.onWebhook((cap) => received.push(cap));
    unsubscribe();

    const body = Buffer.from(JSON.stringify(whatsAppPayload()));
    const res = await request(`http://127.0.0.1:${handle.localPort}`)
      .post('/webhook')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', signBody(body))
      .send(body.toString('utf8'));

    expect(res.status).toBe(200);
    expect(received).toHaveLength(0);
    // Buffer still records it — only the subscriber was detached.
    expect(handle.getRecentCaptures()).toHaveLength(1);
  });

  it('close() invokes the tunnel close() exactly once', async () => {
    handle = await startCaptureServer({
      config: makeConfig(),
      tunnelOverride: tunnel,
      capturesDir: tmpCapturesDir,
      logger
    });
    await handle.close();
    handle = undefined;
    expect(tunnel.close).toHaveBeenCalledTimes(1);
  });
});
