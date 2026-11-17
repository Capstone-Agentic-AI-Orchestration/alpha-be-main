import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addBranchWorktree } from '../utils/gitUtils.js';
import { classifyRecoveryCategory } from './orchestrationRecoveryPolicy.js';
import {
  BUILD_WORKSPACE_LOST_PREFIX, checkpointRef, ensureBuildWorktree, isBuildWorkspaceLost, type CheckpointRemote
} from './orchestrationCheckpoints.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', [
  '-c', 'user.name=Alpha Test', '-c', 'user.email=alpha-test@example.invalid', ...args
], { cwd, stdio: 'pipe' }).toString().trim();

const branchName = 'alpha/orchestration/checkpointtest';

/**
 * The failure this guards against: a build's branch and commits live only in the
 * project's checkout, so deleting and re-cloning that folder disconnected the working
 * copy ("not a git repository") and destroyed the accepted work.
 */
describe('build working copy checkpoints', () => {
  let directory = '';
  afterEach(() => {
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    directory = '';
  });

  /** A project on "GitHub" (a bare repo), its checkout, and a build with one accepted checkpoint. */
  function buildWithCheckpoint() {
    directory = fs.mkdtempSync(path.join(process.cwd(), '.tmp-orchestration-checkpoints-'));
    const origin = path.join(directory, 'origin.git');
    const seed = path.join(directory, 'seed');
    git(directory, 'init', '--bare', '--initial-branch=main', origin);
    fs.mkdirSync(seed);
    git(seed, 'init', '--initial-branch=main');
    fs.writeFileSync(path.join(seed, 'README.md'), 'base\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-m', 'base');
    git(seed, 'push', origin, 'main');
    const baseCommit = git(seed, 'rev-parse', 'HEAD');

    const checkout = path.join(directory, 'project');
    git(directory, 'clone', origin, checkout);
    const worktree = path.join(directory, 'runs', 'build-be');
    return { origin, checkout, worktree, baseCommit, async start() {
      await addBranchWorktree(checkout, worktree, branchName, baseCommit);
      fs.writeFileSync(path.join(worktree, 'login.ts'), 'export const login = true;\n');
      git(worktree, 'add', '-A');
      git(worktree, 'commit', '-m', 'accepted task');
      return git(worktree, 'rev-parse', 'HEAD');
    } };
  }

  /** What GitHub does for the real remote, against the local bare repo. */
  const remoteFor = (origin: string): CheckpointRemote => ({
    async push(cwd, _repository, commit, ref) { git(cwd, 'push', origin, `+${commit}:${ref}`); },
    async fetch(cwd, _repository, ref) { git(cwd, 'fetch', '--no-tags', origin, `+${ref}:${ref}`); }
  });

  /** Delete the project folder and clone it again, as happened to the reported build. */
  function reclone(origin: string, checkout: string) {
    fs.rmSync(checkout, { recursive: true, force: true });
    git(path.dirname(checkout), 'clone', origin, checkout);
  }

  it('leaves a connected working copy alone', async () => {
    const fixture = buildWithCheckpoint();
    const commit = await fixture.start();
    await expect(ensureBuildWorktree({ checkoutDir: fixture.checkout, worktreePath: fixture.worktree, branchName,
      repository: 'org/api', expectedCommit: commit, runId: 'run-1', alphaDir: directory })).resolves.toEqual({ status: 'connected' });
  });

  it('rebuilds a working copy from its GitHub backup after the project folder is re-cloned', async () => {
    const fixture = buildWithCheckpoint();
    const commit = await fixture.start();
    const remote = remoteFor(fixture.origin);
    await remote.push(fixture.worktree, 'org/api', commit, checkpointRef(branchName));
    reclone(fixture.origin, fixture.checkout);
    expect(() => git(fixture.worktree, 'status')).toThrow(/not a git repository/);

    const result = await ensureBuildWorktree({ checkoutDir: fixture.checkout, worktreePath: fixture.worktree, branchName,
      repository: 'org/api', expectedCommit: commit, runId: 'run-1', remote, alphaDir: directory });

    expect(result).toMatchObject({ status: 'rebuilt', commit });
    expect(git(fixture.worktree, 'rev-parse', 'HEAD')).toBe(commit);
    expect(git(fixture.worktree, 'branch', '--show-current')).toBe(branchName);
    expect(git(fixture.worktree, 'status', '--porcelain')).toBe('');
    expect(fs.readFileSync(path.join(fixture.worktree, 'login.ts'), 'utf8')).toContain('login');
    // The disconnected folder is kept, not deleted.
    expect(result.status === 'rebuilt' && result.preservedFolder && fs.existsSync(path.join(result.preservedFolder, 'login.ts'))).toBe(true);
  });

  it('rebuilds at the base commit when no task was accepted yet', async () => {
    const fixture = buildWithCheckpoint();
    await addBranchWorktree(fixture.checkout, fixture.worktree, branchName, fixture.baseCommit);
    reclone(fixture.origin, fixture.checkout);
    const result = await ensureBuildWorktree({ checkoutDir: fixture.checkout, worktreePath: fixture.worktree, branchName,
      repository: 'org/api', expectedCommit: fixture.baseCommit, runId: 'run-1', remote: remoteFor(fixture.origin), alphaDir: directory });
    expect(result).toMatchObject({ status: 'rebuilt', commit: fixture.baseCommit });
  });

  it('stops with a plain reason, not a retry, when the checkpoint was never backed up', async () => {
    const fixture = buildWithCheckpoint();
    const commit = await fixture.start();
    reclone(fixture.origin, fixture.checkout);

    const attempt = ensureBuildWorktree({ checkoutDir: fixture.checkout, worktreePath: fixture.worktree, branchName,
      repository: 'org/api', expectedCommit: commit, runId: 'run-1', remote: remoteFor(fixture.origin), alphaDir: directory });

    await expect(attempt).rejects.toThrow(BUILD_WORKSPACE_LOST_PREFIX);
    await expect(attempt).rejects.toThrow(/deleted and cloned again/);
    // Nothing is moved or removed when the build cannot be rebuilt.
    expect(fs.existsSync(path.join(fixture.worktree, 'login.ts'))).toBe(true);
  });

  it('classifies a lost working copy as a workspace problem', () => {
    const reason = `${BUILD_WORKSPACE_LOST_PREFIX} The org/api working copy is no longer connected.`;
    expect(isBuildWorkspaceLost(reason)).toBe(true);
    expect(classifyRecoveryCategory({ reason, hasTask: false, hasReportError: false, finalValidation: false })).toBe('workspace');
  });

  it('only accepts hidden checkpoint refs under refs/alpha-checkpoints', () => {
    expect(checkpointRef(branchName)).toBe('refs/alpha-checkpoints/alpha/orchestration/checkpointtest');
    expect(() => checkpointRef('../escape')).toThrow();
  });
});
