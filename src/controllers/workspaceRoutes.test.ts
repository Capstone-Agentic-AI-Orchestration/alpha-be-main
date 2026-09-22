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
  vi.doMock('../services/identityService.js', () => ({
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
    expect(res.body.error).toMatch(/admin/i);
  });

  it('wants a name', async () => {
    const { app } = await startApi();
    expect((await call(app, 'POST', '/api/workspaces', { body: {} })).status).toBe(400);
  });
});

describe('POST /workspaces/join', () => {
  it('joins with the invite code, at the role GitHub gives', async () => {
    const { app, registry } = await startApi();
    const workspace = await registry.createWorkspace('Owner1', { name: 'Team Alpha' });

    identity = { login: 'Dev1', role: 'dev' };
    const res = await call(app, 'POST', '/api/workspaces/join', { body: { code: workspace.joinCode } });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: workspace.id, role: 'dev' });
    // And it is theirs from then on.
    expect((await call(app, 'GET', '/api/workspaces')).body.map((w: any) => w.id)).toContain(workspace.id);
  });

  /** The slug is on every listing; accepting it would open every workspace. */
  it('refuses the slug, the id, and a code that matches nothing', async () => {
    const { app, registry } = await startApi();
    const workspace = await registry.createWorkspace('Owner1', { name: 'Team Alpha' });
    identity = { login: 'Dev1', role: 'dev' };

    expect((await call(app, 'POST', '/api/workspaces/join', { body: { code: workspace.slug } })).status).toBe(404);
    expect((await call(app, 'POST', '/api/workspaces/join', { body: { code: workspace.id } })).status).toBe(404);
    expect((await call(app, 'POST', '/api/workspaces/join', { body: { code: 'nope' } })).status).toBe(404);
    expect((await call(app, 'POST', '/api/workspaces/join', { body: {} })).status).toBe(400);
  });
});

describe('members', () => {
  it('are listed for a PM or admin, and not for a developer', async () => {
    const { app } = await startApi();
    expect((await call(app, 'GET', '/api/workspaces/ws-default/members')).status).toBe(200);

    identity = { login: 'Dev1', role: 'dev' };
    const { app: devApp } = await startApi();
    expect((await call(devApp, 'GET', '/api/workspaces/ws-default/members')).status).toBe(403);
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

    identity = { login: 'Dev1', role: 'dev' };
    const { app: devApp } = await startApi();
    expect(
      (await call(devApp, 'PATCH', `/api/workspaces/ws-default/members/${member.id}`, { body: { role: 'admin' } }))
        .status
    ).toBe(403);
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
