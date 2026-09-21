import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * The cloud end of the desktop's token exchange.
 *
 * The property that matters: everything in the minted token comes from
 * GitHub, not from the caller. The desktop used to sign its own token and
 * name its own role; this is what replaced that, so the tests are mostly about
 * what a caller cannot make it say.
 */

const ORG = 'Capstone-Agentic-AI-Orchestration';

/** Who each fake GitHub token belongs to, and their teams in the org. */
let accounts: Record<string, { login: string; teams: string[] }>;
let fetchMock: ReturnType<typeof vi.fn>;

function githubFetch(url: string, init?: RequestInit): Promise<Response> {
  const auth = new Headers(init?.headers).get('Authorization') ?? '';
  const account = accounts[auth.replace(/^Bearer /, '')];
  const json = (body: unknown, status = 200) =>
    Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

  if (!account) return json({ message: 'Bad credentials' }, 401);
  if (url === 'https://api.github.com/user') return json({ login: account.login });
  if (url.startsWith('https://api.github.com/user/teams')) {
    return json(account.teams.map(slug => ({ slug, organization: { login: ORG } })));
  }
  return json({ message: 'Not Found' }, 404);
}

/** Workspace membership as the registry would answer it: everyone is in ws-default. */
const resolveWorkspace = (login: string, workspaceId: string | undefined, role: any) =>
  !workspaceId || workspaceId === 'ws-default' ? { userId: login, workspaceId: 'ws-default', role } : null;

async function load(secret = 'test-secret') {
  process.env.ALPHA_MODE = 'cloud';
  process.env.SUPABASE_JWT_SECRET = secret;
  vi.resetModules();
  const exchange = await import('./databaseTokenExchange.js');
  const tokens = await import('./supabaseTokenService.js');
  return { ...exchange, verify: tokens.verifySupabaseToken };
}

beforeEach(() => {
  accounts = {
    'dev-token': { login: 'ZaneZamoraC1Cs', teams: ['developers'] },
    'admin-token': { login: 'LloydLim1', teams: ['admin'] },
    'no-team-token': { login: 'Pineapple-2005', teams: [] }
  };
  fetchMock = vi.fn(githubFetch);
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ALPHA_MODE;
  delete process.env.SUPABASE_JWT_SECRET;
  delete process.env.ALPHA_ADMINS;
});

describe('desktop token exchange', () => {
  it('mints a token whose login and role come from GitHub', async () => {
    const { exchangeGitHubToken, verify } = await load();
    const result = await exchangeGitHubToken('dev-token', 'ws-default', resolveWorkspace);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(verify(result.token)).toEqual({ sub: 'ZaneZamoraC1Cs', workspace_id: 'ws-default', alpha_role: 'dev' });
  });

  it('decides the role from team membership, so a developer cannot come out admin', async () => {
    const { exchangeGitHubToken, verify } = await load();
    const dev = await exchangeGitHubToken('dev-token', undefined, resolveWorkspace);
    const admin = await exchangeGitHubToken('admin-token', undefined, resolveWorkspace);

    expect(dev.ok && verify(dev.token)?.alpha_role).toBe('dev');
    expect(admin.ok && verify(admin.token)?.alpha_role).toBe('admin');
  });

  it('answers 401 with no token at all', async () => {
    const { exchangeGitHubToken } = await load();
    const result = await exchangeGitHubToken(undefined, undefined, resolveWorkspace);
    expect(result).toMatchObject({ ok: false, status: 401 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers 401 when GitHub does not recognise the token', async () => {
    const { exchangeGitHubToken } = await load();
    const result = await exchangeGitHubToken('forged-token', undefined, resolveWorkspace);
    expect(result).toMatchObject({ ok: false, status: 401 });
  });

  it('refuses someone in no team, and does not cache the refusal', async () => {
    const { exchangeGitHubToken } = await load();
    expect(await exchangeGitHubToken('no-team-token', undefined, resolveWorkspace)).toMatchObject({
      ok: false,
      status: 403
    });

    // Added to a team: the very next attempt must see it, not a cached "no".
    accounts['no-team-token'].teams = ['developers'];
    expect(await exchangeGitHubToken('no-team-token', undefined, resolveWorkspace)).toMatchObject({ ok: true });
  });

  it('refuses a workspace the caller is not a member of', async () => {
    const { exchangeGitHubToken } = await load();
    const result = await exchangeGitHubToken('dev-token', 'someone-elses-workspace', resolveWorkspace);
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it('reuses a verified identity rather than asking GitHub on every refresh', async () => {
    const { exchangeGitHubToken } = await load();
    await exchangeGitHubToken('dev-token', undefined, resolveWorkspace);
    const calls = fetchMock.mock.calls.length;

    await exchangeGitHubToken('dev-token', undefined, resolveWorkspace);
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it('answers 502, not 401, when GitHub cannot be reached', async () => {
    const { exchangeGitHubToken } = await load();
    fetchMock.mockImplementation(() => Promise.reject(new Error('ECONNRESET')));
    expect(await exchangeGitHubToken('dev-token', undefined, resolveWorkspace)).toMatchObject({
      ok: false,
      status: 502
    });
  });

  it('answers 503 when the server has no signing secret', async () => {
    const { exchangeGitHubToken } = await load('');
    expect(await exchangeGitHubToken('dev-token', undefined, resolveWorkspace)).toMatchObject({
      ok: false,
      status: 503
    });
  });
});
