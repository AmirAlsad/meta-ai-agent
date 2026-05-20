/**
 * Unit tests for the Stage 5 in-memory buffer scheduler.
 *
 * Uses `vi.useFakeTimers()` to drive setTimeout deterministically and asserts
 * the handler contract: one fire per scheduled key, traceId pass-through,
 * immediate fire on `delayMs <= 0`, re-schedule replacing the prior timer,
 * cancel, and close() clearing all pending timers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryBufferScheduler } from '../../src/conversation/scheduler.js';

describe('InMemoryBufferScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('arms a timer that fires the handler once with the key after delayMs', async () => {
    const scheduler = new InMemoryBufferScheduler();
    const handler = vi.fn().mockResolvedValue(undefined);
    scheduler.setHandler(handler);

    await scheduler.schedule('whatsapp:b:u', 2000);
    expect(handler).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1999);
    expect(handler).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith('whatsapp:b:u', undefined);
  });

  it('passes the traceId through to the handler when provided', async () => {
    const scheduler = new InMemoryBufferScheduler();
    const handler = vi.fn().mockResolvedValue(undefined);
    scheduler.setHandler(handler);

    await scheduler.schedule('k', 1000, { traceId: 'trace-123' });
    await vi.advanceTimersByTimeAsync(1000);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith('k', { traceId: 'trace-123' });
  });

  it('fires immediately (awaited) when delayMs <= 0', async () => {
    const scheduler = new InMemoryBufferScheduler();
    const order: string[] = [];
    const handler = vi.fn().mockImplementation(async () => {
      order.push('handler');
    });
    scheduler.setHandler(handler);

    await scheduler.schedule('k', 0, { traceId: 't' });
    order.push('after-schedule');

    // The handler must have run before schedule() resolved (no timer pending).
    expect(handler).toHaveBeenCalledWith('k', { traceId: 't' });
    expect(order).toEqual(['handler', 'after-schedule']);
    await expect(scheduler.getStats()).resolves.toEqual({ pending: 0 });
  });

  it('re-scheduling the same key cancels the prior timer (only the latest fires)', async () => {
    const scheduler = new InMemoryBufferScheduler();
    const handler = vi.fn().mockResolvedValue(undefined);
    scheduler.setHandler(handler);

    await scheduler.schedule('k', 2000, { traceId: 'first' });
    await scheduler.schedule('k', 5000, { traceId: 'second' });

    // Past the first delay but before the second: nothing should have fired.
    await vi.advanceTimersByTimeAsync(2000);
    expect(handler).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3000);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith('k', { traceId: 'second' });
  });

  it('cancel prevents the handler from firing', async () => {
    const scheduler = new InMemoryBufferScheduler();
    const handler = vi.fn().mockResolvedValue(undefined);
    scheduler.setHandler(handler);

    await scheduler.schedule('k', 2000);
    await scheduler.cancel('k');

    await vi.advanceTimersByTimeAsync(10_000);
    expect(handler).not.toHaveBeenCalled();
    await expect(scheduler.getStats()).resolves.toEqual({ pending: 0 });
  });

  it('cancel on an unknown key is a no-op', async () => {
    const scheduler = new InMemoryBufferScheduler();
    scheduler.setHandler(vi.fn().mockResolvedValue(undefined));
    await expect(scheduler.cancel('missing')).resolves.toBeUndefined();
  });

  it('close clears all pending timers so nothing fires afterward', async () => {
    const scheduler = new InMemoryBufferScheduler();
    const handler = vi.fn().mockResolvedValue(undefined);
    scheduler.setHandler(handler);

    await scheduler.schedule('a', 2000);
    await scheduler.schedule('b', 3000);
    await expect(scheduler.getStats()).resolves.toEqual({ pending: 2 });

    await scheduler.close();
    await expect(scheduler.getStats()).resolves.toEqual({ pending: 0 });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(handler).not.toHaveBeenCalled();
  });

  it('getStats reflects the count of pending timers', async () => {
    const scheduler = new InMemoryBufferScheduler();
    scheduler.setHandler(vi.fn().mockResolvedValue(undefined));

    await expect(scheduler.getStats()).resolves.toEqual({ pending: 0 });
    await scheduler.schedule('a', 1000);
    await expect(scheduler.getStats()).resolves.toEqual({ pending: 1 });
    await scheduler.schedule('b', 1000);
    await expect(scheduler.getStats()).resolves.toEqual({ pending: 2 });

    // Firing 'a' removes it from the pending set.
    await vi.advanceTimersByTimeAsync(1000);
    await expect(scheduler.getStats()).resolves.toEqual({ pending: 0 });
  });

  it('throws when scheduling without a handler set', async () => {
    const scheduler = new InMemoryBufferScheduler();
    await expect(scheduler.schedule('k', 1000)).rejects.toThrow(
      'Buffer scheduler handler not configured'
    );
  });

  it('swallows a rejected handler without crashing the timer callback', async () => {
    const scheduler = new InMemoryBufferScheduler();
    const handler = vi.fn().mockRejectedValue(new Error('flush failed'));
    scheduler.setHandler(handler);

    await scheduler.schedule('k', 1000);
    // Must not throw/reject out of the timer; the rejection is swallowed
    // (Stage 6 will log + count it here).
    await expect(vi.advanceTimersByTimeAsync(1000)).resolves.not.toThrow();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('exposes kind = in_memory', () => {
    expect(new InMemoryBufferScheduler().kind).toBe('in_memory');
  });
});
