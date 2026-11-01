import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The generic issue write endpoint must not be able to skip the execution and
 * review gates. Ordinary planning moves remain available there; starting a run
 * and completing reviewed work use explicit commands.
 */
let tmp: string;
let opened: { close(): void }[] = [];

async function startApi() {
  process.env.ALPHA_HOME = tmp;
  vi.resetModules();

  /**
   * Identity is mocked here, where it previously fell through to the real
   * `gh` CLI on whichever machine ran the suite.
   *
   * That made the result depend on who was signed in: on this machine it
   * resolved to a project manager, who cannot run agents, while on a
   * developer's machine it would resolve differently again. And it only ever
   * passed because a fresh test database had no projects, so no workspace
   * org, so the `?? 'admin'` default applied — which has since been removed.
   *
   * Admin because these routes span capabilities no single lower role holds.
   * RBAC itself is covered by teamAccess.test.ts.
   */
  vi.doMock('../services/identityService.js', async () => {
    const actual = await vi.importActual<typeof import('../services/identityService.js')>(
      '../services/identityService.js'
    );
    return {
      ...actual,
      currentIdentity: async () => ({
        login: 'octocat',
        source: 'github',
        role: 'admin',
        access: 'granted',
        github: 'ok',
        teams: []
      }),
      knownIdentity: () => ({
        login: 'octocat',
        source: 'github',
        role: 'admin',
        access: 'granted',
        github: 'ok',
        teams: []
      })
    };
  });
  const sql = await import('../services/sqliteService.js');
  const { dataRouter } = await import('./dataController.js');
  const { workspaceContext } = await import('./workspaceContext.js');
  opened.push(sql.sqliteService);
  /**
   * The registry holds a second handle on the same file.
   *
   * `workspaceRegistry` opens SQLite in a module-level singleton, separately
   * from sqliteService. Closing only one left the other open, and Windows will
   * not unlink a file with an open handle — so every test in this file failed
   * in teardown with EBUSY, after its assertions had already passed. For most
   * of the Phase 0 work those failures were written off as Windows noise.
   */
  opened.push((await import('../services/workspaceRegistry.js')).workspaceRegistry);

  const app = express();
  app.use(express.json());
  app.use('/api', workspaceContext);
  app.use('/api', dataRouter);
  return { svc: sql.sqliteService as any, app };
}

async function request(
  app: express.Express,
  method: 'PUT' | 'POST' | 'DELETE',
  url: string,
  body?: unknown
) {
  const { createServer } = await import('node:http');
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };

  try {
    const init: RequestInit = {
      method,
      headers: { 'Content-Type': 'application/json' }
    };
    if (body !== undefined) init.body = JSON.stringify(body);

    const res = await fetch('http://127.0.0.1:' + port + url, init);
    return {
      status: res.status,
      body: await res.json().catch(() => null) as any
    };
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

function plantIssue(svc: any, over: Record<string, unknown> = {}) {
  svc.createProject({ id: 'p1', name: 'Demo', key: 'DEMO' });
  return svc.createIssue({
    id: 'iss-1',
    projectId: 'p1',
    identifier: 'DEMO-101',
    title: 'Add a contact form',
    status: 'todo',
    priority: 'medium',
    ...over
  });
}

function plantRun(svc: any, status: string) {
  const now = new Date().toISOString();
  svc.savePrototypeRun({
    id: 'run-1',
    issueId: 'iss-1',
    projectId: 'p1',
    agentId: 'agent-architect',
    status,
    scenario: 'success',
    plan: [],
    currentStageIndex: 0,
    stages: [],
    branchName: 'feat/demo-101',
    createdAt: now,
    updatedAt: now
  });
}

describe('POST /issues lifecycle guard', () => {
  it('does not allow a task to be created directly in Building', async () => {
    const { app, svc } = await startApi();
    svc.createProject({ id: 'p1', name: 'Demo', key: 'DEMO' });

    const res = await request(app, 'POST', '/api/issues', {
      projectId: 'p1',
      title: 'Run the build',
      status: 'agent_running'
    });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('developer or admin starts');
    expect(svc.getIssues()).toHaveLength(0);
  });
});

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-lifecycle-'));
  opened = [];
});

afterEach(() => {
  for (const svc of opened) {
    try { svc.close(); } catch { /* already closed */ }
  }
  delete process.env.ALPHA_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('PUT /issues/:id lifecycle guard', () => {
  it('rejects direct Agent Running changes and leaves the issue in Todo', async () => {
    const { svc, app } = await startApi();
    plantIssue(svc);

    const res = await request(app, 'PUT', '/api/issues/iss-1', { status: 'agent_running' });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('/api/runs/start');
    expect(svc.getIssues()[0].status).toBe('todo');
  });

  it('rejects direct Done changes and points callers to the completion command', async () => {
    const { svc, app } = await startApi();
    plantIssue(svc, { status: 'review' });

    const res = await request(app, 'PUT', '/api/issues/iss-1', { status: 'done' });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('after a person has reviewed it');
    expect(svc.getIssues()[0].status).toBe('review');
  });

  it('rejects unknown statuses without changing the issue', async () => {
    const { svc, app } = await startApi();
    plantIssue(svc);

    const res = await request(app, 'PUT', '/api/issues/iss-1', { status: 'blocked' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('status must be one of');
    expect(svc.getIssues()[0].status).toBe('todo');
  });

  it('blocks ordinary moves while an agent run is active', async () => {
    const { svc, app } = await startApi();
    plantIssue(svc, { status: 'agent_running' });
    plantRun(svc, 'running');

    const res = await request(app, 'PUT', '/api/issues/iss-1', { status: 'review' });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('active agent run');
    expect(svc.getIssues()[0].status).toBe('agent_running');
  });

  it('still allows ordinary planning moves', async () => {
    const { svc, app } = await startApi();
    plantIssue(svc);

    const res = await request(app, 'PUT', '/api/issues/iss-1', { status: 'in_progress' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('in_progress');
    expect(svc.getIssues()[0].status).toBe('in_progress');
  });
});

describe('POST /issues/:id/complete', () => {
  it('requires an explicit review confirmation', async () => {
    const { svc, app } = await startApi();
    plantIssue(svc, { status: 'review' });

    const res = await request(app, 'POST', '/api/issues/iss-1/complete', {});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('only be completed after it has been reviewed');
    expect(svc.getIssues()[0].status).toBe('review');
  });

  it('completes a reviewed issue', async () => {
    const { svc, app } = await startApi();
    plantIssue(svc, { status: 'review' });

    const res = await request(app, 'POST', '/api/issues/iss-1/complete', { reviewed: true });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('done');
    expect(svc.getIssues()[0].status).toBe('done');
  });

  it('refuses completion while a run is awaiting approval', async () => {
    const { svc, app } = await startApi();
    plantIssue(svc, { status: 'review' });
    plantRun(svc, 'awaiting_approval');

    const res = await request(app, 'POST', '/api/issues/iss-1/complete', { reviewed: true });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('awaiting approval');
    expect(svc.getIssues()[0].status).toBe('review');
  });

  it('refuses completion for an issue still marked Agent Running', async () => {
    const { svc, app } = await startApi();
    plantIssue(svc, { status: 'agent_running' });

    const res = await request(app, 'POST', '/api/issues/iss-1/complete', { reviewed: true });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('must reach review');
    expect(svc.getIssues()[0].status).toBe('agent_running');
  });
});

describe('DELETE /issues/:id', () => {
  it('does not remove a task while its agent run is active', async () => {
    const { svc, app } = await startApi();
    plantIssue(svc);
    plantRun(svc, 'running');

    const res = await request(app, 'DELETE', '/api/issues/iss-1');

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('active agent run');
    expect(svc.getIssues()[0].id).toBe('iss-1');
  });

  it('removes a task after its run has stopped', async () => {
    const { svc, app } = await startApi();
    plantIssue(svc);
    plantRun(svc, 'completed');

    const res = await request(app, 'DELETE', '/api/issues/iss-1');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(svc.getIssues()).toHaveLength(0);
  });
});
