import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Deleting a project's repository: the order of the steps, and what stops
 * the ones after it.
 *
 * GitHub, the project store and hosting teardown are faked; what is under
 * test is that nothing is removed before the caller is known to be allowed,
 * that the repository outlives any hosting that could not be removed, and
 * that only Alpha's own working copies are ever deleted from disk.
 */

const REPO = 'acme/shop-be';

function project(resources: any[] = [{ id: 'r1', type: 'github_repo', pathOrUrl: `https://github.com/${REPO}` }]) {
  return { id: 'p1', key: 'SHOP', name: 'Shop', resources } as any;
}

async function load(options: {
  mode?: 'cloud' | 'desktop';
  home?: string;
  admin?: boolean;
  repoMissing?: boolean;
  deleteStatus?: number;
  teardown?: { removed?: string[]; kept?: string[]; failed?: string[] };
} = {}) {
  process.env.ALPHA_MODE = options.mode ?? 'cloud';
  process.env.ALPHA_CLOUD_API = '';
  if (options.home) process.env.ALPHA_HOME = options.home;
  vi.resetModules();

  const steps: string[] = [];
  const updates: any[] = [];

  vi.doMock('./githubApi.js', async () => {
    const actual = await vi.importActual<typeof import('./githubApi.js')>('./githubApi.js');
    return {
      ...actual,
      githubApi: () => ({
        get: async (p: string) => {
          steps.push(`github get ${p}`);
          if (options.repoMissing) throw new actual.GitHubApiError('Not Found', 404);
          return { permissions: { admin: options.admin ?? true, push: true } };
        },
        delete: async (p: string) => {
          steps.push(`github delete ${p}`);
          if (options.deleteStatus) throw new actual.GitHubApiError('Must have admin rights to Repository.', options.deleteStatus);
        }
      })
    };
  });
  vi.doMock('./hosting/hostingService.js', () => ({
    tearDownHosting: async (repo: string) => {
      steps.push(`hosting teardown ${repo}`);
      return { repo, removed: [], kept: [], failed: [], ...options.teardown };
    }
  }));
  vi.doMock('../store/stores.js', () => ({
    projectStore: () => ({
      update: async (_ws: string, id: string, patch: any) => {
        steps.push('project update');
        updates.push(patch);
        return { ...project(), id, ...patch };
      }
    })
  }));

  const service = await import('./repoDeletionService.js');
  return { service, steps, updates };
}

afterEach(() => {
  vi.doUnmock('./githubApi.js');
  vi.doUnmock('./hosting/hostingService.js');
  vi.doUnmock('../store/stores.js');
  delete process.env.ALPHA_HOME;
  vi.resetModules();
});

describe('deleting a project’s repository', () => {
  it('removes hosting, then the repository, then the project’s link to it', async () => {
    const { service, steps, updates } = await load({ teardown: { removed: ['Render service shop-be'] } });

    const result = await service.deleteProjectRepository({ workspaceId: 'ws', project: project(), repo: REPO });

    expect(steps).toEqual([`github get /repos/${REPO}`, `hosting teardown ${REPO}`, `github delete /repos/${REPO}`, 'project update']);
    expect(updates[0].resources).toEqual([]);
    expect(result).toMatchObject({ github: 'deleted', hosting: { removed: ['Render service shop-be'] } });
  });

  it('touches nothing when the caller is not an admin of the repository', async () => {
    const { service, steps } = await load({ admin: false });

    await expect(service.deleteProjectRepository({ workspaceId: 'ws', project: project(), repo: REPO })).rejects.toMatchObject({
      status: 403,
      message: expect.stringMatching(/needs admin rights.*Nothing was deleted/)
    });
    expect(steps).toEqual([`github get /repos/${REPO}`]);
  });

  it('touches nothing when GitHub cannot find the repository', async () => {
    const { service, steps } = await load({ repoMissing: true });

    await expect(service.deleteProjectRepository({ workspaceId: 'ws', project: project(), repo: REPO })).rejects.toMatchObject({ status: 404 });
    expect(steps).toEqual([`github get /repos/${REPO}`]);
  });

  /** Removing hosting is authorized against the repository, so the repository must outlive it. */
  it('keeps the repository when any hosting could not be removed', async () => {
    const { service, steps } = await load({ teardown: { removed: ['Render service shop-be'], failed: ['Vercel project shop-be: 500'] } });

    const attempt = service.deleteProjectRepository({ workspaceId: 'ws', project: project(), repo: REPO });

    await expect(attempt).rejects.toMatchObject({ status: 502, hosting: { failed: ['Vercel project shop-be: 500'] } });
    expect(steps).not.toContain(`github delete /repos/${REPO}`);
    expect(steps).not.toContain('project update');
  });

  it('counts a repository already gone from GitHub as deleted, and still unlinks it', async () => {
    const { service, steps } = await load({ deleteStatus: 404 });

    const result = await service.deleteProjectRepository({ workspaceId: 'ws', project: project(), repo: REPO });

    expect(result.github).toBe('already_gone');
    expect(steps).toContain('project update');
  });

  it('says so when the organization refuses the delete, and leaves the link in place', async () => {
    const { service, steps } = await load({ deleteStatus: 403 });

    await expect(service.deleteProjectRepository({ workspaceId: 'ws', project: project(), repo: REPO })).rejects.toMatchObject({
      status: 403,
      message: expect.stringMatching(/only let owners delete repositories/)
    });
    expect(steps).not.toContain('project update');
  });

  it('unlinks only this repository, in any casing, and keeps every other resource', async () => {
    const { service, updates } = await load();
    const other = { id: 'r2', type: 'github_repo', pathOrUrl: 'https://github.com/acme/shop-fe' };
    const folder = { id: 'r3', type: 'local_dir', pathOrUrl: 'C:/work/shop' };

    await service.deleteProjectRepository({
      workspaceId: 'ws',
      project: project([{ id: 'r1', type: 'github_repo', pathOrUrl: 'https://github.com/ACME/Shop-BE.git' }, other, folder]),
      repo: REPO
    });

    expect(updates[0].resources).toEqual([other, folder]);
  });
});

describe('working copies on a desktop', () => {
  it('removes Alpha’s own copy and never a folder outside its workspaces', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-delete-'));
    const managed = path.join(home, 'workspaces', 'SHOP', 'shop-be');
    const outside = path.join(home, 'elsewhere', 'shop-be');
    for (const dir of [managed, outside]) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'README.md'), 'x');
    }
    try {
      const { service } = await load({ mode: 'desktop', home });

      const result = await service.deleteProjectRepository({
        workspaceId: 'ws',
        // A hand-attached localPath outside the managed root is recorded, and must survive.
        project: project([{ id: 'r1', type: 'github_repo', pathOrUrl: `https://github.com/${REPO}`, localPath: outside }]),
        repo: REPO
      });

      expect(result.localCopies.removed).toEqual([managed]);
      expect(fs.existsSync(managed)).toBe(false);
      expect(fs.existsSync(outside)).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
