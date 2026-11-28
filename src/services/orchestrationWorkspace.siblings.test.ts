import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { siblingReadRoots } from './orchestrationWorkspace.js';
import type { OrchestrationRunRecord } from './orchestrationStateMachine.js';

const made: string[] = [];
afterEach(() => { for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('siblingReadRoots', () => {
  it('gives a task the other build repositories that exist, never its own', () => {
    const be = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-be-'));
    const fe = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-fe-'));
    made.push(be, fe);
    const workspace = (repository: string, worktreePath: string) => ({ repository, worktreePath, branchName: 'alpha/orchestration/x', baseRef: 'main', baseCommit: 'abc' });
    const run = { repository: 'acme/shop-fe', repositoryWorkspaces: [
      workspace('acme/shop-fe', fe), workspace('acme/shop-be', be), workspace('acme/shop-docs', path.join(be, 'gone'))
    ] } as unknown as OrchestrationRunRecord;

    expect(siblingReadRoots(run, 'acme/shop-fe')).toEqual([{ name: 'shop-be', repo: 'acme/shop-be', dir: fs.realpathSync.native(be) }]);
    expect(siblingReadRoots(run, 'acme/shop-be').map(root => root.repo)).toEqual(['acme/shop-fe']);
  });
});
