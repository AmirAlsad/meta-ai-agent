/**
 * Webhook delivery-gap monitor.
 *
 * WHY: Meta silently UNSUBSCRIBES a Messenger webhook after ~1 hour of failed
 * deliveries, and recovery is a manual re-subscribe — there is no notification
 * of any kind. A deploy that crashed, hung, or lost its tunnel for an hour
 * comes back up healthy-looking and simply never receives another event. The
 * same silent-death shape applies to an expired IG token killing the per-user
 * subscription. This monitor turns "webhooks stopped arriving" into an
 * explicit, alertable error log instead of a discovery made days later.
 *
 * Semantics: for each channel that has received AT LEAST ONE webhook this
 * process lifetime, an error is logged when the time since the last receipt
 * exceeds the threshold — repeated once per subsequent threshold window while
 * the gap persists (re-alert, not log-spam). Channels that have never
 * delivered are NOT alerted on: a freshly-booted process cannot distinguish a
 * quiet account from a broken subscription, and alerting on silence-from-boot
 * would page every low-traffic deploy nightly. OPT-IN via
 * `WEBHOOK_GAP_ALERT_MINUTES` (0 = disabled).
 */

import type pino from 'pino';
import type { Channel } from '../meta/types.js';

export interface WebhookGapMonitorDeps {
  logger: pino.Logger;
  /** Gap length that triggers the alert (ms). */
  thresholdMs: number;
  /** How often to check (ms). Defaults to one quarter of the threshold. */
  checkIntervalMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export class WebhookGapMonitor {
  private readonly logger: pino.Logger;
  private readonly thresholdMs: number;
  private readonly checkIntervalMs: number;
  private readonly now: () => number;
  private readonly lastReceiptAt = new Map<Channel, number>();
  /** Last alert time per channel, so a persisting gap re-alerts once per window. */
  private readonly lastAlertAt = new Map<Channel, number>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(deps: WebhookGapMonitorDeps) {
    this.logger = deps.logger;
    this.thresholdMs = deps.thresholdMs;
    this.checkIntervalMs = deps.checkIntervalMs ?? Math.max(60_000, Math.floor(deps.thresholdMs / 4));
    this.now = deps.now ?? Date.now;
  }

  /** Record one webhook receipt for a channel. Cheap; called per delivery. */
  recordReceipt(channel: Channel): void {
    this.lastReceiptAt.set(channel, this.now());
    this.lastAlertAt.delete(channel);
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => this.check(), this.checkIntervalMs);
    // `unref` so the monitor alone never keeps a shutting-down process alive.
    this.timer.unref?.();
    this.logger.info({ thresholdMs: this.thresholdMs }, 'webhook delivery-gap monitor started');
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** One check pass. Public for tests. */
  check(): void {
    const now = this.now();
    for (const [channel, lastReceipt] of this.lastReceiptAt) {
      const gapMs = now - lastReceipt;
      if (gapMs < this.thresholdMs) continue;
      const lastAlert = this.lastAlertAt.get(channel);
      // Re-alert once per threshold window while the gap persists.
      if (lastAlert !== undefined && now - lastAlert < this.thresholdMs) continue;
      this.lastAlertAt.set(channel, now);
      this.logger.error(
        {
          channel,
          gapMs,
          lastReceiptAt: lastReceipt,
          traceMarker: 'webhook.delivery_gap' as const
        },
        'no webhooks received for longer than the alert threshold — check the Meta subscription ' +
          '(Messenger auto-unsubscribes after ~1h of failed delivery; an expired IG token kills ' +
          'the per-user subscription). Re-run `npm run meta:webhooks` after fixing the cause.'
      );
    }
  }
}
