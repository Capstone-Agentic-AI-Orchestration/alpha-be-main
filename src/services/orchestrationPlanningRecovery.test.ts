import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runWithWorkspace } from './workspaceContext.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', [
  '-c', 'user.name=Alpha Test', '-c', 'user.email=alpha-test@example.invalid', ...args
], { cwd, stdio: 'pipe' }).toString().trim();

describe('interrupted orchestration planning recovery', () => {
  let directory = '';
  let previousAlphaHome: string | undefined;
  let sqliteService: import('./sqliteService.js').SQLiteService | undefined;
  let recovery: typeof import('./orchestrationPlanningRecovery.js');
  let workspace: typeof import('./workspaceService.js');
  let gitUtils: typeof import('../utils/gitUtils.js');

  afterEach(async () => {
    sqliteService?.close();
    sqliteService = undefined;
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    directory = '';
    if (previousAlphaHome === undefined) delete process.env.ALPHA_HOME;
    else process.env.ALPHA_HOME = previousAlphaHome;
    vi.resetModules();
  });

  async function prepare() {
    directory = fs.mkdtempSync(path.join(process.cwd(), '.tmp-orchestration-planning-recovery-'));
    previousAlphaHome = process.env.ALPHA_HOME;
    process.env.ALPHA_HOME = directory;
    vi.resetModules();
    ({ sqliteService } = await import('./sqliteService.js'));
    workspace = await import('./workspaceService.js');
    gitUtils = await import('../utils/gitUtils.js');
    recovery = await import('./orchestrationPlanningRecovery.js');

    const repositoryDir = path.join(directory, 'repository');
    fs.mkdirSync(repositoryDir);
    git(repositoryDir, 'init', '--initial-branch=main');
    fs.writeFileSync(path.join(repositoryDir, 'README.md'), 'planning base\n');
    git(repositoryDir, 'add', '-A');
    git(repositoryDir, 'commit', '-m', 'planning base');
    const baseCommit = git(repositoryDir, 'rev-parse', 'HEAD');
    sqliteService.addAllowedPath(repositoryDir, 'planning recovery fixture');

    const projectId = 'planning-recovery-project';
    const runId = 'orchestration-stale-planning';
    const branchName = 'alpha/orchestration/stale-planning';
    const worktreePath = workspace.projectRunWorkspacePath(projectId, runId);
    await gitUtils.addBranchWorktree(repositoryDir, worktreePath, branchName, baseCommit);
    runWithWorkspace('ws-default', () => sqliteService!.createProject({ id: projectId, name: 'Planning recovery', key: 'PLNREC' }));
    const reservation = runWithWorkspace('ws-default', () => sqliteService!.reserveOrchestrationPlanning({
      projectId, repository: 'acme/planning-recovery', requestKey: 'planning-recovery-request',
      requestFingerprint: 'planning-recovery-fingerprint', createdBy: 'user-1', runId,
      branchName, baseCommit, worktreePath, ownerSessionId: 'old-session'
    }));
    return {
      repositoryDir,
      projectId,
      reservation
    };
  }

  it('removes only a clean stale worktree at its reserved branch and commit', async () => {
    const fixture = await prepare();

    await expect(recovery.removeStaleOrchestrationPlanningWorktree(fixture)).resolves.toBe(true);
    expect(fs.existsSync(fixture.reservation.worktreePath)).toBe(false);
  });

  it('preserves a worktree with changes for explicit recovery', async () => {
    const fixture = await prepare();
    fs.writeFileSync(path.join(fixture.reservation.worktreePath, 'README.md'), 'unresolved change\n');

    await expect(recovery.removeStaleOrchestrationPlanningWorktree(fixture)).resolves.toBe(false);
    expect(fs.existsSync(fixture.reservation.worktreePath)).toBe(true);
  });

  it('preserves a worktree whose branch no longer matches the reservation', async () => {
    const fixture = await prepare();

    await expect(recovery.removeStaleOrchestrationPlanningWorktree({
      ...fixture,
      reservation: { ...fixture.reservation, branchName: 'unexpected-branch' }
    })).resolves.toBe(false);
    expect(fs.existsSync(fixture.reservation.worktreePath)).toBe(true);
  });

  it('does not touch a path outside the deterministic project-run location', async () => {
    const fixture = await prepare();
    const foreignPath = path.join(directory, 'foreign-worktree');
    fs.mkdirSync(foreignPath);

    await expect(recovery.removeStaleOrchestrationPlanningWorktree({
      ...fixture,
      reservation: { ...fixture.reservation, worktreePath: foreignPath }
    })).resolves.toBe(false);
    expect(fs.existsSync(foreignPath)).toBe(true);
  });

  it('previews tracked and untracked saved changes without exposing the local workspace path', async () => {
    const fixture = await prepare();
    fs.writeFileSync(path.join(fixture.reservation.worktreePath, 'README.md'), 'preserved tracked edit\n');
    fs.writeFileSync(path.join(fixture.reservation.worktreePath, 'notes.md'), 'preserved new file\n');
    runWithWorkspace('ws-default', () => sqliteService!.recordOrchestrationPlanningRecovery({
      projectId: fixture.projectId,
      reservation: fixture.reservation,
      state: 'needs_review',
      reason: 'Planning was interrupted.'
    }));

    const preview = await recovery.getOrchestrationPlanningRecoveryPreview({
      projectId: fixture.projectId,
      runId: fixture.reservation.runId
    });

    expect(preview.changedPaths).toEqual(['notes.md', 'README.md']);
    expect(preview.diff).toContain('preserved tracked edit');
    expect(preview.diff).toContain('preserved new file');
    expect(preview.diff).not.toContain(fixture.reservation.worktreePath);
  });
});
