import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IssueStore } from '../store/issueStore.js';
import type { OrchestrationSnapshot } from './orchestrationStateMachine.js';
import { replayPublishedOrchestrationIssueEffects, synchronizePublishedOrchestrationIssue } from './orchestrationFinalization.js';

const WORKSPACE_ID = 'workspace-approval-replay';

function publishedSnapshot(projectId: string, issueId: string): OrchestrationSnapshot {
  return {
    run: {
      id: 'orchestration-restart-replay',
      workspaceId: WORKSPACE_ID,
      projectId,
      issueId,
      repository: 'acme/shop',
      status: 'completed',
      updatedAt: '2026-10-20T00:00:00.000Z',
      publication: {
        branchName: 'alpha/orchestration/restart-replay',
        baseBranch: 'main',
        resultCommit: 'b'.repeat(40),
        pullRequestUrl: 'https://github.com/acme/shop/pull/42',
        publishedAt: '2026-10-20T00:01:00.000Z'
      }
    }
  } as OrchestrationSnapshot;
}

describe('SQLite orchestration publication recovery', () => {
  let home: string | undefined;
  let closeDatabase: (() => void) | undefined;

  afterEach(() => {
    closeDatabase?.();
    closeDatabase = undefined;
    vi.unstubAllEnvs();
    vi.resetModules();
    if (home) fs.rmSync(home, { recursive: true, force: true });
    home = undefined;
  });

  it('replays the durable pull request record after a restart, writing no comment', async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-approval-replay-'));
    vi.stubEnv('ALPHA_HOME', home);
    vi.resetModules();

    const firstDatabase = await import('./sqliteService.js');
    const { SqliteIssueStore } = await import('../store/sqliteIssueStore.js');
    const { SqliteProjectStore } = await import('../store/sqliteProjectStore.js');
    closeDatabase = () => firstDatabase.sqliteService.close();

    const issues = new SqliteIssueStore();
    const projects = new SqliteProjectStore();
    const project = await projects.create(WORKSPACE_ID, { id: 'project-approval-replay', name: 'Approval replay', key: 'APR' });
    const issue = await issues.create(WORKSPACE_ID, { id: 'issue-approval-replay', title: 'Recover approval effects', projectId: project.id });
    const snapshot = publishedSnapshot(project.id, issue.id);

    const interruptedStore: Pick<IssueStore, 'get' | 'update'> = {
      get: (...args) => issues.get(...args),
      async update() {
        throw new Error('Simulated process interruption before the task update.');
      }
    };

    await expect(synchronizePublishedOrchestrationIssue(snapshot, interruptedStore))
      .rejects.toThrow(/process interruption/);
    expect(await issues.get(WORKSPACE_ID, issue.id)).toMatchObject({ status: 'todo', comments: [] });

    firstDatabase.sqliteService.close();
    closeDatabase = undefined;
    vi.resetModules();

    const restartedDatabase = await import('./sqliteService.js');
    const { SqliteIssueStore: RestartedIssueStore } = await import('../store/sqliteIssueStore.js');
    closeDatabase = () => restartedDatabase.sqliteService.close();
    const restartedIssues = new RestartedIssueStore();
    const replay = await replayPublishedOrchestrationIssueEffects([snapshot], restartedIssues);

    expect(replay).toEqual({ synchronized: [snapshot.run.id], failed: [] });
    expect(await restartedIssues.get(WORKSPACE_ID, issue.id)).toMatchObject({
      status: 'review',
      prUrl: 'https://github.com/acme/shop/pull/42',
      comments: []
    });
  });
});
