import { describe, expect, it } from 'vitest';

import { GitHubApiError, type GitHubApi } from './githubApi.js';
import { provisionRepository } from './githubRepoProvisioning.js';

/**
 * Provisioning a repository through the Git Data API.
 *
 * The whole history is one commit, on dev, uat and main alike, made the same
 * way from the cloud as from a desktop -- the cloud used to create an empty
 * repository and drop the files.
 */

type Call = { method: string; path: string; body?: any };

/** A GitHub that records every call and answers from `answer`, which may throw. */
function fakeGitHub(answer: (call: Call) => unknown = () => ({})) {
  const calls: Call[] = [];
  const record = async (method: string, path: string, body?: unknown) => {
    const call = { method, path, ...(body === undefined ? {} : { body }) };
    calls.push(call);
    return answer(call);
  };
  const api: GitHubApi = {
    get: (path: string) => record('GET', path) as any,
    getAll: (path: string) => record('GET', path) as any,
    post: (path: string, body: unknown) => record('POST', path, body) as any,
    patch: (path: string, body: unknown) => record('PATCH', path, body) as any,
    put: (path: string, body: unknown) => record('PUT', path, body) as any,
    delete: async (path: string) => {
      await record('DELETE', path);
    }
  };
  return { api, calls };
}

/** GitHub's answers for a normal provisioning run. */
function github(overrides: (call: Call) => unknown = () => undefined) {
  return fakeGitHub(call => {
    const override = overrides(call);
    if (override !== undefined) return override;
    if (call.method === 'POST' && call.path === '/orgs/acme/repos') {
      return { html_url: 'https://github.com/acme/shop', full_name: 'acme/shop', default_branch: 'main' };
    }
    if (call.method === 'GET' && call.path.includes('/git/ref/heads/')) return { object: { sha: 'init-sha' } };
    if (call.path.endsWith('/git/trees')) return { sha: 'tree-sha' };
    if (call.path.endsWith('/git/commits')) return { sha: 'commit-sha' };
    return {};
  });
}

const files = [
  { path: 'README.md', content: '# shop\n' },
  { path: 'src/index.ts', content: 'export {};\n' },
  { path: 'scripts/setup.sh', content: '#!/bin/sh\n', executable: true }
];

describe('provisioning a repository', () => {
  it('makes the whole history one commit, on dev, uat and main', async () => {
    const { api, calls } = github();

    const result = await provisionRepository({ org: 'acme', name: 'shop', files, message: 'chore: scaffold shop' }, api);

    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/orgs/acme/repos',
      body: { name: 'shop', private: true, auto_init: true }
    });
    // Every file in a single tree request, inline, the script executable.
    const tree = calls.find(call => call.path === '/repos/acme/shop/git/trees');
    expect(tree?.body.tree).toEqual([
      { path: 'README.md', mode: '100644', type: 'blob', content: '# shop\n' },
      { path: 'src/index.ts', mode: '100644', type: 'blob', content: 'export {};\n' },
      { path: 'scripts/setup.sh', mode: '100755', type: 'blob', content: '#!/bin/sh\n' }
    ]);
    // No parent: GitHub's placeholder commit is not part of the history.
    expect(calls.find(call => call.path === '/repos/acme/shop/git/commits')?.body).toEqual({
      message: 'chore: scaffold shop',
      tree: 'tree-sha',
      parents: []
    });
    expect(calls).toContainEqual({
      method: 'PATCH',
      path: '/repos/acme/shop/git/refs/heads/main',
      body: { sha: 'commit-sha', force: true }
    });
    for (const branch of ['dev', 'uat']) {
      expect(calls).toContainEqual({
        method: 'POST',
        path: '/repos/acme/shop/git/refs',
        body: { ref: `refs/heads/${branch}`, sha: 'commit-sha' }
      });
    }
    expect(result).toEqual({
      url: 'https://github.com/acme/shop',
      nameWithOwner: 'acme/shop',
      commitSha: 'commit-sha',
      branches: ['dev', 'uat', 'main'],
      protectedBranches: ['uat', 'main']
    });
    expect(calls.filter(call => call.path.endsWith('/protection')).map(call => call.path)).toEqual([
      '/repos/acme/shop/branches/uat/protection',
      '/repos/acme/shop/branches/main/protection'
    ]);
  });

  /** The organisation's free plan: GitHub will not protect a private repository. */
  it('still provisions when GitHub will not protect the branches, and says why', async () => {
    const { api } = github(call => {
      if (call.path.endsWith('/protection')) {
        throw new GitHubApiError(
          'GitHub 403 on PUT /repos/acme/shop/branches/uat/protection: Upgrade to GitHub Pro or make this repository public to enable this feature.',
          403
        );
      }
      return undefined;
    });

    const result = await provisionRepository({ org: 'acme', name: 'shop', files, message: 'm' }, api);

    expect(result.protectedBranches).toEqual([]);
    expect(result.protectionUnavailable).toBe(
      'Upgrade to GitHub Pro or make this repository public to enable this feature.'
    );
    expect(result.branches).toEqual(['dev', 'uat', 'main']);
  });

  it('deletes the repository again when a later step fails', async () => {
    const { api, calls } = github(call => {
      if (call.path.endsWith('/git/trees')) throw new GitHubApiError('GitHub 422 on POST tree: bad path', 422);
      return undefined;
    });

    await expect(provisionRepository({ org: 'acme', name: 'shop', files, message: 'm' }, api)).rejects.toThrow(
      /bad path/
    );
    expect(calls.at(-1)).toEqual({ method: 'DELETE', path: '/repos/acme/shop' });
  });

  it('waits for a just-created repository whose first ref is not readable yet', async () => {
    let reads = 0;
    const { api, calls } = github(call => {
      if (call.method === 'GET' && call.path.includes('/git/ref/heads/')) {
        reads += 1;
        if (reads < 3) throw new GitHubApiError('GitHub 409 on GET ref: Git Repository is empty.', 409);
      }
      return undefined;
    });

    const result = await provisionRepository({ org: 'acme', name: 'shop', files, message: 'm' }, api);

    expect(result.commitSha).toBe('commit-sha');
    expect(calls.filter(call => call.method === 'GET').length).toBe(3);
  });

  it('makes main the default when the organisation starts repositories on another branch', async () => {
    const { api, calls } = github(call => {
      if (call.method === 'POST' && call.path === '/orgs/acme/repos') {
        return { html_url: 'https://github.com/acme/shop', full_name: 'acme/shop', default_branch: 'master' };
      }
      return undefined;
    });

    await provisionRepository({ org: 'acme', name: 'shop', files, message: 'm' }, api);

    expect(calls).toContainEqual({
      method: 'POST',
      path: '/repos/acme/shop/git/refs',
      body: { ref: 'refs/heads/main', sha: 'commit-sha' }
    });
    expect(calls).toContainEqual({ method: 'PATCH', path: '/repos/acme/shop', body: { default_branch: 'main' } });
    expect(calls).toContainEqual({ method: 'DELETE', path: '/repos/acme/shop/git/refs/heads/master' });
  });

  it('refuses to provision outside an organization, or with nothing to commit', async () => {
    const { api, calls } = github();

    await expect(provisionRepository({ org: ' ', name: 'shop', files, message: 'm' }, api)).rejects.toThrow(
      /organization is required/
    );
    await expect(provisionRepository({ org: 'acme', name: 'shop', files: [], message: 'm' }, api)).rejects.toThrow(
      /at least one file/
    );
    expect(calls).toEqual([]);
  });
});
