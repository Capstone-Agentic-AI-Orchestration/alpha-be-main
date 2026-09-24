import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTestDatabase } from '../store/testDatabase.js';

/**
 * The whole API, as Render runs it, with no SQLite anywhere.
 *
 * In cloud mode the desktop store now refuses to open, so any route that still
 * reached it answers 500 here -- which is the point. Before, such a route read
 * and wrote a file on Render's disk without complaint and lost it all at the
 * next deploy.
 *
 * Every router is mounted as `index.ts` mounts it, the stores are Postgres on
 * PGlite with the real migrations, and GitHub is a stub that records what it
 * was asked.
 */

let db: PGlite;
let tmp: string;
let session = { login: 'Admin1', role: 'admin' };

interface GitHubCall { method: string; path: string; body?: unknown }
let githubCalls: GitHubCall[];

beforeAll(async () => {
  db = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-cloudroutes-'));
  session = { login: 'Admin1', role: 'admin' };
  githubCalls = [];
  await db.exec(
    'truncate project_build_steps, prototype_runs, squad_runs, remote_actions, issues, issue_comments, ' +
      'chat_messages, chat_threads, projects, agents, squads, workspace_members, workspaces cascade'
  );
});

afterEach(() => {
  delete process.env.ALPHA_MODE;
  delete process.env.ALPHA_HOME;
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* windows handle */
  }
  vi.resetModules();
});

async function startCloudApi() {
  process.env.ALPHA_MODE = 'cloud';
  process.env.ALPHA_HOME = tmp;
  vi.resetModules();

  const { workspaceRegistry } = await import('../services/workspaceRegistry.js');
  const { PostgresWorkspaceDirectory } = await import('../store/postgresWorkspaceDirectory.js');
  const { PostgresProjectStore } = await import('../store/postgresProjectStore.js');
  const { PostgresIssueStore } = await import('../store/postgresIssueStore.js');
  const { PostgresAgentStore, PostgresSquadStore } = await import('../store/postgresAgentStore.js');
  const { PostgresRunStore } = await import('../store/postgresRunStore.js');
  const { PostgresChatStore } = await import('../store/postgresChatStore.js');
  const stores = await import('../store/stores.js');
  const { sqlFor } = await import('../store/testDatabase.js');
  const { useGitHubApi } = await import('../services/githubApi.js');

  workspaceRegistry.useDirectory(new PostgresWorkspaceDirectory(sqlFor(db), 'ws-default'));
  stores.useProjectStore(new PostgresProjectStore(sqlFor(db)));
  stores.useIssueStore(new PostgresIssueStore(sqlFor(db)));
  stores.useAgentStores(new PostgresAgentStore(sqlFor(db)), new PostgresSquadStore(sqlFor(db)));
  stores.useRunStore(new PostgresRunStore(sqlFor(db)));
  stores.useChatStore(new PostgresChatStore(sqlFor(db)));

  const record = (method: string) => async (p: string, body?: unknown) => {
    githubCalls.push({ method, path: p, body });
    if (method === 'GET' && /\/pulls\/\d+$/.test(p)) {
      return { head: { ref: 'alpha/fix-cart', repo: { full_name: 'acme/checkout' } }, base: { repo: { full_name: 'acme/checkout' } } };
    }
    if (method === 'PUT') return { merged: true, message: 'Pull Request successfully merged' };
    return method === 'GET' ? [] : {};
  };
  useGitHubApi({
    get: record('GET') as any,
    getAll: record('GET') as any,
    post: record('POST') as any,
    patch: record('PATCH') as any,
    put: record('PUT') as any,
    delete: record('DELETE') as any
  });

  const { workspaceContext } = await import('./workspaceContext.js');
  const { workspaceRouter } = await import('./workspaceController.js');
  const { dataRouter } = await import('./dataController.js');
  const { liveBuildRoomRouter } = await import('./liveBuildRoomController.js');
  const { agentCallRouter } = await import('./agentCallController.js');
  const { runRouter } = await import('./runController.js');
  const { runtimeRouter } = await import('./runtimeController.js');
  const { githubRouter } = await import('./githubController.js');
  const { chatRouter } = await import('./chatController.js');
  const { mcpRouter } = await import('./mcpController.js');
  const { jsonErrorHandler } = await import('./errorHandler.js');

  const app = express();
  app.use(express.json());
  // What `sessionContext` sets in the cloud, without the cookie machinery.
  app.use((req, _res, next) => {
    (req as any).session = {
      login: session.login,
      role: session.role,
      githubToken: 'gho_test',
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    };
    next();
  });
  app.use('/api', workspaceContext);
  for (const router of [
    workspaceRouter, dataRouter, liveBuildRoomRouter, agentCallRouter, runRouter,
    runtimeRouter, githubRouter, chatRouter, mcpRouter
  ]) {
    app.use('/api', router);
  }
  app.use(jsonErrorHandler);
  return app;
}

async function call(
  app: express.Express,
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {}
) {
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

/** What the web app loads at startup, and a few pages after it. */
const STARTUP_READS = [
  '/api/workspaces', '/api/projects', '/api/issues', '/api/agents', '/api/squads', '/api/skills',
  '/api/runtimes', '/api/chat/threads', '/api/runs', '/api/squad-runs', '/api/analytics',
  '/api/live-build-room/projects'
];

/** Every route that needs the machine with the code and the agents on it. */
const DESKTOP_ONLY: Array<[string, string]> = [
  ['POST', '/api/chat/threads'],
  ['PUT', '/api/chat/threads/t1'],
  ['PUT', '/api/chat/threads/t1/target'],
  ['DELETE', '/api/chat/threads/t1'],
  ['DELETE', '/api/chat/threads/t1/messages'],
  ['POST', '/api/chat/messages'],
  ['GET', '/api/projects/p1/chat/available-agents'],
  ['POST', '/api/projects/p1/chat/threads/t1/agent-calls'],
  ['GET', '/api/agent-calls/c1'],
  ['GET', '/api/projects/p1/chat/threads/t1/agent-calls'],
  ['POST', '/api/agent-calls/c1/confirm'],
  ['POST', '/api/agent-calls/c1/apply-patch'],
  ['POST', '/api/agent-calls/c1/cancel'],
  ['POST', '/api/agent-calls/c1/retry'],
  ['POST', '/api/agent-calls/c1/follow-up'],
  ['POST', '/api/runtimes/scan'],
  ['POST', '/api/runtimes/r1/refresh'],
  ['GET', '/api/mcp/servers'],
  ['PUT', '/api/mcp/servers/x'],
  ['DELETE', '/api/mcp/servers/x'],
  ['POST', '/api/runs/start'],
  ['POST', '/api/runs/r1/cancel'],
  ['POST', '/api/runs/r1/retry'],
  ['POST', '/api/squads/s1/run'],
  ['GET', '/api/github/runs'],
  ['POST', '/api/github/dispatch'],
  ['GET', '/api/github/runs/1/logs'],
  ['POST', '/api/github/pr'],
  ['POST', '/api/github/merge'],
  ['POST', '/api/github/repos/clone'],
  ['GET', '/api/github/inspect'],
  ['POST', '/api/projects/check-workspace'],
  ['GET', '/api/agents/a1/persona'],
  ['PUT', '/api/agents/a1/persona'],
  ['POST', '/api/agents/builder/message'],
  ['POST', '/api/skills/scan'],
  ['PUT', '/api/skills/sk-fs']
];

describe('the cloud, without SQLite', () => {
  it('answers everything the web app loads', async () => {
    const app = await startCloudApi();

    for (const url of STARTUP_READS) {
      const res = await call(app, 'GET', url);
      expect({ url, status: res.status }).toEqual({ url, status: 200 });
    }
  });

  /** None, rather than a scan of Render's disk that finds none every time. */
  it('reports no runtimes', async () => {
    const app = await startCloudApi();

    expect((await call(app, 'GET', '/api/runtimes')).body).toEqual([]);
  });

  it('serves Alpha’s own skills', async () => {
    const app = await startCloudApi();

    const skills = (await call(app, 'GET', '/api/skills')).body;
    expect(skills.map((s: any) => s.id)).toEqual(['sk-fs', 'sk-bash', 'sk-git', 'sk-browser', 'sk-code-exec']);
  });

  /**
   * An answer the web app can act on, not a 500 from a CLI Render does not
   * have or a SQLite file nobody will see again.
   */
  it('says which routes need the desktop app', async () => {
    const app = await startCloudApi();

    for (const [method, url] of DESKTOP_ONLY) {
      const res = await call(app, method, url, method === 'GET' ? undefined : {});
      expect({ method, url, status: res.status, code: res.body?.code }).toEqual({
        method,
        url,
        status: 409,
        code: 'desktop_only'
      });
    }
  });

  it('still asks who you are before saying so', async () => {
    session = { login: 'Nobody', role: '' as any };
    const app = await startCloudApi();

    const res = await call(app, 'POST', '/api/chat/messages', {});
    expect(res.status).not.toBe(409);
    expect(res.status).toBeGreaterThanOrEqual(401);
  });
});

describe('a person’s own conversations, on the web', () => {
  /**
   * A conversation is had on the desktop, which publishes it under its
   * owner's login. Reading it back on the web is this person's own history --
   * and nobody else's: there is no project-manager bypass, by design.
   */
  async function seedThreads() {
    await db.exec(`insert into workspaces (id, name, slug) values ('ws-default', 'Alpha', 'alpha')`);
    await db.exec(`insert into chat_threads (id, workspace_id, owner_id, title, last_message_at) values
      ('t-mine', 'ws-default', 'Admin1', 'Mine', now()),
      ('t-theirs', 'ws-default', 'Dev9', 'Theirs', now())`);
    await db.exec(`insert into chat_messages (id, thread_id, sender_type, sender_name, content) values
      ('m-mine', 't-mine', 'user', 'Admin1', 'my prompt'),
      ('m-theirs', 't-theirs', 'user', 'Dev9', 'their prompt')`);
  }

  it('lists the ones this person is having', async () => {
    await seedThreads();
    const app = await startCloudApi();

    const threads = (await call(app, 'GET', '/api/chat/threads')).body;

    expect(threads.map((t: any) => t.id)).toEqual(['t-mine']);
  });

  it('reads back what was said in them', async () => {
    await seedThreads();
    const app = await startCloudApi();

    const messages = (await call(app, 'GET', '/api/chat/threads/t-mine/messages')).body;

    expect(messages.map((m: any) => m.content)).toEqual(['my prompt']);
  });

  /** Thread ids are minted by clients, so knowing one must not be enough. */
  it('will not read a colleague’s, even knowing the id', async () => {
    await seedThreads();
    const app = await startCloudApi();

    const res = await call(app, 'GET', '/api/chat/threads/t-theirs/messages');

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('their prompt');
  });

  it('still answers agents only on the desktop', async () => {
    await seedThreads();
    const app = await startCloudApi();

    expect((await call(app, 'POST', '/api/chat/messages', { threadId: 't-mine', content: 'hi' })).status).toBe(409);
  });
});

describe('a workspace other than the default', () => {
  async function sideWorkspace() {
    await db.exec(`insert into workspaces (id, name, slug) values ('ws-default', 'Alpha', 'alpha'), ('ws-side', 'Side', 'side')`);
    await db.exec(`insert into workspace_members (id, workspace_id, user_id, role, status)
      values ('m-side', 'ws-side', 'PM1', 'pm', 'active'), ('m-default', 'ws-default', 'Admin1', 'admin', 'active')`);
  }
  const SIDE = { 'X-Workspace-Id': 'ws-side' };

  /**
   * The bug this slice exists for. Which workspace a project belonged to was
   * recorded in a SQLite file on Render's disk; a deploy emptied it, and from
   * then on every project outside the default workspace answered 404 to the
   * people who made it.
   */
  it('keeps its projects reachable after a restart', async () => {
    await sideWorkspace();
    session = { login: 'PM1', role: 'pm' };
    const created = await call(await startCloudApi(), 'POST', '/api/projects', { name: 'Side project', key: 'SIDE' }, SIDE);
    expect(created.status).toBe(201);

    // A fresh process: nothing survives but Postgres.
    const restarted = await startCloudApi();
    expect((await call(restarted, 'PUT', `/api/projects/${created.body.id}`, { status: 'completed' }, SIDE)).status).toBe(200);
    expect((await call(restarted, 'GET', `/api/projects/${created.body.id}/build-steps`, undefined, SIDE)).status).toBe(200);
  });

  it('is not reachable from another workspace', async () => {
    await sideWorkspace();
    session = { login: 'PM1', role: 'pm' };
    const created = (await call(await startCloudApi(), 'POST', '/api/projects', { name: 'Side project', key: 'SIDE' }, SIDE)).body;

    session = { login: 'Admin1', role: 'admin' };
    const admin = await startCloudApi();
    expect((await call(admin, 'GET', `/api/projects/${created.id}/build-steps`)).status).toBe(404);
    expect((await call(admin, 'PUT', `/api/projects/${created.id}`, { name: 'Taken' })).status).toBe(404);
  });
});

describe('build steps', () => {
  const steps = (...labels: string[]) => labels.map((label, i) => ({ id: `step-${label}`, label, phase: 'implementation', position: i }));

  /** Projects are started by project managers (fe #32). */
  async function projectAsAdmin() {
    session = { login: 'PM1', role: 'pm' };
    const app = await startCloudApi();
    const project = (await call(app, 'POST', '/api/projects', { name: 'Checkout', key: 'CHK' })).body;
    return { app, project };
  }

  it('are saved in Postgres and read back in order', async () => {
    const { app, project } = await projectAsAdmin();

    const saved = await call(app, 'PUT', `/api/projects/${project.id}/build-steps`, { steps: steps('plan', 'build', 'ship') });
    expect(saved.status).toBe(200);

    const read = await call(app, 'GET', `/api/projects/${project.id}/build-steps`);
    expect(read.body.map((s: any) => [s.label, s.position])).toEqual([['plan', 0], ['build', 1], ['ship', 2]]);
    expect((await db.query('select id from project_build_steps')).rows).toHaveLength(3);
  });

  /** A replace, not an append: what is not sent is gone, and the ids that are sent keep their identity. */
  it('are replaced by the list sent', async () => {
    const { app, project } = await projectAsAdmin();
    await call(app, 'PUT', `/api/projects/${project.id}/build-steps`, { steps: steps('plan', 'build', 'ship') });

    const saved = await call(app, 'PUT', `/api/projects/${project.id}/build-steps`, { steps: steps('ship', 'plan') });

    expect(saved.body.map((s: any) => [s.id, s.position])).toEqual([['step-ship', 0], ['step-plan', 1]]);
    expect((await db.query('select id from project_build_steps')).rows).toHaveLength(2);
  });

  it('refuse a step that names an agent this workspace does not have', async () => {
    const { app, project } = await projectAsAdmin();

    const res = await call(app, 'PUT', `/api/projects/${project.id}/build-steps`, {
      steps: [{ label: 'Build', phase: 'implementation', agentId: 'agent-elsewhere' }]
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Agent not found/);
  });

  /** Ids come from the client, and the key is global. */
  it('refuse an id another project’s step already has', async () => {
    const { app, project } = await projectAsAdmin();
    const other = (await call(app, 'POST', '/api/projects', { name: 'Other', key: 'OTH' })).body;
    await call(app, 'PUT', `/api/projects/${other.id}/build-steps`, { steps: steps('plan') });

    const res = await call(app, 'PUT', `/api/projects/${project.id}/build-steps`, { steps: steps('plan') });

    expect(res.status).toBe(400);
    const { rows } = await db.query<{ project_id: string }>('select project_id from project_build_steps');
    expect(rows).toEqual([{ project_id: other.id }]);
  });

  /**
   * These routes checked nothing at all. Now: developers run a project's
   * pipeline as they run its details (`project.update`), on any project in
   * the catalogue; a client may not touch it.
   */
  it('are written by the team, and not by a client', async () => {
    const { project } = await projectAsAdmin();

    session = { login: 'Dev1', role: 'dev' };
    const dev = await startCloudApi();
    expect((await call(dev, 'PUT', `/api/projects/${project.id}/build-steps`, { steps: steps('plan') })).status).toBe(200);
    expect((await call(dev, 'GET', `/api/projects/${project.id}/build-steps`)).body.map((s: any) => s.label)).toEqual(['plan']);

    session = { login: 'Client1', role: 'client' };
    const client = await startCloudApi();
    expect((await call(client, 'PUT', `/api/projects/${project.id}/build-steps`, { steps: steps('ship') })).status).toBe(403);
  });
});

describe('approving a run on the web', () => {
  /**
   * The project manager's one irreplaceable action. On a desktop it merges
   * with `gh` in the checkout; Render has neither, so it goes to GitHub's API
   * as the person approving.
   */
  it('merges the pull request through GitHub’s API', async () => {
    session = { login: 'PM1', role: 'pm' };
    const app = await startCloudApi();
    const project = (await call(app, 'POST', '/api/projects', { name: 'Checkout', key: 'CHK' })).body;
    const issue = (await call(app, 'POST', '/api/issues', { title: 'Fix cart', projectId: project.id })).body;

    const { PostgresRunStore } = await import('../store/postgresRunStore.js');
    const { sqlFor } = await import('../store/testDatabase.js');
    const now = new Date().toISOString();
    await new PostgresRunStore(sqlFor(db)).save('ws-default', {
      id: 'run-1', issueId: issue.id, projectId: project.id, agentId: 'agent-architect',
      status: 'awaiting_approval', scenario: 'success', plan: [], currentStageIndex: 0, stages: [], activities: [],
      prUrl: 'https://github.com/acme/checkout/pull/12', createdAt: now, updatedAt: now
    } as any, 'Admin1');

    const res = await call(app, 'POST', '/api/runs/run-1/approve', { approved: true });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
    expect(githubCalls.map(c => `${c.method} ${c.path}`)).toEqual([
      'GET /repos/acme/checkout/pulls/12',
      'PUT /repos/acme/checkout/pulls/12/merge',
      'DELETE /repos/acme/checkout/git/refs/heads/alpha%2Ffix-cart'
    ]);
    expect(githubCalls[1].body).toEqual({ merge_method: 'squash' });
  });
});
