import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { addBranchWorktree, addDetachedWorktree, createBranch, createBranchFrom, getGitChangedPaths, getHeadCommit, remoteHasDevBranch, removeDetachedWorktree } from './gitUtils.js';

/**
 * Where an agent's branch starts, against real git: a bare "remote" and a
 * clone of it, the way a provisioned repository and its working copy relate.
 */

let root: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' }).toString().trim();

function repoWithRemote(branches: string[]): { remote: string; clone: string } {
  const remote = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  const clone = path.join(root, 'clone');
  git(root, 'init', '--bare', '--initial-branch', 'main', remote);
  git(root, 'init', '--initial-branch', 'main', seed);
  fs.writeFileSync(path.join(seed, 'README.md'), 'main\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-m', 'first');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-q', 'origin', 'main');
  for (const branch of branches) {
    git(seed, 'checkout', '-q', '-b', branch, 'main');
    fs.writeFileSync(path.join(seed, `${branch}.txt`), `${branch}\n`);
    git(seed, 'add', '-A');
    git(seed, 'commit', '-m', `on ${branch}`);
    git(seed, 'push', '-q', 'origin', branch);
  }
  git(root, 'clone', '-q', remote, clone);
  return { remote, clone };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-gitutils-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('the branch an agent starts from', () => {
  it('knows a repository with the dev -> uat -> main pipeline', async () => {
    const { clone } = repoWithRemote(['dev', 'uat']);

    expect(await remoteHasDevBranch(clone)).toBe(true);
  });

  it('keeps the older behaviour for a repository without dev', async () => {
    const { clone } = repoWithRemote([]);

    expect(await remoteHasDevBranch(clone)).toBe(false);
  });

  it('answers no, rather than throwing, when there is no remote at all', async () => {
    const lone = path.join(root, 'lone');
    git(root, 'init', '--initial-branch', 'main', lone);

    expect(await remoteHasDevBranch(lone)).toBe(false);
  });

  /** From what the team integrated, not from wherever the checkout was left. */
  it('starts the agent branch at origin/dev, even from a checkout sitting on main', async () => {
    const { clone } = repoWithRemote(['dev']);
    expect(git(clone, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');

    await createBranchFrom(clone, 'agent/reviewer/shop-1-0001', 'dev');

    expect(git(clone, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('agent/reviewer/shop-1-0001');
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(git(clone, 'rev-parse', 'origin/dev'));
    expect(fs.existsSync(path.join(clone, 'dev.txt'))).toBe(true);
  });

  it('runs in an isolated worktree without changing a dirty source checkout', async () => {
    const clone = path.join(root, 'source');
    fs.mkdirSync(clone, { recursive: true });
    git(clone, 'init', '--initial-branch', 'main');
    fs.writeFileSync(path.join(clone, 'README.md'), 'source\n');
    git(clone, 'add', '-A');
    git(clone, 'commit', '-m', 'first');
    const sourceBranch = git(clone, 'rev-parse', '--abbrev-ref', 'HEAD');
    fs.writeFileSync(path.join(clone, 'my-unsaved-work.txt'), 'keep this local\n');
    const sourceStatus = git(clone, 'status', '--porcelain', '--untracked-files=all');
    const workingDir = path.join(root, 'isolated-run');

    await addDetachedWorktree(clone, workingDir);
    await createBranch(workingDir, 'agent/build/test-0001');
    fs.writeFileSync(path.join(workingDir, 'agent-output.txt'), 'build output\n');

    expect(git(clone, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(sourceBranch);
    expect(git(clone, 'status', '--porcelain', '--untracked-files=all')).toBe(sourceStatus);
    expect(fs.existsSync(path.join(clone, 'my-unsaved-work.txt'))).toBe(true);
    expect(fs.existsSync(path.join(workingDir, 'agent-output.txt'))).toBe(true);

    await removeDetachedWorktree(clone, workingDir);
    expect(fs.existsSync(workingDir)).toBe(false);
  });

  it('creates a named task branch in the private worktree without moving the source checkout', async () => {
    const source = path.join(root, 'task-source');
    fs.mkdirSync(source, { recursive: true });
    git(source, 'init', '--initial-branch', 'main');
    fs.writeFileSync(path.join(source, 'README.md'), 'baseline\n');
    git(source, 'add', '-A');
    git(source, 'commit', '-m', 'baseline');
    fs.writeFileSync(path.join(source, 'uncommitted.txt'), 'leave me alone\n');
    const sourceHead = git(source, 'rev-parse', 'HEAD');
    const sourceStatus = git(source, 'status', '--porcelain', '--untracked-files=all');
    const workingDir = path.join(root, 'task-worktree');

    await addBranchWorktree(source, workingDir, 'alpha/orchestration/test-run');

    expect(await getHeadCommit(workingDir)).toBe(sourceHead);
    expect(git(workingDir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('alpha/orchestration/test-run');
    expect(git(source, 'rev-parse', 'HEAD')).toBe(sourceHead);
    expect(git(source, 'status', '--porcelain', '--untracked-files=all')).toBe(sourceStatus);
    await removeDetachedWorktree(source, workingDir);
  });

  it('reports committed added, changed, and deleted paths between checkpoint commits', async () => {
    const repo = path.join(root, 'changed-paths');
    fs.mkdirSync(repo, { recursive: true });
    git(repo, 'init', '--initial-branch', 'main');
    fs.writeFileSync(path.join(repo, 'keep.txt'), 'before\n');
    fs.writeFileSync(path.join(repo, 'delete.txt'), 'remove\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'baseline');
    const baseCommit = git(repo, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo, 'keep.txt'), 'after\n');
    fs.writeFileSync(path.join(repo, 'new.txt'), 'new\n');
    fs.rmSync(path.join(repo, 'delete.txt'));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'task result');
    const resultCommit = git(repo, 'rev-parse', 'HEAD');

    expect(await getGitChangedPaths(repo, baseCommit, resultCommit)).toEqual(['delete.txt', 'keep.txt', 'new.txt']);
  });

  it('refuses an unsafe branch name before running git', async () => {
    const { clone } = repoWithRemote(['dev']);

    await expect(createBranchFrom(clone, '-x', 'dev')).rejects.toThrow();
    await expect(createBranchFrom(clone, 'agent/a', '../dev')).rejects.toThrow();
  });
});
