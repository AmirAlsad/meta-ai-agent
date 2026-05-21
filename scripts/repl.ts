/**
 * Local end-to-end REPL — dev tooling, NOT part of the published package.
 *
 * Runs the FULL inbound → chat → outbound loop on your laptop with NO Meta
 * account and NO ngrok tunnel. It boots, in ONE process:
 *
 *   1. an example chat endpoint (the developer's side of CHAT_ENDPOINT_URL),
 *      imported in-process and mounted on an ephemeral port;
 *   2. the REAL {@link ConversationAgent} (in-memory store + scheduler + the
 *      real HttpChatClient pointed at #1) behind the REAL {@link createApp}
 *      webhook receiver, also on an ephemeral port;
 *   3. FAKE "console" channel adapters that PRINT each outbound instead of
 *      calling Meta's Graph API.
 *
 * You type a line; the REPL builds the matching webhook for the current channel,
 * SIGNS it exactly like Meta (`sha256=` + HMAC-SHA256 over the raw JSON bytes
 * with `config.meta.appSecret`), and POSTs it to the agent's `/webhook`. The
 * agent buffers, calls the chat endpoint, and the console adapters print the
 * reply. This exercises every real component except the network edge to Meta.
 *
 * WHY console adapters (the core trick): a {@link ChannelAdapter} is the only
 * seam between the agent and Meta. By substituting an adapter that formats +
 * prints instead of POSTing to the Graph API, the entire Stage 5 state machine
 * runs unmodified with zero credentials. `supports()` returns true for every
 * feature the channel really has, so nothing the chat endpoint emits gets
 * downgraded away.
 */

import http, { type Server } from 'node:http';
import { createHmac } from 'node:crypto';
import readline from 'node:readline';
import pino from 'pino';

import type { Config } from '../src/config/loader.js';
import { defaultConversationConfig } from '../src/config/loader.js';
import { createApp } from '../src/http/app.js';
import { ConversationAgent } from '../src/conversation/agent.js';
import { InMemoryConversationStore } from '../src/conversation/store.js';
import { InMemoryBufferScheduler } from '../src/conversation/scheduler.js';
import { HttpChatClient } from '../src/chat/client.js';
import type {
  ChannelAdapter,
  ChannelFeature,
  MediaSendInput,
  SendOptions,
  SendResult
} from '../src/meta/shared/adapter.js';
import type { Channel } from '../src/meta/types.js';
import { createEchoChatEndpoint } from '../examples/minimal-chat-endpoint/index.js';
import { createRouterChatEndpoint } from '../examples/multi-channel-router/index.js';
import {
  buildInstagramImageWebhook,
  buildInstagramReactionWebhook,
  buildInstagramReadWebhook,
  buildInstagramTextWebhook,
  buildMessengerImageWebhook,
  buildMessengerReactionWebhook,
  buildMessengerReadWebhook,
  buildMessengerTextWebhook,
  buildWhatsAppImageWebhook,
  buildWhatsAppReactionWebhook,
  buildWhatsAppStatusWebhook,
  buildWhatsAppTextWebhook
} from './lib/webhook-builders.js';

/* ────────────────────────────────────────────────────────────────────────── */
/* Fixed fake identities (one per channel)                                    */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Stable fake business + user ids per channel. Stable so the conversation key
 * (`{channel}:{business}:{user}`) is constant across a session — that's what
 * lets a `/status` or `/reaction` reference the right in-flight conversation.
 */
const IDS: Record<Channel, { business: string; user: string }> = {
  whatsapp: { business: '100000000000001', user: '15557654321' },
  messenger: { business: '500000000000005', user: '6000000000000061' },
  instagram: { business: '17841400000000007', user: '1780000000000008' }
};

/** The example endpoints the REPL can boot, by name. */
const EXAMPLES = ['minimal-chat-endpoint', 'multi-channel-router'] as const;
type ExampleName = (typeof EXAMPLES)[number];

/* ────────────────────────────────────────────────────────────────────────── */
/* Console adapter — prints outbound instead of calling Meta                  */
/* ────────────────────────────────────────────────────────────────────────── */

/** Tracks the most recent outbound message id the agent sent on each channel. */
type LastOutbound = Partial<Record<Channel, string>>;

/**
 * Build a fake {@link ChannelAdapter} for `channel` that PRINTS a formatted line
 * for every outbound the agent dispatches and returns a synthetic
 * {@link SendResult}. This is the substitute for the real Graph API client — no
 * network, no credentials.
 *
 * `lastOutbound` is shared mutable state: each successful send records its
 * generated id so the REPL's `/status` and `/reaction` commands can target the
 * message the user just received.
 *
 * `supports()` returns true for every feature this channel genuinely has so the
 * agent never downgrades a chat action away (typing/read/reaction/reply/media on
 * all three; template only on WhatsApp), matching the real adapters' surface.
 */
function createConsoleAdapter(channel: Channel, lastOutbound: LastOutbound): ChannelAdapter {
  let counter = 0;
  // Synthesize a channel-shaped outbound id, recorded as the channel's "last"
  // so /status and /reaction can reference it.
  const nextId = (): string => {
    counter += 1;
    const id =
      channel === 'whatsapp'
        ? `wamid.OUT-${channel}-${counter}`
        : channel === 'messenger'
          ? `m_OUT-${channel}-${counter}`
          : `ig-OUT-${channel}-${counter}`;
    lastOutbound[channel] = id;
    return id;
  };

  const result = (recipientId: string): SendResult => ({
    channel,
    messageId: nextId(),
    recipientId,
    timestamp: Date.now()
  });

  const line = (msg: string): void => {
    process.stdout.write(`  → [${channel}] ${msg}\n`);
  };

  return {
    channel,
    async sendText(recipientId: string, text: string, opts?: SendOptions): Promise<SendResult> {
      const replyNote = opts?.replyTo ? ` (reply to ${opts.replyTo})` : '';
      line(`text: ${JSON.stringify(text)}${replyNote}`);
      return result(recipientId);
    },
    async sendTypingIndicator(_recipientId: string, _messageId?: string): Promise<void> {
      line('typing…');
    },
    async markRead(_recipientId: string, messageId: string): Promise<void> {
      line(`read receipt on ${messageId}`);
    },
    async sendReaction(_recipientId: string, messageId: string, emoji: string): Promise<void> {
      line(`reaction ${emoji || '(removed)'} on ${messageId}`);
    },
    async sendMedia(recipientId: string, input: MediaSendInput): Promise<SendResult> {
      const caption = input.caption ? ` caption=${JSON.stringify(input.caption)}` : '';
      line(`media(${input.kind}): ${input.mediaIdOrUrl}${caption}`);
      return result(recipientId);
    },
    supports(feature: ChannelFeature): boolean {
      // Mirror the real adapters' capability surface so nothing is downgraded.
      switch (feature) {
        case 'typing_indicator':
        case 'read_receipt':
        case 'reaction':
        case 'reply_to':
        case 'media_send':
          return true;
        case 'template':
          // Templates are WhatsApp-only.
          return channel === 'whatsapp';
        default:
          // persistent_menu / get_started / ice_breakers / story_reply are not
          // exercised by the REPL loop — report unsupported.
          return false;
      }
    }
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Config (built INLINE — the REPL controls everything, never loadConfig)     */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Assemble a {@link Config} entirely in code. We deliberately do NOT call
 * `loadConfig` — that reads `process.env` and enforces real credentials / a
 * reserved ngrok domain, none of which exist (or matter) for a local,
 * Meta-less run. Every field here is a safe fake EXCEPT `chatEndpointUrl` (the
 * in-process example) and `appSecret` (which must match the signature the REPL
 * computes — the verifier in createApp checks exactly this).
 */
function buildReplConfig(chatEndpointUrl: string): Config {
  return {
    meta: {
      appId: undefined,
      appSecret: 'repl-app-secret',
      // verifyToken is unused on the POST path but loadConfig would require >=16
      // chars; keep it valid in case anything inspects it.
      verifyToken: 'repl-verify-token-1234567890',
      graphApiVersion: 'v25.0'
    },
    // Fake per-channel credentials so all three channels read as "configured".
    // The console adapters never touch these — they exist only so the agent
    // wires an adapter per channel.
    whatsapp: { phoneNumberId: IDS.whatsapp.business, accessToken: 'x' },
    messenger: { pageId: IDS.messenger.business, pageAccessToken: 'x' },
    instagram: { userId: IDS.instagram.business, accessToken: 'x' },
    channels: { whatsapp: true, messenger: true, instagram: true },
    conversation: {
      ...defaultConversationConfig(),
      // WHY low buffer timeouts: the production defaults (2s base / 8s max) make
      // the REPL feel frozen — you'd wait seconds after every line for the flush
      // to fire. 150ms/400ms keeps the inbound→outbound round-trip snappy while
      // still aggregating a fast multi-line burst into one chat call.
      bufferBaseTimeoutMs: 150,
      bufferMaxTimeoutMs: 400,
      // WHY a tiny typing delay: the agent sleeps `typingDelayMs()` between a
      // typing indicator and the text that follows it — derived from
      // typingRefreshIntervalMs and capped at 1.5s. The production 5s value would
      // push the actual text send ~1.5s past the REPL's post-POST wait, so the
      // outbound would print after the next prompt. 50ms keeps typing visible but
      // lands the text well inside the flush window.
      typingRefreshIntervalMs: 50
    },
    chatEndpointUrl,
    ngrokDomain: 'repl.local',
    agentAutostart: false,
    port: 0,
    nodeEnv: 'development'
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Signing — must satisfy verifyMetaSignature                                 */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Sign the EXACT JSON bytes the REPL is about to POST and return both the body
 * and its `x-hub-signature-256` header value. The verifier recomputes the HMAC
 * over the raw request body, so we must hash the SAME bytes we send — hence we
 * serialize once here and reuse `body` for both the hash and the POST.
 */
function signWebhook(payload: unknown, appSecret: string): { body: string; signature: string } {
  const body = JSON.stringify(payload);
  const digest = createHmac('sha256', appSecret).update(body).digest('hex');
  return { body, signature: `sha256=${digest}` };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* HTTP helpers (built-in http, no fetch dep on the agent port)               */
/* ────────────────────────────────────────────────────────────────────────── */

/** Start an Express app on an ephemeral port; resolve with the server + port. */
function listen(app: http.RequestListener): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('failed to bind ephemeral port'));
        return;
      }
      resolve({ server, port: addr.port });
    });
  });
}

interface PostResult {
  status: number;
  body: string;
}

/** POST a signed webhook body to the agent's /webhook on `port`. */
function postWebhook(port: number, body: string, signature: string): Promise<PostResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/webhook',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'x-hub-signature-256': signature
        }
      },
      res => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {
          data += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      }
    );
    req.once('error', reject);
    req.write(body);
    req.end();
  });
}

/* ────────────────────────────────────────────────────────────────────────── */
/* CLI parsing + help                                                         */
/* ────────────────────────────────────────────────────────────────────────── */

interface CliArgs {
  example: ExampleName;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let example: ExampleName = 'minimal-chat-endpoint';
  let help = false;
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') help = true;
    else if ((EXAMPLES as readonly string[]).includes(arg)) example = arg as ExampleName;
    else if (arg.startsWith('--example=')) {
      const v = arg.slice('--example='.length);
      if ((EXAMPLES as readonly string[]).includes(v)) example = v as ExampleName;
    }
  }
  return { example, help };
}

const USAGE = `
Local end-to-end REPL for meta-ai-agent (no Meta account, no ngrok).

Usage:
  npx tsx scripts/repl.ts [example] [--help]

Arguments:
  example            Which example chat endpoint to boot in-process.
                     One of: ${EXAMPLES.join(' | ')}
                     (default: minimal-chat-endpoint)

What it does:
  Boots the chosen example chat endpoint + the real ConversationAgent (with fake
  "console" channel adapters that PRINT outbound instead of calling Meta), then
  drops you into a prompt. Type a line to simulate an inbound message on the
  current channel; the agent buffers it, calls the chat endpoint, and the
  outbound reply is printed.

REPL commands:
  /channel <whatsapp|messenger|instagram>   Switch the simulated channel.
  /media <url>                              Send an image inbound on this channel.
  /reaction <emoji>                         React to the last outbound message id.
  /status <delivered|read>                  Send a status for the last outbound id
                                            (WhatsApp drives queue advancement;
                                            messenger/ig 'read' is a read receipt).
  /raw                                      Toggle printing raw webhook + response.
  /reset                                    Clear all conversation state.
  /help                                     Show this command list.
  /exit                                     Shut down and quit (Ctrl-C also works).
`;

/* ────────────────────────────────────────────────────────────────────────── */
/* REPL runtime                                                               */
/* ────────────────────────────────────────────────────────────────────────── */

interface Runtime {
  config: Config;
  agent: ConversationAgent;
  store: InMemoryConversationStore;
  scheduler: InMemoryBufferScheduler;
  agentPort: number;
  agentServer: Server;
  chatServer: Server;
  chatUrl: string;
  lastOutbound: LastOutbound;
  /** Rebuild the agent's backing store/scheduler/agent for /reset. */
  rebuild(): void;
}

/**
 * Boot the chat endpoint + agent + console adapters and return the live
 * runtime. The agent and its HTTP receiver are wired here exactly as production
 * wires them, except the adapters are the console fakes and the store/scheduler
 * are the in-memory implementations.
 */
async function bootRuntime(example: ExampleName, logger: pino.Logger): Promise<Runtime> {
  // 1. Boot the chosen example chat endpoint in-process on an ephemeral port.
  const chatApp =
    example === 'multi-channel-router' ? createRouterChatEndpoint() : createEchoChatEndpoint();
  const chat = await listen(chatApp);
  const chatUrl = `http://127.0.0.1:${chat.port}/`;

  // 2. Build the inline config pointed at that endpoint.
  const config = buildReplConfig(chatUrl);

  // 3. Shared mutable "last outbound id per channel" the console adapters fill.
  const lastOutbound: LastOutbound = {};

  // 4. Build the agent's deps. The chat client is the REAL HttpChatClient — the
  // only thing faked is the per-channel adapters.
  const chatClient = new HttpChatClient({ chatEndpointUrl: chatUrl, timeoutMs: 30_000, logger });

  let store = new InMemoryConversationStore({ dedupeTtlSeconds: 86_400 });
  let scheduler = new InMemoryBufferScheduler();
  let agent = new ConversationAgent({
    store,
    scheduler,
    chatClient,
    adapters: {
      whatsapp: createConsoleAdapter('whatsapp', lastOutbound),
      messenger: createConsoleAdapter('messenger', lastOutbound),
      instagram: createConsoleAdapter('instagram', lastOutbound)
    },
    config,
    logger
  });

  // 5. Mount the REAL webhook receiver around the agent on an ephemeral port.
  const agentApp = createApp({ config, logger, agent });
  const agentHttp = await listen(agentApp);

  const runtime: Runtime = {
    config,
    agent,
    store,
    scheduler,
    agentPort: agentHttp.port,
    agentServer: agentHttp.server,
    chatServer: chat.server,
    chatUrl,
    lastOutbound,
    rebuild(): void {
      // /reset: drop the conversation state by swapping in fresh store +
      // scheduler + agent. The HTTP receiver closes over the OLD agent, so we
      // can't hot-swap behind createApp; instead /reset rebuilds and the caller
      // re-points everything. (See resetState which restarts the receiver.)
      store = new InMemoryConversationStore({ dedupeTtlSeconds: 86_400 });
      scheduler = new InMemoryBufferScheduler();
      agent = new ConversationAgent({
        store,
        scheduler,
        chatClient,
        adapters: {
          whatsapp: createConsoleAdapter('whatsapp', lastOutbound),
          messenger: createConsoleAdapter('messenger', lastOutbound),
          instagram: createConsoleAdapter('instagram', lastOutbound)
        },
        config,
        logger
      });
      runtime.store = store;
      runtime.scheduler = scheduler;
      runtime.agent = agent;
    }
  };
  return runtime;
}

/** Sleep helper for the post-POST flush wait. */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Print a divider + banner line on stdout (no logger noise). */
function print(msg = ''): void {
  process.stdout.write(`${msg}\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    print(USAGE);
    return;
  }

  // Quiet logger: the console adapters print the interesting outbound; we don't
  // want the agent's info/debug stream cluttering the REPL. 'warn' keeps genuine
  // problems visible.
  const logger = pino({ level: process.env.LOG_LEVEL ?? 'warn' });

  let runtime = await bootRuntime(args.example, logger);

  // REPL-local state.
  let channel: Channel = 'whatsapp';
  let rawMode = false;
  // The wait after a POST: must exceed bufferMaxTimeoutMs so the async flush +
  // outbound print completes before we re-prompt. The margin on top covers the
  // typing-indicator delay (typingRefreshIntervalMs), the local chat round-trip,
  // and the send(s) — generous enough that a small multi-message reply still
  // lands before the next prompt while staying snappy.
  const flushWaitMs = runtime.config.conversation.bufferMaxTimeoutMs + 400;

  print('');
  print('meta-ai-agent local REPL');
  print(`  example:  ${args.example}`);
  print(`  chat:     ${runtime.chatUrl}`);
  print(`  agent:    http://127.0.0.1:${runtime.agentPort}/webhook (signed POSTs)`);
  print(`  channel:  ${channel}`);
  print('');
  print('Type a message to simulate an inbound. /help for commands, /exit to quit.');
  print('');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const setPrompt = (): void => {
    rl.setPrompt(`[${channel}] > `);
    rl.prompt();
  };

  /** Sign + POST a webhook payload, optionally echoing raw request/response. */
  const send = async (payload: unknown, label: string): Promise<void> => {
    const { body, signature } = signWebhook(payload, runtime.config.meta.appSecret);
    if (rawMode) {
      print(`  ↳ raw request (${label}):`);
      print(`    ${body}`);
    }
    try {
      const res = await postWebhook(runtime.agentPort, body, signature);
      if (rawMode) {
        print(`  ↳ response: ${res.status} ${res.body}`);
      }
      if (res.status !== 200) {
        print(`  ! webhook POST returned ${res.status} (${res.body || 'no body'})`);
      }
    } catch (err) {
      print(`  ! failed to POST webhook: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    // WHY wait: the route ACKs 200 immediately, then the agent buffers and (after
    // bufferMaxTimeoutMs) flushes → calls the chat endpoint → the console adapter
    // prints. Re-prompting before that finishes would interleave the prompt with
    // the outbound print. Waiting just past the max buffer window keeps it ordered
    // and still snappy.
    await delay(flushWaitMs);
  };

  /** /reset: tear down the old agent + receiver, boot a fresh one. */
  const resetState = async (): Promise<void> => {
    await runtime.agent.close().catch(() => {});
    await new Promise<void>(resolve => runtime.agentServer.close(() => resolve()));
    // Keep the same chat endpoint server; just rebuild the agent + receiver.
    runtime.rebuild();
    const agentApp = createApp({ config: runtime.config, logger, agent: runtime.agent });
    const agentHttp = await listen(agentApp);
    runtime.agentServer = agentHttp.server;
    runtime.agentPort = agentHttp.port;
    // Wipe the shared lastOutbound contents IN PLACE. The rebuilt console
    // adapters (rebuild()) close over the same `lastOutbound` object captured at
    // boot, so we must clear that object's keys — NOT reassign
    // `runtime.lastOutbound` to a fresh object, which would orphan it from the
    // adapters and leave /reaction + /status reading an always-empty map after a
    // reset.
    for (const key of Object.keys(runtime.lastOutbound) as Channel[]) delete runtime.lastOutbound[key];
    print('  conversation state cleared (fresh store + agent).');
  };

  /** Resolve the last outbound id for the current channel, or a synthetic one. */
  const lastOutboundId = (): string => {
    const id = runtime.lastOutbound[channel];
    if (id) return id;
    // No outbound has been sent yet — synthesize a plausible target so the
    // reaction/status still flows through the parser without crashing.
    return channel === 'whatsapp'
      ? 'wamid.SYNTHETIC-NO-OUTBOUND-YET'
      : channel === 'messenger'
        ? 'm_SYNTHETIC-NO-OUTBOUND-YET'
        : 'ig-SYNTHETIC-NO-OUTBOUND-YET';
  };

  /** Dispatch one command line. Returns false when the REPL should exit. */
  const handleCommand = async (lineRaw: string): Promise<boolean> => {
    const line = lineRaw.trim();
    if (line === '') return true;

    if (!line.startsWith('/')) {
      // Plain text → a text inbound on the current channel.
      const { business, user } = IDS[channel];
      const payload =
        channel === 'whatsapp'
          ? buildWhatsAppTextWebhook({ phoneNumberId: business, waId: user, text: line })
          : channel === 'messenger'
            ? buildMessengerTextWebhook({ pageId: business, psid: user, text: line })
            : buildInstagramTextWebhook({ igUserId: business, igsid: user, text: line });
      await send(payload, `${channel} text`);
      return true;
    }

    const [cmd, ...rest] = line.split(/\s+/);
    const arg = rest.join(' ').trim();

    switch (cmd) {
      case '/help':
        print(USAGE);
        return true;

      case '/exit':
      case '/quit':
        return false;

      case '/raw':
        rawMode = !rawMode;
        print(`  raw mode ${rawMode ? 'ON' : 'OFF'}`);
        return true;

      case '/channel': {
        const next = arg.toLowerCase();
        if (next === 'whatsapp' || next === 'messenger' || next === 'instagram') {
          channel = next;
          print(`  channel → ${channel}`);
        } else {
          print('  usage: /channel <whatsapp|messenger|instagram>');
        }
        return true;
      }

      case '/media': {
        if (!arg) {
          print('  usage: /media <url>');
          return true;
        }
        const { business, user } = IDS[channel];
        const payload =
          channel === 'whatsapp'
            ? // WhatsApp media is referenced by an uploaded media id, not a URL —
              // pass the given string through as the media id so the loop still runs.
              buildWhatsAppImageWebhook({ phoneNumberId: business, waId: user, mediaId: arg })
            : channel === 'messenger'
              ? buildMessengerImageWebhook({ pageId: business, psid: user, url: arg })
              : buildInstagramImageWebhook({ igUserId: business, igsid: user, url: arg });
        await send(payload, `${channel} image`);
        return true;
      }

      case '/reaction': {
        if (!arg) {
          print('  usage: /reaction <emoji>');
          return true;
        }
        const { business, user } = IDS[channel];
        const target = lastOutboundId();
        const payload =
          channel === 'whatsapp'
            ? buildWhatsAppReactionWebhook({ phoneNumberId: business, waId: user, emoji: arg, targetMessageId: target })
            : channel === 'messenger'
              ? buildMessengerReactionWebhook({ pageId: business, psid: user, emoji: arg, targetMessageId: target })
              : buildInstagramReactionWebhook({ igUserId: business, igsid: user, emoji: arg, targetMessageId: target });
        print(`  reacting ${arg} → ${target}`);
        await send(payload, `${channel} reaction`);
        return true;
      }

      case '/status': {
        const status = arg.toLowerCase();
        if (status !== 'delivered' && status !== 'read') {
          print('  usage: /status <delivered|read>');
          return true;
        }
        const { business, user } = IDS[channel];
        const target = lastOutboundId();
        if (channel === 'whatsapp') {
          const payload = buildWhatsAppStatusWebhook({
            phoneNumberId: business,
            waId: user,
            status,
            messageId: target
          });
          print(`  status ${status} → ${target}`);
          await send(payload, `whatsapp status`);
        } else if (status === 'read') {
          // Messenger / Instagram only emit a READ watermark (no per-message
          // delivered webhook in this shape).
          const payload =
            channel === 'messenger'
              ? buildMessengerReadWebhook({ pageId: business, psid: user })
              : buildInstagramReadWebhook({ igUserId: business, igsid: user });
          print(`  read receipt (watermark) on ${channel}`);
          await send(payload, `${channel} read`);
        } else {
          print(`  ${channel} does not emit a standalone 'delivered' webhook; try /status read.`);
        }
        return true;
      }

      case '/reset':
        await resetState();
        return true;

      default:
        print(`  unknown command: ${cmd} (try /help)`);
        return true;
    }
  };

  // Drive the loop with a serial queue rather than processing lines inline in the
  // 'line' handler. WHY: readline emits ALL buffered 'line' events synchronously
  // (especially when stdin is a pipe — `printf '…' | repl`), so a per-line
  // `pause()/await/resume()` doesn't actually serialize the async round-trips and
  // the prompt interleaves with outbound prints. Buffering lines into a queue and
  // draining them one-at-a-time in an async worker guarantees each inbound's full
  // flush + outbound print completes before the next line is handled — and works
  // identically for an interactive TTY and a piped session.
  const queue: string[] = [];
  let resolveExit: () => void = () => {};
  const exited = new Promise<void>(resolve => {
    resolveExit = resolve;
  });

  let shuttingDown = false;
  let inputClosed = false;
  let notifyLine: (() => void) | undefined;

  const shutdown = async (code?: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Guard rl.close — calling it twice or after close throws on some Node versions.
    try {
      rl.close();
    } catch {
      /* already closed */
    }
    await runtime.agent.close().catch(() => {});
    await new Promise<void>(resolve => runtime.agentServer.close(() => resolve()));
    await new Promise<void>(resolve => runtime.chatServer.close(() => resolve()));
    if (code !== undefined) process.exitCode = code;
    print('  bye.');
    resolveExit();
  };

  /** Re-prompt only while the interface is alive and not shutting down. */
  const safePrompt = (): void => {
    if (shuttingDown || inputClosed) return;
    setPrompt();
  };

  rl.on('line', line => {
    queue.push(line);
    // Wake the worker if it's waiting for input.
    if (notifyLine) {
      const fn = notifyLine;
      notifyLine = undefined;
      fn();
    }
  });
  rl.on('SIGINT', () => {
    void shutdown(130);
  });
  rl.on('close', () => {
    inputClosed = true;
    // Wake the worker so it can drain remaining queued lines, then exit.
    if (notifyLine) {
      const fn = notifyLine;
      notifyLine = undefined;
      fn();
    }
  });

  // Serial worker: process queued lines one at a time; sleep until more arrive or
  // input closes. On EOF, drain whatever's left, then shut down cleanly.
  void (async () => {
    safePrompt();
    for (;;) {
      if (shuttingDown) break;
      if (queue.length === 0) {
        if (inputClosed) break; // nothing left + stdin closed → done
        // Wait for the next 'line' (or 'close') to wake us.
        await new Promise<void>(resolve => {
          notifyLine = resolve;
        });
        continue;
      }
      const line = queue.shift()!;
      try {
        const keepGoing = await handleCommand(line);
        if (!keepGoing) {
          await shutdown(0);
          break;
        }
      } catch (err) {
        // Never crash on bad input — log and keep going.
        print(`  ! error: ${err instanceof Error ? err.message : String(err)}`);
      }
      safePrompt();
    }
    // Reached on EOF with an empty queue (piped input exhausted, no /exit).
    if (!shuttingDown) await shutdown(0);
  })();

  await exited;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Entry-point guard                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

main().catch((err: unknown) => {
  process.stderr.write(`repl fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exitCode = 1;
});
