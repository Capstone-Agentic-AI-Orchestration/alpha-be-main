import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { OrchestrationSnapshot } from './orchestrationStateMachine.js';
import { preserveAndRestoreWorktree, worktreeChangesHash } from './orchestrationWorktreeRecovery.js';
import { listSavedArchives, restoreSavedArchive } from './orchestrationSavedArchives.js';

describe('inspected same-task archive restoration', () => {
  let root = ''; const previousHome = process.env.ALPHA_HOME;
  afterEach(() => { if (previousHome === undefined) delete process.env.ALPHA_HOME; else process.env.ALPHA_HOME = previousHome; if (root) fs.rmSync(root, { recursive: true, force: true }); root = ''; });
  async function fixture() {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-archive-review-')); const cwd = path.join(root, 'worktree'); fs.mkdirSync(cwd);
    process.env.ALPHA_HOME = path.join(root, 'profile');
    const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    git('init', '-b', 'main'); fs.mkdirSync(path.join(cwd, 'src')); fs.writeFileSync(path.join(cwd, 'src', 'app.ts'), 'base\n'); git('add', '.'); git('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-m', 'base');
    const baseCommit = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(cwd, 'src', 'app.ts'), 'candidate endpoint\n'); fs.writeFileSync(path.join(cwd, 'src', 'email.ts'), 'candidate delivery\n');
    const before = await worktreeChangesHash(cwd);
    await preserveAndRestoreWorktree({ worktree: cwd, runId: 'run-one', label: 'backend' });
    const task = { id: 'backend', repository: 'acme/app', status: 'failed', scope: { includePaths: ['src/**'], excludePaths: [] } };
    const snapshot = { run: { id: 'run-one', repository: 'acme/app', plan: { tasks: [task] }, repositoryWorkspaces: [{ repository: 'acme/app', worktreePath: cwd, branchName: 'main', baseCommit }] }, tasks: [task], attempts: [] } as unknown as OrchestrationSnapshot;
    const saved = listSavedArchives(snapshot, snapshot.tasks[0])[0];
    return { cwd, snapshot, task: snapshot.tasks[0], saved, before, git };
  }
  it('restores inspected tracked and untracked candidates, retaining the original archive', async () => {
    const { cwd, snapshot, task, saved, before } = await fixture();
    expect(saved.files).toContain('untracked/src/email.ts'); expect(saved.patch).toContain('candidate endpoint');
    const restored = await restoreSavedArchive(snapshot, task, { archiveId: saved.id, archiveHash: saved.hash, candidateHash: await worktreeChangesHash(cwd) });
    expect(restored).toBe(before); expect(fs.readFileSync(path.join(cwd, 'src', 'email.ts'), 'utf8')).toContain('candidate delivery');
    expect(listSavedArchives(snapshot, task)[0].hash).toBe(saved.hash);
  });
  it('refuses a changed candidate, wrong task scope, archive hash or base without changing files', async () => {
    const { cwd, snapshot, task, saved, git } = await fixture();
    const clean = await worktreeChangesHash(cwd);
    await expect(restoreSavedArchive(snapshot, task, { archiveId: saved.id, archiveHash: 'bad', candidateHash: clean })).rejects.toThrow(/changed/);
    fs.appendFileSync(path.join(cwd, 'src', 'app.ts'), 'new edit');
    await expect(restoreSavedArchive(snapshot, task, { archiveId: saved.id, archiveHash: saved.hash, candidateHash: clean })).rejects.toThrow(/changed/);
    git('restore', 'src/app.ts');
    task.scope.excludePaths = ['src/**']; expect(listSavedArchives(snapshot, task)).toHaveLength(0); task.scope.excludePaths = [];
    task.scope.includePaths = ['src/**']; snapshot.run.repositoryWorkspaces![0].baseCommit = 'a'.repeat(40);
    await expect(restoreSavedArchive(snapshot, task, { archiveId: saved.id, archiveHash: saved.hash, candidateHash: clean })).rejects.toThrow(/checkpoint/);
    expect(fs.existsSync(path.join(cwd, 'src', 'email.ts'))).toBe(false);
  });
});

describe('saved work with ordinary dot files and unusual names', () => {
  it('reads every name in numstat -z output, including both names of a rename', async () => {
    const { numstatPaths } = await import('./orchestrationSavedArchives.js');
    expect(numstatPaths('1\t0\t.github/workflows/ci.yml\x002\t1\tsrc/café.ts\x000\t0\t\x00src/old name.ts\x00src/new name.ts\x00'))
      .toEqual(['.github/workflows/ci.yml', 'src/café.ts', 'src/old name.ts', 'src/new name.ts']);
  });

  it('restores .github and .gitignore files a task may write, but never the .git folder', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-archive-dotfiles-'));
    const previousHome = process.env.ALPHA_HOME;
    try {
      const cwd = path.join(root, 'worktree'); fs.mkdirSync(cwd);
      process.env.ALPHA_HOME = path.join(root, 'profile');
      const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
      git('init', '-b', 'main'); fs.writeFileSync(path.join(cwd, 'README.md'), 'base\n'); git('add', '.'); git('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-m', 'base');
      const baseCommit = git('rev-parse', 'HEAD');
      fs.mkdirSync(path.join(cwd, '.github', 'workflows'), { recursive: true });
      fs.writeFileSync(path.join(cwd, '.github', 'workflows', 'ci.yml'), 'on: push\n');
      fs.writeFileSync(path.join(cwd, '.gitignore'), 'dist\n');
      await preserveAndRestoreWorktree({ worktree: cwd, runId: 'run-dot', label: 'ci' });
      const task = { id: 'ci', repository: 'acme/app', status: 'failed', scope: { includePaths: ['.github/**', '.gitignore'], excludePaths: [] } };
      const snapshot = { run: { id: 'run-dot', repository: 'acme/app', plan: { tasks: [task] }, repositoryWorkspaces: [{ repository: 'acme/app', worktreePath: cwd, branchName: 'main', baseCommit }] }, tasks: [task], attempts: [] } as unknown as OrchestrationSnapshot;
      const saved = listSavedArchives(snapshot, snapshot.tasks[0])[0];
      expect(saved?.files).toEqual(expect.arrayContaining(['untracked/.github/workflows/ci.yml', 'untracked/.gitignore']));
      await restoreSavedArchive(snapshot, snapshot.tasks[0], { archiveId: saved.id, archiveHash: saved.hash, candidateHash: await worktreeChangesHash(cwd) });
      expect(fs.readFileSync(path.join(cwd, '.github', 'workflows', 'ci.yml'), 'utf8')).toBe('on: push\n');
    } finally {
      if (previousHome === undefined) delete process.env.ALPHA_HOME; else process.env.ALPHA_HOME = previousHome;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the file names a saved patch touches', () => {
  it('reads both sides of every file, renames and copies included, quoted names decoded', async () => {
    const { patchHeaderPaths } = await import('./orchestrationSavedArchives.js');
    const patch = [
      'diff --git a/src/app.ts b/src/app.ts', '--- a/src/app.ts', '+++ b/src/app.ts', '@@ -1 +1 @@', '-a', '+b',
      'diff --git a/src/old.ts b/secrets/moved.ts', 'similarity index 100%', 'rename from src/old.ts', 'rename to secrets/moved.ts',
      'diff --git a/src/base.ts b/infra/copy.ts', 'copy from src/base.ts', 'copy to infra/copy.ts',
      String.raw`diff --git "a/src/caf\303\251.ts" "b/src/caf\303\251.ts"`, String.raw`--- "a/src/caf\303\251.ts"`, String.raw`+++ "b/src/caf\303\251.ts"`,
      'diff --git a/src/new.ts b/src/new.ts', 'new file mode 100644', '--- /dev/null', '+++ b/src/new.ts'
    ].join('\n');
    expect(patchHeaderPaths(patch)).toEqual(['src/app.ts', 'src/old.ts', 'secrets/moved.ts', 'src/base.ts', 'infra/copy.ts', 'src/café.ts', 'src/new.ts']);
  });
});
