/**
 * Runtime Graph API HTTP client.
 *
 * This is the transport the per-channel send clients (WhatsApp / Messenger /
 * Instagram, built on top of this) use at runtime. Unlike the setup-time
 * `graphFetch` in `scripts/lib/graph-api.ts` — which is a thin one-shot
 * wrapper — this client adds **retry with exponential backoff** for transient
 * failures and sends the access token as an `Authorization: Bearer` header
 * rather than a query parameter.
 *
 * It is deliberately TRANSPORT-ONLY: no channel-specific body shapes, no
 * knowledge of `messaging_product` / `recipient` / `sender_action`. The
 * per-channel clients own that and call {@link GraphClient.request}.
 *
 * NEVER log access tokens or full request bodies — only redacted shapes
 * (operation, attempt, status, delay).
 */

import type pino from 'pino';
import { MetaApiError } from './errors.js';

const DEFAULT_HOST = 'graph.facebook.com';
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_BACKOFF_MS = 500;
const DEFAULT_MAX_BACKOFF_MS = 8000;

export type GraphHost = 'graph.facebook.com' | 'graph.instagram.com';

export interface GraphClientOptions {
  /** Graph API version, e.g. `config.meta.graphApiVersion` (`'v25.0'`). */
  apiVersion: string;
  /** Injectable fetch (defaults to `globalThis.fetch`) — overridden in tests. */
  fetchImpl?: typeof fetch;
  /**
   * Injectable sleep (defaults to a real `setTimeout`). Tests inject a
   * recording no-op so retries incur NO real delay.
   */
  sleep?: (ms: number) => Promise<void>;
  /** Max retries AFTER the first attempt. Default 3 → up to 4 total attempts. */
  maxRetries?: number;
  /** Base backoff in ms for the exponential schedule. Default 500. */
  baseBackoffMs?: number;
  /** Upper bound on any single backoff delay. Default 8000. */
  maxBackoffMs?: number;
  /** Optional structured logger for retry diagnostics. */
  logger?: Pick<pino.Logger, 'warn' | 'debug'>;
}

export interface GraphRequestOptions {
  method: 'GET' | 'POST' | 'DELETE';
  /** Target host. Default `graph.facebook.com`. */
  host?: GraphHost;
  /** Endpoint path WITHOUT leading slash and WITHOUT version prefix, e.g. `'{phoneNumberId}/messages'`. */
  path: string;
  /** Query params. `undefined` values are dropped; numbers/booleans stringify. */
  query?: Record<string, string | number | boolean | undefined>;
  /** JSON request body. Serialized with `JSON.stringify` when present. */
  body?: unknown;
  /** Access token — sent as `Authorization: Bearer <token>`, never in the query string. */
  accessToken: string;
  /** Free-form label for errors/logs, e.g. `'whatsapp.sendText'`. */
  operation: string;
  /** Include the version segment in the URL. Default true. */
  versioned?: boolean;
  /**
   * Whether the request is safe to retry on a 5xx (server error). Defaults to
   * `true` for GET and `false` for POST/DELETE. See the retry decision matrix
   * in {@link GraphClient.request} for why this gates 5xx retries specifically.
   */
  idempotent?: boolean;
}

export class GraphClient {
  private readonly apiVersion: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly logger?: Pick<pino.Logger, 'warn' | 'debug'>;

  constructor(opts: GraphClientOptions) {
    this.apiVersion = opts.apiVersion;
    // Bind to globalThis so the default fetch keeps its correct `this`.
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.sleep = opts.sleep ?? defaultSleep;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.baseBackoffMs = opts.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
    this.maxBackoffMs = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    if (opts.logger) this.logger = opts.logger;
  }

  /**
   * Build the full Graph API URL: `https://{host}/{version}/{path}?{query}`.
   * Exposed for testing and advanced callers. The version segment is omitted
   * when `versioned === false`.
   */
  buildUrl(opts: Pick<GraphRequestOptions, 'host' | 'path' | 'query' | 'versioned'>): string {
    const host = opts.host ?? DEFAULT_HOST;
    const versioned = opts.versioned ?? true;
    const trimmedPath = opts.path.replace(/^\/+/, '');
    const prefix = versioned ? `https://${host}/${this.apiVersion}` : `https://${host}`;
    const qs = buildQueryString(opts.query);
    const base = `${prefix}/${trimmedPath}`;
    return qs.length > 0 ? `${base}?${qs}` : base;
  }

  /**
   * Perform a Graph API request with retry/backoff. Returns the parsed JSON
   * body as `T` on 2xx (an empty 200 body yields `{}`). Throws
   * {@link MetaApiError} on a non-2xx response or a transport failure.
   *
   * RETRY DECISION MATRIX (the subtle part):
   *
   *   - 429 (rate limited)        → ALWAYS retry, regardless of method. Meta
   *     rejected the request before processing it, so re-sending is safe even
   *     for a non-idempotent POST.
   *   - network error (status 0)  → ALWAYS retry, regardless of method. fetch
   *     rejected before any response, so the request never reached Meta (or we
   *     never learned that it did) — re-sending cannot double-apply it.
   *   - 5xx (server error)        → retry ONLY when `idempotent === true`.
   *     WHY: a 5xx AFTER a POST is ambiguous — Meta may have already accepted
   *     and sent the message before the error surfaced. Retrying a POST send
   *     could DOUBLE-SEND. So 5xx is retried for GET (idempotent by default)
   *     but NOT for POST/DELETE unless the caller explicitly opts in via
   *     `idempotent: true`.
   *   - any other 4xx             → NEVER retry (deterministic client error;
   *     re-sending changes nothing and burns rate budget).
   *
   * Backoff: honors a `Retry-After` header (seconds or HTTP-date), capped at
   * `maxBackoffMs`. Otherwise `min(maxBackoffMs, baseBackoffMs * 2^attempt)`
   * plus jitter (random 0–baseBackoffMs).
   */
  async request<T = unknown>(opts: GraphRequestOptions): Promise<T> {
    const idempotent = opts.idempotent ?? opts.method === 'GET';
    const url = this.buildUrl(opts);
    const init = this.buildInit(opts);

    // attempt 0 is the initial try; attempts 1..maxRetries are retries.
    let lastError: MetaApiError | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let result: AttemptResult<T>;
      try {
        result = await this.attempt<T>(url, init, opts);
      } catch (err) {
        // Network/transport failure before any response (httpStatus 0).
        const causeMessage = err instanceof Error ? err.message : String(err);
        const networkError = new MetaApiError({
          operation: opts.operation,
          httpStatus: 0,
          responseBody: causeMessage,
          message: `Meta Graph API ${opts.operation} failed before response: ${causeMessage}`,
          cause: err
        });
        lastError = networkError;
        // Pre-response network failure is always safe to retry.
        if (attempt < this.maxRetries) {
          await this.backoff({ operation: opts.operation, attempt, status: 0, retryAfter: undefined });
          continue;
        }
        throw networkError;
      }

      if (result.ok) return result.value;

      lastError = result.error;
      const status = result.error.httpStatus;
      if (attempt < this.maxRetries && isRetryable(status, idempotent)) {
        await this.backoff({
          operation: opts.operation,
          attempt,
          status,
          retryAfter: result.retryAfter
        });
        continue;
      }
      throw result.error;
    }

    // Unreachable in practice (the loop always returns or throws), but the
    // type system needs a terminal throw. Surface the last captured error.
    throw lastError ?? new MetaApiError({
      operation: opts.operation,
      httpStatus: 0,
      responseBody: 'retry loop exhausted with no captured error'
    });
  }

  /** Build the `RequestInit` once (reused across retry attempts). */
  private buildInit(opts: GraphRequestOptions): RequestInit {
    const headers: Record<string, string> = {
      // WHY Bearer header (not access_token query param): proxies, CDNs, and
      // server access logs routinely record full query strings — putting the
      // token there leaks it into logs. Sending it as an Authorization header
      // keeps it out of URLs. Stage 3's review made this choice for the
      // webhook surface; we keep it consistent for outbound calls too.
      authorization: `Bearer ${opts.accessToken}`
    };
    const init: RequestInit = { method: opts.method, headers };
    if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    return init;
  }

  /** Perform one HTTP attempt; classify the response into ok/error. */
  private async attempt<T>(
    url: string,
    init: RequestInit,
    opts: GraphRequestOptions
  ): Promise<AttemptResult<T>> {
    const response = await this.fetchImpl(url, init);

    // Read the body as text first so we can attempt JSON parse on any status
    // without losing the raw bytes if parsing fails.
    const rawText = await response.text();
    const parsed = tryParseJson(rawText);

    if (response.ok) {
      // Some endpoints 200 with an empty body — normalize that to `{}` so the
      // caller always gets an object back rather than null/undefined.
      const value = (parsed === undefined ? {} : parsed) as T;
      return { ok: true, value };
    }

    // Non-2xx: extract Meta's error envelope when present. The shape is
    // consistent across products:
    // { error: { message, type, code, error_subcode, fbtrace_id } }.
    const errorObj =
      typeof parsed === 'object' && parsed !== null
        ? ((parsed as { error?: unknown }).error as Record<string, unknown> | undefined)
        : undefined;
    const errorCode = typeof errorObj?.['code'] === 'number' ? (errorObj['code'] as number) : undefined;
    const errorSubCode =
      typeof errorObj?.['error_subcode'] === 'number' ? (errorObj['error_subcode'] as number) : undefined;
    const fbtraceId =
      typeof errorObj?.['fbtrace_id'] === 'string' ? (errorObj['fbtrace_id'] as string) : undefined;

    const error = new MetaApiError({
      operation: opts.operation,
      httpStatus: response.status,
      ...(errorCode !== undefined ? { errorCode } : {}),
      ...(errorSubCode !== undefined ? { errorSubCode } : {}),
      ...(fbtraceId !== undefined ? { fbtraceId } : {}),
      // Hand back the parsed object when JSON parsing succeeded so callers can
      // inspect `error.error` directly; otherwise the raw text.
      responseBody: parsed ?? rawText
    });

    return { ok: false, error, retryAfter: parseRetryAfter(response.headers.get('retry-after')) };
  }

  /** Compute the delay, log the retry, and sleep. */
  private async backoff(args: {
    operation: string;
    attempt: number;
    status: number;
    retryAfter: number | undefined;
  }): Promise<void> {
    const delayMs = this.computeDelay(args.attempt, args.retryAfter);
    this.logger?.warn(
      { operation: args.operation, attempt: args.attempt, status: args.status, delayMs },
      'graph request retrying'
    );
    await this.sleep(delayMs);
  }

  /**
   * `Retry-After` (when present and parseable) takes precedence — capped at
   * `maxBackoffMs`. Otherwise exponential backoff with full jitter:
   * `min(maxBackoffMs, baseBackoffMs * 2^attempt) + random(0, baseBackoffMs)`.
   */
  private computeDelay(attempt: number, retryAfter: number | undefined): number {
    if (retryAfter !== undefined) {
      return Math.min(this.maxBackoffMs, retryAfter);
    }
    const exponential = Math.min(this.maxBackoffMs, this.baseBackoffMs * 2 ** attempt);
    const jitter = Math.random() * this.baseBackoffMs;
    return exponential + jitter;
  }
}

interface AttemptOk<T> {
  ok: true;
  value: T;
}
interface AttemptErr {
  ok: false;
  error: MetaApiError;
  /** Parsed `Retry-After` (ms) when the server supplied one. */
  retryAfter: number | undefined;
}
type AttemptResult<T> = AttemptOk<T> | AttemptErr;

/**
 * Decide whether a non-2xx status is retryable given the request's
 * idempotency. See the matrix in {@link GraphClient.request}.
 */
function isRetryable(status: number, idempotent: boolean): boolean {
  if (status === 429) return true; // rate limited — always safe (not processed)
  if (status >= 500) return idempotent; // 5xx — only when safe to repeat
  return false; // any other 4xx — deterministic, do not retry
}

function buildQueryString(query: GraphRequestOptions['query']): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    params.append(key, typeof value === 'string' ? value : String(value));
  }
  return params.toString();
}

function tryParseJson(raw: string): unknown {
  if (raw.length === 0) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * Parse a `Retry-After` header into milliseconds. Supports both documented
 * forms: a delay in seconds (e.g. `"2"`) or an HTTP-date (e.g.
 * `"Wed, 21 Oct 2026 07:28:00 GMT"`). Returns `undefined` when absent or
 * unparseable. A past HTTP-date clamps to 0.
 */
function parseRetryAfter(header: string | null): number | undefined {
  if (header === null) return undefined;
  const trimmed = header.trim();
  if (trimmed === '') return undefined;
  // Numeric form: seconds.
  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10) * 1000;
  }
  // HTTP-date form.
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return undefined;
  return Math.max(0, dateMs - Date.now());
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
