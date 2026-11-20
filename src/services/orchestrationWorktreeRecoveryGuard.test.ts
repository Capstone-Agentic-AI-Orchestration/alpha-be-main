import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

import { preserveAndRestoreWorktree } from './orchestrationWorktreeRecovery.js';

/**
 * A build folder whose own repository is missing sits inside another repository. Git then
 * resolves it to the outer one, and restoring it used to hard-reset that outer repository:
 * a test doing exactly this wiped a developer's uncommitted work in their checkout.
 */
describe('restoring a build worktree', () => {
  let root = '';
  const previousHome = process.env.ALPHA_HOME;
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = '';
    if (previousHome === undefined) delete process.env.ALPHA_HOME; else process.env.ALPHA_HOME = previousHome;
  });

  it('refuses a folder inside another repository, and leaves that repository untouched', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-recovery-guard-'));
    process.env.ALPHA_HOME = path.join(root, 'home');
    const outer = path.join(root, 'checkout');
    fs.mkdirSync(outer);
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Alpha Test', '-c', 'user.email=alpha-test@example.invalid', ...args], { cwd: outer, stdio: 'pipe' });
    git('init');
    fs.writeFileSync(path.join(outer, 'notes.md'), 'committed\n');
    git('add', '-A');
    git('commit', '-m', 'start');
    fs.writeFileSync(path.join(outer, 'notes.md'), 'uncommitted work\n');
    const inner = path.join(outer, '.tmp-build');
    fs.mkdirSync(inner);

    await expect(preserveAndRestoreWorktree({ worktree: inner, runId: 'run-1', label: 'deliver' }))
      .rejects.toThrow(/would reset a different repository/);
    expect(fs.readFileSync(path.join(outer, 'notes.md'), 'utf8')).toBe('uncommitted work\n');
    expect(fs.existsSync(path.join(root, 'home', 'preserved'))).toBe(false);
  });

  it('still restores a folder that is its own working copy', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-recovery-own-'));
    process.env.ALPHA_HOME = path.join(root, 'home');
    const repo = path.join(root, 'build');
    fs.mkdirSync(repo);
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Alpha Test', '-c', 'user.email=alpha-test@example.invalid', ...args], { cwd: repo, stdio: 'pipe' });
    git('init');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    git('add', '-A');
    git('commit', '-m', 'start');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');

    const saved = await preserveAndRestoreWorktree({ worktree: repo, runId: 'run-1', label: 'backend' });

    expect(saved).toBeDefined();
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8').trim()).toBe('one');
  });
});
