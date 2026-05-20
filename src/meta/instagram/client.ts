/**
 * Instagram messaging outbound send client (Instagram API with Business Login).
 *
 * Implements the shared {@link ChannelAdapter} so the conversation agent can
 * dispatch outbound Instagram DMs without branching on the channel. All sends
 * go through the injected {@link GraphClient} (the shared transport that owns
 * retry/backoff and Bearer-header auth); this client owns only the
 * Instagram-specific request body shapes (`recipient`, `message`,
 * `sender_action`) plus a minimal per-account rate pacer.
 *
 * WHY `host: 'graph.instagram.com'` (and not the default `graph.facebook.com`):
 * this client targets the Instagram API with Instagram Login (Business Login),
 * whose messaging endpoints are served from `graph.instagram.com`. The endpoint
 * for every method here is `POST {igUserId}/messages` on that host. (Meta's docs
 * note the legacy Facebook-Login flow used `graph.facebook.com/{IG_USER_ID}/...`
 * and both can work depending on the integration; we standardize on
 * `graph.instagram.com` for the Business-Login token this package issues. FLAG
 * for the fidelity reviewer — confirm against current Meta docs.) The access
 * token is supplied per request from {@link InstagramConfig.accessToken} and the
 * transport puts it in the `Authorization: Bearer` header — never the URL.
 *
 * DOUBLE-SEND SAFETY: every send is a POST and we deliberately leave
 * `idempotent` unset on `this.graph.request(...)`. The transport then does NOT
 * retry a 5xx for these POSTs, because a 5xx after a send is ambiguous — Meta
 * may have already accepted and delivered the message before the error surfaced,
 * so a retry could double-send. (429 / pre-response network failures are still
 * retried by the transport; those never reached Meta.)
 *
 * Reference: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api
 */

import type pino from 'pino';
import type { InstagramConfig } from '../../config/loader.js';
import type { GraphClient } from '../shared/graph-client.js';
import type { ChannelAdapter, ChannelFeature, SendOptions, SendResult } from '../shared/adapter.js';

/** Host serving the Instagram-Login messaging endpoints. */
const INSTAGRAM_GRAPH_HOST = 'graph.instagram.com' as const;

/**
 * Default minimum spacing between two outbound Graph calls for one IG account.
 *
 * WHY 100ms (and not the old 500ms): the per-second send ceilings on Instagram
 * are well ABOVE 2 calls/sec — Meta documents ~300 calls/sec per account for
 * text / links / reactions / stickers and ~10 calls/sec per account for audio /
 * video. (There is also a separate hourly throughput model of
 * 200 × number-of-messageable-users.) The strictest PER-SECOND sub-limit is the
 * 10/sec media ceiling, so 1000ms / 10 = 100ms is a safe floor that honors it
 * without needlessly throttling legitimate text bursts the way 500ms (a wrong
 * "2/sec" assumption) did. This is only a coarse per-process floor; the full
 * model (per-second + hourly throughput, multi-replica) is Stage 10's
 * `LimitTracker`. Overridable per client via {@link InstagramClientDeps.minIntervalMs}.
 * See {@link InstagramClient.pace}.
 */
const DEFAULT_MIN_CALL_SPACING_MS = 100;

export interface InstagramClientDeps {
  /** Instagram credentials (IG user id + access token). */
  config: InstagramConfig;
  /** Shared Graph API transport — constructed once per process and injected. */
  graph: GraphClient;
  /** Optional structured logger. */
  logger?: Pick<pino.Logger, 'info' | 'warn' | 'debug'>;
  /**
   * Injectable clock for the rate pacer (defaults to {@link Date.now}). Tests
   * inject a controllable clock so pacing is asserted WITHOUT real waiting.
   */
  now?: () => number;
  /**
   * Injectable sleep for the rate pacer (defaults to a real `setTimeout`).
   * Tests inject a recording no-op so the pacer incurs NO real delay.
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Minimum inter-call spacing (ms) enforced by the pacer. Defaults to
   * {@link DEFAULT_MIN_CALL_SPACING_MS} (100ms — the 10/sec media sub-limit).
   * Override to tighten/loosen the per-process floor.
   */
  minIntervalMs?: number;
}

/** Shape of the IG `/messages` success envelope we read the message id from. */
interface InstagramSendResponse {
  message_id?: string;
  recipient_id?: string;
}

export class InstagramClient implements ChannelAdapter {
  readonly channel = 'instagram' as const;

  private readonly config: InstagramConfig;
  private readonly graph: GraphClient;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Minimum inter-call spacing enforced by {@link InstagramClient.pace}. */
  private readonly minIntervalMs: number;

  /**
   * Tail of the serialized pacer's promise chain. Each Graph call appends to
   * this chain so concurrent sends queue behind one another instead of all
   * firing at once. See {@link InstagramClient.pace}.
   */
  private pacerTail: Promise<void> = Promise.resolve();
  /** Timestamp (via {@link InstagramClient.now}) of the previous Graph call. */
  private lastCallAt = 0;

  constructor(deps: InstagramClientDeps) {
    this.config = deps.config;
    this.graph = deps.graph;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? defaultSleep;
    this.minIntervalMs = deps.minIntervalMs ?? DEFAULT_MIN_CALL_SPACING_MS;
  }

  /**
   * Send a plain-text DM via `POST {igUserId}/messages`.
   *
   * `opts.replyTo` is intentionally IGNORED here (the text still sends): the
   * Instagram-Login Send API does not support outbound quoted replies —
   * exhaustively verified 2026-05-20: top-level `reply_to:{mid}` returns code
   * 100/subcode 2534002 'Invalid Message ID' even for a bot's own just-returned
   * (valid) message id; `reply_to_message_id` is accepted but rendered as a plain
   * message; nested forms are 'invalid keys'. The conversation agent downgrades a
   * reply action to a plain message when supports('reply_to') is false, so the
   * user still receives the text. (The Facebook-Login 'Messenger API for
   * Instagram' flavor supports `reply_to`, but this client targets the
   * Instagram-Login flavor by design.)
   */
  async sendText(recipientId: string, text: string, opts?: SendOptions): Promise<SendResult> {
    void opts?.replyTo; // unsupported on Instagram-Login — see doc above; do not build a reply field.
    const message: Record<string, unknown> = { text };

    const body: Record<string, unknown> = {
      recipient: { id: recipientId },
      message
    };

    const raw = await this.send(body, 'instagram.sendText');
    return this.toSendResult(recipientId, raw);
  }

  /**
   * Show a typing indicator to the user.
   *
   * WHY a SEPARATE request (not piggy-backed on a message): like Messenger,
   * Instagram's Send API rejects a request that combines a `message` with a
   * `sender_action`. Typing must be its own `sender_action: "typing_on"` POST.
   *
   * The {@link ChannelAdapter.sendTypingIndicator} `messageId` is unused on
   * Instagram — typing is conversation-scoped via the recipient id, not anchored
   * to a specific inbound message (unlike WhatsApp).
   */
  async sendTypingOn(recipientId: string): Promise<void> {
    const body = {
      recipient: { id: recipientId },
      sender_action: 'typing_on'
    };
    await this.send(body, 'instagram.sendTypingOn');
  }

  /**
   * Mark the conversation's latest inbound message(s) as seen (read receipt).
   *
   * Sent as its own `sender_action: "mark_seen"` POST (same separate-request
   * constraint as typing).
   *
   * FLAG for fidelity reviewer: confirm Instagram supports `mark_seen` via the
   * Send API. Messenger documents it; the Instagram-Login messaging surface is
   * less explicit. If unsupported, `supports('read_receipt')` should flip to
   * false and `markRead` should become a no-op or throw.
   */
  async markSeen(recipientId: string): Promise<void> {
    const body = {
      recipient: { id: recipientId },
      sender_action: 'mark_seen'
    };
    await this.send(body, 'instagram.markSeen');
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /* ChannelAdapter surface                                                     */
  /* ──────────────────────────────────────────────────────────────────────── */

  /**
   * {@link ChannelAdapter.sendTypingIndicator} — delegates to
   * {@link InstagramClient.sendTypingOn}. `messageId` is unused on Instagram
   * (typing is conversation-scoped, not anchored to an inbound message id).
   */
  async sendTypingIndicator(recipientId: string, messageId?: string): Promise<void> {
    void messageId; // unused on Instagram — typing is conversation-scoped.
    await this.sendTypingOn(recipientId);
  }

  /**
   * {@link ChannelAdapter.markRead} — delegates to
   * {@link InstagramClient.markSeen}. `messageId` is unused on Instagram:
   * `mark_seen` marks the conversation read by recipient, not a single message.
   */
  async markRead(recipientId: string, messageId: string): Promise<void> {
    void messageId; // unused on Instagram — mark_seen is conversation-scoped.
    await this.markSeen(recipientId);
  }

  /**
   * React (or unreact) to a user's message via the Send API `sender_action`.
   *
   * Instagram's Send API mirrors Messenger here:
   * - React (non-empty `emoji`): `sender_action: 'react'` with the emoji nested
   *   INSIDE `payload` as `payload.reaction` (NOT a sibling of `payload`), keyed
   *   to the target `payload.message_id`.
   * - Unreact (empty-string `emoji`): `sender_action: 'unreact'` with a `payload`
   *   carrying only `message_id` (no `reaction` key) — removes the prior reaction.
   *
   * `recipientId` IS used — it is the user whose message is being reacted to,
   * sent as `recipient.id`. WHY a standalone request (no `message` key): a
   * `sender_action` MUST NOT be combined with a `message`. Routed through the
   * same {@link InstagramClient.send} pacer as every other IG send.
   */
  async sendReaction(recipientId: string, messageId: string, emoji: string): Promise<void> {
    // Empty emoji = unreact (remove the reaction); otherwise react.
    const body =
      emoji === ''
        ? {
            recipient: { id: recipientId },
            sender_action: 'unreact',
            payload: { message_id: messageId }
          }
        : {
            recipient: { id: recipientId },
            sender_action: 'react',
            // The emoji goes INSIDE `payload` as `reaction`, not as a sibling.
            payload: { message_id: messageId, reaction: emoji }
          };
    await this.send(body, 'instagram.sendReaction');
  }

  /**
   * Capability matrix advertised to the conversation agent. Returns `true`
   * ONLY for features actually wired at Stage 4.
   */
  supports(feature: ChannelFeature): boolean {
    switch (feature) {
      case 'typing_indicator':
        return true;
      // read_receipt (mark_seen) is wired but PENDING fidelity confirmation on
      // the Instagram-Login Send API — see the flag on markSeen. Advertised true
      // so the agent attempts it; flip to false if a fidelity review proves it
      // unsupported.
      case 'read_receipt':
        return true;
      // reply_to is FALSE: the Instagram-Login Send API does not support outbound
      // quoted replies (exhaustively verified 2026-05-20 — see sendText). The
      // agent downgrades a reply action to a plain message when this is false, so
      // the user still receives the text.
      case 'reply_to':
        return false;
      // Supported via `sender_action: react/unreact` on the Send API (see sendReaction).
      case 'reaction':
        return true;
      // No template messaging on Instagram (a WhatsApp-only concept).
      case 'template':
        return false;
      // media_send lands in Stage 7 (media upload + send) — flips to true once
      // image/audio/video send exists on this client.
      case 'media_send':
        return false;
      // story_reply is an INBOUND concept (a user replying to the business's
      // story arrives via webhook) — it is not an outbound send capability.
      case 'story_reply':
        return false;
      // ice_breakers lands in Stage 8 (Messenger/IG profile surfaces) — flips
      // to true once the profile/ice-breaker API is wired.
      case 'ice_breakers':
        return false;
      // get_started / persistent_menu are Messenger profile surfaces not
      // applicable to the Instagram messaging client.
      case 'get_started':
      case 'persistent_menu':
        return false;
      default:
        return false;
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /* Internals                                                                  */
  /* ──────────────────────────────────────────────────────────────────────── */

  /**
   * Shared POST to `{igUserId}/messages` on `graph.instagram.com`, paced to
   * honor the per-account rate ceiling. `idempotent` is intentionally left unset
   * (see the double-send note in the class doc) so a 5xx is not retried for
   * these sends.
   */
  private async send(body: unknown, operation: string): Promise<InstagramSendResponse> {
    await this.pace();
    return this.graph.request<InstagramSendResponse>({
      method: 'POST',
      host: INSTAGRAM_GRAPH_HOST,
      path: `${this.config.userId}/messages`,
      body,
      accessToken: this.config.accessToken,
      operation
    });
  }

  /**
   * Minimal serialized rate pacer: ensure at least {@link InstagramClient.minIntervalMs}
   * (default {@link DEFAULT_MIN_CALL_SPACING_MS}) have elapsed since the previous
   * Graph call before allowing the next.
   *
   * Two properties matter and both are provided here:
   *  1. SPACING — if the last call was <`minIntervalMs` ago, `await sleep(remaining)`.
   *  2. SERIALIZATION — concurrent callers must not all read the same stale
   *     `lastCallAt` and fire together. We chain every call onto `pacerTail`
   *     (a single promise chain), so the Nth caller only computes its delay
   *     after the (N-1)th has reserved its slot. We bump `lastCallAt` BEFORE
   *     the awaited sleep resolves (to `lastCallAt + minIntervalMs`) so a
   *     burst of N calls is spaced `minIntervalMs` apart rather than collapsing.
   *
   * WHY this is a minimal floor and not the real limiter: Stage 10 replaces this
   * with the full `LimitTracker` (shared, Redis-backed, multi-replica-aware,
   * with proper token-bucket accounting and metrics; modeling the real ~300/sec
   * text + ~10/sec media per-second ceilings AND the 200×conversations/hr
   * throughput cap). This in-process pacer is only a per-process floor to avoid
   * tripping immediate 429s before Stage 10 lands; it does NOT coordinate across
   * replicas.
   *
   * Uses the injectable `now`/`sleep` so tests assert pacing deterministically
   * with no real delay.
   */
  private pace(): Promise<void> {
    // Append this call to the serialized chain. Each link computes its own
    // delay against the running `lastCallAt`, reserves its slot by advancing
    // `lastCallAt`, then sleeps for any remaining time.
    const next = this.pacerTail.then(async () => {
      const current = this.now();
      const earliest = this.lastCallAt + this.minIntervalMs;
      const waitMs = earliest - current;
      if (waitMs > 0) {
        // Reserve this slot at the earliest permitted time so the NEXT chained
        // caller spaces off our reserved slot, not off `now`.
        this.lastCallAt = earliest;
        await this.sleep(waitMs);
      } else {
        // No wait needed — this call happens now; record when it fired.
        this.lastCallAt = current;
      }
    });
    // Keep the chain alive even if a link rejects: swallow rejection on the
    // stored tail so one failed send does not poison the pacer for later calls.
    // The caller still sees the original result/rejection via `next`.
    this.pacerTail = next.catch(() => undefined);
    return next;
  }

  /** Parse a `/messages` response into the cross-channel {@link SendResult}. */
  private toSendResult(recipientId: string, raw: InstagramSendResponse): SendResult {
    const messageId = raw.message_id;
    if (messageId === undefined) {
      // A 2xx with no message id is unexpected — surface it loudly rather than
      // returning an empty/garbage id downstream.
      throw new Error(`Instagram send returned no message id: ${JSON.stringify(raw)}`);
    }
    return {
      channel: this.channel,
      messageId,
      recipientId,
      timestamp: Date.now(),
      raw
    };
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
