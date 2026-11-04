import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Approving a run must not report work it did not do.
 *
 * The endpoint wrote a comment reading "Merging <url>" and never merged — the
 * card went to Done while the pull request stayed open on GitHub. The frontend
 * separately fired a merge whose failure went to `console.warn`, so a merge
 * blocked by a required check produced a success toast either way.
 *
 * The merge now belongs to this endpoint, and the run only leaves the gate when
 * it actually succeeded.
 */
let tmp: string;
let previousCloudApi: string | undefined;
let opened: { close(): void }[] = [];
let merge: ReturnType<typeof vi.fn>;

async function startApi() {
  process.env.ALPHA_HOME = tmp;
  vi.resetModules();

  merge = vi.fn().mockResolvedValue('Merged pull request #1');
  vi.doMock('../services/githubService.js', () => ({
    githubService: { mergePullRequest: merge }
  }));

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
  const { runRouter } = await import('./runController.js');
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
  app.use('/api', runRouter);
  return { svc: sql.sqliteService as any, app };
}

/** A run parked at the review gate, with a project whose checkout exists. */
function plantAwaitingRun(svc: any, over: Record<string, unknown> = {}) {
  svc.createProject({
    id: 'proj-1',
    name: 'Repo',
    key: 'ALF',
    // resolveProjectWorkspace reads an attached local path.
    resources: [{ id: 'res-1', type: 'local_path', name: 'checkout', pathOrUrl: tmp }]
  });
  svc.createIssue({ id: 'iss-1', projectId: 'proj-1', title: 'Add a thing', status: 'review' });
  svc.savePrototypeRun({
    id: 'run-1',
    issueId: 'iss-1',
    projectId: 'proj-1',
    agentId: 'agent-architect',
    status: 'awaiting_approval',
    plan: [],
    currentStageIndex: 4,
    stages: [],
    branchName: 'feat/alf-101',
    prUrl: 'https://github.com/o/r/pull/1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over
  });
}

/** Minimal request helper, so the suite needs no supertest dependency. */
async function post(app: express.Express, url: string, body: unknown) {
  const { createServer } = await import('node:http');
  const server = createServer(app);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  try {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return { status: res.status, body: await res.json().catch(() => null) as any };
  } finally {
    await new Promise<void>(r => server.close(() => r()));
  }
}

beforeEach(() => {
  previousCloudApi = process.env.ALPHA_CLOUD_API;
  // These are legacy-run integration tests; Phase 7 cloud relaying is covered
  // by ticketExecutionRelay.test.ts and must not depend on a developer's .env.
  process.env.ALPHA_CLOUD_API = '';
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-approve-'));
  opened = [];
});

afterEach(() => {
  for (const svc of opened) { try { svc.close(); } catch { /* already closed */ } }
  delete process.env.ALPHA_HOME;
  if (previousCloudApi === undefined) delete process.env.ALPHA_CLOUD_API;
  else process.env.ALPHA_CLOUD_API = previousCloudApi;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.doUnmock('../services/githubService.js');
});

describe('POST /runs/:id/approve', () => {
  it('rejects legacy review for a managed task instead of merging independently', async () => {
    const { svc, app } = await startApi();
    plantAwaitingRun(svc);
    svc.updateIssue('iss-1', { labels: ['alpha:task-orchestration'] });
    const res = await post(app, '/api/runs/run-1/approve', { approved: true });
    expect(res.status).toBe(409); expect(res.body.error).toContain('Build tab');
    expect(merge).not.toHaveBeenCalled(); expect(svc.getPrototypeRuns()[0].status).toBe('awaiting_approval');
  });
  it('merges the pull request and completes the run', async () => {
    const { svc, app } = await startApi();
    plantAwaitingRun(svc);

    const res = await post(app, '/api/runs/run-1/approve', { approved: true });

    expect(res.status).toBe(200);
    expect(merge).toHaveBeenCalledWith(tmp, 'https://github.com/o/r/pull/1');
    expect(svc.getPrototypeRuns()[0].status).toBe('completed');
    expect(svc.getIssues()[0].status).toBe('done');
  });

  it('records what it merged, not what it intended to', async () => {
    const { svc, app } = await startApi();
    plantAwaitingRun(svc);
    await post(app, '/api/runs/run-1/approve', { approved: true });

    const comments = svc.getIssues()[0].comments ?? [];
    const note = comments[comments.length - 1].content;
    expect(note).toContain('Merged https://github.com/o/r/pull/1');
  });

  /**
   * The case the whole endpoint exists for.
   *
   * Required checks pending, a conflict, a protected branch — the run stays at
   * the gate and the card stays out of Done, because the merge did not happen.
   */
  it('leaves the run at the gate when the merge fails', async () => {
    const { svc, app } = await startApi();
    plantAwaitingRun(svc);
    merge.mockRejectedValueOnce(new Error('Pull request is not mergeable: required checks pending'));

    const res = await post(app, '/api/runs/run-1/approve', { approved: true });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('required checks pending');
    expect(svc.getPrototypeRuns()[0].status).toBe('awaiting_approval');
    expect(svc.getIssues()[0].status).not.toBe('done');
  });

  it('says on the issue why a merge failed', async () => {
    const { svc, app } = await startApi();
    plantAwaitingRun(svc);
    merge.mockRejectedValueOnce(new Error('merge conflict between base and head'));
    await post(app, '/api/runs/run-1/approve', { approved: true });

    const comments = svc.getIssues()[0].comments ?? [];
    expect(comments[comments.length - 1].content).toContain('merge conflict');
  });

  it('approves a run that opened no pull request', async () => {
    // A project with no remote commits locally and never opens one. That work
    // is no less done, so the gate must not require a URL.
    const { svc, app } = await startApi();
    plantAwaitingRun(svc, { prUrl: undefined });

    const res = await post(app, '/api/runs/run-1/approve', { approved: true });

    expect(res.status).toBe(200);
    expect(merge).not.toHaveBeenCalled();
    expect(svc.getPrototypeRuns()[0].status).toBe('completed');
    expect((svc.getIssues()[0].comments ?? []).pop().content).toContain('nothing to merge');
  });

  it('refuses when the project has no working copy to merge from', async () => {
    const { svc, app } = await startApi();
    svc.createProject({ id: 'proj-1', name: 'Repo', key: 'ALF', resources: [] });
    svc.createIssue({ id: 'iss-1', projectId: 'proj-1', title: 'T', status: 'review' });
    svc.savePrototypeRun({
      id: 'run-1', issueId: 'iss-1', projectId: 'proj-1', agentId: 'agent-architect',
      status: 'awaiting_approval', plan: [], currentStageIndex: 4, stages: [],
      prUrl: 'https://github.com/o/r/pull/1',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    });

    const res = await post(app, '/api/runs/run-1/approve', { approved: true });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('no working copy');
    expect(merge).not.toHaveBeenCalled();
    expect(svc.getPrototypeRuns()[0].status).toBe('awaiting_approval');
  });

  it('never merges on a rejection', async () => {
    const { svc, app } = await startApi();
    plantAwaitingRun(svc);

    const res = await post(app, '/api/runs/run-1/approve', { approved: false });

    expect(res.status).toBe(200);
    expect(merge).not.toHaveBeenCalled();
    expect(svc.getPrototypeRuns()[0].status).toBe('changes_requested');
    expect(svc.getIssues()[0].status).toBe('todo');
  });
});
