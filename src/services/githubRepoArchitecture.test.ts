import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GitHubApi } from './githubApi.js';
import { getRepoArchitecture } from './githubRepoArchitecture.js';

const commitA = 'abcdef0123456789abcdef0123456789abcdef01';
const commitB = '1234567890abcdef1234567890abcdef12345678';
const temporaryRoots: string[] = [];

function makeCacheRoot(): string {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.architecture-test-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fakeGitHub(commit = commitA) {
  const calls: string[] = [];
  const files: Record<string, string> = {
    'README.md': '# Shop\\nA small application.',
    'package.json': JSON.stringify({ dependencies: { express: '1', react: '1' } }),
    'src/server/index.ts': 'import { routes } from \"./routes\";\\nexport { routes };',
    'src/server/routes.ts': 'import { getOrders } from \"../orders/service\";',
    'src/orders/service.ts': 'import { db } from \"../db/client\";',
    'src/db/client.ts': 'export const db = createDatabase();',
    'src/jobs/sync.ts': 'import { db } from \"../db/client\";'
  };
  const tree = [
    ...Object.keys(files).map(filePath => ({ path: filePath, type: 'blob', size: files[filePath]!.length })),
    { path: '.env', type: 'blob', size: 30 },
    { path: 'node_modules/react/index.js', type: 'blob', size: 100 }
  ];
  const api: GitHubApi = {
    async get<T>(requestPath: string): Promise<T> {
      calls.push(requestPath);
      if (requestPath === '/repos/acme/shop') return { default_branch: 'main' } as T;
      if (requestPath === '/repos/acme/shop/git/ref/heads/main') return { object: { sha: commit } } as T;
      if (requestPath === '/repos/acme/shop/git/trees/' + commit + '?recursive=1') {
        return { truncated: false, tree } as T;
      }
      if (requestPath.startsWith('/repos/acme/shop/contents/')) {
        const filePath = decodeURIComponent(requestPath.slice('/repos/acme/shop/contents/'.length).split('?')[0]!);
        const content = files[filePath];
        if (content === undefined) throw new Error('Unexpected file ' + filePath);
        return {
          type: 'file',
          size: content.length,
          encoding: 'base64',
          content: Buffer.from(content).toString('base64')
        } as T;
      }
      throw new Error('Unexpected GitHub path: ' + requestPath);
    },
    async getAll<T>(): Promise<T[]> { return []; },
    async post<T>(): Promise<T> { throw new Error('Unexpected POST'); },
    async patch<T>(): Promise<T> { throw new Error('Unexpected PATCH'); },
    async put<T>(): Promise<T> { throw new Error('Unexpected PUT'); },
    async delete(): Promise<void> { throw new Error('Unexpected DELETE'); }
  };
  return { api, calls };
}

const graph = JSON.stringify({
  nodes: [
    { id: 'web', label: 'Web client', kind: 'web', technology: 'React', path: 'src/server' },
    { id: 'api', label: 'API server', kind: 'api', technology: 'Express', path: 'src/server' },
    { id: 'orders', label: 'Order services', kind: 'module', details: 'Business logic', path: 'src/orders' },
    { id: 'database', label: 'Database', kind: 'database', technology: 'PostgreSQL', path: 'src/db' },
    { id: 'jobs', label: 'Sync worker', kind: 'jobs', path: 'src/jobs' }
  ],
  edges: [
    { from: 'web', to: 'api' },
    { from: 'api', to: 'orders' },
    { from: 'orders', to: 'database' },
    { from: 'jobs', to: 'database' }
  ]
});

describe('repository architecture', () => {
  it('generates a grounded component graph from the latest default-branch commit', async () => {
    const { api, calls } = fakeGitHub();
    const generate = async (_repo: string, files: Array<{ path: string; content: string }>) => {
      expect(files.map(file => file.path)).toContain('src/orders/service.ts');
      expect(files.map(file => file.path)).not.toContain('.env');
      return graph;
    };

    const result = await getRepoArchitecture('acme/shop', api, { cacheRoot: makeCacheRoot(), generate });

    expect(result).toMatchObject({ repository: 'acme/shop', branch: 'main', commit: commitA, truncated: false });
    expect(result.nodes).toHaveLength(5);
    expect(result.nodes).toContainEqual(expect.objectContaining({ id: 'orders', kind: 'module', path: 'src/orders' }));
    expect(result.edges).toContainEqual({ from: 'orders', to: 'database' });
    expect(calls).toContain('/repos/acme/shop/git/trees/' + commitA + '?recursive=1');
  });

  it('reuses the saved graph for the same repository commit without calling the model again', async () => {
    const cacheRoot = makeCacheRoot();
    const { api, calls } = fakeGitHub();
    let generations = 0;
    const generate = async () => { generations += 1; return graph; };

    await getRepoArchitecture('acme/shop', api, { cacheRoot, generate });
    const second = await getRepoArchitecture('acme/shop', api, { cacheRoot, generate });

    expect(generations).toBe(1);
    expect(second.commit).toBe(commitA);
    expect(calls.filter(call => call.includes('/git/trees/'))).toHaveLength(1);
  });

  it('generates a fresh graph when the default-branch commit changes', async () => {
    const cacheRoot = makeCacheRoot();
    let generations = 0;
    const generate = async () => { generations += 1; return graph; };

    await getRepoArchitecture('acme/shop', fakeGitHub(commitA).api, { cacheRoot, generate });
    const latest = await getRepoArchitecture('acme/shop', fakeGitHub(commitB).api, { cacheRoot, generate });

    expect(generations).toBe(2);
    expect(latest.commit).toBe(commitB);
  });

  it('rejects invalid repository names before making a GitHub request', async () => {
    const { api, calls } = fakeGitHub();

    await expect(getRepoArchitecture('acme/../secrets', api, { cacheRoot: makeCacheRoot(), generate: async () => graph }))
      .rejects.toThrow(/owner\/name/);
    expect(calls).toEqual([]);
  });
});
