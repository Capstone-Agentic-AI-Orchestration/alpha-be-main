import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A desktop on a team's board, through its routes.
 *
 * The uplink to Postgres is a stub that records what it was given, and GitHub
 * is a stub that hands out issue numbers. What is under test is the desktop's
 * side: that a developer can pull the team's board at all, that a card is
 * born under GitHub's id, and that what this machine changes is handed to the
 * team -- the issue before its comments, which the database would refuse
 * otherwise.
 */

let tmp: string;
let opened: { close(): void }[] = [];
let role = 'dev';
let sharing = true;
/** Why a desktop meant to be on the team board is not; null when it is, or never meant to be. */
let connectionProblem: string | null = null;
let shared: string[];
let githubFails = false;

const now = '2026-09-22T10:00:00.000Z';
const REPO = [{ id: 'r1', type: 'github_repo', name: 'repo', pathOrUrl: 'https://github.com/acme/checkout' }];

const teamBoard = {
  projects: async () => [
    { id: 'gh-repo-100', name: 'checkout', key: 'CHK', description: '', color: '', icon: '', status: 'in_progress',
      priority: 'medium', startDate: now, targetDate: '', leadType: 'agent', leadName: '', resources: REPO,
      githubOrg: 'acme', createdAt: now, envVars: [] }
  ],
  issues: async () => [
    { id: 'gh-issue-9001', identifier: 'CHK-7', title: 'Cart loses items', description: '', status: 'todo',
      priority: 'high', projectId: 'gh-repo-100', labels: [], subtasks: [], comments: [],
      githubRepo: 'acme/checkout', githubNumber: 7, createdAt: now, updatedAt: now }
  ],
  comments: async () => [],
  agents: async () => [
    { id: 'agent-teammate', name: 'Reviewer', role: 'Reviewer', avatar: '◆', color: '#6366f1', description: '',
      owner: 'PM1', isMine: false, modelProvider: 'anthropic', modelName: 'claude-sonnet-5', systemPrompt: '',
      autonomyLevel: 'supervised', temperature: 0.7, skills: [], mcpServers: [], customCliArgs: '', envVars: [],
      concurrencyLimit: 2, isArchived: false, allowedUsers: 'team', createdAt: now }
  ],
  squads: async () => [],
  squadOwners: async () => [],
  squadProjects: async () => [],
  projectAssignments: async () => []
};

async function startApi() {
  process.env.ALPHA_HOME = tmp;
  delete process.env.ALPHA_MODE;
  vi.resetModules();

  vi.doMock('../services/identityService.js', () => ({
    currentIdentity: async () => ({ login: 'Dev1', source: 'github', role, access: 'granted', github: 'ok', teams: [] }),
    warmIdentity: () => {},
    knownIdentity: () => ({ login: 'Dev1', source: 'github' })
  }));
  vi.doMock('../services/supabaseService.js', () => ({
    supabaseService: {
      sharesBoard: () => sharing,
      connectionProblem: () => connectionProblem,
      isConfigured: () => sharing,
      boardSource: () => teamBoard,
      shareIssue: async (issue: any) => void shared.push(`issue ${issue.id}`),
      unshareIssue: async (id: string) => void shared.push(`delete ${id}`),
      shareProject: async (project: any) => void shared.push(`project ${project.id}`),
      unshareProject: async (id: string) => void shared.push(`delete project ${id}`),
      shareComment: async (comment: any) => void shared.push(`comment ${comment.id}`),
      shareAgent: async (agent: any) => void shared.push(`agent ${agent.id}`),
      unshareAgent: async (id: string) => void shared.push(`delete agent ${id}`),
      shareSquad: async (squad: any, ownerId?: string) => void shared.push(`squad ${squad.id}${ownerId ? ` owned by ${ownerId}` : ''}`),
      unshareSquad: async (id: string) => void shared.push(`delete squad ${id}`),
      shareThread: async (thread: any) => void shared.push(`thread ${thread.id}`),
      shareMessage: async (message: any) => void shared.push(`message ${message.id}`),
      unshareThread: async (id: string) => void shared.push(`delete thread ${id}`),
      unshareMessages: async (id: string) => void shared.push(`clear thread ${id}`),
      saveRunToCloud: async () => {},
      updateIssueInCloud: async () => {},
      broadcastRunEvent: async () => {}
    }
  }));

  const sql = await import('../services/sqliteService.js');
  opened.push(sql.sqliteService);
  opened.push((await import('../services/workspaceRegistry.js')).workspaceRegistry);
  (await import('../services/githubApi.js')).useGitHubApi({
    get: async () => ({ labels: [] }) as any,
    getAll: async () => [],
    post: async (p: string) => {
      if (!p.endsWith('/issues')) return {} as any;
      if (githubFails) throw new Error('GitHub 403 on POST /repos/acme/checkout/issues: Resource not accessible');
      return { id: 777, number: 42, html_url: 'https://github.com/acme/checkout/issues/42' } as any;
    },
    patch: async () => ({}) as any,
    put: async () => ({}) as any,
    delete: async () => {}
  });

  const { dataRouter } = await import('./dataController.js');
  const { chatRouter } = await import('./chatController.js');
  const { workspaceContext } = await import('./workspaceContext.js');
  const { jsonErrorHandler } = await import('./errorHandler.js');
  const app = express();
  app.use(express.json());
  app.use('/api', workspaceContext);
  app.use('/api', dataRouter);
  app.use('/api', chatRouter);
  app.use(jsonErrorHandler);
  return { svc: sql.sqliteService as any, app };
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

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-teamboard-'));
  opened = [];
  role = 'dev';
  sharing = true;
  shared = [];
  connectionProblem = null;
  githubFails = false;
});

afterEach(async () => {
  for (const handle of opened) {
    try {
      handle.close();
    } catch {
      /* already closed */
    }
  }
  delete process.env.ALPHA_HOME;
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* windows handle */
  }
  vi.doUnmock('../services/identityService.js');
  vi.doUnmock('../services/supabaseService.js');
  vi.resetModules();
});

describe('syncing a desktop on a team', () => {
  /**
   * The app has always shown developers the Sync button, and the route asked
   * for `project.manage`, which no developer has.
   */
  it('lets a developer pull the team’s board', async () => {
    const { svc, app } = await startApi();

    const res = await call(app, 'POST', '/api/board/sync');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ projectsImported: 1, created: 1, errors: [] });
    const { runWithWorkspace } = await import('../services/workspaceContext.js');
    expect(runWithWorkspace('ws-default', () => svc.getIssues()).map((i: any) => i.id)).toContain('gh-issue-9001');
  });

  it('still asks a desktop of its own for the right to read GitHub', async () => {
    sharing = false;
    const { app } = await startApi();

    expect((await call(app, 'POST', '/api/board/sync')).status).toBe(403);
  });

  /**
   * Meant to be on the team board, and its client did not start: every
   * installed desktop up to 2.0.6. It used to answer the 403 above, which
   * told a developer nothing about what was actually wrong.
   */
  it('says why, rather than refusing a developer, when it is meant to be on the team board and is not', async () => {
    sharing = false;
    connectionProblem = 'Node.js detected but native WebSocket not found.';
    const { app } = await startApi();

    const res = await call(app, 'POST', '/api/board/sync');
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not connected to the team board: Node\.js detected/);
  });

  /**
   * v2.0.11 shipped an anon key Supabase refused. Every Sync answered the bare
   * "Invalid API key", and people signed in again, which cannot help.
   */
  it('says the build carries a rejected key when Supabase refuses it', async () => {
    const projects = teamBoard.projects;
    teamBoard.projects = async () => {
      throw new Error('Invalid API key');
    };
    try {
      const { app } = await startApi();

      const res = await call(app, 'POST', '/api/board/sync');
      expect(res.status).toBe(502);
      expect(res.body.error).toMatch(/rejected the API key this desktop build carries/);
    } finally {
      teamBoard.projects = projects;
    }
  });
});

describe('the roster on a team’s desktop', () => {
  /**
   * `0011` makes an issue's assignee a real reference again, so an agent this
   * machine has and the team does not has to reach the cloud before a card
   * assigned to it does.
   */
  it('publishes what the team does not have when it syncs', async () => {
    const { app } = await startApi();

    await call(app, 'POST', '/api/board/sync');

    // The machine's seeded roster and core squad, not the one it just pulled.
    expect(shared).toContain('agent agent-architect');
    expect(shared.some(s => s.startsWith('squad squad-core'))).toBe(true);
    expect(shared).not.toContain('agent agent-teammate');
  });

  /**
   * A project made in the desktop app stayed there: nobody else on the team
   * saw it, and every card filed under it was refused by the cloud.
   */
  it('shares a project it makes, changes and removes', async () => {
    role = 'pm'; // projects are started by a project manager
    const { app } = await startApi();
    shared = [];

    const project = (await call(app, 'POST', '/api/projects', { name: 'Payments', key: 'PAY', leadAgentId: 'agent-research' })).body;
    expect(shared).toEqual([`project ${project.id}`]);

    await call(app, 'PUT', `/api/projects/${project.id}`, { name: 'Payments v2' });
    await call(app, 'DELETE', `/api/projects/${project.id}`);
    // The update's share is not awaited by the route; let it land.
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(shared).toEqual([`project ${project.id}`, `project ${project.id}`, `delete project ${project.id}`]);
  });

  it('shares an agent it makes, changes and removes', async () => {
    role = 'admin';
    const { app } = await startApi();
    const agent = (await call(app, 'POST', '/api/agents', {
      id: 'agent-mine', name: 'Mine', role: 'Developer', modelProvider: 'anthropic', modelName: 'claude-sonnet-5',
      autonomyLevel: 'supervised', avatar: '◆', color: '#6366f1', description: 'Mine'
    })).body;
    shared = [];

    await call(app, 'PUT', `/api/agents/${agent.id}`, { description: 'Changed' });
    await call(app, 'DELETE', `/api/agents/${agent.id}`);

    expect(shared).toEqual(['agent agent-mine', 'delete agent agent-mine']);
  });

  /** An agent belongs to whoever made it, so "private to its owner" means someone. */
  it('records who made an agent', async () => {
    role = 'admin';
    const { app } = await startApi();

    const agent = (await call(app, 'POST', '/api/agents', {
      id: 'agent-mine', name: 'Mine', role: 'Developer', modelProvider: 'anthropic', modelName: 'claude-sonnet-5',
      autonomyLevel: 'supervised', avatar: '◆', color: '#6366f1', description: 'Mine', owner: 'You'
    })).body;

    expect(agent.owner).toBe('Dev1');
  });

  it('shares a squad with its owner', async () => {
    role = 'admin';
    const { app } = await startApi();
    shared = [];

    await call(app, 'POST', '/api/squads', { id: 'squad-mine', name: 'Mine', topology: 'Sequential', memberAgentIds: [] });

    expect(shared).toContain('squad squad-mine owned by Dev1');
  });
});

describe('a conversation on a team’s desktop', () => {
  /**
   * A developer's conversations lived in one file on one machine: reinstall
   * the app and they were gone. They are theirs rather than the team's, so
   * they go up under their own login and nobody else can read them back.
   */
  it('is published, and so is what is said in it', async () => {
    const { app } = await startApi();

    const thread = (await call(app, 'POST', '/api/chat/threads', { id: 'thread-1', title: 'About the cart' })).body;
    await call(app, 'PUT', `/api/chat/threads/${thread.id}/target`, { targetAgentId: 'agent-architect' });

    expect(shared).toEqual(['thread thread-1', 'thread thread-1']);
  });

  it('stops being published when it is deleted or emptied', async () => {
    const { app } = await startApi();
    await call(app, 'POST', '/api/chat/threads', { id: 'thread-1', title: 'About the cart' });
    shared = [];

    await call(app, 'DELETE', '/api/chat/threads/thread-1/messages');
    await call(app, 'DELETE', '/api/chat/threads/thread-1');

    expect(shared).toEqual(['clear thread thread-1', 'delete thread thread-1']);
  });

  /** Reading is this person's own history; answering is still the machine's. */
  it('is listed back from the store, not from the file', async () => {
    const { app } = await startApi();
    await call(app, 'POST', '/api/chat/threads', { id: 'thread-1', title: 'About the cart' });

    const threads = (await call(app, 'GET', '/api/chat/threads')).body;

    expect(threads.map((t: any) => t.id)).toEqual(['thread-1']);
  });
});

describe('a card made on a team’s desktop', () => {
  async function withProject(app: express.Express) {
    role = 'pm'; // projects are started by a project manager
    return (await call(app, 'POST', '/api/projects', { id: 'gh-repo-100', name: 'checkout', key: 'CHK', resources: REPO, leadAgentId: 'agent-research' })).body;
  }

  /** One issue, one id, whichever copy of the board meets it first. */
  it('is born under GitHub’s id', async () => {
    const { app } = await startApi();
    const project = await withProject(app);

    const res = await call(app, 'POST', '/api/issues', { id: 'iss-browser', title: 'Add a thing', projectId: project.id });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 'gh-issue-777', githubNumber: 42, githubRepo: 'acme/checkout' });
  });

  /**
   * The database refuses a comment on an issue it does not have, and an issue
   * in a project it does not have: project, then card, then comment.
   */
  it('is shared before its opening comment, after its project', async () => {
    const { app } = await startApi();
    const project = await withProject(app);

    await call(app, 'POST', '/api/issues', { title: 'Add a thing', projectId: project.id });

    expect(shared).toEqual([`project ${project.id}`, 'issue gh-issue-777', 'comment comm-gh-issue-777-created']);
  });

  it('is still made, and says why, when GitHub refuses it', async () => {
    githubFails = true;
    const { app } = await startApi();
    const project = await withProject(app);

    const res = await call(app, 'POST', '/api/issues', { id: 'iss-browser', title: 'Add a thing', projectId: project.id });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe('iss-browser');
    expect(res.body.syncWarning).toMatch(/403/);
  });

  it('shares its changes, its comments and its removal', async () => {
    const { app } = await startApi();
    const project = await withProject(app);
    const issue = (await call(app, 'POST', '/api/issues', { title: 'Add a thing', projectId: project.id })).body;
    shared = [];

    await call(app, 'PUT', `/api/issues/${issue.id}`, { priority: 'urgent' });
    await call(app, 'POST', `/api/issues/${issue.id}/comments`, {
      id: 'comm-note', authorType: 'user', authorName: 'Dev1', content: 'Looking at it'
    });
    await call(app, 'DELETE', `/api/issues/${issue.id}`);

    expect(shared).toEqual([`issue ${issue.id}`, 'comment comm-note', `delete ${issue.id}`]);
  });
});
