import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTestDatabase, sqlFor } from '../store/testDatabase.js';

/**
 * The cloud's board, end to end.
 *
 * Cloud mode, the real middleware, the real routes, and both stores on a real
 * Postgres — so what this exercises is the path Render runs: a session
 * resolves a workspace out of Postgres, and the project routes read and write
 * Postgres rows scoped to it.
 *
 * The seams here are the two stores, which is the whole point of the store
 * driver: a test can hand the cloud a database without a container.
 */

let db: PGlite;
let tmp: string;
let opened: { close(): void }[] = [];
// A project manager: projects are started by one (fe #32), and every suite here starts with one.
let session = { login: 'PM1', role: 'pm' };

beforeAll(async () => {
  db = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await db?.close();
});

async function startCloudApi() {
  process.env.ALPHA_MODE = 'cloud';
  process.env.ALPHA_HOME = tmp;
  vi.resetModules();

  const { workspaceRegistry } = await import('../services/workspaceRegistry.js');
  const { PostgresWorkspaceDirectory } = await import('../store/postgresWorkspaceDirectory.js');
  const { PostgresProjectStore } = await import('../store/postgresProjectStore.js');
  const { PostgresIssueStore } = await import('../store/postgresIssueStore.js');
  const { PostgresAgentStore, PostgresSquadStore } = await import('../store/postgresAgentStore.js');
  const { PostgresRunStore } = await import('../store/postgresRunStore.js');
  const { useAgentStores, useIssueStore, useProjectStore, useRunStore } = await import('../store/stores.js');
  const { workspaceContext } = await import('./workspaceContext.js');
  const { dataRouter } = await import('./dataController.js');
  const { jsonErrorHandler } = await import('./errorHandler.js');
  const sql = await import('../services/sqliteService.js');
  /*
   * Imported here, not at the top of the file: `resetModules` gives this app
   * its own copy of every module, and a `DatabaseError` thrown by one copy is
   * not an `instanceof` the class another copy's error handler tests against.
   * The connection has to come from the same registry as the handler.
   */
  const { sqlFor: freshSqlFor } = await import('../store/testDatabase.js');

  workspaceRegistry.useDirectory(new PostgresWorkspaceDirectory(freshSqlFor(db), 'ws-default'));
  useProjectStore(new PostgresProjectStore(freshSqlFor(db)));
  useIssueStore(new PostgresIssueStore(freshSqlFor(db)));
  useAgentStores(new PostgresAgentStore(freshSqlFor(db)), new PostgresSquadStore(freshSqlFor(db)));
  // The issue lifecycle guard reads runs, to refuse a status change mid-run.
  useRunStore(new PostgresRunStore(freshSqlFor(db)));
  // Nothing here opens SQLite any more; closed in case a regression does.
  opened.push(workspaceRegistry, sql.sqliteService);

  const app = express();
  app.use(express.json());
  // What `sessionContext` sets in the cloud, without the cookie machinery.
  app.use((req, _res, next) => {
    (req as any).session = {
      login: session.login,
      role: session.role,
      githubToken: 'gho_test',
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    };
    next();
  });
  app.use('/api', workspaceContext);
  app.use('/api', dataRouter);
  app.use(jsonErrorHandler);
  return app;
}

async function call(app: express.Express, method: string, url: string, body?: unknown) {
  const { createServer } = await import('node:http');
  const server = createServer(app);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  try {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  } finally {
    await new Promise<void>(r => server.close(() => r()));
  }
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-projectroutes-'));
  opened = [];
  session = { login: 'PM1', role: 'pm' };
  await db.exec('truncate issues, issue_comments, projects, agents, squads, workspaces, workspace_members cascade');
});

afterEach(() => {
  for (const handle of opened) {
    try {
      handle.close();
    } catch {
      /* already closed */
    }
  }
  delete process.env.ALPHA_MODE;
  delete process.env.ALPHA_HOME;
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* windows handle */
  }
  vi.resetModules();
});

describe('the cloud project routes', () => {
  it('create a project in Postgres and read it back', async () => {
    const app = await startCloudApi();

    const created = await call(app, 'POST', '/api/projects', { name: 'Checkout', key: 'CHK' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'Checkout', key: 'CHK' });

    const { rows } = await db.query<{ id: string; workspace_id: string }>('select id, workspace_id from projects');
    expect(rows).toHaveLength(1);
    expect(rows[0].workspace_id).toBe('ws-default');

    const listed = await call(app, 'GET', '/api/projects');
    expect(listed.body.map((p: any) => p.key)).toEqual(['CHK']);
  });

  it('update and delete the row that is actually there', async () => {
    const app = await startCloudApi();
    const created = (await call(app, 'POST', '/api/projects', { name: 'Checkout', key: 'CHK' })).body;

    const updated = await call(app, 'PUT', `/api/projects/${created.id}`, { status: 'completed' });
    expect(updated.body).toMatchObject({ name: 'Checkout', status: 'completed' });

    expect((await call(app, 'DELETE', `/api/projects/${created.id}`)).body).toEqual({ success: true });
    expect((await db.query('select id from projects')).rows).toHaveLength(0);
  });

  /** The same answer the SQLite path gives, for the same mistake. */
  it('answer a duplicate key with 409, naming the field', async () => {
    const app = await startCloudApi();
    await call(app, 'POST', '/api/projects', { name: 'Checkout', key: 'CHK' });

    const again = await call(app, 'POST', '/api/projects', { name: 'Copy', key: 'CHK' });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/key is already taken/);
  });

  /**
   * Discovery is not access. A developer could not see the project they were
   * about to be put on, nor bind it to a folder on their machine before
   * someone assigned them an issue in it -- so the list now says what the
   * workspace has, and which of it is theirs.
   */
  it('show a developer the workspace’s projects, and which are theirs', async () => {
    const admin = await startCloudApi();
    await call(admin, 'POST', '/api/projects', { name: 'Checkout', key: 'CHK' });

    session = { login: 'Dev1', role: 'dev' };
    const dev = await startCloudApi();
    expect((await call(dev, 'GET', '/api/projects')).body.map((p: any) => [p.key, p.assigned])).toEqual([
      ['CHK', false]
    ]);

    const { workspaceRegistry } = await import('../services/workspaceRegistry.js');
    const project = (await db.query<{ id: string }>('select id from projects')).rows[0];
    await workspaceRegistry.assignProject('ws-default', project.id, 'Dev1');
    expect((await call(dev, 'GET', '/api/projects')).body.map((p: any) => [p.key, p.assigned])).toEqual([
      ['CHK', true]
    ]);
  });

  /** A client is not internal: they see the work they commissioned, and no more. */
  it('show a client only what they are assigned to', async () => {
    const admin = await startCloudApi();
    await call(admin, 'POST', '/api/projects', { name: 'Checkout', key: 'CHK' });

    session = { login: 'Client1', role: 'client' };
    const client = await startCloudApi();
    expect((await call(client, 'GET', '/api/projects')).body).toEqual([]);

    const { workspaceRegistry } = await import('../services/workspaceRegistry.js');
    const project = (await db.query<{ id: string }>('select id from projects')).rows[0];
    await workspaceRegistry.assignProject('ws-default', project.id, 'Client1');
    expect((await call(client, 'GET', '/api/projects')).body.map((p: any) => p.key)).toEqual(['CHK']);
  });

  /** An issue is work, not a catalogue entry: it stays behind assignment. */
  it('still show a developer no issues from a project they are not on', async () => {
    const admin = await startCloudApi();
    const project = (await call(admin, 'POST', '/api/projects', { name: 'Checkout', key: 'CHK' })).body;
    await call(admin, 'POST', '/api/issues', { title: 'Fix cart', projectId: project.id });

    session = { login: 'Dev1', role: 'dev' };
    const dev = await startCloudApi();

    expect((await call(dev, 'GET', '/api/issues')).body).toEqual([]);
  });

  /** Projects are started by project managers; an admin's would have no PM behind it. */
  it('refuse an admin creating one', async () => {
    session = { login: 'Admin1', role: 'admin' };
    const app = await startCloudApi();

    const res = await call(app, 'POST', '/api/projects', { name: 'Mine', key: 'MINE' });
    expect(res.status).toBe(403);
    expect((await db.query('select id from projects')).rows).toHaveLength(0);
  });

  /** The creator is the person signed in, never what the request claims. */
  it('record the PM who created it, whatever the request says', async () => {
    const app = await startCloudApi();
    const created = (await call(app, 'POST', '/api/projects', { name: 'Checkout', key: 'CHK', createdBy: 'Someone-else' })).body;
    expect(created.createdBy).toBe('PM1');

    // And an edit cannot re-home it.
    await call(app, 'PUT', `/api/projects/${created.id}`, { createdBy: 'Someone-else', name: 'Checkout v2' });
    const { rows } = await db.query<{ created_by: string; name: string }>('select created_by, name from projects');
    expect(rows[0]).toEqual({ created_by: 'PM1', name: 'Checkout v2' });
  });

  /** A repository the org sync imported has no PM behind it, and is nobody's catalogue entry. */
  it('leave a project with no PM behind it out of the catalogue', async () => {
    const app = await startCloudApi();
    await call(app, 'GET', '/api/projects'); // the default workspace exists once someone has asked
    await db.exec("insert into projects (id, workspace_id, name, key) values ('p-import', 'ws-default', 'Imported', 'IMP')");

    session = { login: 'Dev1', role: 'dev' };
    const dev = await startCloudApi();
    expect((await call(dev, 'GET', '/api/projects')).body).toEqual([]);
    void app;
  });

  /** Developers run projects: they edit one, they do not start or remove one. */
  it('let a developer edit a project, but not delete it', async () => {
    const pm = await startCloudApi();
    const project = (await call(pm, 'POST', '/api/projects', { name: 'Checkout', key: 'CHK' })).body;

    session = { login: 'Dev1', role: 'dev' };
    const dev = await startCloudApi();
    const edited = await call(dev, 'PUT', `/api/projects/${project.id}`, { status: 'completed' });
    expect(edited.status).toBe(200);
    expect(edited.body.status).toBe('completed');

    expect((await call(dev, 'DELETE', `/api/projects/${project.id}`)).status).toBe(403);
    expect((await db.query('select id from projects')).rows).toHaveLength(1);
  });

  it('refuse a developer creating one', async () => {
    session = { login: 'Dev1', role: 'dev' };
    const app = await startCloudApi();

    const res = await call(app, 'POST', '/api/projects', { name: 'Mine', key: 'MINE' });
    expect(res.status).toBe(403);
    expect((await db.query('select id from projects')).rows).toHaveLength(0);
  });
});

describe('the cloud issue routes', () => {
  /** Every issue hangs off a project, so each test starts with one. */
  async function withProject(app: express.Express) {
    const project = (await call(app, 'POST', '/api/projects', { name: 'Checkout', key: 'CHK' })).body;
    return project.id as string;
  }

  it('create a card, numbered in the project’s scheme, with its opening comment', async () => {
    const app = await startCloudApi();
    const projectId = await withProject(app);

    const created = await call(app, 'POST', '/api/issues', { title: 'Cart loses items', projectId });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ identifier: 'CHK-101', title: 'Cart loses items' });
    // The opening comment is written where the real identifier is known.
    expect(created.body.comments.map((c: any) => c.content)).toEqual([
      expect.stringContaining('CHK-101 created by')
    ]);

    const { rows } = await db.query<{ workspace_id: string }>('select workspace_id from issues');
    expect(rows).toEqual([{ workspace_id: 'ws-default' }]);
  });

  it('list, update and delete the rows that are actually there', async () => {
    const app = await startCloudApi();
    const projectId = await withProject(app);
    const issue = (await call(app, 'POST', '/api/issues', { title: 'Cart loses items', projectId })).body;

    expect((await call(app, 'GET', '/api/issues')).body.map((i: any) => i.id)).toEqual([issue.id]);

    const moved = await call(app, 'PUT', `/api/issues/${issue.id}`, { status: 'in_progress' });
    expect(moved.body).toMatchObject({ status: 'in_progress', title: 'Cart loses items' });

    expect((await call(app, 'DELETE', `/api/issues/${issue.id}`)).body).toEqual({ success: true });
    expect((await db.query('select id from issues')).rows).toHaveLength(0);
  });

  it('add a comment to a card', async () => {
    const app = await startCloudApi();
    const projectId = await withProject(app);
    const issue = (await call(app, 'POST', '/api/issues', { title: 'Cart loses items', projectId })).body;

    const added = await call(app, 'POST', `/api/issues/${issue.id}/comments`, {
      id: 'c-manual',
      authorType: 'user',
      authorName: 'LloydLim1',
      content: 'Reproduced on staging.'
    });
    expect(added.status).toBe(201);

    const read = (await call(app, 'GET', '/api/issues')).body[0];
    expect(read.comments.map((c: any) => c.content)).toContain('Reproduced on staging.');
  });

  it('refuse a client, who has no business in the tracker', async () => {
    const admin = await startCloudApi();
    const projectId = await withProject(admin);

    session = { login: 'Client1', role: 'client' };
    const client = await startCloudApi();
    const res = await call(client, 'POST', '/api/issues', { title: 'Mine', projectId });

    expect(res.status).toBe(403);
    expect((await db.query('select id from issues')).rows).toHaveLength(0);
  });
});

describe('the cloud roster routes', () => {
  it('serve the agents the workspace actually has in Postgres', async () => {
    const app = await startCloudApi();
    // One request first, so the directory has created the default workspace
    // the roster hangs off — as it does on a real boot.
    expect((await call(app, 'GET', '/api/agents')).body).toEqual([]);

    const { PostgresAgentStore } = await import('../store/postgresAgentStore.js');
    const { sqlFor: freshSqlFor } = await import('../store/testDatabase.js');
    // What the cloud seeds at boot for the default workspace.
    await new PostgresAgentStore(freshSqlFor(db)).ensureOfficial('ws-default');

    const listed = await call(app, 'GET', '/api/agents');
    expect(listed.status).toBe(200);
    expect(listed.body.length).toBeGreaterThan(0);
    expect(listed.body.every((agent: any) => agent.isSeeded)).toBe(true);

    // And nothing machine-local rode along.
    expect(listed.body.every((agent: any) => agent.customCliArgs === '')).toBe(true);
  });

  it('create, edit and archive an agent', async () => {
    session = { login: 'Admin1', role: 'admin' };
    const app = await startCloudApi();

    const created = await call(app, 'POST', '/api/agents', {
      id: 'agent-mine',
      name: 'Reviewer',
      role: 'Review Agent',
      avatar: '◆',
      color: '#111111',
      description: 'Reviews changes',
      owner: 'Admin1',
      isMine: true,
      modelProvider: 'OpenAI',
      modelName: 'gpt-5',
      systemPrompt: 'Review carefully.',
      autonomyLevel: 'Supervised',
      skills: [],
      mcpServers: [],
      createdAt: new Date().toISOString()
    });
    expect(created.status).toBe(201);

    const renamed = await call(app, 'PUT', '/api/agents/agent-mine', { name: 'Senior Reviewer' });
    expect(renamed.body).toMatchObject({ name: 'Senior Reviewer' });

    const { rows } = await db.query<{ name: string; workspace_id: string }>(
      "select name, workspace_id from agents where id = 'agent-mine'"
    );
    expect(rows[0]).toMatchObject({ name: 'Senior Reviewer', workspace_id: 'ws-default' });
  });

  it('lets a project manager staff an agent for the workspace', async () => {
    session = { login: 'PM1', role: 'pm' };
    const app = await startCloudApi();

    const created = await call(app, 'POST', '/api/agents', {
      id: 'agent-pm-created',
      name: 'Project Reviewer',
      role: 'Review Agent',
      avatar: '◆',
      color: '#111111',
      description: 'Reviews a PM-owned project',
      owner: 'PM1',
      isMine: true,
      modelProvider: 'OpenAI',
      modelName: 'gpt-5',
      systemPrompt: 'Review carefully.',
      autonomyLevel: 'Supervised',
      skills: [],
      mcpServers: [],
      createdAt: new Date().toISOString()
    });

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'Project Reviewer', owner: 'PM1' });
  });

  /**
   * The check that reads the roster.
   *
   * It used to ask this process's SQLite, which in the cloud holds no agents
   * at all — so every agent read as "not available", whatever the database
   * said. A private agent is still refused; its owner still gets it.
   */
  it('decide agent visibility from the shared roster', async () => {
    const app = await startCloudApi();
    const { workspaceRegistry } = await import('../services/workspaceRegistry.js');
    const { PostgresAgentStore, PostgresSquadStore } = await import('../store/postgresAgentStore.js');
    const { sqlFor: freshSqlFor } = await import('../store/testDatabase.js');

    const project = (await call(app, 'POST', '/api/projects', { name: 'Checkout', key: 'CHK' })).body;
    const agents = new PostgresAgentStore(freshSqlFor(db));
    const squads = new PostgresSquadStore(freshSqlFor(db));
    await agents.create('ws-default', {
      id: 'agent-private',
      name: 'Private',
      role: 'Review Agent',
      avatar: '◆',
      color: '#111',
      description: '',
      owner: 'Someone-else',
      isMine: false,
      modelProvider: 'OpenAI',
      modelName: 'gpt-5',
      systemPrompt: '',
      autonomyLevel: 'Supervised',
      skills: [],
      mcpServers: [],
      allowedUsers: 'private',
      createdAt: new Date().toISOString()
    } as any);
    await squads.create('ws-default', {
      id: 'squad-1',
      name: 'Squad',
      description: '',
      avatar: '◈',
      color: '#111',
      topology: 'Sequential',
      memberAgentIds: ['agent-private'],
      mission: '',
      activeRunsCount: 0,
      completedRunsCount: 0
    } as any);
    await workspaceRegistry.assignSquadProject('ws-default', 'squad-1', project.id, 'assigned');
    workspaceRegistry.bind('projects', project.id, 'ws-default');
    workspaceRegistry.bind('squads', 'squad-1', 'ws-default');
    workspaceRegistry.bind('agents', 'agent-private', 'ws-default');

    const asAdmin = (await workspaceRegistry.resolve('Admin1', 'ws-default', 'admin'))!;
    expect(await workspaceRegistry.canAccessProjectAgent(asAdmin, project.id, 'squad-1', 'agent-private')).toBe(false);

    const asOwner = (await workspaceRegistry.resolve('Someone-else', 'ws-default', 'admin'))!;
    expect(await workspaceRegistry.canAccessProjectAgent(asOwner, project.id, 'squad-1', 'agent-private')).toBe(true);
  });
});

/**
 * What a fresh deploy does before anyone signs in.
 *
 * The first version of this seeded the roster at boot straight into a
 * database with no default workspace row yet -- that row was made by the first
 * sign-in -- so every agent failed its foreign key, the error went to a log,
 * and the shared workspace went live with no agents. The earlier test missed
 * it by making a request first, which created the row. This one starts from
 * nothing, as a real boot does.
 */
describe('the cloud boot', () => {
  it('seeds the default workspace, its roster and its core squad into an empty database', async () => {
    await startCloudApi();
    const { seedDefaultWorkspace } = await import('./workspaceController.js');

    await seedDefaultWorkspace();

    const count = async (table: string) =>
      Number((await db.query<{ n: number }>(`select count(*)::int as n from ${table}`)).rows[0].n);
    expect(await count('workspaces')).toBe(1);
    expect(await count('agents')).toBeGreaterThan(0);
    expect(await count('squads')).toBe(1);
  });

  it('adds nothing on a second boot', async () => {
    await startCloudApi();
    const { seedDefaultWorkspace } = await import('./workspaceController.js');

    await seedDefaultWorkspace();
    const agents = (await db.query('select id from agents')).rows.length;
    await seedDefaultWorkspace();

    expect((await db.query('select id from agents')).rows).toHaveLength(agents);
    expect((await db.query('select id from squads')).rows).toHaveLength(1);
  });

  /** Why the order matters, stated as the failure it prevents. */
  it('cannot seed agents before the workspace row exists', async () => {
    await startCloudApi();
    const { agentStore } = await import('../store/stores.js');

    await expect(agentStore().ensureOfficial('ws-default')).rejects.toThrow();
  });
});
