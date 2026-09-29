import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Setting and removing a hosted repository's variables: what may be written,
 * where each platform puts it, that a change is audited by key only, and
 * that values never come back. The platform clients and the audit are faked.
 */

const USER = { login: 'dev-one', kind: 'user' as const };

async function load(options: { render?: Record<string, any>; vercel?: Record<string, any> } = {}) {
  process.env.ALPHA_MODE = 'cloud';
  process.env.RENDER_API_KEY = 'rnd_key';
  process.env.VERCEL_TOKEN = 'vc_token';
  vi.resetModules();
  const audit: any[] = [];
  const render = {
    findServiceByName: vi.fn(async (name: string) => ({ id: name === 'shop-be' ? 'srv-main' : 'srv-uat', name })),
    setEnvVar: vi.fn(async (..._args: any[]) => undefined),
    deleteEnvVar: vi.fn(async (..._args: any[]) => undefined),
    triggerDeploy: vi.fn(async (..._args: any[]) => ({ id: 'dep' })),
    ...options.render
  };
  const vercel = {
    findProjectByName: vi.fn(async () => ({ id: 'proj-1', name: 'shop-fe', link: { org: 'example-org', repo: 'shop-fe' } })),
    upsertEnvVars: vi.fn(async (..._args: any[]) => undefined),
    listEnvVars: vi.fn(async (..._args: any[]) => [] as any[]),
    deleteEnvVar: vi.fn(async (..._args: any[]) => undefined),
    createDeployment: vi.fn(async (..._args: any[]) => ({ id: 'dpl' })),
    ...options.vercel
  };
  vi.doMock('./renderClient.js', async () => ({ ...(await vi.importActual<object>('./renderClient.js')), createRenderClient: () => render }));
  vi.doMock('./vercelClient.js', async () => ({ ...(await vi.importActual<object>('./vercelClient.js')), createVercelClient: () => vercel }));
  vi.doMock('./hostingAudit.js', () => ({ recordHostingChange: async (entry: any) => void audit.push(entry) }));
  const env = await import('./hostingEnv.js');
  return { env, render, vercel, audit };
}

afterEach(() => {
  for (const key of ['ALPHA_MODE', 'RENDER_API_KEY', 'VERCEL_TOKEN']) delete process.env[key];
  for (const mod of ['./renderClient.js', './vercelClient.js', './hostingAudit.js']) vi.doUnmock(mod);
  vi.resetModules();
});

const BE = { repo: 'example-org/shop-be', stackHint: 'nodejs' };
const FE = { repo: 'example-org/shop-fe', stackHint: 'react' };

describe('what may be written', () => {
  it.each([
    [{ environment: 'uat', vars: [{ key: 'CORS_ORIGINS', value: 'x' }] }, /set by Alpha/],
    [{ environment: 'uat', vars: [{ key: 'RENDER_SERVICE_ID', value: 'x' }] }, /reserved/],
    [{ environment: 'uat', vars: [{ key: 'lower', value: 'x' }] }, /not a valid name/],
    [{ environment: 'uat', vars: [{ key: 'A_KEY', value: 'x' }, { key: 'A_KEY', value: 'y' }] }, /given twice/],
    [{ environment: 'uat', vars: [{ key: 'BIG', value: 'x'.repeat(16_385) }] }, /longer than/],
    [{ environment: 'dev', vars: [{ key: 'A_KEY', value: 'x' }] }, /not hosted in dev/],
    [{ environment: 'uat', vars: [] }, /at least one/]
  ])('refuses %o before touching the platform', async (request, message) => {
    const { env, render } = await load();

    await expect(env.setHostingEnv(BE, request as any, USER, 'ws-1')).rejects.toThrow(message);
    expect(render.setEnvVar).not.toHaveBeenCalled();
  });
});

describe('a backend’s variables', () => {
  it('sets each key on the environment’s own Render service, redeploys it, and audits keys only', async () => {
    const { env, render, audit } = await load();

    const result = await env.setHostingEnv(BE, { environment: 'uat', vars: [{ key: 'STRIPE_KEY', value: 'sk_test_1' }] }, USER, 'ws-1');

    expect(render.setEnvVar).toHaveBeenCalledWith('srv-uat', 'STRIPE_KEY', 'sk_test_1');
    expect(render.triggerDeploy).toHaveBeenCalledWith('srv-uat');
    expect(result).toEqual({ environment: 'uat', changed: ['STRIPE_KEY'], failed: [], redeployed: true });
    expect(audit.map(a => [a.action, a.keys, a.result])).toEqual([
      ['env_set', ['STRIPE_KEY'], 'ok'],
      ['redeploy', [], 'ok']
    ]);
    expect(JSON.stringify(audit)).not.toContain('sk_test_1');
  });

  it('reports a partial change key by key, and skips the redeploy when asked', async () => {
    const { env, render } = await load({
      render: { setEnvVar: vi.fn(async (_id: string, key: string) => { if (key === 'BAD_ONE') throw new Error('Render 400'); }) }
    });

    const result = await env.setHostingEnv(
      BE,
      { environment: 'main', vars: [{ key: 'GOOD_ONE', value: 'a' }, { key: 'BAD_ONE', value: 'b' }], redeploy: false },
      USER,
      'ws-1'
    );

    expect(result).toMatchObject({ changed: ['GOOD_ONE'], failed: [{ key: 'BAD_ONE', error: 'Render 400' }], redeployed: false });
    expect(render.triggerDeploy).not.toHaveBeenCalled();
  });

  it('removes one key from the environment’s service', async () => {
    const { env, render } = await load();

    await env.deleteHostingEnv(BE, 'main', 'STRIPE_KEY', {}, USER, 'ws-1');

    expect(render.deleteEnvVar).toHaveBeenCalledWith('srv-main', 'STRIPE_KEY');
  });
});

describe('a frontend’s variables', () => {
  it('writes production without a branch, as a sensitive value', async () => {
    const { env, vercel } = await load();

    await env.setHostingEnv(FE, { environment: 'main', vars: [{ key: 'VITE_STRIPE_PK', value: 'pk_1' }] }, USER, 'ws-1');

    expect(vercel.upsertEnvVars).toHaveBeenCalledWith('proj-1', [
      { key: 'VITE_STRIPE_PK', value: 'pk_1', type: 'sensitive', target: ['production'] }
    ]);
    expect(vercel.createDeployment).toHaveBeenCalledWith(expect.objectContaining({ ref: 'main', target: 'production' }));
  });

  it('scopes a preview variable to its own branch', async () => {
    const { env, vercel } = await load();

    await env.setHostingEnv(FE, { environment: 'dev', vars: [{ key: 'VITE_FLAG', value: 'on' }] }, USER, 'ws-1');

    expect(vercel.upsertEnvVars.mock.calls[0][1]).toEqual([
      { key: 'VITE_FLAG', value: 'on', type: 'sensitive', target: ['preview'], gitBranch: 'dev' }
    ]);
    expect(vercel.createDeployment.mock.calls[0][0]).not.toHaveProperty('target');
  });

  it('refuses a branch variable on a project not linked to its repository', async () => {
    const { env, vercel } = await load({ vercel: { findProjectByName: vi.fn(async () => ({ id: 'proj-1', name: 'shop-fe' })) } });

    await expect(env.setHostingEnv(FE, { environment: 'uat', vars: [{ key: 'VITE_FLAG', value: 'on' }] }, USER, 'ws-1')).rejects.toThrow(/not linked/);
    expect(vercel.upsertEnvVars).not.toHaveBeenCalled();
  });

  /** The same key usually exists once per environment; deleting by key alone would remove another branch's. */
  it('deletes the record for this environment only', async () => {
    const { env, vercel } = await load({
      vercel: {
        listEnvVars: vi.fn(async () => [
          { id: 'e-prod', key: 'VITE_FLAG', target: ['production'] },
          { id: 'e-dev', key: 'VITE_FLAG', target: ['preview'], gitBranch: 'dev' },
          { id: 'e-uat', key: 'VITE_FLAG', target: ['preview'], gitBranch: 'uat' }
        ])
      }
    });

    await env.deleteHostingEnv(FE, 'uat', 'VITE_FLAG', { redeploy: false }, USER, 'ws-1');

    expect(vercel.deleteEnvVar).toHaveBeenCalledWith('proj-1', 'e-uat');
  });

  it('says so when the key is not set in that environment', async () => {
    const { env } = await load();

    await expect(env.deleteHostingEnv(FE, 'uat', 'VITE_FLAG', {}, USER, 'ws-1')).rejects.toThrow(/not set in uat/);
  });
});
