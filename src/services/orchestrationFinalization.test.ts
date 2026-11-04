import { describe, expect, it } from 'vitest';
import type { Issue } from '../models/index.js';
import type { IssueStore } from '../store/issueStore.js';
import type { OrchestrationSnapshot } from './orchestrationStateMachine.js';
import { replayPublishedOrchestrationIssueEffects, synchronizePublishedOrchestrationIssue } from './orchestrationFinalization.js';
import { manualChecklistRequirements } from './issueChecklist.js';

function publishedSnapshot(): OrchestrationSnapshot {
  return {
    run: {
      id: 'orchestration-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      issueId: 'issue-1',
      repository: 'acme/shop',
      status: 'completed',
      updatedAt: '2026-10-20T00:00:00.000Z',
      publication: {
        branchName: 'alpha/orchestration/run-1',
        baseBranch: 'main',
        resultCommit: 'b'.repeat(40),
        pullRequestUrl: 'https://github.com/acme/shop/pull/42',
        publishedAt: '2026-10-20T00:01:00.000Z'
      }
    }
  } as OrchestrationSnapshot;
}

function issueFixture(status: Issue['status'] = 'todo'): Issue {
  return {
    id: 'issue-1',
    identifier: 'TEST-1',
    title: 'Add a small feature',
    description: '',
    status,
    priority: 'medium',
    projectId: 'project-1',
    labels: [],
    subtasks: [],
    comments: [],
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z'
  };
}

function issueStoreFixture(initial = issueFixture()) {
  let issue = initial;
  let updateCount = 0;
  const store: Pick<IssueStore, 'get' | 'update' | 'addComment'> = {
    async get(_workspaceId, id) { return id === issue.id ? issue : null; },
    async update(_workspaceId, id, updates) {
      if (id !== issue.id) return null;
      updateCount++;
      issue = { ...issue, ...updates };
      return issue;
    },
    async addComment(_workspaceId, comment) {
      issue = { ...issue, comments: [...issue.comments.filter(item => item.id !== comment.id), comment] };
      return comment;
    }
  };
  return { store, get issue() { return issue; }, get updateCount() { return updateCount; } };
}

describe('orchestration publication finalization', () => {
  it('shares validated checklist progress with the PR in one idempotent task update', async () => {
    const subtasks = [{ id: 'pm-email', title: 'Invalid email shows an error.', completed: false }];
    const requirements = manualChecklistRequirements(subtasks);
    const snapshot = publishedSnapshot();
    snapshot.run.plan = { requirements } as typeof snapshot.run.plan;
    snapshot.tasks = [{ id: 'validate', kind: 'validation', required: true, status: 'accepted', requirementIds: [requirements[0].id] }] as any;
    snapshot.attempts = [{ taskId: 'validate', attemptNumber: 1, status: 'accepted', result: { agentReport: {
      requirementCoverage: [{ requirementId: requirements[0].id, evidence: 'tests/email.test.ts passed.' }]
    } } }] as any;
    const fixture = issueStoreFixture({ ...issueFixture(), subtasks });
    await synchronizePublishedOrchestrationIssue(snapshot, fixture.store);
    await synchronizePublishedOrchestrationIssue(snapshot, fixture.store);
    expect(fixture.issue).toMatchObject({ status: 'review', subtasks: [{ ...subtasks[0], completed: true }] });
    expect(fixture.updateCount).toBe(1);
    expect(fixture.issue.comments).toHaveLength(1);
  });

  it('finishes a read-only issue without a PR and replays its completion idempotently', async () => {
    const snapshot = publishedSnapshot();
    delete snapshot.run.publication;
    snapshot.tasks = [{ id: 'report', kind: 'requirements', required: true, status: 'accepted' }] as any;
    const fixture = issueStoreFixture(issueFixture('agent_running'));
    await synchronizePublishedOrchestrationIssue(snapshot, fixture.store);
    await replayPublishedOrchestrationIssueEffects([snapshot], fixture.store);
    expect(fixture.issue.status).toBe('review');
    expect(fixture.issue.prUrl).toBeUndefined();
    expect(fixture.issue.comments).toHaveLength(1);
    expect(fixture.updateCount).toBe(1);
  });
  it('synchronizes a published PR idempotently to the project issue', async () => {
    const fixture = issueStoreFixture();

    await synchronizePublishedOrchestrationIssue(publishedSnapshot(), fixture.store);
    await synchronizePublishedOrchestrationIssue(publishedSnapshot(), fixture.store);

    expect(fixture.issue).toMatchObject({
      status: 'review',
      branchName: 'alpha/orchestration/run-1',
      prUrl: 'https://github.com/acme/shop/pull/42'
    });
    expect(fixture.issue.comments).toHaveLength(1);
    expect(fixture.issue.comments[0]).toMatchObject({
      id: 'comm-orchestration-1-orchestration-published',
      content: 'Orchestrator build approved and published for review:\nacme/shop: https://github.com/acme/shop/pull/42',
      createdAt: '2026-10-20T00:01:00.000Z'
    });
    expect(fixture.updateCount).toBe(1);
  });

  it('replays a persisted publication comment after the issue update fails', async () => {
    const fixture = issueStoreFixture();
    let failStatusWrite = true;
    const store: Pick<IssueStore, 'get' | 'update' | 'addComment'> = {
      get: (...args) => fixture.store.get(...args),
      addComment: (...args) => fixture.store.addComment(...args),
      async update(...args) {
        if (failStatusWrite) {
          failStatusWrite = false;
          return null;
        }
        return fixture.store.update(...args);
      }
    };

    await expect(synchronizePublishedOrchestrationIssue(publishedSnapshot(), store))
      .rejects.toThrow(/could not be synchronized/);
    expect(fixture.issue.status).toBe('todo');
    expect(fixture.issue.comments).toHaveLength(1);

    const replay = await replayPublishedOrchestrationIssueEffects([publishedSnapshot()], store);

    expect(replay).toEqual({ synchronized: ['orchestration-1'], failed: [] });
    expect(fixture.issue.status).toBe('review');
    expect(fixture.issue.comments).toHaveLength(1);
    expect(fixture.updateCount).toBe(1);
  });

  it('replays every published run and reports an unavailable issue without stopping the batch', async () => {
    const fixture = issueStoreFixture();
    const result = await replayPublishedOrchestrationIssueEffects(
      [publishedSnapshot(), { ...publishedSnapshot(), run: { ...publishedSnapshot().run, id: 'orchestration-missing', issueId: 'missing' } }],
      {
        async get(workspaceId, id) { return id === 'issue-1' ? fixture.store.get(workspaceId, id) : null; },
        update: (...args) => fixture.store.update(...args),
        addComment: (...args) => fixture.store.addComment(...args)
      }
    );

    expect(result.synchronized).toEqual(['orchestration-1']);
    expect(result.failed).toEqual([{ runId: 'orchestration-missing', reason: 'The project task for this published build is unavailable. Retry to synchronize it.' }]);
  });

  it('preserves a completed issue while filling in the published PR reference', async () => {
    const fixture = issueStoreFixture(issueFixture('done'));

    await synchronizePublishedOrchestrationIssue(publishedSnapshot(), fixture.store);

    expect(fixture.issue.status).toBe('done');
    expect(fixture.issue.prUrl).toBe('https://github.com/acme/shop/pull/42');
    expect(fixture.issue.comments).toHaveLength(1);
  });
});
