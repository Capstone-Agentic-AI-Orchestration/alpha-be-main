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
  const { useAgentStores, useBoardChangeStore, useIssueStore, useProjectStore, useRunStore } = await import('../store/stores.js');
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
  const { PostgresBoardChangeStore } = await import('../store/postgresBoardChangeStore.js');

  workspaceRegistry.useDirectory(new PostgresWorkspaceDirectory(freshSqlFor(db), 'ws-default'));
  useBoardChangeStore(new PostgresBoardChangeStore(freshSqlFor(db)));
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

async function call(app: express.Express, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const { createServer } = await import('node:http');
  const server = createServer(app);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  try {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  } finally {
    await new Promise<void>(r => server.close(() => r()));
  }
}

async function createProject(app: express.Express, input: Record<string, unknown>) {
  const { workspaceRegistry } = await import('../services/workspaceRegistry.js');
  const { PostgresAgentStore } = await import('../store/postgresAgentStore.js');
  const { sqlFor: freshSqlFor } = await import('../store/testDatabase.js');
  await workspaceRegistry.resolve(session.login, 'ws-default', session.role as any);
  await new PostgresAgentStore(freshSqlFor(db)).ensureOfficial('ws-default');
  return call(app, 'POST', '/api/projects', { ...input, leadAgentId: 'agent-backend' });
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
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('the cloud project routes', () => {
  it('create a project in Postgres and read it back', async () => {
    const app = await startCloudApi();

    const created = await createProject(app, { name: 'Checkout', key: 'CHK' });
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
    const created = (await createProject(app, { name: 'Checkout', key: 'CHK' })).body;

    const updated = await call(app, 'PUT', `/api/projects/${created.id}`, { status: 'completed' });
    expect(updated.body).toMatchObject({ name: 'Checkout', status: 'completed' });

    expect((await call(app, 'DELETE', `/api/projects/${created.id}`)).body).toEqual({ success: true });
    expect((await db.query('select id from projects')).rows).toHaveLength(0);
  });

  /** The same answer the SQLite path gives, for the same mistake. */
  it('answer a duplicate key with 409, naming the field', async () => {
    const app = await startCloudApi();
    await createProject(app, { name: 'Checkout', key: 'CHK' });

    const again = await createProject(app, { name: 'Copy', key: 'CHK' });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/key is already taken/);
  });

  /**
   * Discovery is not access. A developer could not see the project they were
   * about to be put on, nor bind it to a folder on their machine before
   * someone assigned them an issue in it -- so the list now says what the
   * workspace has, and which of it is theirs.
   */
  /** Belonging to the workspace is the grant: a developer works in every project, no assignment needed. */
  it('show a developer every project in the workspace, as theirs to work in', async () => {
    const admin = await startCloudApi();
    await createProject(admin, { name: 'Checkout', key: 'CHK' });

    session = { login: 'Dev1', role: 'dev' };
    const dev = await startCloudApi();
    expect((await call(dev, 'GET', '/api/projects')).body.map((p: any) => [p.key, p.assigned])).toEqual([
      ['CHK', true]
    ]);
  });

  /** A client is not internal: they see the work they commissioned, and no more. */
  it('show a client only what they are assigned to', async () => {
    const admin = await startCloudApi();
    await createProject(admin, { name: 'Checkout', key: 'CHK' });

    session = { login: 'Client1', role: 'client' };
    const client = await startCloudApi();
    expect((await call(client, 'GET', '/api/projects')).body).toEqual([]);

    const { workspaceRegistry } = await import('../services/workspaceRegistry.js');
    const project = (await db.query<{ id: string }>('select id from projects')).rows[0];
    await workspaceRegistry.assignProject('ws-default', project.id, 'Client1');
    expect((await call(client, 'GET', '/api/projects')).body.map((p: any) => p.key)).toEqual(['CHK']);
  });

  /** An issue is work, not a catalogue entry: it stays behind assignment. */
  it('show a developer the issues of every project in the workspace', async () => {
    const admin = await startCloudApi();
    const project = (await createProject(admin, { name: 'Checkout', key: 'CHK' })).body;
    await call(admin, 'POST', '/api/issues', { title: 'Fix cart', projectId: project.id });

    session = { login: 'Dev1', role: 'dev' };
    const dev = await startCloudApi();

    expect((await call(dev, 'GET', '/api/issues')).body.map((i: any) => i.title)).toEqual(['Fix cart']);
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
    const created = (await createProject(app, { name: 'Checkout', key: 'CHK', createdBy: 'Someone-else' })).body;
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
    const project = (await createProject(pm, { name: 'Checkout', key: 'CHK' })).body;

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

describe('the cloud board change routes', () => {
  it('reads the watermark before a snapshot and returns bounded changed rows', async () => {
    const app = await startCloudApi();
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const clientHeaders = { 'X-Alpha-Client-Version': 'web-0.1.0' };
    const project = (await createProject(app, { name: 'Checkout', key: 'CHK' })).body;
    const beforeIssue = await db.query<{ cursor: string }>(`
      select last_cursor::text as cursor from workspace_board_cursors where workspace_id='ws-default'
    `);
    const created = await call(app, 'POST', '/api/issues', { title: 'Fix cart', projectId: project.id });

    const bootstrap = await call(app, 'GET', '/api/board/bootstrap', undefined, clientHeaders);
    expect(bootstrap.status).toBe(200);
    expect(bootstrap.body).toMatchObject({
      workspaceId: 'ws-default',
      cursor: { workspaceId: 'ws-default', value: expect.any(String) }
    });
    expect(bootstrap.body.projects.map((row: any) => row.id)).toContain(project.id);
    expect(bootstrap.body.issues.map((row: any) => row.id)).toContain(created.body.id);
    expect(BigInt(bootstrap.body.cursor.value)).toBeGreaterThan(BigInt(beforeIssue.rows[0].cursor));
    const bootstrapRows = bootstrap.body.projects.length + bootstrap.body.agents.length + bootstrap.body.issues.length
      + bootstrap.body.issues.reduce((total: number, issue: any) => total + issue.comments.length, 0);
    expect(JSON.parse(String(info.mock.calls[0][0]))).toEqual({
      event: 'board_sync_metric',
      workspaceId: 'ws-default',
      clientVersion: 'web-0.1.0',
      kind: 'snapshot',
      changedRows: bootstrapRows,
      responseBytes: Buffer.byteLength(JSON.stringify(bootstrap.body), 'utf8')
    });

    const page = await call(app, 'POST', '/api/board/changes', {
      cursor: { workspaceId: 'ws-default', value: beforeIssue.rows[0].cursor },
      limit: 1
    }, clientHeaders);
    expect(page.status).toBe(200);
    expect(page.body.changes).toHaveLength(1);
    expect(page.body.changes[0]).toMatchObject({
      table: 'issues',
      operation: 'insert',
      row: { id: created.body.id, title: 'Fix cart' }
    });
    expect(page.body.hasMore).toBe(true);
    expect(BigInt(page.body.nextCursor.value)).toBeGreaterThan(BigInt(beforeIssue.rows[0].cursor));
    expect(JSON.parse(String(info.mock.calls[1][0]))).toEqual({
      event: 'board_sync_metric',
      workspaceId: 'ws-default',
      clientVersion: 'web-0.1.0',
      kind: 'delta',
      changedRows: 1,
      responseBytes: Buffer.byteLength(JSON.stringify(page.body), 'utf8')
    });
    expect(info.mock.calls.map(([line]) => String(line)).join('\n')).not.toContain(created.body.id);
    expect(info.mock.calls.map(([line]) => String(line)).join('\n')).not.toContain('Fix cart');
  });

  it('rejects a cursor that belongs to a different workspace', async () => {
    const app = await startCloudApi();
    const response = await call(app, 'POST', '/api/board/changes', {
      cursor: { workspaceId: 'ws-someone-else', value: '0' }
    });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/cursor.*workspace/i);
  });

  it('coalesces repeated changes to the latest value of a row', async () => {
    const app = await startCloudApi();
    const project = (await createProject(app, { name: 'Checkout', key: 'CHK' })).body;
    const beforeChanges = await db.query<{ cursor: string }>(`
      select last_cursor::text as cursor from workspace_board_cursors where workspace_id='ws-default'
    `);
    await call(app, 'PUT', `/api/projects/${project.id}`, { name: 'Intermediate name' });
    await call(app, 'PUT', `/api/projects/${project.id}`, { name: 'Latest name' });

    const response = await call(app, 'POST', '/api/board/changes', {
      cursor: { workspaceId: 'ws-default', value: beforeChanges.rows[0].cursor },
      limit: 100
    });
    const projectChanges = response.body.changes.filter((change: any) =>
      change.table === 'projects' && change.rowKey.id === project.id
    );
    expect(projectChanges).toHaveLength(1);
    expect(projectChanges[0]).toMatchObject({
      operation: 'update',
      row: { id: project.id, name: 'Latest name' }
    });
  });

  it('asks for a bootstrap when the cursor is ahead or its history was pruned', async () => {
    const app = await startCloudApi();
    await createProject(app, { name: 'Checkout', key: 'CHK' });
    const watermark = await db.query<{ cursor: string }>(`
      select last_cursor::text as cursor from workspace_board_cursors where workspace_id='ws-default'
    `);

    const future = await call(app, 'POST', '/api/board/changes', {
      cursor: { workspaceId: 'ws-default', value: (BigInt(watermark.rows[0].cursor) + 1n).toString() }
    });
    expect(future.status).toBe(200);
    expect(future.body).toMatchObject({ resetRequired: true, changes: [] });

    await db.exec(`delete from workspace_board_changes where workspace_id='ws-default'`);
    const stale = await call(app, 'POST', '/api/board/changes', {
      cursor: { workspaceId: 'ws-default', value: '0' }
    });
    expect(stale.status).toBe(200);
    expect(stale.body).toMatchObject({ resetRequired: true, changes: [] });
  });

  it('skips issue and comment entries for a role without issue.read but still advances', async () => {
    const pm = await startCloudApi();
    const project = (await createProject(pm, { name: 'Checkout', key: 'CHK' })).body;
    const beforeIssue = await db.query<{ cursor: string }>(`
      select last_cursor::text as cursor from workspace_board_cursors where workspace_id='ws-default'
    `);
    await call(pm, 'POST', '/api/issues', { title: 'Secret issue', projectId: project.id });

    session = { login: 'Client1', role: 'client' };
    const client = await startCloudApi();
    const response = await call(client, 'POST', '/api/board/changes', {
      cursor: { workspaceId: 'ws-default', value: beforeIssue.rows[0].cursor },
      limit: 100
    });
    expect(response.status).toBe(200);
    expect(response.body.changes).toEqual([]);
    expect(BigInt(response.body.nextCursor.value)).toBeGreaterThan(BigInt(beforeIssue.rows[0].cursor));
  });
});

describe('the cloud issue routes', () => {
  /** Every issue hangs off a project, so each test starts with one. */
  async function withProject(app: express.Express) {
    const project = (await createProject(app, { name: 'Checkout', key: 'CHK' })).body;
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
    // The roster endpoint creates the official roles for a newly resolved
    // default workspace before returning the rows from Postgres.
    const initial = await call(app, 'GET', '/api/agents');
    expect(initial.status).toBe(200);
    expect(initial.body.length).toBeGreaterThan(0);
    expect(initial.body.every((agent: any) => agent.isSeeded)).toBe(true);

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

    const project = (await createProject(app, { name: 'Checkout', key: 'CHK' })).body;
    const agents = new PostgresAgentStore(freshSqlFor(db));
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
    workspaceRegistry.bind('projects', project.id, 'ws-default');
    workspaceRegistry.bind('agents', 'agent-private', 'ws-default');

    // No squad is involved: the agent's own visibility is the only limit.
    const asAdmin = (await workspaceRegistry.resolve('Admin1', 'ws-default', 'admin'))!;
    expect(await workspaceRegistry.canAccessProjectAgentRun(asAdmin, project.id, 'agent-private')).toBe(false);

    const asOwner = (await workspaceRegistry.resolve('Someone-else', 'ws-default', 'admin'))!;
    expect(await workspaceRegistry.canAccessProjectAgentRun(asOwner, project.id, 'agent-private')).toBe(true);
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
  it('seeds the default workspace and its roster into an empty database', async () => {
    await startCloudApi();
    const { seedDefaultWorkspace } = await import('./workspaceController.js');

    await seedDefaultWorkspace();

    const count = async (table: string) =>
      Number((await db.query<{ n: number }>(`select count(*)::int as n from ${table}`)).rows[0].n);
    expect(await count('workspaces')).toBe(1);
    expect(await count('agents')).toBeGreaterThan(0);
    // Squads were removed; the Orchestrator assigns agents per task.
    expect(await count('squads')).toBe(0);
  });

  it('adds nothing on a second boot', async () => {
    await startCloudApi();
    const { seedDefaultWorkspace } = await import('./workspaceController.js');

    await seedDefaultWorkspace();
    const agents = (await db.query('select id from agents')).rows.length;
    await seedDefaultWorkspace();

    expect((await db.query('select id from agents')).rows).toHaveLength(agents);
    expect((await db.query('select id from squads')).rows).toHaveLength(0);
  });

  /** Why the order matters, stated as the failure it prevents. */
  it('cannot seed agents before the workspace row exists', async () => {
    await startCloudApi();
    const { agentStore } = await import('../store/stores.js');

    await expect(agentStore().ensureOfficial('ws-default')).rejects.toThrow();
  });
});
