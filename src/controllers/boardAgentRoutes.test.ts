import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The board for agents, over HTTP, on a desktop: the tool server's bridge with
 * a real board pass, and the routes people use to see and decide.
 */
let tmp: string;
let opened: { close(): void }[] = [];
let person: any;

async function start() {
  process.env.ALPHA_HOME = tmp;
  vi.resetModules();
  const sql = await import('../services/sqliteService.js');
  const { workspaceRegistry } = await import('../services/workspaceRegistry.js');
  opened.push(sql.sqliteService as any, workspaceRegistry as any);
  vi.spyOn(workspaceRegistry, 'canAccessProject').mockReturnValue(true);
  vi.spyOn(workspaceRegistry, 'canAccessProjectBuilds').mockReturnValue(true);
  const { boardAgentRouter } = await import('./boardAgentController.js');
  const { jsonErrorHandler } = await import('./errorHandler.js');
  const { runWithWorkspace } = await import('../services/workspaceContext.js');
  runWithWorkspace('ws-default', () => sql.sqliteService.createProject({ id: 'project-1', name: 'Task app', key: 'TASK', resources: [] } as any));
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).workspace = person; runWithWorkspace('ws-default', next); });
  app.use('/api', boardAgentRouter);
  app.use(jsonErrorHandler);
  const grants = await import('../services/boardGrant.js');
  return { app, grants, sqlite: sql.sqliteService };
}

async function call(app: express.Express, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const { createServer } = await import('node:http');
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  try {
    const res = await fetch('http://127.0.0.1:' + port + url, { method, headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

const developer = { userId: 'lloyd', workspaceId: 'ws-default', role: 'dev', access: {} };
const projectManager = { userId: 'maria', workspaceId: 'ws-default', role: 'pm', access: {} };

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-board-agent-routes-'));
  opened = [];
  person = developer;
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  for (const handle of opened) { try { handle.close(); } catch { /* already closed */ } }
  vi.restoreAllMocks();
  delete process.env.ALPHA_HOME;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* windows handle */ }
});

describe('the board bridge and decisions, on a desktop', () => {
  it('refuses a tool call without a board pass', async () => {
    const { app } = await start();
    expect((await call(app, 'POST', '/api/agent-bridge/board/list', {})).status).toBe(401);
  });

  it('creates and lists cards as the developer, records the change, and holds an archive for confirmation', async () => {
    const { app, grants, sqlite } = await start();
    const token = grants.mintBoardGrant({ runId: 'turn-1', agentId: 'agent-manager', agentName: 'Manager Agent', context: developer as any,
      actorLogin: 'lloyd', projectId: 'project-1', access: 'write' });
    const auth = { 'X-Alpha-Run-Token': token };

    const created = await call(app, 'POST', '/api/agent-bridge/board/create', { title: 'Login page', checklist: ['Shows an error for a wrong password.'] }, auth);
    expect(created).toMatchObject({ status: 200, body: { status: 'done' } });
    const listed = await call(app, 'POST', '/api/agent-bridge/board/list', {}, auth);
    const card = listed.body.cards.find((item: any) => item.title === 'Login page');
    expect(card).toMatchObject({ column: 'Todo', checklist: '0/1 done' });

    const archive = await call(app, 'POST', '/api/agent-bridge/board/archive', { card: card.card, expected_updated_at: card.updated_at }, auth);
    expect(archive.body.status).toBe('held');

    const changes = await call(app, 'GET', '/api/board/agent-changes?projectId=project-1');
    expect(changes.body.map((change: any) => [change.action, change.status])).toEqual([['archive', 'held'], ['create', 'applied']]);

    // Another person cannot decide for the developer.
    person = projectManager;
    expect((await call(app, 'POST', '/api/board/agent-changes/' + archive.body.changeId + '/approve')).status).toBe(403);
    person = developer;
    expect((await call(app, 'POST', '/api/board/agent-changes/' + archive.body.changeId + '/approve')).body.status).toBe('applied');
    const { runWithWorkspace } = await import('../services/workspaceContext.js');
    expect(runWithWorkspace('ws-default', () => sqlite.getIssues()).find((issue: any) => issue.title === 'Login page')?.archivedAt).toBeTruthy();
  });

  it('lets a project manager switch the assistant off, which stops the agent at once', async () => {
    const { app, grants } = await start();
    const token = grants.mintBoardGrant({ runId: 'turn-2', agentId: 'agent-manager', agentName: 'Manager Agent', context: developer as any,
      actorLogin: 'lloyd', projectId: 'project-1', access: 'write' });
    expect((await call(app, 'PUT', '/api/board/assistant-settings', { projectId: 'project-1', enabled: false })).status).toBe(403);
    person = projectManager;
    const settings = await call(app, 'GET', '/api/board/assistant-settings?projectId=project-1');
    expect(settings.body).toMatchObject({ enabled: true, canUse: true, canChange: true });
    expect((await call(app, 'PUT', '/api/board/assistant-settings', { projectId: 'project-1', enabled: false })).body).toEqual({ projectId: 'project-1', enabled: false });
    const refused = await call(app, 'POST', '/api/agent-bridge/board/create', { title: 'Too late' }, { 'X-Alpha-Run-Token': token });
    expect(refused).toMatchObject({ status: 403, body: { error: 'The board assistant is turned off for this project.' } });
  });
});

