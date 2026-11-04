import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The board's private conversations: one per task for builds, one per project
 * for Ask Alpha. They stay private to their owner, stay out of the Chat list,
 * are idempotent, and Ask Alpha never starts a build.
 *
 * A developer, because on main only developers hold chat permissions; board
 * builds keep that rule.
 */
let tmp: string;
let opened: { close(): void }[] = [];

async function startApi(role = 'dev') {
  process.env.ALPHA_HOME = tmp;
  vi.resetModules();

  // The daemon resolves this from `gh`; a test must not depend on a signed-in
  // machine.
  vi.doMock('../services/identityService.js', () => ({
    /**
     * An explicit role, stated rather than inherited.
     *
     * These tests exercise issue, thread and run behaviour, not RBAC. They used
     * to get full access by accident: an identity with no role reached
     * `workspaceRegistry.ensureMember`, whose `?? 'admin'` default made any
     * unknown account an administrator. That default was the most dangerous
     * line in the permission system and has been removed, so the precondition
     * these tests always relied on now has to be written down.
     *
     * Admin because the routes under test span capabilities no single lower
     * role holds. RBAC itself is covered by teamAccess.test.ts.
     */
    currentIdentity: async () => ({
      login: 'octocat',
      source: 'github',
      role,
      access: 'granted',
      github: 'ok',
      teams: []
    }),
    warmIdentity: () => {},
    knownIdentity: () => ({ login: 'octocat', source: 'github' })
  }));

  const sql = await import('../services/sqliteService.js');
  const { chatRouter } = await import('./chatController.js');
  const { orchestrationRouter } = await import('./orchestrationController.js');
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
  app.use('/api', chatRouter);
  app.use('/api', orchestrationRouter);
  return { svc: sql.sqliteService as any, app };
}

async function call(
  app: express.Express,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  body?: unknown
) {
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

/** What the browser sends: its own id, and fields SQLite has no column for. */
const threadPayload = (over: Record<string, unknown> = {}) => ({
  id: `th-${Date.now()}`,
  title: 'New Conversation',
  lastMessageSnippet: 'Ready for instructions...',
  lastMessageAt: new Date().toISOString(),
  agentIds: [],
  ...over
});

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-boardthread-'));
  opened = [];
});

afterEach(() => {
  for (const svc of opened) { try { svc.close(); } catch { /* already closed */ } }
  delete process.env.ALPHA_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.doUnmock('../services/identityService.js');
});


async function seedTask(svc: any) {
  const { workspaceRegistry } = await import('../services/workspaceRegistry.js');
  const project = svc.createProject({ id: 'proj-board', name: 'Board project', key: 'BRD' });
  workspaceRegistry.bind('projects', project.id, 'ws-default');
  await workspaceRegistry.assignProject('ws-default', project.id, 'octocat');
  const issue = svc.createIssue({ id: 'issue-board', title: 'Add an empty state', projectId: project.id, status: 'todo', priority: 'medium' });
  workspaceRegistry.bind('issues', issue.id, 'ws-default');
  return { project, issue };
}

describe('POST /projects/:projectId/board-thread', () => {
  it.each(['pm', 'admin', 'client'])('refuses %s access to developer prompting', async role => {
    const { app, svc } = await startApi(role);
    const { project, issue } = await seedTask(svc);
    expect((await call(app, 'POST', '/api/projects/' + project.id + '/board-thread', {})).status).toBe(403);
    expect((await call(app, 'POST', '/api/projects/' + project.id + '/board-thread', { issueId: issue.id })).status).toBe(403);
    expect((await call(app, 'POST', '/api/projects/' + project.id + '/orchestrations/any/request-changes', { expectedRevision: 1, feedback: 'Fix this.' })).status).toBe(403);
    expect(svc.getChatThreads('octocat')).toHaveLength(0);
  });
  it('returns one private task thread per person and task, and the same one on repeat', async () => {
    const { app } = await startApi();
    const { project, issue } = await seedTask((await import('../services/sqliteService.js')).sqliteService);

    const first = await call(app, 'POST', '/api/projects/' + project.id + '/board-thread', { issueId: issue.id });
    const second = await call(app, 'POST', '/api/projects/' + project.id + '/board-thread', { issueId: issue.id });

    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ projectId: project.id, ownerId: 'octocat' });
    expect(first.body.id).toMatch(/^task-[a-f0-9]{32}$/);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
  });

  it('keeps board threads out of the Chat list while their messages stay readable to the owner', async () => {
    const { app } = await startApi();
    const { project, issue } = await seedTask((await import('../services/sqliteService.js')).sqliteService);
    await call(app, 'POST', '/api/chat/threads', { id: 'th-visible', title: 'Visible chat' });
    const task = await call(app, 'POST', '/api/projects/' + project.id + '/board-thread', { issueId: issue.id });
    const ask = await call(app, 'POST', '/api/projects/' + project.id + '/board-thread', {});

    const list = await call(app, 'GET', '/api/chat/threads');
    expect(list.body.map((thread: any) => thread.id)).toEqual(['th-visible']);
    expect((await call(app, 'GET', '/api/chat/threads/' + task.body.id + '/messages')).status).toBe(200);
    expect(ask.body.id).toMatch(/^task-ask-/);
  });

  it('refuses a task from another project', async () => {
    const { app, svc } = await startApi();
    const { issue } = await seedTask(svc);
    const { workspaceRegistry } = await import('../services/workspaceRegistry.js');
    const other = svc.createProject({ id: 'proj-other', name: 'Other', key: 'OTH' });
    workspaceRegistry.bind('projects', other.id, 'ws-default');
    await workspaceRegistry.assignProject('ws-default', other.id, 'octocat');

    const res = await call(app, 'POST', '/api/projects/' + other.id + '/board-thread', { issueId: issue.id });
    expect(res.status).toBe(404);
  });

  it('never lets Ask Alpha start a build', async () => {
    const { app, svc } = await startApi();
    const { project, issue } = await seedTask(svc);
    const ask = await call(app, 'POST', '/api/projects/' + project.id + '/board-thread', {});

    const forced = await call(app, 'POST', '/api/chat/messages', { threadId: ask.body.id, content: '/build add a page', projectId: project.id });
    const withTask = await call(app, 'POST', '/api/chat/messages', { threadId: ask.body.id, content: 'build it', intent: 'build', issueId: issue.id, projectId: project.id });

    expect(forced.status).toBe(400);
    expect(withTask.status).toBe(400);
    expect(forced.body.error).toMatch(/answers questions only/);
  });
});
