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
  'deployment.manage': ['admin'],
  'deployment.env_preview': ['dev', 'admin']
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
      getBuildBranchPreview: async (ctx: any, branch: string) => {
        calls.push({ kind: 'branch_preview', repo: ctx.repo, branch });
        return { repo: ctx.repo, branch, platform: 'vercel', state: 'ready', url: 'https://shop-fe-build.vercel.app', deployStatus: 'READY', ci: { state: 'passed', commitSha: 'sha-build', checksUrl: null, checks: [] } };
      },
      setUpHosting: async (ctx: any) => {
        calls.push({ kind: 'setup', repo: ctx.repo, project: ctx.project?.id ?? null });
        return { state: 'ready' };
      }
    };
  });
  vi.doMock('../services/hosting/healthCheck.js', async () => {
    const actual = await vi.importActual<typeof import('../services/hosting/healthCheck.js')>('../services/hosting/healthCheck.js');
    return {
      ...actual,
      checkHealth: async (url: string, path = '/health') => {
        calls.push({ kind: 'health', url, path });
        return { url: `${url}${path}`, ok: true, status: 200, latencyMs: 17 };
      }
    };
  });
  vi.doMock('../services/hosting/hostingEnv.js', async () => {
    const actual = await vi.importActual<typeof import('../services/hosting/hostingEnv.js')>('../services/hosting/hostingEnv.js');
    return {
      ...actual,
      setHostingEnv: async (ctx: any, request: any, actor: any) => {
        calls.push({ kind: 'env_set', repo: ctx.repo, environment: request.environment, keys: request.vars.map((v: any) => v.key), actor: actor.login });
        return { environment: request.environment, changed: [], failed: [], redeployed: false };
      },
      deleteHostingEnv: async (ctx: any, environment: string, key: string) => {
        calls.push({ kind: 'env_delete', repo: ctx.repo, environment, key });
        return { environment, changed: [key], failed: [], redeployed: false };
      }
    };
  });

  const { hostingRouter } = await import('./hostingController.js');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).workspace = { workspaceId: 'ws-1', role: options.role ?? 'pm', userId: 'u1' };
    (req as any).session = { login: 'signed-in-person' };
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
  for (const mod of ['../store/stores.js', './workspaceContext.js', '../services/githubApi.js', '../services/cloudWorkspaces.js', '../services/hosting/hostingService.js', '../services/hosting/hostingEnv.js', '../services/hosting/healthCheck.js']) {
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

  it('keeps setting up hosting out of a developer role', async () => {
    const { app, calls } = await startApi({ cloud: true, role: 'dev' });

    const res = await call(app, 'POST', projectRoute);

    expect(res.status).toBe(403);
    expect(calls.some(c => c.kind === 'setup')).toBe(false);
  });

  it.each(['admin'])('sets up hosting for a %s', async role => {
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
    const { app, calls } = await startApi({ cloud: true, role: 'admin' });

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

  it('forwards an admin set-up with the hints in the body and room to finish', async () => {
    const { app, calls } = await startApi({ role: 'admin' });

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
    const { app, calls } = await startApi({ role: 'admin' });

    await call(app, 'POST', projectRoute);

    expect(calls.some(c => c.kind === 'setup' || c.kind === 'status' || c.kind === 'github')).toBe(false);
  });

  it('forwards previews and a health check to the same operation in the cloud, with the branch', async () => {
    const { app, calls } = await startApi({ role: 'dev' });

    await call(app, 'GET', `${projectRoute}/previews`);
    await call(app, 'GET', `${projectRoute}/health?branch=uat`);

    expect(calls.map(c => [c.path, c.timeoutMs])).toEqual([
      [`/hosting/${ORG}/shop-fe/previews?stack=react&partner=${encodeURIComponent(`${ORG}/shop-be`)}`, undefined],
      // A health check may be waking a sleeping service.
      [`/hosting/${ORG}/shop-fe/health?stack=react&partner=${encodeURIComponent(`${ORG}/shop-be`)}&branch=uat`, 180_000]
    ]);
  });

  it('forwards the exact build branch to the hosting provider preview lookup', async () => {
    const { app, calls } = await startApi({ role: 'dev' });

    await call(app, 'GET', `${projectRoute}/branch-preview?branch=build%2Fcalculator-1`);

    expect(calls.map(c => c.path)).toEqual([
      `/hosting/${ORG}/shop-fe/branch-preview?stack=react&partner=${encodeURIComponent(`${ORG}/shop-be`)}&branch=build%2Fcalculator-1`
    ]);
  });

  it('checks the served page of a ready Vercel build preview on request', async () => {
    const { app, calls } = await startApi({ cloud: true, role: 'dev' });

    const res = await call(app, 'GET', `${projectRoute}/health?branch=build%2Fcalculator-1`);

    expect(res.body).toMatchObject({ ok: true, status: 200, latencyMs: 17 });
    expect(calls.filter(c => c.kind === 'branch_preview')).toEqual([
      { kind: 'branch_preview', repo: `${ORG}/shop-fe`, branch: 'build/calculator-1' }
    ]);
    expect(calls.filter(c => c.kind === 'health')).toEqual([
      { kind: 'health', url: 'https://shop-fe-build.vercel.app', path: '/' }
    ]);
  });

  it('forwards a log query with its window and filters, and nothing it does not know', async () => {
    const { app, calls } = await startApi({ role: 'dev' });

    await call(app, 'GET', `${projectRoute}/logs?branch=main&direction=forward&startTime=2026-01-01T00%3A00%3A00Z&level=error&junk=1`);

    const url = new URL(`http://x${calls[0].path as string}`);
    expect(url.pathname).toBe(`/hosting/${ORG}/shop-fe/logs`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      stack: 'react',
      partner: `${ORG}/shop-be`,
      branch: 'main',
      direction: 'forward',
      startTime: '2026-01-01T00:00:00Z',
      level: 'error'
    });
  });

  it('answers unavailable, in the usual shape, when no cloud is configured', async () => {
    const { app, calls } = await startApi({ role: 'dev', cloudConfigured: false });

    const res = await call(app, 'GET', projectRoute);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ state: 'unavailable', role: 'frontend', platform: 'vercel', partner: `${ORG}/shop-be` });
    expect(calls).toEqual([]);
  });
});

describe('hosting variables', () => {
  const vars = [{ key: 'STRIPE_KEY', value: 'sk_test_1' }];

  it('lets a developer change uat, recorded as them', async () => {
    const { app, calls } = await startApi({ cloud: true, role: 'dev' });

    const res = await call(app, 'PUT', `${projectRoute}/env`, { environment: 'uat', vars });

    expect(res.status).toBe(200);
    expect(calls.filter(c => c.kind === 'env_set')).toEqual([
      { kind: 'env_set', repo: `${ORG}/shop-fe`, environment: 'uat', keys: ['STRIPE_KEY'], actor: 'signed-in-person' }
    ]);
  });

  /** Production is a release decision. */
  it('keeps production changes to an admin', async () => {
    const { app, calls } = await startApi({ cloud: true, role: 'dev' });

    expect((await call(app, 'PUT', `${projectRoute}/env`, { environment: 'main', vars })).status).toBe(403);
    expect((await call(app, 'DELETE', `${projectRoute}/env?environment=main&key=STRIPE_KEY`)).status).toBe(403);
    expect(calls.some(c => c.kind === 'env_set' || c.kind === 'env_delete')).toBe(false);
  });

  it('keeps a project manager from changing production', async () => {
    const { app, calls } = await startApi({ cloud: true, role: 'pm' });

    const res = await call(app, 'DELETE', `${projectRoute}/env?environment=main&key=STRIPE_KEY`);

    expect(res.status).toBe(403);
    expect(calls.filter(c => c.kind === 'env_delete')).toEqual([]);
  });

  it('keeps a client out entirely', async () => {
    const { app } = await startApi({ cloud: true, role: 'client' });

    expect((await call(app, 'PUT', `${projectRoute}/env`, { environment: 'uat', vars })).status).toBe(403);
  });

  it('on a desktop, forwards a change with the values in the body only', async () => {
    const { app, calls } = await startApi({ role: 'dev' });

    await call(app, 'PUT', `${projectRoute}/env`, { environment: 'uat', vars });
    await call(app, 'DELETE', `${projectRoute}/env?environment=uat&key=STRIPE_KEY&redeploy=false`);

    expect(calls[0]).toMatchObject({
      kind: 'cloud',
      path: `/hosting/${ORG}/shop-fe/env`,
      method: 'PUT',
      body: { environment: 'uat', vars, stack: 'react', partner: `${ORG}/shop-be` },
      timeoutMs: 180_000
    });
    expect(calls[0].path).not.toContain('sk_test_1');
    expect(calls[1]).toMatchObject({ method: 'DELETE', body: undefined });
    expect(Object.fromEntries(new URL(`http://x${calls[1].path as string}`).searchParams)).toMatchObject({
      environment: 'uat',
      key: 'STRIPE_KEY',
      redeploy: 'false'
    });
  });
});
