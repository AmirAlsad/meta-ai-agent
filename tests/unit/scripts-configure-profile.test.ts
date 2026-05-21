/**
 * Unit tests for the profile-configuration setup script's PURE seams.
 *
 * The script needs real Meta creds to actually hit the Graph API, so there is no
 * full e2e test here. Instead we test the testable parts in isolation:
 *  - `applyProfile(config, profileJson, clients, logger)` — the JSON→client-calls
 *    mapping (right methods + args, get-started-before-menu ordering,
 *    continue-on-failure, absent channel/section skipping).
 *  - `parseProfileArgs` — the CLI arg grammar.
 *  - `parseProfileConfig` — the minimal JSON-shape validation.
 *
 * Clients are `vi.fn()`-backed fakes implementing only the methods applyProfile
 * calls, so no GraphClient / network is involved.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  applyProfile,
  parseProfileArgs,
  parseProfileConfig,
  type ProfileClients,
  type ProfileConfig
} from '../../scripts/setup/configure-profile.js';
import type { Config } from '../../src/config/loader.js';
import { defaultConversationConfig } from '../../src/config/loader.js';
import { MetaApiError } from '../../src/meta/shared/errors.js';

/* ────────────────────────────────────────────────────────────────────────── */
/* Helpers                                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

/** A Config with both Messenger + Instagram configured (the apply seam reads creds presence indirectly via clients). */
function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    meta: { appId: undefined, appSecret: 's', verifyToken: 'x'.repeat(16), graphApiVersion: 'v25.0' },
    messenger: { pageId: 'page-1', pageAccessToken: 'page-token' },
    instagram: { userId: 'ig-1', accessToken: 'ig-token' },
    channels: { whatsapp: false, messenger: true, instagram: true },
    conversation: defaultConversationConfig(),
    chatEndpointUrl: 'https://chat.example.com',
    ngrokDomain: 'test.ngrok-free.dev',
    agentAutostart: false,
    port: 3000,
    nodeEnv: 'test',
    ...overrides
  };
}

interface FakeMessengerProfile {
  setGetStartedButton: ReturnType<typeof vi.fn>;
  setGreetingText: ReturnType<typeof vi.fn>;
  setPersistentMenu: ReturnType<typeof vi.fn>;
  setIceBreakers: ReturnType<typeof vi.fn>;
}

interface FakeInstagramIceBreakers {
  setIceBreakers: ReturnType<typeof vi.fn>;
}

function makeMessengerClient(): FakeMessengerProfile {
  return {
    setGetStartedButton: vi.fn(async () => undefined),
    setGreetingText: vi.fn(async () => undefined),
    setPersistentMenu: vi.fn(async () => undefined),
    setIceBreakers: vi.fn(async () => undefined)
  };
}

function makeInstagramClient(): FakeInstagramIceBreakers {
  return { setIceBreakers: vi.fn(async () => undefined) };
}

/** A full profile JSON exercising every Messenger surface + Instagram ice breakers. */
function fullProfile(): ProfileConfig {
  return {
    messenger: {
      getStarted: { payload: 'GET_STARTED' },
      greeting: [{ locale: 'default', text: 'Hi! How can we help?' }],
      persistentMenu: [
        {
          locale: 'default',
          composerInputDisabled: false,
          callToActions: [
            { type: 'postback', title: 'Talk to us', payload: 'TALK' },
            { type: 'web_url', title: 'Website', url: 'https://example.com' }
          ]
        }
      ],
      iceBreakers: [{ locale: 'default', callToActions: [{ question: 'What are your hours?', payload: 'HOURS' }] }]
    },
    instagram: {
      iceBreakers: [{ locale: 'default', callToActions: [{ question: 'How do I order?', payload: 'ORDER' }] }]
    }
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* applyProfile — mapping + ordering                                          */
/* ────────────────────────────────────────────────────────────────────────── */

describe('applyProfile mapping', () => {
  it('calls each Messenger method with the mapped args + Instagram ice breakers', async () => {
    const messenger = makeMessengerClient();
    const instagram = makeInstagramClient();
    const clients: ProfileClients = { messengerProfile: messenger, instagramIceBreakers: instagram };
    const profile = fullProfile();

    const result = await applyProfile(makeConfig(), profile, clients);

    expect(messenger.setGetStartedButton).toHaveBeenCalledWith('GET_STARTED');
    expect(messenger.setGreetingText).toHaveBeenCalledWith(profile.messenger!.greeting);
    expect(messenger.setPersistentMenu).toHaveBeenCalledWith(profile.messenger!.persistentMenu);
    expect(messenger.setIceBreakers).toHaveBeenCalledWith(profile.messenger!.iceBreakers);
    expect(instagram.setIceBreakers).toHaveBeenCalledWith(profile.instagram!.iceBreakers);

    expect(result.ok).toBe(true);
    const mChannel = result.channels.find(c => c.channel === 'messenger')!;
    expect(mChannel.steps.map(s => s.step)).toEqual(['get_started', 'greeting', 'persistent_menu', 'ice_breakers']);
    expect(mChannel.steps.every(s => s.status === 'pass')).toBe(true);
    const igChannel = result.channels.find(c => c.channel === 'instagram')!;
    expect(igChannel.steps.map(s => s.step)).toEqual(['ice_breakers']);
  });

  it('applies Get Started BEFORE the persistent menu (Meta ordering requirement)', async () => {
    const messenger = makeMessengerClient();
    const clients: ProfileClients = { messengerProfile: messenger };

    await applyProfile(makeConfig(), fullProfile(), clients);

    const getStartedOrder = messenger.setGetStartedButton.mock.invocationCallOrder[0]!;
    const menuOrder = messenger.setPersistentMenu.mock.invocationCallOrder[0]!;
    expect(getStartedOrder).toBeLessThan(menuOrder);
  });

  it('only applies the fields present in the JSON (no spurious calls)', async () => {
    const messenger = makeMessengerClient();
    const clients: ProfileClients = { messengerProfile: messenger };
    // Only ice breakers present — no getStarted/greeting/menu.
    const profile: ProfileConfig = {
      messenger: { iceBreakers: [{ locale: 'default', callToActions: [{ question: 'Q?', payload: 'P' }] }] }
    };

    const result = await applyProfile(makeConfig(), profile, clients);

    expect(messenger.setGetStartedButton).not.toHaveBeenCalled();
    expect(messenger.setGreetingText).not.toHaveBeenCalled();
    expect(messenger.setPersistentMenu).not.toHaveBeenCalled();
    expect(messenger.setIceBreakers).toHaveBeenCalledTimes(1);
    expect(result.channels.find(c => c.channel === 'messenger')!.steps.map(s => s.step)).toEqual(['ice_breakers']);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* applyProfile — continue-on-failure                                         */
/* ────────────────────────────────────────────────────────────────────────── */

describe('applyProfile continue-on-failure', () => {
  it('a failing step is recorded and the next steps still run', async () => {
    const messenger = makeMessengerClient();
    // Greeting fails; get_started before it and menu/ice_breakers after must still run.
    messenger.setGreetingText.mockRejectedValueOnce(
      new MetaApiError({ operation: 'messenger.setGreetingText', httpStatus: 400, errorCode: 100, fbtraceId: 'AbC123', responseBody: {} })
    );
    const clients: ProfileClients = { messengerProfile: messenger };

    const result = await applyProfile(makeConfig(), fullProfile(), clients);

    // Every step was attempted despite the greeting failure.
    expect(messenger.setGetStartedButton).toHaveBeenCalledTimes(1);
    expect(messenger.setGreetingText).toHaveBeenCalledTimes(1);
    expect(messenger.setPersistentMenu).toHaveBeenCalledTimes(1);
    expect(messenger.setIceBreakers).toHaveBeenCalledTimes(1);

    const mChannel = result.channels.find(c => c.channel === 'messenger')!;
    const greeting = mChannel.steps.find(s => s.step === 'greeting')!;
    expect(greeting.status).toBe('fail');
    // The Meta error details (code/fbtrace) are surfaced.
    expect(greeting.detail).toContain('code 100');
    expect(greeting.detail).toContain('fbtrace_id AbC123');
    // The channel + overall result are NOT ok because a step failed.
    expect(mChannel.ok).toBe(false);
    expect(result.ok).toBe(false);
    // The other steps still passed.
    expect(mChannel.steps.filter(s => s.status === 'pass').map(s => s.step)).toEqual([
      'get_started',
      'persistent_menu',
      'ice_breakers'
    ]);
  });

  it('a Messenger failure does not stop the Instagram channel from being configured', async () => {
    const messenger = makeMessengerClient();
    messenger.setIceBreakers.mockRejectedValueOnce(new Error('boom'));
    const instagram = makeInstagramClient();
    const clients: ProfileClients = { messengerProfile: messenger, instagramIceBreakers: instagram };

    const result = await applyProfile(makeConfig(), fullProfile(), clients);

    // Instagram still ran and passed.
    expect(instagram.setIceBreakers).toHaveBeenCalledTimes(1);
    expect(result.channels.find(c => c.channel === 'instagram')!.ok).toBe(true);
    // Overall is not ok because Messenger had a failed step.
    expect(result.ok).toBe(false);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* applyProfile — skipping absent channels / sections                         */
/* ────────────────────────────────────────────────────────────────────────── */

describe('applyProfile skips absent channels / sections', () => {
  it('skips Messenger when no messenger client is present (channel not configured)', async () => {
    const instagram = makeInstagramClient();
    // No messengerProfile client → Messenger is not configured.
    const clients: ProfileClients = { instagramIceBreakers: instagram };

    const result = await applyProfile(makeConfig(), fullProfile(), clients);

    expect(result.channels.map(c => c.channel)).toEqual(['instagram']);
    expect(instagram.setIceBreakers).toHaveBeenCalledTimes(1);
  });

  it('skips Instagram when the JSON has no instagram section', async () => {
    const messenger = makeMessengerClient();
    const instagram = makeInstagramClient();
    const clients: ProfileClients = { messengerProfile: messenger, instagramIceBreakers: instagram };
    const profile: ProfileConfig = { messenger: { getStarted: { payload: 'GS' } } };

    const result = await applyProfile(makeConfig(), profile, clients);

    expect(instagram.setIceBreakers).not.toHaveBeenCalled();
    expect(result.channels.map(c => c.channel)).toEqual(['messenger']);
  });

  it('configures nothing (ok=true) when the JSON is empty', async () => {
    const messenger = makeMessengerClient();
    const instagram = makeInstagramClient();
    const clients: ProfileClients = { messengerProfile: messenger, instagramIceBreakers: instagram };

    const result = await applyProfile(makeConfig(), {}, clients);

    expect(messenger.setGetStartedButton).not.toHaveBeenCalled();
    expect(instagram.setIceBreakers).not.toHaveBeenCalled();
    expect(result.channels).toEqual([]);
    // No failed step ⇒ ok (a no-op is success).
    expect(result.ok).toBe(true);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* parseProfileArgs                                                           */
/* ────────────────────────────────────────────────────────────────────────── */

describe('parseProfileArgs', () => {
  it('parses --config and --channels', () => {
    const args = parseProfileArgs(['--config=foo.json', '--channels=messenger,instagram']);
    expect(args.configPath).toBe('foo.json');
    expect(args.channels).toEqual(['messenger', 'instagram']);
    expect(args.help).toBe(false);
  });

  it('parses --help / -h', () => {
    expect(parseProfileArgs(['--help']).help).toBe(true);
    expect(parseProfileArgs(['-h']).help).toBe(true);
  });

  it('de-duplicates channels and preserves order', () => {
    const args = parseProfileArgs(['--channels=instagram,instagram,messenger']);
    expect(args.channels).toEqual(['instagram', 'messenger']);
  });

  it('throws on an unknown channel', () => {
    expect(() => parseProfileArgs(['--channels=whatsapp'])).toThrow(/unknown channel "whatsapp"/);
  });

  it('throws on an unknown flag', () => {
    expect(() => parseProfileArgs(['--nope'])).toThrow(/Unknown flag/);
  });

  it('throws on empty --config / --channels values', () => {
    expect(() => parseProfileArgs(['--config='])).toThrow(/--config requires a path/);
    expect(() => parseProfileArgs(['--channels='])).toThrow(/--channels requires at least one value/);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* parseProfileConfig                                                         */
/* ────────────────────────────────────────────────────────────────────────── */

describe('parseProfileConfig', () => {
  it('accepts a well-formed full profile', () => {
    const parsed = parseProfileConfig(fullProfile());
    expect(parsed.messenger?.getStarted).toEqual({ payload: 'GET_STARTED' });
    expect(parsed.instagram?.iceBreakers).toHaveLength(1);
  });

  it('accepts an empty object', () => {
    expect(parseProfileConfig({})).toEqual({});
  });

  it('rejects a non-object root', () => {
    expect(() => parseProfileConfig([])).toThrow(/must be a JSON object/);
    expect(() => parseProfileConfig('nope')).toThrow(/must be a JSON object/);
    expect(() => parseProfileConfig(null)).toThrow(/must be a JSON object/);
  });

  it('rejects a getStarted without a string payload', () => {
    expect(() => parseProfileConfig({ messenger: { getStarted: {} } })).toThrow(/string "payload"/);
  });

  it('rejects non-array greeting / persistentMenu / iceBreakers', () => {
    expect(() => parseProfileConfig({ messenger: { greeting: {} } })).toThrow(/"messenger.greeting" must be an array/);
    expect(() => parseProfileConfig({ messenger: { persistentMenu: {} } })).toThrow(
      /"messenger.persistentMenu" must be an array/
    );
    expect(() => parseProfileConfig({ instagram: { iceBreakers: {} } })).toThrow(
      /"instagram.iceBreakers" must be an array/
    );
  });

  it('rejects a non-object "messenger" section (array or null)', () => {
    // Arrays/null are typeof 'object' but not valid sections — each must hit the
    // dedicated "must be an object" guard with a friendly message.
    expect(() => parseProfileConfig({ messenger: [] })).toThrow(/"messenger" must be an object/);
    expect(() => parseProfileConfig({ messenger: null })).toThrow(/"messenger" must be an object/);
  });

  it('rejects a non-object "instagram" section (array or null)', () => {
    expect(() => parseProfileConfig({ instagram: [] })).toThrow(/"instagram" must be an object/);
    expect(() => parseProfileConfig({ instagram: null })).toThrow(/"instagram" must be an object/);
  });
});
