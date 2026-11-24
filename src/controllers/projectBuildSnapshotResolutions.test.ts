import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The build snapshot carries the "Resolved without you" list (fixes the Orchestrator made on its
 * own). It is the team's: clients see nothing about orchestration, so a client never loads it.
 */

let tmp: string;
let opened: { close(): void }[] = [];
let role = 'dev';

async function startApi() {
  process.env.ALPHA_HOME = path.join(tmp, 'home');
  delete process.env.ALPHA_MODE;
  vi.resetModules();
  vi.doMock('../services/identityService.js', () => ({
    currentIdentity: async () => ({ login: 'Dev1', source: 'github', role, access: 'granted', github: 'ok', teams: [] }),
    warmIdentity: () => {},
    knownIdentity: () => ({ login: 'Dev1', source: 'github' })
  }));
  const sql = await import('../services/sqliteService.js');
  opened.push(sql.sqliteService);
  opened.push((await import('../services/workspaceRegistry.js')).workspaceRegistry);
  const { projectBuildSnapshotRouter } = await import('./projectBuildSnapshotController.js');
  const { workspaceContext } = await import('./workspaceContext.js');
  const { jsonErrorHandler } = await import('./errorHandler.js');
  const app = express();
  app.use(express.json());
  app.use('/api', workspaceContext);
  app.use('/api', projectBuildSnapshotRouter);
  app.use(jsonErrorHandler);
  const { runWithWorkspace } = await import('../services/workspaceContext.js');
  runWithWorkspace('ws-default', () => sql.sqliteService.createProject({ id: 'p1', name: 'Shop', key: 'SHP' } as any));
  return app;
}

async function get(app: express.Express, url: string) {
  const { createServer } = await import('node:http');
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  try {
    const res = await fetch(`http://127.0.0.1:${port}${url}`);
    return { status: res.status, text: await res.text() };
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-resolved-'));
  opened = [];
  role = 'dev';
});

afterEach(() => {
  for (const handle of opened) {
    try { handle.close(); } catch { /* already closed */ }
  }
  delete process.env.ALPHA_HOME;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* windows handle */ }
  vi.doUnmock('../services/identityService.js');
  vi.resetModules();
});

describe('build snapshot: resolved without you', () => {
  it('is served to the team', async () => {
    const app = await startApi();
    const res = await get(app, '/api/projects/p1/build-snapshot');
    expect(res.status).toBe(200);
  });

  it('is never served to a client', async () => {
    const app = await startApi();
    role = 'client';
    const res = await get(app, '/api/projects/p1/build-snapshot');
    expect(res.status).toBe(403);
    expect(res.text).not.toMatch(/resolvedWithoutYou|orchestration/i);
  });
});
