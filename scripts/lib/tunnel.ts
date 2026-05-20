/**
 * ngrok tunnel wrapper for setup / capture scripts.
 *
 * WHY ngrok: it's the lowest-friction local-dev exposure mechanism — Meta
 * requires a public HTTPS callback URL for webhook subscription, and ngrok
 * gives us one in seconds without DNS / TLS-cert plumbing.
 *
 * WHY @ngrok/ngrok (the SDK) over the legacy `ngrok` package: the SDK is a
 * native Node binding to libngrok, so it does NOT require a separately-
 * installed ngrok binary on the developer's PATH. Everything runs from
 * `npm install` with zero out-of-band setup.
 */
import { forward, type Config as NgrokConfig, type Listener } from '@ngrok/ngrok';

export interface TunnelOptions {
  /** Local port the agent / capture server is listening on. */
  port: number;
  /**
   * ngrok auth token. Falls back to `process.env.NGROK_AUTHTOKEN`. Required
   * — ngrok refuses to start tunnels for anonymous sessions.
   */
  authtoken?: string;
  /**
   * Reserved static ngrok domain (bare hostname, e.g.
   * `my-stable-app.ngrok-free.app`). REQUIRED across the repo: all callers
   * read it from `loadConfig().ngrokDomain`. Pinning a static domain avoids
   * re-registering the webhook callback URL in three Meta Dashboard
   * configurations every time an ephemeral tunnel rotates. Reserve a free
   * one at https://dashboard.ngrok.com/cloud-edge/domains.
   */
  domain: string;
  /** ngrok region. Defaults to the closest geo region if omitted. */
  region?: string;
}

export interface ActiveTunnel {
  /** Public HTTPS URL (no trailing slash). Safe to use as a webhook callback. */
  url: string;
  /** Shut the tunnel down. Idempotent. */
  close(): Promise<void>;
}

/**
 * NgrokForwarder is exported so tests can inject a fake forwarder without
 * actually opening a tunnel.
 */
export type NgrokForwarder = (config: NgrokConfig) => Promise<Pick<Listener, 'url' | 'close'>>;

const MISSING_AUTHTOKEN_REMEDIATION =
  'Missing NGROK_AUTHTOKEN. Create a free ngrok account at https://dashboard.ngrok.com/signup, ' +
  'copy your authtoken from https://dashboard.ngrok.com/get-started/your-authtoken, ' +
  'and add it to .env as NGROK_AUTHTOKEN=...';

/**
 * Start an ngrok tunnel and return its public HTTPS URL plus a `close()` hook.
 * Throws a remediation-rich error if no authtoken is provided.
 */
export async function startTunnel(
  opts: TunnelOptions,
  forwarder: NgrokForwarder = forward
): Promise<ActiveTunnel> {
  const authtoken = opts.authtoken ?? process.env.NGROK_AUTHTOKEN;
  if (!authtoken || authtoken.trim() === '') {
    throw new Error(MISSING_AUTHTOKEN_REMEDIATION);
  }

  const config: NgrokConfig = {
    addr: opts.port,
    authtoken,
    domain: opts.domain
  };
  if (opts.region) config.region = opts.region;

  const listener = await forwarder(config);
  // tunnel.url() returns the public URL; we trim the trailing slash so callers
  // can append paths without worrying about double slashes.
  const rawUrl = listener.url();
  const normalized = normalizeTunnelUrl(rawUrl);
  if (!normalized) {
    // Bail loudly if ngrok handed us something we can't use. This should never
    // happen with a valid authtoken but protects against SDK regressions.
    await listener.close().catch(() => undefined);
    throw new Error(
      `ngrok returned an unexpected URL (${String(rawUrl)}) — expected an https:// public URL.`
    );
  }

  return {
    url: normalized,
    close: () => listener.close()
  };
}

/**
 * Strip trailing slashes and verify the URL is HTTPS. Exported so capture-
 * server tests can use the same normalization without re-importing ngrok.
 */
export function normalizeTunnelUrl(url: string | null): string | undefined {
  if (!url) return undefined;
  const stripped = url.replace(/\/+$/, '');
  return stripped.startsWith('https://') ? stripped : undefined;
}
