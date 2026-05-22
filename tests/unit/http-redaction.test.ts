import { describe, expect, it } from 'vitest';
import {
  redactConversationRecord,
  redactContact,
  redactIncomingMessage,
  redactOutboundItem,
  redactStatusRecord,
  maskConversationKey,
  maskId,
  maskText,
  maskEmail,
  type RedactionOptions
} from '../../src/http/redaction.js';
import type { ConversationRecord } from '../../src/conversation/types.js';
import type { Contact } from '../../src/identity/types.js';
import type { IncomingMessage } from '../../src/meta/types.js';
import type { OutboundItem } from '../../src/delivery/types.js';
import type { StatusRecord } from '../../src/status/types.js';

function makeContact(): Contact {
  return {
    channel: 'whatsapp',
    channelScopedUserId: '447700900123',
    firstName: 'Alice',
    lastName: 'Anderson',
    displayName: 'Alice A.',
    email: 'alice@example.com',
    tags: ['tier:gold'],
    customVariables: { plan: 'pro' },
    unifiedContactId: 'unified-xyz'
  };
}

function makeInbound(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    channel: 'whatsapp',
    channelMessageId: 'wamid.INBOUND1',
    channelScopedUserId: '447700900123',
    channelScopedBusinessId: '1112223334',
    timestamp: 1_700_000_000_000,
    type: 'text',
    text: 'Hey, my account number is 12345 and my email is alice@example.com',
    raw: { from: '447700900123', text: { body: 'secret raw body' } },
    ...overrides
  };
}

function makeOutbound(overrides: Partial<OutboundItem> = {}): OutboundItem {
  return {
    id: 'local-out-1',
    kind: 'message',
    text: 'Sure Alice, your balance is $4,200.00',
    channelMessageId: 'wamid.OUT1',
    sentAt: 1_700_000_001_000,
    ...overrides
  };
}

function makeRecord(): ConversationRecord {
  return {
    key: 'whatsapp:1112223334:447700900123',
    channel: 'whatsapp',
    channelScopedUserId: '447700900123',
    channelScopedBusinessId: '1112223334',
    state: 'sending',
    inboundBuffer: [makeInbound()],
    lateArrivals: [],
    reprocessCount: 0,
    outboundQueue: [makeOutbound()],
    currentOutboundIndex: 0,
    currentOutboundMessageId: 'wamid.OUT1',
    deliveredMessageIds: ['wamid.OUT0'],
    lastInboundMessageId: 'wamid.INBOUND1',
    lastInboundAt: 1_700_000_000_000,
    lastOutboundAt: 1_700_000_001_000,
    windowExpiresAt: 1_700_086_400_000,
    lastActivity: 1_700_000_001_000,
    contact: makeContact(),
    traceId: 'trace-abc-123'
  };
}

describe('maskId', () => {
  it('keeps a short suffix and masks the rest', () => {
    expect(maskId('447700900123')).toBe('…0123');
  });
  it('collapses a value at or below the suffix length to an ellipsis', () => {
    expect(maskId('123')).toBe('…');
    expect(maskId('1234')).toBe('…');
  });
  it('returns empty string for empty / whitespace / non-string input', () => {
    expect(maskId('')).toBe('');
    expect(maskId('   ')).toBe('');
    expect(maskId(undefined as unknown as string)).toBe('');
    expect(maskId(null as unknown as string)).toBe('');
  });
});

describe('maskEmail', () => {
  it('keeps the first local char and the full domain', () => {
    expect(maskEmail('alice@example.com')).toBe('a***@example.com');
  });
  it('falls back to id-masking when there is no @', () => {
    expect(maskEmail('notanemail')).toBe('…mail');
  });
  it('falls back to id-masking when the local part is empty', () => {
    expect(maskEmail('@example.com')).toBe('….com');
  });
  it('returns empty string for empty / non-string input', () => {
    expect(maskEmail('')).toBe('');
    expect(maskEmail('   ')).toBe('');
    expect(maskEmail(undefined as unknown as string)).toBe('');
  });
});

describe('maskText', () => {
  it('is length-only by DEFAULT — leaks no content prefix for a long string', () => {
    // FIX 3: the default must not echo any leading slice of the body.
    const out = maskText('Hello there, this is a long message body');
    expect(out).toBe('[redacted 40 chars]');
    expect(out).not.toContain('Hello');
  });
  it('collapses a short string to a pure length sentinel (no content leak)', () => {
    // A 5-char body must not leak its content either.
    expect(maskText('hello')).toBe('[redacted 5 chars]');
    expect(maskText('hi')).toBe('[redacted 2 chars]');
  });
  it('reports zero length for an empty string', () => {
    expect(maskText('')).toBe('[redacted 0 chars]');
  });
  it('emits length-only when the prefix is 0 (explicit no-leak)', () => {
    expect(maskText('some content', 0)).toBe('[redacted 12 chars]');
  });
  it('opts into a leading prefix only when a positive prefix is passed', () => {
    // The optional prefix param still works for callers that explicitly want it;
    // the admin redactors never pass one, so they always get length-only.
    expect(maskText('Hello there, this is a long message body', 8)).toBe(
      'Hello th… [redacted 40 chars]'
    );
  });
  it('returns empty string for non-string input', () => {
    expect(maskText(undefined as unknown as string)).toBe('');
  });
});

describe('redactContact', () => {
  it('masks user id, name fields, and email by default; keeps channel/tags/customVariables', () => {
    const masked = redactContact(makeContact()) as Record<string, unknown>;
    expect(masked.channelScopedUserId).toBe('…0123');
    expect(masked.firstName).toBe('A***');
    expect(masked.lastName).toBe('A***');
    expect(masked.displayName).toBe('A***');
    expect(masked.email).toBe('a***@example.com');
    // Non-PII / developer-defined fields stay intact.
    expect(masked.channel).toBe('whatsapp');
    expect(masked.tags).toEqual(['tier:gold']);
    expect(masked.customVariables).toEqual({ plan: 'pro' });
    expect(masked.unifiedContactId).toBe('unified-xyz');
  });

  it('returns the contact unchanged when reveal is true', () => {
    const contact = makeContact();
    expect(redactContact(contact, { reveal: true })).toBe(contact);
  });

  it('does not throw on a contact with only the required fields', () => {
    const minimal: Contact = { channel: 'messenger', channelScopedUserId: 'PSID12345' };
    const masked = redactContact(minimal) as Record<string, unknown>;
    expect(masked.channelScopedUserId).toBe('…2345');
    expect(masked.firstName).toBeUndefined();
    expect(masked.email).toBeUndefined();
  });
});

describe('redactConversationRecord', () => {
  it('masks user id, contact PII, and message text but keeps channel/state/key by default', () => {
    const masked = redactConversationRecord(makeRecord()) as Record<string, unknown>;

    // Masked PII
    expect(masked.channelScopedUserId).toBe('…0123');
    const contact = masked.contact as Record<string, unknown>;
    expect(contact.firstName).toBe('A***');
    expect(contact.email).toBe('a***@example.com');
    expect(contact.channelScopedUserId).toBe('…0123');

    // Message text masked, not leaked
    const inbound = (masked.inboundBuffer as Record<string, unknown>[])[0];
    expect(String(inbound.text)).toContain('[redacted');
    expect(String(inbound.text)).not.toContain('account number is 12345');
    expect(inbound.raw).toBe('[redacted]');
    // Structural inbound fields preserved.
    expect(inbound.channelMessageId).toBe('wamid.INBOUND1');
    expect(inbound.type).toBe('text');

    const outbound = (masked.outboundQueue as Record<string, unknown>[])[0];
    expect(String(outbound.text)).toContain('[redacted');
    expect(String(outbound.text)).not.toContain('4,200');
    // OUR send id is non-PII and kept.
    expect(outbound.channelMessageId).toBe('wamid.OUT1');
    expect(outbound.id).toBe('local-out-1');

    // Structural / non-PII conversation fields preserved.
    expect(masked.channel).toBe('whatsapp');
    // FIX 1: the key's USER segment (3rd) is masked; channel:business stays.
    expect(masked.key).toBe('whatsapp:1112223334:…0123');
    expect(masked.state).toBe('sending');
    expect(masked.channelScopedBusinessId).toBe('1112223334');
    expect(masked.currentOutboundMessageId).toBe('wamid.OUT1');
    expect(masked.deliveredMessageIds).toEqual(['wamid.OUT0']);
    expect(masked.windowExpiresAt).toBe(1_700_086_400_000);
    expect(masked.lastActivity).toBe(1_700_000_001_000);
    expect(masked.traceId).toBe('trace-abc-123');
  });

  it('returns the full record unmasked when reveal is true', () => {
    const record = makeRecord();
    const revealed = redactConversationRecord(record, { reveal: true });
    expect(revealed).toBe(record);
    // Spot-check: original content is fully present.
    const r = revealed as ConversationRecord;
    expect(r.channelScopedUserId).toBe('447700900123');
    expect(r.contact?.email).toBe('alice@example.com');
    expect(r.inboundBuffer[0].text).toContain('account number is 12345');
    expect(r.inboundBuffer[0].raw).toEqual({
      from: '447700900123',
      text: { body: 'secret raw body' }
    });
    expect(r.outboundQueue[0].text).toContain('4,200');
  });

  it('does not mutate the input record when redacting', () => {
    const record = makeRecord();
    redactConversationRecord(record);
    // Original is untouched — masking produced a fresh object graph.
    expect(record.channelScopedUserId).toBe('447700900123');
    expect(record.contact?.firstName).toBe('Alice');
    expect(record.inboundBuffer[0].text).toContain('account number is 12345');
    expect(record.inboundBuffer[0].raw).toEqual({
      from: '447700900123',
      text: { body: 'secret raw body' }
    });
  });

  it('is defensive about missing optional fields (no contact, empty buffers)', () => {
    const record = makeRecord();
    delete record.contact;
    record.inboundBuffer = [];
    record.outboundQueue = [];
    const masked = redactConversationRecord(record) as Record<string, unknown>;
    expect(masked.contact).toBeUndefined();
    expect(masked.inboundBuffer).toEqual([]);
    expect(masked.outboundQueue).toEqual([]);
    expect(masked.channelScopedUserId).toBe('…0123');
  });

  it('masks media captions on inbound messages', () => {
    const record = makeRecord();
    record.inboundBuffer = [
      makeInbound({
        type: 'image',
        text: undefined,
        media: { id: 'media-1', mimeType: 'image/jpeg', caption: 'A photo of my passport' }
      })
    ];
    const masked = redactConversationRecord(record) as Record<string, unknown>;
    const inbound = (masked.inboundBuffer as Record<string, unknown>[])[0];
    const media = inbound.media as Record<string, unknown>;
    expect(String(media.caption)).toContain('[redacted');
    expect(String(media.caption)).not.toContain('passport');
    // Non-PII media metadata stays.
    expect(media.id).toBe('media-1');
    expect(media.mimeType).toBe('image/jpeg');
  });

  it('masks outbound media captions', () => {
    const record = makeRecord();
    record.outboundQueue = [
      makeOutbound({
        kind: 'media',
        text: undefined,
        mediaUrl: 'https://cdn.example.com/x.png',
        mediaCaption: 'Here is your statement for John Doe'
      })
    ];
    const masked = redactConversationRecord(record) as Record<string, unknown>;
    const outbound = (masked.outboundQueue as Record<string, unknown>[])[0];
    expect(String(outbound.mediaCaption)).toContain('[redacted');
    expect(String(outbound.mediaCaption)).not.toContain('John Doe');
  });

  it('accepts an explicit reveal:false the same as the default', () => {
    const opts: RedactionOptions = { reveal: false };
    const masked = redactConversationRecord(makeRecord(), opts) as Record<string, unknown>;
    expect(masked.channelScopedUserId).toBe('…0123');
  });
});

describe('maskConversationKey', () => {
  it('masks only the user (3rd) segment, keeping channel:business', () => {
    expect(maskConversationKey('whatsapp:1112223334:447700900123')).toBe(
      'whatsapp:1112223334:…0123'
    );
  });
  it('leaves an unexpectedly-shaped key untouched rather than mangling it', () => {
    // Fewer than 3 segments — better a debuggable opaque key than a corrupted one.
    expect(maskConversationKey('weird-key')).toBe('weird-key');
    expect(maskConversationKey('a:b')).toBe('a:b');
  });
  it('is undefined/empty-safe', () => {
    expect(maskConversationKey('')).toBe('');
    expect(maskConversationKey(undefined as unknown as string)).toBe(undefined);
  });
});

describe('redactIncomingMessage allow-list (fail-closed)', () => {
  // A message populated with EVERY PII-bearing surface so we can prove each one
  // is masked/dropped by default and revealed with reveal:true.
  function makeRichInbound(): IncomingMessage {
    return makeInbound({
      type: 'image',
      text: 'my SSN is 123-45-6789',
      media: {
        id: 'media-1',
        mimeType: 'image/jpeg',
        sha256: 'abc123',
        url: 'https://lookaside.fbcdn.net/secret-media.jpg',
        filename: 'passport-scan.pdf',
        caption: 'photo of my passport',
        voice: false,
        animated: false
      },
      reaction: { emoji: '❤️', targetMessageId: 'wamid.TARGET' },
      replyTo: 'wamid.REPLIED',
      storyReply: { id: 'story-1', url: 'https://instagram.example/story.jpg' },
      storyMention: { id: 'story-2', url: 'https://instagram.example/mention.jpg' },
      postback: { title: 'View Offer', payload: 'PROMO_USER_12345' },
      referral: {
        source: 'ADS',
        type: 'OPEN_THREAD',
        ref: 'campaign-ref-99',
        ctwaClid: 'ctwa-click-id-secret',
        sourceUrl: 'https://fb.example/ad?uid=999',
        headline: 'Limited Time Offer',
        body: 'Tap to chat with us now'
      },
      flowResponse: {
        name: 'lead_gen_flow',
        bodyText: 'Thanks, John — we got your details',
        responseJson: '{"email":"john@example.com","phone":"447700900123"}'
      },
      forwarded: { forwarded: true, frequentlyForwarded: false }
    });
  }

  it('keeps structural / non-PII fields verbatim', () => {
    const out = redactIncomingMessage(makeRichInbound()) as Record<string, unknown>;
    expect(out.channel).toBe('whatsapp');
    expect(out.type).toBe('image');
    expect(out.channelMessageId).toBe('wamid.INBOUND1');
    // OUR business id is kept; the user id is masked.
    expect(out.channelScopedBusinessId).toBe('1112223334');
    expect(out.channelScopedUserId).toBe('…0123');
    expect(out.replyTo).toBe('wamid.REPLIED');
    expect(out.forwarded).toEqual({ forwarded: true, frequentlyForwarded: false });

    const reaction = out.reaction as Record<string, unknown>;
    expect(reaction.emoji).toBe('❤️'); // emoji is not PII — kept
    expect(reaction.targetMessageId).toBe('wamid.TARGET');

    const media = out.media as Record<string, unknown>;
    expect(media.id).toBe('media-1');
    expect(media.mimeType).toBe('image/jpeg');
    expect(media.sha256).toBe('abc123');

    const postback = out.postback as Record<string, unknown>;
    expect(postback.title).toBe('View Offer'); // button label UI text — kept

    const referral = out.referral as Record<string, unknown>;
    expect(referral.source).toBe('ADS');
    expect(referral.type).toBe('OPEN_THREAD');
    expect(referral.ref).toBe('campaign-ref-99');

    const flow = out.flowResponse as Record<string, unknown>;
    expect(flow.name).toBe('lead_gen_flow'); // flow name — kept

    const storyReply = out.storyReply as Record<string, unknown>;
    expect(storyReply.id).toBe('story-1');
    const storyMention = out.storyMention as Record<string, unknown>;
    expect(storyMention.id).toBe('story-2');
  });

  it('masks user-authored free text (length-only, no content leak)', () => {
    const out = redactIncomingMessage(makeRichInbound()) as Record<string, unknown>;
    expect(String(out.text)).toContain('[redacted');
    expect(String(out.text)).not.toContain('123-45-6789');

    const media = out.media as Record<string, unknown>;
    expect(String(media.caption)).toContain('[redacted');
    expect(String(media.caption)).not.toContain('passport');

    const postback = out.postback as Record<string, unknown>;
    expect(String(postback.payload)).toContain('[redacted');
    expect(String(postback.payload)).not.toContain('PROMO_USER_12345');

    const flow = out.flowResponse as Record<string, unknown>;
    expect(String(flow.bodyText)).toContain('[redacted');
    expect(String(flow.bodyText)).not.toContain('John');
  });

  it('DROPS every URL / filename / ctwa / form-submission field to a sentinel', () => {
    const out = redactIncomingMessage(makeRichInbound()) as Record<string, unknown>;

    const media = out.media as Record<string, unknown>;
    expect(media.url).toBe('[redacted]');
    expect(media.filename).toBe('[redacted]');

    const storyReply = out.storyReply as Record<string, unknown>;
    expect(storyReply.url).toBe('[redacted]');
    const storyMention = out.storyMention as Record<string, unknown>;
    expect(storyMention.url).toBe('[redacted]');

    const referral = out.referral as Record<string, unknown>;
    expect(referral.ctwaClid).toBe('[redacted]');
    expect(referral.sourceUrl).toBe('[redacted]');
    expect(referral.headline).toBe('[redacted]');
    expect(referral.body).toBe('[redacted]');

    const flow = out.flowResponse as Record<string, unknown>;
    // The serialized form submission is the highest-PII field — dropped, never masked.
    expect(flow.responseJson).toBe('[redacted]');

    // raw is always dropped.
    expect(out.raw).toBe('[redacted]');
  });

  it('proves none of the raw PII strings survive ANYWHERE in the masked output', () => {
    // Fail-closed safety net: serialize the whole masked object and assert no
    // verbatim PII leaked through any path (a new field added later would have
    // to be explicitly allow-listed to appear at all).
    const serialized = JSON.stringify(redactIncomingMessage(makeRichInbound()));
    for (const secret of [
      '123-45-6789',
      'secret-media.jpg',
      'passport-scan.pdf',
      'instagram.example/story.jpg',
      'instagram.example/mention.jpg',
      'ctwa-click-id-secret',
      'fb.example/ad?uid=999',
      'Limited Time Offer',
      'Tap to chat with us now',
      'john@example.com',
      'PROMO_USER_12345',
      'secret raw body'
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('reveal:true returns the message untouched (all fields present in clear)', () => {
    const msg = makeRichInbound();
    const revealed = redactIncomingMessage(msg, { reveal: true });
    expect(revealed).toBe(msg);
    const r = revealed as IncomingMessage;
    expect(r.media?.url).toBe('https://lookaside.fbcdn.net/secret-media.jpg');
    expect(r.referral?.ctwaClid).toBe('ctwa-click-id-secret');
    expect(r.flowResponse?.responseJson).toContain('john@example.com');
  });

  it('omits sub-objects that are absent on the source (undefined-safe)', () => {
    const out = redactIncomingMessage(makeInbound()) as Record<string, unknown>;
    expect(out.media).toBeUndefined();
    expect(out.reaction).toBeUndefined();
    expect(out.referral).toBeUndefined();
    expect(out.flowResponse).toBeUndefined();
    expect(out.postback).toBeUndefined();
    // text + raw are present on the base fixture and handled.
    expect(String(out.text)).toContain('[redacted');
    expect(out.raw).toBe('[redacted]');
  });
});

describe('redactOutboundItem allow-list (fail-closed)', () => {
  function makeRichOutbound(): OutboundItem {
    return makeOutbound({
      kind: 'media',
      text: 'Sure Alice, your balance is $4,200.00',
      mediaUrl: 'https://cdn.example.com/statement-john-doe.pdf',
      mediaCaption: 'Statement for John Doe',
      templateName: 'order_update',
      templateLanguage: 'en_US',
      templateComponents: [{ type: 'body', parameters: [{ text: '447700900123' }] }],
      targetMessageId: 'wamid.TARGET',
      durationMs: 1500
    });
  }

  it('keeps ids + bookkeeping, masks text/caption, drops url + templateComponents', () => {
    const out = redactOutboundItem(makeRichOutbound()) as Record<string, unknown>;
    // Kept structural.
    expect(out.id).toBe('local-out-1');
    expect(out.kind).toBe('media');
    expect(out.channelMessageId).toBe('wamid.OUT1');
    expect(out.templateName).toBe('order_update');
    expect(out.templateLanguage).toBe('en_US');
    expect(out.targetMessageId).toBe('wamid.TARGET');
    expect(out.durationMs).toBe(1500);
    // Masked free text.
    expect(String(out.text)).toContain('[redacted');
    expect(String(out.text)).not.toContain('4,200');
    expect(String(out.mediaCaption)).toContain('[redacted');
    expect(String(out.mediaCaption)).not.toContain('John Doe');
    // Dropped.
    expect(out.mediaUrl).toBe('[redacted]');
    expect(out.templateComponents).toBe('[redacted]');
    // The user id buried in templateComponents must not survive anywhere.
    expect(JSON.stringify(out)).not.toContain('447700900123');
  });

  it('reveal:true returns the item untouched', () => {
    const item = makeRichOutbound();
    const revealed = redactOutboundItem(item, { reveal: true });
    expect(revealed).toBe(item);
    expect((revealed as OutboundItem).mediaUrl).toBe(
      'https://cdn.example.com/statement-john-doe.pdf'
    );
  });
});

describe('redactStatusRecord', () => {
  function makeStatus(overrides: Partial<StatusRecord> = {}): StatusRecord {
    return {
      channelMessageId: 'wamid.OUT1',
      channel: 'whatsapp',
      conversationKey: 'whatsapp:1112223334:447700900123',
      recipientId: '447700900123',
      current: 'delivered',
      history: [
        { status: 'sent', timestamp: 1_700_000_000_000 },
        { status: 'delivered', timestamp: 1_700_000_001_000 }
      ],
      firstSeenAt: 1_700_000_000_000,
      lastUpdatedAt: 1_700_000_001_000,
      ...overrides
    };
  }

  it('masks recipientId and the key user-segment; keeps the status timeline', () => {
    const out = redactStatusRecord(makeStatus()) as Record<string, unknown>;
    // Masked PII.
    expect(out.recipientId).toBe('…0123');
    expect(out.conversationKey).toBe('whatsapp:1112223334:…0123');
    // Kept structural / non-PII.
    expect(out.channelMessageId).toBe('wamid.OUT1');
    expect(out.channel).toBe('whatsapp');
    expect(out.current).toBe('delivered');
    expect(out.firstSeenAt).toBe(1_700_000_000_000);
    expect(out.lastUpdatedAt).toBe(1_700_000_001_000);
    expect(out.history).toEqual([
      { status: 'sent', timestamp: 1_700_000_000_000 },
      { status: 'delivered', timestamp: 1_700_000_001_000 }
    ]);
    // The raw user id must not survive anywhere in the masked output.
    expect(JSON.stringify(out)).not.toContain('447700900123');
  });

  it('is defensive when recipientId / conversationKey are absent', () => {
    const out = redactStatusRecord(
      makeStatus({ recipientId: undefined, conversationKey: undefined })
    ) as Record<string, unknown>;
    expect(out.recipientId).toBeUndefined();
    expect(out.conversationKey).toBeUndefined();
    expect(out.channelMessageId).toBe('wamid.OUT1');
  });

  it('surfaces errorCategory unmasked (bounded enum, not PII) — top-level and in history', () => {
    const out = redactStatusRecord(
      makeStatus({
        current: 'failed',
        errorCategory: 'recipient',
        history: [
          { status: 'sent', timestamp: 1_700_000_000_000 },
          {
            status: 'failed',
            timestamp: 1_700_000_002_000,
            errorCode: 131_026,
            errorTitle: 'Message undeliverable',
            errorCategory: 'recipient'
          }
        ]
      })
    ) as Record<string, unknown>;
    // The bucket is allow-listed verbatim, not dropped by the fail-closed redactor.
    expect(out.errorCategory).toBe('recipient');
    expect(out.history).toEqual([
      { status: 'sent', timestamp: 1_700_000_000_000 },
      {
        status: 'failed',
        timestamp: 1_700_000_002_000,
        errorCode: 131_026,
        errorTitle: 'Message undeliverable',
        errorCategory: 'recipient'
      }
    ]);
  });

  it('reveal:true returns the record untouched', () => {
    const rec = makeStatus();
    const revealed = redactStatusRecord(rec, { reveal: true });
    expect(revealed).toBe(rec);
    expect((revealed as StatusRecord).recipientId).toBe('447700900123');
  });
});
