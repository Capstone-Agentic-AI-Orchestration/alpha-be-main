import http from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The hosting routes: who may read or set up hosting, which repositories a
 * route may be pointed at, and how a desktop hands the request to the cloud.
 *
 * The store, the workspace guards, GitHub, the cloud relay and the hosting
 * service are faked; what is under test is the routing and those decisions.
 * `ALPHA_ORG` is the test organisation from vitest.config.ts.
 */

const ORG = 'alpha-test-org';
const project = {
  id: 'p1',
  resources: [
    { type: 'github_repo', pathOrUrl: `https://github.com/${ORG}/shop-be`, stack: 'nodejs' },
    { type: 'github_repo', pathOrUrl: `https://github.com/${ORG}/shop-fe`, stack: 'react' }
  ]
};

/** The deployment capabilities as `workspaceRegistry` grants them. */
const CAN: Record<string, string[]> = {
  'deployment.read': ['dev', 'pm', 'admin'],
  'deployment.manage': ['pm', 'admin']
};

interface Options {
  cloud?: boolean;
  role?: string;
  /** Desktop only: whether an Alpha cloud is configured to forward to. */
  cloudConfigured?: boolean;
  push?: boolean;
}

async function startApi(options: Options = {}) {
  vi.resetModules();
  if (options.cloud) process.env.ALPHA_MODE = 'cloud';
  const calls: Array<{ kind: string; [key: string]: unknown }> = [];

  vi.doMock('../store/stores.js', () => ({
    projectStore: () => ({
      get: async (_ws: string, id: string) => (id === 'p1' ? project : null),
      list: async () => [project]
    })
  }));
  vi.doMock('./workspaceContext.js', () => ({
    requireProjectWorkspace: () => true,
    requireWorkspaceCapability: (req: any, res: any, capability: string) => {
      const allowed = (CAN[capability] ?? []).includes(req.workspace.role);
      if (!allowed) res.status(403).json({ error: `Your workspace role cannot ${capability.replace('.', ' ')}.` });
      return allowed;
    }
  }));
  vi.doMock('../services/githubApi.js', async () => {
    const actual = await vi.importActual<typeof import('../services/githubApi.js')>('../services/githubApi.js');
    return {
      ...actual,
      githubApi: () => ({
        get: async (path: string) => {
          calls.push({ kind: 'github', path });
          return { permissions: { push: options.push ?? true } };
        }
      })
    };
  });
  vi.doMock('../services/cloudWorkspaces.js', () => ({
    usesCloudDirectory: () => !options.cloud && (options.cloudConfigured ?? true),
    cloudRequest: async (path: string, init: any) => {
      calls.push({ kind: 'cloud', path, ...init });
      return { status: 200, body: { relayed: true } };
    }
  }));
  vi.doMock('../services/hosting/hostingService.js', async () => {
    const actual = await vi.importActual<typeof import('../services/hosting/hostingService.js')>(
      '../services/hosting/hostingService.js'
    );
    return {
      ...actual,
      getHostingStatus: async (ctx: any) => {
        calls.push({ kind: 'status', repo: ctx.repo, project: ctx.project?.id ?? null, stackHint: ctx.stackHint });
        return { state: 'ready' };
      },
      setUpHosting: async (ctx: any) => {
        calls.push({ kind: 'setup', repo: ctx.repo, project: ctx.project?.id ?? null });
        return { state: 'ready' };
      }
    };
  });

  const { hostingRouter } = await import('./hostingController.js');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).workspace = { workspaceId: 'ws-1', role: options.role ?? 'pm', userId: 'u1' };
    next();
  });
  app.use('/api', hostingRouter);
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
  delete process.env.ALPHA_MODE;
  for (const mod of ['../store/stores.js', './workspaceContext.js', '../services/githubApi.js', '../services/cloudWorkspaces.js', '../services/hosting/hostingService.js']) {
    vi.doUnmock(mod);
  }
  vi.resetModules();
});

const projectRoute = `/api/projects/p1/repos/${ORG}/shop-fe/hosting`;

describe('in the cloud, from a project page', () => {
  it('lets a developer read hosting, with the project behind it', async () => {
    const { app, calls } = await startApi({ cloud: true, role: 'dev' });

    const res = await call(app, 'GET', projectRoute);

    expect(res.status).toBe(200);
    expect(calls.filter(c => c.kind === 'status')).toEqual([
      { kind: 'status', repo: `${ORG}/shop-fe`, project: 'p1', stackHint: undefined }
    ]);
  });

  it('keeps setting up hosting to a project manager or admin', async () => {
    const { app, calls } = await startApi({ cloud: true, role: 'dev' });

    const res = await call(app, 'POST', projectRoute);

    expect(res.status).toBe(403);
    expect(calls.some(c => c.kind === 'setup')).toBe(false);
  });

  it.each(['pm', 'admin'])('sets up hosting for a %s', async role => {
    const { app, calls } = await startApi({ cloud: true, role });

    expect((await call(app, 'POST', projectRoute)).status).toBe(200);
    expect(calls.filter(c => c.kind === 'setup')).toEqual([{ kind: 'setup', repo: `${ORG}/shop-fe`, project: 'p1' }]);
  });

  it('refuses a client even a read', async () => {
    const { app } = await startApi({ cloud: true, role: 'client' });

    expect((await call(app, 'GET', projectRoute)).status).toBe(403);
  });

  it('refuses a repository that is not the project’s', async () => {
    const { app, calls } = await startApi({ cloud: true });

    const res = await call(app, 'GET', `/api/projects/p1/repos/${ORG}/payroll/hosting`);

    expect(res.status).toBe(404);
    expect(calls).toEqual([]);
  });
});

describe('in the cloud, by repository', () => {
  it('refuses a repository outside the organization, without asking GitHub', async () => {
    const { app, calls } = await startApi({ cloud: true });

    const res = await call(app, 'POST', '/api/hosting/someone-else/shop-fe', { stack: 'react' });

    expect(res.status).toBe(404);
    expect(calls).toEqual([]);
  });

  it('refuses a set-up by someone who cannot push to the repository', async () => {
    const { app, calls } = await startApi({ cloud: true, push: false });

    const res = await call(app, 'POST', `/api/hosting/${ORG}/shop-fe`, { stack: 'react' });

    expect(res.status).toBe(403);
    expect(calls.some(c => c.kind === 'setup')).toBe(false);
  });

  it('uses the workspace’s own project for the repository when there is one', async () => {
    const { app, calls } = await startApi({ cloud: true, role: 'dev' });

    await call(app, 'GET', `/api/hosting/${ORG}/shop-fe?stack=nextjs`);

    expect(calls.filter(c => c.kind === 'status')).toEqual([
      { kind: 'status', repo: `${ORG}/shop-fe`, project: 'p1', stackHint: 'nextjs' }
    ]);
  });
});

describe('on a desktop', () => {
  it('forwards a read to the cloud by repository, with what the project knows', async () => {
    const { app, calls } = await startApi({ role: 'dev' });

    const res = await call(app, 'GET', projectRoute);

    expect(res).toEqual({ status: 200, body: { relayed: true } });
    expect(calls).toEqual([
      expect.objectContaining({
        kind: 'cloud',
        path: `/hosting/${ORG}/shop-fe?stack=react&partner=${encodeURIComponent(`${ORG}/shop-be`)}`,
        method: 'GET',
        workspaceId: 'ws-1'
      })
    ]);
  });

  it('forwards a set-up with the hints in the body and room to finish', async () => {
    const { app, calls } = await startApi({ role: 'pm' });

    await call(app, 'POST', projectRoute);

    expect(calls).toEqual([
      expect.objectContaining({
        kind: 'cloud',
        path: `/hosting/${ORG}/shop-fe`,
        method: 'POST',
        body: { stack: 'react', partner: `${ORG}/shop-be` },
        workspaceId: 'ws-1',
        timeoutMs: 180_000
      })
    ]);
  });

  it('never runs hosting itself', async () => {
    const { app, calls } = await startApi({ role: 'pm' });

    await call(app, 'POST', projectRoute);

    expect(calls.some(c => c.kind === 'setup' || c.kind === 'status' || c.kind === 'github')).toBe(false);
  });

  it('answers unavailable, in the usual shape, when no cloud is configured', async () => {
    const { app, calls } = await startApi({ role: 'dev', cloudConfigured: false });

    const res = await call(app, 'GET', projectRoute);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ state: 'unavailable', role: 'frontend', platform: 'vercel', partner: `${ORG}/shop-be` });
    expect(calls).toEqual([]);
  });
});
