# Instagram platform features

Instagram-specific surfaces that have no Messenger/WhatsApp equivalent:

- **Ice breakers** — setup-time conversation starters
  ([`InstagramIceBreakers`](../../src/meta/instagram/ice-breakers.ts)).
- **Private replies** — the comment-to-DM funnel
  ([`InstagramClient.sendPrivateReply`](../../src/meta/instagram/client.ts)).

Both target the Instagram-Login flavor on host **`graph.instagram.com`** (the
Business-Login token this package issues), with the access token in an
`Authorization: Bearer` header — never the URL.

> Instagram has **no Get Started button and no persistent menu** — those are
> Messenger-only profile surfaces. `InstagramClient.supports('get_started')` and
> `supports('persistent_menu')` stay **`false`**; only `supports('ice_breakers')`
> flips **`true`** in Stage 8. See
> [Outbound clients](./outbound-clients.md#the-supports-capability-matrix).

## Ice breakers

[`src/meta/instagram/ice-breakers.ts`](../../src/meta/instagram/ice-breakers.ts)
(`InstagramIceBreakers`) manages the tappable prompts shown to a user who opens a
**new** DM thread with the business before they've typed anything — Instagram's
equivalent of an FAQ launcher. They are configured **once at setup time**
(out-of-band of the live message loop), which is why this is a standalone manager
and not part of [`InstagramClient`](./outbound-clients.md): the runtime send client
owns the per-message `/messages` surface and a rate pacer; this manager owns the
profile-configuration surface and is invoked by setup scripts, not on the inbound
hot path.

Configured via the messenger-profile surface **on the Instagram host**:
`POST | GET | DELETE {igUserId}/messenger_profile` on `graph.instagram.com`.

| Method | HTTP | Body / query |
| --- | --- | --- |
| `setIceBreakers([{ locale, callToActions }])` | `POST` | `{ platform: 'instagram', ice_breakers: [{ locale, call_to_actions: [{ question, payload }] }] }` |
| `getIceBreakers()` | `GET` | `?platform=instagram&fields=ice_breakers` |
| `deleteIceBreakers()` | `DELETE` | body `{ platform: 'instagram', fields: ['ice_breakers'] }` |

Behavior:

- **The `platform: 'instagram'` field is REQUIRED on every call.** Per Meta's
  "Instagram API with Instagram Login — ice breakers" reference, every
  `messenger_profile` call for Instagram (set/get/delete) must carry
  `platform: 'instagram'` — the call **fails live without it** (this surface is
  shared in shape with Messenger, and the platform field selects the IG variant). It
  is sent **in the body** for POST/DELETE and as a **query param** for GET.
- **Localized, ≤4 per locale.** Instagram supports multi-locale ice breakers (the
  `default` locale is the fallback when the user's locale has no entry); each locale
  carries at most 4 starters (`MAX_ICE_BREAKERS_PER_LOCALE`). The cap is **enforced
  locally** — `setIceBreakers` throws a clear, named error before the call so an
  oversized list fails fast rather than surfacing as an opaque Graph 400.
- `setIceBreakers` is a **full replace** of the `ice_breakers` profile field — pass
  every locale you want present in a single call.
- `getIceBreakers` returns the raw Graph envelope (typically
  `{ data: [{ ice_breakers: [...] }] }`) unmodified.
- `deleteIceBreakers` targets the named field in the request **body** (not a query),
  so it clears only `ice_breakers` and leaves any other profile fields untouched.

An `IceBreaker` is `{ question, payload }`: `question` is the prompt shown to the
user; `payload` is a developer-defined string echoed back as a **postback** when the
user taps the starter — the [webhook handler](./inbound-webhooks.md#postbacks-and-referrals)
routes on it to produce a canned reply.

> **Endpoint/host fidelity flag.** The source carries a reviewer note: the IG
> ice-breaker endpoint/host (`messenger_profile` on `graph.instagram.com`) and the
> required `platform` field match Meta's documented schema, but the host/path are
> worth live-verifying — Meta has historically served some IG profile config from
> `graph.facebook.com/{IG_USER_ID}/...` under the Facebook-Login flavor. Like other
> IG specifics in this package, confirm against the live API. See
> [Known gaps](../KNOWN-GAPS.md).

These ice breakers can be applied via the
[`setup:profile` script](./messenger-profile.md#the-setupprofile-script) (its
`instagram.iceBreakers` section).

## Private replies (comment-to-DM)

[`InstagramClient.sendPrivateReply(commentId, text)`](../../src/meta/instagram/client.ts)
turns a public comment on the business's post/reel into a **private DM thread**:
`POST {igUserId}/messages` on `graph.instagram.com`, with the recipient keyed by
`comment_id` instead of a user id:

```jsonc
{
  "recipient": { "comment_id": "<commentId>" },
  "message": { "text": "<text>" }
}
```

Load-bearing details:

- **`recipient.comment_id` (NOT `recipient.id`) is what makes it a private reply.**
  The `comment_id` key is what makes Meta treat this as a Private Reply (delivering
  the DM to the comment's author and opening the thread); a `recipient.id` body is an
  ordinary DM and is **not** a reply to the comment. The two are mutually exclusive —
  this method always uses `comment_id`.
- **7-day window.** A private reply is a **single** message and must be sent within
  **7 days** of the comment being posted. This is **distinct** from the standard
  24-hour messaging window — the comment-to-DM funnel gets its own 7-day,
  one-message allowance. The window is **not enforced client-side**: outside it (or
  after a reply has already been sent for that comment) Meta rejects the call, which
  surfaces as a `MetaApiError` for the caller to fail-soft on. See
  [Known gaps](../KNOWN-GAPS.md).
- **Permission.** Requires the `instagram_business_manage_comments` permission.
- Routed through the **same** `send` path (and thus the [rate pacer](./outbound-clients.md#instagram--srcmetainstagramclientts))
  as every other IG send. The returned `SendResult.recipientId` is the **comment
  id** (the reply is keyed to the comment, not a user id), giving callers a stable
  correlation key.

`sendPrivateReply` is **not** part of the uniform
[`ChannelAdapter`](./outbound-clients.md#the-channeladapter-interface) surface — it
is an Instagram-specific method on `InstagramClient`, called directly by code that
implements a comment-to-DM funnel (the conversation agent does not invoke it).

## Code references

Source:

- [`src/meta/instagram/ice-breakers.ts`](../../src/meta/instagram/ice-breakers.ts)
  — `InstagramIceBreakers` (the required `platform: 'instagram'` field, the ≤4 local
  cap, the `messenger_profile` set/get/delete shapes on `graph.instagram.com`).
- [`src/meta/instagram/client.ts`](../../src/meta/instagram/client.ts) —
  `sendPrivateReply` (the `recipient.comment_id` body, the 7-day window note) and
  the `supports()` matrix (`ice_breakers` true; `get_started` / `persistent_menu`
  false).

Tests (see [Testing](../TESTING.md)):

- [`tests/unit/instagram-ice-breakers.test.ts`](../../tests/unit/instagram-ice-breakers.test.ts)
  — the exact set/get/delete bodies + query (asserting `platform: 'instagram'` is
  present everywhere), the host (`graph.instagram.com`), and the ≤4 local throw.
- [`tests/unit/instagram-client.test.ts`](../../tests/unit/instagram-client.test.ts)
  — `sendPrivateReply` asserts the `recipient.comment_id` body (not `recipient.id`),
  the host/path, and the comment-id `SendResult`.

Related: [Messenger profile](./messenger-profile.md) ·
[Outbound clients](./outbound-clients.md) ·
[Setup verification](./setup-verification.md) ·
[Inbound webhooks](./inbound-webhooks.md) (postbacks fired by ice-breaker taps) ·
[Known gaps](../KNOWN-GAPS.md).
