import 'dotenv/config';
import path from 'node:path';
import express from 'express';
import pino from 'pino';
import { loadConfig, type Config } from './config/loader.js';
import { createApp, PACKAGE_VERSION } from './http/app.js';
import { GraphClient } from './meta/shared/graph-client.js';
import { HttpMediaHydrator } from './meta/shared/media-hydrator.js';
import type { InboundMediaHydrator } from './meta/shared/media-hydrator.js';
import { WhatsAppClient } from './meta/whatsapp/client.js';
import { MessengerClient } from './meta/messenger/client.js';
import { InstagramClient } from './meta/instagram/client.js';
import { HttpChatClient } from './chat/client.js';
import { InMemoryConversationStore } from './conversation/store.js';
import { InMemoryBufferScheduler } from './conversation/scheduler.js';
import { ConversationAgent } from './conversation/agent.js';
import { InMemoryMetricsCollector } from './metrics/collector.js';
import { createAgentMetrics } from './metrics/registry.js';
import { InMemoryStatusTracker } from './status/tracker.js';
import { InMemoryContactStore } from './identity/contact-store.js';
import { HttpIdentityResolver } from './identity/resolver.js';
import type { IdentityResolver } from './identity/resolver.js';
import type { ChannelAdapter } from './meta/shared/adapter.js';
import type { Channel } from './meta/types.js';

/**
 * Build the full Stage 5 dependency graph and return the wired Express app plus
 * the conversation agent — WITHOUT starting a listener. Extracted from `main()`
 * so dev tooling (e.g. `scripts/dev/loop.ts`) can boot the exact same runtime
 * (real adapters, store, scheduler, chat client, agent) against an alternate
 * chat endpoint and tunnel, instead of reimplementing the construction.
 *
 * Construction order: shared Graph transport → per-channel adapters (only the
 * configured channels) → in-memory store + scheduler → HTTP chat client → agent
 * → createApp.
 */
export function buildRuntime(
  config: Config,
  logger: pino.Logger
): { app: express.Express; agent: ConversationAgent } {
  // The shared Graph transport is constructed once; each configured channel
  // gets its own adapter.
  const graph = new GraphClient({ apiVersion: config.meta.graphApiVersion, logger });

  // Wire ONLY the channels that have credentials — an unconfigured channel has
  // no adapter, and the agent drops a turn for a channel it can't send on.
  const adapters: Partial<Record<Channel, ChannelAdapter>> = {};
  if (config.whatsapp) {
    adapters.whatsapp = new WhatsAppClient({
      config: config.whatsapp,
      graph,
      apiVersion: config.meta.graphApiVersion,
      logger
    });
  }
  if (config.messenger) {
    adapters.messenger = new MessengerClient({ config: config.messenger, graph, logger });
  }
  if (config.instagram) {
    adapters.instagram = new InstagramClient({ config: config.instagram, graph, logger });
  }

  // WHY in-memory store + scheduler for Stage 5/6: state is per-process and the
  // setTimeout-based scheduler is single-replica. Likewise the Stage 6 metrics
  // collector, status tracker, and contact-store cache below are all in-memory.
  // The production swap to Redis-backed implementations (store, BullMQ scheduler,
  // status tracker with TTL eviction, shared/bounded contact cache), selected on
  // REDIS_URL, is Stage 10.
  const store = new InMemoryConversationStore({ dedupeTtlSeconds: config.conversation.dedupeTtlSeconds });
  const scheduler = new InMemoryBufferScheduler();
  const chatClient = new HttpChatClient({
    chatEndpointUrl: config.chatEndpointUrl,
    timeoutMs: config.conversation.chatEndpointTimeoutMs,
    logger
  });

  // Stage 6 observability deps. The metrics registry is built once against the
  // collector; agent_up and agent_build_info are set immediately so a scrape
  // right after boot already shows the process as up with its version.
  const metricsCollector = new InMemoryMetricsCollector({ logger });
  const metrics = createAgentMetrics(metricsCollector);
  metrics.agentUp.set(undefined, 1);
  metrics.agentBuildInfo.set({ version: PACKAGE_VERSION }, 1);

  // Identity enrichment (fail-open). An HTTP resolver ONLY when USER_LOOKUP_URL
  // is configured, backed by an in-memory contact cache so repeat senders don't
  // re-hit the lookup endpoint. When no URL is set we pass `undefined` (NOT a
  // NoopIdentityResolver): the agent's "no resolver" branch is what emits
  // `identity_lookup_total{result="disabled"}`. A Noop instance is truthy, so it
  // would take the "resolver present" branch and report `none` on every inbound,
  // making an enrichment-disabled deploy look like a configured-but-empty one.
  const contactStore = new InMemoryContactStore();
  const identityResolver: IdentityResolver | undefined = config.userLookupUrl
    ? new HttpIdentityResolver({
        lookupUrl: config.userLookupUrl,
        timeoutMs: config.conversation.userLookupTimeoutMs,
        logger,
        contactStore
      })
    : undefined;

  // Delivery-status history sink (feeds GET /admin/status/:messageId + metrics).
  const statusTracker = new InMemoryStatusTracker();

  // OPT-IN inbound media hydration. Constructed ONLY when
  // INBOUND_MEDIA_DOWNLOAD is true: the chat endpoint can't fetch WhatsApp media
  // (it holds no access token), so the transport downloads it here and rides the
  // bytes into the chat request as a base64 data URL. Off by default to avoid
  // base64-inflating every media-bearing request. When disabled we pass
  // `undefined` (not a Noop) — the agent simply skips hydration.
  const mediaHydrator: InboundMediaHydrator | undefined = config.conversation.inboundMediaDownload
    ? new HttpMediaHydrator({
        graph,
        ...(config.whatsapp ? { whatsAppAccessToken: config.whatsapp.accessToken } : {}),
        maxBytes: config.conversation.inboundMediaMaxBytes,
        logger
      })
    : undefined;

  const agent = new ConversationAgent({
    store,
    scheduler,
    chatClient,
    adapters,
    config,
    logger,
    metrics,
    identityResolver,
    statusTracker,
    ...(mediaHydrator ? { mediaHydrator } : {})
  });

  const app = createApp({
    config,
    logger,
    agent,
    metrics,
    metricsCollector,
    statusTracker,
    store,
    scheduler
  });

  return { app, agent };
}

function main(): void {
  const config = loadConfig();
  const logger = pino({
    level: process.env.LOG_LEVEL ?? 'info',
    transport:
      config.nodeEnv === 'production'
        ? undefined
        : {
            target: 'pino-pretty',
            options: { translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' }
          }
  });

  const { app, agent } = buildRuntime(config, logger);

  const shouldStart = config.agentAutostart && config.nodeEnv !== 'test';
  if (!shouldStart) {
    logger.info(
      { agentAutostart: config.agentAutostart, nodeEnv: config.nodeEnv },
      'autostart skipped'
    );
    return;
  }

  const server = app.listen(config.port, () => {
    logger.info(
      {
        port: config.port,
        channels: config.channels,
        publicBaseUrl: config.publicBaseUrl ?? null
      },
      'meta-ai-agent listening'
    );
  });

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting down');
    // Force-exit fallback first so a hung close (agent or server) can't wedge
    // the process — `unref` so this timer itself never keeps the loop alive.
    setTimeout(() => process.exit(1), 10_000).unref();
    // Close the agent BEFORE the server: clearing the buffer scheduler +
    // delivery-timeout timers lets the event loop drain so the process can
    // exit. agent.close() is best-effort — log and proceed to close the server
    // regardless so a close failure can't block shutdown.
    void agent
      .close()
      .catch(err => logger.error({ err, signal }, 'agent close failed during shutdown'))
      .finally(() => server.close(() => process.exit(0)));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

/**
 * Run `main()` ONLY when this file is the process entry point. WHY the guard:
 * `scripts/dev/loop.ts` imports `buildRuntime` from this module to boot the
 * runtime itself; without this check that import would also fire `main()` and
 * autostart a second listener. Resolve both `argv[1]` and `import.meta.url` to
 * absolute paths so the match holds regardless of relative-path quirks — same
 * convention as the `scripts/` entry points.
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
  main();
}
