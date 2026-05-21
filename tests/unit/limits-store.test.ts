import { describe, expect, it } from 'vitest';
import { InMemoryLimitCounterStore } from '../../src/limits/store.js';

describe('InMemoryLimitCounterStore.acquireOutboundSlot', () => {
  it('returns 0 for the first call on a fresh line', async () => {
    const store = new InMemoryLimitCounterStore();
    const delay = await store.acquireOutboundSlot('whatsapp:biz', 1000, 10);
    expect(delay).toBe(0);
  });

  it('spaces a rapid second call by ~intervalMs (1000/perSecond)', async () => {
    const store = new InMemoryLimitCounterStore();
    const now = 1000;
    const perSecond = 4; // intervalMs = 250
    const first = await store.acquireOutboundSlot('whatsapp:biz', now, perSecond);
    expect(first).toBe(0);
    // Second call at the same instant must wait one interval.
    const second = await store.acquireOutboundSlot('whatsapp:biz', now, perSecond);
    expect(second).toBe(250);
    // Third call, still same instant, waits two intervals.
    const third = await store.acquireOutboundSlot('whatsapp:biz', now, perSecond);
    expect(third).toBe(500);
  });

  it('does not accumulate burst credit across an idle gap', async () => {
    const store = new InMemoryLimitCounterStore();
    const perSecond = 2; // intervalMs = 500
    await store.acquireOutboundSlot('line', 1000, perSecond);
    // A long idle gap: the next call is well past the reserved slot, so it
    // sends immediately (max(now, lastSlot+interval) clamps to now).
    const afterGap = await store.acquireOutboundSlot('line', 10_000, perSecond);
    expect(afterGap).toBe(0);
  });

  it('tracks lines independently', async () => {
    const store = new InMemoryLimitCounterStore();
    const perSecond = 4; // intervalMs = 250
    await store.acquireOutboundSlot('whatsapp:a', 1000, perSecond);
    // A different line is unaffected and sends now.
    const other = await store.acquireOutboundSlot('whatsapp:b', 1000, perSecond);
    expect(other).toBe(0);
  });

  it('disables pacing when perSecond <= 0 (always 0)', async () => {
    const store = new InMemoryLimitCounterStore();
    expect(await store.acquireOutboundSlot('line', 1000, 0)).toBe(0);
    expect(await store.acquireOutboundSlot('line', 1000, 0)).toBe(0);
    expect(await store.acquireOutboundSlot('line', 1000, -5)).toBe(0);
  });
});
