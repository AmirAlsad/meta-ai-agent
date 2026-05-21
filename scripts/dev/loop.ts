/**
 * One-command full-stack loop runner — dev tooling, NOT part of the published
 * package.
 *
 * Boots, in one process: the keyword-driven test chat endpoint, the REAL
 * ConversationAgent (via `buildRuntime`), an ngrok tunnel, and webhook
 * registration. The founder can then message the bot from real devices and
 * watch the actual Stage 5 loop run (buffering, ordered delivery, typing
 * injection, dedupe, echo filtering, IG reply→message downgrade).
 */
import 'dotenv/config';
import path from 'node:path';
import type { Server } from 'node:http';
import pino from 'pino';

import { loadConfig, type Config } from '../../src/config/loader.js';
import { buildRuntime } from '../../src/index.js';
import { startTunnel } from '../lib/tunnel.js';
import { registerAllWebhooks } from '../setup/register-webhooks.js';
import { startTestChatEndpoint } from './test-chat-endpoint.js';
import { info, success, warn, fail, divider, registerShutdown } from '../lib/console.js';

const KEYWORD_CHEATSHEET = [
  '  reply       → quoted reply targeting your last message',
  '  react       → 👍 reaction on your last message',
  '  multi       → three separate messages (ordered delivery)',
  '  typing      → typing indicator, then a message',
  '  template    → hello_world template (WhatsApp)',
  '  media       → an image with a caption',
  '  silence     → bot stays silent (no reply)',
  '  <anything>  → echo, showing [channel] and buffered message count'
];

interface CliArgs {
  chatPort: number;
  /**
   * When set, point the agent at this EXTERNAL chat endpoint URL instead of
   * booting the in-process keyword test endpoint. Used to run the live stack
   * against a standalone endpoint (e.g. the showcase-bot on http://localhost:4055).
   */
  chatEndpoint?: string;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let chatPort = 4000;
  let chatEndpoint: string | undefined;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') help = true;
    else if (arg.startsWith('--chat-port=')) chatPort = Number.parseInt(arg.slice('--chat-port='.length), 10);
    else if (arg === '--chat-port') {
      const next = argv[i + 1];
      if (next) chatPort = Number.parseInt(next, 10);
    } else if (arg.startsWith('--chat-endpoint=')) chatEndpoint = arg.slice('--chat-endpoint='.length).trim();
    else if (arg === '--chat-endpoint') {
      const next = argv[i + 1];
      if (next) chatEndpoint = next.trim();
    }
  }
  if (!Number.isFinite(chatPort) || chatPort < 1 || chatPort > 65535) chatPort = 4000;
  return { chatPort, chatEndpoint: chatEndpoint || undefined, help };
}

function printHelp(): void {
  process.stdout.write(
    [
      'Usage: npm run dev:loop -- [options]',
      '',
      'Boots the test chat endpoint + real ConversationAgent + ngrok tunnel +',
      'webhook registration in one process, so you can message the bot from real',
      'devices and watch the Stage 5 loop.',
      '',
      'Options:',
      '  --chat-port=<n>       Port for the in-process test chat endpoint (default 4000).',
      '  --chat-endpoint=<url> Point the agent at an EXTERNAL chat endpoint instead of',
      '                        the in-process test endpoint (e.g. the showcase-bot:',
      '                        --chat-endpoint=http://localhost:4055). Start that',
      '                        endpoint separately first.',
      '  --help, -h            Show this help.',
      '',
      'Keywords (in-process test endpoint only; ignored with --chat-endpoint):',
      ...KEYWORD_CHEATSHEET,
      ''
    ].join('\n')
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const logger = pino({
    level: process.env.LOG_LEVEL ?? 'info',
    transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' } }
  });

  divider('meta-ai-agent: full-stack dev loop');

  // 1. Resolve the chat endpoint. By default we boot the in-process keyword
  // test endpoint; with --chat-endpoint=<url> we instead point the agent at an
  // EXTERNAL standalone endpoint (e.g. the showcase-bot) the developer started
  // separately, and do NOT boot the test endpoint.
  let chat: { url: string; close: () => Promise<void> } | undefined;
  let chatUrl: string;
  if (args.chatEndpoint) {
    chatUrl = args.chatEndpoint;
    success(`External chat endpoint: ${chatUrl} (the in-process test endpoint is NOT booted)`);
  } else {
    chat = await startTestChatEndpoint({ port: args.chatPort, logger });
    chatUrl = chat.url;
    success(`Test chat endpoint: ${chatUrl}`);
  }

  // 2. Point the agent's HttpChatClient at the resolved endpoint regardless of
  // what's in .env. `import 'dotenv/config'` already ran at import time, but
  // reassigning here still wins because `loadConfig()` reads `process.env` live
  // (below).
  process.env.CHAT_ENDPOINT_URL = chatUrl;

  // 3. Load config + build the runtime (real adapters + agent).
  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(`Configuration error: ${msg}`);
    await chat?.close();
    process.exitCode = 1;
    return;
  }

  const { app, agent } = buildRuntime(config, logger);

  // 4. Start the agent's HTTP server (webhook receiver).
  const server: Server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(config.port, () => resolve(s));
    s.on('error', reject);
  });
  success(`Agent listening on port ${config.port}`);

  // 5. Open the ngrok tunnel to the agent's port.
  const tunnel = await startTunnel({
    port: config.port,
    domain: config.ngrokDomain,
    authtoken: process.env.NGROK_AUTHTOKEN
  });
  success(`Tunnel: ${tunnel.url}`);

  // 6. Register webhooks against the tunnel's /webhook callback. Per-channel
  // results are printed; WhatsApp manual_required (no per-WABA subscribe) is
  // non-fatal — the rest of the loop still works once the Dashboard step is done.
  divider('webhook registration');
  const summary = await registerAllWebhooks({
    config,
    callbackUrl: `${tunnel.url}/webhook`,
    logger
  });
  for (const r of summary.results) {
    const label = r.channel.toUpperCase();
    switch (r.status) {
      case 'success':
        success(`${label}: ${r.message}`);
        break;
      case 'skipped':
        info(`${label} (skipped): ${r.message}`);
        break;
      case 'manual_required':
        warn(`${label}: ${r.message}`);
        if (r.remediation) warn(`        ${r.remediation}`);
        break;
      case 'failed':
        fail(`${label}: ${r.message}`);
        break;
    }
  }

  // 7. Ready banner.
  const channels = Object.entries(config.channels)
    .filter(([, on]) => on)
    .map(([name]) => name)
    .join(', ');
  divider('ready');
  success('Full-stack loop is up.');
  info(`Tunnel URL:        ${tunnel.url}`);
  info(`Chat endpoint:     ${chatUrl}${chat ? '' : ' (external)'}`);
  info(`Configured channels: ${channels || '(none)'}`);
  if (chat) {
    info('Keywords:');
    for (const line of KEYWORD_CHEATSHEET) info(line);
  } else {
    info('Using an external chat endpoint — its own logic decides the replies.');
  }
  divider();
  info('Message the bot from any configured channel and watch the loop here.');
  info('Press Ctrl-C to stop.');

  // 8. Clean shutdown: close the agent (drains scheduler + delivery timers),
  // then the server, the chat endpoint, and the tunnel. No hard process.exit
  // mid-async — registerShutdown sets the exit code and lets the loop drain.
  registerShutdown(async () => {
    await agent.close().catch(err => logger.error({ err }, 'agent close failed'));
    await new Promise<void>(resolve => server.close(() => resolve()));
    await chat?.close();
    await tunnel.close();
  });
}

/**
 * Detect direct execution vs. library import. Resolve both argv[1] and
 * import.meta.url to absolute paths — same convention as scripts/.
 */
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
    const msg = err instanceof Error ? err.message : String(err);
    fail(`Unexpected error: ${msg}`);
    process.exitCode = 1;
  });
}
