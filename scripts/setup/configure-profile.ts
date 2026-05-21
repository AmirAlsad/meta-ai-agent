/**
 * Stage 8 — setup-time profile configuration.
 *
 * Applies the Messenger Profile surfaces (Get Started button, greeting,
 * persistent menu, ice breakers) and the Instagram ice breakers from a single
 * JSON config file against a REAL Meta App. This is the companion to
 * `register-webhooks.ts`: webhooks make events flow IN; this makes the
 * conversation-entry UI (buttons / menus / starters) show up on the threads.
 *
 * Reuses the REAL clients ({@link MessengerProfileClient} /
 * {@link InstagramIceBreakers}) over the shared {@link GraphClient}, so it
 * exercises the exact camelCase→snake_case body-mapping + validation code that
 * production uses — it does NOT reimplement any profile body shaping.
 *
 * DESIGN — a PURE seam for testing: the JSON→client-calls mapping lives in
 * {@link applyProfile}, a pure function that takes the loaded config, the parsed
 * profile JSON, and the (injectable) clients, and returns a per-channel,
 * per-step pass/fail summary. The CLI wrapper only does I/O: parse args, load
 * config, read the JSON file, build a GraphClient + the two clients, call
 * applyProfile, print the summary, set the exit code. This keeps the
 * Graph-touching glue thin and lets `applyProfile` be unit-tested with fakes.
 *
 * NEVER crash: this is a setup tool. A bad file / malformed JSON / missing
 * channel is surfaced as a friendly console error and a non-zero exit code via
 * `process.exitCode` (not a hard `process.exit`), never an unhandled throw.
 *
 * NEVER log access tokens or full request bodies (only operation + step names).
 */

import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pino from 'pino';

import { loadConfig, type Config } from '../../src/config/loader.js';
import { GraphClient } from '../../src/meta/shared/graph-client.js';
import { MetaApiError } from '../../src/meta/shared/errors.js';
import {
  MessengerProfileClient,
  type Greeting,
  type LocalizedIceBreakers as MessengerLocalizedIceBreakers,
  type PersistentMenuLocale
} from '../../src/meta/messenger/profile.js';
import {
  InstagramIceBreakers,
  type LocalizedIceBreakers as InstagramLocalizedIceBreakers
} from '../../src/meta/instagram/ice-breakers.js';
import { info, success, warn, fail, divider } from '../lib/console.js';

const SCRIPT_NAME = 'configure-profile';

/* ────────────────────────────────────────────────────────────────────────── */
/* Profile JSON shape                                                         */
/* ────────────────────────────────────────────────────────────────────────── */

/** Get Started config: the postback payload delivered when a new user taps it. */
export interface GetStartedConfig {
  payload: string;
}

/** The Messenger section of the profile JSON — every field is OPTIONAL. */
export interface MessengerProfileConfig {
  getStarted?: GetStartedConfig;
  greeting?: Greeting[];
  persistentMenu?: PersistentMenuLocale[];
  iceBreakers?: MessengerLocalizedIceBreakers[];
}

/** The Instagram section — only ice breakers are in scope (IG has no Get Started). */
export interface InstagramProfileConfig {
  iceBreakers?: InstagramLocalizedIceBreakers[];
}

/** The whole profile JSON file: both channel sections OPTIONAL. */
export interface ProfileConfig {
  messenger?: MessengerProfileConfig;
  instagram?: InstagramProfileConfig;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Apply summary types                                                        */
/* ────────────────────────────────────────────────────────────────────────── */

export type ProfileChannel = 'messenger' | 'instagram';

export interface ProfileStepResult {
  /** Short step label, e.g. `'get_started'`, `'persistent_menu'`. */
  step: string;
  status: 'pass' | 'fail';
  /** On fail: a human-readable message (Meta error code/subcode/fbtrace when available). */
  detail?: string;
}

export interface ChannelApplyResult {
  channel: ProfileChannel;
  steps: ProfileStepResult[];
  /** True iff no step failed (a channel with zero steps is trivially ok). */
  ok: boolean;
}

export interface ApplyProfileResult {
  channels: ChannelApplyResult[];
  /** True iff every channel is ok (no failed step anywhere). */
  ok: boolean;
}

/**
 * The client surface {@link applyProfile} needs — narrowed to the methods it
 * calls so tests can pass `vi.fn()`-backed fakes without constructing real
 * clients. Each is OPTIONAL: an absent client means that channel is not
 * configured (no creds), so its section is skipped.
 */
export interface ProfileClients {
  messengerProfile?: Pick<
    MessengerProfileClient,
    'setGetStartedButton' | 'setGreetingText' | 'setPersistentMenu' | 'setIceBreakers'
  >;
  instagramIceBreakers?: Pick<InstagramIceBreakers, 'setIceBreakers'>;
}

type StepLogger = Pick<pino.Logger, 'info' | 'warn' | 'debug'>;

/* ────────────────────────────────────────────────────────────────────────── */
/* The pure seam: JSON → client calls                                         */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Apply the profile JSON to whichever channels are BOTH configured (a client is
 * present) AND have a section in the JSON. Pure with respect to I/O — it only
 * calls the injected client methods and returns a structured summary.
 *
 * ORDERING (load-bearing): for Messenger we set the Get Started button BEFORE
 * the persistent menu. Meta REQUIRES Get Started to exist before a
 * persistent_menu POST (otherwise it rejects with error code 2018145). We apply
 * present fields in the fixed order get_started → greeting → persistent_menu →
 * ice_breakers so a single config file that defines both always satisfies that
 * dependency.
 *
 * PARTIAL SUCCESS: every step runs in its own try/catch. A failing step is
 * recorded (with the Meta error detail) and the NEXT step / channel still runs —
 * one bad surface never aborts the rest.
 */
export async function applyProfile(
  config: Config,
  profile: ProfileConfig,
  clients: ProfileClients,
  logger?: StepLogger
): Promise<ApplyProfileResult> {
  // `config` is part of the documented seam signature for symmetry with the
  // other setup helpers, but channel presence is decided by WHICH clients the
  // caller wired (a present client ⇒ that channel is configured + requested) —
  // so we don't read it here. The CLI's buildClients() is what consults config.
  void config;
  const channels: ChannelApplyResult[] = [];

  // ── Messenger ──────────────────────────────────────────────────────────
  // Only when the channel is configured (a client exists) AND the JSON has a
  // messenger section.
  if (clients.messengerProfile && profile.messenger) {
    const client = clients.messengerProfile;
    const section = profile.messenger;
    const steps: ProfileStepResult[] = [];

    // 1) Get Started FIRST — must precede the persistent menu (see ORDERING).
    if (section.getStarted) {
      await runStep(steps, 'get_started', logger, () =>
        client.setGetStartedButton(section.getStarted!.payload)
      );
    }
    // 2) Greeting.
    if (section.greeting) {
      await runStep(steps, 'greeting', logger, () => client.setGreetingText(section.greeting!));
    }
    // 3) Persistent menu (AFTER get_started).
    if (section.persistentMenu) {
      await runStep(steps, 'persistent_menu', logger, () =>
        client.setPersistentMenu(section.persistentMenu!)
      );
    }
    // 4) Ice breakers.
    if (section.iceBreakers) {
      await runStep(steps, 'ice_breakers', logger, () => client.setIceBreakers(section.iceBreakers!));
    }

    channels.push({ channel: 'messenger', steps, ok: steps.every(s => s.status === 'pass') });
  }

  // ── Instagram ──────────────────────────────────────────────────────────
  if (clients.instagramIceBreakers && profile.instagram) {
    const client = clients.instagramIceBreakers;
    const section = profile.instagram;
    const steps: ProfileStepResult[] = [];

    if (section.iceBreakers) {
      await runStep(steps, 'ice_breakers', logger, () => client.setIceBreakers(section.iceBreakers!));
    }

    channels.push({ channel: 'instagram', steps, ok: steps.every(s => s.status === 'pass') });
  }

  return { channels, ok: channels.every(c => c.ok) };
}

/**
 * Run one apply step, recording pass/fail. Surfaces a {@link MetaApiError}'s
 * code/subcode/fbtrace_id (without the body, which can carry payloads/titles).
 * Continue-on-failure: never throws — the caller proceeds to the next step.
 */
async function runStep(
  steps: ProfileStepResult[],
  step: string,
  logger: StepLogger | undefined,
  fn: () => Promise<void>
): Promise<void> {
  try {
    await fn();
    steps.push({ step, status: 'pass' });
    logger?.debug({ step }, 'profile step applied');
  } catch (err) {
    const detail = describeStepError(err);
    steps.push({ step, status: 'fail', detail });
    logger?.warn({ step, detail }, 'profile step failed');
  }
}

/** Format an apply error: Meta API code/subcode/fbtrace when present, else message. */
function describeStepError(err: unknown): string {
  if (err instanceof MetaApiError) {
    const parts = [`HTTP ${err.httpStatus}`];
    if (err.errorCode !== undefined) parts.push(`code ${err.errorCode}`);
    if (err.errorSubCode !== undefined) parts.push(`subcode ${err.errorSubCode}`);
    if (err.fbtraceId !== undefined) parts.push(`fbtrace_id ${err.fbtraceId}`);
    return `${err.message} (${parts.join(', ')})`;
  }
  return err instanceof Error ? err.message : String(err);
}

/* ────────────────────────────────────────────────────────────────────────── */
/* JSON validation                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Minimally validate + narrow the parsed JSON into a {@link ProfileConfig}.
 * Throws a clear, actionable error on a malformed shape (so the CLI can print a
 * friendly message rather than letting a deep client call blow up). We validate
 * only the STRUCTURE the script reads; the per-field semantics (locale rules,
 * ≤4 ice breakers, ≤3 menu items) are left to the clients + Meta, which already
 * fail fast with named errors.
 */
export function parseProfileConfig(raw: unknown): ProfileConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Profile config must be a JSON object with optional "messenger"/"instagram" keys.');
  }
  const obj = raw as Record<string, unknown>;
  const out: ProfileConfig = {};

  if (obj['messenger'] !== undefined) {
    const m = obj['messenger'];
    if (typeof m !== 'object' || m === null || Array.isArray(m)) {
      throw new Error('"messenger" must be an object.');
    }
    const mo = m as Record<string, unknown>;
    const messenger: MessengerProfileConfig = {};
    if (mo['getStarted'] !== undefined) {
      const gs = mo['getStarted'];
      if (typeof gs !== 'object' || gs === null || typeof (gs as Record<string, unknown>)['payload'] !== 'string') {
        throw new Error('"messenger.getStarted" must be an object with a string "payload".');
      }
      messenger.getStarted = { payload: (gs as Record<string, unknown>)['payload'] as string };
    }
    if (mo['greeting'] !== undefined) {
      if (!Array.isArray(mo['greeting'])) throw new Error('"messenger.greeting" must be an array.');
      messenger.greeting = mo['greeting'] as Greeting[];
    }
    if (mo['persistentMenu'] !== undefined) {
      if (!Array.isArray(mo['persistentMenu'])) throw new Error('"messenger.persistentMenu" must be an array.');
      messenger.persistentMenu = mo['persistentMenu'] as PersistentMenuLocale[];
    }
    if (mo['iceBreakers'] !== undefined) {
      if (!Array.isArray(mo['iceBreakers'])) throw new Error('"messenger.iceBreakers" must be an array.');
      messenger.iceBreakers = mo['iceBreakers'] as MessengerLocalizedIceBreakers[];
    }
    out.messenger = messenger;
  }

  if (obj['instagram'] !== undefined) {
    const ig = obj['instagram'];
    if (typeof ig !== 'object' || ig === null || Array.isArray(ig)) {
      throw new Error('"instagram" must be an object.');
    }
    const igo = ig as Record<string, unknown>;
    const instagram: InstagramProfileConfig = {};
    if (igo['iceBreakers'] !== undefined) {
      if (!Array.isArray(igo['iceBreakers'])) throw new Error('"instagram.iceBreakers" must be an array.');
      instagram.iceBreakers = igo['iceBreakers'] as InstagramLocalizedIceBreakers[];
    }
    out.instagram = instagram;
  }

  return out;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* CLI parsing                                                                */
/* ────────────────────────────────────────────────────────────────────────── */

const VALID_CHANNELS: ReadonlySet<ProfileChannel> = new Set(['messenger', 'instagram']);

export interface ParsedProfileArgs {
  /** Path to the profile JSON. Required unless `help` is set. */
  configPath?: string;
  /** Channels to configure. Empty ⇒ all configured channels present in the JSON. */
  channels: ProfileChannel[];
  help: boolean;
}

/**
 * Pure arg parser (exported for tests). Throws on unknown flags / empty values
 * so the CLI prints a clean remediation instead of half-parsing argv. Mirrors
 * `parseVerifyArgs` in verify-shared.ts.
 *
 * Flags:
 *   --config=<path>          Path to the profile JSON (required unless --help).
 *   --channels=messenger,instagram   Restrict to these channels. Default: all.
 *   --help, -h               Print usage.
 */
export function parseProfileArgs(argv: readonly string[]): ParsedProfileArgs {
  const out: ParsedProfileArgs = { channels: [], help: false };
  for (const raw of argv) {
    if (raw === '--help' || raw === '-h') {
      out.help = true;
      continue;
    }
    if (raw.startsWith('--config=')) {
      const value = raw.slice('--config='.length).trim();
      if (value === '') throw new Error('--config requires a path, e.g. --config=scripts/setup/profile.example.json');
      out.configPath = value;
      continue;
    }
    if (raw.startsWith('--channels=')) {
      const value = raw.slice('--channels='.length).trim();
      if (value === '') throw new Error('--channels requires at least one value: --channels=messenger[,instagram]');
      const parts = value.split(',').map(s => s.trim()).filter(s => s.length > 0);
      const channels: ProfileChannel[] = [];
      for (const part of parts) {
        if (!VALID_CHANNELS.has(part as ProfileChannel)) {
          throw new Error(`--channels: unknown channel "${part}". Valid values: messenger, instagram.`);
        }
        if (!channels.includes(part as ProfileChannel)) channels.push(part as ProfileChannel);
      }
      out.channels = channels;
      continue;
    }
    throw new Error(`Unknown flag: ${raw}. Run with --help for usage.`);
  }
  return out;
}

export function printHelp(): void {
  process.stdout.write(
    [
      `${SCRIPT_NAME} — apply the Messenger Profile + Instagram ice breakers from a JSON file.`,
      '',
      'Usage:',
      `  npm run setup:profile -- --config=<path> [--channels=messenger,instagram]`,
      `  npx tsx scripts/setup/${SCRIPT_NAME}.ts --config=<path> [options]`,
      '',
      'Options:',
      '  --config=<path>        Path to the profile JSON (required). See the shape below.',
      '  --channels=<list>      Comma-separated channels to configure (messenger,instagram).',
      '                         Default: every channel that is BOTH configured (creds set)',
      '                         AND present in the JSON.',
      '  --help, -h             Show this message.',
      '',
      'Profile JSON shape (all sections + fields OPTIONAL):',
      '  {',
      '    "messenger": {',
      '      "getStarted": { "payload": "GET_STARTED" },',
      '      "greeting": [{ "locale": "default", "text": "Hi! How can we help?" }],',
      '      "persistentMenu": [{ "locale": "default", "composerInputDisabled": false,',
      '        "callToActions": [',
      '          { "type": "postback", "title": "Talk to us", "payload": "TALK" },',
      '          { "type": "web_url", "title": "Website", "url": "https://example.com" }',
      '        ] }],',
      '      "iceBreakers": [{ "locale": "default",',
      '        "callToActions": [{ "question": "What are your hours?", "payload": "HOURS" }] }]',
      '    },',
      '    "instagram": {',
      '      "iceBreakers": [{ "locale": "default",',
      '        "callToActions": [{ "question": "How do I order?", "payload": "ORDER" }] }]',
      '    }',
      '  }',
      '',
      'Notes:',
      '  - Get Started is applied BEFORE the persistent menu (Meta requires it).',
      '  - A failing step is logged and the rest still run (partial success).',
      '  - A sample file ships at scripts/setup/profile.example.json.',
      '  - Environment: META_APP_SECRET, META_VERIFY_TOKEN + per-channel creds',
      '    (MESSENGER_*, INSTAGRAM_*). See .env.example.',
      ''
    ].join('\n')
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Console summary                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

/** Print the per-channel, per-step pass/fail table. Exported for testability. */
export function printApplySummary(result: ApplyProfileResult): void {
  divider('profile configuration summary');
  if (result.channels.length === 0) {
    warn('No channels were configured. (None were both configured AND present in the JSON, or none matched --channels.)');
    return;
  }
  for (const channel of result.channels) {
    const label = channel.channel.toUpperCase();
    if (channel.steps.length === 0) {
      info(`${label}: no steps (section present but empty).`);
      continue;
    }
    for (const s of channel.steps) {
      if (s.status === 'pass') success(`${label} ${s.step}: applied`);
      else fail(`${label} ${s.step}: ${s.detail ?? 'failed'}`);
    }
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* CLI glue                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

function makeLogger(nodeEnv: string): pino.Logger {
  return pino({
    level: process.env['LOG_LEVEL'] ?? 'info',
    transport:
      nodeEnv === 'production'
        ? undefined
        : { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' } }
  });
}

/**
 * Build the injectable {@link ProfileClients} from config + a GraphClient.
 * A client is created only when its channel has BOTH credentials AND the channel
 * was requested (empty `requested` ⇒ all configured channels). Returns plain
 * clients ready for {@link applyProfile}.
 */
function buildClients(
  config: Config,
  graph: GraphClient,
  requested: ProfileChannel[],
  logger: pino.Logger
): ProfileClients {
  const wants = (c: ProfileChannel): boolean => requested.length === 0 || requested.includes(c);
  const clients: ProfileClients = {};
  if (config.messenger && wants('messenger')) {
    clients.messengerProfile = new MessengerProfileClient({ config: config.messenger, graph, logger });
  }
  if (config.instagram && wants('instagram')) {
    clients.instagramIceBreakers = new InstagramIceBreakers({ config: config.instagram, graph, logger });
  }
  return clients;
}

async function runCli(argv: readonly string[]): Promise<number> {
  let args: ParsedProfileArgs;
  try {
    args = parseProfileArgs(argv);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    printHelp();
    return 1;
  }

  if (args.help) {
    printHelp();
    return 0;
  }

  if (!args.configPath) {
    fail('Missing --config=<path>. Point it at your profile JSON (see --help for the shape).');
    return 1;
  }

  // Load config with a friendly error path (loadConfig is strict).
  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(`Configuration error: ${msg}`);
    info(
      'Hint: ensure .env defines META_APP_SECRET, META_VERIFY_TOKEN, and credentials ' +
        'for at least one of Messenger (MESSENGER_*) or Instagram (INSTAGRAM_*).'
    );
    return 1;
  }

  // Read + parse the profile JSON with a friendly error path (never crash).
  let profile: ProfileConfig;
  const resolvedPath = path.resolve(args.configPath);
  try {
    const rawText = await readFile(resolvedPath, 'utf8');
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawText);
    } catch (err) {
      fail(`Profile JSON at ${resolvedPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    profile = parseProfileConfig(parsedJson);
  } catch (err) {
    // ENOENT or a parseProfileConfig validation error both land here.
    const msg = err instanceof Error ? err.message : String(err);
    fail(`Failed to load profile config: ${msg}`);
    return 1;
  }

  const logger = makeLogger(config.nodeEnv);

  divider('meta-ai-agent: profile configuration');
  info(`Config file: ${resolvedPath}`);
  info(`Graph API: ${config.meta.graphApiVersion}`);

  const graph = new GraphClient({ apiVersion: config.meta.graphApiVersion, logger });
  const clients = buildClients(config, graph, args.channels, logger);

  // Warn for any requested-but-unconfigured / requested-but-absent-in-JSON case
  // so a developer who expected a channel to apply sees WHY it didn't.
  warnSkips(config, profile, args.channels, clients);

  const result = await applyProfile(config, profile, clients, logger);
  printApplySummary(result);

  divider();
  // Exit non-zero ONLY when a step actually failed. "Nothing to do" (no matching
  // channel/section) is a no-op success — the developer's config simply targeted
  // channels that aren't set up, which is not a script error.
  if (!result.ok) {
    fail('One or more profile steps failed. See above for the Meta error details.');
    return 1;
  }
  if (result.channels.length === 0) {
    info('Nothing to configure (no channel was both configured and present in the JSON).');
  } else {
    success('Profile configuration complete.');
  }
  return 0;
}

/**
 * Emit a `warn` for each channel that the developer plausibly expected to apply
 * but won't: present in the JSON but missing credentials, or explicitly
 * requested via --channels but missing creds / absent from the JSON.
 */
function warnSkips(
  config: Config,
  profile: ProfileConfig,
  requested: ProfileChannel[],
  clients: ProfileClients
): void {
  const wants = (c: ProfileChannel): boolean => requested.length === 0 || requested.includes(c);

  if (profile.messenger && wants('messenger') && !clients.messengerProfile) {
    warn('Messenger section present in JSON but Messenger is not configured (MESSENGER_PAGE_ID + MESSENGER_PAGE_ACCESS_TOKEN). Skipping.');
  }
  if (profile.instagram && wants('instagram') && !clients.instagramIceBreakers) {
    warn('Instagram section present in JSON but Instagram is not configured (INSTAGRAM_USER_ID + INSTAGRAM_ACCESS_TOKEN). Skipping.');
  }
  // Requested a channel that has no JSON section → nothing to apply for it.
  for (const c of requested) {
    if (c === 'messenger' && config.messenger && !profile.messenger) {
      warn('Messenger requested via --channels but the JSON has no "messenger" section. Skipping.');
    }
    if (c === 'instagram' && config.instagram && !profile.instagram) {
      warn('Instagram requested via --channels but the JSON has no "instagram" section. Skipping.');
    }
  }
}

/**
 * Detect "run as script" — resolve both argv[1] and import.meta.url to absolute
 * paths so the match holds regardless of relative-path quirks (same convention
 * as probe-outbound.ts / verify-whatsapp.ts).
 */
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
  runCli(process.argv.slice(2))
    .then(code => {
      process.exitCode = code;
    })
    .catch(err => {
      // Last-resort guard: applyProfile/runStep already swallow per-step errors,
      // so reaching here means an unexpected glue failure. Never crash — set a
      // non-zero exit code and print a friendly line.
      fail(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = process.exitCode ?? 1;
    });
}
