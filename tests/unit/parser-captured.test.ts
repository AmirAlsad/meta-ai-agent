import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  parseInstagramWebhook,
  parseMessengerWebhook,
  parseWhatsAppWebhook
} from '../../src/meta/parser.js';

/**
 * These fixtures come from real Meta webhooks captured by `npm run setup:whatsapp`,
 * `npm run setup:messenger`, and `npm run setup:instagram` (see
 * docs/features/payload-capture.md). Phone numbers, PSIDs, IGSIDs, page/IG-user
 * ids, names, mids, and wamids are redacted to clearly-fake test values;
 * everything else is byte-for-byte what Meta actually sent in 2026-05.
 * Real-payload fields our documentation-derived fixtures lacked:
 *   - WhatsApp: `contacts[].user_id`, `messages[].from_user_id`,
 *     `statuses[].recipient_user_id`, and the PMP `pricing` block.
 *   - Messenger: `reaction.reaction` (the named reaction string, e.g. "laugh",
 *     sent alongside `reaction.emoji`).
 *   - Instagram: `reaction.reaction` too (the named string, e.g. "other" for ❤),
 *     sent alongside `reaction.emoji` and `reaction.action` — same extra field
 *     Messenger sends. Also notable: the IG message/reaction `mid` is a long
 *     base64-ish `aWdf…`-prefixed string (a different shape from Messenger's
 *     `m_…` mids), and IG ships its `entry[].id` / `recipient.id` as the
 *     17-digit IG business-user id (not a page id).
 * See docs/META-PAYLOAD-STRUCTURES.md for the inventory.
 *
 * The parser must tolerate the extra fields without choking. These tests
 * lock in that behavior; future Meta additions should drop into the same
 * pattern (capture → redact → promote → add test).
 */

function loadFixture(channel: 'whatsapp' | 'messenger' | 'instagram', name: string): unknown {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fixturePath = path.resolve(here, `../fixtures/meta/${channel}/captured/${name}.json`);
  return JSON.parse(readFileSync(fixturePath, 'utf8'));
}

describe('parseWhatsAppWebhook against real captured payloads', () => {
  describe('outbound-status-sent', () => {
    const payload = loadFixture('whatsapp', 'outbound-status-sent');
    const result = parseWhatsAppWebhook(payload);

    it('emits one StatusUpdate, no messages', () => {
      expect(result.messages).toHaveLength(0);
      expect(result.statuses).toHaveLength(1);
    });

    it('extracts the wamid as channelMessageId', () => {
      expect(result.statuses[0]?.channelMessageId).toBe(
        'wamid.HBgLMTU1NTU1NTAxMDAVAgARGBJTRU5UMDAwMDAwMDAwMDAwMDAwMQA'
      );
    });

    it('maps status="sent" verbatim', () => {
      expect(result.statuses[0]?.status).toBe('sent');
    });

    it('normalizes the WhatsApp seconds timestamp to milliseconds', () => {
      expect(result.statuses[0]?.timestamp).toBe(1779222147 * 1000);
    });

    it('uses phone_number_id as the business id (not the WABA entry.id)', () => {
      expect(result.statuses[0]?.channelScopedBusinessId).toBe('200000000000001');
    });

    it('uses recipient_id as the user id', () => {
      expect(result.statuses[0]?.channelScopedUserId).toBe('15555550100');
    });

    it('preserves the PMP pricing block on the raw field for downstream window tracking (Stage 4)', () => {
      const raw = result.statuses[0]?.raw as { pricing?: { pricing_model?: string } } | undefined;
      expect(raw?.pricing?.pricing_model).toBe('PMP');
    });
  });

  describe('inbound-text', () => {
    const payload = loadFixture('whatsapp', 'inbound-text');
    const result = parseWhatsAppWebhook(payload);

    it('emits one IncomingMessage, no statuses', () => {
      expect(result.messages).toHaveLength(1);
      expect(result.statuses).toHaveLength(0);
    });

    it('classifies as type="text"', () => {
      expect(result.messages[0]?.type).toBe('text');
    });

    it('extracts the text body', () => {
      expect(result.messages[0]?.text).toBe('hello there');
    });

    it('uses wa_id as the user id (NOT the US.* user_id field)', () => {
      // contacts[].user_id is a separate identifier Meta added; the parser keys
      // on `from` / `wa_id` which is the public phone-scoped id. The US.* id
      // is preserved on the raw block for downstream code that wants it.
      expect(result.messages[0]?.channelScopedUserId).toBe('15555550100');
    });

    it('normalizes the seconds timestamp to ms', () => {
      expect(result.messages[0]?.timestamp).toBe(1779222193 * 1000);
    });
  });

  describe('inbound-reaction', () => {
    const payload = loadFixture('whatsapp', 'inbound-reaction');
    const result = parseWhatsAppWebhook(payload);

    it('classifies as type="reaction"', () => {
      expect(result.messages[0]?.type).toBe('reaction');
    });

    it('extracts emoji and targetMessageId', () => {
      expect(result.messages[0]?.reaction?.emoji).toBe('😮');
      expect(result.messages[0]?.reaction?.targetMessageId).toBe(
        'wamid.HBgLMTU1NTU1NTAxMDAVAgARGBJTRU5UMDAwMDAwMDAwMDAwMDAwMQA'
      );
    });

    it('reaction targets the same wamid as the outbound-status-sent fixture (verifies fixture coherence)', () => {
      const outbound = parseWhatsAppWebhook(loadFixture('whatsapp', 'outbound-status-sent'));
      expect(result.messages[0]?.reaction?.targetMessageId).toBe(
        outbound.statuses[0]?.channelMessageId
      );
    });
  });
});

describe('parseMessengerWebhook against real captured payloads', () => {
  describe('inbound-text', () => {
    const payload = loadFixture('messenger', 'inbound-text');
    const result = parseMessengerWebhook(payload);

    it('emits one IncomingMessage, no statuses', () => {
      expect(result.messages).toHaveLength(1);
      expect(result.statuses).toHaveLength(0);
    });

    it('classifies as type="text" and extracts the body', () => {
      expect(result.messages[0]?.type).toBe('text');
      expect(result.messages[0]?.text).toBe('hey hey');
    });

    it('uses sender.id (PSID) as the user id and recipient.id (page) as the business id', () => {
      expect(result.messages[0]?.channelScopedUserId).toBe('9000000000000001');
      expect(result.messages[0]?.channelScopedBusinessId).toBe('100000000000002');
    });

    it('keeps the millisecond timestamp as-is (Messenger sends ms, unlike WhatsApp)', () => {
      expect(result.messages[0]?.timestamp).toBe(1779231788118);
    });

    it('uses the mid verbatim as channelMessageId', () => {
      expect(result.messages[0]?.channelMessageId).toBe(
        'm_TESTinboundMid00000000000000000000000000000000000000000001'
      );
    });
  });

  describe('inbound-reaction', () => {
    const payload = loadFixture('messenger', 'inbound-reaction');
    const result = parseMessengerWebhook(payload);

    it('classifies as type="reaction"', () => {
      expect(result.messages[0]?.type).toBe('reaction');
    });

    it('extracts emoji, action, and the target mid', () => {
      expect(result.messages[0]?.reaction?.emoji).toBe('😆');
      expect(result.messages[0]?.reaction?.action).toBe('react');
      expect(result.messages[0]?.reaction?.targetMessageId).toBe(
        'm_TESToutboundMid0000000000000000000000000000000000000000002'
      );
    });

    it('preserves the named reaction string ("laugh") on the raw block', () => {
      // Real Messenger reaction payloads carry BOTH `emoji` (😆) and a named
      // `reaction` ("laugh") — a field our documentation-derived fixtures
      // lacked. The parser surfaces emoji/action/target as first-class fields
      // and keeps the named string on `raw` for downstream consumers.
      const raw = result.messages[0]?.raw as
        | { reaction?: { reaction?: string } }
        | undefined;
      expect(raw?.reaction?.reaction).toBe('laugh');
    });
  });
});

describe('parseInstagramWebhook against real captured payloads', () => {
  describe('inbound-text', () => {
    const payload = loadFixture('instagram', 'inbound-text');
    const result = parseInstagramWebhook(payload);

    it('emits one IncomingMessage, no statuses', () => {
      expect(result.messages).toHaveLength(1);
      expect(result.statuses).toHaveLength(0);
    });

    it('classifies as type="text" and extracts the body', () => {
      expect(result.messages[0]?.type).toBe('text');
      expect(result.messages[0]?.text).toBe('test message');
    });

    it('uses sender.id (IGSID) as the user id and recipient.id (IG business user) as the business id', () => {
      // Instagram messaging reuses the FB-style sender/recipient shape: the
      // IGSID is the inbound sender, and `recipient.id` (== `entry[].id`) is the
      // 17-digit IG business-user id — there is no page id involved.
      expect(result.messages[0]?.channelScopedUserId).toBe('9000000000000009');
      expect(result.messages[0]?.channelScopedBusinessId).toBe('17000000000000001');
    });

    it('keeps the millisecond timestamp as-is (Instagram sends ms, unlike WhatsApp)', () => {
      expect(result.messages[0]?.timestamp).toBe(1779293744461);
    });

    it('uses the IG mid verbatim as channelMessageId', () => {
      // Real IG mids are long base64-ish `aWdf…` strings; redacted here but the
      // parser passes whatever Meta sent straight through as channelMessageId.
      expect(result.messages[0]?.channelMessageId).toBe(
        'ig_TESTinboundMid0000000000000000000000000000000001'
      );
    });
  });

  describe('inbound-reaction', () => {
    const payload = loadFixture('instagram', 'inbound-reaction');
    const result = parseInstagramWebhook(payload);

    it('classifies as type="reaction"', () => {
      expect(result.messages[0]?.type).toBe('reaction');
    });

    it('extracts emoji, action, and the target mid', () => {
      expect(result.messages[0]?.reaction?.emoji).toBe('❤');
      expect(result.messages[0]?.reaction?.action).toBe('react');
      expect(result.messages[0]?.reaction?.targetMessageId).toBe(
        'ig_TESTinboundMid0000000000000000000000000000000002'
      );
    });

    it('synthesizes channelMessageId from (sender, target, action) — reactions carry no top-level mid', () => {
      expect(result.messages[0]?.channelMessageId).toBe(
        '9000000000000009-ig_TESTinboundMid0000000000000000000000000000000002-react'
      );
    });

    it('preserves the named reaction string ("other") on the raw block', () => {
      // Like Messenger, real Instagram reaction payloads carry BOTH `emoji` (❤)
      // and a named `reaction` string — here "other" — alongside `action`. Our
      // documentation-derived IG fixtures lacked this named field. The parser
      // surfaces emoji/action/target as first-class fields and leaves the named
      // string reachable on `raw` for downstream consumers.
      const raw = result.messages[0]?.raw as
        | { reaction?: { reaction?: string } }
        | undefined;
      expect(raw?.reaction?.reaction).toBe('other');
    });
  });
});
