/**
 * Buffer scheduler: arms a per-conversation timer that fires the buffer-flush
 * handler after a computed delay (see {@link calculateBufferTimeout}). One
 * outstanding timer per conversation key — re-scheduling replaces the prior
 * timer so a fresh inbound extends the burst window rather than queuing a
 * second flush.
 *
 * This stage ships the interface plus the {@link InMemoryBufferScheduler}
 * (setTimeout-based, for tests and single-process/local runs). The Redis-backed
 * {@link BufferScheduler.kind} `'bullmq'` implementation is deferred to Stage 10
 * (production path) — hence `kind` and {@link BufferScheduler.getStats} exist
 * now so the `/ready` route and the future BullMQ impl share one shape.
 */

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
