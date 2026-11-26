import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OrchestrationRecoveryEpisode } from '../models/index.js';
import type { SQLiteService } from './sqliteService.js';
import { retirableTests, retiredTestTitles } from './orchestrationRecoveryPolicy.js';

/**
 * A task the test guard stopped over named tests: the person may retire them as obsolete in one
 * step. Alpha records exactly the tests that stop named, then retries the same specialist with them
 * left out of the guard and every other test still held.
 */

const retryTask = vi.fn();

afterEach(() => {
  delete process.env.ALPHA_ORCHESTRATION_ENABLED;
  vi.doUnmock('./orchestrationRuntime.js');
  vi.resetModules();
  retryTask.mockReset();
});

const TEST_FILE = 'tests/unit/App.spec.tsx';
const GUARD = `This task replaced test cases (“renders a custom title”) in ${TEST_FILE}. A task may add and update tests but not delete, skip or replace them or remove assertions. Restore what was removed and keep the update.`;

function fixture(input: { reason?: string; evidence?: Record<string, unknown> } = {}) {
  const reason = input.reason ?? GUARD;
  const snapshot: any = {
    run: { id: 'run-1', workspaceId: 'ws-1', projectId: 'project-1', issueId: 'issue-1', repository: 'acme/shop-be', createdBy: 'pm-1', status: 'blocked', revision: 9 },
    tasks: [{ id: 'storefront', title: 'Build the storefront', kind: 'frontend', repository: 'acme/shop-fe', status: 'failed', revision: 5, required: true,
      ownerAgentId: 'fe-agent', requirementIds: [], acceptanceCriteria: [], dependsOn: [], scope: { includePaths: ['src/**', 'tests/**'], excludePaths: [] } }],
    attempts: [1, 2, 3].map(number => ({ id: `attempt-${number}`, taskId: 'storefront', status: 'rejected', prototypeRunId: `p-${number}`,
      resultCommit: String(number).repeat(40), failureReason: reason, contextManifest: {}, createdAt: `2026-11-26T12:0${number}:00.000Z` })),
    artifacts: [],
    findings: [
      // An older attempt's finding names other tests; only the latest stop counts.
      { id: 'finding-old', taskId: 'storefront', status: 'open', severity: 'blocking', path: TEST_FILE,
        evidence: { check: 'test_weakened', changedPath: TEST_FILE, instruction: 'an older stop', testTitles: ['renders the default title'] } },
      { id: 'finding-1', taskId: 'storefront', status: 'open', severity: 'blocking', path: TEST_FILE,
        evidence: { check: 'test_weakened', changedPath: TEST_FILE, instruction: reason, ...input.evidence } }
    ]
  };
  let episode: OrchestrationRecoveryEpisode = {
    id: 'recovery-1', workspaceId: 'ws-1', projectId: 'project-1', runId: 'run-1', issueId: 'issue-1', taskId: 'storefront', attemptId: 'attempt-3',
    source: 'acceptance', category: 'project_code', code: 'acceptance_project_code', summary: reason,
    fingerprint: 'f', phase: 'waiting_for_user', episodeNumber: 1, repairBudget: 4, attemptsUsed: 3, threadId: 'thread-1', buildMessageId: 'build-1',
    initiatedBy: 'pm-1', revision: 2, createdAt: '2026-11-26T12:00:00.000Z', updatedAt: '2026-11-26T12:00:00.000Z', evidence: {}
  };
  const milestones: Array<{ key: string; content: string }> = [];
  const retired: unknown[] = [];
  const store = {
    getOrchestrationSnapshot: () => snapshot,
    getOrchestrationChatBinding: () => ({ threadId: 'thread-1', ownerId: 'pm-1', buildMessageId: 'build-1' }),
    getOrchestrationRecoveryEpisode: () => episode,
    getOpenOrchestrationRecoveryEpisode: () => episode,
    listOrchestrationRecoveryEpisodes: () => [episode],
    listOrchestrationEvents: () => [],
    listPendingOrchestrationRecoveryMilestones: () => [],
    createOrchestrationRecoveryAction: (action: any) => ({ created: true, action: { ...action, status: 'pending' } }),
    finishOrchestrationRecoveryAction: vi.fn(),
    retireTests: (call: { expectedRevision: number; tests: unknown[] }) => {
      retired.push(call);
      snapshot.run = { ...snapshot.run, revision: call.expectedRevision + 1 };
      snapshot.retiredTests = call.tests;
      return snapshot;
    },
    saveOrchestrationRecoveryEpisode: (save: { episode: OrchestrationRecoveryEpisode; milestone?: { key: string; content: string } }) => {
      episode = { ...save.episode, revision: episode.revision + 1 };
      if (save.milestone) milestones.push(save.milestone);
      return { episode, changed: true };
    }
  } as unknown as SQLiteService;
  return { snapshot, store, milestones, retired };
}

async function service(store: SQLiteService) {
  process.env.ALPHA_ORCHESTRATION_ENABLED = '1';
  vi.resetModules();
  vi.doMock('./orchestrationRuntime.js', () => ({ orchestrationService: { retryTask }, taskAcceptanceService: {} }));
  const { OrchestrationRecoveryService } = await import('./orchestrationRecoveryService.js');
  return new OrchestrationRecoveryService(store);
}

const act = { workspaceId: 'ws-1', projectId: 'project-1', runId: 'run-1', recoveryId: 'recovery-1', actorId: 'pm-1', canControl: true,
  expectedRunRevision: 9, expectedRecoveryRevision: 2, expectedTaskRevision: 5, action: 'retire_tests' as const };

describe('retiring obsolete tests', () => {
  it('offers the tests the latest stop named, records them, and retries the same specialist without them', async () => {
    const { snapshot, store, milestones, retired } = fixture({ evidence: { testTitles: ['renders a custom title'] } });
    retryTask.mockResolvedValue(snapshot);
    const recovery = await service(store);

    const state = await recovery.getState({ workspaceId: 'ws-1', runId: 'run-1', canControl: true });
    expect(state.recovery?.availableActions).toContain('retire_tests');
    expect(state.recovery?.retirableTests).toEqual([{ path: TEST_FILE, titles: ['renders a custom title'] }]);

    await recovery.executeAction({ ...act, expectedRecoveryRevision: state.recovery!.revision, idempotencyKey: 'retire-tests-0001' });

    expect(retired).toEqual([expect.objectContaining({ runId: 'run-1', expectedRevision: 9, actorId: 'pm-1',
      tests: [expect.objectContaining({ taskId: 'storefront', attemptId: 'attempt-3', repository: 'acme/shop-fe', path: TEST_FILE, titles: ['renders a custom title'] })] })]);
    // The retry starts at the revision the retirement left, with the retired tests named.
    expect(retryTask).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'storefront', expectedRunRevision: 10, actorId: 'pm-1',
      developerGuidance: expect.stringContaining(`The person retired these tests as obsolete, so they may be removed or replaced: ${TEST_FILE} (“renders a custom title”). Keep every other test`) }));
    expect(milestones).toContainEqual(expect.objectContaining({ key: 'tests_retired', content: expect.stringContaining('You retired an obsolete test for “Build the storefront”') }));
    expect(retiredTestTitles(snapshot, 'Acme/Shop-FE', TEST_FILE)).toEqual(['renders a custom title']);
    expect(retiredTestTitles(snapshot, 'acme/shop-be', TEST_FILE)).toEqual([]);
  });

  it('reads the tests from the guard sentence for a stop saved before they were listed, but not a shortened list', () => {
    expect(retirableTests(fixture().snapshot, 'storefront')).toEqual([{ path: TEST_FILE, titles: ['renders a custom title'] }]);
    const shortened = GUARD.replace('(“renders a custom title”)', '(“a”, “b”, “c”, …)');
    expect(retirableTests(fixture({ reason: shortened }).snapshot, 'storefront')).toEqual([]);
  });

  it('is not offered for a stop that is not about named tests', async () => {
    const lint = 'Required check “lint” was not observed passing on this attempt.';
    const removedAssertions = `This task removed assertions in ${TEST_FILE}. A task may add and update tests but not delete, skip or replace them or remove assertions. Restore what was removed and keep the update.`;
    for (const reason of [lint, removedAssertions]) {
      const { store } = fixture({ reason, evidence: reason === lint ? { check: 'required_check' } : { testTitles: [] } });
      const recovery = await service(store);
      const state = await recovery.getState({ workspaceId: 'ws-1', runId: 'run-1', canControl: true });
      expect(state.recovery?.availableActions).not.toContain('retire_tests');
      expect(state.recovery?.retirableTests).toBeUndefined();
      await expect(recovery.executeAction({ ...act, idempotencyKey: `retire-tests-${reason.length}` })).rejects.toThrow();
    }
    expect(retryTask).not.toHaveBeenCalled();
  });
});
