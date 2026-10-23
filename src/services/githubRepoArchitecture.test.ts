import { describe, expect, it } from 'vitest';
import type { GitHubApi } from './githubApi.js';
import { getRepoArchitecture } from './githubRepoArchitecture.js';

const commit = 'abcdef0123456789abcdef0123456789abcdef01';

function fakeGitHub() {
  const calls: string[] = [];
  const api: GitHubApi = {
    async get<T>(path: string): Promise<T> {
      calls.push(path);
      if (path === '/repos/acme/shop') return { default_branch: 'main' } as T;
      if (path === '/repos/acme/shop/git/ref/heads/main') return { object: { sha: commit } } as T;
      if (path === `/repos/acme/shop/git/trees/${commit}?recursive=1`) {
        return {
          truncated: false,
          tree: [
            { path: 'README.md', type: 'blob', size: 50 },
            { path: 'package.json', type: 'blob', size: 220 },
            { path: 'prisma/schema.prisma', type: 'blob', size: 80 },
            { path: 'src/server/index.ts', type: 'blob', size: 300 },
            { path: 'src/jobs/sync.ts', type: 'blob', size: 120 },
          ],
        } as T;
      }
      if (path.includes('/contents/')) {
        const source = path.includes('package.json')
          ? JSON.stringify({ dependencies: {
              react: '^18', express: '^4', passport: '^0.7', pg: '^8', bullmq: '^5', '@octokit/rest': '^21',
            } })
          : path.includes('schema.prisma')
            ? 'datasource db { provider = "postgresql" }'
            : '# app architecture';
        return {
          type: 'file', size: source.length, encoding: 'base64',
          content: Buffer.from(source).toString('base64'),
        } as T;
      }
      throw new Error(`Unexpected GitHub path: ${path}`);
    },
    async getAll<T>(): Promise<T[]> { return []; },
    async post<T>(): Promise<T> { throw new Error('Unexpected POST'); },
    async patch<T>(): Promise<T> { throw new Error('Unexpected PATCH'); },
    async put<T>(): Promise<T> { throw new Error('Unexpected PUT'); },
    async delete(): Promise<void> { throw new Error('Unexpected DELETE'); },
  };
  return { api, calls };
}

describe('repository architecture', () => {
  it('uses the latest default-branch commit and detects connected components from manifests', async () => {
    const { api, calls } = fakeGitHub();

    const result = await getRepoArchitecture('acme/shop', api);

    expect(result).toMatchObject({ repository: 'acme/shop', branch: 'main', commit, truncated: false });
    expect(result.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'web', label: 'Web client', technology: 'React' }),
      expect.objectContaining({ id: 'api', label: 'API server', technology: 'Express' }),
      expect.objectContaining({ id: 'auth', label: 'Auth', technology: 'Passport' }),
      expect.objectContaining({ id: 'database', label: 'PostgreSQL' }),
      expect.objectContaining({ id: 'jobs', label: 'Background jobs', technology: 'BullMQ' }),
      expect.objectContaining({ id: 'integration-1', label: 'GitHub API' }),
    ]));
    expect(result.edges).toEqual(expect.arrayContaining([
      { from: 'api', to: 'auth' },
      { from: 'api', to: 'database' },
      { from: 'api', to: 'jobs' },
      { from: 'jobs', to: 'integration-1' },
    ]));
    expect(calls).toContain(`/repos/acme/shop/git/trees/${commit}?recursive=1`);
  });

  it('rejects invalid repository names before making a GitHub request', async () => {
    const { api, calls } = fakeGitHub();

    await expect(getRepoArchitecture('acme/../secrets', api)).rejects.toThrow(/owner\/name/);
    expect(calls).toEqual([]);
  });
});
