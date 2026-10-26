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
const boardChangeCalls: Array<[string, ...unknown[]]> = [];
const boardSyncOrder: string[] = [];

const now = '2026-09-22T10:00:00.000Z';
const REPO = [{ id: 'r1', type: 'github_repo', name: 'repo', pathOrUrl: 'https://github.com/acme/checkout' }];

const teamBoard = {
  projects: async () => {
    boardSyncOrder.push('snapshot');
    return [
      { id: 'gh-repo-100', name: 'checkout', key: 'CHK', description: '', color: '', icon: '', status: 'in_progress',
        priority: 'medium', startDate: now, targetDate: '', leadType: 'agent', leadName: '', resources: REPO,
        githubOrg: 'acme', createdAt: now, envVars: [] }
    ];
  },
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

const teamBoardChangeSource = {
  watermark: async (workspaceId: string) => {
    boardChangeCalls.push(['watermark', workspaceId]);
    boardSyncOrder.push('watermark');
    return '1';
  },
  readAfter: async (workspaceId: string, after: string, limit: number) => {
    boardChangeCalls.push(['readAfter', workspaceId, after, limit]);
    return {
      rows: [{ cursor: '2', table: 'projects', rowKey: { id: 'gh-repo-100' }, operation: 'update', createdAt: now }],
      hasMore: false,
      oldestCursor: '1',
      currentCursor: '2'
    };
  },
  snapshot: async () => ({
    projects: await teamBoard.projects(),
    agents: await teamBoard.agents(),
    issues: await teamBoard.issues()
  }),
  readRows: async (_workspaceId: string, changes: Array<{ table: string; rowKey: Record<string, string> }>) => {
    const projects = await teamBoard.projects();
    return new Map(changes.map(change => [
      `${change.table}:${JSON.stringify(change.rowKey)}`,
      projects.find(row => row.id === change.rowKey.id)
    ]));
  }
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
      boardChangeSource: () => teamBoardChangeSource,
      shareIssue: async (issue: any) => void shared.push(`issue ${issue.id}`),
      unshareIssue: async (id: string) => void shared.push(`delete ${id}`),
      shareProject: async (project: any) => void shared.push(`project ${project.id}`),
      unshareProject: async (id: string) => void shared.push(`delete project ${id}`),
      shareComment: async (comment: any) => void shared.push(`comment ${comment.id}`),
      shareAgent: async (agent: any) => void shared.push(`agent ${agent.id}`),
      unshareAgent: async (id: string) => void shared.push(`delete agent ${id}`),
      shareSquad: async (squad: any, ownerId?: string) => void shared.push(`squad ${squad.id}${ownerId ? ` owned by ${ownerId}` : ''}`),
      unshareSquad: async (id: string) => void shared.push(`delete squad ${id}`),
      shareThread: async (thread: any) => { shared.push(`thread ${thread.id}`); return true; },
      shareMessage: async (message: any) => { shared.push(`message ${message.id}`); return true; },
      unshareThread: async (id: string) => { shared.push(`delete thread ${id}`); return true; },
      unshareMessages: async (id: string) => { shared.push(`clear thread ${id}`); return true; },
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

async function call(app: express.Express, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const { createServer } = await import('node:http');
  const server = createServer(app);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  try {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
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
  boardChangeCalls.length = 0;
  boardSyncOrder.length = 0;
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
  vi.restoreAllMocks();
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
    expect(boardSyncOrder.indexOf('watermark')).toBeLessThan(boardSyncOrder.indexOf('snapshot'));
    const { runWithWorkspace } = await import('../services/workspaceContext.js');
    expect(runWithWorkspace('ws-default', () => svc.getIssues()).map((i: any) => i.id)).toContain('gh-issue-9001');
    expect(svc.getBoardSyncCursor('ws-default')).toBe('1');
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

describe('incremental board reads on a team desktop', () => {
  it('uses the signed-in board source for bootstrap and catch-up pages', async () => {
    const { app, svc } = await startApi();
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    const clientHeaders = { 'X-Alpha-Client-Version': 'desktop-2.0.67' };
    const bootstrap = await call(app, 'GET', '/api/board/bootstrap', undefined, clientHeaders);
    expect(bootstrap.status).toBe(200);
    expect(bootstrap.body).toMatchObject({
      workspaceId: 'ws-default',
      cursor: { workspaceId: 'ws-default', value: '1' },
      projects: [{ id: 'gh-repo-100' }]
    });
    expect(svc.getBoardSyncCursor('ws-default')).toBe('1');
    expect(boardChangeCalls).toContainEqual(['watermark', 'ws-default']);
    expect(JSON.parse(String(info.mock.calls[0][0]))).toEqual({
      event: 'board_sync_metric',
      workspaceId: 'ws-default',
      clientVersion: 'desktop-2.0.67',
      kind: 'snapshot',
      changedRows: 3,
      responseBytes: Buffer.byteLength(JSON.stringify(bootstrap.body), 'utf8')
    });

    const page = await call(app, 'POST', '/api/board/changes', {
      cursor: { workspaceId: 'ws-default', value: '1' },
      limit: 10
    }, clientHeaders);
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({
      workspaceId: 'ws-default',
      nextCursor: { workspaceId: 'ws-default', value: '2' },
      changes: [{ table: 'projects', operation: 'update', row: { id: 'gh-repo-100' } }]
    });
    expect(svc.getBoardSyncCursor('ws-default')).toBe('2');
    expect(boardChangeCalls).toContainEqual(['readAfter', 'ws-default', '1', 10]);
    expect(JSON.parse(String(info.mock.calls[1][0]))).toEqual({
      event: 'board_sync_metric',
      workspaceId: 'ws-default',
      clientVersion: 'desktop-2.0.67',
      kind: 'delta',
      changedRows: 1,
      responseBytes: Buffer.byteLength(JSON.stringify(page.body), 'utf8')
    });
    expect(info.mock.calls.map(([line]) => String(line)).join('\n')).not.toMatch(/gh-repo-100|checkout|Cart loses items/);
  });

  it('uses only the supplied user client and scopes log and row reads to its workspace', async () => {
    const { supabaseBoardChangeSource } = await import('../services/sharedBoard.js');
    const requests: Array<{
      table: string;
      columns: string;
      filters: unknown[][];
    }> = [];
    const client = {
      from(table: string) {
        const request = { table, columns: '', filters: [] as unknown[][] };
        requests.push(request);
        const query: any = {
          select(columns: string) { request.columns = columns; return query; },
          eq(column: string, value: unknown) { request.filters.push(['eq', column, value]); return query; },
          in(column: string, value: unknown[]) { request.filters.push(['in', column, value]); return query; },
          gt(column: string, value: unknown) { request.filters.push(['gt', column, value]); return query; },
          lte(column: string, value: unknown) { request.filters.push(['lte', column, value]); return query; },
          order() { return query; },
          limit() { return query; },
          range() { return query; },
          maybeSingle: async () => ({ data: { last_cursor: '7' }, error: null }),
          then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) {
            let data: unknown[] = [];
            if (table === 'workspace_board_changes' && request.columns === 'cursor') data = [{ cursor: '1' }];
            if (table === 'workspace_board_changes' && request.columns !== 'cursor') data = [{
              cursor: '2', table_name: 'projects', row_key: { id: 'changed-id' },
              operation: 'update', created_at: now
            }];
            if (table === 'projects') data = [{
              id: 'changed-id', name: 'Changed', key: 'CHG', description: '', color: '', icon: '',
              status: 'in_progress', priority: 'medium', start_date: now, target_date: null,
              lead_type: 'agent', lead_name: '', lead_agent_id: null, resources: [], github_org: null,
              created_by: 'PM1', created_at: now
            }];
            return Promise.resolve({ data, error: null }).then(resolve, reject);
          }
        };
        return query;
      }
    };
    const source = supabaseBoardChangeSource(client as any);
    const access = { canReadIssues: true, canReadAgents: true, canReadSquads: true };

    expect(await source.watermark('ws-user')).toBe('7');
    const page = await source.readAfter('ws-user', '0', 25);
    expect(page.rows).toHaveLength(1);
    const rows = await source.readRows('ws-user', page.rows, access);
    expect([...rows.values()][0]).toMatchObject({ id: 'changed-id', name: 'Changed' });

    const logReads = requests.filter(request => request.table === 'workspace_board_changes');
    expect(logReads.length).toBeGreaterThanOrEqual(2);
    expect(logReads.every(request => request.filters.some(filter =>
      filter[0] === 'eq' && filter[1] === 'workspace_id' && filter[2] === 'ws-user'
    ))).toBe(true);
    const projectRead = requests.find(request => request.table === 'projects');
    expect(projectRead?.filters).toContainEqual(['eq', 'workspace_id', 'ws-user']);
    expect(projectRead?.filters).toContainEqual(['in', 'id', ['changed-id']]);
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

    // The machine's seeded roster, not the one it just pulled. Squads are never published.
    expect(shared).toContain('agent agent-architect');
    expect(shared.some(s => s.startsWith('squad '))).toBe(false);
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

  it('refuses to create a squad and shares nothing', async () => {
    role = 'admin';
    const { app } = await startApi();
    shared = [];

    const res = await call(app, 'POST', '/api/squads', { id: 'squad-mine', name: 'Mine', topology: 'Sequential', memberAgentIds: [] });

    expect(res.status).toBe(410);
    expect(shared).toEqual([]);
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
    const { flushChatSyncOutbox } = await import('../services/chatSyncService.js');
    await flushChatSyncOutbox();

    expect(shared).toEqual(['thread thread-1', 'thread thread-1']);
  });

  it('stops being published when it is deleted or emptied', async () => {
    const { app } = await startApi();
    await call(app, 'POST', '/api/chat/threads', { id: 'thread-1', title: 'About the cart' });
    shared = [];

    await call(app, 'DELETE', '/api/chat/threads/thread-1/messages');
    await call(app, 'DELETE', '/api/chat/threads/thread-1');
    const { flushChatSyncOutbox } = await import('../services/chatSyncService.js');
    await flushChatSyncOutbox();

    expect(shared).toEqual(['clear thread thread-1', 'thread thread-1', 'delete thread thread-1']);
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
