import { describe, it, expect, afterEach } from 'vitest';

import { useGitHubApi, type GitHubApi } from './githubApi.js';
import { mergePullRequestOverApi, parsePullRequestUrl } from './githubPullRequests.js';

/**
 * Merging from the web, where there is no checkout for `gh` to run in.
 *
 * The merge is what matters; deleting the branch afterwards is tidying, and a
 * failure there must not report a merged pull request as unmerged.
 */

let calls: string[];

function fakeGitHub(over: { headRepo?: string; deleteFails?: boolean; mergeFails?: boolean } = {}): GitHubApi {
  calls = [];
  return {
    get: async (p: string) => {
      calls.push(`GET ${p}`);
      return {
        head: { ref: 'alpha/fix-cart', repo: { full_name: over.headRepo ?? 'acme/checkout' } },
        base: { repo: { full_name: 'acme/checkout' } }
      } as any;
    },
    getAll: async () => [],
    post: async () => ({}) as any,
    patch: async () => ({}) as any,
    put: async (p: string) => {
      calls.push(`PUT ${p}`);
      if (over.mergeFails) throw new Error('GitHub 405 on PUT: Required status check "ci" is expected.');
      return { message: 'Pull Request successfully merged' } as any;
    },
    delete: async (p: string) => {
      calls.push(`DELETE ${p}`);
      if (over.deleteFails) throw new Error('GitHub 422: Reference does not exist');
    }
  };
}

afterEach(() => useGitHubApi(null));

describe('mergePullRequestOverApi', () => {
  it('squash-merges and deletes the branch', async () => {
    useGitHubApi(fakeGitHub());

    const message = await mergePullRequestOverApi('https://github.com/acme/checkout/pull/12');

    expect(message).toBe('Pull Request successfully merged');
    expect(calls).toEqual([
      'GET /repos/acme/checkout/pulls/12',
      'PUT /repos/acme/checkout/pulls/12/merge',
      'DELETE /repos/acme/checkout/git/refs/heads/alpha%2Ffix-cart'
    ]);
  });

  /** A branch in a fork is its owner's, not ours to delete. */
  it('leaves a fork’s branch alone', async () => {
    useGitHubApi(fakeGitHub({ headRepo: 'someone/checkout' }));

    await mergePullRequestOverApi('https://github.com/acme/checkout/pull/12');

    expect(calls.some(c => c.startsWith('DELETE'))).toBe(false);
  });

  it('reports a merge even when the branch cannot be deleted', async () => {
    useGitHubApi(fakeGitHub({ deleteFails: true }));

    await expect(mergePullRequestOverApi('https://github.com/acme/checkout/pull/12')).resolves.toBeTruthy();
  });

  /** GitHub's reason is what the review gate shows the person approving. */
  it('fails with GitHub’s reason when the merge is refused', async () => {
    useGitHubApi(fakeGitHub({ mergeFails: true }));

    await expect(mergePullRequestOverApi('https://github.com/acme/checkout/pull/12')).rejects.toThrow(/status check/);
    expect(calls.some(c => c.startsWith('DELETE'))).toBe(false);
  });

  it('refuses anything that is not a pull request URL', async () => {
    useGitHubApi(fakeGitHub());

    await expect(mergePullRequestOverApi('https://example.com/acme/checkout/pull/12')).rejects.toThrow(/not a GitHub pull request/);
    expect(calls).toEqual([]);
  });
});

describe('parsePullRequestUrl', () => {
  it('reads the repository and number', () => {
    expect(parsePullRequestUrl('https://github.com/acme/checkout/pull/12')).toEqual({ ownerRepo: 'acme/checkout', number: 12 });
    expect(parsePullRequestUrl('https://github.com/acme/checkout/pull/12/')).toEqual({ ownerRepo: 'acme/checkout', number: 12 });
  });

  it('refuses a path that could reach another endpoint', () => {
    expect(parsePullRequestUrl('https://github.com/acme/checkout/pull/12/../../x')).toBeNull();
    expect(parsePullRequestUrl('https://github.com/acme/checkout/issues/12')).toBeNull();
  });
});
