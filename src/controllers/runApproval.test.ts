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
let opened: { close(): void }[] = [];
let merge: ReturnType<typeof vi.fn>;

async function startApi() {
  process.env.ALPHA_HOME = tmp;
  vi.resetModules();

  merge = vi.fn().mockResolvedValue('Merged pull request #1');
  vi.doMock('../services/githubService.js', () => ({
    githubService: { mergePullRequest: merge }
  }));

  const sql = await import('../services/sqliteService.js');
  const { runRouter } = await import('./runController.js');
  const { workspaceContext } = await import('./workspaceContext.js');
  opened.push(sql.sqliteService);

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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-approve-'));
  opened = [];
});

afterEach(() => {
  for (const svc of opened) { try { svc.close(); } catch { /* already closed */ } }
  delete process.env.ALPHA_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.doUnmock('../services/githubService.js');
});

describe('POST /runs/:id/approve', () => {
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
