import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Alpha's own GitHub credential.
 *
 * Every test loads the module fresh against a throwaway ALPHA_HOME: the stored
 * credential is cached in module scope, and a test that signed in would
 * otherwise leave the next one already signed in.
 */
const tmp = path.join(os.tmpdir(), `alpha-gh-token-${Date.now()}`);

type Module = typeof import('./alphaGitHubToken.js');

async function load(clientId = 'Iv1.testclientid', packaged = false): Promise<Module> {
  process.env.ALPHA_HOME = tmp;
  process.env.ALPHA_PACKAGED = packaged ? '1' : '0';
  // Emptied rather than deleted: dotenv refills a key that is absent.
  process.env.GITHUB_CLIENT_ID = clientId;
  process.env.GITHUB_SCOPE = 'repo,workflow,read:org';
  vi.resetModules();
  return import('./alphaGitHubToken.js');
}

/** A fetch that answers each call in turn, and records what it was asked. */
function stubFetch(responses: Array<{ ok?: boolean; status?: number; body: unknown }>) {
  const calls: Array<{ url: string; body: any }> = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const next = responses.shift() ?? { body: {} };
    calls.push({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : undefined
    });
    return {
      ok: next.ok ?? true,
      status: next.status ?? 200,
      statusText: '',
      json: async () => next.body
    } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

beforeEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.ALPHA_PACKAGED;
});

describe('asking GitHub for a device code', () => {
  it('returns the code to show, and keeps the one that is not shown', async () => {
    const mod = await load();
    const { impl, calls } = stubFetch([
      {
        body: {
          device_code: 'secret-device-code',
          user_code: 'ABCD-1234',
          verification_uri: 'https://github.com/login/device',
          interval: 5,
          expires_in: 900
        }
      }
    ]);

    const code = await mod.requestDeviceCode(impl);

    expect(code).toMatchObject({
      userCode: 'ABCD-1234',
      deviceCode: 'secret-device-code',
      interval: 5
    });
    // Scopes reach GitHub space-separated, not in the comma form they are configured in.
    expect(calls[0].body.scope).toBe('repo workflow read:org');
    expect(calls[0].body.client_id).toBe('Iv1.testclientid');
  });

  /** Device flow is off by default on a new app, and the error says so. */
  it('explains a refusal in GitHub words', async () => {
    const mod = await load();
    const { impl } = stubFetch([
      { ok: false, status: 400, body: { error: 'device_flow_disabled', error_description: 'Device flow is not enabled' } }
    ]);

    await expect(mod.requestDeviceCode(impl)).rejects.toThrow(/Device flow is not enabled/);
  });
});

describe('waiting for the person to authorise it', () => {
  const code = {
    userCode: 'ABCD-1234',
    verificationUrl: 'https://github.com/login/device',
    deviceCode: 'secret-device-code',
    interval: 1,
    expiresIn: 900
  };

  it('keeps the token, and the name GitHub gives it', async () => {
    const mod = await load();
    const { impl } = stubFetch([
      { body: { error: 'authorization_pending' } },
      { body: { access_token: 'gho_thetoken' } },
      { body: { login: 'Dev1' } }
    ]);

    const credential = await mod.awaitAuthorization(code, { fetchImpl: impl, sleep: async () => undefined });

    expect(credential).toMatchObject({ token: 'gho_thetoken', login: 'Dev1' });
    // And it survives the process: this is the whole point of storing it.
    const reloaded = await load();
    expect(reloaded.storedToken()).toBe('gho_thetoken');
  });

  /** Ignoring slow_down is how a client gets rate-limited out of signing in. */
  it('backs off when GitHub says it is asking too often', async () => {
    const mod = await load();
    const { impl } = stubFetch([
      { body: { error: 'slow_down' } },
      { body: { access_token: 'gho_thetoken' } },
      { body: { login: 'Dev1' } }
    ]);

    const waits: number[] = [];
    await mod.awaitAuthorization(code, {
      fetchImpl: impl,
      sleep: async ms => {
        waits.push(ms);
      }
    });

    expect(waits).toEqual([1000, 6000]);
  });

  it('gives up when the sign-in is declined, and stores nothing', async () => {
    const mod = await load();
    const { impl } = stubFetch([{ body: { error: 'access_denied' } }]);

    await expect(
      mod.awaitAuthorization(code, { fetchImpl: impl, sleep: async () => undefined })
    ).rejects.toThrow(/declined/);
    expect(mod.storedToken()).toBeNull();
  });
});

describe('the stored credential', () => {
  it('is forgotten on request, and nothing else is touched', async () => {
    const mod = await load();
    mod.saveCredential({ token: 'gho_thetoken', login: 'Dev1', obtainedAt: new Date().toISOString() });
    expect(mod.storedToken()).toBe('gho_thetoken');

    mod.clearCredential();

    expect(mod.storedToken()).toBeNull();
    expect((await load()).storedToken()).toBeNull();
  });

  it('remembers account metadata without exposing a token to the profile list', async () => {
    const mod = await load();
    mod.saveCredential({
      token: 'gho_thetoken',
      userId: '42',
      login: 'Dev1',
      name: 'Dev One',
      avatarUrl: 'https://avatars.githubusercontent.com/u/42',
      obtainedAt: new Date().toISOString()
    });

    expect(mod.profileSummaries()).toMatchObject([
      { id: '42', login: 'Dev1', name: 'Dev One', active: true }
    ]);
    expect(JSON.stringify(mod.profileSummaries())).not.toContain('gho_thetoken');

    mod.clearCredential();
    expect(mod.profileSummaries()).toMatchObject([
      { id: '42', login: 'Dev1', active: false }
    ]);

    mod.removeProfile('42');
    expect(mod.profileSummaries()).toEqual([]);
  });

  it('does not treat a remembered token as an active packaged session', async () => {
    const mod = await load('Iv1.testclientid', true);
    mod.saveCredential({ token: 'gho_thetoken', userId: '42', login: 'Dev1', obtainedAt: new Date().toISOString() });

    expect(mod.isSessionAuthenticated()).toBe(true);
    expect(mod.profileSummaries()).toMatchObject([{ id: '42', active: true }]);

    mod.beginSessionAuthentication();

    expect(mod.isSessionAuthenticated()).toBe(false);
    expect(mod.profileSummaries()).toMatchObject([{ id: '42', active: false }]);
  });
});

describe('which app to sign in to', () => {
  it('asks the deployment when the build has no client id of its own', async () => {
    process.env.ALPHA_CLOUD_API = 'https://alpha.example.com/api';
    const mod = await load('');
    const { impl, calls } = stubFetch([{ body: { clientId: 'Iv1.fromcloud' } }]);

    expect(await mod.clientId(impl)).toBe('Iv1.fromcloud');
    expect(calls[0].url).toBe('https://alpha.example.com/api/github/app/client');
    process.env.ALPHA_CLOUD_API = '';
  });

  it('says so when there is nothing to ask', async () => {
    process.env.ALPHA_CLOUD_API = '';
    const mod = await load('');
    await expect(mod.clientId()).rejects.toThrow(/cannot sign in/);
  });
});

describe('hosted account-specific desktop sign-in', () => {
  it('starts an OAuth handoff with the selected login and stores its result locally', async () => {
    process.env.ALPHA_CLOUD_API = 'https://alpha.example.com/api';
    const mod = await load('');
    const { impl: start, calls } = stubFetch([
      { body: { state: 'desktop-state', authorizationUrl: 'https://github.com/login/oauth/authorize?...' } }
    ]);

    const flow = await mod.requestHostedOAuth('pineapple-2005', start);
    expect(calls[0].url).toBe('https://alpha.example.com/api/github/oauth/desktop/start');
    expect(calls[0].body.login).toBe('pineapple-2005');
    expect(calls[0].body.handoffToken).toMatch(/^[a-f0-9]{64}$/);
    expect(flow.authorizationUrl).toContain('github.com/login/oauth/authorize');

    const { impl: result } = stubFetch([
      { body: { token: 'gho_hosted', username: 'pineapple-2005', profileId: '2005' } }
    ]);
    const credential = await mod.awaitHostedOAuth(flow, { fetchImpl: result });
    expect(credential).toMatchObject({ username: 'pineapple-2005', profileId: '2005' });
    expect(mod.storedToken()).toBe('gho_hosted');
    process.env.ALPHA_CLOUD_API = '';
  });
});
