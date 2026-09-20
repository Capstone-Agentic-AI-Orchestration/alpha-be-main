import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Creating an issue, which was wrong in four ways at once.
 *
 * The browser sent an identifier built from `issues.length + 101` — a count of
 * every issue in every project — and the daemon honoured it, so
 * `nextIssueIdentifier` never ran for anything made in the UI. The first issue
 * of a brand-new project came out numbered 107 because six issues happened to
 * exist elsewhere, and `identifier` is UNIQUE, so two creates at the same count
 * would collide outright.
 *
 * The browser also sent an opening comment with no `issueId`. `addIssueComment`
 * binds that column, so the insert threw — after the issue row was written. The
 * request answered 500 about an issue that had been saved, and the reconcile
 * that would have corrected the identifier never ran.
 *
 * And nothing recorded who created anything, which is why "My Issues" had to
 * filter on "has any assignee" instead.
 */
let tmp: string;
let opened: { close(): void }[] = [];

async function startApi() {
  process.env.ALPHA_HOME = tmp;
  vi.resetModules();

  // The daemon resolves this from `gh`; a test must not depend on a signed-in
  // machine, and the login is what the assertions are about.
  vi.doMock('../services/identityService.js', () => ({
    currentIdentity: async () => ({ login: 'octocat', source: 'github' }),
    warmIdentity: () => {},
    knownIdentity: () => ({ login: 'octocat', source: 'github' })
  }));

  const sql = await import('../services/sqliteService.js');
  const { dataRouter } = await import('./dataController.js');
  const { workspaceContext } = await import('./workspaceContext.js');
  opened.push(sql.sqliteService);

  const app = express();
  app.use(express.json());
  app.use('/api', workspaceContext);
  app.use('/api', dataRouter);
  return { svc: sql.sqliteService as any, app };
}

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
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  } finally {
    await new Promise<void>(r => server.close(() => r()));
  }
}

/** What the browser actually sends, invented identifier and comment included. */
const browserPayload = (projectId: string, over: Record<string, unknown> = {}) => ({
  id: `iss-${Date.now()}`,
  identifier: 'WRONG-999',
  title: 'Add a thing',
  status: 'todo',
  priority: 'medium',
  projectId,
  comments: [
    { id: 'comm-client', authorType: 'system', authorName: 'System', content: 'client-invented' }
  ],
  ...over
});

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-issuecreate-'));
  opened = [];
});

afterEach(() => {
  for (const svc of opened) { try { svc.close(); } catch { /* already closed */ } }
  delete process.env.ALPHA_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.doUnmock('../services/identityService.js');
});

describe('POST /issues', () => {
  it('answers 201, where it used to answer 500 having saved the issue anyway', async () => {
    const { svc, app } = await startApi();
    svc.createProject({ id: 'p1', name: 'Repo', key: 'ALF' });

    const res = await post(app, '/api/issues', browserPayload('p1'));

    expect(res.status).toBe(201);
    expect(svc.getIssues()).toHaveLength(1);
  });

  it('numbers from the project, not from a global count', async () => {
    const { svc, app } = await startApi();
    svc.createProject({ id: 'p1', name: 'Backend', key: 'ALF' });
    svc.createProject({ id: 'p2', name: 'Frontend', key: 'AFE' });

    // Four issues elsewhere, which is exactly what used to poison the number.
    for (let i = 0; i < 4; i++) {
      await post(app, '/api/issues', browserPayload('p1', { id: `iss-a${i}` }));
    }
    const first = await post(app, '/api/issues', browserPayload('p2', { id: 'iss-b' }));

    expect(first.body.identifier).toBe('AFE-101');
  });

  it('continues a project that already has issues', async () => {
    const { svc, app } = await startApi();
    svc.createProject({ id: 'p1', name: 'Backend', key: 'ALF' });
    svc.createIssue({ id: 'old', projectId: 'p1', identifier: 'ALF-104', title: 'Existing' });

    const res = await post(app, '/api/issues', browserPayload('p1'));
    expect(res.body.identifier).toBe('ALF-105');
  });

  it('ignores an identifier the client made up', async () => {
    const { svc, app } = await startApi();
    svc.createProject({ id: 'p1', name: 'Repo', key: 'ALF' });

    const res = await post(app, '/api/issues', browserPayload('p1'));
    expect(res.body.identifier).not.toBe('WRONG-999');
    expect(res.body.identifier).toBe('ALF-101');
  });

  it('records who created it', async () => {
    const { svc, app } = await startApi();
    svc.createProject({ id: 'p1', name: 'Repo', key: 'ALF' });

    const res = await post(app, '/api/issues', browserPayload('p1'));
    expect(res.body.createdBy).toBe('octocat');
    expect(svc.getIssues()[0].createdBy).toBe('octocat');
  });

  /**
   * The comment names the identifier the issue actually got.
   *
   * The client composed this against its guess, so the permanent record on the
   * issue referred to a name that never existed.
   */
  it('writes an opening comment quoting the real identifier and author', async () => {
    const { svc, app } = await startApi();
    svc.createProject({ id: 'p1', name: 'Repo', key: 'ALF' });

    const res = await post(app, '/api/issues', browserPayload('p1'));
    const comments = res.body.comments ?? [];

    expect(comments).toHaveLength(1);
    expect(comments[0].content).toBe('ALF-101 created by octocat.');
    expect(comments[0].content).not.toContain('WRONG-999');
  });

  it('drops a comment the client invented', async () => {
    const { app } = await startApi();
    const svc = (await import('../services/sqliteService.js')).sqliteService as any;
    svc.createProject({ id: 'p1', name: 'Repo', key: 'ALF' });

    const res = await post(app, '/api/issues', browserPayload('p1'));
    expect((res.body.comments ?? []).map((c: any) => c.content)).not.toContain('client-invented');
  });

  it('returns the comment in the create response', async () => {
    // The client clears its own optimistic comments, so a response without them
    // would leave a new card with no history until the next reload.
    const { svc, app } = await startApi();
    svc.createProject({ id: 'p1', name: 'Repo', key: 'ALF' });

    const res = await post(app, '/api/issues', browserPayload('p1'));
    expect(res.body.comments?.length).toBeGreaterThan(0);
  });

  it('survives a payload carrying no comments at all', async () => {
    const { svc, app } = await startApi();
    svc.createProject({ id: 'p1', name: 'Repo', key: 'ALF' });

    const res = await post(app, '/api/issues', { title: 'Bare', projectId: 'p1' });
    expect(res.status).toBe(201);
    expect(res.body.identifier).toBe('ALF-101');
  });
});
