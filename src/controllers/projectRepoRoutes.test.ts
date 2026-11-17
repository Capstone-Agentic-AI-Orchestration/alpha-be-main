import http from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * A project's repository routes: scoped to repositories attached to the
 * project, and promotion kept to those allowed to promote.
 *
 * The store, the workspace guards and GitHub are faked; what is under test is
 * the routing and the scoping decisions.
 */

const project = {
  id: 'p1',
  resources: [
    { type: 'github_repo', pathOrUrl: 'https://github.com/acme/shop-be' },
    { type: 'github_repo', pathOrUrl: 'https://github.com/acme/shop-fe' },
    { type: 'local_folder', pathOrUrl: 'C:/work/shop' }
  ]
};

async function startApi(options: { role?: string; canSeeProject?: boolean; promoteAnswer?: unknown; githubFails?: number; architectureAnswer?: unknown; actionsAnswer?: (path: string) => unknown; readiness?: unknown; memoryAnswer?: unknown[] } = {}) {
  vi.resetModules();
  const calls: string[] = [];
  vi.doMock('../services/repositoryMemory.js', async () => {
    const actual = await vi.importActual<typeof import('../services/repositoryMemory.js')>('../services/repositoryMemory.js');
    return {
      ...actual,
      projectMemory: async (_project: unknown, memoryOptions?: { refresh?: boolean }) => {
        calls.push(`memory ${memoryOptions?.refresh ? 'refresh' : 'cached'}`);
        return options.memoryAnswer ?? [];
      }
    };
  });
  vi.doMock('../services/productionReadiness.js', () => ({
    productionReadiness: async (_ws: string, projectId: string, repo: string) => {
      calls.push(`readiness ${projectId} ${repo}`);
      return options.readiness ?? { state: 'approved', repository: repo, sha: 'a'.repeat(40), round: 1, submittedAt: 't' };
    }
  }));
  vi.doMock('../store/stores.js', () => ({
    projectStore: () => ({ get: async (_ws: string, id: string) => (id === 'p1' ? project : null) })
  }));
  vi.doMock('./workspaceContext.js', () => ({
    requireProjectWorkspace: (_req: any, res: any) => {
      if (options.canSeeProject === false) {
        res.status(404).json({ error: 'Project not found in the active workspace.' });
        return false;
      }
      return true;
    },
    requireWorkspaceCapability: (_req: any, res: any, capability: string) => {
      const managerOnly = ['project.promote', 'project.provision_repository'].includes(capability);
      const allowed = capability === 'project.promote_uat' ? ['dev', 'pm', 'admin'].includes(options.role ?? 'dev') : !managerOnly || ['pm', 'admin'].includes(options.role ?? 'dev');
      if (!allowed) res.status(403).json({ error: `Your workspace role cannot ${capability.replace('.', ' ')}.` });
      return allowed;
    }
  }));
  vi.doMock('../services/githubRepoArchitecture.js', () => ({
    getRepoArchitecture: async (repo: string) => {
      calls.push(`architecture ${repo}`);
      return options.architectureAnswer ?? {
        repository: repo,
        branch: 'main',
        commit: '1234567890abcdef',
        nodes: [{ id: 'api', label: 'API server', kind: 'api' }],
        edges: [],
        truncated: false
      };
    }
  }));
  vi.doMock('../services/githubRepoWorkspace.js', async () => {
    const actual = await vi.importActual<typeof import('../services/githubRepoWorkspace.js')>('../services/githubRepoWorkspace.js');
    return {
      ...actual,
      listBranches: async (repo: string) => {
        calls.push(`branches ${repo}`);
        if (options.githubFails) {
          const { GitHubApiError } = await import('../services/githubApi.js');
          throw new GitHubApiError('GitHub said no', options.githubFails);
        }
        return [{ name: 'dev' }];
      },
      promote: async (repo: string, from: string, to: string) => {
        calls.push(`promote ${repo} ${from}->${to}`);
        return options.promoteAnswer ?? { status: 'opened', url: 'u', number: 1, commits: 1 };
      }
    };
  });

  const { projectRepoRouter } = await import('./projectRepoController.js');
  if (options.actionsAnswer) {
    const { useGitHubApi } = await import('../services/githubApi.js');
    useGitHubApi({ get: async (path: string) => { calls.push(path); return options.actionsAnswer!(path); } } as any);
  }
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).workspace = { workspaceId: 'ws-default', role: options.role ?? 'dev', userId: 'u1' };
    next();
  });
  app.use('/api', projectRepoRouter);
  return { app, calls };
}

async function call(app: express.Express, method: string, url: string, body?: unknown) {
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  try {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: res.status, body: (await res.json()) as any };
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

afterEach(() => {
  vi.doUnmock('../store/stores.js');
  vi.doUnmock('./workspaceContext.js');
  vi.doUnmock('../services/githubRepoWorkspace.js');
  vi.doUnmock('../services/githubRepoArchitecture.js');
  vi.doUnmock('../services/productionReadiness.js');
  vi.doUnmock('../services/repositoryMemory.js');
  vi.resetModules();
});

describe('a project’s repository memory', () => {
  const memory = [
    { repository: 'acme/shop-be', file: 'AGENTS.md', text: 'Login: POST /api/auth/login', origin: 'checkout' },
    { repository: 'acme/shop-fe', file: 'AGENTS.md', text: 'x'.repeat(3_500), origin: 'github', version: 'blob-1', fetchedAt: '2026-11-18T10:00:00.000Z' }
  ];

  it.each(['dev', 'pm'])('shows the %s what every agent is told first, with what is sent after the budget', async role => {
    const { app, calls } = await startApi({ role, memoryAnswer: memory });
    const res = await call(app, 'GET', '/api/projects/p1/memory?refresh=1');
    expect(res.status).toBe(200);
    expect(calls).toContain('memory refresh');
    expect(res.body.limits).toEqual({ PER_REPO: 3000, TOTAL: 6000 });
    expect(res.body.repositories).toEqual([
      expect.objectContaining({ repository: 'acme/shop-be', file: 'AGENTS.md', characters: 27, sentCharacters: 27, shortened: false, origin: 'checkout' }),
      expect.objectContaining({ repository: 'acme/shop-fe', characters: 3500, sentCharacters: 3000, shortened: true, origin: 'github', version: 'blob-1' })
    ]);
    expect(res.body.sentCharacters).toBe(3027);
  });

  it('never shows project memory to a client', async () => {
    const { app, calls } = await startApi({ role: 'client', memoryAnswer: memory });
    const res = await call(app, 'GET', '/api/projects/p1/memory');
    expect(res.status).toBe(403);
    expect(calls).not.toContain('memory cached');
  });
});

describe('a project’s repositories', () => {
  it('reads paginated Actions without requiring a local checkout', async () => {
    const { app, calls } = await startApi({ actionsAnswer: () => ({ total_count: 65, workflow_runs: [] }) });
    const res = await call(app, 'GET', '/api/projects/p1/repos/acme/shop-be/runs?page=2&status=failure');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ page: 2, totalCount: 65, runs: [] });
    expect(calls[0]).toContain('/actions/runs?page=2&per_page=30&status=failure');
  });
  it.each(['runs', 'workflows', 'runs/11', 'runs/11/jobs', 'runs/11/jobs/7/logs', 'runs/11/artifacts', 'runs/11/artifacts/8/download'])(
    'refuses unattached repositories for Actions %s', async route => {
      const { app, calls } = await startApi();
      expect((await call(app, 'GET', `/api/projects/p1/repos/acme/other/${route}`)).status).toBe(404);
      expect(calls).toEqual([]);
    });
  it.each(['runs', 'workflows', 'runs/11', 'runs/11/jobs', 'runs/11/jobs/7/logs', 'runs/11/artifacts', 'runs/11/artifacts/8/download'])(
    'refuses inaccessible projects for Actions %s', async route => {
      const { app, calls } = await startApi({ canSeeProject: false });
      expect((await call(app, 'GET', `/api/projects/p1/repos/acme/shop-be/${route}`)).status).toBe(404);
      expect(calls).toEqual([]);
    });
  it('rejects repeated or object-shaped Actions filters without asking GitHub', async () => {
    const { app, calls } = await startApi({ actionsAnswer: () => ({}) });
    expect((await call(app, 'GET', '/api/projects/p1/repos/acme/shop-be/runs?page[]=1')).status).toBe(400);
    expect(calls).toEqual([]);
  });
  it('lists the GitHub repositories attached to the project', async () => {
    const { app } = await startApi();

    const res = await call(app, 'GET', '/api/projects/p1/repos');

    expect(res).toEqual({ status: 200, body: { repositories: ['acme/shop-be', 'acme/shop-fe'] } });
  });

  it('reads an attached repository', async () => {
    const { app, calls } = await startApi();

    const res = await call(app, 'GET', '/api/projects/p1/repos/acme/shop-be/branches');

    expect(res.status).toBe(200);
    expect(calls).toEqual(['branches acme/shop-be']);
  });

  it('returns a diagram for an attached repository', async () => {
    const architecture = {
      repository: 'acme/shop-be', branch: 'main', commit: '1234567890abcdef',
      nodes: [{ id: 'api', label: 'API server', kind: 'api' }], edges: [], truncated: false
    };
    const { app, calls } = await startApi({ architectureAnswer: architecture });

    const res = await call(app, 'GET', '/api/projects/p1/repos/acme/shop-be/architecture');

    expect(res).toEqual({ status: 200, body: architecture });
    expect(calls).toEqual(['architecture acme/shop-be']);
  });

  it.each(['client', 'pm', 'admin'])('keeps architecture diagrams limited to developers (%s)', async role => {
    const { app, calls } = await startApi({ role });

    const res = await call(app, 'GET', '/api/projects/p1/repos/acme/shop-be/architecture');

    expect(res).toEqual({ status: 403, body: { error: 'Architecture diagrams are available to developers only.' } });
    expect(calls).toEqual([]);
  });

  /** The caller's token could read it; a project page is still not a general GitHub browser. */
  it('refuses a repository that is not the project’s, without asking GitHub', async () => {
    const { app, calls } = await startApi();

    const res = await call(app, 'GET', '/api/projects/p1/repos/acme/payroll/branches');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not a repository of this project/);
    expect(calls).toEqual([]);
  });

  it('refuses to generate a diagram for a repository that is not attached', async () => {
    const { app, calls } = await startApi();

    const res = await call(app, 'GET', '/api/projects/p1/repos/acme/payroll/architecture');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not a repository of this project/);
    expect(calls).toEqual([]);
  });

  it('refuses a project the caller does not work in', async () => {
    const { app, calls } = await startApi({ canSeeProject: false });

    expect((await call(app, 'GET', '/api/projects/p1/repos/acme/shop-be/branches')).status).toBe(404);
    expect(calls).toEqual([]);
  });

  it('passes GitHub’s own refusal through with its status', async () => {
    const { app } = await startApi({ githubFails: 401 });

    const res = await call(app, 'GET', '/api/projects/p1/repos/acme/shop-be/branches');

    expect(res).toEqual({ status: 401, body: { error: 'GitHub said no' } });
  });
});

describe('promotion', () => {
  it('allows a developer to prepare UAT promotion', async () => {
    const { app, calls } = await startApi({ role: 'dev' });

    const res = await call(app, 'POST', '/api/projects/p1/repos/acme/shop-be/promote', { from: 'dev', to: 'uat' });

    expect(res.status).toBe(201);
    expect(calls).toEqual(['promote acme/shop-be dev->uat']);
  });
  it('keeps production promotion restricted for developers', async () => {
    const { app, calls } = await startApi({ role: 'dev' });
    expect((await call(app, 'POST', '/api/projects/p1/repos/acme/shop-be/promote', { from: 'uat', to: 'main' })).status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('opens the promotion for a project manager', async () => {
    const { app, calls } = await startApi({ role: 'pm' });

    const res = await call(app, 'POST', '/api/projects/p1/repos/acme/shop-fe/promote', { from: 'dev', to: 'uat' });

    expect(res.status).toBe(201);
    expect(calls).toEqual(['promote acme/shop-fe dev->uat']);
  });

  it('answers 200 when the promotion is already open', async () => {
    const { app } = await startApi({ role: 'admin', promoteAnswer: { status: 'existing', url: 'u', number: 4 } });

    const res = await call(app, 'POST', '/api/projects/p1/repos/acme/shop-be/promote', { from: 'uat', to: 'main' });

    expect(res).toEqual({ status: 200, body: { status: 'existing', url: 'u', number: 4,
      readiness: { state: 'approved', repository: 'acme/shop-be', sha: 'a'.repeat(40), round: 1, submittedAt: 't' } } });
  });

  it('refuses production until the client passes UAT for the commit on uat, and opens nothing', async () => {
    const readiness = { state: 'not_approved', repository: 'acme/shop-fe', sha: 'a'.repeat(40), reason: 'The client has not passed UAT.' };
    const { app, calls } = await startApi({ role: 'pm', readiness });

    const res = await call(app, 'POST', '/api/projects/p1/repos/acme/shop-fe/promote', { from: 'uat', to: 'main' });

    expect(res).toEqual({ status: 409, body: { error: 'The client has not passed UAT.', readiness } });
    expect(calls).toEqual(['readiness p1 acme/shop-fe']);
  });

  it('opens production for a project manager once the client passed UAT', async () => {
    const { app, calls } = await startApi({ role: 'pm' });

    const res = await call(app, 'POST', '/api/projects/p1/repos/acme/shop-fe/promote', { from: 'uat', to: 'main' });

    expect(res.status).toBe(201);
    expect(calls).toEqual(['readiness p1 acme/shop-fe', 'promote acme/shop-fe uat->main']);
  });

  it('does not check client UAT for a dev -> uat promotion', async () => {
    const { app, calls } = await startApi({ role: 'dev', readiness: { state: 'not_approved', reason: 'x' } });

    expect((await call(app, 'POST', '/api/projects/p1/repos/acme/shop-be/promote', { from: 'dev', to: 'uat' })).status).toBe(201);
    expect(calls).toEqual(['promote acme/shop-be dev->uat']);
  });

  it('shows production readiness to a project manager, not a developer', async () => {
    const dev = await startApi({ role: 'dev' });
    expect((await call(dev.app, 'GET', '/api/projects/p1/repos/acme/shop-fe/production-readiness')).status).toBe(403);

    const pm = await startApi({ role: 'pm' });
    const res = await call(pm.app, 'GET', '/api/projects/p1/repos/acme/shop-fe/production-readiness');
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('approved');
  });
});

describe('deleting a repository', () => {
  it('is a project manager’s to do, not a developer’s', async () => {
    const { app } = await startApi({ role: 'dev' });

    const res = await call(app, 'DELETE', '/api/projects/p1/repos/acme/shop-be?confirm=acme/shop-be');

    expect(res.status).toBe(403);
  });

  it('refuses without the repository typed out to confirm', async () => {
    const { app } = await startApi({ role: 'pm' });

    const missing = await call(app, 'DELETE', '/api/projects/p1/repos/acme/shop-be');
    const wrong = await call(app, 'DELETE', '/api/projects/p1/repos/acme/shop-be?confirm=acme/shop-fe');

    expect(missing.status).toBe(400);
    expect(wrong.status).toBe(400);
    expect(missing.body.error).toBe('Type acme/shop-be to confirm deleting it.');
  });

  it('refuses a repository that is not the project’s', async () => {
    const { app } = await startApi({ role: 'pm' });

    const res = await call(app, 'DELETE', '/api/projects/p1/repos/acme/payroll?confirm=acme/payroll');

    expect(res.status).toBe(404);
  });
});
