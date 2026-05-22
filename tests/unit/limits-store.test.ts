import { describe, expect, it } from 'vitest';
import { DAY_MS, HOUR_MS, InMemoryLimitCounterStore } from '../../src/limits/store.js';

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

describe('InMemoryLimitCounterStore.incrementWindowCounters', () => {
  it('returns 1/1 on the first bump for a fresh line', async () => {
    const store = new InMemoryLimitCounterStore();
    const r = await store.incrementWindowCounters('whatsapp:biz', 0);
    expect(r).toEqual({ hourCount: 1, dayCount: 1 });
  });

  it('accumulates within the same hour and day window', async () => {
    const store = new InMemoryLimitCounterStore();
    await store.incrementWindowCounters('line', 0);
    await store.incrementWindowCounters('line', 60_000); // +1 min, same hour/day
    const r = await store.incrementWindowCounters('line', 120_000); // +2 min
    expect(r).toEqual({ hourCount: 3, dayCount: 3 });
  });

  it('rolls the hour window over (resets to 1) while the day window keeps counting', async () => {
    const store = new InMemoryLimitCounterStore();
    await store.incrementWindowCounters('line', 0); // hour bucket 0, day bucket 0
    // Cross into the next hour but stay in the same day.
    const r = await store.incrementWindowCounters('line', HOUR_MS + 1);
    expect(r.hourCount).toBe(1); // new hour bucket → reset
    expect(r.dayCount).toBe(2); // same day bucket → still counting
  });

  it('rolls the day window over (resets to 1) on a new day', async () => {
    const store = new InMemoryLimitCounterStore();
    await store.incrementWindowCounters('line', 0);
    const r = await store.incrementWindowCounters('line', DAY_MS + 1);
    expect(r).toEqual({ hourCount: 1, dayCount: 1 });
  });

  it('tracks lines independently', async () => {
    const store = new InMemoryLimitCounterStore();
    await store.incrementWindowCounters('whatsapp:a', 0);
    await store.incrementWindowCounters('whatsapp:a', 0);
    const b = await store.incrementWindowCounters('whatsapp:b', 0);
    expect(b).toEqual({ hourCount: 1, dayCount: 1 });
  });
});
