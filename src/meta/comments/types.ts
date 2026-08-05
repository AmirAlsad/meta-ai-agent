/**
 * Comment pipeline types.
 *
 * Comments are a SEPARATE inbound surface from messaging: they arrive in
 * `entry[].changes` (Facebook Pages, field `feed`; Instagram, field
 * `comments`) rather than `entry[].messaging`, they have no 24h window and no
 * delivery callbacks, and one post fans out to many authors — so they get
 * their own normalized type and their own agent (`src/comments/agent.ts`)
 * instead of riding the ConversationAgent's state machine.
 *
 * Channel naming: a Facebook Page comment carries `channel: 'messenger'`.
 * That reads oddly ("messenger" for a feed comment) but is deliberate — the
 * transport's channel unions key the ADAPTER that owns the asset, and the
 * Page's comment endpoints authenticate with the same Page token the
 * Messenger adapter holds. Introducing a fourth channel value would fork
 * every `Record<Channel, ...>` in the package for a distinction that only
 * matters inside the comment pipeline.
 */

import type { Channel } from '../types.js';

/** The two channels that have comment surfaces (WhatsApp has none). */
export type CommentChannel = Extract<Channel, 'messenger' | 'instagram'>;

/**
 * The comment author as the webhook/poll surfaced it.
 *
 * PERSIST AT RECEIPT: Facebook comment WEBHOOKS carry `from` for any author,
 * but the corresponding READ endpoints omit other people's `from` at Standard
 * Access (the identity gate bites on reads, not deliveries) — so an author
 * seen now may not be re-fetchable later. Instagram polling returns identity
 * freely. Either way, what arrives here is what downstream gets.
 */
export interface CommentAuthor {
  id: string;
  /** FB `from.name` / IG `from.username`, when present. */
  name?: string;
}

/**
 * Normalized inbound comment, produced by the parser (webhook path) and the
 * Instagram poller (poll path) in the same shape.
 */
export interface IncomingComment {
  channel: CommentChannel;
  /** Your side — the Page id / IG user id the comment's asset belongs to. */
  channelScopedBusinessId: string;
  /** The comment's own id (FB `comment_id`, IG comment `id`). */
  commentId: string;
  /** The commented asset: FB `post_id` / IG `media.id`. Absent only on malformed payloads. */
  postId?: string;
  /**
   * FB `parent_id` / IG `parent_id`, VERBATIM. On Facebook this is NOT a
   * reliable reply indicator: measured August 2026, a top-level reel comment
   * carries `parent_id == post_id` while photo-post ids use a different
   * prefix scheme entirely — use {@link isReply} for the best-effort
   * classification and treat this field as raw material.
   */
  parentId?: string;
  /**
   * Best-effort "this is a reply to another comment" flag.
   * Instagram: `parent_id` present ⇔ reply (reliable, documented).
   * Facebook: true when `parent_id` is present AND neither equals `post_id`
   * nor shares its final `_`-segment (the post's own id part) — the rule that
   * classifies both measured August 2026 captures correctly. Undefined when
   * there is no parent material to judge.
   */
  isReply?: boolean;
  /** Comment text. Absent for sticker/GIF-only comments. */
  text?: string;
  from?: CommentAuthor;
  /** Unix milliseconds, normalized at the boundary (FB `created_time` arrives in seconds). */
  timestamp: number;
  /**
   * FB `verb` verbatim (`add` / `edited` / `edit` / `remove` / `delete` / …).
   * Instagram comment webhooks carry no verb — normalized to `'add'`.
   * The comment agent acts on `add` only; everything else is logged.
   */
  verb: string;
  /** FB `post.permalink_url`, when the webhook carried the post block. */
  permalinkUrl?: string;
  /** IG `media.media_product_type` (e.g. `REELS`), when present. */
  mediaProductType?: string;
  /** The per-comment raw payload (the `changes[].value` block), for debugging. */
  raw: unknown;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Comment chat contract                                                      */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Capabilities the responding account has for THIS comment, so the endpoint
 * never asks for a lever the channel lacks:
 *  - `reply`          — public reply under the comment (both channels).
 *  - `private_reply`  — comment-to-DM (both channels; one message, 7-day
 *                       limit, does not open a messaging window).
 *  - `like`           — Facebook only. Instagram has NO comment-like endpoint;
 *                       on IG the levers are reply, private reply, or nothing.
 */
export type CommentCapability = 'reply' | 'private_reply' | 'like';

/**
 * Payload POSTed to the comment endpoint for one inbound comment.
 *
 * `kind: 'comment'` is the discriminator that lets one endpoint serve both
 * this and the DM {@link ChatRequest} (which has no `kind` field).
 */
export interface CommentChatRequest {
  kind: 'comment';
  channel: CommentChannel;
  /** Name of the configured account the comment belongs to. */
  accountName: string;
  capabilities: CommentCapability[];
  comment: {
    commentId: string;
    postId?: string;
    parentId?: string;
    isReply?: boolean;
    text?: string;
    from?: CommentAuthor;
    /** Unix milliseconds. */
    timestamp: number;
    permalinkUrl?: string;
    mediaProductType?: string;
  };
}

/**
 * One action the comment endpoint can request. Mirrors the DM contract's
 * spirit (typed actions + explicit silence) with comment-shaped verbs.
 */
export type CommentChatAction =
  | { type: 'reply'; text: string }
  | { type: 'private_reply'; text: string }
  | { type: 'like' }
  | { type: 'silence' };

/**
 * Raw response from the comment endpoint. `actions[]` is canonical;
 * `silence: true` (or an empty response) means engage-nothing — which is a
 * normal, expected outcome: selective engagement is the correct posture for
 * comments, not full coverage.
 */
export interface CommentChatResponse {
  actions?: CommentChatAction[];
  silence?: boolean;
  /** Legacy convenience: a bare string is treated as one public reply. */
  message?: string;
}

/** Collapsed, validated form of a {@link CommentChatResponse}. */
export interface NormalizedCommentChatResponse {
  actions: CommentChatAction[];
  /** True when the response was an explicit silence. */
  silence?: boolean;
  warnings?: string[];
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Outbound comment capabilities (implemented by the channel clients)         */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * The comment levers a channel client exposes. MessengerClient and
 * InstagramClient implement this alongside {@link ChannelAdapter}; the
 * comment agent narrows a registry-resolved adapter with
 * {@link isCommentCapable} rather than the registry carrying a second client.
 */
export interface CommentCapableClient {
  /** Public reply under a comment. Returns the created comment/reply id when the API provides one. */
  replyToComment(commentId: string, text: string): Promise<{ id?: string }>;
  /** Comment-to-DM private reply (one message, 7-day limit). */
  sendCommentPrivateReply(commentId: string, text: string): Promise<unknown>;
  /** Facebook only — absent on clients whose platform has no comment-like endpoint. */
  likeComment?(commentId: string): Promise<void>;
  /** Delete a comment on your own asset (moderation / cleanup; never driven by the chat endpoint). */
  deleteComment(commentId: string): Promise<void>;
}

/** Structural narrow for a registry-resolved adapter. */
export function isCommentCapable(value: unknown): value is CommentCapableClient {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.replyToComment === 'function' &&
    typeof candidate.sendCommentPrivateReply === 'function' &&
    typeof candidate.deleteComment === 'function'
  );
}
