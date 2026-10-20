import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SQLiteService } from './sqliteService.js';
import { parseOrchestrationPlan } from './orchestrationContract.js';
import { initialTaskRecords } from './orchestrationStateMachine.js';
import { assertOrchestrationApprovalCheckpointCurrent, getOrchestrationDiffPreview } from './orchestrationReviewService.js';
import { runWithWorkspace } from './workspaceContext.js';

const plan = parseOrchestrationPlan({
  schemaVersion: 1,
  goal: 'Review one validated repository change.',
  exclusions: [],
  requirements: [{ id: 'REQ-1', description: 'A changed file is visible for review.' }],
  tasks: [{
    id: 'code-change', title: 'Make a small change', description: 'Update a single file.', kind: 'backend',
    ownerAgentId: 'backend-agent', dependsOn: [], requirementIds: ['REQ-1'],
    acceptanceCriteria: ['The changed file appears in the reviewed commit.'], required: false
  }]
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', [
  '-c', 'user.name=Alpha Test', '-c', 'user.email=alpha-test@example.invalid', ...args
], { cwd, stdio: 'pipe' }).toString().trim();

describe('orchestration review checkpoint', () => {
  let directory = '';
  let store: SQLiteService | undefined;

  afterEach(() => {
    store?.close();
    store = undefined;
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    directory = '';
  });

  async function prepareAwaitingApproval() {
    directory = fs.mkdtempSync(path.join(process.cwd(), '.tmp-orchestration-review-'));
    const repository = path.join(directory, 'repo');
    fs.mkdirSync(repository);
    git(repository, 'init', '--initial-branch=main');
    fs.writeFileSync(path.join(repository, 'README.md'), 'before\n');
    git(repository, 'add', '-A');
    git(repository, 'commit', '-m', 'base');
    const baseCommit = git(repository, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repository, 'README.md'), 'before\nreviewed change\n');
    git(repository, 'add', '-A');
    git(repository, 'commit', '-m', 'reviewed change');
    const resultCommit = git(repository, 'rev-parse', 'HEAD');

    store = new SQLiteService({ dbPath: path.join(directory, 'alpha.db'), seedDefaults: false });
    store.addAllowedPath(repository, 'review fixture');
    const now = '2026-10-20T00:00:00.000Z';
    runWithWorkspace('workspace-review', () => {
      store!.createProject({ id: 'project-review', name: 'Review fixture', key: 'REV' });
      store!.createOrchestrationSnapshot({
        id: 'orchestration-review', workspaceId: 'workspace-review', projectId: 'project-review',
        issueId: 'issue-review', repository: 'acme/review', requestKey: 'review-request',
        requestFingerprint: 'review-fingerprint', createdBy: 'user-review', executorId: 'desktop-review',
        ownershipEpoch: 1, workflowVersion: 1, planVersion: 1, plan, status: 'planning', revision: 0,
        branchName: 'main', baseRef: 'main', baseCommit, worktreePath: repository,
        createdAt: now, updatedAt: now
      }, initialTaskRecords(plan));
      let snapshot = store!.transitionOrchestrationRun({ runId: 'orchestration-review', expectedRevision: 0, nextStatus: 'executing', now });
      snapshot = store!.transitionOrchestrationRun({ runId: snapshot.run.id, expectedRevision: snapshot.run.revision, nextStatus: 'validating', now });
      snapshot = store!.transitionOrchestrationRun({
        runId: snapshot.run.id, expectedRevision: snapshot.run.revision, nextStatus: 'awaiting_approval', now,
        evidence: {
          validationVersion: 1, resultCommit, branchName: 'main', noOpenBlockingFindings: true,
          checks: { status: 'passed', missingScripts: [], observed: [{ script: 'test', exitCode: 0, signal: null }] }
        }
      });
    });

    return runWithWorkspace('workspace-review', () => store!.getOrchestrationSnapshot('orchestration-review'))!;
  }

  it('shows the exact validated commit and its changed files in a bounded text diff', async () => {
    const snapshot = await prepareAwaitingApproval();

    const preview = await getOrchestrationDiffPreview(snapshot, store!);

    expect(preview).toMatchObject({
      baseCommit: snapshot.run.baseCommit,
      branchName: 'main',
      changedPaths: ['README.md'],
      pathsTruncated: false,
      truncated: false
    });
    expect(preview.resultCommit).toMatch(/^[a-f0-9]{40}$/i);
    expect(preview.resultCommit).not.toBe(snapshot.run.baseCommit);
    expect(preview.diff).toContain('+reviewed change');
  });

  it('blocks approval if the branch or working tree changed after final validation', async () => {
    const snapshot = await prepareAwaitingApproval();
    fs.writeFileSync(path.join(snapshot.run.worktreePath!, 'README.md'), 'changed after review\n');

    await expect(assertOrchestrationApprovalCheckpointCurrent(snapshot, store!))
      .rejects.toThrow(/changed after final checks/);
  });
});
