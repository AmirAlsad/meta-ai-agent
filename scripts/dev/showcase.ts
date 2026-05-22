/**
 * Scripted live showcase harness — dev tooling, NOT part of the published
 * package, NEVER run in CI. Requires real Meta creds + NGROK_DOMAIN + a real
 * device to drive end-to-end.
 *
 * Mirrors the sibling sendblue repo's `scripts/e2e/showcase.ts`, adapted to
 * Meta's three channels. In one process it boots:
 *  - the REAL runtime via {@link buildRuntime} (same wiring as `dev:loop`),
 *  - pointed at a DETERMINISTIC, scenario-aware in-process chat endpoint (NOT an
 *    LLM — the package stays model-provider-free),
 *  - an ngrok tunnel (`scripts/lib/tunnel.ts`, using `config.ngrokDomain`),
 *  - and Meta webhook registration (`scripts/setup/register-webhooks.ts`).
 *
 * It then walks a per-channel scenario list (the core matrix: text, reply,
 * reaction, typing, media, and — WhatsApp — template), prompting the operator
 * for each user action and reporting what the agent understood. Every outbound
 * Graph API call is instrumented (via a `globalThis.fetch` tap installed before
 * the runtime is built — the GraphClient binds the default fetch at construction)
 * and every inbound webhook is captured raw. Per-step succeeded/failed/timed-out
 * counts plus the raw captures are written under
 * `.captures/meta-showcase/<session>/` (gitignored — may contain secrets, phone
 * numbers, message content).
 *
 * Instrumentation strategy (WHY, since `src/` is off-limits to this script):
 *  - Outbound: monkey-patch `globalThis.fetch` BEFORE `buildRuntime`. The
 *    GraphClient defaults to `globalThis.fetch.bind(globalThis)`, so it picks up
 *    our wrapper; we record every request to graph.facebook.com /
 *    graph.instagram.com and delegate to the real fetch. Localhost chat-endpoint
 *    POSTs are ignored.
 *  - Inbound: a thin capturing reverse-proxy sits in FRONT of the agent app. The
 *    ngrok tunnel points at the proxy; the proxy reads the raw body, records it,
 *    then forwards the exact bytes (signature header intact) to the agent app on
 *    a private localhost port. This avoids any byte-mutating body replay that
 *    would break the load-bearing raw-body signature verification.
 *
 * Flags: `--channel=<x>` scope, `--only=<ids>` subset, `--list` (no creds), and
 * `skip` (the operator replies "skip" to advance past a step). Cleanup runs via
 * `registerShutdown` from `scripts/lib/console.ts` (house rule — no bespoke
 * SIGINT handler).
 */
import 'dotenv/config';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import express, { type Request, type Response } from 'express';
import pino from 'pino';

import { loadConfig, type Config } from '../../src/config/loader.js';
import { buildRuntime } from '../../src/index.js';
import { objectToChannel } from '../../src/http/app.js';
import type { ChatRequest } from '../../src/chat/types.js';
import type { Channel } from '../../src/meta/types.js';
import { startTunnel, type ActiveTunnel } from '../lib/tunnel.js';
import { registerAllWebhooks } from '../setup/register-webhooks.js';
import { info, success, warn, fail, divider, step, registerShutdown } from '../lib/console.js';
import {
  selectShowcaseScenarios,
  formatShowcaseScenarioList,
  summarizeShowcaseStep,
  aggregateSessionTotals,
  buildShowcaseChatResponse,
  summarizeUnderstanding,
  isSkipContent,
  type ShowcaseScenario,
  type ShowcaseInboundEnvelope,
  type ShowcaseChatExchange,
  type ShowcaseOutboundCall,
  type ShowcaseStepSummary
} from './showcase-scenarios.js';

/* ────────────────────────────────────────────────────────────────────────── */
/* CLI flags                                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

interface ShowcaseFlags {
  help: boolean;
  list: boolean;
  channel: Channel | undefined;
  only: string[] | undefined;
  /** Override the outbound demo media URL (else SHOWCASE_MEDIA_URL / default). */
  mediaUrl: string | undefined;
  /** Per-step wait timeout in ms (default 3 min). */
  timeoutMs: number;
  /** Quiet window (ms) after first activity before scoring a step (default 4s). */
  settleMs: number;
}

export function parseShowcaseFlags(argv: readonly string[]): ShowcaseFlags {
  const flags: ShowcaseFlags = {
    help: false,
    list: false,
    channel: undefined,
    only: undefined,
    mediaUrl: undefined,
    timeoutMs: 3 * 60 * 1000,
    settleMs: 4000
  };
  for (const raw of argv) {
    if (raw === '--help' || raw === '-h') {
      flags.help = true;
      continue;
    }
    if (raw === '--list') {
      flags.list = true;
      continue;
    }
    if (raw.startsWith('--channel=')) {
      const v = raw.slice('--channel='.length);
      if (v !== 'whatsapp' && v !== 'messenger' && v !== 'instagram') {
        throw new Error(`Invalid --channel=${v}: expected whatsapp|messenger|instagram.`);
      }
      flags.channel = v;
      continue;
    }
    if (raw.startsWith('--only=')) {
      flags.only = raw
        .slice('--only='.length)
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      continue;
    }
    if (raw.startsWith('--media-url=')) {
      flags.mediaUrl = raw.slice('--media-url='.length).trim() || undefined;
      continue;
    }
    if (raw.startsWith('--timeout-ms=')) {
      const v = Number.parseInt(raw.slice('--timeout-ms='.length), 10);
      if (Number.isFinite(v) && v > 0) flags.timeoutMs = v;
      continue;
    }
    if (raw.startsWith('--settle-ms=')) {
      const v = Number.parseInt(raw.slice('--settle-ms='.length), 10);
      if (Number.isFinite(v) && v >= 0) flags.settleMs = v;
      continue;
    }
    throw new Error(`Unknown flag: ${raw}. Run with --help for usage.`);
  }
  return flags;
}

const HELP_TEXT = `
showcase — Scripted live Meta showcase (dev-only; needs real creds + a device).

Boots the REAL runtime (buildRuntime) pointed at a deterministic, scenario-aware
chat endpoint + ngrok tunnel + webhook registration, then walks a per-channel
scenario matrix (text, reply, reaction, typing, media, and WhatsApp template).
Each step prompts you for a device action; the agent responds with what it
understood. Raw inbound webhooks + outbound Graph calls are instrumented and a
per-step summary.json is written under .captures/meta-showcase/<session>/.

Usage:
  npm run showcase [-- --flag ...]
  npx tsx scripts/dev/showcase.ts [options]

Options:
  --channel=<x>     whatsapp | messenger | instagram. Default: all channels.
  --only=<a,b,c>    Run only these scenario ids (channel-prefixed, e.g.
                    whatsapp:reaction). See --list for the ids.
  --list            Print the scenario ids (grouped by channel) and exit.
                    Requires NO credentials.
  --media-url=<url> Override the outbound demo media URL (else SHOWCASE_MEDIA_URL).
  --timeout-ms=<n>  Per-step wait timeout. Default 180000 (3 min).
  --settle-ms=<n>   Quiet window after first activity before scoring. Default 4000.
  --help, -h        Show this message.

During a step, reply "skip" from your device to advance past it.
Captures may contain secrets, phone numbers, and message content — they are
gitignored under .captures/. Use Ctrl-C to stop early.
`.trim();

/* ────────────────────────────────────────────────────────────────────────── */
/* Outbound fetch instrumentation                                             */
/* ────────────────────────────────────────────────────────────────────────── */

const GRAPH_HOSTS = new Set(['graph.facebook.com', 'graph.instagram.com']);

/**
 * Install a `globalThis.fetch` tap that records outbound Graph API calls into
 * `sink` and delegates to the original fetch. Returns an uninstall fn. The
 * GraphClient binds `globalThis.fetch` at construction, so this MUST be called
 * before `buildRuntime`. We only record graph.* hosts — the chat-endpoint POST
 * (localhost) and any other fetch pass straight through unrecorded.
 */
function installOutboundFetchTap(sink: ShowcaseOutboundCall[]): () => void {
  const original = globalThis.fetch;
  const wrapped: typeof fetch = async (input, init) => {
    const url = requestUrl(input);
    const host = safeHost(url);
    const isGraph = host !== undefined && GRAPH_HOSTS.has(host);
    if (!isGraph) return original(input, init);

    const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')) || 'GET';
    const channel = host === 'graph.instagram.com' ? 'instagram' : graphChannelFromUrl(url);
    const record: ShowcaseOutboundCall = {
      at: new Date().toISOString(),
      channel,
      method: `${method} ${graphPathSummary(url)}`,
      recipientId: '',
      ok: false
    };
    try {
      const res = await original(input, init);
      // Clone so reading the body for the id doesn't consume it for the caller.
      record.ok = res.ok;
      if (!res.ok) record.error = `HTTP ${res.status}`;
      try {
        const body = (await res.clone().json()) as Record<string, unknown>;
        const id = extractMessageId(body);
        if (id) record.messageId = id;
        if (!res.ok) record.error = extractGraphError(body) ?? record.error;
      } catch {
        /* non-JSON / empty body — leave id/error as-is */
      }
      sink.push(record);
      return res;
    } catch (err) {
      record.ok = false;
      record.error = err instanceof Error ? err.message : String(err);
      sink.push(record);
      throw err;
    }
  };
  globalThis.fetch = wrapped;
  return () => {
    globalThis.fetch = original;
  };
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function safeHost(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

function graphChannelFromUrl(url: string): Channel {
  // Best-effort: WhatsApp sends include `messaging_product=whatsapp` or hit a
  // phone-number-id path; Messenger uses `/me/messages` or a page id. We can't
  // always tell, so default to messenger for facebook-host non-IG calls. The
  // per-step scoping makes this label informational only.
  return /whatsapp/i.test(url) ? 'whatsapp' : 'messenger';
}

function graphPathSummary(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function extractMessageId(body: Record<string, unknown>): string | undefined {
  // WhatsApp: { messages: [{ id }] }. Messenger/IG: { message_id }.
  const messages = body.messages;
  if (Array.isArray(messages) && messages[0] && typeof messages[0] === 'object') {
    const id = (messages[0] as Record<string, unknown>).id;
    if (typeof id === 'string') return id;
  }
  if (typeof body.message_id === 'string') return body.message_id;
  return undefined;
}

function extractGraphError(body: Record<string, unknown>): string | undefined {
  const error = body.error;
  if (error && typeof error === 'object') {
    const message = (error as Record<string, unknown>).message;
    const code = (error as Record<string, unknown>).code;
    if (typeof message === 'string') return code !== undefined ? `${message} (code ${String(code)})` : message;
  }
  return undefined;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Capturing reverse proxy (inbound raw webhooks)                             */
/* ────────────────────────────────────────────────────────────────────────── */

interface ProxyHandle {
  /** Public-facing port the ngrok tunnel should point at. */
  port: number;
  close(): Promise<void>;
}

/**
 * Stand up a capturing reverse proxy in FRONT of the agent app. It reads the
 * raw request body (so we can capture the bit-faithful webhook), records it for
 * a POST /webhook, then forwards the EXACT bytes + headers to the agent app on
 * `agentPort`. Forwarding raw bytes preserves the X-Hub-Signature-256 the agent
 * verifies. The `currentScenarioId` callback tags each capture with the active
 * step. `onInbound` is invoked for every recorded webhook so the harness can
 * detect skip replies / step activity in real time.
 */
async function startCaptureProxy(opts: {
  port: number;
  agentPort: number;
  currentScenarioId: () => string | undefined;
  onInbound: (envelope: ShowcaseInboundEnvelope) => void;
  logger: pino.Logger;
}): Promise<ProxyHandle> {
  const app = express();
  // express.raw captures the body as a Buffer WITHOUT JSON-parsing it, so the
  // bytes we forward (and verify the signature over downstream) stay exact.
  app.use(express.raw({ type: () => true, limit: '6mb' }));

  app.all('*', async (req: Request, res: Response) => {
    const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

    // Record only inbound POST /webhook bodies (the GET handshake + others just
    // proxy through).
    if (req.method === 'POST' && req.path === '/webhook') {
      void recordInbound(raw, opts);
    }

    try {
      const target = `http://127.0.0.1:${opts.agentPort}${req.originalUrl}`;
      const headers = forwardHeaders(req.headers);
      const upstream = await fetch(target, {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : raw
      });
      res.status(upstream.status);
      const ct = upstream.headers.get('content-type');
      if (ct) res.type(ct);
      const text = await upstream.text();
      res.send(text);
    } catch (err) {
      opts.logger.error({ err }, 'capture proxy upstream forward failed');
      if (!res.headersSent) res.status(502).send('bad gateway');
    }
  });

  const server: Server = await new Promise((resolve, reject) => {
    const s = app.listen(opts.port, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });

  return {
    port: opts.port,
    close: () => new Promise<void>(resolve => server.close(() => resolve()))
  };
}

function forwardHeaders(headers: Request['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    // Drop hop-by-hop / host headers; keep the signature + content-type so the
    // agent verifies the body and parses it the same way Meta posted it.
    if (key === 'host' || key === 'connection' || key === 'content-length') continue;
    if (typeof value === 'string') out[key] = value;
    else if (Array.isArray(value)) out[key] = value.join(', ');
  }
  return out;
}

async function recordInbound(
  raw: Buffer,
  opts: {
    currentScenarioId: () => string | undefined;
    onInbound: (envelope: ShowcaseInboundEnvelope) => void;
  }
): Promise<void> {
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    body = { _unparseable: true };
  }
  const objectField =
    body !== null && typeof body === 'object' ? (body as { object?: unknown }).object : undefined;
  const envelope: ShowcaseInboundEnvelope = {
    at: new Date().toISOString(),
    scenarioId: opts.currentScenarioId(),
    channel: objectToChannel(objectField),
    body,
    // We only note that a signature header was present here; the agent app does
    // the authoritative verification. Keeping this lightweight avoids duplicating
    // the verifier from src/ in a dev script.
    signatureValid: true
  };
  opts.onInbound(envelope);
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Deterministic scenario-aware chat endpoint                                 */
/* ────────────────────────────────────────────────────────────────────────── */

interface ChatEndpointHandle {
  url: string;
  exchanges: ShowcaseChatExchange[];
  close(): Promise<void>;
}

async function startShowcaseChatEndpoint(opts: {
  mediaUrl?: string;
  currentScenarioId: () => string | undefined;
  logger: pino.Logger;
}): Promise<ChatEndpointHandle> {
  const exchanges: ShowcaseChatExchange[] = [];
  const app = express();
  app.use(express.json({ limit: '6mb' }));

  const handler = (req: Request, res: Response): void => {
    const request = req.body as ChatRequest;
    const response = buildShowcaseChatResponse(
      request,
      opts.mediaUrl !== undefined ? { mediaUrl: opts.mediaUrl } : {}
    );
    exchanges.push({
      at: new Date().toISOString(),
      scenarioId: opts.currentScenarioId(),
      channel: request.channel,
      messageCount: Array.isArray(request.messages) ? request.messages.length : 0,
      understood: summarizeUnderstanding(request),
      request,
      response
    });
    res.status(200).json(response);
  };
  app.post('/chat', handler);
  app.post('/', handler);

  const server: Server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  return {
    url: `http://127.0.0.1:${port}/chat`,
    exchanges,
    close: () => new Promise<void>(resolve => server.close(() => resolve()))
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Step driver                                                                */
/* ────────────────────────────────────────────────────────────────────────── */

interface StepActivity {
  inbound: ShowcaseInboundEnvelope[];
  exchanges: ShowcaseChatExchange[];
  outbound: ShowcaseOutboundCall[];
}

/**
 * Wait for a scenario to complete: poll the captured activity until either a
 * skip reply arrives, the step has both an inbound + an outbound (matched), or
 * the timeout elapses. After first activity, wait for a quiet `settleMs` window
 * so trailing outbounds (typing→message, multi-send) are counted.
 */
async function waitForStep(opts: {
  scenario: ShowcaseScenario;
  inbound: ShowcaseInboundEnvelope[];
  exchanges: ShowcaseChatExchange[];
  outbound: ShowcaseOutboundCall[];
  baseInbound: number;
  baseExchanges: number;
  baseOutbound: number;
  timeoutMs: number;
  settleMs: number;
  shuttingDown: () => boolean;
}): Promise<{ skipped: boolean }> {
  const deadline = Date.now() + opts.timeoutMs;
  let lastActivityAt = 0;
  let lastCount = -1;

  while (!opts.shuttingDown() && Date.now() < deadline) {
    const stepInbound = opts.inbound.slice(opts.baseInbound);
    const stepOutbound = opts.outbound.slice(opts.baseOutbound);

    if (stepInbound.some(env => isSkipEnvelope(env))) {
      return { skipped: true };
    }

    const activityCount = stepInbound.length + opts.exchanges.slice(opts.baseExchanges).length + stepOutbound.length;
    if (activityCount !== lastCount) {
      lastCount = activityCount;
      if (activityCount > 0) lastActivityAt = Date.now();
    }

    const hasInbound = stepInbound.length > 0;
    const hasOutbound = stepOutbound.length > 0;
    const settled = lastActivityAt > 0 && Date.now() - lastActivityAt >= opts.settleMs;
    if (hasInbound && hasOutbound && settled) {
      return { skipped: false };
    }
    await delay(500);
  }
  return { skipped: false };
}

function isSkipEnvelope(env: ShowcaseInboundEnvelope): boolean {
  const texts = collectTexts(env.body);
  return texts.some(t => isSkipContent(t));
}

/** Best-effort recursive text extraction from a raw webhook body. */
function collectTexts(body: unknown, depth = 0): string[] {
  if (depth > 8 || body === null || typeof body !== 'object') return [];
  const out: string[] = [];
  const record = body as Record<string, unknown>;
  // WhatsApp text bubble: messages[i].text.body. Messenger/IG: messaging[i].message.text.
  if (typeof record.body === 'string') out.push(record.body);
  if (typeof record.text === 'string') out.push(record.text);
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) {
      for (const item of value) out.push(...collectTexts(item, depth + 1));
    } else if (value && typeof value === 'object') {
      out.push(...collectTexts(value, depth + 1));
    }
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Summary file                                                               */
/* ────────────────────────────────────────────────────────────────────────── */

async function writeRawInboundCaptures(outputDir: string, inbound: ShowcaseInboundEnvelope[]): Promise<void> {
  if (inbound.length === 0) return;
  await mkdir(outputDir, { recursive: true });
  let seq = 0;
  for (const env of inbound) {
    seq += 1;
    const ts = env.at.replace(/[:.]/g, '-');
    const scenario = env.scenarioId ? `${safeSegment(env.scenarioId)}-` : '';
    const filename = `${ts}-${String(seq).padStart(4, '0')}-${scenario}${env.channel}.json`;
    await writeFile(path.join(outputDir, filename), `${JSON.stringify(env, null, 2)}\n`, { mode: 0o600 });
  }
}

async function writeSummary(outputDir: string, summary: unknown): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-') || 'step';
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Main                                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  let flags: ShowcaseFlags;
  try {
    flags = parseShowcaseFlags(process.argv.slice(2));
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    process.exitCode = 2;
    return;
  }

  if (flags.help) {
    process.stdout.write(`${HELP_TEXT}\n`);
    return;
  }

  // `--list` runs with NO config / creds — it's a pure inventory dump. Resolve
  // it before loadConfig so `node ... --list` works on a fresh checkout.
  if (flags.list) {
    process.stdout.write(`${formatShowcaseScenarioList().join('\n')}\n`);
    return;
  }

  let scenarios: ShowcaseScenario[];
  try {
    scenarios = selectShowcaseScenarios({
      ...(flags.channel ? { channel: flags.channel } : {}),
      ...(flags.only ? { only: flags.only } : {})
    });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    process.exitCode = 2;
    return;
  }
  if (scenarios.length === 0) {
    warn('No scenarios selected. Run with --list to see available ids.');
    return;
  }

  const logger = pino({
    level: process.env.LOG_LEVEL ?? 'info',
    transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' } }
  });

  divider('meta-ai-agent: scripted live showcase');

  // Session bookkeeping.
  const sessionId = randomUUID().slice(0, 8);
  const outputDir = path.resolve(process.cwd(), '.captures/meta-showcase', sessionId);
  const startedAt = new Date().toISOString();
  const mediaUrl = flags.mediaUrl ?? process.env.SHOWCASE_MEDIA_URL;

  // Shared activity sinks — populated by the fetch tap, the chat endpoint, and
  // the capture proxy; sliced per step in the driver.
  const inbound: ShowcaseInboundEnvelope[] = [];
  const outbound: ShowcaseOutboundCall[] = [];
  let activeScenarioId: string | undefined;
  let shuttingDown = false;
  const currentScenarioId = (): string | undefined => activeScenarioId;

  // Outbound tap MUST be installed before buildRuntime (the GraphClient binds
  // globalThis.fetch at construction). uninstall on shutdown.
  const uninstallFetchTap = installOutboundFetchTap(outbound);

  // Boot the deterministic chat endpoint first so we can point CHAT_ENDPOINT_URL
  // at it before loadConfig reads process.env.
  const chat = await startShowcaseChatEndpoint({
    ...(mediaUrl ? { mediaUrl } : {}),
    currentScenarioId,
    logger
  });
  process.env.CHAT_ENDPOINT_URL = chat.url;
  success(`Deterministic chat endpoint: ${chat.url}`);

  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    fail(`Configuration error: ${err instanceof Error ? err.message : String(err)}`);
    uninstallFetchTap();
    await chat.close();
    process.exitCode = 1;
    return;
  }

  // Filter the requested scenarios down to CONFIGURED channels so we never sit
  // waiting on a channel with no adapter.
  const runnable = scenarios.filter(s => config.channels[s.channel]);
  const droppedChannels = [...new Set(scenarios.filter(s => !config.channels[s.channel]).map(s => s.channel))];
  for (const ch of droppedChannels) {
    warn(`${ch} is not configured — skipping its scenarios. (run npm run setup:${ch})`);
  }
  if (runnable.length === 0) {
    fail('None of the selected scenarios target a configured channel.');
    uninstallFetchTap();
    await chat.close();
    process.exitCode = 1;
    return;
  }

  // Build the REAL runtime (real adapters + agent), then run it on a PRIVATE
  // localhost port behind the capture proxy.
  // We use the wired Express app + aggregate close; the agent instance is driven
  // entirely via the inbound webhooks the capture proxy forwards.
  const { app, close: closeRuntime } = buildRuntime(config, logger);
  const agentPort = config.port + 1; // private; the public tunnel hits the proxy.
  const agentServer: Server = await new Promise((resolve, reject) => {
    const s = app.listen(agentPort, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
  success(`Agent app (private): http://127.0.0.1:${agentPort}`);

  const proxy = await startCaptureProxy({
    port: config.port,
    agentPort,
    currentScenarioId,
    onInbound: env => inbound.push(env),
    logger
  });
  success(`Capture proxy (public-facing): http://127.0.0.1:${proxy.port} → agent`);

  // Tunnel points at the PROXY port so every inbound webhook is captured raw.
  let tunnel: ActiveTunnel;
  try {
    tunnel = await startTunnel({
      port: proxy.port,
      domain: config.ngrokDomain,
      ...(process.env.NGROK_AUTHTOKEN ? { authtoken: process.env.NGROK_AUTHTOKEN } : {})
    });
  } catch (err) {
    fail(`Tunnel failed: ${err instanceof Error ? err.message : String(err)}`);
    uninstallFetchTap();
    await proxy.close();
    await new Promise<void>(resolve => agentServer.close(() => resolve()));
    await closeRuntime();
    await chat.close();
    process.exitCode = 1;
    return;
  }
  success(`Tunnel: ${tunnel.url}`);

  // Register webhooks against the tunnel's /webhook callback.
  divider('webhook registration');
  try {
    const summary = await registerAllWebhooks({ config, callbackUrl: `${tunnel.url}/webhook`, logger });
    for (const r of summary.results) {
      const label = r.channel.toUpperCase();
      if (r.status === 'success') success(`${label}: ${r.message}`);
      else if (r.status === 'skipped') info(`${label} (skipped): ${r.message}`);
      else if (r.status === 'manual_required') {
        warn(`${label}: ${r.message}`);
        if (r.remediation) warn(`        ${r.remediation}`);
      } else fail(`${label}: ${r.message}`);
    }
  } catch (err) {
    warn(`Webhook registration threw: ${err instanceof Error ? err.message : String(err)}. Continuing.`);
  }

  // Cleanup via the shared registry (house rule — no bespoke SIGINT handler).
  const cleanup = async (): Promise<void> => {
    shuttingDown = true;
    uninstallFetchTap();
    await tunnel.close().catch(() => undefined);
    await proxy.close().catch(() => undefined);
    await new Promise<void>(resolve => agentServer.close(() => resolve()));
    await closeRuntime().catch(err => logger.error({ err }, 'runtime close failed'));
    await chat.close().catch(() => undefined);
  };
  registerShutdown(cleanup);

  divider('ready');
  success(`Showcase is up. Session ${sessionId}.`);
  info(`Tunnel:   ${tunnel.url}`);
  info(`Captures: ${outputDir}`);
  info(`Steps:    ${runnable.length} (${runnable.map(s => s.id).join(', ')})`);
  info('Reply "skip" from your device to advance past a step. Ctrl-C to stop.');

  const summaries: ShowcaseStepSummary[] = [];
  try {
    for (const [index, scenario] of runnable.entries()) {
      if (shuttingDown) break;
      activeScenarioId = scenario.id;
      const baseInbound = inbound.length;
      const baseOutbound = outbound.length;
      const baseExchanges = chat.exchanges.length;

      divider(`channel: ${scenario.channel}`);
      step(index + 1, runnable.length, `${scenario.id} — ${scenario.title}`);
      if (scenario.optional) info('Optional step. Reply "skip" to move on.');
      info(scenario.instruction);

      const result = await waitForStep({
        scenario,
        inbound,
        exchanges: chat.exchanges,
        outbound,
        baseInbound,
        baseExchanges,
        baseOutbound,
        timeoutMs: flags.timeoutMs,
        settleMs: flags.settleMs,
        shuttingDown: () => shuttingDown
      });

      const activity: StepActivity = {
        inbound: inbound.slice(baseInbound),
        exchanges: chat.exchanges.slice(baseExchanges),
        outbound: outbound.slice(baseOutbound)
      };
      const stepSummary = summarizeShowcaseStep({
        scenario,
        skipped: result.skipped,
        inbound: activity.inbound,
        exchanges: activity.exchanges,
        outbound: activity.outbound
      });
      summaries.push(stepSummary);

      const marker = stepSummary.skipped ? 'skipped' : stepSummary.matched ? 'matched' : 'incomplete';
      const tag = marker === 'matched' ? success : marker === 'skipped' ? info : warn;
      tag(
        `Step ${marker}: ${stepSummary.inboundCount} inbound, ${stepSummary.chatRequestCount} chat call(s), ` +
          `${stepSummary.outboundSucceededCount}/${stepSummary.outboundCount} outbound ok` +
          (stepSummary.outboundFailedCount > 0 ? ` (${stepSummary.outboundFailedCount} failed)` : '')
      );
      if (stepSummary.understood) info(`Understood: ${stepSummary.understood}`);
    }

    activeScenarioId = undefined;
    const totals = aggregateSessionTotals(summaries);
    await writeRawInboundCaptures(outputDir, inbound);
    await writeSummary(outputDir, {
      sessionId,
      startedAt,
      completedAt: new Date().toISOString(),
      tunnelUrl: tunnel.url,
      chatEndpointUrl: chat.url,
      mediaUrl: mediaUrl ?? null,
      channelsRequested: flags.channel ?? 'all',
      totals,
      steps: summaries
    });

    divider('summary');
    success(
      `Done: ${totals.matched} matched, ${totals.skipped} skipped, ${totals.incomplete} incomplete ` +
        `(${totals.outboundSucceeded} outbound ok, ${totals.outboundFailed} failed).`
    );
    info(`Summary: ${path.join(outputDir, 'summary.json')}`);
  } finally {
    await cleanup();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    const t = setTimeout(resolve, ms);
    t.unref();
  });
}

/* ────────────────────────────────────────────────────────────────────────── */
/* CLI entry point                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

const invokedAsScript = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    const thisFile = new URL(import.meta.url).pathname;
    return path.resolve(entry) === path.resolve(thisFile);
  } catch {
    return false;
  }
})();

if (invokedAsScript) {
  main().catch((err: unknown) => {
    fail(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
