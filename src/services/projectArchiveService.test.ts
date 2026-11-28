import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Archiving a project's repositories on GitHub: what is asked of GitHub, and
 * that a repository GitHub refuses never stops the project or the others.
 */

const project = {
  id: 'p1', key: 'SHOP', name: 'Shop',
  resources: ['acme/shop-be', 'acme/shop-fe', 'acme/gone'].map((repo, i) => ({ id: `r${i}`, type: 'github_repo', pathOrUrl: `https://github.com/${repo}` })),
} as any;

async function load(repos: Record<string, { archived?: boolean; admin?: boolean } | 'missing'>) {
  vi.resetModules();
  const calls: string[] = [];
  const stored: any[] = [];
  vi.doMock('./githubApi.js', async () => {
    const actual = await vi.importActual<typeof import('./githubApi.js')>('./githubApi.js');
    return {
      ...actual,
      githubApi: () => ({
        get: async (path: string) => {
          const repo = repos[path.replace('/repos/', '')];
          if (!repo || repo === 'missing') throw new actual.GitHubApiError('Not Found', 404);
          return { archived: repo.archived ?? false, permissions: { admin: repo.admin ?? true } };
        },
        patch: async (path: string, body: any) => { calls.push(`patch ${path} ${body.archived}`); return {}; },
      }),
    };
  });
  vi.doMock('../store/stores.js', () => ({
    projectStore: () => ({
      setArchived: async (_ws: string, id: string, archive: any) => {
        stored.push(archive);
        return { ...project, id, archivedAt: archive?.at, archivedBy: archive?.by };
      },
    }),
  }));
  return { ...(await import('./projectArchiveService.js')), calls, stored };
}

afterEach(() => { vi.resetModules(); vi.restoreAllMocks(); });

describe('archiving a project', () => {
  it('archives each repository it may, reports the rest, and archives the project anyway', async () => {
    const { archiveProject, calls, stored } = await load({
      'acme/shop-be': { archived: false },
      'acme/shop-fe': { archived: false, admin: false },
      'acme/gone': 'missing',
    });
    const result = await archiveProject({ workspaceId: 'ws', project, by: 'PM1' });
    expect(calls).toEqual(['patch /repos/acme/shop-be true']);
    expect(result.repositories.map(r => [r.repo, r.state])).toEqual([
      ['acme/shop-be', 'archived'], ['acme/shop-fe', 'failed'], ['acme/gone', 'not_found'],
    ]);
    expect(result.repositories[1].error).toContain('admin rights');
    expect(stored[0]).toMatchObject({ by: 'PM1' });
    expect(result.project.archivedAt).toBeTruthy();
  });

  it('restores by unarchiving, leaving active repositories alone', async () => {
    const { restoreProject, calls, stored } = await load({
      'acme/shop-be': { archived: true }, 'acme/shop-fe': { archived: false }, 'acme/gone': 'missing',
    });
    const result = await restoreProject({ workspaceId: 'ws', project: { ...project, archivedAt: '2026-11-28T00:00:00.000Z' } });
    expect(calls).toEqual(['patch /repos/acme/shop-be false']);
    expect(result.repositories.map(r => r.state)).toEqual(['restored', 'already_active', 'not_found']);
    expect(stored).toEqual([null]);
  });
});
