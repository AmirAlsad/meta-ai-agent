# Comments

Inbound comment handling for Facebook Pages and Instagram professional
accounts: parse the comment surfaces, ask the developer's endpoint what to do,
and execute the answer (public reply, comment-to-DM private reply, Facebook
like) as the owning account — with the same fail-soft, dedupe-first posture as
the messaging pipeline.

**Opt-in.** Nothing dispatches until `COMMENTS_ENABLED=true`. A transport that
starts answering public comments as a side effect of wiring credentials would
be a foot-gun; parsed comments are logged either way.

## Inbound: two paths, one shape

**Webhooks.** Comments arrive in `entry[].changes`, not `entry[].messaging`:

- Facebook Pages: field `feed`, which fires for far more than comments (likes,
  shares, publishes, edits, the Page's own actions). The parser keeps only
  `item: 'comment'` blocks. `created_time` arrives in Unix **seconds** —
  unlike the messaging events on the same webhook object — and is upscaled at
  the boundary.
- Instagram: field `comments`. Both observed envelope flavors are handled —
  the `changes[]` wrapper and the Instagram-Login flavor with `field`/`value`
  directly on the entry.

Both are subscribed by `npm run meta:webhooks` (`feed` on the Page,
`comments` on the IG user). The fields must live in the script's
`SUBSCRIBED_FIELDS` — the per-asset `subscribed_apps` POST *replaces* the
field set, so a manually-added field is clobbered on the next run.

**The Instagram poller.** IG comment webhook *delivery* requires Advanced
Access (the subscription itself is accepted at Standard; measured August
2026). At Standard Access the poller (`src/comments/ig-poller.ts`) covers the
gap: every `INSTAGRAM_COMMENT_POLL_SECONDS` (default 60) it lists each IG
account's recent media (`INSTAGRAM_COMMENT_MEDIA_LIMIT`, default 10, within
`INSTAGRAM_COMMENT_LOOKBACK_HOURS`, default 72) and reads each media's
comments, normalizing them into the same `IncomingComment` shape the webhook
path produces. The store-backed dedupe makes the two paths converge — on a
deploy that later gains Advanced Access, whichever path sees a comment first
claims it and the other is a no-op. Calls are paced (~600ms apart) under the
general ~2/s Graph ceiling and accounts sweep sequentially.

Facebook has no poller: `feed` webhooks deliver at Standard Access.

## Dispatch policy (`src/comments/agent.ts`)

The `CommentAgent` is deliberately **not** the ConversationAgent — comments
have no 24h window, no delivery callbacks, no burst buffering, and no
per-user conversation. It reuses the generic pieces: the conversation store's
SETNX dedupe, the `AdapterRegistry`, and the limit tracker's per-account
pacing. In order:

1. **Verb filter** — only `add` dispatches; `edited` / `remove` are logged.
2. **Self filter, allowlist-of-self** — both platforms echo the account's own
   comments back with **no `is_echo` flag** (measured ~1s on FB), so any
   comment whose author id matches *any* registered account's business id is
   dropped. This also hard-stops configured accounts from engaging each
   other's content at the transport level.
3. **Account resolution** — the registry entry for
   `(channel, channelScopedBusinessId)`; unclaimed assets are dropped with a
   warning. Facebook Page comments carry `channel: 'messenger'` — the Page's
   comment endpoints authenticate with the same Page token the Messenger
   adapter holds, and a fourth channel value would fork every
   `Record<Channel, …>` in the package.
4. **Dedupe** — `claimInboundHandle('comment:' + commentId)`.
5. **Chat call** — see the contract below. Silence is the *expected common
   answer*: selective, engagement-shaped replying is the correct posture for
   comments (full-coverage identical replying is the exact signature platform
   spam systems key on).
6. **Actions** — executed via the owning account's client, paced, each
   independently fail-soft.

### Identity: persist at receipt

Facebook comment **webhooks** carry the author's `from` (id + name) for any
author, but the corresponding **read** endpoints omit other people's `from`
at Standard Access — the identity gate bites on reads, not deliveries. So the
author identity that arrives on the webhook is not re-fetchable later; it is
carried on the `IncomingComment` and into the chat request, and endpoints
that want it durably must store it then. Instagram returns identity freely on
the polling path. Useful join: a commenter's id equals their DM-scoped id for
the same account (IG comment `from.id` == IGSID; FB comment id == Messenger
PSID — both measured), so a comment author and a DM sender can be recognized
as the same person.

## The comment chat contract

POSTed to `COMMENT_ENDPOINT_URL` (default: `CHAT_ENDPOINT_URL` — branch on
`kind`):

```jsonc
{
  "kind": "comment",
  "channel": "messenger",            // 'messenger' = Facebook Page surface
  "accountName": "official",
  "capabilities": ["reply", "private_reply", "like"],  // 'like' is FB-only
  "comment": {
    "commentId": "…", "postId": "…",
    "parentId": "…", "isReply": false,
    "text": "Testing",
    "from": { "id": "…", "name": "…" },
    "timestamp": 1785904973000,
    "permalinkUrl": "https://…",      // FB, when the webhook carried it
    "mediaProductType": "REELS"       // IG, when present
  }
}
```

Response: `{ "actions": [...] }` with `{type:'reply', text}`,
`{type:'private_reply', text}`, `{type:'like'}`, `{type:'silence'}` — or
`{"silence": true}`, or a legacy bare `{"message": "…"}` (one public reply).
Malformed actions warn and drop; `silence:true` beside real actions drops
everything (same mixed-silence rule as the DM contract).

`isReply` is best-effort on Facebook: `parent_id` is **not** a reliable
top-level indicator (a top-level reel comment carries `parent_id == post_id`,
while photo-post ids use a different prefix scheme — both measured). The rule
used: a parent that equals the post id, or shares its final `_`-segment, is a
top-level comment. Instagram's `parent_id` ⇔ reply is documented and
reliable.

## Outbound surface

`MessengerClient` and `InstagramClient` implement `CommentCapableClient`
(`src/meta/comments/types.ts`), all live-verified August 2026:

| Lever | Facebook Page | Instagram |
|---|---|---|
| Public reply | `POST /{comment-id}/comments` | `POST /{comment-id}/replies` (graph.instagram.com) |
| Private reply (comment→DM) | `POST /{page-id}/messages`, `recipient:{comment_id}` | `sendPrivateReply` (same body, IG host) |
| Like | `POST /{comment-id}/likes` | **none — no endpoint exists** |
| Delete (cleanup only, never endpoint-driven) | `DELETE /{comment-id}` | `DELETE /{comment-id}` |

Private replies are one message per comment within 7 days and do **not** open
a messaging window until the person replies. The Facebook comment levers need
`pages_manage_engagement` + `pages_read_user_content` on the Page token —
scopes the plain messaging login config does not carry. Instagram needs
`instagram_business_manage_comments`.

## Configuration

| Var | Default | Meaning |
|---|---|---|
| `COMMENTS_ENABLED` | `false` | Master switch for comment dispatch (webhook + poller). |
| `COMMENT_ENDPOINT_URL` | unset → `CHAT_ENDPOINT_URL` | Where `kind:'comment'` requests POST. |
| `INSTAGRAM_COMMENT_POLL_SECONDS` | `60` | IG poll interval; `0` disables the poller. |
| `INSTAGRAM_COMMENT_LOOKBACK_HOURS` | `72` | How long a media object stays in the poll set. |
| `INSTAGRAM_COMMENT_MEDIA_LIMIT` | `10` | Recent media considered per sweep. |
