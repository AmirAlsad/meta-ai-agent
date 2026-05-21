/**
 * Conversation state types and key builders.
 *
 * One {@link ConversationRecord} per (channel, business, user) triple. No
 * cross-channel merging happens here — that is the identity resolver's job.
 * Mirrors the SendBlue repo's conversation model, adapted to Meta's three
 * channels. The state machine, store, and buffering logic that operate on these
 * records land later in Stage 5.
 */

import type { Channel, IncomingMessage } from '../meta/types.js';
import type { OutboundItem } from '../delivery/types.js';
import type { Contact } from '../identity/types.js';

/** Lifecycle phases of a conversation as it buffers, processes, and sends. */
export type ConversationStateName = 'idle' | 'buffering' | 'processing' | 'sending';

/** WhatsApp conversation key: `whatsapp:{phoneNumberId}:{waId}`. */
export function whatsappConversationKey(phoneNumberId: string, waId: string): string {
  return `whatsapp:${phoneNumberId}:${waId}`;
}

/** Messenger conversation key: `messenger:{pageId}:{psid}`. */
export function messengerConversationKey(pageId: string, psid: string): string {
  return `messenger:${pageId}:${psid}`;
}

/** Instagram conversation key: `instagram:{igUserId}:{igsid}`. */
export function instagramConversationKey(igUserId: string, igsid: string): string {
  return `instagram:${igUserId}:${igsid}`;
}

/**
 * Derive the conversation key from a parsed {@link IncomingMessage}.
 *
 * Uses `channel` as the prefix and the parser-normalized
 * `channelScopedBusinessId` (your side) and `channelScopedUserId` (the user) —
 * which is exactly what the per-channel builders take, so the format stays
 * `{channel}:{business}:{user}` for every channel.
 */
export function conversationKeyFor(
  message: Pick<IncomingMessage, 'channel' | 'channelScopedBusinessId' | 'channelScopedUserId'>
): string {
  return `${message.channel}:${message.channelScopedBusinessId}:${message.channelScopedUserId}`;
}

/**
 * Per-(channel, business, user) conversation record — the unit the store
 * persists and the state machine mutates.
 */
export interface ConversationRecord {
  key: string;
  channel: Channel;
  /** The user side — `wa_id` / PSID / IGSID. */
  channelScopedUserId: string;
  /** Your side — `phone_number_id` / page id / ig user id. */
  channelScopedBusinessId: string;
  state: ConversationStateName;
  /** Inbound messages buffered awaiting flush to the chat endpoint. */
  inboundBuffer: IncomingMessage[];
  /**
   * Inbound messages that arrived WHILE a flush's chat call was in flight
   * (state `processing`) — see the interrupt/rebatch flow in
   * `ConversationAgent.handleInboundImpl` / `flushImpl`. They are NOT added to
   * `inboundBuffer` (which was already snapshotted + cleared by the flush);
   * instead they accumulate here and the flush, after its chat call returns,
   * folds `[...batch, ...lateArrivals]` back into `inboundBuffer` and reschedules
   * so the COMBINED input becomes ONE response instead of two.
   */
  lateArrivals: IncomingMessage[];
  /**
   * How many times the current turn has been deferred + rebatched because a late
   * arrival interrupted its in-flight chat call. Bounded by `MAX_REPROCESS` in
   * the agent so a steady stream of messages eventually gets a response rather
   * than reprocessing forever. Reset to 0 on a clean turn completion.
   */
  reprocessCount: number;
  /** Ordered outbound work produced from the chat response. */
  outboundQueue: OutboundItem[];
  /** Index of the in-flight outbound item within `outboundQueue`. */
  currentOutboundIndex: number;
  /** Channel message id of the in-flight outbound (for status correlation). */
  currentOutboundMessageId?: string;
  /** Channel message ids confirmed delivered/sent. */
  deliveredMessageIds: string[];
  /**
   * Channel message id of the MOST RECENT inbound message. WhatsApp's typing
   * indicator and read receipt are both anchored to an inbound wamid (typing is
   * coupled with mark-read — see `WhatsAppClient.sendTypingIndicator`), so the
   * agent stores it here to thread outbound typing back to the right message.
   */
  lastInboundMessageId?: string;
  /** Unix milliseconds of the most recent inbound. */
  lastInboundAt?: number;
  /** Unix milliseconds of the most recent outbound. */
  lastOutboundAt?: number;
  /**
   * Unix milliseconds the 24h messaging window closes (`lastInboundAt + 24h`).
   * Tracked here; full enforcement is Stage 10.
   */
  windowExpiresAt?: number;
  /** Unix milliseconds of the last activity of any kind (inbound/outbound/status). */
  lastActivity: number;
  /** Resolved identity for the user, when available. */
  contact?: Contact;
  /** Request-scoped trace id captured at the inbound webhook entry. */
  traceId?: string;
  /**
   * Guards a SINGLE WhatsApp out-of-window re-prompt per turn (Stage 10). When a
   * WhatsApp send fails because the 24h messaging window is closed
   * (`window_closed`), the agent re-prompts the chat endpoint ONCE (asking it to
   * reply with a template). This flag is set on that first re-prompt so a second
   * `window_closed` in the same turn just skips the item instead of looping.
   * Reset to `false` when a fresh turn attaches its outbound queue. Optional:
   * absent ⇒ false (no re-prompt has happened).
   */
  windowReprompted?: boolean;
  /**
   * Per-turn nonce stamped when the conversation enters `processing` (the chat
   * call is in flight). Boot recovery uses it to build a UNIQUE claim token per
   * processing entry so that, on a shared Redis, concurrent recoveries of the same
   * crash dedupe (one replica wins) while a LATER processing turn — after the
   * conversation has done more work — is never blocked by a stale claim from an
   * earlier turn. Set in `flushImpl`; absent outside `processing`. See
   * `ConversationAgent.recoverPendingRetries`.
   */
  processingNonce?: string;
}

/**
 * Maps an outbound channel message id back to its conversation + queue slot, so
 * a later status callback (which only carries the channel message id) can
 * locate the record and advance the right queue item.
 */
export interface OutboundHandleMapping {
  conversationKey: string;
  messageIndex: number;
  /** Conversation traceId at the time this outbound was sent. */
  traceId?: string;
}

/** Build a fresh idle conversation record with empty buffers/queues. */
export function createIdleConversation(input: {
  key: string;
  channel: Channel;
  channelScopedUserId: string;
  channelScopedBusinessId: string;
  contact?: Contact;
  now?: number;
}): ConversationRecord {
  const now = input.now ?? Date.now();
  const record: ConversationRecord = {
    key: input.key,
    channel: input.channel,
    channelScopedUserId: input.channelScopedUserId,
    channelScopedBusinessId: input.channelScopedBusinessId,
    state: 'idle',
    inboundBuffer: [],
    lateArrivals: [],
    reprocessCount: 0,
    outboundQueue: [],
    currentOutboundIndex: 0,
    deliveredMessageIds: [],
    lastActivity: now
  };
  // Only attach `contact` when supplied so the field stays absent (not
  // `undefined`) under `exactOptionalPropertyTypes`-style consumers.
  if (input.contact !== undefined) {
    record.contact = input.contact;
  }
  return record;
}

/**
 * Length of Meta's customer-service messaging window in milliseconds (24h).
 *
 * WHY this exists: Meta only lets a business send free-form messages to a user
 * within 24 hours of that user's last inbound message; outside it you must use
 * an approved template (WhatsApp) or a message tag (Messenger/Instagram). We
 * track the window here so the chat endpoint sees `context.windowOpen`. Full
 * enforcement (blocking/forcing templates on a closed window) is Stage 10.
 */
export const MESSAGING_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Whether the 24h messaging window is still open. Open when `windowExpiresAt`
 * is set and strictly in the future relative to `now`. An unset
 * `windowExpiresAt` (no inbound seen yet) is treated as CLOSED.
 */
export function isWindowOpen(
  record: Pick<ConversationRecord, 'windowExpiresAt'>,
  now: number = Date.now()
): boolean {
  return record.windowExpiresAt !== undefined && record.windowExpiresAt > now;
}
