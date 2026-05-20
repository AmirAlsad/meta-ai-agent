/**
 * Unit tests for the pure delivery-queue logic (`src/delivery/queue.ts`):
 * `buildOutboundItems` (action → item mapping, downgrades, skips), the
 * per-channel advancement policy (`advancementMode` / `statusAdvancesQueue`),
 * and the cursor helpers (`currentItem` / `isQueueComplete` / `advanceCursor`).
 */
import { describe, expect, it } from 'vitest';
import type { ChatAction } from '../../src/chat/types.js';
import type { ChannelFeature } from '../../src/meta/shared/adapter.js';
import type { OutboundItem, QueueState } from '../../src/delivery/types.js';
import {
  advanceCursor,
  advancementMode,
  buildOutboundItems,
  currentItem,
  isQueueComplete,
  statusAdvancesQueue
} from '../../src/delivery/queue.js';

/** A `supports` predicate that advertises every feature. */
const supportsAll = (): boolean => true;

/** A typical non-WhatsApp predicate: media + template + reply + reaction off. */
function supportsNoRich(feature: ChannelFeature): boolean {
  return !(
    feature === 'media_send' ||
    feature === 'template' ||
    feature === 'reply_to' ||
    feature === 'reaction'
  );
}

/** Every action variant, in a fixed order, for the supports-all mapping test. */
const ALL_ACTIONS: ChatAction[] = [
  { type: 'message', text: 'hello' },
  { type: 'reply', text: 'replying', targetMessageId: 'wamid.reply-target' },
  { type: 'reaction', emoji: '👍', targetMessageId: 'wamid.react-target' },
  { type: 'typing', durationMs: 1500 },
  { type: 'media', url: 'https://cdn.example/cat.jpg', caption: 'a cat', mimeType: 'image/jpeg' },
  {
    type: 'template',
    name: 'order_update',
    language: 'en_US',
    components: [{ type: 'body', parameters: [{ type: 'text', text: 'Ada' }] }]
  },
  { type: 'silence' }
];

describe('buildOutboundItems', () => {
  it('maps every action type to the right item with a non-empty id (supports-all)', () => {
    const { items, skipped } = buildOutboundItems(ALL_ACTIONS, supportsAll);

    // silence yields no item; the other six actions each yield exactly one.
    expect(items).toHaveLength(6);
    expect(skipped).toEqual([]);

    // Every item carries a non-empty local id.
    for (const item of items) {
      expect(typeof item.id).toBe('string');
      expect(item.id.length).toBeGreaterThan(0);
    }

    // Compare item shapes ignoring the random ids.
    const withoutIds = items.map(({ id: _id, ...rest }) => rest);
    expect(withoutIds).toEqual([
      { kind: 'message', text: 'hello' },
      { kind: 'reply', text: 'replying', targetMessageId: 'wamid.reply-target' },
      { kind: 'reaction', emoji: '👍', targetMessageId: 'wamid.react-target' },
      { kind: 'typing', durationMs: 1500 },
      {
        kind: 'media',
        mediaUrl: 'https://cdn.example/cat.jpg',
        mediaCaption: 'a cat',
        mediaMimeType: 'image/jpeg'
      },
      {
        kind: 'template',
        templateName: 'order_update',
        templateLanguage: 'en_US',
        templateComponents: [{ type: 'body', parameters: [{ type: 'text', text: 'Ada' }] }]
      }
    ]);
  });

  it('silence produces no item and no skip note', () => {
    const { items, skipped } = buildOutboundItems([{ type: 'silence' }], supportsAll);
    expect(items).toEqual([]);
    expect(skipped).toEqual([]);
  });

  it('assigns DISTINCT ids to two items', () => {
    const { items } = buildOutboundItems(
      [
        { type: 'message', text: 'one' },
        { type: 'message', text: 'two' }
      ],
      supportsAll
    );
    expect(items).toHaveLength(2);
    expect(items[0].id).not.toBe(items[1].id);
  });

  it('skips media and template with reasons on a non-WhatsApp predicate', () => {
    const { items, skipped } = buildOutboundItems(
      [
        { type: 'media', url: 'https://cdn.example/v.mp4', mimeType: 'video/mp4' },
        { type: 'template', name: 'promo', language: 'en_US' }
      ],
      supportsNoRich
    );

    expect(items).toEqual([]);
    expect(skipped).toEqual([
      { kind: 'media', reason: 'media_send unsupported (Stage 7)' },
      { kind: 'template', reason: 'template unsupported on this channel' }
    ]);
  });

  it('downgrades reply to message (and notes it) when reply_to is unsupported', () => {
    const { items, skipped } = buildOutboundItems(
      [{ type: 'reply', text: 'still deliver me', targetMessageId: 'm_target' }],
      supportsNoRich
    );

    // The text is STILL delivered — as a plain message, not dropped.
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'message', text: 'still deliver me' });
    expect(items[0].targetMessageId).toBeUndefined();
    expect(items[0].id.length).toBeGreaterThan(0);

    expect(skipped).toEqual([
      { kind: 'reply', reason: 'reply_to unsupported; downgraded to message' }
    ]);
  });

  it('skips reaction with a reason when reaction is unsupported', () => {
    const { items, skipped } = buildOutboundItems(
      [{ type: 'reaction', emoji: '❤️', targetMessageId: 'm_target' }],
      supportsNoRich
    );
    expect(items).toEqual([]);
    expect(skipped).toEqual([
      { kind: 'reaction', reason: 'reaction unsupported on this channel' }
    ]);
  });

  it('skips typing with a reason when typing_indicator is unsupported', () => {
    // typing_indicator is off in supportsNoRich? No — only reply/reaction/media/
    // template are off there, so use an explicit predicate that disables typing.
    const noTyping = (feature: ChannelFeature): boolean => feature !== 'typing_indicator';
    const { items, skipped } = buildOutboundItems([{ type: 'typing', durationMs: 800 }], noTyping);
    expect(items).toEqual([]);
    expect(skipped).toEqual([
      { kind: 'typing', reason: 'typing_indicator unsupported on this channel' }
    ]);
  });
});

describe('advancementMode', () => {
  it('whatsapp advances on a delivery status (on_status)', () => {
    expect(advancementMode('whatsapp')).toBe('on_status');
  });

  it('messenger and instagram advance on a successful send (on_send)', () => {
    expect(advancementMode('messenger')).toBe('on_send');
    expect(advancementMode('instagram')).toBe('on_send');
  });
});

describe('statusAdvancesQueue', () => {
  it('whatsapp: sent and delivered advance; read and failed do not', () => {
    expect(statusAdvancesQueue('whatsapp', 'sent')).toBe(true);
    expect(statusAdvancesQueue('whatsapp', 'delivered')).toBe(true);
    expect(statusAdvancesQueue('whatsapp', 'read')).toBe(false);
    expect(statusAdvancesQueue('whatsapp', 'failed')).toBe(false);
  });

  it('messenger: no status advances the queue (advances on send)', () => {
    for (const status of ['sent', 'delivered', 'read', 'failed'] as const) {
      expect(statusAdvancesQueue('messenger', status)).toBe(false);
    }
  });

  it('instagram: no status advances the queue (advances on send)', () => {
    for (const status of ['sent', 'delivered', 'read', 'failed'] as const) {
      expect(statusAdvancesQueue('instagram', status)).toBe(false);
    }
  });
});

describe('cursor helpers', () => {
  const makeItem = (id: string): OutboundItem => ({ id, kind: 'message', text: id });
  const baseQueue: QueueState = {
    items: [makeItem('a'), makeItem('b')],
    currentIndex: 0
  };

  it('currentItem returns the item at the cursor', () => {
    expect(currentItem(baseQueue)?.id).toBe('a');
    expect(currentItem({ ...baseQueue, currentIndex: 1 })?.id).toBe('b');
  });

  it('currentItem returns undefined when the cursor is out of range', () => {
    expect(currentItem({ ...baseQueue, currentIndex: 2 })).toBeUndefined();
    expect(currentItem({ items: [], currentIndex: 0 })).toBeUndefined();
  });

  it('isQueueComplete is false mid-queue and true once past the end', () => {
    expect(isQueueComplete(baseQueue)).toBe(false);
    expect(isQueueComplete({ ...baseQueue, currentIndex: 1 })).toBe(false);
    expect(isQueueComplete({ ...baseQueue, currentIndex: 2 })).toBe(true);
    // An empty queue is complete from the start.
    expect(isQueueComplete({ items: [], currentIndex: 0 })).toBe(true);
  });

  it('advanceCursor increments the index and does not mutate its input', () => {
    const next = advanceCursor(baseQueue);
    expect(next.currentIndex).toBe(1);
    // Input untouched.
    expect(baseQueue.currentIndex).toBe(0);
    // items array reference is reused (cheap, immutable contract).
    expect(next.items).toBe(baseQueue.items);
  });

  it('advanceCursor walks a small queue to completion', () => {
    let state: QueueState = baseQueue;
    expect(currentItem(state)?.id).toBe('a');
    state = advanceCursor(state);
    expect(currentItem(state)?.id).toBe('b');
    state = advanceCursor(state);
    expect(currentItem(state)).toBeUndefined();
    expect(isQueueComplete(state)).toBe(true);
  });
});
