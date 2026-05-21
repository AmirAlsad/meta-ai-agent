/**
 * Live-device example runner — boots the REAL agent stack against one of the
 * in-repo example chat endpoints, exposed via ngrok, with webhook registration,
 * so you can message the bot from a REAL device (WhatsApp / Page / Instagram)
 * and watch the example respond.
 *
 * WHY this needs real credentials (unlike `npm run example:chat`, the local
 * REPL): this path constructs the REAL adapters via `buildRuntime` and actually
 * sends through Meta's Graph API. There is no fake/console adapter here — every
 * outbound is a live Send API call — so it requires real Meta App creds plus a
 * reserved NGROK_DOMAIN, all loaded from `.env` via `loadConfig()`.
 *
 * WHY it overrides `config.chatEndpointUrl`: the agent POSTs every buffered
 * inbound turn to `config.chatEndpointUrl`. For this runner we want those POSTs
 * to hit the IN-REPO example endpoint we boot in-process (echo / router), NOT
 * whatever production endpoint `.env` points at. `loadConfig()` *requires*
 * CHAT_ENDPOINT_URL to be set (so the dev's normal .env stays valid), but we
 * override the loaded value before building the runtime — see step 3.
 *
 * WHY the showcase bot is NOT booted here: it's a separate npm package with its
 * own dependencies (the Vercel AI SDK — `ai`, `@ai-sdk/anthropic`, ...) that the
 * root package never installs, so this runner can't import it in-process. To
 * exercise it live, run it separately (`cd examples/showcase-bot && npm install
 * && npm start`) and point CHAT_ENDPOINT_URL at it, then start the agent with
 * `npm run dev` (which reads CHAT_ENDPOINT_URL). NOT `npm run dev:loop` — that
 * boots its own in-process keyword test endpoint and OVERRIDES CHAT_ENDPOINT_URL,
 * so it would never route to the standalone showcase bot.
 *
 * This is the live-device sibling of `scripts/dev/loop.ts` (which wires the
 * keyword test endpoint); the bootstrap order — boot endpoint → override
 * chatEndpointUrl → buildRuntime → listen → tunnel → register-webhooks — is the
 * same, and the friendly-error / shutdown conventions mirror the setup scripts.
 */
import 'dotenv/config';
import path from 'node:path';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import pino from 'pino';

import { loadConfig, type Config } from '../src/config/loader.js';
import { buildRuntime } from '../src/index.js';
import { startTunnel } from './lib/tunnel.js';
import { registerAllWebhooks } from './setup/register-webhooks.js';
import { createEchoChatEndpoint } from '../examples/minimal-chat-endpoint/index.js';
import { createRouterChatEndpoint } from '../examples/multi-channel-router/index.js';
import { createCatalogChatEndpoint } from '../examples/action-catalog/index.js';
import { createScriptedFlowChatEndpoint } from '../examples/scripted-flow/index.js';
import { info, success, warn, fail, divider, registerShutdown } from './lib/console.js';

/* ────────────────────────────────────────────────────────────────────────── */
/* Example registry                                                           */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * The in-repo CHAT-endpoint examples this runner can boot in-process. NOTE:
 * `identity-lookup` is deliberately ABSENT — it implements the `USER_LOOKUP_URL`
 * contract (returns a `Contact`), NOT the `CHAT_ENDPOINT_URL` contract, so it is
 * not a valid target for this chat runner. Run it alongside a chat endpoint
 * instead (see examples/identity-lookup/README.md).
 */
const EXAMPLES = [
  'minimal-chat-endpoint',
  'multi-channel-router',
  'action-catalog',
  'scripted-flow'
] as const;
type ExampleName = (typeof EXAMPLES)[number];

const DEFAULT_EXAMPLE: ExampleName = 'minimal-chat-endpoint';

/** Build the chosen example's Express app (listener-guarded → safe to import). */
function buildExampleApp(name: ExampleName): { app: express.Express; description: string } {
  switch (name) {
    case 'minimal-chat-endpoint':
      return { app: createEchoChatEndpoint(), description: 'echo bot — replies with the inbound text' };
    case 'multi-channel-router':
      return {
        app: createRouterChatEndpoint(),
        description: 'channel-aware + capability-driven routing (greetings, reactions, WhatsApp templates)'
      };
    case 'action-catalog':
      return {
        app: createCatalogChatEndpoint(),
        description: 'keyword-routed reference for every ChatAction shape (capability-gated)'
      };
    case 'scripted-flow':
      return {
        app: createScriptedFlowChatEndpoint(),
        description: 'deterministic in-memory state machine (coffee-order arc, no LLM)'
      };
  }
}

function isExampleName(value: string): value is ExampleName {
  return (EXAMPLES as readonly string[]).includes(value);
}

/* ────────────────────────────────────────────────────────────────────────── */
/* CLI parsing                                                                */
/* ────────────────────────────────────────────────────────────────────────── */

interface CliArgs {
  example: ExampleName;
  /** Local port for the agent's HTTP (webhook) server. Defaults to config.port. */
  port?: number;
  /** Override the reserved ngrok domain. Defaults to config.ngrokDomain. */
  ngrokDomain?: string;
  /**
   * Point the agent at an EXTERNAL chat endpoint (e.g. the showcase-bot running
   * as its own server) instead of booting an in-repo example in-process. When
   * set, the positional example name is ignored and no in-process example is
   * started — the agent's `chatEndpointUrl` is this URL.
   */
  chatEndpoint?: string;
  /** Skip the programmatic webhook subscription step. */
  skipWebhookRegistration: boolean;
  help: boolean;
}

/**
 * Hand-rolled arg parser (same posture as the setup scripts — no commander dep
 * for a handful of flags). Throws on an unknown flag / bad value so the caller
 * surfaces a clean remediation rather than half-parsing argv and proceeding
 * with corrupted defaults.
 */
function parseArgs(argv: readonly string[]): CliArgs {
  const out: CliArgs = {
    example: DEFAULT_EXAMPLE,
    skipWebhookRegistration: false,
    help: false
  };
  let examplePositionalSeen = false;

  for (const raw of argv) {
    // A bare `--` is the npm/shell argument separator (the `example:dev` npm
    // script ends with `--`, so it arrives here as a literal token). Skip it.
    if (raw === '--') {
      continue;
    }
    if (raw === '--help' || raw === '-h') {
      out.help = true;
      continue;
    }
    if (raw === '--no-webhook-registration') {
      out.skipWebhookRegistration = true;
      continue;
    }
    if (raw.startsWith('--port=')) {
      const value = raw.slice('--port='.length).trim();
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || String(parsed) !== value || parsed < 1 || parsed > 65535) {
        throw new Error(`--port: expected integer 1–65535 (got "${value}").`);
      }
      out.port = parsed;
      continue;
    }
    if (raw.startsWith('--ngrok-domain=')) {
      const value = raw.slice('--ngrok-domain='.length).trim();
      if (value === '') {
        throw new Error('--ngrok-domain requires a value, e.g. --ngrok-domain=foo.ngrok-free.app');
      }
      out.ngrokDomain = value;
      continue;
    }
    if (raw.startsWith('--chat-endpoint=')) {
      const value = raw.slice('--chat-endpoint='.length).trim();
      if (value === '') {
        throw new Error('--chat-endpoint requires a value, e.g. --chat-endpoint=http://127.0.0.1:4055');
      }
      try {
        // eslint-disable-next-line no-new
        new URL(value);
      } catch {
        throw new Error(`--chat-endpoint: expected a parseable URL (got "${value}").`);
      }
      out.chatEndpoint = value;
      continue;
    }
    // A bare positional (not starting with `-`) is the example name.
    if (!raw.startsWith('-')) {
      if (examplePositionalSeen) {
        throw new Error(`Unexpected extra argument: "${raw}". Only one example name may be given.`);
      }
      if (!isExampleName(raw)) {
        throw new Error(
          `Unknown example "${raw}". Valid examples: ${EXAMPLES.join(', ')}.`
        );
      }
      out.example = raw;
      examplePositionalSeen = true;
      continue;
    }
    throw new Error(`Unknown flag: ${raw}. Run with --help for usage.`);
  }
  return out;
}

function printHelp(): void {
  process.stdout.write(
    [
      'Usage: npm run example:dev -- [example] [options]',
      '',
      'Boots the REAL agent stack (real Meta adapters → live Graph API sends)',
      'pointed at an IN-REPO example chat endpoint, exposed via ngrok, with',
      'webhook registration — so you can message it from a real device and watch',
      'the example respond.',
      '',
      'Requires a complete .env: real Meta App credentials (META_APP_ID,',
      'META_APP_SECRET, META_VERIFY_TOKEN), at least one channel, NGROK_DOMAIN,',
      'NGROK_AUTHTOKEN, and CHAT_ENDPOINT_URL (any valid URL — it is OVERRIDDEN',
      'to the in-process example for this run). Use `npm run example:chat` for a',
      'no-Meta-account local REPL instead.',
      '',
      'Examples (booted in-process):',
      '  minimal-chat-endpoint   echo bot (default).',
      '  multi-channel-router    channel-aware + capability-driven routing.',
      '  action-catalog          reference for every ChatAction shape.',
      '  scripted-flow           deterministic state machine (coffee-order arc).',
      '',
      'Options:',
      '  --port=<n>                   Local port for the agent webhook server.',
      '                               Default: PORT env / config.port.',
      '  --ngrok-domain=<domain>      Reserved ngrok domain (bare hostname).',
      '                               Default: NGROK_DOMAIN from .env.',
      '  --chat-endpoint=<url>        Point the agent at an EXTERNAL chat endpoint',
      '                               (e.g. the showcase-bot running standalone)',
      '                               instead of booting an in-repo example. When',
      '                               set, the [example] positional is ignored.',
      '  --no-webhook-registration    Skip programmatic webhook subscription',
      '                               (assume the Dashboard config is already done).',
      '  --help, -h                   Show this help.',
      '',
      'LLM showcase bot: it is a SEPARATE package, so run it standalone first',
      '(cd examples/showcase-bot && npm install && npm start), then point this',
      'runner at it: `npm run example:dev -- --chat-endpoint=http://127.0.0.1:4055`.',
      'That gives you the real Meta stack + ngrok + webhook registration aimed at',
      'the showcase-bot, all in one command.',
      ''
    ].join('\n')
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Helpers                                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Start an HTTP server on the given port and resolve once it is listening.
 * `port: 0` binds an ephemeral port — used for the in-process example endpoint
 * so it never collides with the agent's port or anything else on the box.
 */
function listen(app: express.Express, port: number): Promise<Server> {
  return new Promise<Server>((resolve, reject) => {
    const server = http.createServer(app);
    server.once('error', reject);
    server.listen(port, () => resolve(server));
  });
}

/** Read the actual bound port off a listening server (handles ephemeral `0`). */
function boundPort(server: Server, fallback: number): number {
  const addr = server.address() as AddressInfo | string | null;
  return addr !== null && typeof addr === 'object' ? addr.port : fallback;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Main                                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(msg);
    info('Run with --help for usage.');
    process.exitCode = 1;
    return;
  }
  if (args.help) {
    printHelp();
    return;
  }

  const logger = pino({
    level: process.env.LOG_LEVEL ?? 'info',
    transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' } }
  });

  divider('meta-ai-agent: live-device example runner');

  // 1. Load config with a friendly error path. `loadConfig` is strict — it
  // throws on missing required vars (META_APP_SECRET, META_VERIFY_TOKEN,
  // CHAT_ENDPOINT_URL, NGROK_DOMAIN, ...) and on half-configured channels. We
  // re-emit the message through `fail` so the developer sees a clean line, not
  // a stack trace.
  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(`Configuration error: ${msg}`);
    info(
      'This runner boots the REAL stack (live Graph API sends), so it needs a complete .env: ' +
        'META_APP_ID, META_APP_SECRET, META_VERIFY_TOKEN, credentials for at least one channel, ' +
        'NGROK_DOMAIN, NGROK_AUTHTOKEN, and CHAT_ENDPOINT_URL (any valid URL — it is overridden ' +
        'to the in-process example).'
    );
    info('No Meta account? Use the local REPL instead: npm run example:chat -- ' + DEFAULT_EXAMPLE);
    process.exitCode = 1;
    return;
  }

  // Track handles so the shutdown hook (and the catch below) can tear down only
  // what actually started. Assigned as each resource comes up.
  let exampleServer: Server | undefined;
  let agentServer: Server | undefined;
  let tunnelClose: (() => Promise<void>) | undefined;
  let agentClose: (() => Promise<void>) | undefined;

  // Single teardown path, shared by the SIGINT/SIGTERM hook and the failure
  // catch. Each step is best-effort and independently guarded so one failure
  // can't block the rest — we'd rather exit promptly than wedge on a hung
  // close(). Order mirrors construction in reverse: tunnel → agent → servers.
  const teardown = async (): Promise<void> => {
    if (tunnelClose) await tunnelClose().catch((err) => logger.error({ err }, 'tunnel close failed'));
    if (agentClose) await agentClose().catch((err) => logger.error({ err }, 'agent close failed'));
    if (agentServer) await new Promise<void>((resolve) => agentServer!.close(() => resolve()));
    if (exampleServer) await new Promise<void>((resolve) => exampleServer!.close(() => resolve()));
  };

  try {
    // 2 + 3. Resolve the agent's chat endpoint and (only for the in-repo
    // examples) boot it in-process. Two modes:
    //   - EXTERNAL (--chat-endpoint=<url>): the chat endpoint is a separate
    //     server the developer runs themselves (e.g. the showcase-bot, which is
    //     its own package with its own deps). We do NOT boot anything in-process;
    //     the agent simply POSTs to that URL.
    //   - IN-PROCESS (default): boot the chosen in-repo example on an ephemeral
    //     port (the factory is listener-guarded, so importing it is side-effect-
    //     free; we create + listen ourselves).
    // Either way the override MUST happen BEFORE `buildRuntime` (next step),
    // which reads `config.chatEndpointUrl` when it builds the HttpChatClient. We
    // mutate the loaded config object (not process.env) so the change is explicit
    // and local to this run; the .env value only had to exist to satisfy
    // `loadConfig`'s required-var check.
    let wiredLabel: string;
    if (args.chatEndpoint) {
      config.chatEndpointUrl = args.chatEndpoint;
      wiredLabel = `external chat endpoint → ${args.chatEndpoint}`;
      success(`Pointing the agent at the EXTERNAL chat endpoint: ${args.chatEndpoint}`);
      info('  (no in-process example booted — run that chat endpoint server yourself, e.g. the showcase-bot)');
    } else {
      const { app: exampleApp, description } = buildExampleApp(args.example);
      exampleServer = await listen(exampleApp, 0);
      const examplePort = boundPort(exampleServer, 0);
      // The example endpoints expose `POST /`, and HttpChatClient POSTs to the
      // URL as-given (no path appended). So the agent's chat endpoint is the
      // example's root URL.
      const exampleUrl = `http://127.0.0.1:${examplePort}/`;
      config.chatEndpointUrl = exampleUrl;
      wiredLabel = `${args.example} (${description})`;
      success(`Example endpoint "${args.example}" listening at ${exampleUrl}`);
      info(`  ${description}`);
    }

    // 4. Build the REAL runtime (shared Graph transport → per-channel adapters →
    // store/scheduler → chat client pointed at `exampleUrl` → agent → app). This
    // is the exact same construction as `src/index.ts`'s `main()`.
    const { app: agentApp, agent } = buildRuntime(config, logger);
    agentClose = () => agent.close();

    // 5. Start the agent's HTTP server (the webhook receiver). `--port` wins,
    // else config.port (PORT env / 3000).
    const agentPort = args.port ?? config.port;
    agentServer = await listen(agentApp, agentPort);
    const listeningPort = boundPort(agentServer, agentPort);
    success(`Agent listening on port ${listeningPort}`);

    // 6. Open the ngrok tunnel to the agent's port → public HTTPS URL. `--ngrok-
    // domain` wins, else the validated `config.ngrokDomain`. The authtoken comes
    // from NGROK_AUTHTOKEN (startTunnel throws a remediation-rich error if it's
    // missing — caught below).
    const tunnel = await startTunnel({
      port: listeningPort,
      domain: args.ngrokDomain ?? config.ngrokDomain,
      authtoken: process.env.NGROK_AUTHTOKEN
    });
    tunnelClose = () => tunnel.close();
    success(`Tunnel: ${tunnel.url}`);

    const callbackUrl = `${tunnel.url}/webhook`;

    // 7. Register webhooks against the tunnel's /webhook callback (unless
    // skipped). Per-channel results are printed; WhatsApp/IG `manual_required`
    // (Meta needs a Dashboard step) is non-fatal — the rest of the loop still
    // works once that step is done, and we surface the remediation hints.
    if (args.skipWebhookRegistration) {
      info('Skipping webhook registration (--no-webhook-registration).');
      info(`If you register manually, use callback URL: ${callbackUrl}`);
    } else {
      divider('webhook registration');
      try {
        const summary = await registerAllWebhooks({ config, callbackUrl, logger });
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
      } catch (err) {
        // Non-fatal: a throw here is usually a wrong appId/appSecret. Print it
        // and keep the runner up so the developer can fix creds and re-register
        // (or configure the Dashboard manually) without restarting everything.
        const msg = err instanceof Error ? err.message : String(err);
        fail(`Webhook registration threw: ${msg}`);
        warn('Continuing without programmatic subscription. Configure the Dashboard manually if needed.');
        warn(`Callback URL: ${callbackUrl}`);
      }
    }

    // 8. Ready banner.
    const channels = Object.entries(config.channels)
      .filter(([, on]) => on)
      .map(([name]) => name)
      .join(', ');
    divider('ready');
    success('Live-device example runner is up.');
    info(`Chat endpoint wired:  ${wiredLabel}`);
    info(`Public webhook URL:   ${callbackUrl}`);
    info(`Configured channels:  ${channels || '(none)'}`);
    divider();
    info('Send a message from a real device to your WhatsApp / Page / Instagram');
    info('and watch the example respond here. (Real Graph API sends — this is live.)');
    info('Press Ctrl-C to stop.');

    // 9. Clean shutdown: registerShutdown runs the teardown on SIGINT/SIGTERM,
    // sets the exit code, and lets the event loop drain — no hard process.exit
    // mid-async. Teardown closes the tunnel, the agent (drains scheduler +
    // delivery timers), then both HTTP servers.
    registerShutdown(async () => {
      warn('Received shutdown signal — tearing down tunnel, agent, and servers.');
      await teardown();
    });
  } catch (err) {
    // Any failure during bootstrap (tunnel auth, port in use, ...): print a
    // clean line, tear down whatever already started, set a non-zero exit code,
    // and return. Never crash with a raw stack trace.
    const msg = err instanceof Error ? err.message : String(err);
    fail(`Failed to start the live-device runner: ${msg}`);
    info('Hint: ensure NGROK_AUTHTOKEN is set and the chosen port is free.');
    await teardown().catch(() => undefined);
    process.exitCode = 1;
  }
}

/**
 * Run `main()` ONLY when this file is the process entry point — same convention
 * as the other scripts/ entry points (resolve both argv[1] and import.meta.url
 * to absolute paths before comparing). Errors never crash the process: we set
 * `process.exitCode` and let the loop drain.
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
