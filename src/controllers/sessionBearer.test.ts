import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * The cloud API, called by a desktop with its GitHub token.
 *
 * A desktop has no cookie. Workspaces and their members live in the cloud,
 * so without this a developer's desktop could only ever list the workspaces
 * in its own file -- the default one -- and never one a project manager put
 * them in. The identity comes from GitHub, as it does for the database-token
 * exchange; nothing the caller says about itself is believed.
 */

const ORG = 'Capstone-Agentic-AI-Orchestration';
let accounts: Record<string, { login: string; teams: string[] }>;

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

async function sessionFor(headers: Record<string, string>) {
  process.env.ALPHA_MODE = 'cloud';
  process.env.ALPHA_ORG = ORG;
  vi.resetModules();
  const { sessionContext } = await import('./sessionContext.js');

  const req: any = {
    headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
    header(name: string) {
      return this.headers[name.toLowerCase()];
    }
  };
  await new Promise<void>((resolve, reject) => sessionContext(req, {} as any, (err?: unknown) => (err ? reject(err) : resolve())));
  return req.session;
}

beforeEach(() => {
  accounts = {
    'dev-token': { login: 'ZaneZamoraC1Cs', teams: ['developers'] },
    'pm-token': { login: 'LloydLim1', teams: ['project-managers'] },
    'no-team-token': { login: 'Pineapple-2005', teams: [] }
  };
  vi.stubGlobal('fetch', vi.fn(githubFetch));
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ALPHA_MODE;
  delete process.env.ALPHA_ORG;
});

describe('a GitHub token instead of a cookie', () => {
  it('signs a developer in as themselves, at the role their team grants', async () => {
    const session = await sessionFor({ Authorization: 'Bearer dev-token' });
    expect(session).toMatchObject({ login: 'ZaneZamoraC1Cs', role: 'dev', githubToken: 'dev-token' });
  });

  it('gives a project manager their own role, not one they claim', async () => {
    const session = await sessionFor({ Authorization: 'Bearer pm-token', 'X-Alpha-Role': 'admin' });
    expect(session?.role).toBe('pm');
  });

  it('signs nobody in for a token GitHub refuses', async () => {
    expect(await sessionFor({ Authorization: 'Bearer forged' })).toBeUndefined();
  });

  it('signs nobody in for an account in no role-granting team', async () => {
    expect(await sessionFor({ Authorization: 'Bearer no-team-token' })).toBeUndefined();
  });

  it('leaves a request with neither alone', async () => {
    expect(await sessionFor({})).toBeUndefined();
  });
});
