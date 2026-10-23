import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getOrchestrationLiveChanges } from './orchestrationReviewService.js';

let dir: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

describe('live build changes', () => {
  it('reports committed, in-progress and untracked edits against the build base, skipping node_modules', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-live-changes-'));
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    fs.writeFileSync(path.join(dir, 'app.ts'), 'one\ntwo\n');
    git('add', '.');
    git('commit', '-qm', 'base');
    const baseCommit = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(dir, 'app.ts'), 'one\nTWO\nthree\n');
    fs.writeFileSync(path.join(dir, 'package-lock.json'), '{\n  "lockfileVersion": 3\n}\n');
    fs.mkdirSync(path.join(dir, 'node_modules', 'dep'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', 'dep', 'index.js'), 'x');

    const snapshot = { run: { repositoryWorkspaces: [{ repository: 'org/be', worktreePath: dir, branchName: 'alpha/x', baseRef: 'main', baseCommit }] } } as any;
    const result = await getOrchestrationLiveChanges(snapshot, { isPathAllowed: () => true } as any);

    const repo = result.repositories[0];
    expect(repo.repository).toBe('org/be');
    expect(repo.files).toEqual([
      { path: 'app.ts', status: 'modified', additions: 2, deletions: 1 },
      { path: 'package-lock.json', status: 'added', additions: 3, deletions: 0 }
    ]);
    expect(repo.diff).toContain('+TWO');
    expect(repo.diff).toContain('+++ b/package-lock.json');
    expect(repo.diff).not.toContain('node_modules');
  });

  it('skips a worktree outside the allowed paths', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-live-changes-'));
    const snapshot = { run: { repositoryWorkspaces: [{ repository: 'org/be', worktreePath: dir, branchName: 'b', baseRef: 'main', baseCommit: 'a'.repeat(40) }] } } as any;
    const result = await getOrchestrationLiveChanges(snapshot, { isPathAllowed: () => false } as any);
    expect(result.repositories).toEqual([]);
  });
});

