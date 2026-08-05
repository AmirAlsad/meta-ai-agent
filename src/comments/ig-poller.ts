/**
 * Instagram comment poller.
 *
 * WHY a poller: Instagram comment WEBHOOKS (`comments` field) require
 * Advanced Access — at Standard Access the subscription is accepted but
 * nothing delivers (measured August 2026), while the comment READ endpoints
 * work fine. So new comments on the account's own media are discovered by
 * polling `GET /{user}/media` + `GET /{media}/comments`, normalized into the
 * same {@link IncomingComment} shape the webhook path produces, and pushed
 * through the same {@link CommentAgent} — whose store-backed dedupe makes the
 * two paths converge (a deploy that later gains Advanced Access just sees
 * every comment claimed by whichever path won).
 *
 * Pacing: the InstagramClient's internal pacer already spaces Graph calls
 * (default ~10/s floor for messaging); comment reads sit under the general
 * ~2/s Conversations ceiling, so the poller adds its own inter-call delay on
 * top and polls accounts SEQUENTIALLY. Cost model: one media-list call plus
 * one comments call per fresh media object per sweep, against the IG BUC
 * quota of 4800 × impressions — a 60s interval over ≤10 media is far inside
 * it for any account that has impressions at all.
 */

import type pino from 'pino';
import type { NamedInstagramConfig } from '../config/loader.js';
import type { IncomingComment } from '../meta/comments/types.js';
import type { CommentAgent } from './agent.js';

/** The slice of InstagramClient the poller needs (kept narrow for tests). */
export interface InstagramCommentSource {
  listRecentMedia(limit?: number): Promise<Array<{ id: string; timestamp?: string }>>;
  listMediaComments(mediaId: string, limit?: number): Promise<Array<Record<string, unknown>>>;
}

export interface InstagramCommentPollerDeps {
  /** The IG accounts to poll, each with its own client. */
  accounts: Array<{
    account: Pick<NamedInstagramConfig, 'accountName' | 'userId'>;
    client: InstagramCommentSource;
  }>;
  commentAgent: CommentAgent;
  logger: pino.Logger;
  /** Poll interval (ms). */
  intervalMs: number;
  /** Media newer than this many ms stay in the poll set. */
  lookbackMs: number;
  /** Recent-media page size per sweep. */
  mediaLimit: number;
  /**
   * Delay between consecutive Graph calls within one sweep (ms). Default 600
   * — under the ~2/s general Conversations ceiling with headroom.
   */
  interCallDelayMs?: number;
  /** Injectable clock/sleep for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class InstagramCommentPoller {
  private readonly deps: InstagramCommentPollerDeps;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly interCallDelayMs: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private sweeping = false;

  constructor(deps: InstagramCommentPollerDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
    this.interCallDelayMs = deps.interCallDelayMs ?? 600;
  }

  /** Start the poll loop. First sweep runs one full interval after start —
   *  boot is already busy with webhook (re)registration, and a comment
   *  arriving in that first minute is caught by the sweep that follows. */
  start(): void {
    if (this.timer !== undefined || this.stopped) return;
    this.schedule();
    this.deps.logger.info(
      {
        accounts: this.deps.accounts.map(entry => entry.account.accountName),
        intervalMs: this.deps.intervalMs
      },
      'instagram comment poller started'
    );
  }

  /** Stop the loop. A sweep already in flight finishes; no new one starts. */
  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private schedule(): void {
    // `unref` so a poller alone never keeps a shutting-down process alive.
    this.timer = setTimeout(() => {
      void this.runSweep().finally(() => {
        if (!this.stopped) this.schedule();
      });
    }, this.deps.intervalMs);
    this.timer.unref?.();
  }

  /**
   * One full sweep across every account. Public for tests (and callable for
   * an on-demand sweep); re-entrancy-guarded so a slow sweep can never
   * overlap the next interval's.
   */
  async runSweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      for (const entry of this.deps.accounts) {
        if (this.stopped) return;
        await this.sweepAccount(entry);
      }
    } finally {
      this.sweeping = false;
    }
  }

  private async sweepAccount(entry: InstagramCommentPollerDeps['accounts'][number]): Promise<void> {
    const { account, client } = entry;
    const logger = this.deps.logger;
    try {
      const media = await client.listRecentMedia(this.deps.mediaLimit);
      const cutoff = this.now() - this.deps.lookbackMs;
      for (const item of media) {
        if (this.stopped) return;
        // Media timestamps are ISO8601 (`2026-08-05T04:42:53+0000`); one with
        // no/unparseable timestamp stays in the poll set (dropping it could
        // silently blind the poller to a whole post).
        const publishedAt = item.timestamp !== undefined ? Date.parse(item.timestamp) : NaN;
        if (Number.isFinite(publishedAt) && publishedAt < cutoff) continue;

        await this.sleep(this.interCallDelayMs);
        const comments = await client.listMediaComments(item.id);
        for (const raw of comments) {
          const comment = normalizePolledComment(raw, account.userId, item.id);
          if (!comment) continue;
          // The agent's store-backed dedupe filters everything already seen —
          // by an earlier sweep or by a webhook delivery.
          await this.deps.commentAgent.handleComment(comment);
        }
      }
    } catch (err) {
      // One account's failure (expired token, rate limit) must not stop the
      // others' sweeps or kill the loop.
      logger.warn({ err, accountName: account.accountName }, 'instagram comment sweep failed');
    }
  }
}

/**
 * Normalize one polled comment record into the shared {@link IncomingComment}
 * shape. Exported for tests. Polled records carry `from` {id, username} (IG
 * returns identity freely on this path), ISO8601 `timestamp`, and `parent_id`
 * on replies. Top-level `username` appears without `from` on some responses —
 * tolerated, but without an author ID the self-filter can't run, so the agent
 * still processes it (a stranger-shaped record).
 */
export function normalizePolledComment(
  raw: Record<string, unknown>,
  businessUserId: string,
  mediaId: string
): IncomingComment | undefined {
  const commentId = typeof raw.id === 'string' ? raw.id : undefined;
  if (commentId === undefined) return undefined;

  const from =
    typeof raw.from === 'object' && raw.from !== null ? (raw.from as Record<string, unknown>) : undefined;
  const fromId = from && typeof from.id === 'string' ? from.id : undefined;
  const fromName =
    from && typeof from.username === 'string'
      ? from.username
      : typeof raw.username === 'string'
        ? raw.username
        : undefined;

  const parsedTimestamp = typeof raw.timestamp === 'string' ? Date.parse(raw.timestamp) : NaN;
  const parentId = typeof raw.parent_id === 'string' ? raw.parent_id : undefined;

  const comment: IncomingComment = {
    channel: 'instagram',
    channelScopedBusinessId: businessUserId,
    commentId,
    postId: mediaId,
    timestamp: Number.isFinite(parsedTimestamp) ? parsedTimestamp : Date.now(),
    verb: 'add',
    raw
  };
  if (parentId !== undefined) {
    comment.parentId = parentId;
    comment.isReply = true;
  }
  if (typeof raw.text === 'string') comment.text = raw.text;
  if (fromId !== undefined) {
    comment.from = { id: fromId, ...(fromName !== undefined ? { name: fromName } : {}) };
  }
  return comment;
}
