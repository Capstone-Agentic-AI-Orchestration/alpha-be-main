import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Signing out of the desktop app.
 *
 * It deleted Alpha's stored credential and nothing else. The identity is
 * resolved once and cached, so the window reloaded onto the same signed-in
 * developer -- and every request went on being served as them -- until the
 * app was restarted. From inside the app, sign-out simply did not work.
 */

let tmp: string;
let credential: boolean;
let forgotten: number;

async function startApi() {
  process.env.ALPHA_HOME = tmp;
  vi.resetModules();

  // The real identity service caches the same way: resolved once, reused
  // until `refreshIdentity`. What it resolves to follows the credential.
  let cached: any = null;
  const resolve = () =>
    credential
      ? { login: 'Dev1', source: 'github', role: 'dev', access: 'granted', github: 'ok', teams: [] }
      : { login: 'os-user', source: 'local', access: 'granted', github: 'signed_out', teams: [] };
  vi.doMock('../services/identityService.js', async () => ({
    ...(await vi.importActual<object>('../services/identityService.js')),
    currentIdentity: async () => (cached ??= resolve()),
    refreshIdentity: async () => {
      cached = null;
      return (cached = resolve());
    },
    knownIdentity: () => cached ?? undefined,
    warmIdentity: () => {}
  }));
  vi.doMock('../services/githubService.js', async () => ({
    ...(await vi.importActual<object>('../services/githubService.js')),
    githubService: {
      logout: async () => {
        credential = false;
      }
    }
  }));
  vi.doMock('../services/supabaseService.js', async () => ({
    ...(await vi.importActual<object>('../services/supabaseService.js')),
    supabaseService: {
      forgetCredentials: () => void (forgotten += 1),
      sharesBoard: () => false,
      connectionProblem: () => null,
      isConfigured: () => false
    }
  }));

  const { githubRouter } = await import('./githubController.js');
  const { dataRouter } = await import('./dataController.js');
  const app = express();
  app.use(express.json());
  app.use('/api', githubRouter);
  app.use('/api', dataRouter);
  return app;
}

async function call(app: express.Express, method: string, url: string) {
  const { createServer } = await import('node:http');
  const server = createServer(app);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  try {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, { method });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  } finally {
    await new Promise<void>(r => server.close(() => r()));
  }
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-signout-'));
  credential = true;
  forgotten = 0;
});

afterEach(() => {
  delete process.env.ALPHA_HOME;
  vi.doUnmock('../services/identityService.js');
  vi.doUnmock('../services/githubService.js');
  vi.doUnmock('../services/supabaseService.js');
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* windows handle */
  }
});

// Loading the data routes cold takes a few seconds on its own.
describe('signing out of the desktop app', { timeout: 30_000 }, () => {
  it('is signed out afterwards, not still the same developer until a restart', async () => {
    const app = await startApi();
    expect((await call(app, 'GET', '/api/me')).body).toMatchObject({ login: 'Dev1', github: 'ok' });

    expect((await call(app, 'POST', '/api/github/auth/logout')).status).toBe(200);

    expect((await call(app, 'GET', '/api/me')).body).toMatchObject({ github: 'signed_out' });
  });

  it('drops the database token exchanged for the account that left', async () => {
    const app = await startApi();
    await call(app, 'POST', '/api/github/auth/logout');
    expect(forgotten).toBe(1);
  });
});
