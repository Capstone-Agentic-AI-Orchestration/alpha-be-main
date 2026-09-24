import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Who may list, create, join and staff a workspace.
 *
 * These routes used to read `sqliteService` directly, and the damage was not
 * subtle: listing returned every workspace on the deployment to anyone who
 * asked, and creating one needed no sign-in at all -- `/workspaces` was on the
 * public-path list so the browser could ask which workspaces it had, and that
 * exemption matches on path, so it covered POST too. Each anonymous call
 * seeded a workspace with a full agent roster, and nobody could open it
 * afterwards because it had no members.
 *
 * Ephemeral storage hid all of it: Render replaces its disk on each deploy.
 * The rows persist now, so these are the tests that say who may do what.
 */

let tmp: string;
let opened: { close(): void }[] = [];
let identity = { login: 'Admin1', role: 'admin' as string };

async function startApi({ cloud = false } = {}) {
  process.env.ALPHA_HOME = tmp;
  if (cloud) process.env.ALPHA_MODE = 'cloud';
  vi.resetModules();

  // The desktop resolves this from `gh`; a test must not depend on a
  // signed-in machine, and the role is what these assertions are about.
  vi.doMock('../services/identityService.js', async () => ({
    // The team-to-role table stays real: the roster below is asserted against it.
    ...(await vi.importActual<object>('../services/identityService.js')),
    currentIdentity: async () => ({
      login: identity.login,
      source: 'github',
      role: identity.role,
      access: 'granted',
      github: 'ok',
      teams: []
    }),
    warmIdentity: () => {},
    knownIdentity: () => ({ login: identity.login, source: 'github' })
  }));

  const sql = await import('../services/sqliteService.js');
  const { workspaceRouter } = await import('./workspaceController.js');
  const { workspaceContext } = await import('./workspaceContext.js');
  const { jsonErrorHandler } = await import('./errorHandler.js');
  const registry = (await import('../services/workspaceRegistry.js')).workspaceRegistry;
  opened.push(sql.sqliteService);
  // A second handle on the same file; Windows will not unlink a file with one
  // still open, so both are closed in teardown.
  opened.push(registry);

  const app = express();
  app.use(express.json());
  app.use('/api', workspaceContext);
  app.use('/api', workspaceRouter);
  app.use(jsonErrorHandler);
  return { app, registry, svc: sql.sqliteService as any };
}

async function call(
  app: express.Express,
  method: string,
  url: string,
  options: { body?: unknown; workspaceId?: string } = {}
) {
  const { createServer } = await import('node:http');
  const server = createServer(app);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  try {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(options.workspaceId ? { 'X-Workspace-Id': options.workspaceId } : {})
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  } finally {
    await new Promise<void>(r => server.close(() => r()));
  }
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-workspaces-'));
  opened = [];
  identity = { login: 'Admin1', role: 'admin' };
});

afterEach(() => {
  for (const handle of opened) {
    try {
      handle.close();
    } catch {
      /* already closed */
    }
  }
  delete process.env.ALPHA_HOME;
  delete process.env.ALPHA_MODE;
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* windows handle */
  }
  vi.restoreAllMocks();
  vi.doUnmock('../services/identityService.js');
});

describe('a caller with no session, in cloud mode', () => {
  it('cannot create a workspace', async () => {
    const { app } = await startApi({ cloud: true });
    const res = await call(app, 'POST', '/api/workspaces', { body: { name: 'Free for all' } });

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Sign in/);
  });

  it('cannot list workspaces either', async () => {
    const { app } = await startApi({ cloud: true });
    expect((await call(app, 'GET', '/api/workspaces')).status).toBe(401);
  });
});

describe('GET /workspaces', () => {
  it('lists the caller’s workspaces, not the deployment’s', async () => {
    const { app, registry } = await startApi();
    await registry.createWorkspace('Someone-else', { name: 'Not yours' });

    const res = await call(app, 'GET', '/api/workspaces');
    expect(res.status).toBe(200);
    expect(res.body.map((workspace: any) => workspace.name)).toEqual(['Alpha Workspace']);
  });
});

describe('POST /workspaces', () => {
  it('creates one for an admin, with its agents and its creator as a member', async () => {
    const { app, registry, svc } = await startApi();

    const res = await call(app, 'POST', '/api/workspaces', { body: { name: 'Team Alpha' } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'Team Alpha', role: 'admin', memberCount: 1 });

    // Openable afterwards, which a workspace with no members is not.
    expect(await registry.resolve('Admin1', res.body.id, 'admin')).not.toBeNull();
    expect(svc.getAgents().length).toBeGreaterThan(0);
  });

  it('refuses a developer', async () => {
    identity = { login: 'Dev1', role: 'dev' };
    const { app } = await startApi();

    const res = await call(app, 'POST', '/api/workspaces', { body: { name: 'Team Alpha' } });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/project manager/i);
  });

  /** A project manager runs their own workspaces, and is not made admin of them for creating one. */
  it('creates one for a project manager, who joins it as a project manager', async () => {
    identity = { login: 'PM1', role: 'pm' };
    const { app, registry } = await startApi();

    const res = await call(app, 'POST', '/api/workspaces', { body: { name: 'Client Portal' } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'Client Portal', role: 'pm', memberCount: 1 });

    const context = await registry.resolve('PM1', res.body.id, 'pm');
    expect(context?.role).toBe('pm');
    // And can staff it straight away, which is the next thing they will do.
    expect(registry.can(context!.role, 'workspace.manage_members')).toBe(true);
  });

  /**
   * The GitHub team decides, not a workspace role. A project manager may make
   * a developer a `pm` inside their workspace; that must not let the developer
   * create workspaces of their own.
   */
  it('refuses a developer who was made a project manager inside a workspace', async () => {
    const { registry } = await startApi();
    await registry.listForUser('Dev1', 'dev');
    const member = (await registry.listMembers('ws-default')).find((m: any) => m.userId === 'Dev1')!;
    await registry.updateMember('ws-default', member.id, { role: 'pm' });

    identity = { login: 'Dev1', role: 'dev' };
    const { app } = await startApi();
    expect((await call(app, 'POST', '/api/workspaces', { body: { name: 'Mine now' } })).status).toBe(403);
  });

  it('wants a name', async () => {
    const { app } = await startApi();
    expect((await call(app, 'POST', '/api/workspaces', { body: {} })).status).toBe(400);
  });

  /** Staffed as it is named: the people are in it at once, with nothing to accept. */
  it('puts the chosen people in it as it is created', async () => {
    identity = { login: 'PM1', role: 'pm' };
    const { app, registry } = await startApi();

    const res = await call(app, 'POST', '/api/workspaces', {
      body: {
        name: 'Client Portal',
        members: [
          { userId: 'Dev1', role: 'dev' },
          { userId: 'PM2', role: 'pm' },
          // The creator, again: already in it at their team role.
          { userId: 'pm1', role: 'dev' }
        ]
      }
    });

    expect(res.status).toBe(201);
    expect(res.body.memberCount).toBe(3);
    const members = await registry.listMembers(res.body.id);
    expect(members.map((m: any) => [m.userId, m.role, m.status]).sort()).toEqual([
      ['Dev1', 'dev', 'active'],
      ['PM1', 'pm', 'active'],
      ['PM2', 'pm', 'active']
    ]);
    // And the developer finds it waiting, without doing anything.
    expect((await registry.listForUser('Dev1', 'dev')).map((w: any) => w.name)).toContain('Client Portal');
  });

  it('refuses the whole request, and makes nothing, for one bad entry', async () => {
    identity = { login: 'PM1', role: 'pm' };
    const { app, registry } = await startApi();

    const badRole = await call(app, 'POST', '/api/workspaces', {
      body: { name: 'Half staffed', members: [{ userId: 'Dev1', role: 'dev' }, { userId: 'Dev2', role: 'root' }] }
    });
    const madeAdmin = await call(app, 'POST', '/api/workspaces', {
      body: { name: 'Half staffed', members: [{ userId: 'Dev1', role: 'admin' }] }
    });

    expect(badRole.status).toBe(400);
    expect(madeAdmin.status).toBe(403);
    expect((await registry.listForUser('PM1', 'pm')).map((w: any) => w.name)).not.toContain('Half staffed');
  });
});

describe('GET /org/teams', () => {
  function teamsApi(lists: Record<string, unknown[]>) {
    return {
      get: async () => ({}) as any,
      getAll: async (path: string) => {
        if (!(path in lists)) throw new Error(`unexpected GitHub call ${path}`);
        return lists[path] as any;
      },
      post: async () => ({}) as any,
      patch: async () => ({}) as any,
      put: async () => ({}) as any,
      delete: async () => {}
    };
  }

  /** The create form's people, before there is a workspace to add them to. */
  it('lists the role-granting teams for a project manager', async () => {
    process.env.ALPHA_ORG = 'acme';
    identity = { login: 'PM1', role: 'pm' };
    const { app } = await startApi();
    const { useGitHubApi } = await import('../services/githubApi.js');
    useGitHubApi(teamsApi({
      '/orgs/acme/teams?per_page=100': [{ slug: 'developers', name: 'Developers' }, { slug: 'book-club', name: 'Book Club' }],
      '/orgs/acme/teams/developers/members?per_page=100': [{ login: 'Dev1', avatar_url: 'https://avatars/1' }]
    }));

    const res = await call(app, 'GET', '/api/org/teams');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { slug: 'developers', name: 'Developers', role: 'dev', members: [{ login: 'Dev1', avatarUrl: 'https://avatars/1' }] }
    ]);
    useGitHubApi(null);
    delete process.env.ALPHA_ORG;
  });

  it('is not a developer’s to read', async () => {
    identity = { login: 'Dev1', role: 'dev' };
    const { app } = await startApi();
    expect((await call(app, 'GET', '/api/org/teams')).status).toBe(403);
  });
});

/**
 * A team's desktop, where the cloud decides who is in which workspace.
 *
 * Each desktop kept workspaces in its own SQLite file, which the cloud never
 * wrote to. A workspace made on the web never reached a developer's desktop,
 * and one made on a project manager's desktop lived on that one machine.
 */
describe('on a team desktop', () => {
  const CLOUD = 'https://cloud.test/api';
  let cloudCalls: Array<{ method: string; url: string; auth: string | null; workspace: string | null; body: any }>;
  let cloudAnswers: Record<string, (body: any) => { status: number; body: unknown }>;

  function summary(id: string, name: string, role: string) {
    return { id, name, slug: name.toLowerCase().replace(/\s+/g, '-'), status: 'active', role, memberCount: 2,
      createdAt: '2026-09-24T00:00:00.000Z', updatedAt: '2026-09-24T00:00:00.000Z' };
  }

  async function desktop() {
    process.env.ALPHA_CLOUD_API = CLOUD;
    vi.doMock('../services/githubApi.js', async () => ({
      ...(await vi.importActual<object>('../services/githubApi.js')),
      tokenForThisRequest: async () => 'desktop-gh-token'
    }));
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: any, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith(CLOUD)) return realFetch(input, init);
      const headers = new Headers(init?.headers);
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      cloudCalls.push({ method, url, auth: headers.get('Authorization'), workspace: headers.get('X-Workspace-Id'), body });
      const answer = cloudAnswers[`${method} ${url.slice(CLOUD.length)}`];
      if (!answer) throw new Error(`cloud unreachable for ${method} ${url}`);
      const { status, body: out } = answer(body);
      return new Response(JSON.stringify(out), { status, headers: { 'Content-Type': 'application/json' } });
    });
    return startApi();
  }

  beforeEach(() => {
    cloudCalls = [];
    cloudAnswers = {};
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock('../services/githubApi.js');
    // Empty, not deleted: deleted, dotenv refills it from the developer's .env.
    process.env.ALPHA_CLOUD_API = '';
  });

  it('shows a developer the workspace a project manager put them in, and opens it', async () => {
    identity = { login: 'Dev1', role: 'dev' };
    cloudAnswers['GET /workspaces'] = () => ({
      status: 200,
      body: [summary('ws-default', 'Alpha Workspace', 'dev'), summary('workspace-portal', 'Client Portal', 'dev')]
    });
    cloudAnswers['GET /workspaces/workspace-portal/members'] = () => ({
      status: 200,
      body: [{ id: 'm1', userId: 'PM1', role: 'pm', status: 'active' }, { id: 'm2', userId: 'Dev1', role: 'dev', status: 'active' }]
    });
    const { app } = await desktop();

    const listed = await call(app, 'GET', '/api/workspaces');
    expect(listed.status).toBe(200);
    expect(listed.body.map((w: any) => [w.name, w.role])).toEqual([
      ['Alpha Workspace', 'dev'],
      ['Client Portal', 'dev']
    ]);
    // Signed in to the cloud as this desktop's GitHub account.
    expect(cloudCalls[0].auth).toBe('Bearer desktop-gh-token');

    // Openable here, and its roster is the cloud's.
    const members = await call(app, 'GET', '/api/workspaces/workspace-portal/members', { workspaceId: 'workspace-portal' });
    expect(members.status).toBe(200);
    expect(members.body.map((m: any) => m.userId)).toEqual(['PM1', 'Dev1']);
    expect(cloudCalls.at(-1)!.workspace).toBe('workspace-portal');
  });

  it('lists even when the app asks with a workspace it has not seen yet', async () => {
    identity = { login: 'Dev1', role: 'dev' };
    cloudAnswers['GET /workspaces'] = () => ({ status: 200, body: [summary('workspace-portal', 'Client Portal', 'dev')] });
    const { app } = await desktop();

    const listed = await call(app, 'GET', '/api/workspaces', { workspaceId: 'workspace-portal' });
    expect(listed.status).toBe(200);
    expect(listed.body.map((w: any) => w.id)).toContain('workspace-portal');
  });

  it('takes a workspace away when the cloud says they are no longer in it', async () => {
    identity = { login: 'Dev1', role: 'dev' };
    cloudAnswers['GET /workspaces'] = () => ({
      status: 200,
      body: [summary('ws-default', 'Alpha Workspace', 'dev'), summary('workspace-portal', 'Client Portal', 'dev')]
    });
    const { app } = await desktop();
    await call(app, 'GET', '/api/workspaces');

    cloudAnswers['GET /workspaces'] = () => ({ status: 200, body: [summary('ws-default', 'Alpha Workspace', 'dev')] });
    const listed = await call(app, 'GET', '/api/workspaces');
    expect(listed.body.map((w: any) => w.id)).toEqual(['ws-default']);
  });

  it('keeps the last copy when the cloud does not answer', async () => {
    identity = { login: 'Dev1', role: 'dev' };
    cloudAnswers['GET /workspaces'] = () => ({
      status: 200,
      body: [summary('ws-default', 'Alpha Workspace', 'dev'), summary('workspace-portal', 'Client Portal', 'dev')]
    });
    const { app } = await desktop();
    await call(app, 'GET', '/api/workspaces');

    delete cloudAnswers['GET /workspaces'];
    const listed = await call(app, 'GET', '/api/workspaces');
    expect(listed.status).toBe(200);
    expect(listed.body.map((w: any) => w.id)).toEqual(['ws-default', 'workspace-portal']);
  });

  /** Made where the team can see it, not in this one machine's file. */
  it('creates a project manager’s workspace in the cloud, with its people, and opens it here', async () => {
    identity = { login: 'PM1', role: 'pm' };
    cloudAnswers['POST /workspaces'] = () => ({ status: 201, body: summary('workspace-portal', 'Client Portal', 'pm') });
    cloudAnswers['GET /workspaces'] = () => ({
      status: 200,
      body: [summary('ws-default', 'Alpha Workspace', 'pm'), summary('workspace-portal', 'Client Portal', 'pm')]
    });
    const { app, registry } = await desktop();

    const res = await call(app, 'POST', '/api/workspaces', {
      body: { name: 'Client Portal', members: [{ userId: 'Dev1', role: 'dev' }] }
    });

    expect(res.status).toBe(201);
    const create = cloudCalls.find(c => c.method === 'POST')!;
    expect(create.body).toEqual({ name: 'Client Portal', members: [{ userId: 'Dev1', role: 'dev' }] });
    expect((await registry.resolve('PM1', 'workspace-portal', 'pm'))?.role).toBe('pm');
    // Not a second, local-only copy under an id nobody else has.
    expect((await registry.listForUser('PM1', 'pm')).map((w: any) => w.name)).toEqual(['Alpha Workspace', 'Client Portal']);
  });

  it('adds a member through the cloud, and relays its refusal unchanged', async () => {
    identity = { login: 'PM1', role: 'pm' };
    cloudAnswers['POST /workspaces/ws-default/members'] = body =>
      body.userId === 'Stranger'
        ? { status: 400, body: { error: 'Not in the organisation.' } }
        : { status: 201, body: { id: 'm9', userId: body.userId, role: body.role, status: 'active' } };
    const { app } = await desktop();

    const added = await call(app, 'POST', '/api/workspaces/ws-default/members', { body: { userId: 'Dev1', role: 'dev' } });
    const refused = await call(app, 'POST', '/api/workspaces/ws-default/members', { body: { userId: 'Stranger', role: 'dev' } });

    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ userId: 'Dev1', status: 'active' });
    expect(refused).toEqual({ status: 400, body: { error: 'Not in the organisation.' } });
  });

  it('says so when the cloud cannot be reached for something a person asked for', async () => {
    identity = { login: 'PM1', role: 'pm' };
    const { app } = await desktop();

    const res = await call(app, 'POST', '/api/workspaces/ws-default/members', { body: { userId: 'Dev1', role: 'dev' } });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/Alpha cloud/);
  });
});

/**
 * Joining is gone, and stays gone.
 *
 * A project manager puts people in a workspace, so an invite code -- which
 * outlives the conversation it was pasted into, and names nobody -- was a
 * second way in that nobody administered. Asserted rather than merely deleted,
 * because a route that quietly returns is exactly the kind of regression a
 * removal invites.
 */
describe('POST /workspaces/join', () => {
  it('is not a route, even with a real code', async () => {
    const { app, registry } = await startApi();
    const workspace = await registry.createWorkspace('Owner1', { name: 'Team Alpha' });

    identity = { login: 'Dev1', role: 'dev' };
    // Any code at all: there is no longer a column for one, let alone a route.
    const res = await call(app, 'POST', '/api/workspaces/join', { body: { code: 'team-alpha-whatever' } });

    expect(res.status).toBe(404);
    // And the caller is no nearer the workspace for having tried.
    expect((await call(app, 'GET', '/api/workspaces')).body.map((w: any) => w.id)).not.toContain(workspace.id);
  });
});

describe('members', () => {
  /** Knowing who your colleagues are is not privileged; the database policy always said so. */
  it('are listed for everyone in the workspace, developers included', async () => {
    const { app } = await startApi();
    expect((await call(app, 'GET', '/api/workspaces/ws-default/members')).status).toBe(200);

    identity = { login: 'Dev1', role: 'dev' };
    const { app: devApp } = await startApi();
    expect((await call(devApp, 'GET', '/api/workspaces/ws-default/members')).status).toBe(200);
  });

  it('cannot be read through another workspace’s id', async () => {
    const { app, registry } = await startApi();
    const other = await registry.createWorkspace('Someone-else', { name: 'Not yours' });

    const res = await call(app, 'GET', `/api/workspaces/${other.id}/members`);
    expect(res.status).toBe(404);
  });

  it('change role only for an admin, and only to a role that exists', async () => {
    const { app, registry } = await startApi();
    await registry.listForUser('Dev1', 'dev');
    const member = (await registry.listMembers('ws-default')).find((m: any) => m.userId === 'Dev1')!;

    const promoted = await call(app, 'PATCH', `/api/workspaces/ws-default/members/${member.id}`, {
      body: { role: 'pm' }
    });
    expect(promoted.status).toBe(200);
    expect(promoted.body.role).toBe('pm');

    expect(
      (await call(app, 'PATCH', `/api/workspaces/ws-default/members/${member.id}`, { body: { role: 'root' } })).status
    ).toBe(400);
    expect((await call(app, 'PATCH', '/api/workspaces/ws-default/members/nobody', { body: { role: 'pm' } })).status).toBe(404);

    // Dev2, not Dev1: the promotion above made Dev1 a project manager here,
    // and a project manager may change a membership.
    identity = { login: 'Dev2', role: 'dev' };
    const { app: devApp } = await startApi();
    expect(
      (await call(devApp, 'PATCH', `/api/workspaces/ws-default/members/${member.id}`, { body: { role: 'admin' } }))
        .status
    ).toBe(403);
  });
});

describe('staffing a workspace', () => {
  /**
   * A project manager decides who is in their workspace, and the person is in
   * it -- no code to pass along, nothing for them to accept.
   */
  it('puts someone in it at once, when a project manager says so', async () => {
    identity = { login: 'PM1', role: 'pm' };
    const { app, registry } = await startApi();

    const added = await call(app, 'POST', '/api/workspaces/ws-default/members', {
      body: { userId: 'Dev1', role: 'dev' }
    });

    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ userId: 'Dev1', role: 'dev', status: 'active' });
    const members = await registry.listMembers('ws-default');
    expect(members.map((m: any) => m.userId)).toContain('Dev1');
  });

  it('changes the role rather than refusing, the second time', async () => {
    identity = { login: 'PM1', role: 'pm' };
    const { app, registry } = await startApi();
    await call(app, 'POST', '/api/workspaces/ws-default/members', { body: { userId: 'Dev1', role: 'dev' } });

    const again = await call(app, 'POST', '/api/workspaces/ws-default/members', {
      body: { userId: 'Dev1', role: 'pm' }
    });

    expect(again.status).toBe(201);
    expect(again.body.role).toBe('pm');
    expect((await registry.listMembers('ws-default')).filter((m: any) => m.userId === 'Dev1')).toHaveLength(1);
  });

  /** A present decision by someone entitled to make it, unlike an old invite code. */
  it('restores a membership that had been removed', async () => {
    const { app, registry } = await startApi();
    await registry.listForUser('Dev1', 'dev');
    const member = (await registry.listMembers('ws-default')).find((m: any) => m.userId === 'Dev1')!;
    await registry.updateMember('ws-default', member.id, { status: 'removed' });

    identity = { login: 'PM1', role: 'pm' };
    const { app: pmApp } = await startApi();
    const added = await call(pmApp, 'POST', '/api/workspaces/ws-default/members', {
      body: { userId: 'Dev1', role: 'dev' }
    });

    expect(added.body.status).toBe('active');
    void app;
  });

  /** The one role a project manager cannot hand out is the one that hands out claims. */
  it('will not let a project manager make an admin', async () => {
    identity = { login: 'PM1', role: 'pm' };
    const { app } = await startApi();

    const res = await call(app, 'POST', '/api/workspaces/ws-default/members', {
      body: { userId: 'Dev1', role: 'admin' }
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/admin/i);
  });

  it('lets an admin make one', async () => {
    const { app } = await startApi();

    const res = await call(app, 'POST', '/api/workspaces/ws-default/members', {
      body: { userId: 'Dev1', role: 'admin' }
    });

    expect(res.status).toBe(201);
    expect(res.body.role).toBe('admin');
  });

  it('is not a developer’s to do', async () => {
    identity = { login: 'Dev1', role: 'dev' };
    const { app } = await startApi();

    const res = await call(app, 'POST', '/api/workspaces/ws-default/members', {
      body: { userId: 'Someone', role: 'dev' }
    });

    expect(res.status).toBe(403);
  });

  it('refuses a role that does not exist, and a missing person', async () => {
    identity = { login: 'PM1', role: 'pm' };
    const { app } = await startApi();

    expect((await call(app, 'POST', '/api/workspaces/ws-default/members', { body: { userId: 'Dev1', role: 'root' } })).status).toBe(400);
    expect((await call(app, 'POST', '/api/workspaces/ws-default/members', { body: { role: 'dev' } })).status).toBe(400);
  });

  it('cannot staff another workspace through its id', async () => {
    const { app, registry } = await startApi();
    const other = await registry.createWorkspace('Someone-else', { name: 'Not yours' });

    const res = await call(app, 'POST', `/api/workspaces/${other.id}/members`, {
      body: { userId: 'Dev1', role: 'dev' }
    });

    expect(res.status).toBe(404);
  });

  /** Typing a login exactly right is not a staffing workflow. */
  it('offers the organisation’s people, minus the ones already here', async () => {
    process.env.ALPHA_ORG = 'acme';
    identity = { login: 'PM1', role: 'pm' };
    const { app } = await startApi();
    const { useGitHubApi } = await import('../services/githubApi.js');
    useGitHubApi({
      get: async () => ({}) as any,
      getAll: async () => [{ login: 'Dev1', avatar_url: 'https://avatars/1' }, { login: 'PM1' }] as any,
      post: async () => ({}) as any,
      patch: async () => ({}) as any,
      put: async () => ({}) as any,
      delete: async () => {}
    });
    await call(app, 'POST', '/api/workspaces/ws-default/members', { body: { userId: 'PM1', role: 'pm' } });

    const res = await call(app, 'GET', '/api/workspaces/ws-default/members/candidates');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ login: 'Dev1', avatarUrl: 'https://avatars/1' }]);
    useGitHubApi(null);
    delete process.env.ALPHA_ORG;
  });

  /** Staffing by team: "the developers", with who is already here marked. */
  it('lists the organisation’s role-granting teams and their people', async () => {
    process.env.ALPHA_ORG = 'acme';
    identity = { login: 'PM1', role: 'pm' };
    const { app } = await startApi();
    const { useGitHubApi } = await import('../services/githubApi.js');
    const lists: Record<string, unknown[]> = {
      '/orgs/acme/teams?per_page=100': [
        { slug: 'developers', name: 'Developers' },
        { slug: 'project-managers', name: 'Project Managers' },
        // Grants no role, so its people could never open the workspace.
        { slug: 'book-club', name: 'Book Club' }
      ],
      '/orgs/acme/teams/developers/members?per_page=100': [{ login: 'Dev1', avatar_url: 'https://avatars/1' }],
      '/orgs/acme/teams/project-managers/members?per_page=100': [{ login: 'PM1' }]
    };
    useGitHubApi({
      get: async () => ({}) as any,
      getAll: async (path: string) => {
        if (!(path in lists)) throw new Error(`unexpected GitHub call ${path}`);
        return lists[path] as any;
      },
      post: async () => ({}) as any,
      patch: async () => ({}) as any,
      put: async () => ({}) as any,
      delete: async () => {}
    });
    await call(app, 'POST', '/api/workspaces/ws-default/members', { body: { userId: 'PM1', role: 'pm' } });

    const res = await call(app, 'GET', '/api/workspaces/ws-default/members/teams');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        slug: 'developers',
        name: 'Developers',
        role: 'dev',
        members: [{ login: 'Dev1', avatarUrl: 'https://avatars/1', workspaceRole: null }]
      },
      {
        slug: 'project-managers',
        name: 'Project Managers',
        role: 'pm',
        members: [{ login: 'PM1', avatarUrl: null, workspaceRole: 'pm' }]
      }
    ]);
    useGitHubApi(null);
    delete process.env.ALPHA_ORG;
  });

  it('keeps the team roster from developers', async () => {
    process.env.ALPHA_ORG = 'acme';
    identity = { login: 'Dev1', role: 'dev' };
    const { app } = await startApi();

    expect((await call(app, 'GET', '/api/workspaces/ws-default/members/teams')).status).toBe(403);
    delete process.env.ALPHA_ORG;
  });
});

describe('project assignments', () => {
  it('are managed by a PM, and decide what a developer sees', async () => {
    const { app, registry, svc } = await startApi();
    svc.createProject({ id: 'p1', name: 'Repo', key: 'ALF' });
    registry.bind('projects', 'p1', 'ws-default');
    await registry.listForUser('Dev1', 'dev');

    const assigned = await call(app, 'PUT', '/api/workspaces/ws-default/projects/p1/assignments/Dev1');
    expect(assigned.status).toBe(201);

    const listed = await call(app, 'GET', '/api/workspaces/ws-default/projects/p1/assignments');
    expect(listed.body).toHaveLength(1);

    const context = await registry.resolve('Dev1', 'ws-default', 'dev');
    expect(registry.canAccessProject(context!, 'p1')).toBe(true);

    expect((await call(app, 'DELETE', '/api/workspaces/ws-default/projects/p1/assignments/Dev1')).status).toBe(200);
    expect((await call(app, 'DELETE', '/api/workspaces/ws-default/projects/p1/assignments/Dev1')).status).toBe(404);
  });

  it('are not a developer’s to hand out', async () => {
    const { registry, svc } = await startApi();
    svc.createProject({ id: 'p1', name: 'Repo', key: 'ALF' });
    registry.bind('projects', 'p1', 'ws-default');
    await registry.assignProject('ws-default', 'p1', 'Dev1');

    identity = { login: 'Dev1', role: 'dev' };
    const { app: devApp } = await startApi();
    const res = await call(devApp, 'PUT', '/api/workspaces/ws-default/projects/p1/assignments/Dev2');
    expect(res.status).toBe(403);
  });
});
