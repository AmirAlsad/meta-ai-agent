/**
 * Scheduled Instagram long-lived-token refresh.
 *
 * WHY this exists: Instagram Login tokens are a 60-DAY TREADMILL. They can be
 * refreshed unattended (`GET graph.instagram.com/refresh_access_token`) any
 * time between 24 hours and 60 days of age — but a LAPSED token has NO
 * unattended recovery, only a manual re-OAuth. The failure is silent until
 * something calls the API: a May-minted token aging out unnoticed took the
 * whole IG webhook subscription down with an HTTP 400 / code 190 (measured
 * August 2026). Run this on a schedule (cron/CI, weekly is ample) and alert
 * on a non-zero exit code.
 *
 * Behavior:
 *  - Refreshes EVERY configured Instagram account (default + `__<name>`).
 *  - Default is DRY-RUN-ish: prints the refreshed token masked and does NOT
 *    touch .env. `--write` rewrites each account's token line IN PLACE.
 *  - Exit codes: 0 all refreshed; 1 any account failed (the alerting hook).
 *
 * Usage:
 *   npm run tokens:refresh:instagram              # refresh, print masked
 *   npm run tokens:refresh:instagram -- --write   # refresh + rewrite .env
 *   npm run tokens:refresh:instagram -- --write --reveal
 */

import 'dotenv/config';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { loadConfig, configuredAccounts, type Config } from '../../src/config/loader.js';
import { info, success, warn, fail, divider } from '../lib/console.js';

interface CliFlags {
  help: boolean;
  write: boolean;
  reveal: boolean;
}

interface RefreshResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
}

export function parseFlags(argv: readonly string[]): CliFlags {
  const flags: CliFlags = { help: false, write: false, reveal: false };
  for (const raw of argv) {
    if (raw === '--help' || raw === '-h') flags.help = true;
    else if (raw === '--write') flags.write = true;
    else if (raw === '--reveal') flags.reveal = true;
    else throw new Error(`Unknown flag: ${raw}. Run with --help for usage.`);
  }
  return flags;
}

/** The env var the account's token lives in (bare for default, suffixed otherwise). */
export function tokenEnvVarName(accountName: string): string {
  return accountName === 'default'
    ? 'INSTAGRAM_ACCESS_TOKEN'
    : `INSTAGRAM_ACCESS_TOKEN__${accountName}`;
}

/**
 * Replace the account's token line in the .env contents. Returns the updated
 * contents, or undefined when no non-empty line for that var exists — the
 * caller surfaces that instead of appending a duplicate (a token this script
 * refreshed necessarily came FROM .env, so a missing line means the env came
 * from somewhere else and a file write would be wrong).
 */
export function replaceTokenLine(
  envContents: string,
  accountName: string,
  newToken: string
): string | undefined {
  const varName = tokenEnvVarName(accountName);
  // Escape the only regex-significant characters an account name can carry.
  const escaped = varName.replace(/[-]/g, '\\-');
  const pattern = new RegExp(`^(\\s*${escaped}=)\\S[^\\n]*$`, 'm');
  if (!pattern.test(envContents)) return undefined;
  return envContents.replace(pattern, `$1${newToken}`);
}

function maskToken(token: string): string {
  if (token.length <= 14) return '*'.repeat(token.length);
  return `${token.slice(0, 10)}...${token.slice(-4)}`;
}

function formatExpiry(expiresIn: number | undefined): string {
  if (expiresIn === undefined || expiresIn <= 0) return 'unknown';
  const days = Math.floor(expiresIn / 86_400);
  return days >= 1 ? `~${days} days` : `${expiresIn}s`;
}

async function refreshToken(
  accessToken: string,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)
): Promise<RefreshResponse> {
  // UNVERSIONED path on graph.instagram.com — the refresh endpoint 404s with
  // a version segment, same as the long-lived exchange.
  const url = new URL('https://graph.instagram.com/refresh_access_token');
  url.searchParams.set('grant_type', 'ig_refresh_token');
  url.searchParams.set('access_token', accessToken);
  const response = await fetchImpl(url.toString(), { method: 'GET' });
  const body = (await response.json().catch(() => ({}))) as RefreshResponse & {
    error?: { message?: string; code?: number };
  };
  if (!response.ok || typeof body.access_token !== 'string') {
    const detail = body.error
      ? `code ${body.error.code ?? '?'}: ${body.error.message ?? 'unknown error'}`
      : `HTTP ${response.status}`;
    throw new Error(
      `refresh_access_token failed (${detail}). A token older than 60 days cannot be ` +
        'refreshed — re-mint via the Dashboard Generate-token button or setup:oauth:instagram.'
    );
  }
  return body;
}

function printHelp(): void {
  process.stdout.write(
    [
      'Usage: npm run tokens:refresh:instagram -- [options]',
      '',
      'Refreshes the long-lived Instagram token of EVERY configured account',
      '(bare vars + __<name>-suffixed). Run on a schedule; alert on exit 1.',
      '',
      'Options:',
      '  --write     Rewrite each refreshed token in .env in place. Without this,',
      '              tokens are printed (masked) and .env is untouched.',
      '  --reveal    Print tokens unmasked.',
      '  --help, -h  Show this help.',
      ''
    ].join('\n')
  );
}

async function runCli(): Promise<number> {
  let flags: CliFlags;
  try {
    flags = parseFlags(process.argv.slice(2));
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    return 2;
  }
  if (flags.help) {
    printHelp();
    return 0;
  }

  divider('meta-ai-agent: refresh Instagram tokens');

  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    fail(`Configuration error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const accounts = configuredAccounts(config).instagram;
  if (accounts.length === 0) {
    warn('No Instagram accounts configured — nothing to refresh.');
    return 0;
  }

  const envPath = path.resolve(process.cwd(), '.env');
  let anyFailed = false;

  for (const account of accounts) {
    const label = account.accountName === 'default' ? 'default account' : `account "${account.accountName}"`;
    try {
      const refreshed = await refreshToken(account.accessToken);
      const newToken = refreshed.access_token!;
      success(
        `${label}: refreshed (expires ${formatExpiry(refreshed.expires_in)}) — ` +
          `${tokenEnvVarName(account.accountName)}=${flags.reveal ? newToken : maskToken(newToken)}`
      );
      if (flags.write) {
        const contents = await readFile(envPath, 'utf8');
        const updated = replaceTokenLine(contents, account.accountName, newToken);
        if (updated === undefined) {
          // See replaceTokenLine's doc: a missing line means this env did not
          // come from .env — appending would create a shadowed duplicate.
          warn(
            `${label}: no non-empty ${tokenEnvVarName(account.accountName)} line in .env — ` +
              'not written. Update wherever this environment is actually configured.'
          );
          anyFailed = true;
        } else if (updated !== contents) {
          await writeFile(envPath, updated, 'utf8');
          info(`${label}: .env updated in place.`);
        } else {
          info(`${label}: token unchanged; .env untouched.`);
        }
      }
    } catch (err) {
      anyFailed = true;
      fail(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (anyFailed) {
    fail('One or more accounts failed to refresh. A lapsed (>60d) token needs a manual re-mint.');
    return 1;
  }
  success('All Instagram tokens refreshed.');
  if (!flags.write) info('Run with --write to persist the refreshed tokens to .env.');
  return 0;
}

const invokedAsScript = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    const thisFile = new URL(import.meta.url).pathname;
    return path.resolve(entry) === path.resolve(thisFile);
  } catch {
    return false;
  }
})();

if (invokedAsScript) {
  runCli()
    .then(code => {
      process.exitCode = code;
    })
    .catch(err => {
      fail(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    });
}
