/**
 * Identity types.
 *
 * Stage 5 only needs the {@link Contact} shape — the resolved identity that
 * rides on a {@link ConversationRecord} and is forwarded to the chat endpoint.
 * The full `IdentityResolver` (optional enrichment over `USER_LOOKUP_URL`,
 * fail-open) lands in Stage 6; this file deliberately stays minimal so the
 * conversation/chat layers can compile and import a stable `Contact` now.
 */

/**
 * A resolved contact for the OTHER party (the user) on a conversation.
 *
 * `channel` is a plain string (not the `Channel` union) so a developer's
 * resolver can return contacts for channels this package does not model
 * without a type clash. All enrichment fields are optional — an unresolved
 * contact is just `{ channel, channelScopedUserId }`.
 */
export interface Contact {
  /** Originating channel, e.g. `whatsapp` / `messenger` / `instagram`. */
  channel: string;
  /** Channel-scoped id of the user — `wa_id` / PSID / IGSID. */
  channelScopedUserId: string;
  firstName?: string;
  lastName?: string;
  displayName?: string;
  email?: string;
  /** Free-form labels (e.g. `["tier:gold"]`). */
  tags?: string[];
  /** Arbitrary string-valued metadata the resolver wants to surface. */
  customVariables?: Record<string, string>;
  /**
   * Stable cross-channel id set by the developer's resolver to link the same
   * person across WhatsApp / Messenger / Instagram. This package never
   * synthesizes it — conversation keying stays per-channel; unification is the
   * resolver's job.
   */
  unifiedContactId?: string;
}
