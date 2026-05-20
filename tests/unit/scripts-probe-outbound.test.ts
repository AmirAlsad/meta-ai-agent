/**
 * Unit tests for the PURE helpers in scripts/setup/probe-outbound.ts.
 *
 * The probe itself is inherently manual (real Meta API, real test devices), so
 * we focus on the boring-but-load-bearing pieces that have no side effects:
 *   - parseProbeArgs: every flag + invalid input.
 *   - planChannelOperations: op names, order, and the WhatsApp typing/markRead
 *     skip semantics that hinge on `hasTarget`.
 *   - makeCapturingFetch: records the request and returns the per-channel fake
 *     response shape WITHOUT touching the network.
 *
 * Importing the module is side-effect-free for tests: `main()` only runs when
 * the file is invoked directly as a script (it isn't, under vitest).
 */
import { describe, expect, it } from 'vitest';
import {
  parseProbeArgs,
  planChannelOperations,
  makeCapturingFetch,
  pickUsableInbound,
  redactId,
  remainingTargets,
  type CapturedRequest,
  type UsableInboundInput
} from '../../scripts/setup/probe-outbound.js';
import type { Channel } from '../../src/meta/types.js';

/* ────────────────────────────────────────────────────────────────────────── */
/* parseProbeArgs                                                              */
/* ────────────────────────────────────────────────────────────────────────── */

describe('parseProbeArgs', () => {
  it('defaults: no channels filter, not dry-run, not yes, text has a value', () => {
    const args = parseProbeArgs([]);
    expect(args.only).toEqual([]);
    expect(args.dryRun).toBe(false);
    expect(args.yes).toBe(false);
    expect(args.help).toBe(false);
    expect(args.waTarget).toBeUndefined();
    expect(args.fbTarget).toBeUndefined();
    expect(args.igTarget).toBeUndefined();
    expect(args.text.length).toBeGreaterThan(0);
  });

  it('--only filters and de-duplicates without reordering', () => {
    expect(parseProbeArgs(['--only=whatsapp,messenger']).only).toEqual(['whatsapp', 'messenger']);
    expect(parseProbeArgs(['--only=instagram,instagram']).only).toEqual(['instagram']);
  });

  it('--only rejects an unknown channel and an empty value', () => {
    expect(() => parseProbeArgs(['--only=tiktok'])).toThrow(/unknown channel/i);
    expect(() => parseProbeArgs(['--only='])).toThrow(/requires at least one channel/i);
  });

  it('captures the three --*-target flags', () => {
    const args = parseProbeArgs([
      '--wa-target=wamid.ABC',
      '--fb-target=m_FB',
      '--ig-target=mid.IG'
    ]);
    expect(args.waTarget).toBe('wamid.ABC');
    expect(args.fbTarget).toBe('m_FB');
    expect(args.igTarget).toBe('mid.IG');
  });

  it('a --*-target flag with no value throws', () => {
    expect(() => parseProbeArgs(['--wa-target='])).toThrow(/requires a value/i);
  });

  it('--text overrides the default and may contain spaces', () => {
    expect(parseProbeArgs(['--text=hello there probe']).text).toBe('hello there probe');
  });

  it('--text with an empty value throws', () => {
    expect(() => parseProbeArgs(['--text='])).toThrow(/non-empty/i);
  });

  it('--dry-run, --yes/-y, and --help/-h set their flags', () => {
    expect(parseProbeArgs(['--dry-run']).dryRun).toBe(true);
    expect(parseProbeArgs(['--yes']).yes).toBe(true);
    expect(parseProbeArgs(['-y']).yes).toBe(true);
    expect(parseProbeArgs(['--help']).help).toBe(true);
    expect(parseProbeArgs(['-h']).help).toBe(true);
  });

  it('defaults capture and acceptInvalidSignatures to false', () => {
    const args = parseProbeArgs([]);
    expect(args.capture).toBe(false);
    expect(args.acceptInvalidSignatures).toBe(false);
  });

  it('--capture sets the capture flag', () => {
    expect(parseProbeArgs(['--capture']).capture).toBe(true);
  });

  it('--accept-invalid-signatures sets its flag', () => {
    expect(parseProbeArgs(['--accept-invalid-signatures']).acceptInvalidSignatures).toBe(true);
  });

  it('--capture composes with --only, --yes, --dry-run, --accept-invalid-signatures', () => {
    const args = parseProbeArgs([
      '--capture',
      '--only=whatsapp,instagram',
      '--yes',
      '--dry-run',
      '--accept-invalid-signatures'
    ]);
    expect(args.capture).toBe(true);
    expect(args.only).toEqual(['whatsapp', 'instagram']);
    expect(args.yes).toBe(true);
    expect(args.dryRun).toBe(true);
    expect(args.acceptInvalidSignatures).toBe(true);
  });

  it('rejects an unknown flag', () => {
    expect(() => parseProbeArgs(['--nope'])).toThrow(/unknown flag/i);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* planChannelOperations                                                      */
/* ────────────────────────────────────────────────────────────────────────── */

/** Pull just the operation names (order-preserving) for plan assertions. */
function names(plan: ReturnType<typeof planChannelOperations>): string[] {
  return plan.map((op) => op.name);
}
/** Names of operations the plan pre-skips (op.skip set). */
function skipped(plan: ReturnType<typeof planChannelOperations>): string[] {
  return plan.filter((op) => op.skip !== undefined).map((op) => op.name);
}

describe('planChannelOperations: whatsapp', () => {
  it('runs sendTemplate(hello_world) FIRST (the window-independent baseline)', () => {
    const plan = planChannelOperations('whatsapp', { hasTarget: false });
    expect(plan[0]?.name).toBe('sendTemplate(hello_world)');
  });

  it('SKIPS typing + markRead when hasTarget is false, with the inbound-wamid reason', () => {
    const plan = planChannelOperations('whatsapp', { hasTarget: false });
    expect(skipped(plan)).toEqual(['sendTypingIndicator', 'markRead']);
    const typing = plan.find((op) => op.name === 'sendTypingIndicator');
    expect(typing?.skip).toMatch(/--wa-target=<inbound wamid/);
  });

  it('INCLUDES typing + markRead (not skipped) when hasTarget is true', () => {
    const plan = planChannelOperations('whatsapp', { hasTarget: true, target: 'wamid.IN' });
    expect(skipped(plan)).toEqual([]);
    expect(names(plan)).toEqual([
      'sendTemplate(hello_world)',
      'sendText',
      'sendText(reply)',
      'sendReaction',
      'sendTypingIndicator',
      'markRead'
    ]);
  });
});

describe('planChannelOperations: messenger & instagram', () => {
  it('messenger plans the five ops in order with none pre-skipped', () => {
    const plan = planChannelOperations('messenger', { hasTarget: false });
    expect(names(plan)).toEqual(['sendText', 'sendTypingOn', 'markSeen', 'sendText(reply)', 'sendReaction']);
    expect(skipped(plan)).toEqual([]);
  });

  it('instagram plans the same five ops, independent of hasTarget', () => {
    const noTarget = planChannelOperations('instagram', { hasTarget: false });
    const withTarget = planChannelOperations('instagram', { hasTarget: true, target: 'mid.IG' });
    expect(names(noTarget)).toEqual(['sendText', 'sendTypingOn', 'markSeen', 'sendText(reply)', 'sendReaction']);
    expect(names(withTarget)).toEqual(names(noTarget));
    expect(skipped(withTarget)).toEqual([]);
  });

  it('the dependent ops (reply / reaction) are present and run-eligible at plan time', () => {
    // The planner lists reply/reaction as runnable; the EXECUTOR downgrades them
    // to skipped only at runtime if the prior sendText failed and no explicit
    // target was given. So at plan time they must NOT be pre-skipped.
    const plan = planChannelOperations('messenger', { hasTarget: false });
    expect(plan.find((op) => op.name === 'sendText(reply)')?.skip).toBeUndefined();
    expect(plan.find((op) => op.name === 'sendReaction')?.skip).toBeUndefined();
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* makeCapturingFetch (dry-run shape helper)                                  */
/* ────────────────────────────────────────────────────────────────────────── */

describe('makeCapturingFetch', () => {
  it('records the request (url/method/body) and redacts the authorization header', async () => {
    const sink: CapturedRequest[] = [];
    const fetchImpl = makeCapturingFetch(sink);
    await fetchImpl('https://graph.facebook.com/v25.0/PHONE/messages', {
      method: 'POST',
      headers: { authorization: 'Bearer super-secret-token', 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: '15551234567', type: 'text' })
    });
    expect(sink).toHaveLength(1);
    expect(sink[0]?.method).toBe('POST');
    expect(sink[0]?.url).toContain('/messages');
    expect(sink[0]?.headers['authorization']).toBe('Bearer <redacted>');
    expect((sink[0]?.body as { to?: string }).to).toBe('15551234567');
  });

  it('returns the WhatsApp fake shape ({ messages:[{id}] }) for whatsapp bodies', async () => {
    const sink: CapturedRequest[] = [];
    const fetchImpl = makeCapturingFetch(sink);
    const res = await fetchImpl('https://graph.facebook.com/v25.0/PHONE/messages', {
      method: 'POST',
      headers: { authorization: 'Bearer x' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: '15550000000' })
    });
    const json = (await res.json()) as { messages?: Array<{ id?: string }> };
    expect(res.status).toBe(200);
    expect(json.messages?.[0]?.id).toBe('wamid.DRYRUN');
  });

  it('returns the Send-API fake shape ({ message_id, recipient_id }) for messenger/instagram bodies', async () => {
    const sink: CapturedRequest[] = [];
    const fetchImpl = makeCapturingFetch(sink);
    const res = await fetchImpl('https://graph.instagram.com/v25.0/IGID/messages', {
      method: 'POST',
      headers: { authorization: 'Bearer x' },
      body: JSON.stringify({ recipient: { id: 'IGSID_123' }, message: { text: 'hi' } })
    });
    const json = (await res.json()) as { message_id?: string; recipient_id?: string };
    expect(json.message_id).toBe('m_DRYRUN');
    // The recipient is echoed back from recipient.id so the fake is plausible.
    expect(json.recipient_id).toBe('IGSID_123');
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* pickUsableInbound (capture-mode predicate + id extraction)                 */
/* ────────────────────────────────────────────────────────────────────────── */

/** Build a minimal CapturedWebhook-shaped object from a list of messages. */
function cap(
  messages: Array<{
    channel: Channel;
    channelScopedUserId?: string;
    channelMessageId?: string;
    type?: string;
    isEcho?: boolean;
  }>
): UsableInboundInput {
  return { parsed: { messages } };
}

describe('pickUsableInbound', () => {
  it('picks a non-echo message with both ids and extracts recipient + target', () => {
    const got = pickUsableInbound(
      cap([{ channel: 'whatsapp', channelScopedUserId: '15551230000', channelMessageId: 'wamid.IN', type: 'text' }]),
      ['whatsapp']
    );
    expect(got).toEqual({ channel: 'whatsapp', recipientId: '15551230000', targetMessageId: 'wamid.IN' });
  });

  it('skips echoes (our own outbound) even when both ids are present', () => {
    const got = pickUsableInbound(
      cap([
        { channel: 'messenger', channelScopedUserId: 'PSID_1', channelMessageId: 'm_echo', type: 'text', isEcho: true }
      ]),
      ['messenger']
    );
    expect(got).toBeUndefined();
  });

  it('skips messages missing the user id or the message id', () => {
    const noUser = pickUsableInbound(
      cap([{ channel: 'instagram', channelMessageId: 'mid.IG', type: 'text' }]),
      ['instagram']
    );
    const noMsg = pickUsableInbound(
      cap([{ channel: 'instagram', channelScopedUserId: 'IGSID_1', type: 'text' }]),
      ['instagram']
    );
    const emptyUser = pickUsableInbound(
      cap([{ channel: 'instagram', channelScopedUserId: '   ', channelMessageId: 'mid.IG', type: 'text' }]),
      ['instagram']
    );
    expect(noUser).toBeUndefined();
    expect(noMsg).toBeUndefined();
    expect(emptyUser).toBeUndefined();
  });

  it('skips messages whose channel is not in the target set', () => {
    const got = pickUsableInbound(
      cap([{ channel: 'messenger', channelScopedUserId: 'PSID_1', channelMessageId: 'm_1', type: 'text' }]),
      ['whatsapp', 'instagram']
    );
    expect(got).toBeUndefined();
  });

  it('prefers a text message over a non-text one in the same delivery', () => {
    const got = pickUsableInbound(
      cap([
        { channel: 'whatsapp', channelScopedUserId: 'U', channelMessageId: 'wamid.REACT', type: 'reaction' },
        { channel: 'whatsapp', channelScopedUserId: 'U', channelMessageId: 'wamid.TEXT', type: 'text' }
      ]),
      ['whatsapp']
    );
    expect(got?.targetMessageId).toBe('wamid.TEXT');
  });

  it('accepts a non-text message when no text message is present', () => {
    const got = pickUsableInbound(
      cap([{ channel: 'whatsapp', channelScopedUserId: 'U', channelMessageId: 'wamid.IMG', type: 'image' }]),
      ['whatsapp']
    );
    expect(got).toEqual({ channel: 'whatsapp', recipientId: 'U', targetMessageId: 'wamid.IMG' });
  });

  it('returns the first usable message for a target when several channels are present', () => {
    const got = pickUsableInbound(
      cap([
        { channel: 'messenger', channelScopedUserId: 'PSID', channelMessageId: 'm_1', type: 'text' },
        { channel: 'whatsapp', channelScopedUserId: 'WA', channelMessageId: 'wamid.1', type: 'text' }
      ]),
      ['whatsapp', 'messenger']
    );
    // messenger comes first in the messages array, so it wins for this delivery.
    expect(got).toEqual({ channel: 'messenger', recipientId: 'PSID', targetMessageId: 'm_1' });
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* redactId                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

describe('redactId', () => {
  it('keeps only the last 4 characters and tolerates short ids', () => {
    expect(redactId('15551234567')).toBe('…4567');
    expect(redactId('12')).toBe('…12');
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* remainingTargets (on-arrival capture flow: channels still owed a response)  */
/* ────────────────────────────────────────────────────────────────────────── */

describe('remainingTargets', () => {
  const all: Channel[] = ['whatsapp', 'messenger', 'instagram'];

  it('returns all targets when none are handled yet', () => {
    expect(remainingTargets(all, new Set())).toEqual(['whatsapp', 'messenger', 'instagram']);
  });

  it('drops handled channels while preserving the original target order', () => {
    expect(remainingTargets(all, new Set<Channel>(['messenger']))).toEqual(['whatsapp', 'instagram']);
    // Order follows `targets`, not the handled-set insertion order.
    expect(remainingTargets(all, new Set<Channel>(['instagram', 'whatsapp']))).toEqual(['messenger']);
  });

  it('returns an empty array once every target is handled (completion signal)', () => {
    expect(remainingTargets(all, new Set<Channel>(['whatsapp', 'messenger', 'instagram']))).toEqual([]);
  });

  it('ignores handled channels that are not in the target set', () => {
    // A handled channel outside `targets` (e.g. --only filtered it out) must not
    // affect the remaining computation.
    expect(remainingTargets(['whatsapp'], new Set<Channel>(['messenger']))).toEqual(['whatsapp']);
  });

  it('does not mutate the inputs', () => {
    const targets: Channel[] = ['whatsapp', 'messenger'];
    const handled = new Set<Channel>(['whatsapp']);
    remainingTargets(targets, handled);
    expect(targets).toEqual(['whatsapp', 'messenger']);
    expect([...handled]).toEqual(['whatsapp']);
  });
});
