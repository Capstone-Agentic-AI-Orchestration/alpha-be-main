import { describe, expect, it } from 'vitest';
import { createVercelClient, VercelApiError } from './vercelClient.js';

/**
 * The Vercel REST client. Same convention as `renderClient.test.ts`: every
 * test supplies its own `fetchImpl`, so nothing here ever reaches the network.
 */

interface Call {
  method: string;
  url: string;
  body: unknown;
}

function fakeFetch(handler: (call: Call) => { status: number; body?: unknown }) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit = {}) => {
    const call: Call = { method: init.method ?? 'GET', url, body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const answer = handler(call);
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('team scoping', () => {
  it('adds ?teamId= to every call when a team is configured', async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 200, body: { envs: [] } }));
    const client = createVercelClient('token', 'team_123', impl);

    await client.listEnvVars('proj-1');

    expect(calls[0].url).toBe('https://api.vercel.com/v10/projects/proj-1/env?teamId=team_123');
  });

  it('adds no teamId at all for a personal-account token', async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 200, body: { envs: [] } }));
    const client = createVercelClient('token', '', impl);

    await client.listEnvVars('proj-1');

    expect(calls[0].url).toBe('https://api.vercel.com/v10/projects/proj-1/env');
  });
});

describe('finding a project by name', () => {
  it('answers null on a 404 rather than throwing', async () => {
    const { impl } = fakeFetch(() => ({ status: 404, body: { error: { message: 'not found' } } }));
    const client = createVercelClient('token', '', impl);

    expect(await client.findProjectByName('shop-fe')).toBeNull();
  });

  it('returns the project on a match', async () => {
    const { impl } = fakeFetch(() => ({ status: 200, body: { id: 'proj-1', name: 'shop-fe' } }));
    const client = createVercelClient('token', '', impl);

    expect(await client.findProjectByName('shop-fe')).toEqual({ id: 'proj-1', name: 'shop-fe' });
  });
});

describe('creating a project', () => {
  it('links the GitHub repository and disables SSO protection at create time', async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 201, body: { id: 'proj-1', name: 'shop-fe' } }));
    const client = createVercelClient('token', '', impl);

    await client.createProject({ name: 'shop-fe', framework: 'vite', org: 'acme', repo: 'shop-fe' });

    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: 'https://api.vercel.com/v11/projects',
      body: { name: 'shop-fe', framework: 'vite', gitRepository: { type: 'github', repo: 'acme/shop-fe' }, ssoProtection: null }
    });
  });

  it('surfaces a 400 as a VercelApiError a caller can recognise as "install the GitHub app"', async () => {
    const { impl } = fakeFetch(() => ({ status: 400, body: { error: { message: 'Please install the GitHub integration' } } }));
    const client = createVercelClient('token', '', impl);

    const call = client.createProject({ name: 'shop-fe', framework: 'vite', org: 'acme', repo: 'shop-fe' });
    await expect(call).rejects.toBeInstanceOf(VercelApiError);
    await expect(call).rejects.toMatchObject({ status: 400, message: expect.stringContaining('GitHub integration') });
  });

  it('surfaces a 409 (name already exists) as a VercelApiError, leaving the reuse decision to the caller', async () => {
    const { impl } = fakeFetch(() => ({ status: 409, body: { error: { message: 'Project already exists' } } }));
    const client = createVercelClient('token', '', impl);

    await expect(client.createProject({ name: 'shop-fe', framework: 'vite', org: 'acme', repo: 'shop-fe' })).rejects.toMatchObject({
      status: 409
    });
  });
});

describe('env vars', () => {
  it('upserts as plain, production-or-preview targeted variables', async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 200, body: {} }));
    const client = createVercelClient('token', '', impl);

    await client.upsertEnvVars('proj-1', [
      { key: 'VITE_API_URL', value: 'https://api.example.com', target: ['production'] },
      { key: 'VITE_API_URL', value: 'https://api-uat.example.com', target: ['preview'] }
    ]);

    expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://api.vercel.com/v10/projects/proj-1/env?upsert=true' });
    expect(calls[0].body).toEqual([
      { key: 'VITE_API_URL', value: 'https://api.example.com', type: 'plain', target: ['production'] },
      { key: 'VITE_API_URL', value: 'https://api-uat.example.com', type: 'plain', target: ['preview'] }
    ]);
  });

  it('restricts a preview variable to one branch when gitBranch is given', async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 200, body: {} }));
    const client = createVercelClient('token', '', impl);

    await client.upsertEnvVars('proj-1', [{ key: 'K', value: 'v', target: ['preview'], gitBranch: 'dev' }]);

    expect((calls[0].body as any[])[0]).toMatchObject({ gitBranch: 'dev' });
  });
});

describe('branch domains', () => {
  it('returns true when Render... Vercel accepts the branch domain', async () => {
    const { impl } = fakeFetch(() => ({ status: 201, body: { name: 'shop-fe-uat.vercel.app' } }));
    const client = createVercelClient('token', '', impl);

    expect(await client.addBranchDomain('proj-1', 'shop-fe-uat.vercel.app', 'uat')).toBe(true);
  });

  it('returns false rather than throwing when the plan does not allow it', async () => {
    const { impl } = fakeFetch(() => ({ status: 403, body: { error: { message: 'not allowed on this plan' } } }));
    const client = createVercelClient('token', '', impl);

    expect(await client.addBranchDomain('proj-1', 'shop-fe-uat.vercel.app', 'uat')).toBe(false);
  });

  it('still throws for an error unrelated to plan limits', async () => {
    const { impl } = fakeFetch(() => ({ status: 500, body: { error: { message: 'internal error' } } }));
    const client = createVercelClient('token', '', impl);

    await expect(client.addBranchDomain('proj-1', 'x', 'uat')).rejects.toBeInstanceOf(VercelApiError);
  });
});

describe('deployments', () => {
  it('deploys with an explicit gitSource ref, since linking a repo does not deploy its branches', async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 201, body: { id: 'dpl-1', url: 'shop-fe.vercel.app' } }));
    const client = createVercelClient('token', '', impl);

    await client.createDeployment({ name: 'shop-fe', projectId: 'proj-1', org: 'acme', repo: 'shop-fe', ref: 'main', target: 'production' });

    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: 'https://api.vercel.com/v13/deployments',
      body: { name: 'shop-fe', project: 'proj-1', target: 'production', gitSource: { type: 'github', org: 'acme', repo: 'shop-fe', ref: 'main' } }
    });
  });

  it('omits target for a preview deployment', async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 201, body: { id: 'dpl-2' } }));
    const client = createVercelClient('token', '', impl);

    await client.createDeployment({ name: 'shop-fe', projectId: 'proj-1', org: 'acme', repo: 'shop-fe', ref: 'uat' });

    expect(calls[0].body).not.toHaveProperty('target');
  });

  /** Filtered by Vercel, not picked out of a page of mixed results -- a preview once read as production. */
  it('asks Vercel for the newest production deployment only', async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 200, body: { deployments: [{ uid: 'p' }] } }));
    const client = createVercelClient('token', '', impl);

    expect(await client.latestDeployment('proj-1', { production: true })).toEqual({ uid: 'p' });
    expect(calls[0].url).toContain('/v7/deployments?projectId=proj-1&limit=1&target=production');
  });

  it('asks Vercel for the newest deployment of one branch', async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 200, body: { deployments: [{ uid: 'd' }] } }));
    const client = createVercelClient('token', '', impl);

    expect(await client.latestDeployment('proj-1', { branch: 'dev' })).toEqual({ uid: 'd' });
    expect(calls[0].url).toContain('&branch=dev');
    expect(calls[0].url).not.toContain('target=');
  });

  it('answers null when there is no such deployment', async () => {
    const { impl } = fakeFetch(() => ({ status: 200, body: { deployments: [] } }));
    const client = createVercelClient('token', '', impl);

    expect(await client.latestDeployment('proj-1', { branch: 'uat' })).toBeNull();
  });

  it('reads the aliases Vercel assigned a deployment', async () => {
    const { impl, calls } = fakeFetch(() => ({
      status: 200,
      body: { id: 'dpl-1', alias: ['shop-fe-git-uat-team.vercel.app'] }
    }));
    const client = createVercelClient('token', '', impl);

    expect(await client.deploymentAliases('dpl-1')).toEqual(['shop-fe-git-uat-team.vercel.app']);
    expect(calls[0].url).toContain('/v13/deployments/dpl-1');
  });
});
describe('deleting a project', () => {
  it('sends DELETE to the project', async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 204 }));
    const client = createVercelClient('token', '', impl);

    await client.deleteProject('proj-1');

    expect(calls[0]).toMatchObject({ method: 'DELETE', url: 'https://api.vercel.com/v9/projects/proj-1' });
  });
});

describe('reading logs', () => {
  it('reads a branch deployment’s build output when only build logs are asked for', async () => {
    const { impl, calls } = fakeFetch(call =>
      call.url.includes('/v7/deployments')
        ? { status: 200, body: { deployments: [{ uid: 'dpl-uat' }] } }
        : { status: 200, body: [{ id: 'e1', created: 1767225600000, type: 'stdout', payload: { text: 'Build completed' } }] }
    );
    const client = createVercelClient('token', '', impl);

    const page = await client.queryLogs('proj-1', { branch: 'uat' }, { type: ['build'] });

    expect(calls[0].url).toContain('branch=uat');
    expect(calls[1].url).toContain('/v3/deployments/dpl-uat/events');
    expect(page.logs.map(l => l.message)).toEqual(['Build completed']);
  });

  it('reads runtime logs sent as a stream of JSON lines, and filters them by level', async () => {
    const ndjson = [
      JSON.stringify({ id: 'r1', timestamp: 1767225600000, message: 'GET / 200', level: 'info' }),
      JSON.stringify({ id: 'r2', timestamp: 1767225601000, message: 'boom', level: 'error' }),
      '{"id":"r3","timest'
    ].join('\n');
    const impl = (async (url: string) =>
      String(url).includes('/v7/deployments')
        ? new Response(JSON.stringify({ deployments: [{ uid: 'dpl-prod' }] }), { status: 200 })
        : new Response(ndjson, { status: 200, headers: { 'content-type': 'application/stream+json' } })) as unknown as typeof fetch;
    const client = createVercelClient('token', '', impl);

    const page = await client.queryLogs('proj-1', { production: true }, { level: ['error'] });

    expect(page).toMatchObject({ hasMore: false, next: null });
    expect(page.logs.map(l => l.message)).toEqual(['boom']);
  });

  it('answers no lines when the branch has never been deployed', async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 200, body: { deployments: [] } }));

    const page = await createVercelClient('token', '', impl).queryLogs('proj-1', { branch: 'dev' }, {});

    expect(page.logs).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});