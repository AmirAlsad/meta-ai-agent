/**
 * Unit tests for the Stage 6 in-memory delivery-status tracker:
 * per-message upsert + append-only history, the rank-based (non-regressing)
 * `current`, idempotency under exact-duplicate redeliveries, `failed`
 * diagnostics, the Messenger/IG read-watermark fan-out, and the load-bearing
 * clone-on-read contract. Also asserts the STATUS_RANK ordering directly.
 */
import { describe, expect, it } from 'vitest';
import { InMemoryStatusTracker } from '../../src/status/tracker.js';
import { STATUS_RANK } from '../../src/status/types.js';

/** Tracker plus a base status-update input with sensible defaults. */
function makeTracker(): InMemoryStatusTracker {
  return new InMemoryStatusTracker();
}

describe('InMemoryStatusTracker — applyStatusUpdate', () => {
  it('creates a record on the first status, seeding current/history/timestamps', () => {
    const tracker = makeTracker();
    const record = tracker.applyStatusUpdate({
      channelMessageId: 'wamid.A',
      channel: 'whatsapp',
      status: 'sent',
      timestamp: 1000,
      conversationKey: 'whatsapp:pn-1:wa-1',
      recipientId: 'wa-1'
    });

    expect(record.channelMessageId).toBe('wamid.A');
    expect(record.channel).toBe('whatsapp');
    expect(record.conversationKey).toBe('whatsapp:pn-1:wa-1');
    expect(record.recipientId).toBe('wa-1');
    expect(record.current).toBe('sent');
    expect(record.history).toEqual([{ status: 'sent', timestamp: 1000 }]);
    expect(record.firstSeenAt).toBe(1000);
    expect(record.lastUpdatedAt).toBe(1000);
  });

  it('appends to history and advances current sent -> delivered -> read', () => {
    const tracker = makeTracker();
    tracker.applyStatusUpdate({ channelMessageId: 'wamid.A', channel: 'whatsapp', status: 'sent', timestamp: 1000 });
    tracker.applyStatusUpdate({ channelMessageId: 'wamid.A', channel: 'whatsapp', status: 'delivered', timestamp: 2000 });
    const record = tracker.applyStatusUpdate({
      channelMessageId: 'wamid.A',
      channel: 'whatsapp',
      status: 'read',
      timestamp: 3000
    });

    expect(record.current).toBe('read');
    expect(record.history.map((h) => h.status)).toEqual(['sent', 'delivered', 'read']);
    expect(record.firstSeenAt).toBe(1000);
    expect(record.lastUpdatedAt).toBe(3000);
  });

  it('does NOT regress current when an out-of-order sent arrives after delivered', () => {
    const tracker = makeTracker();
    tracker.applyStatusUpdate({ channelMessageId: 'wamid.A', channel: 'whatsapp', status: 'delivered', timestamp: 2000 });
    // A late `sent` (Meta does not guarantee ordering) arrives after delivered.
    const record = tracker.applyStatusUpdate({
      channelMessageId: 'wamid.A',
      channel: 'whatsapp',
      status: 'sent',
      timestamp: 1000
    });

    // current stays at the more-advanced delivered...
    expect(record.current).toBe('delivered');
    // ...but history preserves BOTH events in arrival order.
    expect(record.history.map((h) => h.status)).toEqual(['delivered', 'sent']);
    // firstSeenAt tracks the earliest timestamp regardless of arrival order.
    expect(record.firstSeenAt).toBe(1000);
    // lastUpdatedAt does not move backward for the older event.
    expect(record.lastUpdatedAt).toBe(2000);
  });

  it('is idempotent on an exact-duplicate (status,timestamp) redelivery', () => {
    const tracker = makeTracker();
    tracker.applyStatusUpdate({ channelMessageId: 'wamid.A', channel: 'whatsapp', status: 'delivered', timestamp: 2000 });
    const record = tracker.applyStatusUpdate({
      channelMessageId: 'wamid.A',
      channel: 'whatsapp',
      status: 'delivered',
      timestamp: 2000
    });

    // History is not double-appended for the exact duplicate.
    expect(record.history).toEqual([{ status: 'delivered', timestamp: 2000 }]);
    expect(record.current).toBe('delivered');
  });

  it('appends a same-status event with a DIFFERENT timestamp (not a duplicate)', () => {
    const tracker = makeTracker();
    tracker.applyStatusUpdate({ channelMessageId: 'wamid.A', channel: 'whatsapp', status: 'delivered', timestamp: 2000 });
    const record = tracker.applyStatusUpdate({
      channelMessageId: 'wamid.A',
      channel: 'whatsapp',
      status: 'delivered',
      timestamp: 2500
    });

    expect(record.history).toEqual([
      { status: 'delivered', timestamp: 2000 },
      { status: 'delivered', timestamp: 2500 }
    ]);
  });

  it('records errorCode/errorTitle/errorCategory on failed and sets current to failed', () => {
    const tracker = makeTracker();
    const record = tracker.applyStatusUpdate({
      channelMessageId: 'wamid.A',
      channel: 'whatsapp',
      status: 'failed',
      timestamp: 1500,
      errorCode: 131_026,
      errorTitle: 'Message undeliverable'
    });

    expect(record.current).toBe('failed');
    // 131026 → recipient bucket; the derived category rides on the history entry
    // AND is mirrored onto the record top-level.
    expect(record.history).toEqual([
      {
        status: 'failed',
        timestamp: 1500,
        errorCode: 131_026,
        errorTitle: 'Message undeliverable',
        errorCategory: 'recipient'
      }
    ]);
    expect(record.errorCategory).toBe('recipient');
  });

  it('derives errorCategory for a failed status even with NO errorCode (→ unknown)', () => {
    const tracker = makeTracker();
    const record = tracker.applyStatusUpdate({
      channelMessageId: 'wamid.B',
      channel: 'whatsapp',
      status: 'failed',
      timestamp: 2000
    });
    expect(record.history[0]).toEqual({
      status: 'failed',
      timestamp: 2000,
      errorCategory: 'unknown'
    });
    expect(record.errorCategory).toBe('unknown');
  });

  it('maps a window errorCode (131047) to the window_closed category', () => {
    const tracker = makeTracker();
    const record = tracker.applyStatusUpdate({
      channelMessageId: 'wamid.C',
      channel: 'whatsapp',
      status: 'failed',
      timestamp: 2500,
      errorCode: 131_047
    });
    expect(record.errorCategory).toBe('window_closed');
    expect(record.history[0]?.errorCategory).toBe('window_closed');
  });

  it('does NOT attach errorCategory to a non-failure status', () => {
    const tracker = makeTracker();
    const record = tracker.applyStatusUpdate({
      channelMessageId: 'wamid.D',
      channel: 'whatsapp',
      status: 'sent',
      timestamp: 3000
    });
    expect(record.history[0]).toEqual({ status: 'sent', timestamp: 3000 });
    expect(record.history[0]).not.toHaveProperty('errorCategory');
    expect(record.errorCategory).toBeUndefined();
  });

  it('failed (top rank) is not masked by a lower-rank status arriving afterward', () => {
    const tracker = makeTracker();
    tracker.applyStatusUpdate({ channelMessageId: 'wamid.A', channel: 'whatsapp', status: 'failed', timestamp: 1500, errorCode: 131_026 });
    const record = tracker.applyStatusUpdate({
      channelMessageId: 'wamid.A',
      channel: 'whatsapp',
      status: 'sent',
      timestamp: 1000
    });

    expect(record.current).toBe('failed');
    expect(record.history.map((h) => h.status)).toEqual(['failed', 'sent']);
  });
});

describe('InMemoryStatusTracker — applyReadWatermark', () => {
  it('marks the given known ids read, returns affected records', () => {
    const tracker = makeTracker();
    tracker.applyStatusUpdate({ channelMessageId: 'm_1', channel: 'messenger', status: 'sent', timestamp: 1000 });
    tracker.applyStatusUpdate({ channelMessageId: 'm_2', channel: 'messenger', status: 'sent', timestamp: 1500 });

    const affected = tracker.applyReadWatermark({
      messageIds: ['m_1', 'm_2'],
      channel: 'messenger',
      watermark: 2000,
      conversationKey: 'messenger:page-1:psid-1'
    });

    expect(affected.map((r) => r.channelMessageId).sort()).toEqual(['m_1', 'm_2']);
    expect(affected.every((r) => r.current === 'read')).toBe(true);
    // The read event lands at the watermark time on each record.
    expect(tracker.getStatus('m_1')!.history.map((h) => h.status)).toEqual(['sent', 'read']);
    expect(tracker.getStatus('m_1')!.history.at(-1)!.timestamp).toBe(2000);
    expect(tracker.getStatus('m_1')!.conversationKey).toBe('messenger:page-1:psid-1');
  });

  it('skips unknown ids and only returns records for ids it knows', () => {
    const tracker = makeTracker();
    tracker.applyStatusUpdate({ channelMessageId: 'ig_1', channel: 'instagram', status: 'sent', timestamp: 1000 });

    const affected = tracker.applyReadWatermark({
      messageIds: ['ig_1', 'ig_unknown'],
      channel: 'instagram',
      watermark: 2000
    });

    expect(affected.map((r) => r.channelMessageId)).toEqual(['ig_1']);
    // The unknown id is NOT conjured into existence by the watermark.
    expect(tracker.getStatus('ig_unknown')).toBeUndefined();
  });

  it('returns an empty array when no ids are known', () => {
    const tracker = makeTracker();
    const affected = tracker.applyReadWatermark({ messageIds: ['nope'], channel: 'messenger', watermark: 999 });
    expect(affected).toEqual([]);
  });
});

describe('InMemoryStatusTracker — getStatus / clone-on-read', () => {
  it('returns a CLONE: mutating the result does not change stored state', () => {
    const tracker = makeTracker();
    tracker.applyStatusUpdate({ channelMessageId: 'wamid.A', channel: 'whatsapp', status: 'sent', timestamp: 1000 });

    const got = tracker.getStatus('wamid.A')!;
    got.current = 'read';
    got.history.push({ status: 'failed', timestamp: 9999 });

    const again = tracker.getStatus('wamid.A')!;
    expect(again.current).toBe('sent');
    expect(again.history).toEqual([{ status: 'sent', timestamp: 1000 }]);
  });

  it('the record returned by applyStatusUpdate is also a clone', () => {
    const tracker = makeTracker();
    const returned = tracker.applyStatusUpdate({ channelMessageId: 'wamid.A', channel: 'whatsapp', status: 'sent', timestamp: 1000 });
    returned.history.push({ status: 'read', timestamp: 9999 });

    expect(tracker.getStatus('wamid.A')!.history).toEqual([{ status: 'sent', timestamp: 1000 }]);
  });

  it('returns undefined for an unknown id', () => {
    const tracker = makeTracker();
    expect(tracker.getStatus('wamid.missing')).toBeUndefined();
  });
});

describe('InMemoryStatusTracker — listByConversation', () => {
  it('returns matching records most-recently-updated first, honoring limit', () => {
    const tracker = makeTracker();
    const key = 'whatsapp:pn-1:wa-1';
    tracker.applyStatusUpdate({ channelMessageId: 'wamid.A', channel: 'whatsapp', status: 'sent', timestamp: 1000, conversationKey: key });
    tracker.applyStatusUpdate({ channelMessageId: 'wamid.B', channel: 'whatsapp', status: 'sent', timestamp: 3000, conversationKey: key });
    tracker.applyStatusUpdate({ channelMessageId: 'wamid.C', channel: 'whatsapp', status: 'sent', timestamp: 2000, conversationKey: 'other' });

    const all = tracker.listByConversation(key);
    expect(all.map((r) => r.channelMessageId)).toEqual(['wamid.B', 'wamid.A']);

    const limited = tracker.listByConversation(key, 1);
    expect(limited.map((r) => r.channelMessageId)).toEqual(['wamid.B']);
  });
});

describe('STATUS_RANK ordering', () => {
  it('orders sent < delivered < read < failed', () => {
    expect(STATUS_RANK.sent).toBeLessThan(STATUS_RANK.delivered);
    expect(STATUS_RANK.delivered).toBeLessThan(STATUS_RANK.read);
    expect(STATUS_RANK.read).toBeLessThan(STATUS_RANK.failed);
  });
});
