import { describe, expect, it } from 'vitest';

import { GitHubApiError, type GitHubApi } from './githubApi.js';
import {
  agentBranchName,
  compareBranches,
  createAgentBranch,
  deleteAgentBranch,
  findOpenPullRequest,
  getFile,
  getTree,
  listBranches,
  listPullRequests,
  promote
} from './githubRepoWorkspace.js';

type Call = { method: string; path: string; body?: any };

/** A GitHub that answers each call from `answer` (which may throw) and records it. */
function fakeGitHub(answer: (call: Call) => unknown) {
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

const comparison = (aheadBy: number, messages: string[] = []) => ({
  status: aheadBy ? 'ahead' : 'identical',
  ahead_by: aheadBy,
  behind_by: 0,
  commits: messages.map((message, i) => ({ sha: `sha${i}abcdef`, commit: { message, author: { name: 'dev1' } } })),
  files: [{ filename: 'src/a.ts', status: 'modified', additions: 3, deletions: 1, patch: '@@ -1 +1 @@' }]
});

describe('branches', () => {
  it('names agent branches agent/<agent>/<task>, safely', () => {
    expect(agentBranchName('Senior Reviewer', 'SHOP-12-4821')).toBe('agent/senior-reviewer/shop-12-4821');
    expect(agentBranchName('squad-Web Squad!', 'CHK-7-0001')).toBe('agent/squad-web-squad/chk-7-0001');
    expect(agentBranchName('???', '')).toBe('agent/task/task');
  });

  it('marks pipeline and agent branches', async () => {
    const { api } = fakeGitHub(() => [
      { name: 'main', commit: { sha: 'a' }, protected: true },
      { name: 'dev', commit: { sha: 'b' } },
      { name: 'agent/reviewer/x', commit: { sha: 'c' } },
      { name: 'feature/y', commit: { sha: 'd' } }
    ]);

    expect(await listBranches('acme/shop', api)).toEqual([
      { name: 'main', sha: 'a', protected: true, pipeline: true, agent: false },
      { name: 'dev', sha: 'b', protected: false, pipeline: true, agent: false },
      { name: 'agent/reviewer/x', sha: 'c', protected: false, pipeline: false, agent: true },
      { name: 'feature/y', sha: 'd', protected: false, pipeline: false, agent: false }
    ]);
  });

  it('creates only agent branches, from dev by default', async () => {
    const { api, calls } = fakeGitHub(call => (call.method === 'GET' ? { object: { sha: 'dev-sha' } } : {}));

    await expect(createAgentBranch('acme/shop', 'dev', 'main', api)).rejects.toThrow(/only create "agent\/\.\.\." branches/);
    expect(calls).toEqual([]);

    const created = await createAgentBranch('acme/shop', 'agent/reviewer/fix-login', undefined, api);

    expect(created).toEqual({ name: 'agent/reviewer/fix-login', sha: 'dev-sha', from: 'dev' });
    expect(calls).toEqual([
      { method: 'GET', path: '/repos/acme/shop/git/ref/heads/dev' },
      { method: 'POST', path: '/repos/acme/shop/git/refs', body: { ref: 'refs/heads/agent/reviewer/fix-login', sha: 'dev-sha' } }
    ]);
  });

  it('says a branch already exists instead of passing GitHub’s 422 through', async () => {
    const { api } = fakeGitHub(call => {
      if (call.method === 'POST') throw new GitHubApiError('GitHub 422: Reference already exists', 422);
      return { object: { sha: 's' } };
    });

    await expect(createAgentBranch('acme/shop', 'agent/a/b', 'dev', api)).rejects.toMatchObject({ status: 409 });
  });

  it('never deletes a pipeline branch', async () => {
    const { api, calls } = fakeGitHub(() => ({}));

    await expect(deleteAgentBranch('acme/shop', 'uat', api)).rejects.toThrow(/Only "agent\/\.\.\." branches/);
    await deleteAgentBranch('acme/shop', 'agent/a/b', api);
    expect(calls).toEqual([{ method: 'DELETE', path: '/repos/acme/shop/git/refs/heads/agent%2Fa%2Fb' }]);
  });
});

describe('reading a branch', () => {
  it('lists files and folders, skipping submodules', async () => {
    const { api, calls } = fakeGitHub(() => ({
      truncated: false,
      tree: [
        { path: 'src', type: 'tree' },
        { path: 'src/a.ts', type: 'blob', size: 12 },
        { path: 'vendor/lib', type: 'commit' }
      ]
    }));

    expect(await getTree('acme/shop', 'dev', api)).toEqual({
      ref: 'dev',
      truncated: false,
      entries: [
        { path: 'src', type: 'dir' },
        { path: 'src/a.ts', type: 'file', size: 12 }
      ]
    });
    expect(calls[0].path).toBe('/repos/acme/shop/git/trees/dev?recursive=1');
  });

  it('reads a file at a branch, and refuses paths that climb out', async () => {
    const { api } = fakeGitHub(() => ({ type: 'file', size: 5, encoding: 'base64', content: Buffer.from('hello').toString('base64') }));

    expect(await getFile('acme/shop', 'src/a.ts', 'dev', api)).toEqual({
      path: 'src/a.ts',
      ref: 'dev',
      size: 5,
      content: 'hello',
      truncated: false
    });
    await expect(getFile('acme/shop', '../secrets', 'dev', api)).rejects.toThrow(/Invalid file path/);
  });

  it('does not inline a file over 1 MB', async () => {
    const { api } = fakeGitHub(() => ({ type: 'file', size: 2_000_000, content: '' }));

    expect(await getFile('acme/shop', 'big.bin', undefined, api)).toMatchObject({ content: null, truncated: true });
  });
});

describe('comparing and pull requests', () => {
  it('summarises a comparison, with diffs only when asked', async () => {
    const { api, calls } = fakeGitHub(() => comparison(1, ['feat: add cart\n\nlong body']));

    const plain = await compareBranches('acme/shop', 'main', 'dev', {}, api);
    const withPatches = await compareBranches('acme/shop', 'main', 'dev', { patches: true }, api);

    expect(calls[0].path).toBe('/repos/acme/shop/compare/main...dev');
    expect(plain).toMatchObject({ aheadBy: 1, commits: [{ message: 'feat: add cart', author: 'dev1' }] });
    expect(plain.files[0]).toEqual({ path: 'src/a.ts', status: 'modified', additions: 3, deletions: 1 });
    expect(withPatches.files[0].patch).toBe('@@ -1 +1 @@');
  });

  it('marks promotion pull requests', async () => {
    const pr = (head: string, base: string, n: number) => ({
      number: n,
      title: `t${n}`,
      html_url: `u${n}`,
      head: { ref: head },
      base: { ref: base },
      created_at: 'now'
    });
    const { api } = fakeGitHub(() => [pr('dev', 'uat', 1), pr('agent/a/b', 'dev', 2), pr('uat', 'main', 3)]);

    expect((await listPullRequests('acme/shop', 'open', api)).map(p => [p.number, p.promotion])).toEqual([
      [1, true],
      [2, false],
      [3, true]
    ]);
  });

  it('looks up an exact open pull request by owner, head, and base', async () => {
    const { api, calls } = fakeGitHub(() => [
      { number: 7, html_url: 'https://github.com/acme/shop/pull/7', head: { ref: 'alpha/orchestration/run-1' }, base: { ref: 'dev' } },
      { number: 8, html_url: 'https://github.com/acme/shop/pull/8', head: { ref: 'alpha/orchestration/run-1' }, base: { ref: 'main' } }
    ]);

    await expect(findOpenPullRequest('acme/shop', 'alpha/orchestration/run-1', 'dev', api)).resolves.toEqual({
      number: 7,
      url: 'https://github.com/acme/shop/pull/7'
    });
    expect(calls).toEqual([{
      method: 'GET',
      path: '/repos/acme/shop/pulls?state=open&head=acme%3Aalpha%2Forchestration%2Frun-1&base=dev&per_page=10'
    }]);
  });

  it('refuses unsafe branches before querying the pull request API', async () => {
    const { api, calls } = fakeGitHub(() => []);

    await expect(findOpenPullRequest('acme/shop', '../main', 'dev', api)).rejects.toThrow(/not a valid git branch/);
    expect(calls).toEqual([]);
  });
});

describe('promotion', () => {
  it('only moves dev -> uat -> main', async () => {
    const { api, calls } = fakeGitHub(() => []);

    await expect(promote('acme/shop', 'dev', 'main', api)).rejects.toThrow(/not a step/);
    await expect(promote('acme/shop', 'main', 'uat', api)).rejects.toThrow(/not a step/);
    expect(calls).toEqual([]);
  });

  it('returns the promotion already open rather than opening another', async () => {
    const { api, calls } = fakeGitHub(() => [{ number: 7, html_url: 'https://github.com/acme/shop/pull/7' }]);

    expect(await promote('acme/shop', 'dev', 'uat', api)).toEqual({
      status: 'existing',
      url: 'https://github.com/acme/shop/pull/7',
      number: 7
    });
    expect(calls[0].path).toBe('/repos/acme/shop/pulls?state=open&head=acme%3Adev&base=uat');
  });

  it('opens nothing when the source has nothing new', async () => {
    const { api, calls } = fakeGitHub(call => (call.path.includes('/compare/') ? comparison(0) : []));

    expect(await promote('acme/shop', 'uat', 'main', api)).toEqual({ status: 'nothing_to_promote' });
    expect(calls.some(call => call.method === 'POST')).toBe(false);
  });

  it('opens the promotion with the commits it carries', async () => {
    const { api, calls } = fakeGitHub(call => {
      if (call.path.includes('/compare/')) return comparison(2, ['feat: cart', 'fix: tax']);
      if (call.method === 'POST') return { number: 9, html_url: 'https://github.com/acme/shop/pull/9' };
      return [];
    });

    const result = await promote('acme/shop', 'dev', 'uat', api);

    expect(result).toEqual({ status: 'opened', url: 'https://github.com/acme/shop/pull/9', number: 9, commits: 2 });
    const post = calls.find(call => call.method === 'POST')!;
    expect(post.path).toBe('/repos/acme/shop/pulls');
    expect(post.body).toMatchObject({ title: 'Promote dev → uat', head: 'dev', base: 'uat' });
    expect(post.body.body).toContain('- feat: cart (sha0abc)');
    expect(post.body.body).toContain('- fix: tax (sha1abc)');
    // Compared the right way round: what dev has that uat does not.
    expect(calls.find(call => call.path.includes('/compare/'))!.path).toBe('/repos/acme/shop/compare/uat...dev');
  });
});
