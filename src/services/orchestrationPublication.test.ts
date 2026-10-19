import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Issue } from '../models/index.js';
import type { IssueStore } from '../store/issueStore.js';
import type { OrchestrationEventRecord, OrchestrationSnapshot } from './orchestrationStateMachine.js';
import { OrchestrationPublicationService } from './orchestrationPublication.js';
import { getHeadCommit } from '../utils/gitUtils.js';

const WORKSPACE_ID = 'workspace-publication';

function issueFixture(): Issue {
  return {
    id: 'issue-1', identifier: 'SHOP-7', title: 'Add cart totals', description: '', status: 'in_progress',
    priority: 'medium', projectId: 'project-1', labels: [], subtasks: [], comments: [],
    createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-20T00:00:00.000Z'
  };
}

function event(type: string, evidence: Record<string, unknown>): OrchestrationEventRecord {
  return {
    id: 1, eventId: `event-${type}`, runId: 'run-1', sequence: 1,
    type, payload: { evidence }, createdAt: '2026-10-20T00:00:00.000Z'
  };
}

function snapshot(cwd: string, status: 'awaiting_approval' | 'publishing', commit: string): OrchestrationSnapshot {
  return {
    run: {
      id: 'run-1', workspaceId: WORKSPACE_ID, projectId: 'project-1', issueId: 'issue-1', repository: 'acme/shop',
      requestKey: 'request-1', requestFingerprint: 'fingerprint-1', createdBy: 'user-1', executorId: 'desktop-1',
      ownershipEpoch: 1, workflowVersion: 1, planVersion: 1,
      plan: {
        schemaVersion: 1, goal: 'Add cart totals', exclusions: [],
        requirements: [{ id: 'REQ-1', description: 'Show an accurate subtotal.' }],
        tasks: [{ id: 'backend', title: 'Calculate totals', description: 'Calculate cart totals.', kind: 'backend', ownerAgentId: 'agent-1', dependsOn: [], requirementIds: ['REQ-1'], acceptanceCriteria: ['Subtotal is accurate.'], requiredChecks: ['test'], scope: { includePaths: ['src/'], excludePaths: [] }, required: true }]
      },
      status, revision: status === 'awaiting_approval' ? 4 : 5, branchName: 'alpha/orchestration/run-1',
      baseRef: 'a'.repeat(40), baseCommit: 'a'.repeat(40), worktreePath: cwd,
      createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-20T00:00:00.000Z'
    },
    tasks: [{
      id: 'backend', title: 'Calculate totals', description: 'Calculate cart totals.', kind: 'backend', ownerAgentId: 'agent-1',
      dependsOn: [], requirementIds: ['REQ-1'], acceptanceCriteria: ['Subtotal is accurate.'], requiredChecks: ['test'],
      scope: { includePaths: ['src/'], excludePaths: [] }, required: true, status: 'accepted', revision: 2, attemptCount: 1
    }],
    attempts: [], artifacts: [], findings: []
  } as OrchestrationSnapshot;
}

describe('orchestration publication', () => {
  let cwd: string | undefined;

  afterEach(() => {
    if (cwd) fs.rmSync(cwd, { recursive: true, force: true });
    cwd = undefined;
  });

  it('pins a PR target before approval and reconciles a PR created before a timeout', async () => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-orchestration-publish-'));
    const branchName = 'alpha/orchestration/run-1';
    execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
    execFileSync('git', ['checkout', '-b', branchName], { cwd, stdio: 'ignore' });
    fs.writeFileSync(path.join(cwd, 'README.md'), 'approved fixture\n');
    execFileSync('git', ['add', 'README.md'], { cwd, stdio: 'ignore' });
    execFileSync('git', ['-c', 'user.name=Alpha Test', '-c', 'user.email=alpha-test@example.invalid', 'commit', '-m', 'approved fixture'], { cwd, stdio: 'ignore' });
    const resultCommit = await getHeadCommit(cwd);

    const validation = event('run_awaiting_approval', {
      validationVersion: 1, resultCommit, branchName, noOpenBlockingFindings: true,
      checks: { status: 'passed', missingScripts: [], observed: [{ command: 'npm test', exitCode: 0, signal: null }] }
    });
    let events: OrchestrationEventRecord[] = [validation];
    const issue = issueFixture();
    const issues: Pick<IssueStore, 'get' | 'update' | 'addComment'> = {
      async get(_workspaceId, id) { return id === issue.id ? issue : null; },
      async update() { return issue; },
      async addComment(_workspaceId, comment) { return comment; }
    };
    let pullRequestExists = false;
    const pullUrl = 'https://github.com/acme/shop/pull/42';
    const github = {
      async checkAuth() { return { authenticated: true }; },
      async inspectLocalRepo() { return { isRepo: true, ownerRepo: 'acme/shop', branch: branchName, workflows: [], hasReadme: true }; },
      async getRepository() { return { nameWithOwner: 'acme/shop', url: 'https://github.com/acme/shop', description: null, defaultBranch: 'main', isPrivate: true, isEmpty: false }; },
      async listBranches() { return [{ name: 'main', protected: true }, { name: 'dev', protected: false }]; },
      pushBranch: vi.fn(async () => {}),
      createPullRequest: vi.fn(async () => { pullRequestExists = true; throw new Error('GitHub response timed out after creation.'); })
    };
    const store = {
      isPathAllowed: (value: string) => value === cwd,
      listOrchestrationEvents: () => events
    } as any;
    const service = new OrchestrationPublicationService({
      store,
      issues,
      github: github as any,
      listRemoteBranches: async () => [{ name: branchName, sha: resultCommit, protected: false, pipeline: false, agent: false }],
      findOpenPullRequest: vi.fn(async () => pullRequestExists ? { number: 42, url: pullUrl } : undefined),
      now: () => '2026-10-20T00:03:00.000Z'
    });

    const target = await service.prepare(snapshot(cwd, 'awaiting_approval', resultCommit));
    expect(target).toEqual({ publicationBaseBranch: 'dev', resultCommit });
    events = [validation, event('run_publishing', {
      decision: 'approved', approvedBy: 'user-1', approvedAt: '2026-10-20T00:02:00.000Z',
      resultCommit, branchName, publicationBaseBranch: target.publicationBaseBranch
    })];

    const publication = await service.publish(snapshot(cwd, 'publishing', resultCommit));

    expect(publication).toEqual({
      branchName, baseBranch: 'dev', resultCommit, pullRequestUrl: pullUrl, publishedAt: '2026-10-20T00:03:00.000Z'
    });
    expect(github.pushBranch).toHaveBeenCalledWith(cwd, branchName, 'acme/shop');
    expect(github.createPullRequest).toHaveBeenCalledWith(
      cwd, 'feat: Add cart totals [SHOP-7]', expect.stringContaining('Add cart totals'), 'dev', branchName
    );
  });

  it('refuses publication if the validated branch changed before the push', async () => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-orchestration-publish-stale-'));
    execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
    execFileSync('git', ['checkout', '-b', 'alpha/orchestration/run-1'], { cwd, stdio: 'ignore' });
    fs.writeFileSync(path.join(cwd, 'README.md'), 'approved fixture\n');
    execFileSync('git', ['add', 'README.md'], { cwd, stdio: 'ignore' });
    execFileSync('git', ['-c', 'user.name=Alpha Test', '-c', 'user.email=alpha-test@example.invalid', 'commit', '-m', 'approved fixture'], { cwd, stdio: 'ignore' });
    const resultCommit = await getHeadCommit(cwd);
    fs.writeFileSync(path.join(cwd, 'README.md'), 'changed after approval\n');
    const branchName = 'alpha/orchestration/run-1';
    const events = [
      event('run_awaiting_approval', { validationVersion: 1, resultCommit, branchName, noOpenBlockingFindings: true,
        checks: { status: 'passed', missingScripts: [], observed: [{ command: 'npm test', exitCode: 0, signal: null }] } }),
      event('run_publishing', { decision: 'approved', approvedBy: 'user-1', approvedAt: 'now', resultCommit, branchName, publicationBaseBranch: 'main' })
    ];
    const pushBranch = vi.fn(async () => {});
    const service = new OrchestrationPublicationService({
      store: { isPathAllowed: () => true, listOrchestrationEvents: () => events } as any,
      github: {
        async checkAuth() { return { authenticated: true }; },
        async inspectLocalRepo() { return { isRepo: true, ownerRepo: 'acme/shop', branch: branchName }; },
        async getRepository() { return { nameWithOwner: 'acme/shop', url: '', description: null, defaultBranch: 'main', isPrivate: true, isEmpty: false }; },
        async listBranches() { return [{ name: 'main', protected: true }]; },
        pushBranch,
        async createPullRequest() { return 'https://github.com/acme/shop/pull/1'; }
      } as any
    });

    await expect(service.publish(snapshot(cwd, 'publishing', resultCommit))).rejects.toThrow(/changed after validation/);
    expect(pushBranch).not.toHaveBeenCalled();
  });
});
