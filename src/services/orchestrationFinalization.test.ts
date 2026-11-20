import { describe, expect, it } from 'vitest';
import type { Issue } from '../models/index.js';
import type { IssueStore } from '../store/issueStore.js';
import type { OrchestrationSnapshot } from './orchestrationStateMachine.js';
import { replayPublishedOrchestrationIssueEffects, synchronizePublishedOrchestrationIssue, type TeamBoard } from './orchestrationFinalization.js';
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
  const store: Pick<IssueStore, 'get' | 'update'> = {
    async get(_workspaceId, id) { return id === issue.id ? issue : null; },
    async update(_workspaceId, id, updates) {
      if (id !== issue.id) return null;
      updateCount++;
      issue = { ...issue, ...updates };
      return issue;
    }
  };
  return { store, get issue() { return issue; }, get updateCount() { return updateCount; } };
}

/** A team board holding its own copy of each card, which a share overwrites. */
function teamBoardFixture(initial: Record<string, Pick<Issue, 'status' | 'prUrl'>> = {}) {
  const cards = new Map(Object.entries(initial));
  const shared: Array<Pick<Issue, 'id' | 'status' | 'prUrl'>> = [];
  const board: TeamBoard = {
    async share(issue) {
      shared.push({ id: issue.id, status: issue.status, prUrl: issue.prUrl });
      cards.set(issue.id, { status: issue.status, prUrl: issue.prUrl });
      return true;
    },
    async isBehind(issue) {
      const card = cards.get(issue.id);
      return !card || card.status !== issue.status || (card.prUrl ?? null) !== (issue.prUrl ?? null);
    }
  };
  return { board, shared };
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
    const team = teamBoardFixture();
    await synchronizePublishedOrchestrationIssue(snapshot, fixture.store, team.board);
    await synchronizePublishedOrchestrationIssue(snapshot, fixture.store, team.board);
    expect(fixture.issue).toMatchObject({ status: 'review', subtasks: [{ ...subtasks[0], completed: true }] });
    expect(fixture.updateCount).toBe(1);
    expect(team.shared).toHaveLength(1);
  });

  it('finishes a read-only issue without a PR and replays its completion idempotently', async () => {
    const snapshot = publishedSnapshot();
    delete snapshot.run.publication;
    snapshot.tasks = [{ id: 'report', kind: 'requirements', required: true, status: 'accepted' }] as any;
    const fixture = issueStoreFixture(issueFixture('agent_running'));
    const team = teamBoardFixture();
    await synchronizePublishedOrchestrationIssue(snapshot, fixture.store, team.board);
    await replayPublishedOrchestrationIssueEffects([snapshot], fixture.store, team.board);
    expect(fixture.issue.status).toBe('review');
    expect(fixture.issue.prUrl).toBeUndefined();
    expect(fixture.issue.comments).toHaveLength(0);
    expect(fixture.updateCount).toBe(1);
    expect(team.shared).toEqual([{ id: 'issue-1', status: 'review', prUrl: undefined }]);
  });

  it('moves the card to review and sends it to the team board without writing a comment', async () => {
    const fixture = issueStoreFixture();
    const team = teamBoardFixture({ 'issue-1': { status: 'todo' } });

    await synchronizePublishedOrchestrationIssue(publishedSnapshot(), fixture.store, team.board);
    await synchronizePublishedOrchestrationIssue(publishedSnapshot(), fixture.store, team.board);

    expect(fixture.issue).toMatchObject({
      status: 'review',
      branchName: 'alpha/orchestration/run-1',
      prUrl: 'https://github.com/acme/shop/pull/42'
    });
    expect(fixture.issue.comments).toHaveLength(0);
    expect(fixture.updateCount).toBe(1);
    expect(team.shared).toEqual([{ id: 'issue-1', status: 'review', prUrl: 'https://github.com/acme/shop/pull/42' }]);
  });

  it('repairs a card that moved on this machine but never reached the team board', async () => {
    // How PRO-107 was left: review here, still Todo for the team.
    const fixture = issueStoreFixture({ ...issueFixture('review'), prUrl: 'https://github.com/acme/shop/pull/42', branchName: 'alpha/orchestration/run-1' });
    const team = teamBoardFixture({ 'issue-1': { status: 'todo' } });

    await replayPublishedOrchestrationIssueEffects([publishedSnapshot()], fixture.store, team.board);
    await replayPublishedOrchestrationIssueEffects([publishedSnapshot()], fixture.store, team.board);

    expect(fixture.updateCount).toBe(0);
    // Sent once to repair it, then never again: an unchanged write still reaches every teammate's sync.
    expect(team.shared).toEqual([{ id: 'issue-1', status: 'review', prUrl: 'https://github.com/acme/shop/pull/42' }]);
  });

  it('sends nothing when the team board already matches', async () => {
    const fixture = issueStoreFixture({ ...issueFixture('review'), prUrl: 'https://github.com/acme/shop/pull/42', branchName: 'alpha/orchestration/run-1' });
    const team = teamBoardFixture({ 'issue-1': { status: 'review', prUrl: 'https://github.com/acme/shop/pull/42' } });

    await replayPublishedOrchestrationIssueEffects([publishedSnapshot()], fixture.store, team.board);

    expect(team.shared).toHaveLength(0);
  });

  it('replays a publication after the issue update fails', async () => {
    const fixture = issueStoreFixture();
    const team = teamBoardFixture();
    let failStatusWrite = true;
    const store: Pick<IssueStore, 'get' | 'update'> = {
      get: (...args) => fixture.store.get(...args),
      async update(...args) {
        if (failStatusWrite) {
          failStatusWrite = false;
          return null;
        }
        return fixture.store.update(...args);
      }
    };

    await expect(synchronizePublishedOrchestrationIssue(publishedSnapshot(), store, team.board))
      .rejects.toThrow(/could not be synchronized/);
    expect(fixture.issue.status).toBe('todo');
    expect(team.shared).toHaveLength(0);

    const replay = await replayPublishedOrchestrationIssueEffects([publishedSnapshot()], store, team.board);

    expect(replay).toEqual({ synchronized: ['orchestration-1'], failed: [] });
    expect(fixture.issue.status).toBe('review');
    expect(fixture.updateCount).toBe(1);
    expect(team.shared).toHaveLength(1);
  });

  it('replays every published run and reports an unavailable issue without stopping the batch', async () => {
    const fixture = issueStoreFixture();
    const result = await replayPublishedOrchestrationIssueEffects(
      [publishedSnapshot(), { ...publishedSnapshot(), run: { ...publishedSnapshot().run, id: 'orchestration-missing', issueId: 'missing' } }],
      {
        async get(workspaceId, id) { return id === 'issue-1' ? fixture.store.get(workspaceId, id) : null; },
        update: (...args) => fixture.store.update(...args)
      },
      teamBoardFixture().board
    );

    expect(result.synchronized).toEqual(['orchestration-1']);
    expect(result.failed).toEqual([{ runId: 'orchestration-missing', reason: 'The project task for this published build is unavailable. Retry to synchronize it.' }]);
  });

  it('preserves a completed issue while filling in the published PR reference', async () => {
    const fixture = issueStoreFixture(issueFixture('done'));
    const team = teamBoardFixture();

    await synchronizePublishedOrchestrationIssue(publishedSnapshot(), fixture.store, team.board);

    expect(fixture.issue.status).toBe('done');
    expect(fixture.issue.prUrl).toBe('https://github.com/acme/shop/pull/42');
    expect(team.shared).toEqual([{ id: 'issue-1', status: 'done', prUrl: 'https://github.com/acme/shop/pull/42' }]);
  });
});
