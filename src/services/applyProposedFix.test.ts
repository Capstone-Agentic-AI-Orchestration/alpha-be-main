import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OrchestrationRecoveryEpisode } from '../models/index.js';
import type { SQLiteService } from './sqliteService.js';

/**
 * A sensitive fix the Orchestrator held back is applied by the person in one step: the same guided
 * retry as typed direction, with the verified fix as the direction, recorded as theirs.
 */

const retryTask = vi.fn();

afterEach(() => {
  delete process.env.ALPHA_ORCHESTRATION_ENABLED;
  vi.doUnmock('./orchestrationRuntime.js');
  vi.resetModules();
  retryTask.mockReset();
});

function fixture() {
  const snapshot: any = {
    run: { id: 'run-1', workspaceId: 'ws-1', projectId: 'project-1', issueId: 'issue-1', repository: 'acme/shop-fe', createdBy: 'pm-1', status: 'blocked', revision: 9 },
    tasks: [{ id: 'booking-ui', title: 'Show bookings', kind: 'frontend', status: 'blocked', revision: 5, required: true, ownerAgentId: 'fe-agent',
      requirementIds: [], acceptanceCriteria: [], dependsOn: [], scope: { includePaths: ['src/**'], excludePaths: [] } }],
    attempts: [1, 2, 3].map(number => ({ id: `attempt-${number}`, taskId: 'booking-ui', status: 'rejected', prototypeRunId: `p-${number}`,
      failureReason: 'Required check “lint” was not observed passing on this attempt.', contextManifest: {}, createdAt: `2026-11-24T10:0${number}:00.000Z` })),
    artifacts: [], findings: []
  };
  let episode: OrchestrationRecoveryEpisode = {
    id: 'recovery-1', workspaceId: 'ws-1', projectId: 'project-1', runId: 'run-1', issueId: 'issue-1', taskId: 'booking-ui', attemptId: 'attempt-3',
    source: 'acceptance', category: 'project_code', code: 'acceptance_project_code', summary: 'Required check “lint” was not observed passing on this attempt.',
    fingerprint: 'f', phase: 'waiting_for_user', episodeNumber: 1, repairBudget: 4, attemptsUsed: 3, threadId: 'thread-1', buildMessageId: 'build-1',
    initiatedBy: 'pm-1', revision: 2, createdAt: '2026-11-24T10:00:00.000Z', updatedAt: '2026-11-24T10:00:00.000Z',
    evidence: { resolution: { outcome: 'escalated', escalation: 'sensitive', tier: 2, fingerprint: 'f', turn: true, startedAt: '',
      diagnosis: 'The session cookie name is hard-coded.',
      proposedFix: { instructions: 'Read the cookie name from src/auth/session.ts.', expectedFiles: [{ repository: 'acme/shop-fe', path: 'src/auth/session.ts' }] },
      citations: [{ source: 'repository', repository: 'acme/shop-fe', path: 'src/auth/session.ts', quote: 'export const SESSION_COOKIE', commit: 'c'.repeat(40) }] } }
  };
  const milestones: string[] = [];
  const store = {
    getOrchestrationSnapshot: () => snapshot,
    getOrchestrationChatBinding: () => ({ threadId: 'thread-1', ownerId: 'pm-1', buildMessageId: 'build-1' }),
    getOrchestrationRecoveryEpisode: () => episode,
    getOpenOrchestrationRecoveryEpisode: () => episode,
    listOrchestrationRecoveryEpisodes: () => [episode],
    listOrchestrationEvents: () => [],
    listPendingOrchestrationRecoveryMilestones: () => [],
    createOrchestrationRecoveryAction: (input: any) => ({ created: true, action: { ...input, status: 'pending' } }),
    finishOrchestrationRecoveryAction: vi.fn(),
    saveOrchestrationRecoveryEpisode: (input: { episode: OrchestrationRecoveryEpisode; milestone?: { key: string } }) => {
      episode = { ...input.episode, revision: episode.revision + 1 };
      if (input.milestone) milestones.push(input.milestone.key);
      return { episode, changed: true };
    }
  } as unknown as SQLiteService;
  return { snapshot, store, milestones, episode: () => episode };
}

describe('apply the proposed fix', () => {
  it('retries the task with the verified fix as direction and records who applied it', async () => {
    process.env.ALPHA_ORCHESTRATION_ENABLED = '1';
    vi.resetModules();
    vi.doMock('./orchestrationRuntime.js', () => ({ orchestrationService: { retryTask }, taskAcceptanceService: {} }));
    const { OrchestrationRecoveryService } = await import('./orchestrationRecoveryService.js');
    const { snapshot, store, milestones, episode } = fixture();
    retryTask.mockResolvedValue(snapshot);
    const recovery = new OrchestrationRecoveryService(store);

    await recovery.executeAction({
      workspaceId: 'ws-1', projectId: 'project-1', runId: 'run-1', recoveryId: 'recovery-1', actorId: 'pm-1', canControl: true,
      expectedRunRevision: 9, expectedRecoveryRevision: 2, expectedTaskRevision: 5, idempotencyKey: 'apply-fix-0001', action: 'apply_proposed_fix'
    });

    expect(retryTask).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'booking-ui', actorId: 'pm-1', developerGuidance: expect.stringContaining('Read the cookie name from src/auth/session.ts.')
    }));
    expect(String(retryTask.mock.calls[0][0].developerGuidance)).toContain('Evidence: acme/shop-fe:src/auth/session.ts.');
    expect(episode().evidence.resolution).toMatchObject({ outcome: 'retrying', appliedBy: 'pm-1' });
    expect(milestones).toContain('proposed_fix_applied');
  });

  it('shows a held-back fix saved before the shared redaction without its paths or credentials', async () => {
    process.env.ALPHA_ORCHESTRATION_ENABLED = '1';
    vi.resetModules();
    vi.doMock('./orchestrationRuntime.js', () => ({ orchestrationService: { retryTask }, taskAcceptanceService: {} }));
    const { OrchestrationRecoveryService } = await import('./orchestrationRecoveryService.js');
    const { store, episode } = fixture();
    const current = episode();
    const resolution = current.evidence.resolution as Record<string, any>;
    current.evidence = { resolution: { ...resolution,
      proposedFix: { ...resolution.proposedFix, instructions: 'Copy C:\\Users\\dev\\.env and use postgres://u:p4ss@db/x with client_secret=abc123.' },
      citations: [...resolution.citations, { source: 'product_picture', quote: 'Guests sign in with email.' }] } };

    const state = await new OrchestrationRecoveryService(store).getState({ workspaceId: 'ws-1', runId: 'run-1', canControl: true });
    const shown = state.recovery?.orchestratorResolution;

    expect(shown?.proposedFix).toBe('Copy [local path] and use postgres://[redacted]@db/x with client_secret=[redacted]');
    expect(shown?.evidence).toEqual(['acme/shop-fe:src/auth/session.ts', 'Product record']);
  });

  it('is not offered once there is no held-back fix', async () => {
    process.env.ALPHA_ORCHESTRATION_ENABLED = '1';
    vi.resetModules();
    vi.doMock('./orchestrationRuntime.js', () => ({ orchestrationService: { retryTask }, taskAcceptanceService: {} }));
    const { OrchestrationRecoveryService } = await import('./orchestrationRecoveryService.js');
    const { store, episode } = fixture();
    const current = episode();
    current.evidence = { resolution: { ...(current.evidence.resolution as object), proposedFix: undefined } };

    await expect(new OrchestrationRecoveryService(store).executeAction({
      workspaceId: 'ws-1', projectId: 'project-1', runId: 'run-1', recoveryId: 'recovery-1', actorId: 'pm-1', canControl: true,
      expectedRunRevision: 9, expectedRecoveryRevision: 2, expectedTaskRevision: 5, idempotencyKey: 'apply-fix-0002', action: 'apply_proposed_fix'
    })).rejects.toThrow();
    expect(retryTask).not.toHaveBeenCalled();
  });
});
