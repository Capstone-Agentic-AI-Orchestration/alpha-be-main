import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * A hosted branch's logs: the right service or deployment, the platform's own
 * scoping, secrets out, and a failure reported as `unavailable` -- never an
 * empty `live`. The platform clients are faked at their factories.
 */

const LINE = (message: string) => ({
  id: message,
  timestamp: '2026-01-01T00:00:00.000Z',
  message,
  level: 'info' as const,
  type: 'app' as const,
  instance: null,
  labels: {}
});

async function load(options: { render?: Record<string, any>; vercel?: Record<string, any> } = {}) {
  process.env.ALPHA_MODE = 'cloud';
  process.env.RENDER_API_KEY = 'rnd_key';
  process.env.VERCEL_TOKEN = 'vc_token';
  vi.resetModules();
  const render = {
    findServiceByName: vi.fn(async (name: string) => (name === 'shop-be' ? { id: 'srv-main', name, ownerId: 'own-1' } : null)),
    getService: vi.fn(),
    listEnvVars: vi.fn(async () => [
      { key: 'NODE_ENV', value: 'production' },
      { key: 'DATABASE_URL', value: 'postgres://app:hunter22pass@db/shop' }
    ]),
    queryLogs: vi.fn(async (..._args: any[]) => ({ logs: [LINE('db at postgres://app:hunter22pass@db/shop'), LINE('running in production')], hasMore: true, next: { startTime: 'a', endTime: 'b' } })),
    ...options.render
  };
  const vercel = {
    findProjectByName: vi.fn(async () => ({ id: 'proj-1', name: 'shop-fe', link: { type: 'github', org: 'example-org', repo: 'shop-fe' } })),
    listEnvVars: vi.fn(async () => []),
    queryLogs: vi.fn(async (..._args: any[]) => ({ logs: [LINE('GET / 200')], hasMore: false, next: null })),
    ...options.vercel
  };
  vi.doMock('./renderClient.js', async () => ({ ...(await vi.importActual<object>('./renderClient.js')), createRenderClient: () => render }));
  vi.doMock('./vercelClient.js', async () => ({ ...(await vi.importActual<object>('./vercelClient.js')), createVercelClient: () => vercel }));
  const { getHostingLogs } = await import('./hostingLogs.js');
  return { getHostingLogs, render, vercel };
}

afterEach(() => {
  for (const key of ['ALPHA_MODE', 'RENDER_API_KEY', 'VERCEL_TOKEN']) delete process.env[key];
  vi.doUnmock('./renderClient.js');
  vi.doUnmock('./vercelClient.js');
  vi.resetModules();
});

describe('a backend branch’s logs', () => {
  it('reads the branch’s own Render service, scoped by its owner, with its secrets redacted', async () => {
    const { getHostingLogs, render } = await load();

    const page = await getHostingLogs({ repo: 'example-org/shop-be', stackHint: 'nodejs' }, 'main', { direction: 'backward' });

    expect(render.queryLogs).toHaveBeenCalledWith('own-1', 'srv-main', { direction: 'backward' });
    expect(page).toMatchObject({ source: 'live', hasMore: true, next: { startTime: 'a', endTime: 'b' }, filters: ['level', 'type', 'text', 'instance'] });
    expect(page.logs.map(l => l.message)).toEqual(['db at [redacted]', 'running in production']);
  });

  it('asks Render for the owner when the listing left it out', async () => {
    const { getHostingLogs, render } = await load({
      render: {
        findServiceByName: vi.fn(async () => ({ id: 'srv-main', name: 'shop-be' })),
        getService: vi.fn(async () => ({ id: 'srv-main', ownerId: 'own-9' }))
      }
    });

    await getHostingLogs({ repo: 'example-org/shop-be', stackHint: 'nodejs' }, 'main', {});

    expect(render.queryLogs.mock.calls[0][0]).toBe('own-9');
  });

  it('says a backend has no dev service rather than showing nothing', async () => {
    const { getHostingLogs, render } = await load();

    const page = await getHostingLogs({ repo: 'example-org/shop-be', stackHint: 'nodejs' }, 'dev', {});

    expect(page).toMatchObject({ source: 'unavailable', reason: 'Backends are hosted for main and uat only.' });
    expect(render.queryLogs).not.toHaveBeenCalled();
  });

  it('reports a platform failure as unavailable, with the reason', async () => {
    const { getHostingLogs } = await load({ render: { queryLogs: vi.fn(async () => { throw new Error('Render 503: busy'); }) } });

    const page = await getHostingLogs({ repo: 'example-org/shop-be', stackHint: 'nodejs' }, 'main', {});

    expect(page).toMatchObject({ source: 'unavailable', logs: [], reason: 'Could not read Render logs: Render 503: busy' });
  });
});

describe('a frontend branch’s logs', () => {
  it('reads the newest deployment of that branch, or production for main', async () => {
    const { getHostingLogs, vercel } = await load();

    await getHostingLogs({ repo: 'example-org/shop-fe', stackHint: 'react' }, 'uat', { type: ['build'] });
    await getHostingLogs({ repo: 'example-org/shop-fe', stackHint: 'react' }, 'main', {});

    expect(vercel.queryLogs.mock.calls.map(c => c[1])).toEqual([{ branch: 'uat' }, { production: true }]);
    expect(vercel.queryLogs.mock.calls[0][2]).toMatchObject({ type: ['build'] });
  });

  it('reads the exact deployment build output for a project build branch', async () => {
    const { getHostingLogs, vercel } = await load();

    const page = await getHostingLogs({ repo: 'example-org/shop-fe', stackHint: 'react' }, 'build/calculator-1', { type: ['build'], direction: 'backward' });

    expect(vercel.queryLogs).toHaveBeenCalledWith('proj-1', { branch: 'build/calculator-1' }, { type: ['build'], level: undefined, text: undefined });
    expect(page).toMatchObject({ source: 'live', logs: [expect.objectContaining({ message: 'GET / 200' })] });
  });

  it('refuses unsafe branch names before querying Vercel', async () => {
    const { getHostingLogs, vercel } = await load();

    expect(await getHostingLogs({ repo: 'example-org/shop-fe', stackHint: 'react' }, '/main', {})).toMatchObject({
      source: 'unavailable',
      reason: 'The requested branch name is not valid.'
    });
    expect(vercel.queryLogs).not.toHaveBeenCalled();
  });

  it('does not show a same-named Vercel project linked to another repository', async () => {
    const { getHostingLogs, vercel } = await load({
      vercel: { findProjectByName: vi.fn(async () => ({ id: 'proj-1', name: 'shop-fe', link: { org: 'somewhere-else', repo: 'shop-fe' } })) }
    });

    expect(await getHostingLogs({ repo: 'example-org/shop-fe', stackHint: 'react' }, 'build/calculator-1', {})).toMatchObject({
      source: 'unavailable',
      reason: 'The Vercel project with this name is linked to a different repository.'
    });
    expect(vercel.queryLogs).not.toHaveBeenCalled();
  });

  it('does not imply Render can provide logs for an isolated build branch', async () => {
    const { getHostingLogs, render } = await load();

    expect(await getHostingLogs({ repo: 'example-org/shop-be', stackHint: 'nodejs' }, 'build/calculator-1', {})).toMatchObject({
      source: 'unavailable',
      reason: 'Run-branch logs are not available for Render previews.'
    });
    expect(render.queryLogs).not.toHaveBeenCalled();
  });

});
