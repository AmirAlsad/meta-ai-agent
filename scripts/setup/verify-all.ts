/**
 * Run every configured channel's verify suite end-to-end in one shot.
 *
 * The three per-channel scripts (`verify-whatsapp.ts`, `verify-messenger.ts`,
 * `verify-instagram.ts`) each export a `run*Verify(ctx)` function that
 * consumes the shared {@link VerifyContext} and returns a
 * {@link ChannelVerifyResult}. This script:
 *
 *   1. Bootstraps ONE context (one tunnel, one capture server, one
 *      `registerAllWebhooks` call) — much less setup noise than running the
 *      three scripts back-to-back, and the test corpus accumulates under
 *      a single `.captures/meta/` tree.
 *   2. Iterates the requested channels (defaults to every channel with
 *      credentials configured; `--channels=...` filters).
 *   3. On per-channel failure, continues to the next channel — partial
 *      success is the desired outcome when one channel is misconfigured.
 *   4. Prints a combined summary and exits 0 iff every requested channel
 *      passed.
 */

import 'dotenv/config';
import path from 'node:path';
import pino from 'pino';

import {
  bootstrapVerifyContext,
  parseVerifyArgs,
  printVerifyHelp,
  printVerifySummary,
  VerifyBootstrapError,
  type ChannelVerifyResult,
  type ParsedArgs,
  type VerifyChannel,
  type VerifyContext
} from './verify-shared.js';
import { runWhatsAppVerify } from './verify-whatsapp.js';
import { runMessengerVerify } from './verify-messenger.js';
import { runInstagramVerify } from './verify-instagram.js';
import { info, success, warn, fail, divider, closePrompts } from '../lib/console.js';

const SCRIPT_NAME = 'verify-all';

/* ────────────────────────────────────────────────────────────────────────── */
/* Channel routing                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

type ChannelRunner = (ctx: VerifyContext) => Promise<ChannelVerifyResult>;

const CHANNEL_RUNNERS: Record<VerifyChannel, ChannelRunner> = {
  whatsapp: runWhatsAppVerify,
  messenger: runMessengerVerify,
  instagram: runInstagramVerify
};

/**
 * Resolve the list of channels to run. If the CLI didn't pin a list, pick
 * every channel that has credentials configured (so a developer with only
 * WhatsApp set up doesn't see two failed-config rows in the summary).
 */
function resolveChannels(ctx: VerifyContext): VerifyChannel[] {
  if (ctx.cli.channels.length > 0) return ctx.cli.channels;
  const out: VerifyChannel[] = [];
  if (ctx.config.channels.whatsapp) out.push('whatsapp');
  if (ctx.config.channels.messenger) out.push('messenger');
  if (ctx.config.channels.instagram) out.push('instagram');
  return out;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* CLI entry point                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  let cli: ParsedArgs;
  try {
    cli = parseVerifyArgs(process.argv.slice(2));
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    process.exitCode = 2;
    return;
  }

  if (cli.help) {
    printVerifyHelp(SCRIPT_NAME);
    return;
  }

  divider('meta-ai-agent: verify all configured channels');

  const logger = pino({
    level: process.env['LOG_LEVEL'] ?? 'info',
    transport: process.stdout.isTTY
      ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' } }
      : undefined
  });

  let ctx: VerifyContext;
  try {
    ctx = await bootstrapVerifyContext({ channel: 'all', cli, logger });
  } catch (err) {
    if (err instanceof VerifyBootstrapError) {
      process.exitCode = 1;
      return;
    }
    fail(`Unexpected bootstrap error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  const channels = resolveChannels(ctx);
  if (channels.length === 0) {
    warn('No channels selected — nothing to verify.');
    info('Pass --channels=<whatsapp,messenger,instagram> or configure at least one channel in .env.');
    await ctx.capture.close().catch(() => undefined);
    closePrompts();
    process.exitCode = 1;
    return;
  }

  info(`Verifying channels: ${channels.join(', ')}`);

  const results: ChannelVerifyResult[] = [];
  try {
    for (const channel of channels) {
      const runner = CHANNEL_RUNNERS[channel];
      try {
        const result = await runner(ctx);
        results.push(result);
      } catch (err) {
        // Defensive guard — the per-channel runners are designed not to throw,
        // but a runtime regression should still let us continue to the next
        // channel rather than abort the whole verify-all session.
        const msg = err instanceof Error ? err.message : String(err);
        fail(`${channel}: unexpected runner error: ${msg}`);
        results.push({
          channel,
          ok: false,
          steps: [{ name: 'runner', status: 'fail', detail: msg }]
        });
      }
    }
  } finally {
    await ctx.capture.close().catch(() => undefined);
    closePrompts();
  }

  printVerifySummary(results);
  const allOk = results.every((r) => r.ok);
  if (allOk) {
    success('All verified channels passed.');
  } else {
    fail('One or more channels failed verification.');
  }
  process.exitCode = allOk ? 0 : 1;
}

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
  main().catch((err) => {
    fail(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = process.exitCode ?? 1;
  });
}
