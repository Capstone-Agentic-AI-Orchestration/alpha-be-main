import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { OrchestrationSnapshot } from './orchestrationStateMachine.js';
import { repositoryMemoryAtCheckpoints } from './orchestrationService.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', [
  '-c', 'user.name=Alpha Test', '-c', 'user.email=alpha-test@example.invalid', ...args
], { cwd, stdio: 'pipe' }).toString().trim();

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function repository(memory: string): { dir: string; commit: () => string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-build-memory-'));
  dirs.push(dir);
  git(dir, 'init', '--initial-branch=main');
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), memory);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'memory');
  return { dir, commit: () => git(dir, 'rev-parse', 'HEAD') };
}

describe('build tasks and repository memory', () => {
  it('reads every repository\'s memory at its checkpoint, not as the folder is now', async () => {
    const be = repository('Login: POST /api/auth/login');
    const fe = repository('Send credentials: include.');
    const beBase = be.commit();
    const feBase = fe.commit();
    // An accepted backend task moved its checkpoint; memory changed with it.
    fs.writeFileSync(path.join(be.dir, 'AGENTS.md'), 'Login: POST /api/auth/login (returns {user})');
    git(be.dir, 'commit', '-am', 'accepted task');
    const beAccepted = be.commit();
    // Edited after preparation and never committed: must not reach the task.
    fs.writeFileSync(path.join(fe.dir, 'AGENTS.md'), 'Edited during the build');

    const snapshot = {
      run: {
        repository: 'org/be',
        repositoryWorkspaces: [
          { repository: 'org/be', worktreePath: be.dir, baseCommit: beBase, branchName: 'alpha/orchestration/x' },
          { repository: 'org/fe', worktreePath: fe.dir, baseCommit: feBase, branchName: 'alpha/orchestration/x' }
        ]
      },
      tasks: [{ id: 't-be', repository: 'org/be' }],
      attempts: [{ taskId: 't-be', status: 'accepted', resultCommit: beAccepted }]
    } as unknown as OrchestrationSnapshot;

    const memory = await repositoryMemoryAtCheckpoints(snapshot);
    expect(memory.text).toContain('### org/be (AGENTS.md)\nLogin: POST /api/auth/login (returns {user})');
    expect(memory.text).toContain('### org/fe (AGENTS.md)\nSend credentials: include.');
    expect(memory.text).not.toContain('Edited during the build');
    expect(memory.sources).toEqual([
      { repository: 'org/be', file: 'AGENTS.md', version: beAccepted },
      { repository: 'org/fe', file: 'AGENTS.md', version: feBase }
    ]);
  });

  it('gives nothing when the repositories have no memory or no working copy', async () => {
    const snapshot = { run: { repository: 'org/be', repositoryWorkspaces: [{ repository: 'org/be', worktreePath: path.join(os.tmpdir(), 'missing-' + Date.now()), baseCommit: 'a'.repeat(40) }] }, tasks: [], attempts: [] } as unknown as OrchestrationSnapshot;
    expect(await repositoryMemoryAtCheckpoints(snapshot)).toEqual({ text: '', sources: [] });
  });
});
