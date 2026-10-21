import { describe, expect, it, vi } from 'vitest';
import type { OrchestrationRecoveryEpisode } from '../models/index.js';
import type { OrchestrationSnapshot } from './orchestrationStateMachine.js';
import type { SQLiteService } from './sqliteService.js';
import { OrchestrationRecoveryService } from './orchestrationRecoveryService.js';

const reportError = "The specialist report is invalid: reportedChecks.0.result Required; reportedChecks.0 Unrecognized key(s) in object: 'name', 'status'.";

function snapshot(input: {
  status: 'executing' | 'blocked';
  taskStatus: 'running' | 'failed';
  correctionAttempts: number;
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
      currentTaskId: input.status === 'executing' ? 'review-calculator' : undefined, revision: 4
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
  it('posts the exact report error as retries start and escalates after the bounded corrections', () => {
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
    expect(milestones.at(-1)?.key).toBe('report_correction_1');
    expect(milestones.at(-1)?.content).toContain(reportError);
    expect(milestones.at(-1)?.content).toContain('correction 1 of 2');

    const second = recovery.reconcileSnapshot(snapshot({ status: 'executing', taskStatus: 'running', correctionAttempts: 2 }))!;
    expect(second.phase).toBe('repairing');
    expect(milestones.at(-1)?.key).toBe('report_correction_2');
    expect(milestones.at(-1)?.content).toContain(reportError);
    expect(milestones.at(-1)?.content).toContain('correction 2 of 2');

    const escalated = recovery.reconcileSnapshot(snapshot({ status: 'blocked', taskStatus: 'failed', correctionAttempts: 2 }))!;
    expect(escalated.phase).toBe('waiting_for_user');
    expect(milestones.at(-1)?.key).toBe('developer_action_needed');
    expect(milestones.at(-1)?.content).toContain(reportError);
    expect(milestones.at(-1)?.content).toContain('one more bounded, read-only correction');
  });
});
