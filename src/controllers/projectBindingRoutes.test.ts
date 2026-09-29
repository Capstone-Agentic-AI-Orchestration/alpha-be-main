import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Binding a project to a folder on this machine.
 *
 * The project is the team's and the folder is this developer's, so the folder
 * cannot live in the project row: the cloud drops local paths on write, and a
 * path from one laptop means nothing on another. These are the rules for the
 * per-machine binding that replaced it.
 *
 * Real git checkouts, because what is under test includes "is this a checkout
 * of the right repository", and a stub would be checking the stub.
 */

let tmp: string;
let opened: { close(): void }[] = [];
let role = 'dev';
/** Where the stubbed clone put a checkout, so a test can assert on it. */
let cloned: string[] = [];

function aCheckout(name: string, origin?: string): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('commit', '--allow-empty', '-m', 'first');
  if (origin) git('remote', 'add', 'origin', origin);
  return dir;
}

async function startApi() {
  process.env.ALPHA_HOME = path.join(tmp, 'home');
  delete process.env.ALPHA_MODE;
  vi.resetModules();

  /**
   * The clone is stubbed; everything downstream of it is not.
   *
   * What is under test is what Alpha does with the result -- where it puts it,
   * whether it binds it, whether pressing twice is safe. Reaching GitHub
   * would test GitHub.
   */
  vi.doMock('../services/githubService.js', async () => {
    const actual = await vi.importActual<typeof import('../services/githubService.js')>('../services/githubService.js');
    return {
      ...actual,
      githubService: {
        ...actual.githubService,
        cloneRepository: async (repo: string, intoDir: string) => {
          const target = path.join(intoDir, repo.split('/').pop()!);
          fs.mkdirSync(target, { recursive: true });
          const git = (...args: string[]) => execFileSync('git', args, { cwd: target, stdio: 'ignore' });
          git('init');
          git('config', 'user.email', 'test@example.com');
          git('config', 'user.name', 'Test');
          git('commit', '--allow-empty', '-m', 'first');
          git('remote', 'add', 'origin', `https://github.com/${repo}.git`);
          cloned.push(target);
          return target;
        },
        inspectLocalRepo: actual.githubService.inspectLocalRepo.bind(actual.githubService)
      }
    };
  });

  vi.doMock('../services/identityService.js', () => ({
    currentIdentity: async () => ({ login: 'Dev1', source: 'github', role, access: 'granted', github: 'ok', teams: [] }),
    warmIdentity: () => {},
    knownIdentity: () => ({ login: 'Dev1', source: 'github' })
  }));

  const sql = await import('../services/sqliteService.js');
  opened.push(sql.sqliteService);
  opened.push((await import('../services/workspaceRegistry.js')).workspaceRegistry);
  const { dataRouter } = await import('./dataController.js');
  const { workspaceContext } = await import('./workspaceContext.js');
  const { jsonErrorHandler } = await import('./errorHandler.js');

  const app = express();
  app.use(express.json());
  app.use('/api', workspaceContext);
  app.use('/api', dataRouter);
  app.use(jsonErrorHandler);
  return { app, svc: sql.sqliteService as any };
}

async function call(app: express.Express, method: string, url: string, body?: unknown) {
  const { createServer } = await import('node:http');
  const server = createServer(app);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  try {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  } finally {
    await new Promise<void>(r => server.close(() => r()));
  }
}

const REPO = [{ id: 'r1', type: 'github_repo', name: 'repo', pathOrUrl: 'https://github.com/acme/checkout' }];

async function withProject(svc: any) {
  const { runWithWorkspace } = await import('../services/workspaceContext.js');
  return runWithWorkspace('ws-default', () =>
    svc.createProject({ id: 'p1', name: 'Checkout', key: 'CHK', resources: REPO })
  );
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-binding-'));
  opened = [];
  role = 'dev';
  cloned = [];
});

afterEach(() => {
  for (const handle of opened) {
    try {
      handle.close();
    } catch {
      /* already closed */
    }
  }
  delete process.env.ALPHA_HOME;
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* windows handle */
  }
  vi.doUnmock('../services/identityService.js');
  vi.doUnmock('../services/githubService.js');
  vi.resetModules();
});

describe('the state of a bound checkout', () => {
  /**
   * Read from git each time. The developer works in this folder outside Alpha
   * all day, so a remembered branch is a wrong one.
   */
  it('says the branch, and that there is nothing uncommitted', async () => {
    const { app, svc } = await startApi();
    await withProject(svc);
    const dir = aCheckout('checkout', 'https://github.com/acme/checkout.git');
    await call(app, 'PUT', '/api/projects/p1/binding', { localDir: dir });

    const status = (await call(app, 'GET', '/api/projects/p1/binding/status')).body;

    expect(status).toMatchObject({ exists: true, clean: true, ahead: 0, behind: 0 });
    expect(status.branch).toBeTruthy();
  });

  it('notices work that is not committed', async () => {
    const { app, svc } = await startApi();
    await withProject(svc);
    const dir = aCheckout('checkout', 'https://github.com/acme/checkout.git');
    await call(app, 'PUT', '/api/projects/p1/binding', { localDir: dir });
    fs.writeFileSync(path.join(dir, 'unfinished.ts'), 'half a thought');

    expect((await call(app, 'GET', '/api/projects/p1/binding/status')).body.clean).toBe(false);
  });

  /** Folders get moved and deleted; the app should say so rather than guess. */
  it('says so when the folder has gone', async () => {
    const { app, svc } = await startApi();
    await withProject(svc);
    const dir = aCheckout('checkout', 'https://github.com/acme/checkout.git');
    await call(app, 'PUT', '/api/projects/p1/binding', { localDir: dir });
    fs.rmSync(dir, { recursive: true, force: true });

    expect((await call(app, 'GET', '/api/projects/p1/binding/status')).body).toMatchObject({ exists: false });
  });

  it('is nothing at all for a project with no binding', async () => {
    const { app, svc } = await startApi();
    await withProject(svc);

    expect((await call(app, 'GET', '/api/projects/p1/binding/status')).body).toBeNull();
  });
});

describe('binding a project to a folder', () => {
  /** A developer's own act on their own disk, not a change to the project. */
  it('is a developer’s to make', async () => {
    const { app, svc } = await startApi();
    await withProject(svc);
    const dir = aCheckout('checkout', 'https://github.com/acme/checkout.git');

    const res = await call(app, 'PUT', '/api/projects/p1/binding', { localDir: dir });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ projectId: 'p1', localDir: path.resolve(dir), isManaged: false });
    expect(res.body.activeBranch).toBeTruthy();
  });

  it('is read back, and removed', async () => {
    const { app, svc } = await startApi();
    await withProject(svc);
    const dir = aCheckout('checkout', 'https://github.com/acme/checkout.git');
    await call(app, 'PUT', '/api/projects/p1/binding', { localDir: dir });

    expect((await call(app, 'GET', '/api/projects/p1/binding')).body.localDir).toBe(path.resolve(dir));

    expect((await call(app, 'DELETE', '/api/projects/p1/binding')).body).toEqual({ success: true });
    expect((await call(app, 'GET', '/api/projects/p1/binding')).body).toBeNull();
  });

  /**
   * The mistake this exists to catch: an agent editing the wrong checkout
   * looks exactly like one editing the right checkout, until someone reads
   * the diff.
   */
  it('refuses a checkout of another repository', async () => {
    const { app, svc } = await startApi();
    await withProject(svc);
    const dir = aCheckout('elsewhere', 'https://github.com/acme/payments.git');

    const res = await call(app, 'PUT', '/api/projects/p1/binding', { localDir: dir });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ reason: 'wrong_repository' });
    expect(res.body.error).toMatch(/acme\/payments/);
  });

  it('refuses a folder that is not a checkout', async () => {
    const { app, svc } = await startApi();
    await withProject(svc);
    const dir = path.join(tmp, 'just-a-folder');
    fs.mkdirSync(dir);

    const res = await call(app, 'PUT', '/api/projects/p1/binding', { localDir: dir });

    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('invalid_folder');
  });

  it('refuses a folder that is not there at all', async () => {
    const { app, svc } = await startApi();
    await withProject(svc);

    const res = await call(app, 'PUT', '/api/projects/p1/binding', { localDir: path.join(tmp, 'nowhere') });

    expect(res.status).toBe(400);
  });

  /** A project with no repository attached is bound on the person's word. */
  it('accepts any checkout for a project with no repository', async () => {
    const { app, svc } = await startApi();
    const { runWithWorkspace } = await import('../services/workspaceContext.js');
    runWithWorkspace('ws-default', () => svc.createProject({ id: 'p2', name: 'Local', key: 'LOC', resources: [] }));
    const dir = aCheckout('anything', 'https://github.com/acme/payments.git');

    expect((await call(app, 'PUT', '/api/projects/p2/binding', { localDir: dir })).status).toBe(200);
  });

  /** Choosing the folder is the act of consent, so the runner may read it. */
  it('puts the folder on this machine’s allowlist', async () => {
    const { app, svc } = await startApi();
    await withProject(svc);
    const dir = aCheckout('checkout', 'https://github.com/acme/checkout.git');

    await call(app, 'PUT', '/api/projects/p1/binding', { localDir: dir });

    expect(svc.isPathAllowed(path.resolve(dir))).toBe(true);
  });

  it('is where the agent then works', async () => {
    const { app, svc } = await startApi();
    const project = await withProject(svc);
    const dir = aCheckout('checkout', 'https://github.com/acme/checkout.git');
    await call(app, 'PUT', '/api/projects/p1/binding', { localDir: dir });

    const { resolveProjectWorkspace } = await import('../services/workspaceService.js');
    expect(resolveProjectWorkspace(project)).toEqual({ dir: path.resolve(dir), managed: false, repo: 'acme/checkout' });
  });

  it('is set up in one press: cloned, then bound', async () => {
    const { app, svc } = await startApi();
    await withProject(svc);

    const res = await call(app, 'POST', '/api/projects/p1/clone');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ projectId: 'p1', repo: 'acme/checkout', isManaged: true });
    expect(cloned).toHaveLength(1);
    expect(fs.existsSync(path.join(res.body[0].localDir, '.git'))).toBe(true);
  });

  /** So pressing it again after a failure finishes the job rather than refusing. */
  it('binds what is already there rather than cloning twice', async () => {
    const { app, svc } = await startApi();
    await withProject(svc);
    await call(app, 'POST', '/api/projects/p1/clone');

    const again = await call(app, 'POST', '/api/projects/p1/clone');

    expect(again.status).toBe(200);
    expect(cloned).toHaveLength(1);
  });

  /** Alpha did not put it there, so it does not touch it. */
  it('leaves a folder it did not create alone', async () => {
    const { app, svc } = await startApi();
    await withProject(svc);
    const { clonePathFor } = await import('../services/workspaceService.js');
    const target = clonePathFor('acme/checkout').dir;
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'notes.txt'), 'mine');

    const res = await call(app, 'POST', '/api/projects/p1/clone');

    expect(res.status).toBe(400);
    expect(cloned).toHaveLength(0);
    expect(fs.readFileSync(path.join(target, 'notes.txt'), 'utf8')).toBe('mine');
  });

  it('will not clone a project with no repository', async () => {
    const { app, svc } = await startApi();
    const { runWithWorkspace } = await import('../services/workspaceContext.js');
    runWithWorkspace('ws-default', () => svc.createProject({ id: 'p2', name: 'Local', key: 'LOC', resources: [] }));

    const res = await call(app, 'POST', '/api/projects/p2/clone');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no GitHub repository/);
  });

  it('is not a client’s to make', async () => {
    role = 'client';
    const { app, svc } = await startApi();
    await withProject(svc);
    const dir = aCheckout('checkout', 'https://github.com/acme/checkout.git');

    expect((await call(app, 'PUT', '/api/projects/p1/binding', { localDir: dir })).status).toBe(403);
  });

  it('is not a client’s to clone either', async () => {
    role = 'client';
    const { app, svc } = await startApi();
    await withProject(svc);

    expect((await call(app, 'POST', '/api/projects/p1/clone')).status).toBe(403);
  });

  it('cannot be made for a project this workspace does not have', async () => {
    const { app, svc } = await startApi();
    await withProject(svc);
    const dir = aCheckout('checkout', 'https://github.com/acme/checkout.git');

    expect((await call(app, 'PUT', '/api/projects/nope/binding', { localDir: dir })).status).toBe(404);
  });
});

describe('a project with a frontend and a backend', () => {
  const PAIR = [
    { id: 'r-be', type: 'github_repo', name: 'shop-be', pathOrUrl: 'https://github.com/acme/shop-be' },
    { id: 'r-fe', type: 'github_repo', name: 'shop-fe', pathOrUrl: 'https://github.com/acme/shop-fe' }
  ];

  async function withPair(svc: any) {
    const { runWithWorkspace } = await import('../services/workspaceContext.js');
    return runWithWorkspace('ws-default', () => svc.createProject({ id: 'p9', name: 'Shop', key: 'SHP', resources: PAIR }));
  }

  it('clones and binds both in one press, and lists each on this machine', async () => {
    const { app, svc } = await startApi();
    await withPair(svc);

    const res = await call(app, 'POST', '/api/projects/p9/clone');

    expect(res.status).toBe(200);
    expect(res.body.map((b: any) => b.repo)).toEqual(['acme/shop-be', 'acme/shop-fe']);
    const { body } = await call(app, 'GET', '/api/projects/p9/checkouts');
    expect(body.checkouts.map((c: any) => [c.repo, Boolean(c.localDir), c.status?.exists])).toEqual([
      ['acme/shop-be', true, true],
      ['acme/shop-fe', true, true]
    ]);
  });

  it('tells which half a pasted folder is from its origin, wherever it was cloned', async () => {
    const { app, svc } = await startApi();
    await withPair(svc);
    const dir = aCheckout('anywhere/at/all/shop-fe', 'https://github.com/acme/shop-fe.git');

    const res = await call(app, 'PUT', '/api/projects/p9/binding', { localDir: dir });

    expect(res.body).toMatchObject({ repo: 'acme/shop-fe', localDir: path.resolve(dir) });
    const { body } = await call(app, 'GET', '/api/projects/p9/checkouts');
    expect(body.checkouts.map((c: any) => [c.repo, c.localDir])).toEqual([
      ['acme/shop-be', null],
      ['acme/shop-fe', path.resolve(dir)]
    ]);
  });

  /** The half this machine has is never used for work on the half it does not. */
  it('answers for the repository asked about, and nothing else', async () => {
    const { app, svc } = await startApi();
    const project = await withPair(svc);
    const be = aCheckout('shop-be', 'https://github.com/acme/shop-be.git');
    await call(app, 'PUT', '/api/projects/p9/binding', { localDir: be });

    const { resolveProjectWorkspace } = await import('../services/workspaceService.js');
    expect(resolveProjectWorkspace(project, 'acme/shop-fe')).toBeNull();
    expect(resolveProjectWorkspace(project, 'acme/shop-be')?.dir).toBe(path.resolve(be));
    expect(resolveProjectWorkspace(project)?.dir).toBe(path.resolve(be));
  });

  it('clones only the one named, and forgets only the one named', async () => {
    const { app, svc } = await startApi();
    await withPair(svc);

    const res = await call(app, 'POST', '/api/projects/p9/clone', { repo: 'acme/shop-fe' });
    expect(res.body.map((b: any) => b.repo)).toEqual(['acme/shop-fe']);
    await call(app, 'POST', '/api/projects/p9/clone', { repo: 'acme/shop-be' });

    await call(app, 'DELETE', '/api/projects/p9/binding?repo=acme/shop-fe');
    const { body } = await call(app, 'GET', '/api/projects/p9/checkouts');
    expect(body.checkouts.map((c: any) => [c.repo, Boolean(c.localDir)])).toEqual([
      ['acme/shop-be', true],
      ['acme/shop-fe', false]
    ]);
  });

  it('refuses a repository the project does not have', async () => {
    const { app, svc } = await startApi();
    await withPair(svc);

    const res = await call(app, 'POST', '/api/projects/p9/clone', { repo: 'acme/payroll' });

    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('wrong_repository');
  });

  /** A folder bound before per-repository bindings keeps working, as its first repository's. */
  it('reads an older project binding as the first repository’s, and moves it on the next change', async () => {
    const { app, svc } = await startApi();
    const project = await withPair(svc);
    const be = aCheckout('old-be', 'https://github.com/acme/shop-be.git');
    svc.saveProjectBinding({ projectId: 'p9', localDir: be, isManaged: false });

    const { resolveProjectWorkspace } = await import('../services/workspaceService.js');
    expect(resolveProjectWorkspace(project, 'acme/shop-be')?.dir).toBe(path.resolve(be));

    const fe = aCheckout('new-fe', 'https://github.com/acme/shop-fe.git');
    await call(app, 'PUT', '/api/projects/p9/binding', { localDir: fe });

    expect(svc.getProjectBinding('p9')).toBeNull();
    expect(svc.getRepoBinding('p9', 'acme/shop-be')?.localDir).toBe(path.resolve(be));
    expect(svc.getRepoBinding('p9', 'acme/shop-fe')?.localDir).toBe(path.resolve(fe));
  });
});
