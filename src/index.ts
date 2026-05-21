import 'dotenv/config';
import path from 'node:path';
import express from 'express';
import pino from 'pino';
import { Redis } from 'ioredis';
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
import { RedisConversationStore } from './conversation/redis-store.js';
import { InMemoryBufferScheduler, BullMqBufferScheduler } from './conversation/scheduler.js';
import type { BufferScheduler } from './conversation/scheduler.js';
import type { ConversationStore } from './conversation/store.js';
import { ConversationAgent } from './conversation/agent.js';
import { InMemoryLimitCounterStore } from './limits/store.js';
import type { LimitCounterStore } from './limits/store.js';
import { RedisLimitCounterStore } from './limits/redis-store.js';
import { createLimitTracker } from './limits/tracker.js';
import { InMemoryMetricsCollector } from './metrics/collector.js';
import { createAgentMetrics } from './metrics/registry.js';
import { InMemoryStatusTracker } from './status/tracker.js';
import { InMemoryContactStore } from './identity/contact-store.js';
import { HttpIdentityResolver } from './identity/resolver.js';
import type { IdentityResolver } from './identity/resolver.js';
import type { ChannelAdapter } from './meta/shared/adapter.js';
import type { Channel } from './meta/types.js';

/**
 * Build the full dependency graph and return the wired Express app, the
 * conversation agent, and an aggregate `close` — WITHOUT starting a listener.
 * Extracted from `main()` so dev tooling (e.g. `scripts/dev/loop.ts`) can boot
 * the exact same runtime (real adapters, store, scheduler, chat client, agent)
 * against an alternate chat endpoint and tunnel, instead of reimplementing the
 * construction.
 *
 * Construction order: shared Graph transport → per-channel adapters (only the
 * configured channels) → persistence trio (store + scheduler + limit-counter
 * store) → limit tracker → HTTP chat client → agent → createApp.
 *
 * DUAL PERSISTENCE PATH (Stage 10): selected on `config.redisUrl`.
 *  - REDIS_URL set → ONE shared ioredis client backs the
 *    {@link RedisConversationStore} + {@link RedisLimitCounterStore}, and a
 *    {@link BullMqBufferScheduler} (which owns its OWN BullMQ connections). The
 *    shared client is also handed to `createApp` so GET /ready can ping it.
 *  - REDIS_URL unset → the in-memory trio
 *    ({@link InMemoryConversationStore} + {@link InMemoryBufferScheduler} +
 *    {@link InMemoryLimitCounterStore}): per-process, single-replica, lost on
 *    restart. Fine for tests, local runs, and single-replica deploys.
 *
 * The Stage 6 metrics collector, status tracker, and contact-store cache below
 * stay in-memory in both paths (their Redis-backed swaps with TTL eviction are
 * tracked separately).
 *
 * Adding `close` to the return is backward-compatible: existing callers that
 * destructure `{ app, agent }` keep working.
 */
export function buildRuntime(
  config: Config,
  logger: pino.Logger
): { app: express.Express; agent: ConversationAgent; close: () => Promise<void> } {
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

  // Persistence trio (store + buffer scheduler + limit-counter store), selected
  // on REDIS_URL — see the function doc. The Redis path shares ONE ioredis client
  // across the conversation store + limit-counter store. We DELIBERATELY do NOT set
  // `maxRetriesPerRequest: null` on this DATA client: that option (which makes a
  // command retry forever) is a BullMQ-connection requirement, NOT a data-path one.
  // These stores issue only ordinary (non-blocking) commands on the inbound/flush
  // hot path, so we keep ioredis's bounded default — during a Redis outage a command
  // FAILS FAST after the retry budget (caught by the agent's fail-soft handlers)
  // rather than hanging the flush indefinitely. The BullMQ scheduler owns its OWN
  // connections (it needs a blocking one for the worker, with `maxRetriesPerRequest:
  // null`), so it takes the URL rather than this client. `redis` is `undefined` on
  // the in-memory path; it is threaded into createApp (for the /ready ping) and
  // disconnected by the aggregate `close` below.
  //
  // The Stage 6 metrics collector, status tracker, and contact-store cache
  // further down stay in-memory in both paths (their Redis swaps are separate).
  let redis: Redis | undefined;
  let store: ConversationStore;
  let scheduler: BufferScheduler;
  let limitCounterStore: LimitCounterStore;
  if (config.redisUrl) {
    redis = new Redis(config.redisUrl);
    store = new RedisConversationStore({
      redis,
      dedupeTtlSeconds: config.conversation.dedupeTtlSeconds,
      conversationTtlSeconds: config.persistence.conversationTtlSeconds,
      logger
    });
    scheduler = new BullMqBufferScheduler({
      redisUrl: config.redisUrl,
      queueName: config.persistence.bufferQueueName,
      workerConcurrency: config.persistence.bufferWorkerConcurrency,
      logger
    });
    limitCounterStore = new RedisLimitCounterStore({ redis, logger });
  } else {
    store = new InMemoryConversationStore({ dedupeTtlSeconds: config.conversation.dedupeTtlSeconds });
    scheduler = new InMemoryBufferScheduler();
    limitCounterStore = new InMemoryLimitCounterStore();
  }

  // The limit tracker is built in BOTH paths (it fail-opens on a pacing error,
  // so it is always safe to wire) over whichever counter store was selected.
  const limitTracker = createLimitTracker({ store: limitCounterStore, config: config.limits, logger });

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
    limitTracker,
    ...(mediaHydrator ? { mediaHydrator } : {})
  });

  // Boot recovery (fire-and-forget, non-blocking): re-arm any transient retries
  // that were persisted before the last restart. On the in-memory path there is
  // nothing persisted so this resolves with 0; on the Redis path it resumes
  // pending retries across replicas. Logged, never awaited — a recovery failure
  // must not block the listener from coming up.
  void agent
    .recoverPendingRetries()
    .then(({ transientRetriesResumed, processingReset }) => {
      if (transientRetriesResumed > 0 || processingReset > 0) {
        logger.info(
          { transientRetriesResumed, processingReset },
          'recovered conversations from persisted state'
        );
      }
    })
    .catch(err => logger.warn({ err }, 'recoverPendingRetries failed'));

  const app = createApp({
    config,
    logger,
    agent,
    metrics,
    metricsCollector,
    statusTracker,
    store,
    scheduler,
    // Hand the shared client (Redis path only) to /ready so it can ping it. On
    // the in-memory path this is undefined and /ready reports presence-only.
    ...(redis ? { redisClient: redis } : {})
  });

  // Aggregate shutdown: close the agent FIRST (clears the buffer scheduler +
  // delivery-timeout timers, closes the BullMQ scheduler's own connections, and
  // runs the store/limit-tracker no-op closes), THEN disconnect the shared
  // ioredis client. WHY this order: the agent's scheduler may still touch state
  // during a graceful drain. Our BullMQ scheduler owns SEPARATE connections, so
  // ordering is not strictly required — disconnecting the shared client after the
  // agent is closed is simply the safe default.
  const close = async (): Promise<void> => {
    await agent.close();
    if (redis) redis.disconnect();
  };

  return { app, agent, close };
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

  const { app, close } = buildRuntime(config, logger);

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
    // Force-exit fallback first so a hung close (agent, redis, or server) can't
    // wedge the process — `unref` so this timer itself never keeps the loop alive.
    setTimeout(() => process.exit(1), 10_000).unref();
    // Aggregate close BEFORE the server: it closes the agent (clearing the buffer
    // scheduler + delivery-timeout timers so the event loop can drain) and then
    // disconnects the shared Redis client (Redis path). Best-effort — log and
    // proceed to close the server regardless so a close failure can't block
    // shutdown. Boot recovery already fired inside buildRuntime, so it is not
    // repeated here.
    void close()
      .catch(err => logger.error({ err, signal }, 'runtime close failed during shutdown'))
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
