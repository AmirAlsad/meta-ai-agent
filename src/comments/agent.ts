/**
 * CommentAgent — inbound comment handling, separate from the ConversationAgent.
 *
 * WHY a separate agent: comments share none of the DM machinery's premises.
 * There is no 24h messaging window, no delivery-status callbacks, no
 * burst-buffering (one comment = one event), and no per-user conversation —
 * one post fans out to arbitrarily many authors. What IS reused is the
 * generic infrastructure: the ConversationStore's SETNX dedupe (webhook
 * redeliveries AND the webhook/poller overlap collapse onto one claim), the
 * AdapterRegistry (the same per-account clients hold the tokens the comment
 * endpoints need), and the LimitTracker's per-(channel, businessId) pacing.
 *
 * Dispatch policy, in order:
 *  1. Verb filter — only `add` reaches the endpoint. Edits/removes are logged.
 *  2. Self filter — a comment whose author id matches ANY registered
 *     account's business id is ours (both platforms echo the account's own
 *     comments back with no is_echo flag; measured ~1s on FB). Allowlist-of-
 *     self, never heuristics. This also hard-stops configured accounts from
 *     ever engaging each other's comments.
 *  3. Account resolution — the registry entry for (channel, businessId); a
 *     comment for an unclaimed asset is dropped with a warning.
 *  4. Dedupe — `store.claimInboundHandle('comment:' + commentId)`; the
 *     webhook path and the IG poller race benignly on this.
 *  5. Chat call — POST the `kind: 'comment'` request; the endpoint's normal
 *     answer is silence (selective engagement, not full coverage).
 *  6. Actions — executed through the account's own client, paced through the
 *     limit tracker; every step fail-soft.
 */

import type pino from 'pino';
import type { ConversationStore } from '../conversation/store.js';
import type { AdapterRegistry } from '../meta/shared/registry.js';
import type { LimitTracker } from '../limits/tracker.js';
import {
  isCommentCapable,
  type CommentCapability,
  type CommentChatRequest,
  type IncomingComment
} from '../meta/comments/types.js';
import type { NormalizedCommentChatResponse } from '../meta/comments/types.js';

/**
 * The slice of {@link import('./chat.js').CommentChatClient} the agent needs.
 * An interface (not the class) so tests and embedders can inject any
 * completer without carrying the HTTP client's private fields.
 */
export interface CommentChatCompleter {
  complete(request: CommentChatRequest): Promise<NormalizedCommentChatResponse>;
}

export interface CommentAgentDeps {
  store: ConversationStore;
  adapters: AdapterRegistry;
  chatClient: CommentChatCompleter;
  logger: pino.Logger;
  /** Optional pacing/counters; absent ⇒ sends are not paced (tests). */
  limitTracker?: LimitTracker;
}

/** Outcome of one {@link CommentAgent.handleComment} call, for tests/metrics. */
export type CommentHandleResult =
  | 'handled'
  | 'silence'
  | 'skipped_verb'
  | 'skipped_self'
  | 'skipped_duplicate'
  | 'no_account'
  | 'error';

export class CommentAgent {
  private readonly store: ConversationStore;
  private readonly adapters: AdapterRegistry;
  private readonly chatClient: CommentChatCompleter;
  private readonly logger: pino.Logger;
  private readonly limitTracker?: LimitTracker;

  constructor(deps: CommentAgentDeps) {
    this.store = deps.store;
    this.adapters = deps.adapters;
    this.chatClient = deps.chatClient;
    this.logger = deps.logger;
    this.limitTracker = deps.limitTracker;
  }

  /**
   * Handle one inbound comment (webhook or poller origin — the shape is
   * identical). NEVER throws: the webhook dispatcher has already ACKed, so an
   * error here is logged and swallowed exactly like the ConversationAgent's
   * fail-soft posture.
   */
  async handleComment(comment: IncomingComment, opts?: { logger?: pino.Logger }): Promise<CommentHandleResult> {
    const logger = opts?.logger ?? this.logger;
    const logCtx = {
      channel: comment.channel,
      commentId: comment.commentId,
      businessId: comment.channelScopedBusinessId
    };
    try {
      // 1. Verb filter. `add` is the only actionable verb; everything else
      // (edited / remove / …) is surfaced for observability and dropped —
      // replying to an edit would double-engage the same comment.
      if (comment.verb !== 'add') {
        logger.debug({ ...logCtx, verb: comment.verb }, 'comment verb is not add; skipping');
        return 'skipped_verb';
      }

      // 2. Self filter (allowlist-of-self across EVERY registered account).
      const fromId = comment.from?.id;
      if (fromId !== undefined && this.isOwnAccountId(fromId)) {
        logger.debug({ ...logCtx, fromId }, 'comment authored by a configured account; skipping (self-echo)');
        return 'skipped_self';
      }

      // 3. Account resolution.
      const account = this.adapters.resolve(comment.channel, comment.channelScopedBusinessId);
      if (!account) {
        logger.warn(logCtx, 'no account claims this comment\'s asset; dropping');
        return 'no_account';
      }
      if (!isCommentCapable(account.adapter)) {
        // Structurally impossible with the built-in clients; guards embedders
        // that registered a custom adapter without the comment surface.
        logger.warn({ ...logCtx, accountName: account.accountName }, 'adapter has no comment surface; dropping');
        return 'no_account';
      }
      const client = account.adapter;

      // 4. Dedupe. The `comment:` prefix keeps the namespace disjoint from DM
      // message ids sharing the store.
      const fresh = await this.store.claimInboundHandle(`comment:${comment.commentId}`);
      if (!fresh) {
        logger.debug(logCtx, 'duplicate comment delivery; skipping');
        return 'skipped_duplicate';
      }

      // 5. Chat call.
      const capabilities: CommentCapability[] = ['reply', 'private_reply'];
      if (typeof client.likeComment === 'function') capabilities.push('like');
      const request: CommentChatRequest = {
        kind: 'comment',
        channel: comment.channel,
        accountName: account.accountName,
        capabilities,
        comment: {
          commentId: comment.commentId,
          ...(comment.postId !== undefined ? { postId: comment.postId } : {}),
          ...(comment.parentId !== undefined ? { parentId: comment.parentId } : {}),
          ...(comment.isReply !== undefined ? { isReply: comment.isReply } : {}),
          ...(comment.text !== undefined ? { text: comment.text } : {}),
          ...(comment.from !== undefined ? { from: comment.from } : {}),
          timestamp: comment.timestamp,
          ...(comment.permalinkUrl !== undefined ? { permalinkUrl: comment.permalinkUrl } : {}),
          ...(comment.mediaProductType !== undefined
            ? { mediaProductType: comment.mediaProductType }
            : {})
        }
      };
      const response = await this.chatClient.complete(request);
      for (const warning of response.warnings ?? []) {
        logger.warn({ ...logCtx, warning }, 'comment chat response warning');
      }
      if (response.silence || response.actions.length === 0) {
        logger.debug(logCtx, 'comment endpoint chose silence');
        return 'silence';
      }

      // 6. Execute actions — each independently fail-soft, paced per account.
      for (const action of response.actions) {
        try {
          await this.limitTracker?.acquireSendSlot(comment.channel, comment.channelScopedBusinessId);
          switch (action.type) {
            case 'reply': {
              const result = await client.replyToComment(comment.commentId, action.text);
              logger.info({ ...logCtx, replyId: result.id }, 'comment reply sent');
              break;
            }
            case 'private_reply':
              await client.sendCommentPrivateReply(comment.commentId, action.text);
              logger.info(logCtx, 'comment private reply sent');
              break;
            case 'like':
              if (typeof client.likeComment !== 'function') {
                // The capabilities list already excluded it; tolerate an
                // endpoint that asked anyway (Instagram has no comment-like).
                logger.warn(logCtx, 'like action on a channel with no comment-like endpoint; skipped');
                break;
              }
              await client.likeComment(comment.commentId);
              logger.info(logCtx, 'comment liked');
              break;
            case 'silence':
              break; // stripped by the normalizer; defensive.
          }
          await this.limitTracker?.recordOutbound(comment.channel, comment.channelScopedBusinessId);
        } catch (err) {
          logger.warn({ ...logCtx, err, action: action.type }, 'comment action failed; continuing');
        }
      }
      return 'handled';
    } catch (err) {
      logger.error({ ...logCtx, err }, 'comment handling failed');
      return 'error';
    }
  }

  /** True when `id` is any registered account's business id (any channel). */
  private isOwnAccountId(id: string): boolean {
    return this.adapters.allAccounts().some(account => account.businessId === id);
  }
}
