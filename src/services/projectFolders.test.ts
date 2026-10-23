import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const meta = new Map<string, string>();
const workspaces = new Map<string, { dir: string; managed: boolean }>();
vi.mock('./sqliteService.js', () => ({
  sqliteService: {
    getMetaValue: (key: string) => meta.get(key) ?? null,
    setMetaValue: (key: string, value: string | null) => (value === null ? meta.delete(key) : meta.set(key, value)),
    getProjects: () => [
      { id: 'p1', name: 'Test Project', key: 'TES' },
      { id: 'p2', name: 'Money tracker', key: 'MON' },
      { id: 'p3', name: 'money  tracker', key: 'MON2' }
    ]
  }
}));
vi.mock('./workspaceService.js', () => ({
  resolveProjectWorkspace: (_project: unknown, repo: string) => {
    const found = workspaces.get(repo);
    return found ? { ...found, repo } : null;
  }
}));
const bound: Array<{ dir: string; repo?: string }> = [];
vi.mock('./projectBindings.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./projectBindings.js')>()),
  bindProject: vi.fn(async (_project: unknown, dir: string, options: { repo?: string }) => {
    bound.push({ dir, repo: options.repo });
    return { localDir: dir, repo: options.repo };
  })
}));

import {
  codeFolder,
  folderName,
  locateProjectRepositories,
  originOf,
  projectFolder,
  projectReadRoots,
  repoOfRemote,
  setCodeFolder,
  setProjectFolder,
  useFoundCopy
} from './projectFolders.js';
import type { Project } from '../models/index.js';

const project = {
  id: 'p1', name: 'Test Project', key: 'TES',
  resources: [
    { id: 'r1', type: 'github_repo', name: 'app-be', pathOrUrl: 'https://github.com/acme/app-be' },
    { id: 'r2', type: 'github_repo', name: 'app-fe', pathOrUrl: 'https://github.com/acme/app-fe' }
  ]
} as unknown as Project;

let base: string;
const checkout = (dir: string, url: string) => {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'config'), '[core]\n\tbare = false\n[remote "upstream"]\n\turl = https://github.com/else/where.git\n[remote "origin"]\n\turl = ' + url + '\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n');
};

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-project-folders-'));
  meta.clear();
  workspaces.clear();
  bound.length = 0;
  setCodeFolder(base);
});
afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

describe('project folders', () => {
  it('names folders safely and adds the key when two projects share a name', () => {
    expect(folderName('Test Project')).toBe('Test-Project');
    expect(folderName('a/b:c?')).toBe('a-b-c-');
    expect(folderName('con')).toBe('con-project');
    expect(projectFolder(project).dir).toBe(path.join(base, 'Test-Project'));
    expect(projectFolder({ id: 'p2', name: 'Money tracker', key: 'MON' }).dir).toBe(path.join(base, 'Money-tracker-MON'));
  });

  it('uses a chosen folder, and goes back to the default when cleared', () => {
    const chosen = path.join(base, 'elsewhere');
    expect(setProjectFolder(project, chosen)).toEqual({ dir: chosen, isDefault: false });
    expect(setProjectFolder(project, null)).toEqual({ dir: path.join(base, 'Test-Project'), isDefault: true });
    expect(() => setProjectFolder(project, 'relative')).toThrow('Choose a folder');
    expect(setCodeFolder(null)).toBe(codeFolder());
  });

  it('reads a repository from https and ssh remotes, and from a worktree', () => {
    expect(repoOfRemote('https://github.com/acme/app-be.git')).toBe('acme/app-be');
    expect(repoOfRemote('git@github.com:acme/app-fe.git')).toBe('acme/app-fe');
    expect(repoOfRemote('https://gitlab.com/acme/app')).toBeNull();
    const main = path.join(base, 'main');
    checkout(main, 'git@github.com:acme/app-be.git');
    expect(originOf(main)).toBe('acme/app-be');
    const worktree = path.join(base, 'wt');
    fs.mkdirSync(path.join(main, '.git', 'worktrees', 'wt'), { recursive: true });
    fs.writeFileSync(path.join(main, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
    fs.mkdirSync(worktree);
    fs.writeFileSync(path.join(worktree, '.git'), 'gitdir: ' + path.join(main, '.git', 'worktrees', 'wt') + '\n');
    expect(originOf(worktree)).toBe('acme/app-be');
    expect(originOf(path.join(base, 'nothing'))).toBeNull();
  });

  it('reports each repository: registered elsewhere, found in the project folder, or missing', () => {
    const elsewhere = path.join(base, 'D', 'api', 'app-be');
    fs.mkdirSync(elsewhere, { recursive: true });
    workspaces.set('acme/app-be', { dir: elsewhere, managed: false });
    let report = locateProjectRepositories(project);
    expect(report.repositories.map(r => [r.repo, r.state])).toEqual([['acme/app-be', 'registered'], ['acme/app-fe', 'missing']]);
    expect(report.repositories[0].dir).toBe(elsewhere);
    expect(report.repositories[1].expectedDir).toBe(path.join(base, 'Test-Project', 'app-fe'));

    checkout(path.join(base, 'Test-Project', 'app-fe'), 'https://github.com/acme/app-fe');
    report = locateProjectRepositories(project);
    expect(report.repositories[1]).toMatchObject({ state: 'found', dir: path.join(base, 'Test-Project', 'app-fe') });
    expect(projectReadRoots(project).roots.map(root => root.name)).toEqual(['app-be', 'app-fe']);
  });

  it('does not take a folder whose origin is another repository', () => {
    checkout(path.join(base, 'Test-Project', 'app-fe'), 'https://github.com/someone/other');
    expect(locateProjectRepositories(project).repositories[1].state).toBe('missing');
  });

  it('says a registered folder has moved, and registers a found copy on request', async () => {
    workspaces.set('acme/app-be', { dir: path.join(base, 'gone'), managed: false });
    expect(locateProjectRepositories(project).repositories[0].state).toBe('moved');
    expect(projectReadRoots(project)).toMatchObject({ roots: [], missing: ['acme/app-be', 'acme/app-fe'] });

    await expect(useFoundCopy(project, 'acme/app-fe')).rejects.toThrow('No unregistered copy');
    checkout(path.join(base, 'Test-Project', 'app-fe'), 'https://github.com/acme/app-fe.git');
    await useFoundCopy(project, 'acme/app-fe');
    expect(bound).toEqual([{ dir: path.join(base, 'Test-Project', 'app-fe'), repo: 'acme/app-fe' }]);
  });
});

