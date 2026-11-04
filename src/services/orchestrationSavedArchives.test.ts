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
    task.scope.includePaths = ['elsewhere/**']; expect(listSavedArchives(snapshot, task)).toHaveLength(0);
    task.scope.includePaths = ['src/**']; snapshot.run.repositoryWorkspaces![0].baseCommit = 'a'.repeat(40);
    await expect(restoreSavedArchive(snapshot, task, { archiveId: saved.id, archiveHash: saved.hash, candidateHash: clean })).rejects.toThrow(/checkpoint/);
    expect(fs.existsSync(path.join(cwd, 'src', 'email.ts'))).toBe(false);
  });
});
