import { describe, expect, it, vi } from 'vitest';
import type { OrchestrationRecoveryEpisode } from '../models/index.js';
import type { OrchestrationSnapshot } from './orchestrationStateMachine.js';
import type { SQLiteService } from './sqliteService.js';
import { OrchestrationRecoveryService } from './orchestrationRecoveryService.js';

const reportError = "The specialist report is invalid: reportedChecks.0.result Required; reportedChecks.0 Unrecognized key(s) in object: 'name', 'status'.";

function snapshot(input: {
  status: 'executing' | 'blocked' | 'cancelled';
  taskStatus: 'running' | 'failed';
  correctionAttempts: number;
  revision?: number;
}): OrchestrationSnapshot {
  const attempts = [{
    id: 'attempt-original', taskId: 'review-calculator', status: 'rejected',
    failureReason: reportError,
    result: { agentReportError: reportError, rejectionReason: reportError },
    contextManifest: { reportOnlyReportRetry: false },
    createdAt: '2026-10-21T10:00:00.000Z'
  }];
  for (let index = 1; index <= input.correctionAttempts; index += 1) {
    const active = input.status === 'executing' && index === input.correctionAttempts;
    attempts.push({
      id: `attempt-correction-${index}`, taskId: 'review-calculator', status: active ? 'running' : 'rejected',
      failureReason: active ? undefined : reportError,
      result: active ? undefined : { agentReportError: reportError, rejectionReason: reportError },
      contextManifest: { reportOnlyReportRetry: true },
      createdAt: `2026-10-21T10:0${index}:00.000Z`
    } as typeof attempts[number]);
  }
  return {
    run: {
      id: 'run-1', workspaceId: 'workspace-1', projectId: 'project-1', issueId: 'issue-1',
      repository: 'acme/calculator', createdBy: 'owner-1', status: input.status,
      currentTaskId: input.status === 'executing' ? 'review-calculator' : undefined, revision: input.revision ?? 4
    },
    tasks: [{
      id: 'review-calculator', title: 'Independently review calculator changes', kind: 'review',
      status: input.taskStatus, ownerAgentId: 'reviewer-1', required: true, revision: 3,
      requirementIds: [], acceptanceCriteria: [], dependsOn: [], scope: { includePaths: [], excludePaths: [] }
    }],
    attempts,
    artifacts: [],
    findings: []
  } as unknown as OrchestrationSnapshot;
}

describe('orchestration recovery chat milestones', () => {
  it('does not let an old report finding hide a newer audit execution blocker', () => {
    const state = snapshot({ status: 'blocked', taskStatus: 'failed', correctionAttempts: 1 });
    state.tasks[0].kind = 'audit';
    const latest = state.attempts.at(-1)!;
    latest.failureReason = 'The dependency scanner could not reach the registry because of a network connection error.';
    latest.result = { rejectionReason: latest.failureReason };
    state.findings.push({ id: 'old-format', runId: 'run-1', taskId: state.tasks[0].id, sourceTaskId: state.tasks[0].id,
      severity: 'blocking', status: 'open', createdAt: state.attempts[0].createdAt, evidence: { check: 'agent_report' } });
    const store = {
      getOrchestrationChatBinding: () => ({ threadId: 'thread-1', ownerId: 'owner-1' }),
      getOpenOrchestrationRecoveryEpisode: () => undefined,
      listOrchestrationEvents: () => [], listOrchestrationRecoveryEpisodes: () => [],
      saveOrchestrationRecoveryEpisode: (input: { episode: OrchestrationRecoveryEpisode }) => ({ episode: input.episode, changed: true })
    } as unknown as SQLiteService;
    const episode = new OrchestrationRecoveryService(store).reconcileSnapshot(state)!;
    expect(episode.category).toBe('provider');
    expect(episode.summary).toContain('registry');
  });

  it('closes the recovery once when a build is cancelled and never reopens it for the failed task', () => {
    const opened: OrchestrationRecoveryEpisode = {
      id: 'recovery-1', workspaceId: 'workspace-1', projectId: 'project-1', runId: 'run-1', issueId: 'issue-1',
      taskId: 'review-calculator', source: 'orchestrator', category: 'project_code', code: 'process_exit',
      summary: 'Error: Process exited with error code: 2', fingerprint: 'f', phase: 'ready_to_continue',
      episodeNumber: 1, repairBudget: 2, attemptsUsed: 1, evidence: {}, threadId: 'thread-1',
      buildMessageId: 'build-1', initiatedBy: 'orchestrator', revision: 0,
      createdAt: '2026-10-21T10:00:00.000Z', updatedAt: '2026-10-21T10:00:00.000Z'
    } as unknown as OrchestrationRecoveryEpisode;
    let open: OrchestrationRecoveryEpisode | undefined = opened;
    const milestones: string[] = [];
    const store = {
      getOrchestrationChatBinding: vi.fn(() => ({
        runId: 'run-1', projectId: 'project-1', threadId: 'thread-1', buildMessageId: 'build-1', ownerId: 'owner-1'
      })),
      getOpenOrchestrationRecoveryEpisode: vi.fn(() => open),
      listOrchestrationEvents: vi.fn(() => []),
      saveOrchestrationRecoveryEpisode: vi.fn((input: { episode: OrchestrationRecoveryEpisode; milestone?: { key: string } }) => {
        if (input.milestone) milestones.push(input.milestone.key);
        open = ['repairing', 'waiting_for_user', 'ready_to_continue'].includes(input.episode.phase) ? input.episode : undefined;
        return { episode: input.episode, changed: true, milestone: undefined };
      })
    } as unknown as SQLiteService;
    const recovery = new OrchestrationRecoveryService(store);
    const cancelled = snapshot({ status: 'cancelled', taskStatus: 'failed', correctionAttempts: 0 });

    expect(recovery.reconcileSnapshot(cancelled)?.phase).toBe('cancelled');
    for (let check = 0; check < 5; check += 1) recovery.reconcileSnapshot(cancelled);

    expect(milestones).toEqual(['build_cancelled']);
    expect(store.saveOrchestrationRecoveryEpisode).toHaveBeenCalledTimes(1);
  });

  // Alpha's own report corrections stay out of the chat; the person hears once it needs them.
  it('keeps report corrections out of the chat and posts the exact report error when it needs the person', () => {
    let episode: OrchestrationRecoveryEpisode | undefined;
    const milestones: Array<{ key: string; content: string } | undefined> = [];
    const store = {
      getOrchestrationChatBinding: vi.fn(() => ({
        runId: 'run-1', projectId: 'project-1', threadId: 'thread-1', buildMessageId: 'build-1', ownerId: 'owner-1'
      })),
      getOpenOrchestrationRecoveryEpisode: vi.fn(() => episode),
      listOrchestrationEvents: vi.fn(() => []),
      listOrchestrationRecoveryEpisodes: vi.fn(() => episode ? [episode] : []),
      saveOrchestrationRecoveryEpisode: vi.fn((input: {
        episode: OrchestrationRecoveryEpisode;
        expectedRevision?: number;
        milestone?: { key: string; content: string };
      }) => {
        milestones.push(input.milestone);
        episode = {
          ...input.episode,
          revision: input.expectedRevision === undefined ? 0 : input.expectedRevision + 1
        };
        return { episode, changed: true, milestone: undefined };
      })
    } as unknown as SQLiteService;
    const recovery = new OrchestrationRecoveryService(store);

    const first = recovery.reconcileSnapshot(snapshot({ status: 'executing', taskStatus: 'running', correctionAttempts: 1 }))!;
    expect(first.phase).toBe('repairing');
    expect(milestones.at(-1)).toBeUndefined();

    const second = recovery.reconcileSnapshot(snapshot({ status: 'executing', taskStatus: 'running', correctionAttempts: 2 }))!;
    expect(second.phase).toBe('repairing');
    expect(milestones.filter(Boolean)).toEqual([]);

    const escalated = recovery.reconcileSnapshot(snapshot({ status: 'blocked', taskStatus: 'failed', correctionAttempts: 2 }))!;
    expect(escalated.phase).toBe('waiting_for_user');
    expect(milestones.at(-1)?.key).toContain('developer_action_needed');
    expect(milestones.at(-1)?.content).toContain(reportError);
    expect(milestones.at(-1)?.content).toContain('ask it once more for the summary');
  });

  it('explains the final failed implementation attempt after both automatic repairs', () => {
    let episode: OrchestrationRecoveryEpisode | undefined;
    const milestones: Array<{ key: string; content: string } | undefined> = [];
    const store = {
      getOrchestrationChatBinding: vi.fn(() => ({
        runId: 'run-1', projectId: 'project-1', threadId: 'thread-1', buildMessageId: 'build-1', ownerId: 'owner-1'
      })),
      getOpenOrchestrationRecoveryEpisode: vi.fn(() => episode),
      listOrchestrationEvents: vi.fn(() => []),
      listOrchestrationRecoveryEpisodes: vi.fn(() => episode ? [episode] : []),
      saveOrchestrationRecoveryEpisode: vi.fn((input: {
        episode: OrchestrationRecoveryEpisode;
        expectedRevision?: number;
        milestone?: { key: string; content: string };
      }) => {
        milestones.push(input.milestone);
        episode = {
          ...input.episode,
          revision: input.expectedRevision === undefined ? 0 : input.expectedRevision + 1
        };
        return { episode, changed: true, milestone: undefined };
      })
    } as unknown as SQLiteService;
    const recovery = new OrchestrationRecoveryService(store);
    const makeSnapshot = (failedCount: number, active: boolean, revision = 4): OrchestrationSnapshot => {
      const attempts: Array<Record<string, unknown>> = Array.from({ length: failedCount }, (_, index) => ({
        id: `attempt-failed-${index + 1}`,
        taskId: 'implement',
        status: 'failed',
        // Each failed implementation attempt ran a specialist process.
        prototypeRunId: `run-failed-${index + 1}`,
        failureReason: `TypeScript failed at src/repair-${['one', 'two', 'three', 'four'][index] ?? `attempt-${index + 1}`}.ts`,
        result: {},
        contextManifest: {},
        createdAt: `2026-10-21T10:0${index}:00.000Z`
      }));
      if (active) attempts.push({
        id: 'attempt-active-repair', taskId: 'implement', status: 'running', result: {}, contextManifest: {},
        createdAt: '2026-10-21T10:03:00.000Z'
      });
      return {
        run: {
          id: 'run-1', workspaceId: 'workspace-1', projectId: 'project-1', issueId: 'issue-1',
          repository: 'acme/calculator', createdBy: 'owner-1', status: active ? 'executing' : 'blocked',
          currentTaskId: active ? 'implement' : undefined, revision,
          stoppedReason: active ? undefined : 'The Orchestrator reviewed the failure; automatic repair attempts are used.'
        },
        tasks: [{
          id: 'implement', title: 'Implement calculator behavior', kind: 'backend',
          status: active ? 'running' : 'failed', ownerAgentId: 'backend-1', required: true, revision: 3,
          requirementIds: [], acceptanceCriteria: [], dependsOn: [], scope: { includePaths: ['src/**'], excludePaths: [] }
        }],
        attempts,
        artifacts: [],
        findings: []
      } as unknown as OrchestrationSnapshot;
    };

    const repairing = recovery.reconcileSnapshot(makeSnapshot(1, true))!;
    expect(repairing.phase).toBe('repairing');
    expect(milestones.at(-1)).toBeUndefined();

    const escalated = recovery.reconcileSnapshot(makeSnapshot(3, false))!;
    expect(escalated.phase).toBe('waiting_for_user');
    expect(milestones.at(-1)?.key).toContain('developer_action_needed');
    expect(milestones.at(-1)?.content).toContain('TypeScript failed at src/repair-three.ts');
    expect(milestones.at(-1)?.content).toContain('after the first try and two fixes');

    const firstEscalationKey = milestones.at(-1)?.key;
    const retryFailure = recovery.reconcileSnapshot(makeSnapshot(4, false, 5))!;
    expect(retryFailure.phase).toBe('waiting_for_user');
    expect(milestones.at(-1)?.key).not.toBe(firstEscalationKey);
    expect(milestones.at(-1)?.content).toContain('TypeScript failed at src/repair-four.ts');
  });
});
