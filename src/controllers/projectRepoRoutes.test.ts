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

async function startApi(options: { role?: string; canSeeProject?: boolean; promoteAnswer?: unknown; githubFails?: number } = {}) {
  vi.resetModules();
  const calls: string[] = [];
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
      const allowed = capability !== 'project.promote' || ['pm', 'admin'].includes(options.role ?? 'dev');
      if (!allowed) res.status(403).json({ error: `Your workspace role cannot ${capability.replace('.', ' ')}.` });
      return allowed;
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
  vi.resetModules();
});

describe('a project’s repositories', () => {
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

  /** The caller's token could read it; a project page is still not a general GitHub browser. */
  it('refuses a repository that is not the project’s, without asking GitHub', async () => {
    const { app, calls } = await startApi();

    const res = await call(app, 'GET', '/api/projects/p1/repos/acme/payroll/branches');

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
  it('is a project manager’s to make, not a developer’s', async () => {
    const { app, calls } = await startApi({ role: 'dev' });

    const res = await call(app, 'POST', '/api/projects/p1/repos/acme/shop-be/promote', { from: 'dev', to: 'uat' });

    expect(res.status).toBe(403);
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

    expect(res).toEqual({ status: 200, body: { status: 'existing', url: 'u', number: 4 } });
  });
});
