/**
 * Keyword-driven test chat endpoint — dev tooling, NOT part of the published
 * package.
 *
 * Implements the chat contract (`src/chat/types.ts`): it RECEIVES a
 * {@link ChatRequest} and RETURNS a {@link ChatResponse}. Instead of calling a
 * real LLM, it scans the aggregated `req.message` for keywords and returns a
 * deterministic response so the founder can exercise every branch of the
 * Stage 5 conversation loop (buffering, ordered delivery, typing injection,
 * dedupe, echo filtering, IG reply→message downgrade) from real devices.
 *
 * Two pieces:
 *  - {@link buildTestChatResponse} — pure keyword router (unit-tested).
 *  - {@link startTestChatEndpoint} — boots a tiny Express server around it.
 */
import path from 'node:path';
import type { Server } from 'node:http';
import express, { type Request, type Response } from 'express';
import pino from 'pino';

import type { ChatRequest, ChatResponse } from '../../src/chat/types.js';
import { registerShutdown, info, success, divider } from '../lib/console.js';

/* ────────────────────────────────────────────────────────────────────────── */
/* Pure keyword router                                                        */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Map an inbound {@link ChatRequest} to a deterministic {@link ChatResponse}
 * by scanning the aggregated `req.message` (lowercased) for keywords. Rules are
 * checked in the order below; the FIRST match wins. The default branch echoes
 * the channel + buffered message COUNT so a multi-message burst surfaces the
 * buffering (a 3-message burst shows "(3 msg)").
 */
export function buildTestChatResponse(req: ChatRequest): ChatResponse {
  const text = (req.message ?? '').toLowerCase();
  // The reaction / reply actions target the LAST message of the buffered turn —
  // that's the message the user most recently sent, so reacting to it reads
  // naturally on the device.
  const lastMid = req.messages.at(-1)?.channelMessageId ?? '';

  if (text.includes('silence')) {
    return { silence: true };
  }
  if (text.includes('multi')) {
    return {
      actions: [
        { type: 'message', text: 'first' },
        { type: 'message', text: 'second' },
        { type: 'message', text: 'third' }
      ]
    };
  }
  if (text.includes('react')) {
    return { actions: [{ type: 'reaction', emoji: '👍', targetMessageId: lastMid }] };
  }
  if (text.includes('reply')) {
    return { actions: [{ type: 'reply', text: '↩️ quoted reply', targetMessageId: lastMid }] };
  }
  if (text.includes('typing')) {
    return {
      actions: [
        { type: 'typing', durationMs: 3000 },
        { type: 'message', text: 'done "typing"' }
      ]
    };
  }
  if (text.includes('template')) {
    return { actions: [{ type: 'template', name: 'hello_world', language: 'en_US' }] };
  }
  if (text.includes('media')) {
    return {
      actions: [
        { type: 'media', url: 'https://www.gstatic.com/webp/gallery/1.jpg', caption: 'sample' }
      ]
    };
  }

  // Default / echo. The message count makes BUFFERING visible.
  return {
    message: `echo [${req.channel}] (${req.messages.length} msg): ${req.message}`
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Express server                                                             */
/* ────────────────────────────────────────────────────────────────────────── */

export interface TestChatEndpointOptions {
  port: number;
  logger?: pino.Logger;
}

export interface TestChatEndpointHandle {
  /** Full URL of the chat route — point CHAT_ENDPOINT_URL here. */
  url: string;
  /** Local port the server is bound to. */
  port: number;
  /** Shut the server down cleanly. */
  close: () => Promise<void>;
}

/**
 * Boot the keyword-driven test chat endpoint. Handles `POST /chat` AND `POST /`
 * (both route through {@link buildTestChatResponse}) so the URL works whether or
 * not the agent appends `/chat`. Each request is logged with the fields that
 * matter for watching the loop: channel, conversationKey, buffered message
 * count, the aggregated text, and the channel's capabilities.
 */
export function startTestChatEndpoint(
  opts: TestChatEndpointOptions
): Promise<TestChatEndpointHandle> {
  const logger = opts.logger ?? pino({ level: 'silent' });
  const app = express();
  app.use(express.json({ limit: '5mb' }));

  const handler = (req: Request, res: Response): void => {
    const body = req.body as ChatRequest;
    logger.info(
      {
        channel: body.channel,
        conversationKey: body.conversationKey,
        messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
        message: body.message,
        capabilities: body.capabilities
      },
      'test chat endpoint received turn'
    );
    res.status(200).json(buildTestChatResponse(body));
  };

  app.post('/chat', handler);
  app.post('/', handler);

  return new Promise<TestChatEndpointHandle>((resolve, reject) => {
    const server: Server = app.listen(opts.port, () => {
      const addr = server.address();
      const boundPort =
        typeof addr === 'object' && addr !== null && typeof addr.port === 'number'
          ? addr.port
          : opts.port;
      resolve({
        url: `http://localhost:${boundPort}/chat`,
        port: boundPort,
        close: () =>
          new Promise<void>(resolveClose => {
            server.close(() => resolveClose());
          })
      });
    });
    server.on('error', reject);
  });
}

/* ────────────────────────────────────────────────────────────────────────── */
/* CLI entry point                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

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
  port: number;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let port = 4000;
  let help = false;
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') help = true;
    else if (arg.startsWith('--port=')) port = Number.parseInt(arg.slice('--port='.length), 10);
    else if (arg === '--port') {
      const idx = argv.indexOf(arg);
      const next = argv[idx + 1];
      if (next) port = Number.parseInt(next, 10);
    }
  }
  if (!Number.isFinite(port) || port < 1 || port > 65535) port = 4000;
  return { port, help };
}

function printHelp(): void {
  process.stdout.write(
    [
      'Usage: npm run dev:chat -- [options]',
      '',
      'A keyword-driven test chat endpoint implementing the chat contract.',
      'Point CHAT_ENDPOINT_URL at the printed URL (the dev:loop runner does this',
      'automatically).',
      '',
      'Options:',
      '  --port=<n>   Port to listen on (default 4000).',
      '  --help, -h   Show this help.',
      '',
      'Keywords (scanned in the aggregated message text):',
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

  const chat = await startTestChatEndpoint({ port: args.port, logger });

  divider('test chat endpoint');
  success(`Listening at ${chat.url}`);
  info('Keyword cheatsheet:');
  for (const line of KEYWORD_CHEATSHEET) info(line);
  divider();
  info('Press Ctrl-C to stop.');

  // Keep the process alive until a signal arrives; registerShutdown sets the
  // exit code and lets the event loop drain after close().
  registerShutdown(async () => {
    await chat.close();
  });
}

/**
 * Detect direct execution vs. library import (so importing
 * {@link buildTestChatResponse} for tests does NOT start a server). Resolve both
 * argv[1] and import.meta.url to absolute paths — same convention as scripts/.
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
    process.stderr.write(`test-chat-endpoint failed: ${msg}\n`);
    process.exitCode = 1;
  });
}
