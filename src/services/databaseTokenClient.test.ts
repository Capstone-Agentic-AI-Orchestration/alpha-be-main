import { describe, it, expect, vi } from 'vitest';

import { DatabaseTokenClient } from './databaseTokenClient.js';

/**
 * The desktop end of the token exchange.
 *
 * Every failure must come back as `null` -- the caller then presents the anon
 * key and the write is refused by policy -- and the happy path must not turn
 * into an exchange per database call.
 */

const MINUTE = 60 * 1000;

function setup(overrides: Partial<ConstructorParameters<typeof DatabaseTokenClient>[0]> = {}) {
  let now = 1_000_000;
  let workspace = 'ws-default';
  let issued = 0;
  const failures: string[] = [];

  const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => {
    issued++;
    return new Response(
      JSON.stringify({ token: `token-${issued}`, expiresAt: new Date(now + 10 * MINUTE).toISOString() }),
      { status: 200 }
    );
  });

  const client = new DatabaseTokenClient({
    cloudApi: 'https://alpha.example/api',
    githubToken: async () => 'gh-token',
    workspaceId: () => workspace,
    onFailure: (_what, err) => failures.push(String((err as Error)?.message ?? err)),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    now: () => now,
    ...overrides
  });

  return {
    client,
    fetchImpl,
    failures,
    advance: (ms: number) => { now += ms; },
    switchWorkspace: (id: string) => { workspace = id; }
  };
}

describe('desktop database token client', () => {
  it('presents the gh token and workspace to the exchange endpoint', async () => {
    const { client, fetchImpl } = setup();
    expect(await client.token()).toBe('token-1');

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://alpha.example/api/database/token/exchange');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer gh-token');
    expect(new Headers(init?.headers).get('X-Workspace-Id')).toBe('ws-default');
  });

  it('reuses a token until it nears expiry, then refreshes', async () => {
    const { client, fetchImpl, advance } = setup();
    await client.token();
    advance(7 * MINUTE);
    expect(await client.token()).toBe('token-1');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Inside the refresh margin: a cold Render could outlast what is left.
    advance(2 * MINUTE);
    expect(await client.token()).toBe('token-2');
  });

  it('shares one exchange between concurrent callers', async () => {
    const { client, fetchImpl } = setup();
    const tokens = await Promise.all([client.token(), client.token(), client.token()]);
    expect(new Set(tokens)).toEqual(new Set(['token-1']));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('asks again when the workspace changes', async () => {
    const { client, switchWorkspace } = setup();
    await client.token();
    switchWorkspace('ws-other');
    expect(await client.token()).toBe('token-2');
  });

  it('returns null, and never calls out, without ALPHA_CLOUD_API', async () => {
    const { client, fetchImpl, failures } = setup({ cloudApi: '' });
    expect(await client.token()).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(failures[0]).toMatch(/ALPHA_CLOUD_API/);
  });

  it('returns null when gh is signed out', async () => {
    const { client, fetchImpl, failures } = setup({ githubToken: async () => null });
    expect(await client.token()).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(failures[0]).toMatch(/gh is not signed in/);
  });

  it('returns null on a refusal, and tries again next time rather than caching it', async () => {
    let refuse = true;
    const { client, failures } = setup({
      fetchImpl: (async () =>
        refuse
          ? new Response(JSON.stringify({ error: 'no team' }), { status: 403 })
          : new Response(JSON.stringify({ token: 't', expiresAt: new Date(2e12).toISOString() }), { status: 200 })
      ) as unknown as typeof fetch
    });

    expect(await client.token()).toBeNull();
    expect(failures[0]).toMatch(/403/);

    refuse = false;
    expect(await client.token()).toBe('t');
  });
});
