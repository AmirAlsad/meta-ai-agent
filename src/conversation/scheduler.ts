/**
 * Buffer scheduler: arms a per-conversation timer that fires the buffer-flush
 * handler after a computed delay (see {@link calculateBufferTimeout}). One
 * outstanding timer per conversation key — re-scheduling replaces the prior
 * timer so a fresh inbound extends the burst window rather than queuing a
 * second flush.
 *
 * This file ships the interface, the {@link InMemoryBufferScheduler}
 * (setTimeout-based, for tests and single-process/local runs), and the Stage 10
 * {@link BullMqBufferScheduler} (Redis-backed, the production path selected on
 * `REDIS_URL`). `kind` and {@link BufferScheduler.getStats} let the `/ready`
 * route introspect whichever impl is wired.
 */

import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import type pino from 'pino';

/**
 * Called when a conversation's buffer window elapses. Receives the conversation
 * key and the trace id captured when the flush was last scheduled, so the flush
 * can be correlated back to the originating inbound request.
 */
export type BufferHandler = (
  conversationKey: string,
  options?: { traceId?: string }
) => Promise<void>;

/** Counts for the buffer queue. Implementations may approximate / omit fields. */
export interface BufferSchedulerStats {
  /** Jobs scheduled with a future delay (bullmq). */
  delayed?: number;
  /** Locally-pending timers (in_memory only). */
  pending?: number;
}

export interface BufferScheduler {
  /** Register the flush handler. Must be set before {@link schedule}. */
  setHandler(handler: BufferHandler): void;
  /**
   * (Re)arm the flush timer for `conversationKey`, cancelling any existing one.
   * A `delayMs <= 0` fires the handler immediately (awaited).
   */
  schedule(conversationKey: string, delayMs: number, options?: { traceId?: string }): Promise<void>;
  /** Cancel a pending flush for `conversationKey` (no-op if none). */
  cancel(conversationKey: string): Promise<void>;
  /** Release all resources. The in-memory impl clears every pending timer. */
  close(): Promise<void>;
  /** Implementation kind for `/ready` introspection. */
  readonly kind: 'in_memory' | 'bullmq';
  /** Returns counts for the buffer queue. Implementations may approximate. */
  getStats?(): Promise<BufferSchedulerStats>;
}

/**
 * setTimeout-backed {@link BufferScheduler} for tests and single-process/local
 * runs. State is per-process and disappears on restart — production should use
 * the Stage 10 BullMQ implementation selected on `REDIS_URL`.
 */
export class InMemoryBufferScheduler implements BufferScheduler {
  readonly kind = 'in_memory' as const;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pendingTraceIds = new Map<string, string>();
  private handler: BufferHandler | undefined;

  async getStats(): Promise<BufferSchedulerStats> {
    return { pending: this.timers.size };
  }

  setHandler(handler: BufferHandler): void {
    this.handler = handler;
  }

  async schedule(
    conversationKey: string,
    delayMs: number,
    options?: { traceId?: string }
  ): Promise<void> {
    // Replace any in-flight timer first so the latest inbound resets the window
    // (one outstanding flush per conversation, never two).
    await this.cancel(conversationKey);
    if (!this.handler) throw new Error('Buffer scheduler handler not configured');

    if (options?.traceId) this.pendingTraceIds.set(conversationKey, options.traceId);

    if (delayMs <= 0) {
      const traceId = this.pendingTraceIds.get(conversationKey);
      this.pendingTraceIds.delete(conversationKey);
      await this.handler(conversationKey, traceId ? { traceId } : undefined);
      return;
    }

    const handle = setTimeout(() => {
      this.timers.delete(conversationKey);
      const traceId = this.pendingTraceIds.get(conversationKey);
      this.pendingTraceIds.delete(conversationKey);
      // WHY swallow: a rejected flush must not throw out of the timer callback
      // (an unhandled rejection there can crash the process). For now we drop it
      // silently; Stage 6 wires metrics + structured logging into this catch.
      this.handler?.(conversationKey, traceId ? { traceId } : undefined).catch(() => {
        /* Stage 6: increment a failure counter and log here. */
      });
    }, delayMs);
    this.timers.set(conversationKey, handle);
  }

  async cancel(conversationKey: string): Promise<void> {
    const handle = this.timers.get(conversationKey);
    if (handle) clearTimeout(handle);
    this.timers.delete(conversationKey);
    this.pendingTraceIds.delete(conversationKey);
  }

  async close(): Promise<void> {
    // Clear every timer so no dangling handle keeps the event loop (and thus the
    // process) alive on shutdown.
    for (const handle of this.timers.values()) clearTimeout(handle);
    this.timers.clear();
    this.pendingTraceIds.clear();
  }
}

/** Job payload carried on each BullMQ buffer job. */
interface BufferJobPayload {
  conversationKey: string;
  /** Trace id captured when the flush was scheduled (for log correlation). */
  traceId?: string;
}

/**
 * Redis-backed {@link BufferScheduler} (Stage 10 production path). A BullMQ
 * delayed job per conversation key flushes the buffer after the burst window,
 * surviving process restarts and coordinating across replicas (unlike the
 * per-process {@link InMemoryBufferScheduler}).
 *
 * Three load-bearing design choices:
 *
 *  1. **Two SEPARATE connections** (one for the {@link Queue}, one for the
 *     {@link Worker}). The Worker uses blocking Redis commands (`BRPOPLPUSH`
 *     etc.) to wait for jobs; those monopolize a connection, so it cannot share
 *     the Queue's connection. We construct both as explicit `Redis` instances we
 *     own, so {@link BullMqBufferScheduler.close} can disconnect them
 *     deterministically. Both set `maxRetriesPerRequest: null`, which BullMQ
 *     REQUIRES on its connections (a finite retry budget would let BullMQ's
 *     long-lived blocking calls error out).
 *
 *  2. **Stable, replaceable `jobId` = `buffer-<base64url(conversationKey)>`.** One
 *     outstanding flush per conversation: re-scheduling cancels the prior job and
 *     adds a new one under the same id, so a fresh inbound EXTENDS the burst
 *     window rather than queuing a second flush — mirroring the in-memory
 *     "replace the timer" semantics. The key is base64url-encoded because BullMQ
 *     FORBIDS `:` in a custom job id and conversation keys are colon-delimited
 *     (`{channel}:{biz}:{user}`) — see {@link BullMqBufferScheduler.jobId}.
 *
 *  3. **`attempts: 1` (no BullMQ retry).** The flush handler
 *     (`ConversationAgent`'s buffer-flush) is fail-soft and owns its OWN
 *     retry/rebatch logic at the application layer; letting BullMQ also retry a
 *     failed job would double-process. The buffer job is "fire once"; any
 *     recovery is the agent's job.
 */
export class BullMqBufferScheduler implements BufferScheduler {
  readonly kind = 'bullmq' as const;
  private readonly queueName: string;
  /** Stashed so the Worker (created lazily in setHandler) can open its own connection. */
  private readonly redisUrl: string;
  private readonly logger: pino.Logger | undefined;
  /** Connection dedicated to the Queue (non-blocking ops). */
  private readonly queueConnection: Redis;
  private readonly queue: Queue<BufferJobPayload>;
  /** Connection dedicated to the Worker (blocking ops) — created lazily. */
  private workerConnection: Redis | undefined;
  private worker: Worker<BufferJobPayload> | undefined;
  private handler: BufferHandler | undefined;
  /** Worker concurrency — see {@link PersistenceConfig.bufferWorkerConcurrency}. */
  private readonly workerConcurrency: number;

  constructor(opts: { redisUrl: string; queueName: string; workerConcurrency?: number; logger?: pino.Logger }) {
    this.queueName = opts.queueName;
    this.redisUrl = opts.redisUrl;
    this.logger = opts.logger;
    // Default 10 (NOT 1): the flush handler awaits the slow chat call, so a
    // concurrency of 1 would serialize EVERY conversation's flush behind one
    // in-flight chat call — unlike the in-memory scheduler's independent timers.
    // Parallel flushes are safe (each takes only its per-conversation key lock).
    this.workerConcurrency = opts.workerConcurrency ?? 10;
    // Construct our own connection (rather than passing `{ url }`) so the
    // lifecycle is explicit and closeable; `maxRetriesPerRequest: null` is
    // mandatory for BullMQ.
    this.queueConnection = new Redis(opts.redisUrl, { maxRetriesPerRequest: null });
    this.queue = new Queue<BufferJobPayload>(this.queueName, {
      connection: this.queueConnection as ConnectionOptions,
      defaultJobOptions: {
        removeOnComplete: true,
        // Keep the last few failures for debugging; succeeded jobs are dropped.
        removeOnFail: 100,
        // App-layer retry only — see class doc (3).
        attempts: 1
      }
    });
  }

  async getStats(): Promise<BufferSchedulerStats> {
    const counts = await this.queue.getJobCounts('delayed', 'waiting', 'active', 'failed');
    return { delayed: counts.delayed ?? 0 };
  }

  setHandler(handler: BufferHandler): void {
    this.handler = handler;
    if (this.worker) return;

    // The Worker needs its OWN connection (blocking ops) — see class doc (1).
    this.workerConnection = new Redis(this.redisUrl, { maxRetriesPerRequest: null });
    this.worker = new Worker<BufferJobPayload>(
      this.queueName,
      async (job: Job<BufferJobPayload>) => {
        const options = job.data.traceId ? { traceId: job.data.traceId } : undefined;
        await this.handler?.(job.data.conversationKey, options);
      },
      { connection: this.workerConnection as ConnectionOptions, concurrency: this.workerConcurrency }
    );
    // A worker-level error (connection blip, processor throw) must never become
    // an unhandled rejection that crashes the process.
    this.worker.on('error', (err) => {
      this.logger?.error({ err }, 'bullmq buffer worker error');
    });
    this.worker.on('failed', (job, err) => {
      this.logger?.warn({ err, jobId: job?.id }, 'bullmq buffer job failed');
    });
  }

  async schedule(
    conversationKey: string,
    delayMs: number,
    options?: { traceId?: string }
  ): Promise<void> {
    // Replace any in-flight job first so the latest inbound resets the window
    // (one outstanding flush per conversation, never two).
    await this.cancel(conversationKey);
    const payload: BufferJobPayload = { conversationKey };
    if (options?.traceId) payload.traceId = options.traceId;
    await this.queue.add('process-buffer', payload, {
      jobId: this.jobId(conversationKey),
      delay: Math.max(0, delayMs)
    });
  }

  async cancel(conversationKey: string): Promise<void> {
    const job = await this.queue.getJob(this.jobId(conversationKey));
    if (!job) return;
    try {
      await job.remove();
    } catch (err) {
      // RACE: BullMQ throws if the job is ACTIVE (the worker picked up the delayed
      // job between getJob and remove). This is reachable when a concurrent inbound
      // calls schedule()→cancel() in the narrow gap before the agent lock flips the
      // record out of `buffering`. Swallow it: the in-flight flush proceeds on the
      // existing schedule and the new message is already in the buffer, so the
      // conversation makes forward progress either way — only the burst-window
      // extension is skipped. (A non-active remove failure is equally non-fatal
      // here — the next schedule() will re-cancel.)
      this.logger?.debug(
        { err, conversationKey },
        'bullmq cancel: job.remove() failed (likely active); proceeding'
      );
    }
  }

  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
    // Disconnect the connections we own (the worker's may not exist if
    // setHandler was never called).
    this.workerConnection?.disconnect();
    this.queueConnection.disconnect();
  }

  private jobId(conversationKey: string): string {
    // BullMQ FORBIDS ':' in a custom job id (it reserves ':' as its own Redis
    // key delimiter and throws "Custom Id cannot contain :"). Conversation keys
    // are `{channel}:{businessId}:{userId}` — all colons — so base64url-encode
    // the key into a colon-free, collision-free id. The id only needs to be a
    // STABLE, UNIQUE per-conversation identity so a re-schedule REPLACES the
    // prior job; the human-readable conversationKey rides in `job.data`.
    return `buffer-${Buffer.from(conversationKey).toString('base64url')}`;
  }
}
