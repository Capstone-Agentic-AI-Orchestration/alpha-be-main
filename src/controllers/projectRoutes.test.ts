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
let session = { login: 'Admin1', role: 'admin' };

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
  const { useProjectStore } = await import('../store/stores.js');
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
  // Entity bindings are still SQLite in both modes; the board's rows move off
  // it in the slice after this one.
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
  session = { login: 'Admin1', role: 'admin' };
  await db.exec('truncate projects, workspaces, workspace_members cascade');
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

  it('show a developer nothing they are not assigned to', async () => {
    const admin = await startCloudApi();
    await call(admin, 'POST', '/api/projects', { name: 'Checkout', key: 'CHK' });

    session = { login: 'Dev1', role: 'dev' };
    const dev = await startCloudApi();
    expect((await call(dev, 'GET', '/api/projects')).body).toEqual([]);

    // Assigned, and it appears.
    const { workspaceRegistry } = await import('../services/workspaceRegistry.js');
    const project = (await db.query<{ id: string }>('select id from projects')).rows[0];
    await workspaceRegistry.assignProject('ws-default', project.id, 'Dev1');
    expect((await call(dev, 'GET', '/api/projects')).body.map((p: any) => p.key)).toEqual(['CHK']);
  });

  it('refuse a developer creating one', async () => {
    session = { login: 'Dev1', role: 'dev' };
    const app = await startCloudApi();

    const res = await call(app, 'POST', '/api/projects', { name: 'Mine', key: 'MINE' });
    expect(res.status).toBe(403);
    expect((await db.query('select id from projects')).rows).toHaveLength(0);
  });
});
