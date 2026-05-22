# Delivery-status tracking

## What it does

The tracker accumulates a per-outbound-message delivery-status history so an operator can answer "did this reply actually arrive / get read?" The history feeds the [`GET /admin/status/:messageId`](./operational-visibility.md) admin route and the `status_callback_total` metric. The tracker itself is observability only — recording a status never drives the conversation state machine or the outbound queue. (A WhatsApp `failed` delivery-status webhook *can* drive an async retry / template re-prompt, but that decision is the **agent's**, not the tracker's — see [Async-failure interaction](#async-failure-interaction-the-agent-owns-retry) below.)

The vocabulary is Meta's four-value `DeliveryStatus` enum (`sent` / `delivered` / `read` / `failed`) reused from the parser, so there is exactly one status vocabulary across the package.

This document covers the tracker. For read receipts specifically (the WhatsApp `read` status, the Messenger/Instagram watermark, and the `READ_RECEIPTS_ENABLED` outbound knob) see [Read receipts](./read-receipts.md).

## How it works

### `StatusRecord` shape

The tracker keys one `StatusRecord` per channel-scoped outbound message id (`channelMessageId` — a WhatsApp wamid, a Messenger `m_*` id, or an Instagram id). Defined in [`src/status/types.ts`](../../src/status/types.ts):

```typescript
export interface StatusRecord {
  channelMessageId: string;
  channel: Channel;
  conversationKey?: string;   // set when the caller supplies it
  recipientId?: string;       // the user side (wa_id / PSID / IGSID), when supplied
  current: DeliveryStatus;    // the MOST-ADVANCED status seen (see STATUS_RANK)
  history: StatusHistoryEntry[]; // append-only, arrival order
  firstSeenAt: number;        // Unix ms of the first status seen
  lastUpdatedAt: number;      // Unix ms of the most recent status applied
}

export interface StatusHistoryEntry {
  status: DeliveryStatus;
  timestamp: number;
  errorCode?: number;            // WhatsApp-only, only on a `failed` entry
  errorTitle?: string;           // WhatsApp-only, only on a `failed` entry
  errorCategory?: FailureCategory; // human-readable bucket, only on a `failed` entry
}
```

`StatusRecord` additionally mirrors `errorCategory?: FailureCategory` at the top
level — the bucket of the **most recent** `failed` status — so a dashboard can read
it off the record without scanning `history`. It is set once a `failed` status has
been applied (WhatsApp-only) and is never cleared by a later non-failure status.

### Rank-based `current` — no regression

`current` is the **highest-rank** status ever observed, not the most-recently-written. The rank in [`src/status/types.ts`](../../src/status/types.ts) is:

```typescript
export const STATUS_RANK: Record<DeliveryStatus, number> = {
  sent: 0,
  delivered: 1,
  read: 2,
  failed: 3
};
```

Meta does not guarantee status events arrive in lifecycle order and it redelivers them. Ranking by progression (`sent` < `delivered` < `read`) means a late, out-of-order `sent` arriving after `delivered` cannot regress `current` — yet `history` still records both entries. `failed` is given the top rank so a terminal failure is never masked by a lower-rank success; in practice Meta does not emit a success after a `failed` for the same id, so highest-rank-wins yields the intuitive `current` in every real case. The update is applied with `>=` so an equal-rank re-observation still refreshes `current` to the same value.

### Idempotency

A redelivered webhook must not double-append to `history`. `applyStatusUpdate` skips an exact `(status, timestamp)` duplicate before pushing the entry, so a redelivered status is idempotent on `(status, timestamp)`. `firstSeenAt` / `lastUpdatedAt` are widened to cover the observed timestamp on every call.

### WhatsApp failure categories

A bare error code (`131047`, `131026`, `190`, …) is opaque on a dashboard, so on a
`failed` status the tracker derives a human-readable `FailureCategory` from
`status.errorCode` via `whatsappFailureCategory(errorCode)` and stamps it on both
the history entry and the record:

```typescript
export type FailureCategory =
  | 'rate_limit'    // 4, 80007, 130429, 131056, 613
  | 'window_closed' // 131047, 470
  | 'policy'        // 131048, 131049, 368 (spam / quality throttles)
  | 'unsupported'   // 131051 (unsupported message type)
  | 'recipient'     // 131026, 131030, 131045 (undeliverable / not allow-listed)
  | 'auth'          // 190, 10, 200 (token / permission)
  | 'server'        // 131000, 1, 2 (Meta-side server error)
  | 'unknown';      // undefined or any code not yet enumerated
```

`whatsappFailureCategory` and the code sets live in
[`src/limits/error-codes.ts`](../../src/limits/error-codes.ts) — the **single
source of truth** for the WhatsApp/Meta error-code groupings, shared with the retry
classifier (`classifyError` / `classifyStatusErrorCode`) so the display bucket can
never drift from the routing decision (e.g. whether `131047` is a window error).
The mapper is total and never throws — `undefined` and any unrecognized code map to
`unknown`, since Meta can emit codes the package does not yet enumerate. The
category is computed only on a `failed` status (a success carries no error code),
and a `failed` with no diagnostics still gets a bucket (`unknown`).

`errorCategory` is a **bounded enum, not PII**, so it is allow-listed verbatim in
the admin redactor (`redactStatusRecord` keeps the per-entry category inside each
`history` object and the top-level mirror). See [Operational
visibility](./operational-visibility.md).

### Async-failure interaction (the agent owns retry)

On WhatsApp the real rate-limit / closed-window failures usually surface
**asynchronously** as a `failed` delivery-status webhook (carrying
`status.errorCode`) *after* the synchronous send POST already returned 200/queued —
not on the send call itself. Two distinct concerns split across two layers on that
path, and keeping them separate is load-bearing:

- **The tracker records the failure (observability).** In `handleStatus`
  ([`src/conversation/agent.ts`](../../src/conversation/agent.ts)), the per-message
  status — including a `failed` with its `errorCode` / `errorTitle` — is recorded
  **up front** via `applyStatusUpdate`, before the outbound-handle mapping lookup
  and the per-key lock. The tracker derives the `FailureCategory` from the code and
  stamps it on the history entry + the record mirror. This is pure bookkeeping: the
  tracker takes no retry action.
- **The agent owns the retry decision.** Separately, when a `failed` status refers
  to the **currently in-flight** queue item (`currentOutboundIndex ===
  mapping.messageIndex`), the agent classifies `status.errorCode` via
  `LimitTracker.classifyStatusErrorCode` (the async sibling of the synchronous
  `classifyError`) and routes it: `window_closed` → a once-per-turn template
  re-prompt; `transient` → a backoff retry counted on a dedicated
  `asyncFailRetryCount` (a separate counter from the synchronous `retryCount`,
  because a successful send clears `retryCount`); `permanent` / exhausted → skip +
  advance so one bad send can't wedge the queue. Each outcome emits
  `transient_retry_total{outcome}` (`scheduled` / `exhausted`). See [Rate
  limiting](./rate-limiting.md) for the classification + backoff math.

The double-send-safety reasoning is **inverted** versus the synchronous send path: a
5xx after a POST is ambiguous (Meta may have delivered), so the sync path does not
retry; a `failed` *delivery status* is Meta's definitive statement the message did
NOT reach the user, so retrying a transient-classified async failure is safe. The
tracker's recording is unaffected by either decision — it logs every `failed` it
sees regardless of how the agent then routes it.

### Per-channel model

The two webhook shapes are handled by two methods on the `StatusTracker` interface ([`src/status/tracker.ts`](../../src/status/tracker.ts)):

| Channel | Webhook shape | Tracker entry point |
| --- | --- | --- |
| WhatsApp | per-message `statuses[]` (`sent`/`delivered`/`read`/`failed`) keyed by the real wamid | `applyStatusUpdate` (1:1) |
| Messenger / Instagram | a READ WATERMARK timestamp (`message_reads` / `messaging_seen`), not a per-message id | `applyReadWatermark` |

**WhatsApp** is direct: the agent's `handleStatus` calls `applyStatusUpdate` with the wamid, status, timestamp, the resolved `conversationKey`, the user-side `recipientId`, and (on a `failed`) the `errorCode` / `errorTitle` (the tracker derives `errorCategory` from the code itself). It records the status **up front** — before the outbound-handle mapping lookup and the per-key lock — so a `delivered`/`read` callback arriving after the first advancing status (`sent`) deleted the mapping is still captured (otherwise the history would stick at `sent`). The tracker is its own synchronous store, so recording needs no lock, and the call is inside a try/catch so a tracker error cannot break delivery.

**Messenger / Instagram** carry no per-message id — `channelMessageId` on the status is a watermark timestamp. The agent translates the watermark into concrete message ids: in `handleReadWatermarkImpl` ([`src/conversation/agent.ts`](../../src/conversation/agent.ts)) it scans the conversation record's `outboundQueue` for items that were actually sent (`channelMessageId` set and `sentAt !== undefined`) at or before the watermark, then passes those ids to `applyReadWatermark`:

```typescript
const messageIds = record.outboundQueue
  .filter(item => item.channelMessageId && item.sentAt !== undefined && item.sentAt <= status.timestamp)
  .map(item => item.channelMessageId!);
```

`applyReadWatermark` marks each id `read` at the watermark time by reusing `applyStatusUpdate` (so the rank / idempotency / timestamp logic lives in one place). Crucially it **only advances ids the tracker already knows** — `if (!this.records.has(messageId)) continue;`. The watermark never invents a record from nothing, so an id the agent sent but whose `sent` status the tracker never recorded is simply skipped there.

This watermark path is observability-only. Messenger/IG are advance-on-send (`statusAdvancesQueue` returns false for them), so by the time a read arrives the queue has long since advanced on each send's API response. The read therefore must not advance, skip, or re-open any queue item — `handleReadWatermarkImpl` only updates status history and the `status_callback_total{status:'read'}` metric. See [Ordered delivery](./ordered-delivery.md) for the advancement model and [Read receipts](./read-receipts.md) for the full read flow.

### Clone-on-read

`getStatus` and `listByConversation` return a JSON deep-clone of the stored record, matching the conversation store's discipline: a caller that mutates the returned record (sorts/truncates `history`, flips `current`) cannot corrupt the tracker's internal state. `StatusRecord` is JSON-safe (primitives plus a `history` array of plain objects), so a JSON round-trip is a sufficient, dependency-free deep copy.

### The admin route (redacted)

`GET /admin/status/:messageId` returns the record for one outbound id, **PII-redacted by default**. The redactor `redactStatusRecord` ([`src/http/redaction.ts`](../../src/http/redaction.ts)) keeps the structural fields verbatim — `channelMessageId` (our send id), `channel`, `current`, the full `history` (status enums + timestamps + WhatsApp error codes/titles + the bounded `errorCategory` bucket, none of which is PII), the top-level `errorCategory` mirror, and `firstSeenAt` / `lastUpdatedAt` — and masks the two PII fields: `recipientId` via `maskId` (last-4 suffix) and the user segment of `conversationKey` via `maskConversationKey`. `?reveal=true` (authenticated only) returns the unmasked record. The route is token-gated and guarded at registration — when `ADMIN_API_TOKEN` is unset it is not mounted at all (404, not 401). See [Operational visibility](./operational-visibility.md) for the full route table and redaction policy.

## Code files

| File | Role |
| --- | --- |
| [`src/status/types.ts`](../../src/status/types.ts) | `StatusRecord`, `StatusHistoryEntry` (incl. `errorCategory`), the `STATUS_RANK` map. |
| [`src/status/tracker.ts`](../../src/status/tracker.ts) | `StatusTracker` interface + `InMemoryStatusTracker` (`applyStatusUpdate`, `applyReadWatermark`, `getStatus`, `listByConversation`); derives `errorCategory` on a `failed` status. |
| [`src/limits/error-codes.ts`](../../src/limits/error-codes.ts) | `FailureCategory`, `whatsappFailureCategory`, and the WhatsApp/Meta error-code sets — the single source of truth shared with the retry classifier. |
| [`src/conversation/agent.ts`](../../src/conversation/agent.ts) | `handleStatus` (records the status up front), `handleStatusImpl` (WhatsApp 1:1 + the async `failed`-status retry/re-prompt routing via `classifyStatusErrorCode`) and `handleReadWatermarkImpl` (the watermark→message-id translation). |
| [`src/http/app.ts`](../../src/http/app.ts) | `GET /admin/status/:messageId` route (token-gated, guarded at registration). |
| [`src/http/redaction.ts`](../../src/http/redaction.ts) | `redactStatusRecord` — masks `recipientId` + the key user segment. |

## Configuration

The status tracker itself has no env vars. The admin route that reads it is gated by `ADMIN_API_TOKEN` (≥16 chars; see [Configuration](./configuration.md)).

## Known limitations

- **Still in-memory (Stage 10 did NOT swap this store).** `InMemoryStatusTracker` is a plain `Map` and is **unbounded** — no TTL, no sweeper — in both the in-memory and Redis runtime paths. Stage 10 made the conversation store, buffer scheduler, and limit-counter store Redis-backed, but the status tracker (along with the metrics collector and contact store) was left for a later pass; a Redis-backed tracker with TTL eviction is still deferred (see [Known gaps](../KNOWN-GAPS.md)). The `StatusTracker` interface is the contract that Redis impl will honor.
- **Watermark translation depends on the in-memory conversation record.** The Messenger/IG read path reads the outbound queue off the conversation record, so it surfaces reads only while that record (and its sent items) are still present.

See [Read receipts](./read-receipts.md), [Operational visibility](./operational-visibility.md), [Ordered delivery](./ordered-delivery.md), and [Known gaps](../KNOWN-GAPS.md).
