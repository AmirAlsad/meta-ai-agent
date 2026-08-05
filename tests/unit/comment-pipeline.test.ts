/**
 * Comment pipeline tests: the `entry[].changes` parser arms (both envelope
 * shapes, modeled on real August 2026 captures), the comment chat response
 * normalizer, the CommentAgent's dispatch policy, and the Instagram poller's
 * normalization + sweep behavior.
 */
import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { parseMetaWebhook } from '../../src/meta/parser.js';
import {
  isCommentCapable,
  type IncomingComment
} from '../../src/meta/comments/types.js';
import { normalizeCommentChatResponse } from '../../src/comments/chat.js';
import { CommentAgent, type CommentChatCompleter } from '../../src/comments/agent.js';
import {
  InstagramCommentPoller,
  normalizePolledComment,
  type InstagramCommentSource
} from '../../src/comments/ig-poller.js';
import { AdapterRegistry } from '../../src/meta/shared/registry.js';
import { InMemoryConversationStore } from '../../src/conversation/store.js';
import type { ChannelAdapter, SendResult } from '../../src/meta/shared/adapter.js';
import type { Channel } from '../../src/meta/types.js';

const silentLogger = pino({ level: 'silent' });

const PAGE_ID = '111111111111111';
const IG_USER_ID = '17841400000000001';

/* ──────────────────────────────────────────────────────────────────────── */
/* Fixtures (shapes verbatim from the August 2026 live captures)            */
/* ──────────────────────────────────────────────────────────────────────── */

/** Stranger's top-level comment on a reel: parent_id == post_id. */
function fbReelCommentPayload(): unknown {
  return {
    object: 'page',
    entry: [
      {
        id: PAGE_ID,
        time: 1785904977,
        changes: [
          {
            value: {
              from: { id: '2735965996040001', name: 'Test Stranger' },
              post: {
                status_type: 'added_video',
                is_published: true,
                permalink_url: 'https://www.facebook.com/reel/1234567890/',
                id: `${PAGE_ID}_122107704489330262`
              },
              message: 'Testing',
              post_id: `${PAGE_ID}_122107704489330262`,
              comment_id: '122107704489330262_1149195374953894',
              created_time: 1785904973,
              item: 'comment',
              parent_id: `${PAGE_ID}_122107704489330262`,
              verb: 'add'
            },
            field: 'feed'
          }
        ]
      }
    ]
  };
}

/** The Page's own reply to a comment on a photo post (self-echo shape). */
function fbOwnReplyPayload(): unknown {
  return {
    object: 'page',
    entry: [
      {
        id: PAGE_ID,
        time: 1785903450,
        changes: [
          {
            value: {
              from: { id: PAGE_ID, name: 'Test Page' },
              post: {
                status_type: 'added_photos',
                is_published: true,
                permalink_url: 'https://www.facebook.com/photo.php?fbid=1',
                id: `${PAGE_ID}_122107585233330262`
              },
              message: 'Appreciate it.',
              post_id: `${PAGE_ID}_122107585233330262`,
              comment_id: '122107585233330262_1069374258878262',
              created_time: 1785903445,
              item: 'comment',
              parent_id: '122107585233330262_1239651294908193',
              verb: 'add'
            },
            field: 'feed'
          }
        ]
      }
    ]
  };
}

/** Feed noise: a reaction event (the Page liking a comment). */
function fbReactionNoisePayload(): unknown {
  return {
    object: 'page',
    entry: [
      {
        id: PAGE_ID,
        time: 1785904000,
        changes: [
          {
            value: {
              from: { id: PAGE_ID, name: 'Test Page' },
              post_id: `${PAGE_ID}_122107704489330262`,
              comment_id: '122107704489330262_1149195374953894',
              created_time: 1785903999,
              item: 'reaction',
              reaction_type: 'like',
              verb: 'add'
            },
            field: 'feed'
          }
        ]
      }
    ]
  };
}

/** IG comment webhook, `changes[]` wrapper shape. */
function igCommentChangesPayload(): unknown {
  return {
    object: 'instagram',
    entry: [
      {
        id: IG_USER_ID,
        time: 1785905000,
        changes: [
          {
            field: 'comments',
            value: {
              id: '17900000000000001',
              text: 'Love this',
              from: { id: '17841400000000099', username: 'some_viewer' },
              media: { id: '17850000000000001', media_product_type: 'REELS' }
            }
          }
        ]
      }
    ]
  };
}

/** IG comment webhook, Instagram-Login flavor: field/value directly on entry. */
function igCommentEntryLevelPayload(): unknown {
  return {
    object: 'instagram',
    entry: [
      {
        id: IG_USER_ID,
        time: 1785905000,
        field: 'comments',
        value: {
          id: '17900000000000002',
          text: 'A reply',
          parent_id: '17900000000000001',
          from: { id: '17841400000000099', username: 'some_viewer' },
          media: { id: '17850000000000001' }
        }
      }
    ]
  };
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Parser                                                                    */
/* ──────────────────────────────────────────────────────────────────────── */

describe('parser: entry[].changes comments', () => {
  it('parses a top-level FB reel comment (parent_id == post_id → not a reply)', () => {
    const result = parseMetaWebhook(fbReelCommentPayload());
    expect(result.comments).toHaveLength(1);
    const comment = result.comments![0]!;
    expect(comment.channel).toBe('messenger');
    expect(comment.channelScopedBusinessId).toBe(PAGE_ID);
    expect(comment.commentId).toBe('122107704489330262_1149195374953894');
    expect(comment.postId).toBe(`${PAGE_ID}_122107704489330262`);
    expect(comment.text).toBe('Testing');
    expect(comment.from).toEqual({ id: '2735965996040001', name: 'Test Stranger' });
    expect(comment.isReply).toBe(false);
    expect(comment.verb).toBe('add');
    // created_time arrives in SECONDS and must be upscaled.
    expect(comment.timestamp).toBe(1785904973 * 1000);
    expect(comment.permalinkUrl).toBe('https://www.facebook.com/reel/1234567890/');
    // Messaging surfaces untouched.
    expect(result.messages).toHaveLength(0);
  });

  it("parses the Page's own reply and classifies it as a reply (photo-post id scheme)", () => {
    const result = parseMetaWebhook(fbOwnReplyPayload());
    expect(result.comments).toHaveLength(1);
    const comment = result.comments![0]!;
    expect(comment.from?.id).toBe(PAGE_ID);
    // parent_id shares neither the post_id nor its final segment → a reply.
    expect(comment.isReply).toBe(true);
  });

  it('drops non-comment feed items (reactions, publishes, edits)', () => {
    const result = parseMetaWebhook(fbReactionNoisePayload());
    expect(result.comments).toHaveLength(0);
  });

  it('parses an IG comment in the changes[] wrapper shape', () => {
    const result = parseMetaWebhook(igCommentChangesPayload());
    expect(result.comments).toHaveLength(1);
    const comment = result.comments![0]!;
    expect(comment.channel).toBe('instagram');
    expect(comment.channelScopedBusinessId).toBe(IG_USER_ID);
    expect(comment.commentId).toBe('17900000000000001');
    expect(comment.postId).toBe('17850000000000001');
    expect(comment.from).toEqual({ id: '17841400000000099', name: 'some_viewer' });
    expect(comment.mediaProductType).toBe('REELS');
    expect(comment.isReply).toBeUndefined();
    expect(comment.verb).toBe('add');
  });

  it('parses the entry-level field/value IG shape and flags parent_id as a reply', () => {
    const result = parseMetaWebhook(igCommentEntryLevelPayload());
    expect(result.comments).toHaveLength(1);
    const comment = result.comments![0]!;
    expect(comment.commentId).toBe('17900000000000002');
    expect(comment.parentId).toBe('17900000000000001');
    expect(comment.isReply).toBe(true);
  });

  it('dedupes identical comment blocks within one payload', () => {
    const payload = fbReelCommentPayload() as { entry: unknown[] };
    payload.entry.push((fbReelCommentPayload() as { entry: unknown[] }).entry[0]);
    const result = parseMetaWebhook(payload);
    expect(result.comments).toHaveLength(1);
  });

  it('WhatsApp payloads carry no comments field', () => {
    const result = parseMetaWebhook({ object: 'whatsapp_business_account', entry: [] });
    expect(result.comments).toBeUndefined();
  });
});

/* ──────────────────────────────────────────────────────────────────────── */
/* Response normalizer                                                       */
/* ──────────────────────────────────────────────────────────────────────── */

describe('normalizeCommentChatResponse', () => {
  it('passes valid actions through', () => {
    const result = normalizeCommentChatResponse({
      actions: [
        { type: 'reply', text: 'thanks' },
        { type: 'like' },
        { type: 'private_reply', text: 'check your DMs' }
      ]
    });
    expect(result.actions).toEqual([
      { type: 'reply', text: 'thanks' },
      { type: 'like' },
      { type: 'private_reply', text: 'check your DMs' }
    ]);
    expect(result.silence).toBeUndefined();
  });

  it('treats a legacy bare message as one public reply', () => {
    expect(normalizeCommentChatResponse({ message: 'appreciate it' }).actions).toEqual([
      { type: 'reply', text: 'appreciate it' }
    ]);
  });

  it('empty response and explicit silence both normalize to silence', () => {
    expect(normalizeCommentChatResponse({}).silence).toBe(true);
    expect(normalizeCommentChatResponse({ silence: true }).silence).toBe(true);
    expect(normalizeCommentChatResponse({ actions: [{ type: 'silence' }] }).silence).toBe(true);
  });

  it('silence:true beside real actions drops the actions with a warning', () => {
    const result = normalizeCommentChatResponse({
      silence: true,
      actions: [{ type: 'reply', text: 'hi' }]
    });
    expect(result.actions).toEqual([]);
    expect(result.silence).toBe(true);
    expect(result.warnings?.some(w => w.includes('silence'))).toBe(true);
  });

  it('warns on malformed and unknown actions without throwing', () => {
    const result = normalizeCommentChatResponse({
      actions: [{ type: 'reply' }, { type: 'dance' }, { type: 'like' }]
    });
    expect(result.actions).toEqual([{ type: 'like' }]);
    expect(result.warnings).toHaveLength(2);
  });
});

/* ──────────────────────────────────────────────────────────────────────── */
/* CommentAgent                                                              */
/* ──────────────────────────────────────────────────────────────────────── */

interface FakeCommentClient extends ChannelAdapter {
  replyToComment: ReturnType<typeof vi.fn>;
  sendCommentPrivateReply: ReturnType<typeof vi.fn>;
  deleteComment: ReturnType<typeof vi.fn>;
  likeComment?: ReturnType<typeof vi.fn>;
}

function fakeCommentClient(channel: Channel, opts: { withLike: boolean }): FakeCommentClient {
  const sendResult = (recipientId: string): SendResult => ({
    channel,
    messageId: 'm1',
    recipientId,
    timestamp: 0
  });
  const client: FakeCommentClient = {
    channel,
    supports: () => false,
    sendText: vi.fn(async (recipientId: string) => sendResult(recipientId)),
    sendTypingIndicator: vi.fn(async () => undefined),
    markRead: vi.fn(async () => undefined),
    sendReaction: vi.fn(async () => undefined),
    sendMedia: vi.fn(async (recipientId: string) => sendResult(recipientId)),
    replyToComment: vi.fn(async () => ({ id: 'reply-1' })),
    sendCommentPrivateReply: vi.fn(async () => ({})),
    deleteComment: vi.fn(async () => undefined)
  };
  if (opts.withLike) client.likeComment = vi.fn(async () => undefined);
  return client;
}

function makeComment(overrides: Partial<IncomingComment> = {}): IncomingComment {
  return {
    channel: 'messenger',
    channelScopedBusinessId: PAGE_ID,
    commentId: `c-${Math.random().toString(36).slice(2)}`,
    postId: `${PAGE_ID}_1`,
    text: 'nice one',
    from: { id: 'stranger-1', name: 'Stranger' },
    timestamp: 1785904973000,
    verb: 'add',
    raw: {},
    ...overrides
  };
}

function makeAgentHarness(opts: {
  responses?: unknown[];
  igToo?: boolean;
}): {
  agent: CommentAgent;
  fb: FakeCommentClient;
  ig: FakeCommentClient;
  chatCalls: unknown[];
  registry: AdapterRegistry;
} {
  const registry = new AdapterRegistry();
  const fb = fakeCommentClient('messenger', { withLike: true });
  const ig = fakeCommentClient('instagram', { withLike: false });
  registry.register({ channel: 'messenger', accountName: 'official', businessId: PAGE_ID, adapter: fb });
  registry.register({ channel: 'instagram', accountName: 'reed', businessId: IG_USER_ID, adapter: ig });
  const chatCalls: unknown[] = [];
  const responses = opts.responses ?? [{ actions: [{ type: 'reply', text: 'thanks' }] }];
  let i = 0;
  const chatClient: CommentChatCompleter = {
    complete: async request => {
      chatCalls.push(request);
      const raw = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return normalizeCommentChatResponse(raw);
    }
  };
  const agent = new CommentAgent({
    store: new InMemoryConversationStore({ dedupeTtlSeconds: 60 }),
    adapters: registry,
    chatClient,
    logger: silentLogger
  });
  return { agent, fb, ig, chatCalls, registry };
}

describe('CommentAgent', () => {
  it('replies to a stranger comment through the owning account', async () => {
    const h = makeAgentHarness({});
    const comment = makeComment();
    expect(await h.agent.handleComment(comment)).toBe('handled');
    expect(h.fb.replyToComment).toHaveBeenCalledWith(comment.commentId, 'thanks');
    expect(h.chatCalls).toHaveLength(1);
    const request = h.chatCalls[0] as { accountName: string; capabilities: string[]; kind: string };
    expect(request.kind).toBe('comment');
    expect(request.accountName).toBe('official');
    expect(request.capabilities).toContain('like');
  });

  it('skips non-add verbs without a chat call', async () => {
    const h = makeAgentHarness({});
    expect(await h.agent.handleComment(makeComment({ verb: 'edited' }))).toBe('skipped_verb');
    expect(h.chatCalls).toHaveLength(0);
  });

  it("skips the account's own comment echoes (allowlist-of-self)", async () => {
    const h = makeAgentHarness({});
    const own = makeComment({ from: { id: PAGE_ID, name: 'Test Page' } });
    expect(await h.agent.handleComment(own)).toBe('skipped_self');
    expect(h.chatCalls).toHaveLength(0);
  });

  it('skips comments authored by ANY configured account (cross-account engagement)', async () => {
    const h = makeAgentHarness({});
    // reed's IG id commenting on the official Page's post — never engage.
    const crossAccount = makeComment({ from: { id: IG_USER_ID, name: 'reed' } });
    expect(await h.agent.handleComment(crossAccount)).toBe('skipped_self');
  });

  it('drops comments for an unclaimed business id on a multi-account channel', async () => {
    const h = makeAgentHarness({});
    // A second messenger account makes the channel genuinely multi-account, so
    // the registry's single-account fallback does not apply and an unclaimed
    // id must drop. (On a single-account channel the fallback answers for any
    // id — benign for comments, since webhooks only deliver for subscribed
    // assets, so entry.id is always a configured account's.)
    h.registry.register({
      channel: 'messenger',
      accountName: 'second',
      businessId: 'page-second',
      adapter: fakeCommentClient('messenger', { withLike: true })
    });
    expect(
      await h.agent.handleComment(makeComment({ channelScopedBusinessId: 'some-other-page' }))
    ).toBe('no_account');
    expect(h.chatCalls).toHaveLength(0);
  });

  it('dedupes redeliveries of the same comment', async () => {
    const h = makeAgentHarness({});
    const comment = makeComment();
    expect(await h.agent.handleComment(comment)).toBe('handled');
    expect(await h.agent.handleComment(comment)).toBe('skipped_duplicate');
    expect(h.fb.replyToComment).toHaveBeenCalledTimes(1);
  });

  it('silence executes nothing', async () => {
    const h = makeAgentHarness({ responses: [{ silence: true }] });
    expect(await h.agent.handleComment(makeComment())).toBe('silence');
    expect(h.fb.replyToComment).not.toHaveBeenCalled();
    expect(h.fb.likeComment).not.toHaveBeenCalled();
  });

  it('executes like and private_reply on Facebook', async () => {
    const h = makeAgentHarness({
      responses: [{ actions: [{ type: 'like' }, { type: 'private_reply', text: 'sent you a DM' }] }]
    });
    const comment = makeComment();
    expect(await h.agent.handleComment(comment)).toBe('handled');
    expect(h.fb.likeComment).toHaveBeenCalledWith(comment.commentId);
    expect(h.fb.sendCommentPrivateReply).toHaveBeenCalledWith(comment.commentId, 'sent you a DM');
  });

  it('IG capabilities exclude like, and a like action is skipped without erroring', async () => {
    const h = makeAgentHarness({
      responses: [{ actions: [{ type: 'like' }, { type: 'reply', text: 'ok' }] }]
    });
    const igComment = makeComment({
      channel: 'instagram',
      channelScopedBusinessId: IG_USER_ID
    });
    expect(await h.agent.handleComment(igComment)).toBe('handled');
    const request = h.chatCalls[0] as { capabilities: string[] };
    expect(request.capabilities).not.toContain('like');
    expect(h.ig.replyToComment).toHaveBeenCalledWith(igComment.commentId, 'ok');
  });

  it('a failing action does not sink the remaining actions', async () => {
    const h = makeAgentHarness({
      responses: [{ actions: [{ type: 'reply', text: 'a' }, { type: 'like' }] }]
    });
    h.fb.replyToComment.mockRejectedValueOnce(new Error('boom'));
    expect(await h.agent.handleComment(makeComment())).toBe('handled');
    expect(h.fb.likeComment).toHaveBeenCalledTimes(1);
  });
});

/* ──────────────────────────────────────────────────────────────────────── */
/* Instagram poller                                                          */
/* ──────────────────────────────────────────────────────────────────────── */

describe('normalizePolledComment', () => {
  it('normalizes a polled record with from/timestamp/parent_id', () => {
    const comment = normalizePolledComment(
      {
        id: '17900000000000009',
        text: 'polled',
        from: { id: 'viewer-9', username: 'viewer_nine' },
        timestamp: '2026-08-05T04:42:53+0000',
        parent_id: '17900000000000001'
      },
      IG_USER_ID,
      'media-1'
    );
    expect(comment).toMatchObject({
      channel: 'instagram',
      channelScopedBusinessId: IG_USER_ID,
      commentId: '17900000000000009',
      postId: 'media-1',
      text: 'polled',
      from: { id: 'viewer-9', name: 'viewer_nine' },
      parentId: '17900000000000001',
      isReply: true,
      verb: 'add'
    });
    expect(comment!.timestamp).toBe(Date.parse('2026-08-05T04:42:53+0000'));
  });

  it('returns undefined without an id', () => {
    expect(normalizePolledComment({ text: 'x' }, IG_USER_ID, 'media-1')).toBeUndefined();
  });
});

describe('InstagramCommentPoller', () => {
  function makePollerHarness(mediaTimestamp: string): {
    poller: InstagramCommentPoller;
    handled: IncomingComment[];
    source: InstagramCommentSource & {
      listRecentMedia: ReturnType<typeof vi.fn>;
      listMediaComments: ReturnType<typeof vi.fn>;
    };
  } {
    const handled: IncomingComment[] = [];
    const source = {
      listRecentMedia: vi.fn(async () => [{ id: 'media-1', timestamp: mediaTimestamp }]),
      listMediaComments: vi.fn(async () => [
        { id: 'c-1', text: 'first', from: { id: 'viewer-1', username: 'v1' }, timestamp: '2026-08-05T04:42:53+0000' }
      ])
    };
    const commentAgent = {
      handleComment: vi.fn(async (comment: IncomingComment) => {
        handled.push(comment);
        return 'handled' as const;
      })
    };
    const poller = new InstagramCommentPoller({
      accounts: [{ account: { accountName: 'reed', userId: IG_USER_ID }, client: source }],
      commentAgent: commentAgent as unknown as CommentAgent,
      logger: silentLogger,
      intervalMs: 60_000,
      lookbackMs: 72 * 3_600_000,
      mediaLimit: 10,
      now: () => Date.parse('2026-08-05T12:00:00Z'),
      sleep: async () => undefined
    });
    return { poller, handled, source };
  }

  it('sweeps recent media and routes polled comments into the agent', async () => {
    const h = makePollerHarness('2026-08-05T04:00:00+0000');
    await h.poller.runSweep();
    expect(h.source.listRecentMedia).toHaveBeenCalledTimes(1);
    expect(h.source.listMediaComments).toHaveBeenCalledWith('media-1');
    expect(h.handled).toHaveLength(1);
    expect(h.handled[0]).toMatchObject({ commentId: 'c-1', channel: 'instagram' });
  });

  it('skips media older than the lookback window', async () => {
    const h = makePollerHarness('2026-07-01T00:00:00+0000');
    await h.poller.runSweep();
    expect(h.source.listMediaComments).not.toHaveBeenCalled();
    expect(h.handled).toHaveLength(0);
  });
});

/* ──────────────────────────────────────────────────────────────────────── */
/* isCommentCapable                                                          */
/* ──────────────────────────────────────────────────────────────────────── */

describe('isCommentCapable', () => {
  it('accepts the fake clients and rejects a bare adapter', () => {
    expect(isCommentCapable(fakeCommentClient('messenger', { withLike: true }))).toBe(true);
    expect(
      isCommentCapable({
        channel: 'whatsapp',
        supports: () => false,
        sendText: async () => ({}) as SendResult
      })
    ).toBe(false);
  });
});
