/**
 * Canonical Meta Graph API error type, shared across the setup-time helper
 * (`scripts/lib/graph-api.ts`) and the runtime client
 * (`src/meta/shared/graph-client.ts`).
 *
 * Scope discipline: `src/` is the published package and must NEVER import from
 * `scripts/`. The dependency direction is `scripts/ → src/` only, so the error
 * class lives here and `scripts/lib/graph-api.ts` re-exports it. This file is
 * intentionally dependency-free (no fetch, no config) so both surfaces can
 * share it without dragging runtime concerns into setup scripts.
 *
 * All non-2xx Graph API responses are wrapped in {@link MetaApiError} with
 * parsed Meta error JSON (error.code / error.error_subcode / error.fbtrace_id)
 * so callers can branch on documented codes without regex-matching
 * `error.message` strings.
 *
 * NEVER log access tokens or app secrets via this error — only redacted shapes.
 */

export interface MetaApiErrorArgs {
  operation: string;
  httpStatus: number;
  errorCode?: number;
  errorSubCode?: number;
  fbtraceId?: string;
  responseBody: unknown;
  message?: string;
  /**
   * Underlying error (e.g. the original network exception from fetch).
   * Passed to `Error`'s `cause` option so `.cause` is exposed on instances
   * and the V8 stack chain preserves the inner trace. JavaScript's Error
   * spec accepts `unknown` for `cause`; we preserve that flexibility.
   */
  cause?: unknown;
}

/**
 * Thrown by the Graph API helpers on non-2xx responses (and on transport
 * failures with `httpStatus: 0`). Carries enough structured detail for
 * callers to branch on documented Meta error codes without parsing
 * `error.message` strings.
 */
export class MetaApiError extends Error {
  readonly operation: string;
  readonly httpStatus: number;
  readonly errorCode?: number;
  readonly errorSubCode?: number;
  readonly fbtraceId?: string;
  readonly responseBody: unknown;

  constructor(args: MetaApiErrorArgs) {
    // Pass `cause` through to `Error`'s constructor so the V8 stack chain
    // links to the underlying transport exception (e.g. ECONNREFUSED). Only
    // forward `cause` when explicitly supplied — undefined `cause` would
    // still set `this.cause = undefined`, which is harmless but noisier.
    super(args.message ?? formatMessage(args), args.cause !== undefined ? { cause: args.cause } : undefined);
    this.name = 'MetaApiError';
    this.operation = args.operation;
    this.httpStatus = args.httpStatus;
    if (args.errorCode !== undefined) this.errorCode = args.errorCode;
    if (args.errorSubCode !== undefined) this.errorSubCode = args.errorSubCode;
    if (args.fbtraceId !== undefined) this.fbtraceId = args.fbtraceId;
    this.responseBody = args.responseBody;
  }
}

function formatMessage(args: MetaApiErrorArgs): string {
  const parts: string[] = [];
  parts.push(`Meta Graph API error during ${args.operation}`);
  parts.push(`(HTTP ${args.httpStatus}`);
  if (args.errorCode !== undefined) parts.push(`, code ${args.errorCode}`);
  if (args.errorSubCode !== undefined) parts.push(`, subcode ${args.errorSubCode}`);
  parts.push(')');
  if (args.fbtraceId) parts.push(` [fbtrace_id: ${args.fbtraceId}]`);
  // Surface the server-side error.message when we have it; falls back to a
  // truncated dump of the response body for full-context debugging.
  const inline = extractServerMessage(args.responseBody) ?? stringifyResponseBody(args.responseBody);
  if (inline) parts.push(`: ${inline}`);
  return parts.join('');
}

/**
 * Pull `error.message` out of a Meta error envelope when present. Exported so
 * the runtime client and setup helpers can reuse the exact same extraction
 * logic (e.g. when deciding whether to fall back to a manual-config hint).
 */
export function extractServerMessage(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const err = (body as { error?: unknown }).error;
  if (typeof err !== 'object' || err === null) return undefined;
  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' ? message : undefined;
}

function stringifyResponseBody(body: unknown): string {
  if (body === null || body === undefined) return '';
  if (typeof body === 'string') return body.length > 200 ? `${body.slice(0, 200)}…` : body;
  try {
    const json = JSON.stringify(body);
    return json.length > 200 ? `${json.slice(0, 200)}…` : json;
  } catch {
    return '<unserializable response body>';
  }
}
