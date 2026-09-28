import { describe, expect, it } from 'vitest';
import { createRenderClient, RenderApiError } from './renderClient.js';

/**
 * The Render REST client. No real network call is possible here -- every test
 * hands the client its own `fetchImpl`, a table-driven fake that also records
 * what was sent, so a request's method, path and body are asserted directly
 * rather than inferred from behaviour.
 */

interface Call {
  method: string;
  url: string;
  body: unknown;
  headers: Record<string, string>;
}

function fakeFetch(handler: (call: Call) => { status: number; body?: unknown; headers?: Record<string, string> }) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit = {}) => {
    const headers = Object.fromEntries(new Headers(init.headers as ConstructorParameters<typeof Headers>[0]).entries());
    const call: Call = { method: init.method ?? 'GET', url, body: init.body ? JSON.parse(String(init.body)) : undefined, headers };
    calls.push(call);
    const answer = handler(call);
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
      status: answer.status,
      headers: answer.headers
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('authorization', () => {
  it('sends the api key as a bearer token, never anything else identifying it', async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 200, body: [] }));
    const client = createRenderClient('rnd_secret', impl);

    await client.listOwners();

    // Headers normalizes names to lowercase.
    expect(calls[0].headers.authorization).toBe('Bearer rnd_secret');
  });
});

describe('owners', () => {
  it('unwraps the {cursor, owner} list shape', async () => {
    const { impl } = fakeFetch(() => ({
      status: 200,
      body: [{ cursor: 'a', owner: { id: 'usr-1', type: 'user' } }, { cursor: 'b', owner: { id: 'tea-1', type: 'team' } }]
    }));
    const client = createRenderClient('key', impl);

    const owners = await client.listOwners();

    expect(owners).toEqual([{ id: 'usr-1', type: 'user' }, { id: 'tea-1', type: 'team' }]);
  });
});

describe('finding a service by name', () => {
  it('returns the exact match, not a prefix match Render\'s filter also returns', async () => {
    const { impl } = fakeFetch(() => ({
      status: 200,
      body: [{ service: { id: 's1', name: 'shop-be' } }, { service: { id: 's2', name: 'shop-be-uat' } }]
    }));
    const client = createRenderClient('key', impl);

    const found = await client.findServiceByName('shop-be');

    expect(found).toEqual({ id: 's1', name: 'shop-be' });
  });

  it('answers null rather than throwing when there is no match', async () => {
    const { impl } = fakeFetch(() => ({ status: 200, body: [] }));
    const client = createRenderClient('key', impl);

    expect(await client.findServiceByName('shop-be')).toBeNull();
  });
});

describe('creating a service', () => {
  it('always sends the free plan, the health check path and both build/start commands', async () => {
    const { impl, calls } = fakeFetch(call => {
      if (call.method === 'POST' && call.url === 'https://api.render.com/v1/services') {
        return { status: 201, body: { service: { id: 'srv-1', name: 'shop-be' }, deployId: 'dep-1' } };
      }
      return { status: 200, body: { id: 'srv-1', name: 'shop-be', dashboardUrl: 'https://dashboard.render.com/web/srv-1' } };
    });
    const client = createRenderClient('key', impl);

    await client.createService({
      name: 'shop-be',
      ownerId: 'own-1',
      repo: 'https://github.com/acme/shop-be',
      branch: 'main',
      region: 'oregon',
      healthCheckPath: '/health',
      buildCommand: 'npm install && npm run build',
      startCommand: 'npm run start',
      autoDeployTrigger: 'checksPass'
    });

    const create = calls.find(c => c.method === 'POST')!;
    expect(create.body).toMatchObject({
      type: 'web_service',
      name: 'shop-be',
      ownerId: 'own-1',
      repo: 'https://github.com/acme/shop-be',
      branch: 'main',
      autoDeploy: 'yes',
      autoDeployTrigger: 'checksPass',
      serviceDetails: {
        runtime: 'node',
        plan: 'free',
        region: 'oregon',
        healthCheckPath: '/health',
        previews: { generation: 'off' },
        envSpecificDetails: { buildCommand: 'npm install && npm run build', startCommand: 'npm run start' }
      }
    });
  });

  it('retries without autoDeployTrigger when Render rejects the field', async () => {
    let attempt = 0;
    const { impl, calls } = fakeFetch(call => {
      if (call.method !== 'POST') return { status: 200, body: {} };
      attempt += 1;
      if (attempt === 1) return { status: 400, body: { message: 'unknown field autoDeployTrigger' } };
      return { status: 201, body: { service: { id: 'srv-1', name: 'shop-be' } } };
    });
    const client = createRenderClient('key', impl);

    const result = await client.createService({
      name: 'shop-be',
      ownerId: 'own-1',
      repo: 'https://github.com/acme/shop-be',
      branch: 'main',
      region: 'oregon',
      healthCheckPath: '/health',
      buildCommand: 'npm install',
      startCommand: 'npm start',
      autoDeployTrigger: 'checksPass'
    });

    expect(result.service.id).toBe('srv-1');
    const posts = calls.filter(c => c.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(posts[0].body).toHaveProperty('autoDeployTrigger');
    expect(posts[1].body).not.toHaveProperty('autoDeployTrigger');
  });

  it('does not retry a failure unrelated to autoDeployTrigger', async () => {
    const { impl } = fakeFetch(() => ({ status: 500, body: { message: 'internal error' } }));
    const client = createRenderClient('key', impl);

    await expect(
      client.createService({
        name: 'shop-be',
        ownerId: 'own-1',
        repo: 'https://github.com/acme/shop-be',
        branch: 'main',
        region: 'oregon',
        healthCheckPath: '/health',
        buildCommand: 'npm install',
        startCommand: 'npm start',
        autoDeployTrigger: 'checksPass'
      })
    ).rejects.toThrow(/Render 500/);
  });
});

describe('errors', () => {
  it('surfaces Render’s own message and status', async () => {
    const { impl } = fakeFetch(() => ({ status: 404, body: { message: 'Not Found' } }));
    const client = createRenderClient('key', impl);

    const call = client.getService('missing');
    await expect(call).rejects.toBeInstanceOf(RenderApiError);
    await expect(call).rejects.toMatchObject({ status: 404, message: 'Render 404: Not Found' });
  });

  it('captures Retry-After on a 429, for a caller to back off by', async () => {
    const { impl } = fakeFetch(() => ({ status: 429, body: { message: 'rate limited' }, headers: { 'retry-after': '120' } }));
    const client = createRenderClient('key', impl);

    const call = client.getService('any');
    await expect(call).rejects.toMatchObject({ status: 429, retryAfterSeconds: 120 });
  });
});

describe('env vars and deploys', () => {
  it('sets an env var without triggering a deploy, then triggers one explicitly', async () => {
    const { impl, calls } = fakeFetch(call => {
      if (call.method === 'PUT') return { status: 200, body: { key: 'CORS_ORIGINS', value: call.body } };
      if (call.method === 'POST') return { status: 201, body: { id: 'dep-2' } };
      return { status: 200, body: [] };
    });
    const client = createRenderClient('key', impl);

    await client.setEnvVar('srv-1', 'CORS_ORIGINS', 'https://app.example.com');
    await client.triggerDeploy('srv-1');

    expect(calls[0]).toMatchObject({ method: 'PUT', url: 'https://api.render.com/v1/services/srv-1/env-vars/CORS_ORIGINS', body: { value: 'https://app.example.com' } });
    expect(calls[1]).toMatchObject({ method: 'POST', url: 'https://api.render.com/v1/services/srv-1/deploys' });
  });

  it('unwraps the {cursor, envVar} list shape', async () => {
    const { impl } = fakeFetch(() => ({ status: 200, body: [{ cursor: 'a', envVar: { key: 'NODE_ENV', value: 'production' } }] }));
    const client = createRenderClient('key', impl);

    expect(await client.listEnvVars('srv-1')).toEqual([{ key: 'NODE_ENV', value: 'production' }]);
  });

  it('answers null when a service has never deployed', async () => {
    const { impl } = fakeFetch(() => ({ status: 200, body: [] }));
    const client = createRenderClient('key', impl);

    expect(await client.latestDeploy('srv-1')).toBeNull();
  });

  it('unwraps the {cursor, deploy} list shape for the latest deploy', async () => {
    const { impl } = fakeFetch(() => ({ status: 200, body: [{ cursor: 'a', deploy: { id: 'dep-1', status: 'live' } }] }));
    const client = createRenderClient('key', impl);

    expect(await client.latestDeploy('srv-1')).toEqual({ id: 'dep-1', status: 'live' });
  });
});

describe('deleting a service', () => {
  it('sends DELETE to the service', async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 204 }));
    const client = createRenderClient('key', impl);

    await client.deleteService('srv-1');

    expect(calls[0]).toMatchObject({ method: 'DELETE', url: 'https://api.render.com/v1/services/srv-1' });
  });
});
