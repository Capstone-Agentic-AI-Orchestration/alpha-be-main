import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';

/**
 * Handing someone the desktop app.
 *
 * The repository is private, so the link cannot be a link: an anonymous
 * browser gets a 404 from GitHub, and a public release would put an installer
 * carrying this deployment's settings in front of anyone who found the URL. So
 * the cloud fetches it with the signed-in person's own token and streams it
 * back, and GitHub decides whether they may have it.
 *
 * What this replaces served a zip from a path relative to the daemon, which
 * exists on nobody's Render instance: the button answered 404 for every
 * developer the gateway page offered it to.
 */

/** The real one, kept before the stub goes in: the test's own requests use it. */
const realFetch = globalThis.fetch.bind(globalThis);

let calls: string[];
let release: unknown;
let releaseFails: { status: number; message: string } | null;
let assetStatus = 200;

async function startApi({ repo = 'acme/alpha-desktop' } = {}) {
  process.env.ALPHA_MODE = 'cloud';
  process.env.ALPHA_DESKTOP_REPO = repo;
  vi.resetModules();

  const { useGitHubApi } = await import('../services/githubApi.js');
  useGitHubApi({
    get: async (path: string) => {
      calls.push(`GET ${path}`);
      if (releaseFails) throw Object.assign(new Error(releaseFails.message), { status: releaseFails.status });
      return release as never;
    },
    getAll: async () => [],
    post: async () => ({}) as never,
    patch: async () => ({}) as never,
    put: async () => ({}) as never,
    delete: async () => {}
  });

  // The asset itself comes back as bytes, not JSON, so it is a plain fetch.
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push(`FETCH ${url}`);
    const auth = ((init?.headers ?? {}) as Record<string, string>).Authorization ?? '';
    calls.push(`AUTH ${auth ? 'present' : 'missing'}`);
    if (assetStatus !== 200) return new Response('no', { status: assetStatus });
    return new Response(new Blob(['MZ-installer-bytes']).stream(), { status: 200 });
  });

  const { downloadRouter } = await import('./downloadController.js');
  const { jsonErrorHandler } = await import('./errorHandler.js');
  const { withGitHubIdentity } = await import('../services/githubRequestContext.js');
  const app = express();
  app.use(express.json());
  // What sessionContext puts on a signed-in request in the cloud: who they are,
  // and their GitHub token on the request's async chain.
  app.use((req, _res, next) => {
    (req as any).workspace = { userId: 'Dev1', workspaceId: 'ws-default', role: 'dev' };
    withGitHubIdentity({ token: 'gho_test', login: 'Dev1' }, () => next());
  });
  app.use('/api', downloadRouter);
  app.use(jsonErrorHandler);
  return app;
}

async function call(app: express.Express, url: string) {
  const { createServer } = await import('node:http');
  const server = createServer(app);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  try {
    const res = await realFetch(`http://127.0.0.1:${port}${url}`);
    const type = res.headers.get('content-type') ?? '';
    return {
      status: res.status,
      disposition: res.headers.get('content-disposition'),
      body: (type.includes('json') ? await res.json() : await res.text()) as any
    };
  } finally {
    await new Promise<void>(r => server.close(() => r()));
  }
}

const aRelease = (assets: Array<{ name: string }>) => ({
  tag_name: 'v2.0.1',
  name: 'Alpha 2.0.1',
  draft: false,
  prerelease: false,
  assets: assets.map(asset => ({
    ...asset,
    size: 42,
    url: `https://api.github.com/repos/acme/alpha-desktop/releases/assets/${asset.name}`
  }))
});

beforeEach(() => {
  calls = [];
  releaseFails = null;
  assetStatus = 200;
  release = aRelease([{ name: 'Alpha-Setup-2.0.1.exe' }, { name: 'Alpha-2.0.1-portable.exe' }, { name: 'latest.yml' }]);
});

afterEach(() => {
  delete process.env.ALPHA_MODE;
  delete process.env.ALPHA_DESKTOP_REPO;
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('downloading the desktop app', () => {
  it('streams the installer from the latest release, as this person', async () => {
    const app = await startApi();

    const res = await call(app, '/api/download/desktop');

    expect(res.status).toBe(200);
    expect(res.disposition).toContain('Alpha-Setup-2.0.1.exe');
    expect(res.body).toContain('MZ-installer-bytes');
    // The caller's own token: GitHub decides whether they may have it.
    expect(calls).toContain('AUTH present');
  });

  /** The setup installer, not the portable build, which is not what a person means. */
  it('prefers the installer over the portable build', async () => {
    release = aRelease([{ name: 'Alpha-2.0.1-portable.exe' }, { name: 'Alpha-Setup-2.0.1.exe' }]);
    const app = await startApi();

    expect((await call(app, '/api/download/desktop')).disposition).toContain('Alpha-Setup-2.0.1.exe');
  });

  /** The ordinary state before the first release, which deserves a plain sentence. */
  it('says when nothing has been released yet', async () => {
    releaseFails = { status: 404, message: 'GitHub 404 on GET: Not Found' };
    const app = await startApi();

    const res = await call(app, '/api/download/desktop');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no desktop release has been published/i);
  });

  it('says when a release has no installer attached', async () => {
    release = aRelease([{ name: 'latest.yml' }]);
    const app = await startApi();

    const res = await call(app, '/api/download/desktop');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no Windows installer/i);
  });

  it('says when this deployment has no desktop repository', async () => {
    const app = await startApi({ repo: '' });

    const res = await call(app, '/api/download/desktop');

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/ALPHA_DESKTOP_REPO/);
  });

  /** GitHub refusing the person is not this service failing. */
  it('reports a refusal from GitHub rather than a broken file', async () => {
    assetStatus = 403;
    const app = await startApi();

    const res = await call(app, '/api/download/desktop');

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/403/);
  });

  it('tells a page which version is on offer', async () => {
    const app = await startApi();

    expect((await call(app, '/api/download/desktop/version')).body).toMatchObject({
      version: 'v2.0.1',
      available: true
    });
  });

  it('answers the version question without a release, too', async () => {
    releaseFails = { status: 404, message: 'Not Found' };
    const app = await startApi();

    expect((await call(app, '/api/download/desktop/version')).body).toMatchObject({
      version: null,
      available: false
    });
  });
});
