import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isGitRepo } from '../utils/gitUtils.js';
import { previewSourceUnavailable } from './localPreviewService.js';
import { BUILD_WORKSPACE_LOST_PREFIX, lostReviewedWorkingCopy } from './orchestrationCheckpoints.js';

/**
 * A build's working copy is a git worktree whose history lives in the project checkout.
 * When that checkout is deleted (or re-cloned), the worktree folder stays behind and still
 * exists on disk, but git can no longer open it. This builds that situation with real git,
 * so the guards are checked against what actually happens on a person's machine.
 */
let root: string;

function orphanedWorktree(): { checkout: string; worktree: string; commit: string } {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-orphan-'));
  const checkout = path.join(root, 'project', 'e-commerce-fe');
  const worktree = path.join(root, 'runs', 'build-1');
  fs.mkdirSync(checkout, { recursive: true });
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git(checkout, 'init', '-q');
  git(checkout, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'start');
  git(checkout, 'worktree', 'add', '-q', '--detach', worktree, 'HEAD');
  const commit = git(worktree, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(worktree, 'storefront.ts'), 'export const built = true;\n');
  // The project folder is deleted; the build's folder is left behind.
  fs.rmSync(path.join(root, 'project'), { recursive: true, force: true });
  return { checkout, worktree, commit };
}

afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

describe('a build working copy whose project checkout was deleted', () => {
  it('still exists on disk, so an existence check alone would let it through', () => {
    const { worktree } = orphanedWorktree();
    expect(fs.existsSync(worktree)).toBe(true);
    expect(fs.existsSync(path.join(worktree, 'storefront.ts'))).toBe(true);
  });

  it('is not a git repository, which is what the preview now checks before running git', async () => {
    const { worktree } = orphanedWorktree();
    expect(await isGitRepo(worktree)).toBe(false);
  });

  it('is reported as lost for review, with no repair possible', async () => {
    const { checkout, worktree, commit } = orphanedWorktree();
    const reason = await lostReviewedWorkingCopy({ repository: 'org/e-commerce-fe', worktreePath: worktree, checkoutDir: checkout, reviewedCommit: commit });
    expect(reason?.startsWith(BUILD_WORKSPACE_LOST_PREFIX)).toBe(true);
  });

  it('gives the preview a reason a person can act on, not git\'s own error', () => {
    const saved = previewSourceUnavailable('org/e-commerce-fe', true);
    expect(saved).toContain('org/e-commerce-fe');
    expect(saved).toContain('deleted or cloned again');
    expect(saved).toContain('plan a new build');
    expect(saved).not.toMatch(/fatal|rev-parse|worktrees/);
    const checkout = previewSourceUnavailable('org/e-commerce-fe', false);
    expect(checkout).toContain('not a git repository any more');
    expect(checkout).toContain('Clone the repository again');
  });
});
