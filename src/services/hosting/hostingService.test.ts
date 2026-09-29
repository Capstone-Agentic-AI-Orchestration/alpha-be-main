import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../models/index.js';

/**
 * Hosting orchestration: naming, idempotent reuse, pairing, and rollback.
 *
 * Render and Vercel are mocked at the client-factory level (`createRenderClient`
 * / `createVercelClient`), never at the network layer -- those two files have
 * their own unit tests already. GitHub is mocked for the same reason. What is
 * under test here is the sequencing: which platform a stack gets, what a
 * service/project is named, what happens when one already exists, what gets
 * rolled back when a later step fails, and how a paired repo's partner gets
 * updated once it exists.
 */

function fakeRenderClient(overrides: Partial<Record<string, any>> = {}) {
  const services = new Map<string, any>();
  const envVars = new Map<string, Record<string, string>>();
  const deploysTriggered: string[] = [];
  const deleted: string[] = [];
  const updates: Array<{ id: string; patch: any }> = [];
  const projects = new Map<string, { id: string; name: string }>();
  const environments: Array<{ id: string; name: string; projectId: string }> = [];
  const moved: Array<{ environmentId: string; resourceIds: string[] }> = [];
  let nextId = 1;

  const client = {
    listOwners: vi.fn(async () => [{ id: 'own-team', type: 'team' }]),
    findProjectByName: vi.fn(async (_ownerId: string, name: string) => projects.get(name) ?? null),
    createProject: vi.fn(async (_ownerId: string, name: string, envNames: string[]) => {
      const project = { id: `prj-${projects.size + 1}`, name };
      projects.set(name, project);
      for (const env of envNames) environments.push({ id: `evm-${project.id}-${env}`, name: env, projectId: project.id });
      return project;
    }),
    listEnvironments: vi.fn(async (projectId: string) => environments.filter(e => e.projectId === projectId)),
    createEnvironment: vi.fn(async (projectId: string, name: string) => {
      const env = { id: `evm-${projectId}-${name}`, name, projectId };
      environments.push(env);
      return env;
    }),
    addToEnvironment: vi.fn(async (environmentId: string, resourceIds: string[]) => {
      moved.push({ environmentId, resourceIds });
    }),
    deleteProject: vi.fn(async (id: string) => {
      deleted.push(id);
      for (const [name, project] of projects) if (project.id === id) projects.delete(name);
    }),
    findServiceByName: vi.fn(async (name: string) => services.get(name) ?? null),
    getService: vi.fn(async (id: string) => [...services.values()].find(s => s.id === id)),
    createService: vi.fn(async (input: any) => {
      const id = `srv-${nextId++}`;
      const service = {
        id,
        name: input.name,
        serviceDetails: { url: `${input.name}.onrender.com` },
        dashboardUrl: `https://dashboard.render.com/web/${id}`
      };
      services.set(input.name, service);
      return { service, deployId: `dep-${id}` };
    }),
    setEnvVar: vi.fn(async (serviceId: string, key: string, value: string) => {
      const current = envVars.get(serviceId) ?? {};
      current[key] = value;
      envVars.set(serviceId, current);
    }),
    triggerDeploy: vi.fn(async (serviceId: string) => {
      deploysTriggered.push(serviceId);
      return { id: `dep-${serviceId}` };
    }),
    latestDeploy: vi.fn(async () => ({ id: 'dep-1', status: 'live', createdAt: '2026-01-01T00:00:00Z' })),
    listEnvVars: vi.fn(async (serviceId: string) => Object.entries(envVars.get(serviceId) ?? {}).map(([key, value]) => ({ key, value }))),
    deleteService: vi.fn(async (id: string) => {
      deleted.push(id);
      for (const [name, service] of services) if (service.id === id) services.delete(name);
    }),
    updateService: vi.fn(async (id: string, patch: any) => {
      updates.push({ id, patch });
      return [...services.values()].find(s => s.id === id);
    }),
    ...overrides
  };

  return { client, services, envVars, deploysTriggered, deleted, updates, projects, environments, moved };
}

function fakeVercelClient(overrides: Partial<Record<string, any>> = {}) {
  const projects = new Map<string, any>();
  const envVars = new Map<string, any[]>();
  const domains = new Map<string, any[]>();
  const deployments: any[] = [];
  const deleted: string[] = [];
  let nextId = 1;

  const client = {
    findProjectByName: vi.fn(async (name: string) => projects.get(name) ?? null),
    createProject: vi.fn(async (input: any) => {
      const id = `proj-${nextId++}`;
      const project = { id, name: input.name, framework: input.framework, link: { type: 'github', org: input.org, repo: input.repo } };
      projects.set(input.name, project);
      return project;
    }),
    getProject: vi.fn(async (id: string) => [...projects.values()].find(p => p.id === id)),
    disableSsoProtection: vi.fn(async () => {}),
    upsertEnvVars: vi.fn(async (projectId: string, vars: any[]) => {
      envVars.set(projectId, [...(envVars.get(projectId) ?? []), ...vars]);
    }),
    listEnvVars: vi.fn(async (projectId: string) => envVars.get(projectId) ?? []),
    addBranchDomain: vi.fn(async (projectId: string, name: string, gitBranch: string) => {
      domains.set(projectId, [...(domains.get(projectId) ?? []), { name, gitBranch }]);
      return true;
    }),
    listDomains: vi.fn(async (projectId: string) => domains.get(projectId) ?? []),
    productionDomain: vi.fn(async (projectId: string) => {
      const project = [...projects.values()].find(p => p.id === projectId);
      return project ? `${project.name}.vercel.app` : null;
    }),
    deploymentAliases: vi.fn(async () => [] as string[]),
    createDeployment: vi.fn(async (input: any) => {
      const dpl = { id: `dpl-${deployments.length + 1}`, url: `${input.name}-${input.ref}.vercel.app` };
      deployments.push({ ...input, ...dpl });
      return dpl;
    }),
    latestDeployment: vi.fn(async (_projectId: string, _scope: unknown) => null as any),
    deleteProject: vi.fn(async (id: string) => {
      deleted.push(id);
      for (const [name, project] of projects) if (project.id === id) projects.delete(name);
    }),
    ...overrides
  };

  return { client, projects, envVars, domains, deployments, deleted };
}

const HOSTING_KEYS = ['RENDER_API_KEY', 'VERCEL_TOKEN', 'RENDER_OWNER_ID', 'VERCEL_TEAM_ID', 'RENDER_REGION'] as const;

async function load(options: {
  env?: Partial<Record<(typeof HOSTING_KEYS)[number], string>>;
  render?: ReturnType<typeof fakeRenderClient>;
  vercel?: ReturnType<typeof fakeVercelClient>;
  githubRepos?: string[];
} = {}) {
  process.env.ALPHA_MODE = 'cloud';
  // Every hosting setting is given a value -- '' when the test does not name it -- because env.ts
  // loads the developer's own .env, and dotenv fills in a variable that is absent (never one that
  // is set, even to ''). A developer with real tokens locally must not change what a test sees.
  for (const key of HOSTING_KEYS) process.env[key] = options.env?.[key] ?? '';
  vi.resetModules();

  const render = options.render ?? fakeRenderClient();
  const vercel = options.vercel ?? fakeVercelClient();
  const existingRepos = new Set((options.githubRepos ?? []).map(r => r.toLowerCase()));
  const variableWrites: Array<{ method: string; path: string; body: any }> = [];

  vi.doMock('./renderClient.js', async () => {
    const actual = await vi.importActual<typeof import('./renderClient.js')>('./renderClient.js');
    return { ...actual, createRenderClient: () => render.client };
  });
  vi.doMock('./vercelClient.js', async () => {
    const actual = await vi.importActual<typeof import('./vercelClient.js')>('./vercelClient.js');
    return { ...actual, createVercelClient: () => vercel.client };
  });
  vi.doMock('../githubApi.js', async () => {
    const actual = await vi.importActual<typeof import('../githubApi.js')>('../githubApi.js');
    return {
      ...actual,
      githubApi: () => ({
        get: async (path: string) => {
          const match = /^\/repos\/([^/]+\/[^/]+)$/.exec(path);
          if (match) {
            if (existingRepos.has(match[1].toLowerCase())) return { full_name: match[1] };
            throw new actual.GitHubApiError('Not Found', 404);
          }
          if (path.endsWith('/actions/secrets')) return { secrets: [] };
          if (path.endsWith('/actions/variables')) return { variables: [] };
          throw new actual.GitHubApiError('Not Found', 404);
        },
        // No variable exists yet: an update answers 404, so the service creates it.
        patch: async (path: string, body: any) => {
          variableWrites.push({ method: 'PATCH', path, body });
          throw new actual.GitHubApiError('Not Found', 404);
        },
        post: async (path: string, body: any) => {
          variableWrites.push({ method: 'POST', path, body });
          return {};
        }
      })
    };
  });

  const service = await import('./hostingService.js');
  return { service, render, vercel, variableWrites };
}

afterEach(() => {
  delete process.env.ALPHA_MODE;
  delete process.env.RENDER_API_KEY;
  delete process.env.VERCEL_TOKEN;
  delete process.env.RENDER_OWNER_ID;
  vi.doUnmock('./renderClient.js');
  vi.doUnmock('./vercelClient.js');
  vi.doUnmock('../githubApi.js');
  vi.resetModules();
});

const RENDER_ENV = { RENDER_API_KEY: 'rnd_key' };
const VERCEL_ENV = { VERCEL_TOKEN: 'vc_token' };
const BOTH_ENV = { ...RENDER_ENV, ...VERCEL_ENV };

function projectWith(resources: Array<{ repo: string; stack: string }>): Project {
  return {
    id: 'p1',
    name: 'Shop',
    key: 'SHOP',
    description: '',
    color: '',
    icon: '',
    status: 'in_progress',
    priority: 'medium',
    startDate: '',
    leadType: 'agent',
    leadName: '',
    resources: resources.map(r => ({ id: r.repo, type: 'github_repo', name: r.repo, pathOrUrl: `https://github.com/${r.repo}`, stack: r.stack })),
    createdAt: ''
  } as Project;
}

describe('hostingConfigured', () => {
  it('reports each platform independently', async () => {
    const { service } = await load({ env: RENDER_ENV });
    expect(service.hostingConfigured()).toEqual({ render: true, vercel: false });
  });
});

describe('getHostingStatus', () => {
  it('is unavailable when the stack cannot be determined at all', async () => {
    const { service } = await load({ env: BOTH_ENV });

    const status = await service.getHostingStatus({ repo: 'acme/mystery' });

    expect(status).toMatchObject({ role: null, platform: null, state: 'unavailable' });
  });

  it('is unavailable when the platform for a known stack has no credentials', async () => {
    const { service } = await load({ env: {} });

    const status = await service.getHostingStatus({ repo: 'acme/shop-be', stackHint: 'nestjs' });

    expect(status).toMatchObject({ role: 'backend', platform: 'render', configured: false, state: 'unavailable' });
  });

  it('reports not_set_up when nothing exists on the platform yet', async () => {
    const { service } = await load({ env: RENDER_ENV });

    const status = await service.getHostingStatus({ repo: 'acme/shop-be', stackHint: 'nodejs' });

    expect(status).toMatchObject({ state: 'not_set_up', environments: [], envVars: [] });
  });

  it('reports ready with both environments once both Render services exist', async () => {
    const { service, render } = await load({ env: RENDER_ENV });
    render.services.set('shop-be', { id: 'srv-1', name: 'shop-be', serviceDetails: { url: 'shop-be.onrender.com' }, dashboardUrl: 'https://dashboard.render.com/web/srv-1' });
    render.services.set('shop-be-uat', { id: 'srv-2', name: 'shop-be-uat', serviceDetails: { url: 'shop-be-uat.onrender.com' }, dashboardUrl: 'https://dashboard.render.com/web/srv-2' });

    const status = await service.getHostingStatus({ repo: 'acme/shop-be', stackHint: 'nodejs' });

    expect(status.state).toBe('ready');
    expect(status.environments).toEqual([
      { branch: 'main', url: 'https://shop-be.onrender.com', dashboardUrl: 'https://dashboard.render.com/web/srv-1', latestDeploy: { status: 'live', createdAt: '2026-01-01T00:00:00Z', url: 'shop-be.onrender.com' }, waitsForCi: null },
      { branch: 'uat', url: 'https://shop-be-uat.onrender.com', dashboardUrl: 'https://dashboard.render.com/web/srv-2', latestDeploy: { status: 'live', createdAt: '2026-01-01T00:00:00Z', url: 'shop-be-uat.onrender.com' }, waitsForCi: null }
    ]);
  });

  it('derives role and platform from the project’s own resource, not a hint', async () => {
    const { service } = await load({ env: VERCEL_ENV });
    const project = projectWith([{ repo: 'acme/shop-fe', stack: 'nextjs' }]);

    const status = await service.getHostingStatus({ repo: 'acme/shop-fe', project });

    expect(status).toMatchObject({ role: 'frontend', platform: 'vercel' });
  });

  it('finds the partner from the project’s attached resources', async () => {
    const { service } = await load({ env: RENDER_ENV });
    const project = projectWith([
      { repo: 'acme/shop-be', stack: 'nodejs' },
      { repo: 'acme/shop-fe', stack: 'react' }
    ]);

    const status = await service.getHostingStatus({ repo: 'acme/shop-be', project });

    expect(status.partner).toBe('acme/shop-fe');
  });

  it('guesses the partner by the -be/-fe convention, confirmed against GitHub, when there is no project', async () => {
    const { service } = await load({ env: RENDER_ENV, githubRepos: ['acme/shop-fe'] });

    const status = await service.getHostingStatus({ repo: 'acme/shop-be', stackHint: 'nodejs' });

    expect(status.partner).toBe('acme/shop-fe');
  });

  it('reports no partner when the guessed sibling does not exist on GitHub', async () => {
    const { service } = await load({ env: RENDER_ENV, githubRepos: [] });

    const status = await service.getHostingStatus({ repo: 'acme/shop-be', stackHint: 'nodejs' });

    expect(status.partner).toBeNull();
  });
});

describe('setUpHosting — backend', () => {
  it('creates both Render services, named by convention, on the free plan', async () => {
    const { service, render } = await load({ env: RENDER_ENV });

    const status = await service.setUpHosting({ repo: 'acme/shop-be', stackHint: 'nodejs' });

    expect(render.client.createService).toHaveBeenCalledTimes(2);
    expect(render.client.createService.mock.calls.map(c => c[0].name)).toEqual(['shop-be', 'shop-be-uat']);
    expect(render.client.createService.mock.calls.every(c => c[0].ownerId === 'own-team')).toBe(true);
    expect(status.state).toBe('ready');
  });

  it('sets NODE_ENV on both and triggers a deploy on each', async () => {
    const { service, render } = await load({ env: RENDER_ENV });

    await service.setUpHosting({ repo: 'acme/shop-be', stackHint: 'nodejs' });

    for (const id of ['srv-1', 'srv-2']) {
      expect(render.envVars.get(id)).toMatchObject({ NODE_ENV: 'production' });
    }
    expect(render.deploysTriggered.sort()).toEqual(['srv-1', 'srv-2']);
  });

  it('uses RENDER_OWNER_ID directly when set, without listing owners', async () => {
    const { service, render } = await load({ env: { ...RENDER_ENV, RENDER_OWNER_ID: 'own-pinned' } });

    await service.setUpHosting({ repo: 'acme/shop-be', stackHint: 'nodejs' });

    expect(render.client.listOwners).not.toHaveBeenCalled();
    expect(render.client.createService.mock.calls[0][0].ownerId).toBe('own-pinned');
  });

  it('is idempotent: reuses an existing service by name instead of creating it again', async () => {
    const { service, render } = await load({ env: RENDER_ENV });
    render.services.set('shop-be', { id: 'srv-existing', name: 'shop-be', serviceDetails: { url: 'shop-be.onrender.com' }, dashboardUrl: 'd' });

    await service.setUpHosting({ repo: 'acme/shop-be', stackHint: 'nodejs' });

    expect(render.client.createService).toHaveBeenCalledTimes(1);
    expect(render.client.createService.mock.calls[0][0].name).toBe('shop-be-uat');
  });

  it('rolls back a service it created this call when a later step fails, and never touches GitHub', async () => {
    const render = fakeRenderClient();
    let created = 0;
    render.client.createService = vi.fn(async (input: any) => {
      created += 1;
      if (created === 2) throw new Error('Render said no');
      const service = { id: 'srv-1', name: input.name, serviceDetails: { url: `${input.name}.onrender.com` }, dashboardUrl: 'd' };
      render.services.set(input.name, service);
      return { service };
    });
    const { service } = await load({ env: RENDER_ENV, render });

    const status = await service.setUpHosting({ repo: 'acme/shop-be', stackHint: 'nodejs' });

    expect(status.state).toBe('failed');
    expect(status.error).toMatch(/Render said no/);
    expect(render.deleted).toEqual(['srv-1']);
  });

  it('reports the friendly GitHub-App message when Render cannot reach the repository', async () => {
    const render = fakeRenderClient();
    render.client.createService = vi.fn(async () => {
      const { RenderApiError } = await import('./renderClient.js');
      throw new RenderApiError('Render 404: repo not found', 404);
    });
    const { service } = await load({ env: RENDER_ENV, render });

    const status = await service.setUpHosting({ repo: 'acme/shop-be', stackHint: 'nodejs' });

    expect(status.state).toBe('failed');
    expect(status.error).toMatch(/Install the Render GitHub app/);
  });
});

describe('setUpHosting — frontend', () => {
  it('creates one Vercel project named after the repo, with the right framework', async () => {
    const { service, vercel } = await load({ env: VERCEL_ENV });

    await service.setUpHosting({ repo: 'acme/shop-fe', stackHint: 'react' });

    expect(vercel.client.createProject).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'shop-fe', framework: 'vite', org: 'acme', repo: 'shop-fe' })
    );
  });

  it('disables SSO protection and deploys all three branches explicitly', async () => {
    const { service, vercel } = await load({ env: VERCEL_ENV });

    await service.setUpHosting({ repo: 'acme/shop-fe', stackHint: 'nextjs' });

    expect(vercel.client.disableSsoProtection).toHaveBeenCalled();
    expect(vercel.deployments.map(d => d.ref)).toEqual(['main', 'uat', 'dev']);
    expect(vercel.deployments[0].target).toBe('production');
    expect(vercel.deployments[1].target).toBeUndefined();
  });

  it('is idempotent: reuses an existing project of the same name and repo', async () => {
    const { service, vercel } = await load({ env: VERCEL_ENV });
    // Vercel reports a link's owner and name separately.
    vercel.projects.set('shop-fe', { id: 'proj-existing', name: 'shop-fe', link: { org: 'acme', repo: 'shop-fe' } });

    const status = await service.setUpHosting({ repo: 'acme/shop-fe', stackHint: 'react' });

    expect(vercel.client.createProject).not.toHaveBeenCalled();
    expect(status.state).not.toBe('failed');
  });

  it('refuses to reuse a same-named project linked to a different repository', async () => {
    const { service, vercel } = await load({ env: VERCEL_ENV });
    vercel.projects.set('shop-fe', { id: 'proj-existing', name: 'shop-fe', link: { org: 'someone-else', repo: 'unrelated' } });

    const status = await service.setUpHosting({ repo: 'acme/shop-fe', stackHint: 'react' });

    expect(status.state).toBe('failed');
    expect(status.error).toMatch(/already exists/);
  });

  it('leaves the API URL env vars unset when the backend partner does not exist yet', async () => {
    const { service, vercel } = await load({ env: VERCEL_ENV });

    await service.setUpHosting({ repo: 'acme/shop-fe', stackHint: 'react' });

    expect(vercel.client.upsertEnvVars).not.toHaveBeenCalled();
  });

  it('wires VITE_API_URL to the backend partner’s URLs when it already has hosting', async () => {
    const render = fakeRenderClient();
    render.services.set('shop-be', { id: 'srv-1', name: 'shop-be', serviceDetails: { url: 'shop-be.onrender.com' }, dashboardUrl: 'd' });
    render.services.set('shop-be-uat', { id: 'srv-2', name: 'shop-be-uat', serviceDetails: { url: 'shop-be-uat.onrender.com' }, dashboardUrl: 'd' });
    const { service, vercel } = await load({ env: BOTH_ENV, render });

    await service.setUpHosting({ repo: 'acme/shop-fe', stackHint: 'react', partnerHint: 'acme/shop-be' });

    const vars = vercel.envVars.get([...vercel.projects.values()][0].id) ?? [];
    expect(vars).toEqual(
      expect.arrayContaining([
        { key: 'VITE_API_URL', value: 'https://shop-be.onrender.com', target: ['production'] },
        { key: 'VITE_API_URL', value: 'https://shop-be-uat.onrender.com', target: ['preview'] }
      ])
    );
  });
});

describe('pairing: setting up the second side updates the first', () => {
  it('updates the backend’s CORS_ORIGINS and redeploys it once the frontend is set up', async () => {
    const render = fakeRenderClient();
    render.services.set('shop-be', { id: 'srv-1', name: 'shop-be', serviceDetails: { url: 'shop-be.onrender.com' }, dashboardUrl: 'd' });
    render.services.set('shop-be-uat', { id: 'srv-2', name: 'shop-be-uat', serviceDetails: { url: 'shop-be-uat.onrender.com' }, dashboardUrl: 'd' });
    const { service, vercel } = await load({ env: BOTH_ENV, render });

    const status = await service.setUpHosting({ repo: 'acme/shop-fe', stackHint: 'react', partnerHint: 'acme/shop-be' });

    expect(status.partnerWiring).toEqual({ ok: true });
    expect(render.envVars.get('srv-1')).toMatchObject({ CORS_ORIGINS: expect.stringContaining('.vercel.app') });
    expect(render.deploysTriggered).toContain('srv-1');
    expect(vercel.deployments.length).toBeGreaterThan(0);
  });
});

describe('what a status reveals', () => {
  /** Render hands back every value; a status reaches anyone on the project, and agents. */
  it('withholds every value Alpha did not set itself', async () => {
    const render = fakeRenderClient();
    render.services.set('shop-be', { id: 'srv-1', name: 'shop-be', serviceDetails: { url: 'shop-be.onrender.com' }, dashboardUrl: 'd' });
    render.envVars.set('srv-1', { NODE_ENV: 'production', DATABASE_URL: 'postgres://user:secret@db/shop' });
    const { service } = await load({ env: RENDER_ENV, render });

    const status = await service.getHostingStatus({ repo: 'acme/shop-be', stackHint: 'nodejs' });

    expect(status.envVars).toEqual(
      expect.arrayContaining([
        { key: 'NODE_ENV', value: 'production', scope: 'main', managedByAlpha: true },
        { key: 'DATABASE_URL', value: null, scope: 'main', managedByAlpha: false }
      ])
    );
    expect(JSON.stringify(status)).not.toContain('user:secret');
  });
});

describe('frontend addresses', () => {
  it('uses Vercel’s own branch alias when the branch domain could not be claimed, never a single deploy’s URL', async () => {
    const vercel = fakeVercelClient({
      addBranchDomain: vi.fn(async () => false),
      latestDeployment: vi.fn(async (_id: string, scope: any) =>
        'branch' in scope ? { uid: `dpl-${scope.branch}`, url: `shop-fe-abc123-${scope.branch}.vercel.app` } : { uid: 'dpl-prod', url: 'shop-fe-zzz.vercel.app' }
      ),
      deploymentAliases: vi.fn(async (id: string) =>
        id === 'dpl-uat' ? ['shop-fe-abc123-uat.vercel.app', 'shop-fe-git-uat-team.vercel.app'] : []
      )
    });
    const { service } = await load({ env: VERCEL_ENV, vercel });

    const status = await service.setUpHosting({ repo: 'acme/shop-fe', stackHint: 'react' });
    const byBranch = Object.fromEntries(status.environments.map(e => [e.branch, e.url]));

    expect(byBranch).toEqual({
      main: 'https://shop-fe.vercel.app',
      uat: 'https://shop-fe-git-uat-team.vercel.app',
      // No stable address yet: reported as missing, not filled with a URL that changes on the next push.
      dev: null
    });
    expect(status.state).toBe('partial');
  });

  it('reports a partner that could not be wired, instead of hiding it', async () => {
    const render = fakeRenderClient({ findServiceByName: vi.fn(async () => { throw new Error('Render is down'); }) });
    const { service } = await load({ env: BOTH_ENV, render });

    const status = await service.setUpHosting({ repo: 'acme/shop-fe', stackHint: 'react', partnerHint: 'acme/shop-be' });

    expect(status.partnerWiring).toEqual({ ok: false, error: expect.stringContaining('Render is down') });
  });
});
describe('what a set-up leaves on the repository and in the status', () => {
  it('writes each environment’s stable URL as a repository variable', async () => {
    const { service, variableWrites } = await load({ env: RENDER_ENV });

    const status = await service.setUpHosting({ repo: 'acme/shop-be', stackHint: 'nodejs' });

    expect(status.urlVariables).toEqual({ ok: true });
    expect(variableWrites.filter(w => w.method === 'POST').map(w => w.body)).toEqual([
      { name: 'ALPHA_URL_MAIN', value: 'https://shop-be.onrender.com' },
      { name: 'ALPHA_URL_UAT', value: 'https://shop-be-uat.onrender.com' }
    ]);
  });

  /** Render refused "wait for CI" once and fell back to every push -- a person needs to know. */
  it('says whether each backend environment waits for CI', async () => {
    const render = fakeRenderClient();
    render.services.set('shop-be', { id: 'srv-1', name: 'shop-be', serviceDetails: { url: 'shop-be.onrender.com' }, dashboardUrl: 'd', autoDeployTrigger: 'checksPass' });
    render.services.set('shop-be-uat', { id: 'srv-2', name: 'shop-be-uat', serviceDetails: { url: 'shop-be-uat.onrender.com' }, dashboardUrl: 'd', autoDeployTrigger: 'commit' });
    const { service } = await load({ env: RENDER_ENV, render });

    const status = await service.getHostingStatus({ repo: 'acme/shop-be', stackHint: 'nodejs' });

    expect(status.environments.map(e => [e.branch, e.waitsForCi])).toEqual([
      ['main', true],
      ['uat', false]
    ]);
  });
});
describe('how a backend is built on Render', () => {
  /** NODE_ENV=production reaches the build, and npm then skips the devDependencies the build needs. */
  it('installs dev dependencies to build, and asks to deploy only once CI passes', async () => {
    const { service, render } = await load({ env: RENDER_ENV });

    await service.setUpHosting({ repo: 'acme/shop-be', stackHint: 'nodejs' });

    const input = render.client.createService.mock.calls[0][0];
    expect(input).toMatchObject({
      buildCommand: 'npm install --include=dev && npm run build',
      startCommand: 'npm run start',
      autoDeployTrigger: 'checksPass'
    });
  });

  it('repairs an existing service’s build command and trigger on a retry', async () => {
    const render = fakeRenderClient();
    render.services.set('shop-be', {
      id: 'srv-old',
      name: 'shop-be',
      serviceDetails: { url: 'shop-be.onrender.com', envSpecificDetails: { buildCommand: 'npm install && npm run build', startCommand: 'npm run start' } },
      autoDeployTrigger: 'commit',
      dashboardUrl: 'd'
    });
    const { service } = await load({ env: RENDER_ENV, render });

    await service.setUpHosting({ repo: 'acme/shop-be', stackHint: 'nodejs' });

    expect(render.updates.filter(u => u.id === 'srv-old').map(u => u.patch)).toEqual([
      { buildCommand: 'npm install --include=dev && npm run build', startCommand: 'npm run start', autoDeployTrigger: 'checksPass' }
    ]);
  });

  it('leaves a service already set up correctly alone', async () => {
    const render = fakeRenderClient();
    render.services.set('shop-be', {
      id: 'srv-ok',
      name: 'shop-be',
      serviceDetails: { url: 'shop-be.onrender.com', envSpecificDetails: { buildCommand: 'npm install --include=dev && npm run build', startCommand: 'npm run start' } },
      autoDeployTrigger: 'checksPass',
      dashboardUrl: 'd'
    });
    const { service } = await load({ env: RENDER_ENV, render });

    await service.setUpHosting({ repo: 'acme/shop-be', stackHint: 'nodejs' });

    expect(render.updates.filter(u => u.id === 'srv-ok')).toEqual([]);
  });
});
describe('grouping a backend into a Render project', () => {
  it('creates a project named after the repo, with production and uat, and creates each service in its environment', async () => {
    const { service, render } = await load({ env: RENDER_ENV });

    await service.setUpHosting({ repo: 'acme/shop-be', stackHint: 'nodejs' });

    expect(render.client.createProject).toHaveBeenCalledWith('own-team', 'shop-be', ['production', 'uat']);
    const [main, uat] = render.client.createService.mock.calls.map(c => c[0]);
    const envOf = (name: string) => render.environments.find(e => e.name === name)!.id;
    expect(main.environmentId).toBe(envOf('production'));
    expect(uat.environmentId).toBe(envOf('uat'));
  });

  it('reuses the project on a retry, adding an environment it is missing', async () => {
    const render = fakeRenderClient();
    render.projects.set('shop-be', { id: 'prj-old', name: 'shop-be' });
    render.environments.push({ id: 'evm-prod', name: 'production', projectId: 'prj-old' });
    const { service } = await load({ env: RENDER_ENV, render });

    await service.setUpHosting({ repo: 'acme/shop-be', stackHint: 'nodejs' });

    expect(render.client.createProject).not.toHaveBeenCalled();
    expect(render.client.createEnvironment).toHaveBeenCalledWith('prj-old', 'uat');
  });

  it('moves ungrouped services into the project, and leaves grouped ones where they are', async () => {
    const render = fakeRenderClient();
    const settled = { envSpecificDetails: { buildCommand: 'npm install --include=dev && npm run build', startCommand: 'npm run start' } };
    render.services.set('shop-be', { id: 'srv-loose', name: 'shop-be', serviceDetails: settled, autoDeployTrigger: 'checksPass' });
    render.services.set('shop-be-uat', { id: 'srv-placed', name: 'shop-be-uat', serviceDetails: settled, autoDeployTrigger: 'checksPass', environmentId: 'evm-elsewhere' });
    const { service } = await load({ env: RENDER_ENV, render });

    await service.setUpHosting({ repo: 'acme/shop-be', stackHint: 'nodejs' });

    const production = render.environments.find(e => e.name === 'production')!.id;
    expect(render.moved).toEqual([{ environmentId: production, resourceIds: ['srv-loose'] }]);
  });

  it('still creates working services, ungrouped, when Render refuses the project', async () => {
    const render = fakeRenderClient({
      createProject: vi.fn(async () => {
        throw new Error('Render 402: upgrade your workspace');
      })
    });
    const { service } = await load({ env: RENDER_ENV, render });

    const status = await service.setUpHosting({ repo: 'acme/shop-be', stackHint: 'nodejs' });

    expect(status.state).toBe('ready');
    expect(render.client.createService.mock.calls.every(c => c[0].environmentId === undefined)).toBe(true);
  });
});

describe('when Vercel cannot link the repository', () => {
  it('keeps Vercel’s own reason and names both things that can be missing', async () => {
    const vercel = fakeVercelClient();
    vercel.client.createProject = vi.fn(async () => {
      const { VercelApiError } = await import('./vercelClient.js');
      throw new VercelApiError('Vercel 400: You need to add a Login Connection to your GitHub account first.', 400);
    });
    const { service } = await load({ env: VERCEL_ENV, vercel });

    const status = await service.setUpHosting({ repo: 'acme/shop-fe', stackHint: 'react' });

    expect(status.state).toBe('failed');
    expect(status.error).toContain('You need to add a Login Connection to your GitHub account first.');
    expect(status.error).toMatch(/owns VERCEL_TOKEN needs GitHub connected/);
  });
});

describe('removing a repository’s hosting', () => {
  const linked = (id: string, name: string, repo = 'https://github.com/acme/shop-be') => ({ id, name, repo, serviceDetails: {} });

  it('removes both services and the project that grouped only them', async () => {
    const render = fakeRenderClient();
    render.services.set('shop-be', linked('srv-a', 'shop-be'));
    render.services.set('shop-be-uat', linked('srv-b', 'shop-be-uat'));
    render.projects.set('shop-be', { id: 'prj-1', name: 'shop-be' });
    render.environments.push({ id: 'evm-1', name: 'production', projectId: 'prj-1', serviceIds: ['srv-a'] } as any);
    render.environments.push({ id: 'evm-2', name: 'uat', projectId: 'prj-1', serviceIds: ['srv-b'] } as any);
    const { service } = await load({ env: RENDER_ENV, render });

    const result = await service.tearDownHosting('acme/shop-be');

    expect(render.deleted).toEqual(['srv-a', 'srv-b', 'prj-1']);
    expect(result).toEqual({
      repo: 'acme/shop-be',
      removed: ['Render service shop-be', 'Render service shop-be-uat', 'Render project shop-be'],
      kept: [],
      failed: []
    });
  });

  it('never removes a same-named service of another repository', async () => {
    const render = fakeRenderClient();
    render.services.set('shop-be', linked('srv-x', 'shop-be', 'https://github.com/someone/else'));
    const { service } = await load({ env: RENDER_ENV, render });

    const result = await service.tearDownHosting('acme/shop-be');

    expect(render.deleted).toEqual([]);
    expect(result.kept).toEqual(['Render service shop-be (linked to https://github.com/someone/else)']);
  });

  /** Deleting a Render project deletes what it still holds. */
  it('keeps the project when it still holds anything else', async () => {
    const render = fakeRenderClient();
    render.services.set('shop-be', linked('srv-a', 'shop-be'));
    render.projects.set('shop-be', { id: 'prj-1', name: 'shop-be' });
    render.environments.push({ id: 'evm-1', name: 'production', projectId: 'prj-1', serviceIds: ['srv-a'], databasesIds: ['db-1'] } as any);
    const { service } = await load({ env: RENDER_ENV, render });

    const result = await service.tearDownHosting('acme/shop-be');

    expect(render.deleted).toEqual(['srv-a']);
    expect(result.kept).toEqual(['Render project shop-be (still holds 1 other resource)']);
  });

  it('removes the Vercel project linked to the repository, and keeps one linked elsewhere', async () => {
    const vercel = fakeVercelClient();
    vercel.projects.set('shop-fe', { id: 'proj-1', name: 'shop-fe', link: { org: 'acme', repo: 'shop-fe' } });
    vercel.projects.set('other-fe', { id: 'proj-2', name: 'other-fe', link: { org: 'someone', repo: 'other-fe' } });
    const { service } = await load({ env: VERCEL_ENV, vercel });

    expect((await service.tearDownHosting('acme/shop-fe')).removed).toEqual(['Vercel project shop-fe']);
    expect((await service.tearDownHosting('acme/other-fe')).kept).toEqual(['Vercel project other-fe (linked to someone/other-fe)']);
    expect(vercel.deleted).toEqual(['proj-1']);
  });

  it('reports a platform failure instead of throwing, so the caller can stop before the repository', async () => {
    const render = fakeRenderClient({
      deleteService: vi.fn(async () => {
        throw new Error('Render 500: try later');
      })
    });
    render.services.set('shop-be', linked('srv-a', 'shop-be'));
    const { service } = await load({ env: RENDER_ENV, render });

    const result = await service.tearDownHosting('acme/shop-be');

    expect(result.failed).toEqual(['Render service shop-be: Render 500: try later']);
  });

  it('has nothing to report when nothing was ever set up', async () => {
    const { service } = await load({ env: { ...RENDER_ENV, ...VERCEL_ENV } });

    expect(await service.tearDownHosting('acme/shop-be')).toEqual({ repo: 'acme/shop-be', removed: [], kept: [], failed: [] });
  });
});
