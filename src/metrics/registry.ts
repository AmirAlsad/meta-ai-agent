import type { Counter, Gauge, Histogram, MetricsCollector } from './collector.js';
import { DEFAULT_LATENCY_BUCKETS_SECONDS } from './collector.js';

/**
 * The full set of named metric handles instrumented across the agent. Created
 * once per `createApp` call against the configured collector. Call sites pull
 * the specific handle they need from this registry; the registry shape is the
 * source of truth for label cardinality and bucket boundaries.
 *
 * Scope: Stage 6 (transport + observability). Stage 10 added the send-limit /
 * hardening metrics below (`transient_retry_total`,
 * `acquire_send_slot_delay_seconds`, `webhook_secret_rejections_total`).
 */
export type AgentMetrics = {
  webhookReceived: Counter;
  webhookParseFailures: Counter;
  inboundDedupe: Counter;
  inboundMessages: Counter;
  chatDispatchDuration: Histogram;
  outboundSendTotal: Counter;
  outboundSendDuration: Histogram;
  statusCallbackTotal: Counter;
  deliveryTimeoutFired: Counter;
  identityLookupTotal: Counter;
  bufferFlushTotal: Counter;
  agentUp: Gauge;
  agentBuildInfo: Gauge;
  /**
   * Stage 10: transient-retry outcomes for a failed outbound send. `outcome` is
   * `scheduled` (a retry was armed with backoff) or `exhausted` (the retry
   * budget ran out and the item was skipped). EMITTED by the conversation agent's
   * transient-retry path; registered here so the handle exists for it to pull.
   */
  transientRetryTotal: Counter;
  /**
   * Stage 10: wall-clock seconds a send waited at the per-channel pacing slot
   * (`LimitTracker.acquireSendSlot`). 0 == the slot was free. EMITTED by the
   * agent's `sendNext` pacing path; registered here.
   */
  acquireSendSlotDelaySeconds: Histogram;
  /**
   * Stage 10: inbound webhooks REJECTED at the signature-verification boundary,
   * by `reason`. EMITTED here from the signature verifier callback (the only
   * `AgentMetrics` handle whose emit lives outside the agent) — it counts the
   * requests that never reach the dispatcher's `webhook_received_total`.
   */
  webhookSecretRejectionsTotal: Counter;
};

/**
 * Known Meta error codes mapped to a bounded label set. This list is a
 * CARDINALITY GUARD, not an exhaustive catalogue of Meta error codes: Meta
 * surfaces hundreds of codes (and `error_data.details` strings) that would
 * blow up `error_code` label cardinality if forwarded verbatim. We pin the
 * codes we actually want to alert/dashboard on and fold everything else into
 * `other` (and a missing code into `none`). Add a code here only when a
 * dashboard or alert needs to distinguish it.
 *
 * Codes (illustrative, common Cloud API / Graph errors):
 *  100    – invalid parameter
 *  131030 – recipient not in allowed list
 *  131047 – re-engagement outside 24h customer-service window
 *  131051 – unsupported message type
 *  132000 – template param count mismatch
 *  190    – access token expired / invalid
 *  10     – permission denied
 *  200    – permission error
 *  368    – temporarily blocked for policy violations
 *  4      – application request limit reached (rate limit)
 *  80007  – business-account rate limit hit
 *  131056 – pair rate limit (too many messages to one number)
 */
const KNOWN_ERROR_CODES = new Set<string>([
  '100',
  '131030',
  '131047',
  '131051',
  '132000',
  '190',
  '10',
  '200',
  '368',
  '4',
  '80007',
  '131056'
]);

/**
 * Bound the `error_code` label to a known set so a runaway/hostile stream of
 * distinct codes can't explode metric cardinality. Unknown codes collapse to
 * `other`; a missing code collapses to `none`. Accepts numeric codes (Meta's
 * `MetaApiError.errorCode` / `StatusUpdate.errorCode` are numbers) as well as
 * pre-stringified values.
 */
export function normalizeErrorCodeLabel(code?: string | number): string {
  if (code === undefined || code === null || code === '') return 'none';
  const asString = typeof code === 'number' ? String(code) : code;
  return KNOWN_ERROR_CODES.has(asString) ? asString : 'other';
}

export function createAgentMetrics(collector: MetricsCollector): AgentMetrics {
  return {
    webhookReceived: collector.counter('webhook_received_total', {
      help: 'Meta webhooks received, broken down by channel and disposition.',
      labels: ['channel', 'result']
    }),
    webhookParseFailures: collector.counter('webhook_parse_failures_total', {
      help: 'Meta webhooks that passed signature validation but failed to parse.',
      labels: ['channel', 'reason']
    }),
    inboundDedupe: collector.counter('inbound_dedupe_total', {
      help: 'Inbound message dedupe outcomes keyed on the channel message id.',
      labels: ['result']
    }),
    inboundMessages: collector.counter('inbound_messages_total', {
      help: 'Inbound messages accepted for processing, by channel and message type.',
      labels: ['channel', 'type']
    }),
    chatDispatchDuration: collector.histogram('chat_dispatch_duration_seconds', {
      help: 'Wall-clock seconds spent in a single chat endpoint dispatch.',
      labels: ['result'],
      buckets: DEFAULT_LATENCY_BUCKETS_SECONDS
    }),
    outboundSendTotal: collector.counter('outbound_send_total', {
      help: 'Outbound actions attempted, by channel/operation/result/error_code.',
      labels: ['channel', 'operation', 'result', 'error_code']
    }),
    outboundSendDuration: collector.histogram('outbound_send_duration_seconds', {
      help: 'Wall-clock seconds for one outbound action (Meta Graph API call).',
      labels: ['channel', 'operation'],
      buckets: DEFAULT_LATENCY_BUCKETS_SECONDS
    }),
    statusCallbackTotal: collector.counter('status_callback_total', {
      help: 'Delivery-status callbacks observed, by channel and status.',
      labels: ['channel', 'status']
    }),
    deliveryTimeoutFired: collector.counter('delivery_timeout_fired_total', {
      help: 'Outbound delivery-timeout callbacks that fired without a terminal status.'
    }),
    identityLookupTotal: collector.counter('identity_lookup_total', {
      help: 'Identity-resolver lookup outcomes (fail-open enrichment).',
      labels: ['result']
    }),
    bufferFlushTotal: collector.counter('buffer_flush_total', {
      help: 'Conversation buffer flush outcomes.',
      labels: ['result']
    }),
    agentUp: collector.gauge('agent_up', {
      help: 'Always 1 while the process is serving HTTP requests.'
    }),
    agentBuildInfo: collector.gauge('agent_build_info', {
      help: 'Build/version metadata. Always 1; the version is encoded in the label.',
      labels: ['version']
    }),
    transientRetryTotal: collector.counter('transient_retry_total', {
      help: 'Transient-retry outcomes for failed outbound sends (scheduled vs exhausted).',
      labels: ['channel', 'outcome']
    }),
    acquireSendSlotDelaySeconds: collector.histogram('acquire_send_slot_delay_seconds', {
      help: 'Wall-clock seconds a send waited at the per-channel pacing slot.',
      labels: ['channel'],
      buckets: DEFAULT_LATENCY_BUCKETS_SECONDS
    }),
    webhookSecretRejectionsTotal: collector.counter('webhook_secret_rejections_total', {
      help: 'Inbound webhooks rejected at signature verification, by reason.',
      labels: ['reason']
    })
  };
}
