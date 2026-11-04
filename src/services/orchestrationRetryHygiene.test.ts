import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let dir = '';
let home = '';
afterEach(() => {
  for (const item of [dir, home]) if (item) fs.rmSync(item, { recursive: true, force: true });
  dir = home = '';
  delete process.env.ALPHA_HOME;
});

describe('recovering a worktree a stopped attempt left dirty', () => {
  it('can back up a candidate without clearing it and detects subsequent changes', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-resume-worktree-'));
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-resume-home-'));
    process.env.ALPHA_HOME = home;
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
    git('init', '-q'); fs.writeFileSync(path.join(dir, 'app.ts'), 'base\n'); git('add', '.');
    git('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', 'base');
    fs.writeFileSync(path.join(dir, 'app.ts'), 'unfinished tracked edit\n');
    fs.writeFileSync(path.join(dir, 'email.ts'), 'unfinished mail integration\n');
    const { preserveAndRestoreWorktree, worktreeChangesHash } = await import('./orchestrationWorktreeRecovery.js');
    const before = await worktreeChangesHash(dir);
    const saved = await preserveAndRestoreWorktree({ worktree: dir, runId: 'run-1', label: 'backend', keepChanges: true });
    expect(await worktreeChangesHash(dir)).toBe(before);
    expect(fs.readFileSync(path.join(dir, 'app.ts'), 'utf8')).toContain('unfinished');
    expect(fs.readFileSync(path.join(dir, 'email.ts'), 'utf8')).toContain('unfinished');
    expect(fs.readFileSync(path.join(saved!.folder, 'untracked', 'email.ts'), 'utf8')).toContain('unfinished');
    fs.appendFileSync(path.join(dir, 'email.ts'), 'changed after preparation');
    expect(await worktreeChangesHash(dir)).not.toBe(before);
  });

  it('saves tracked edits and untracked files aside and returns the worktree to its checkpoint', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-worktree-'));
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-home-'));
    process.env.ALPHA_HOME = home;
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
    git('init', '-q');
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"be"}\n');
    git('add', '.');
    git('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', 'base');
    const head = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"be","edited":true}\n');
    fs.mkdirSync(path.join(dir, '.lockcache', '_cacache'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.lockcache', '_cacache', 'entry'), 'cached');
    fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');

    const { preserveAndRestoreWorktree } = await import('./orchestrationWorktreeRecovery.js');
    const saved = await preserveAndRestoreWorktree({ worktree: dir, runId: 'run-1', label: 'backend-lockfile' });

    expect(git('status', '--porcelain', '--untracked-files=all')).toBe('');
    expect(git('rev-parse', 'HEAD')).toBe(head);
    expect(saved!.movedPaths.sort()).toEqual(['.lockcache', 'package-lock.json']);
    expect(fs.readFileSync(saved!.patchFile!, 'utf8')).toContain('"edited":true');
    expect(fs.readFileSync(path.join(saved!.folder, 'untracked', '.lockcache', '_cacache', 'entry'), 'utf8')).toBe('cached');
    expect(saved!.folder.startsWith(path.join(home, 'preserved'))).toBe(true);
    expect(await preserveAndRestoreWorktree({ worktree: dir, runId: 'run-1', label: 'again' })).toBeUndefined();
  });
});

describe('the repair budget', () => {
  it('treats a refused git commit as retryable, with plain "retry" accepted as direction', async () => {
    const { recoveryAvailableActions, isSpecialistBlocker } = await import('./orchestrationRecoveryPolicy.js');
    const reason = "The specialist reported a blocker: git add -- package-lock.json was refused: fatal: Unable to create '.git/worktrees/x/index.lock': Permission denied";
    expect(isSpecialistBlocker(reason)).toBe(false);
    const snapshot = (runs: number) => ({
      run: { status: 'blocked' }, findings: [],
      tasks: [{ id: 't', status: 'failed', required: true, kind: 'backend' }],
      attempts: Array.from({ length: runs }, (_, index) => ({ taskId: 't', status: 'failed', prototypeRunId: 'run-' + index, contextManifest: {}, failureReason: reason }))
    }) as any;
    const actions = (runs: number) => recoveryAvailableActions({ snapshot: snapshot(runs), category: 'workspace', taskId: 't', canControl: true, episodeAgeMs: 0 }).availableActions;
    expect(actions(1)).toContain('repair_and_continue');
    expect(actions(3)).toContain('provide_guidance');
    expect(actions(4)).not.toContain('provide_guidance');
  });

  it('lets the person direct or retry a task after any blocker the specialist reported', async () => {
    const { recoveryAvailableActions } = await import('./orchestrationRecoveryPolicy.js');
    const snapshot = {
      run: { status: 'blocked' }, findings: [],
      tasks: [{ id: 't', status: 'failed', required: true, kind: 'backend' }],
      attempts: [{ taskId: 't', status: 'failed', prototypeRunId: 'run-a', contextManifest: {},
        failureReason: 'The specialist reported a blocker: npm install was refused: EACCES permission denied' }]
    } as any;
    const { availableActions } = recoveryAvailableActions({ snapshot, category: 'workspace', taskId: 't', canControl: true, episodeAgeMs: 0 });
    expect(availableActions).toContain('provide_guidance');
  });

  it('offers a retry after a preparation refused leftover changes, but not after a checkpoint mismatch', async () => {
    const { recoveryAvailableActions } = await import('./orchestrationRecoveryPolicy.js');
    const snapshot = (failureReason: string) => ({
      run: { status: 'blocked' }, findings: [],
      tasks: [{ id: 't', status: 'failed', required: true }],
      attempts: [
        { taskId: 't', status: 'failed', prototypeRunId: 'run-a', contextManifest: {} },
        { taskId: 't', status: 'failed', contextManifest: { orchestrationPreparationFailed: true }, failureReason }
      ]
    }) as any;
    const actions = (reason: string) => recoveryAvailableActions({ snapshot: snapshot(reason), category: 'workspace', taskId: 't', canControl: true, episodeAgeMs: 0 }).availableActions;
    expect(actions('The previous task left uncheckpointed changes. Preserve the worktree and reconcile those changes before dispatching another task.')).toContain('recheck_prerequisite');
    expect(actions('The retry worktree no longer matches its latest saved checkpoint.')).not.toContain('recheck_prerequisite');
  });

  it('does not count attempts that never reached a specialist', async () => {
    const { workAttemptCount } = await import('./orchestrationRecoveryPolicy.js');
    const attempt = (status: string, prototypeRunId?: string) => ({ taskId: 't', status, prototypeRunId, contextManifest: {} });
    const snapshot = { attempts: [attempt('failed'), attempt('failed', 'run-a'), attempt('failed', 'run-b'), attempt('failed'), attempt('running', 'run-c')] } as any;
    expect(workAttemptCount(snapshot, 't')).toBe(3);
  });
});

describe('runner failure reasons', () => {
  it('ignores a blocker that only reports the agent\'s own git commit being refused', async () => {
    const { isAlphaOwnedGitBlocker } = await import('./taskAcceptanceService.js');
    expect(isAlphaOwnedGitBlocker("git add -- package-lock.json was refused: fatal: Unable to create '.../.git/worktrees/x/index.lock': Permission denied")).toBe(true);
    expect(isAlphaOwnedGitBlocker('git commit failed: permission denied')).toBe(true);
    expect(isAlphaOwnedGitBlocker('The required API key is missing, so the endpoint cannot be tested.')).toBe(false);
    expect(isAlphaOwnedGitBlocker('npm install was refused: EACCES permission denied')).toBe(false);
  });

  it('leads with what happened and the agent update, without raw tool calls', async () => {
    const { describeRunnerFailure } = await import('./orchestrationService.js');
    const reason = describeRunnerFailure({
      activities: [
        { kind: 'assistant', message: 'The npm registry is unreachable from this sandbox.' },
        { kind: 'error', message: 'Run failed: Process timed out.' }
      ]
    } as any, ['ool Call] Bash: {"command":"pwsh -Command ..."}', 'npm error code ENOTFOUND', '[Tool Call] Bash: {"command":"x"}']);
    expect(reason.split('\n')[0]).toBe('The agent ran out of time before it submitted a result, so Alpha stopped it.');
    expect(reason).toContain("Agent's last update: The npm registry is unreachable from this sandbox.");
    expect(reason).toContain('npm error code ENOTFOUND');
    expect(reason).not.toMatch(/Tool Call|"command"/);
  });
});
