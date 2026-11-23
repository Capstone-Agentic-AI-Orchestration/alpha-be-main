import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTaskRequiredChecks, taskRequiredChecks } from './repositoryChecks.js';
import { definedCheckScripts, discoverVerificationCommands } from './repositoryExecution.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function repository(scripts: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-ci-checks-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts }));
  return dir;
}

describe('CI checks a code task runs', () => {
  // CI runs tests, lint and (for frontends) a build on every pull request. Alpha never ran `build`,
  // so a build error passed every task and final validation, then failed CI after delivery.
  const scripts = { test: 'jest', lint: 'eslint . --max-warnings=0', build: 'vite build', dev: 'vite', start: 'vite preview' };

  it('reads the check scripts a repository defines, build included', () => {
    expect(definedCheckScripts(repository(scripts))).toEqual(['test', 'lint', 'build']);
    expect(discoverVerificationCommands(repository(scripts)).map(command => command.script)).toEqual(['test', 'lint', 'build']);
  });

  it('adds every CI check the repository defines to a code task, never to a report task', () => {
    const tasks = [
      { kind: 'frontend', repository: 'acme/web', requiredChecks: ['test'] as const },
      { kind: 'review', repository: 'acme/web', requiredChecks: [] as const }
    ];
    expect(taskRequiredChecks(tasks[0], tasks, 'acme/web', ['test', 'lint', 'build'])).toEqual(['test', 'lint', 'build']);
    expect(taskRequiredChecks(tasks[0], tasks, 'acme/web', ['test'])).toEqual(['test']);
    expect(taskRequiredChecks(tasks[1], tasks, 'acme/web', ['test', 'lint', 'build'])).toEqual([]);
  });

  it('holds a running build to the scripts its working copy defines now, including plans made before this rule', () => {
    const worktree = repository(scripts);
    const task = { id: 'pages', kind: 'frontend', repository: 'acme/web', requiredChecks: ['test'] };
    const snapshot = {
      run: {
        repository: 'acme/web',
        repositoryWorkspaces: [{ repository: 'acme/web', branchName: 'alpha/x', baseRef: 'dev', baseCommit: 'a'.repeat(40), worktreePath: worktree }],
        plan: { tasks: [task] }
      },
      tasks: [task]
    } as never;
    expect(buildTaskRequiredChecks(snapshot, task as never)).toEqual(['test', 'lint', 'build']);
  });
});
