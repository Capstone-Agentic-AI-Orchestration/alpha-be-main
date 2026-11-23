import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The project's autonomy setting: how far Alpha resolves a stuck build on its own. It is the
 * team's, so it defaults to `standard`, a developer or PM can change it, and a client never sees
 * or changes it (clients see nothing about orchestration).
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
  const { dataRouter } = await import('./dataController.js');
  const { workspaceContext } = await import('./workspaceContext.js');
  const { jsonErrorHandler } = await import('./errorHandler.js');
  const app = express();
  app.use(express.json());
  app.use('/api', workspaceContext);
  app.use('/api', dataRouter);
  app.use(jsonErrorHandler);
  const { runWithWorkspace } = await import('../services/workspaceContext.js');
  runWithWorkspace('ws-default', () => sql.sqliteService.createProject({ id: 'p1', name: 'Shop', key: 'SHP' } as any));
  return app;
}

async function call(app: express.Express, method: string, url: string, body?: unknown) {
  const { createServer } = await import('node:http');
  const server = createServer(app);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  try {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  } finally {
    await new Promise<void>(r => server.close(() => r()));
  }
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-autonomy-'));
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

describe('project autonomy setting', () => {
  it('defaults to standard and lets the team change it and add sensitive paths', async () => {
    const app = await startApi();
    const initial = await call(app, 'GET', '/api/projects/p1/orchestration-settings');
    expect(initial.status).toBe(200);
    expect(initial.body).toMatchObject({ enabled: true, autonomy: 'standard', sensitivePaths: [] });

    const strict = await call(app, 'PUT', '/api/projects/p1/orchestration-settings', { autonomy: 'strict', sensitivePaths: ['src/pricing/**'] });
    expect(strict.status).toBe(200);
    expect(strict.body).toMatchObject({ autonomy: 'strict', sensitivePaths: ['src/pricing/**'] });
    expect((await call(app, 'PUT', '/api/projects/p1/orchestration-settings', { enabled: true })).body).toMatchObject({ autonomy: 'strict' });
    expect((await call(app, 'GET', '/api/projects/p1/orchestration-settings')).body).toMatchObject({ autonomy: 'strict', sensitivePaths: ['src/pricing/**'] });
  });

  it('refuses unknown levels and unsafe path patterns', async () => {
    const app = await startApi();
    expect((await call(app, 'PUT', '/api/projects/p1/orchestration-settings', { autonomy: 'yolo' })).status).toBe(400);
    expect((await call(app, 'PUT', '/api/projects/p1/orchestration-settings', { sensitivePaths: ['../outside/**'] })).status).toBe(400);
    expect((await call(app, 'PUT', '/api/projects/p1/orchestration-settings', { sensitivePaths: ['/etc/**'] })).status).toBe(400);
    expect((await call(app, 'PUT', '/api/projects/p1/orchestration-settings', {})).status).toBe(400);
    expect((await call(app, 'PUT', '/api/projects/p1/orchestration-settings', { enabled: false })).status).toBe(400);
  });

  it('never shows or changes autonomy for a client', async () => {
    const app = await startApi();
    role = 'client';
    const read = await call(app, 'GET', '/api/projects/p1/orchestration-settings');
    expect(read.body?.autonomy).toBeUndefined();
    expect(read.body?.sensitivePaths).toBeUndefined();
    const write = await call(app, 'PUT', '/api/projects/p1/orchestration-settings', { autonomy: 'off' });
    expect(write.status).toBeGreaterThanOrEqual(403);
    const { sqliteService } = await import('../services/sqliteService.js');
    const { runWithWorkspace } = await import('../services/workspaceContext.js');
    expect(runWithWorkspace('ws-default', () => sqliteService.getProjectOrchestrationSetting('p1').autonomy)).toBe('standard');
  });
});
