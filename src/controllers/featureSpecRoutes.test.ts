import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Feature specs on task cards: draft with the Manager Agent, edit, approve once
 * open questions are answered, and go stale when the task changes. The model
 * turn is replaced by a fixture; the routes, storage and checklist are real.
 */
const fixtureSpec = {
  schemaVersion: 1,
  epicTitle: 'Empty states',
  summary: 'Developers see what to do next on an empty board.',
  personas: [{ id: 'P1', name: 'Developer', goal: 'Start quickly.' }],
  journeys: [{ id: 'J1', personaId: 'P1', title: 'Open an empty board', steps: ['Open the project', 'Create the first task'] }],
  requirements: [{ id: 'REQ-1', behavior: 'An empty board explains what tasks are.', acceptanceCriteria: ['A heading and one sentence show.'], journeyIds: ['J1'] }],
  exclusions: ['No onboarding tour.'],
  openQuestions: ['Should the empty state link to docs?']
};

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

  vi.doMock('../services/featureSpecService.js', () => ({
    draftFeatureSpec: vi.fn(async (input: { revision?: string }) => ({ ...fixtureSpec, epicTitle: input.revision ? 'Revised: ' + fixtureSpec.epicTitle : fixtureSpec.epicTitle })),
    proposeSystemEpics: vi.fn(async () => ({ schemaVersion: 1, epics: [{ title: 'Accounts', outcome: 'People can sign in.', personas: ['Developer'] }] }))
  }));

  const sql = await import('../services/sqliteService.js');
  const { chatRouter } = await import('./chatController.js');
  const { featureSpecRouter } = await import('./featureSpecController.js');
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
  app.use('/api', featureSpecRouter);
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-featurespec-'));
  opened = [];
});

afterEach(() => {
  for (const svc of opened) { try { svc.close(); } catch { /* already closed */ } }
  delete process.env.ALPHA_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.doUnmock('../services/identityService.js');
  vi.doUnmock('../services/featureSpecService.js');
});



async function seedTask(svc: any) {
  const { workspaceRegistry } = await import('../services/workspaceRegistry.js');
  const project = svc.createProject({ id: 'proj-spec', name: 'Spec project', key: 'SPC' });
  workspaceRegistry.bind('projects', project.id, 'ws-default');
  await workspaceRegistry.assignProject('ws-default', project.id, 'octocat');
  const issue = svc.createIssue({ id: 'issue-spec', title: 'Empty states', description: 'Add them.', projectId: project.id, status: 'todo', priority: 'medium',
    subtasks: [{ id: 'sub-1', title: 'Ask design for copy', completed: false }] });
  workspaceRegistry.bind('issues', issue.id, 'ws-default');
  return { project, issue, base: '/api/projects/' + project.id + '/issues/' + issue.id + '/feature-spec' };
}

describe('feature spec routes', () => {
  it.each(['pm', 'admin', 'client'])('refuses %s AI drafting and suggestions', async role => {
    const { app, svc } = await startApi(role);
    const { project, base } = await seedTask(svc);
    expect((await call(app, 'POST', base + '/draft', { expectedVersion: 0, request: 'Write requirements.' })).status).toBe(403);
    expect((await call(app, 'POST', '/api/projects/' + project.id + '/system-proposal', { description: 'Create tasks.' })).status).toBe(403);
    const manager = await import('../services/featureSpecService.js');
    expect(manager.draftFeatureSpec).not.toHaveBeenCalled();
    expect(manager.proposeSystemEpics).not.toHaveBeenCalled();
  });
  it('drafts, refuses approval while questions are open, saves edits, approves, and writes the checklist', async () => {
    const { app, svc } = await startApi();
    const { issue, base } = await seedTask(svc);

    expect((await call(app, 'GET', base)).body).toEqual({ spec: null });
    const drafted = await call(app, 'POST', base + '/draft', { expectedVersion: 0, request: 'Add empty states.' });
    expect(drafted.status).toBe(200);
    expect(drafted.body.spec).toMatchObject({ version: 1, status: 'draft', stale: false });
    expect(svc.getChatThreads('octocat').some((thread: any) => thread.id.startsWith('task-'))).toBe(true);

    const blocked = await call(app, 'POST', base + '/approve', { expectedVersion: 1 });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatch(/open questions/);

    const edited = await call(app, 'PUT', base, { expectedVersion: 1, spec: { ...fixtureSpec, openQuestions: [] } });
    expect(edited.body.spec).toMatchObject({ version: 2, status: 'draft' });
    expect((await call(app, 'PUT', base, { expectedVersion: 1, spec: fixtureSpec })).status).toBe(409);

    const approved = await call(app, 'POST', base + '/approve', { expectedVersion: 2 });
    expect(approved.status).toBe(200);
    expect(approved.body.spec).toMatchObject({ version: 3, status: 'approved', approvedBy: 'octocat', stale: false });
    expect(svc.getIssues().find((item: any) => item.id === issue.id).subtasks.map((item: any) => item.id)).toEqual(['spec-REQ-1', 'sub-1']);
  });

  it('revises the saved spec and marks an approved spec stale when the task changes', async () => {
    const { app, svc } = await startApi();
    const { issue, base } = await seedTask(svc);
    await call(app, 'POST', base + '/draft', { expectedVersion: 0 });
    const revised = await call(app, 'POST', base + '/draft', { expectedVersion: 1, revision: 'Mention keyboard shortcuts.' });
    expect(revised.body.spec.spec.epicTitle).toBe('Revised: Empty states');
    await call(app, 'PUT', base, { expectedVersion: 2, spec: { ...fixtureSpec, openQuestions: [] } });
    await call(app, 'POST', base + '/approve', { expectedVersion: 3 });

    svc.updateIssue(issue.id, { description: 'Add them, and a tour.' });
    expect((await call(app, 'GET', base)).body.spec).toMatchObject({ status: 'approved', stale: true });
  });

  it('proposes epics for a system through the private Ask Alpha thread', async () => {
    const { app, svc } = await startApi();
    const { project } = await seedTask(svc);
    const res = await call(app, 'POST', '/api/projects/' + project.id + '/system-proposal', { description: 'A task tracker with accounts.' });
    expect(res.status).toBe(200);
    expect(res.body.epics[0].title).toBe('Accounts');
    expect(svc.getChatThreads('octocat').some((thread: any) => thread.id.startsWith('task-ask-'))).toBe(true);
  });
});
