/**
 * Multi-account adapter registry.
 *
 * The transport historically wired ONE account per channel (`Partial<Record<
 * Channel, ChannelAdapter>>`), which made outbound adapter selection the last
 * single-account seam in the package — inbound routing has been multi-account
 * from the start (conversation keys embed `channelScopedBusinessId`). This
 * registry closes that seam: adapters are keyed by `channel:businessId`, where
 * `businessId` is the same channel-scoped business id the parser normalizes
 * onto every {@link IncomingMessage} (WhatsApp `phone_number_id` / Messenger
 * Page id / Instagram user id), so the id that arrives on a webhook is the id
 * that selects the adapter that answers it.
 *
 * Resolution contract (see {@link AdapterRegistry.resolve}):
 *  1. Exact `channel:businessId` match wins.
 *  2. When the channel has EXACTLY ONE registered account, that account is
 *     returned for any businessId (or none). This preserves the historical
 *     single-account behavior — records persisted before this change, echo
 *     edge cases, and tests that construct records with arbitrary business ids
 *     all keep working unchanged on a one-account deploy.
 *  3. Otherwise `undefined` — on a genuinely multi-account channel a mismatch
 *     is ambiguous, and guessing would answer as the wrong identity. Callers
 *     treat this exactly like the old "channel not configured" branch.
 */

import type { Channel } from '../types.js';
import type { ChannelAdapter } from './adapter.js';

/** One registered account: a channel adapter plus the identity it answers as. */
export interface RegisteredAccount {
  channel: Channel;
  /**
   * Human-readable account name (`'default'` for the bare-env single-account
   * form, or the `__<name>` suffix from the multi-account env form). Threaded
   * into the chat request so one chat endpoint can serve several personas.
   */
  accountName: string;
  /**
   * Channel-scoped business id — the value inbound webhooks carry as
   * `channelScopedBusinessId`. Empty string ONLY for legacy channel-map
   * construction ({@link AdapterRegistry.fromChannelMap}), where the id is
   * unknown; such entries are reachable via the single-account fallback.
   */
  businessId: string;
  adapter: ChannelAdapter;
}

export class AdapterRegistry {
  /** Exact-match index, keyed `${channel}:${businessId}`. */
  private readonly byKey = new Map<string, RegisteredAccount>();
  /** Per-channel account lists, in registration order. */
  private readonly byChannel = new Map<Channel, RegisteredAccount[]>();

  /**
   * Register an account. Throws on a duplicate `channel:businessId` pair —
   * two adapters answering as the same identity is always a wiring bug, and
   * silently keeping either one would hide it.
   */
  register(account: RegisteredAccount): void {
    const key = `${account.channel}:${account.businessId}`;
    if (account.businessId !== '' && this.byKey.has(key)) {
      throw new Error(
        `Duplicate adapter registration for ${key} (accounts "${this.byKey.get(key)?.accountName}" and "${account.accountName}").`
      );
    }
    if (account.businessId !== '') this.byKey.set(key, account);
    const list = this.byChannel.get(account.channel) ?? [];
    list.push(account);
    this.byChannel.set(account.channel, list);
  }

  /**
   * Resolve the account that should answer for `(channel, businessId)`. See
   * the module doc for the three-step contract.
   */
  resolve(channel: Channel, businessId?: string): RegisteredAccount | undefined {
    if (businessId !== undefined && businessId !== '') {
      const exact = this.byKey.get(`${channel}:${businessId}`);
      if (exact) return exact;
    }
    const list = this.byChannel.get(channel);
    if (list && list.length === 1) return list[0];
    return undefined;
  }

  /** Every account registered for a channel (empty array when none). */
  accountsFor(channel: Channel): RegisteredAccount[] {
    return [...(this.byChannel.get(channel) ?? [])];
  }

  /** Every registered account across all channels. */
  allAccounts(): RegisteredAccount[] {
    return [...this.byChannel.values()].flat();
  }

  /** True when at least one account is registered for the channel. */
  hasChannel(channel: Channel): boolean {
    return (this.byChannel.get(channel)?.length ?? 0) > 0;
  }

  /**
   * Wrap the legacy single-account-per-channel adapter map. Each present
   * channel registers one `'default'` account with an UNKNOWN business id
   * (empty string) — reachable via the single-account fallback, exactly
   * matching the historical "any record on this channel gets this adapter"
   * behavior. Kept so existing constructors and tests that pass a plain map
   * keep working verbatim.
   */
  static fromChannelMap(map: Partial<Record<Channel, ChannelAdapter>>): AdapterRegistry {
    const registry = new AdapterRegistry();
    for (const [channel, adapter] of Object.entries(map) as Array<[Channel, ChannelAdapter | undefined]>) {
      if (!adapter) continue;
      registry.register({ channel, accountName: 'default', businessId: '', adapter });
    }
    return registry;
  }
}
