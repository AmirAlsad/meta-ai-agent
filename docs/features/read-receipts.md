# Read receipts

## What it does

Read receipts come in two directions, and this doc separates them because they are different mechanisms:

- **Inbound read tracking (Stage 6, observability).** When the *user* reads one of *our* outbound messages, Meta tells us. The [status tracker](./status-tracking.md) records that as a `read` status. This is observability only — it does not drive the conversation or the outbound queue.
- **Outbound mark-read (Stage 4/5 adapters).** Marking the *user's inbound* message as read/seen so the user sees the blue ticks / "seen" indicator. This is an adapter capability (`markRead` / `mark_seen`) gated by the `READ_RECEIPTS_ENABLED` knob and the per-channel `supports('read_receipt')`.

## Inbound read tracking (observability)

### Per channel

| Channel | Webhook | Granularity | `DeliveryStatus` |
| --- | --- | --- | --- |
| WhatsApp | `statuses[]` with `status: read` | per-message (real wamid) | `read` |
| Messenger | `message_reads` | READ WATERMARK (a timestamp) | `read` |
| Instagram | `messaging_seen` | READ WATERMARK (a timestamp) | `read` |

WhatsApp emits a `read` status keyed by the real wamid, so the agent records it 1:1 via the tracker's `applyStatusUpdate` (same path as `sent`/`delivered`/`failed`).

Messenger and Instagram do not give a per-message id. Their read event carries a **watermark**: "everything sent at or before this timestamp has been read." In the parser, a Messenger/IG read event uses the watermark as the `StatusUpdate.channelMessageId` ([`src/meta/types.ts`](../../src/meta/types.ts) — `read?: { watermark?: number }`).

### The watermark → message-id translation

Because a watermark is not an id, the agent translates it. In `handleStatus` ([`src/conversation/agent.ts`](../../src/conversation/agent.ts)), when a `read` status on a non-WhatsApp channel has no outbound-handle mapping (the watermark isn't a real id, so the pre-lookup misses) but does carry the user/business ids, the agent derives the conversation key and runs `handleReadWatermarkImpl` under that key's lock. That handler scans the conversation's own outbound queue for items actually sent at or before the watermark and hands those concrete ids to the tracker:

```typescript
const messageIds = record.outboundQueue
  .filter(item => item.channelMessageId && item.sentAt !== undefined && item.sentAt <= status.timestamp)
  .map(item => item.channelMessageId!);
// ...
this.statusTracker?.applyReadWatermark({
  messageIds, channel: status.channel, watermark: status.timestamp, conversationKey: key
});
```

`applyReadWatermark` only advances ids the tracker already knows (it never invents a record from a watermark), so an id whose `sent` was never recorded is skipped. See [Status tracking](./status-tracking.md) for the tracker internals.

### Inbound read tracking does NOT drive queue advancement

Messenger and Instagram are **advance-on-send**: `statusAdvancesQueue` returns false for them, so the outbound queue advanced the moment each send's API call returned (see [Ordered delivery](./ordered-delivery.md)). By the time a read watermark arrives, the queue has long since moved on. `handleReadWatermarkImpl` is therefore purely informational — it updates status history and the `status_callback_total{status:'read'}` metric and nothing else. It must not advance, skip, or re-open a queue item.

WhatsApp's queue advances on `sent`/`delivered` (`on_status`), **not** on `read` — `statusAdvancesQueue('whatsapp', 'read')` is false. So even on WhatsApp a `read` status is recorded in the tracker but does not move the queue; the queue already advanced when `delivered` (or the delivery-timeout fallback) fired.

### Where reads surface

A recorded read shows up as `current: 'read'` (read is the top success rank) and a `read` entry in `history` on the [`GET /admin/status/:messageId`](./operational-visibility.md) record, and in the `status_callback_total{channel,status:'read'}` counter.

## Outbound mark-read (`READ_RECEIPTS_ENABLED`)

The `READ_RECEIPTS_ENABLED` env var (default `false`) loads onto `config.conversation.readReceiptsEnabled` ([`src/config/loader.ts`](../../src/config/loader.ts)). When enabled, the conversation agent marks the **user's inbound** message read/seen once per turn (see [Agent wiring](#agent-wiring) below) — distinct from the inbound read *tracking* above.

The adapters implement the underlying capability:

- **WhatsApp** — `markRead(to, messageId)` POSTs `{ messaging_product: 'whatsapp', status: 'read', message_id }`. Note that WhatsApp's typing indicator is a *combined* call that marks the inbound message read AND attaches the typing bubble in one request, so when the agent emits a typing indicator before a text reply it implicitly marks the triggering inbound read (see [Outbound clients](./outbound-clients.md) and the WhatsApp combined-call constraint in [CLAUDE.md](../../CLAUDE.md)). `supports('read_receipt')` is `true`.
- **Messenger** — `markRead` issues a standalone `{ recipient: { id }, sender_action: 'mark_seen' }` request (a watermark mark, conversation-scoped, not per-message). `supports('read_receipt')` is `true`.
- **Instagram** — `markRead` issues a standalone `sender_action: 'mark_seen'` POST on `graph.instagram.com` (live-verified working 2026-05-20). `supports('read_receipt')` is `true`.

### Agent wiring

`ConversationAgent.maybeMarkRead` ([`src/conversation/agent.ts`](../../src/conversation/agent.ts)) fires the read receipt inside `flushImpl`, **before the chat-endpoint call**, gated on `config.conversation.readReceiptsEnabled` AND `adapter.supports('read_receipt')`. Running before the chat call is the load-bearing detail: a turn whose response is **silence**, a **reaction only**, or even a **chat-endpoint error** still marks the user's message read. The read receipt is fully decoupled from the typing indicator.

- **What gets marked.** WhatsApp marks the most recent inbound message (`record.lastInboundMessageId`); a rapid burst marks only the latest. Messenger and Instagram issue a single `mark_seen` (thread-scoped watermark), so one call covers the whole burst regardless.
- **Fail-soft.** A `markRead` failure is logged at `warn` and swallowed — it never blocks the chat call or the reply.
- **Metric.** Each attempt increments `outbound_send_total{operation:'mark_read', result}` (with `error_code` via `normalizeErrorCodeLabel` on failure).
- **Relationship to typing.** When both `READ_RECEIPTS_ENABLED` and `OUTBOUND_TYPING_INDICATORS_ENABLED` are on and the reply contains text, WhatsApp receives two read signals — the explicit `markRead` at flush and the typing indicator's combined `status:'read'` call before the text. Both are idempotent on Meta's side, so this is harmless; WhatsApp's typing API cannot show a typing bubble *without* marking read.

## Code files

| File | Role |
| --- | --- |
| [`src/conversation/agent.ts`](../../src/conversation/agent.ts) | `maybeMarkRead` (outbound mark-read at flush, gated on `READ_RECEIPTS_ENABLED`), `handleStatusImpl` (WhatsApp `read` 1:1), `handleReadWatermarkImpl` (Messenger/IG watermark translation). |
| [`src/status/tracker.ts`](../../src/status/tracker.ts) | `applyReadWatermark` — marks the translated ids `read`. |
| [`src/meta/types.ts`](../../src/meta/types.ts) | `StatusUpdate` + the `read.watermark` parse. |
| [`src/meta/whatsapp/client.ts`](../../src/meta/whatsapp/client.ts), [`src/meta/messenger/client.ts`](../../src/meta/messenger/client.ts), [`src/meta/instagram/client.ts`](../../src/meta/instagram/client.ts) | `markRead` / `mark_seen` outbound capability. |
| [`src/config/loader.ts`](../../src/config/loader.ts) | `READ_RECEIPTS_ENABLED` → `conversation.readReceiptsEnabled`. |

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `READ_RECEIPTS_ENABLED` | `false` | When `true`, the agent marks the user's inbound message read/seen once per turn — at flush, before the chat call — on channels whose adapter `supports('read_receipt')`. See [Agent wiring](#agent-wiring). |

See [Configuration](./configuration.md) for the full env reference.

## Known limitations

- **Inbound read tracking is observability-only** — it does not advance the queue on any channel.
- **Messenger/IG reads are watermark-derived** — they surface only for outbound items still present on the in-memory conversation record (sent, with a `sentAt`).
- **Outbound mark-read targets the latest inbound on WhatsApp** — a multi-message burst marks only the most recent message read, not each one individually. Messenger/IG `mark_seen` is thread-scoped, so this distinction is WhatsApp-only.
- **WhatsApp double-read when typing is also on** — see the typing note under [Agent wiring](#agent-wiring); idempotent and harmless.

See [Status tracking](./status-tracking.md), [Ordered delivery](./ordered-delivery.md), [Outbound clients](./outbound-clients.md), and [Operational visibility](./operational-visibility.md).
