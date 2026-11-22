import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ snapshot: {} as any, start: vi.fn(), correct: vi.fn(), notice: vi.fn(), saveRejected: vi.fn() }));
vi.mock('../config/env.js', () => ({ ALPHA_ORCHESTRATION_ENABLED: true }));
vi.mock('./sqliteService.js', () => ({ sqliteService: { getOrchestrationSnapshot: () => mocks.snapshot,
  getOrchestrationPlans: () => [{ version: 2 }], listChatPendingDecisions: () => [mocks.snapshot] } }));
vi.mock('./workspaceRegistry.js', () => ({ workspaceRegistry: { can: () => true, canAccessProjectBuilds: () => true, canAccessProjectAgentRun: async () => true } }));
vi.mock('./orchestrationRuntime.js', () => ({ orchestrationService: { startPlannedWork: mocks.start, approveAndPublish: vi.fn() } }));
vi.mock('./boardPlanRevision.js', () => ({ correctPlanBeforeStart: mocks.correct }));
vi.mock('./orchestrationChatNotice.js', () => ({ postPlanCorrectedNotice: mocks.notice, postStartedNotice: vi.fn() }));
vi.mock('./projectBuildOrchestrator.js', () => ({ saveRejectedPlans: mocks.saveRejected }));
vi.mock('./orchestrationPlanner.js', () => {
  class OrchestrationPlanningError extends Error { constructor(message: string, readonly code: string) { super(message); } }
  return { OrchestrationPlanningError };
});

import { executeOrchestrationDecision } from './orchestrationDecision.js';
import { DomainRefusal, PlanNeedsYouError } from './domainRefusal.js';
import { OrchestrationPlanningError } from './orchestrationPlanner.js';

const issue = { code: 'unassigned_repository', detail: 'No task is assigned to selected repository acme/api.' };
const input = { context: { userId: 'alice', workspaceId: 'ws', role: 'dev' } as any, projectId: 'project', runId: 'run', action: 'start' as const, expectedRevision: 3 };

/** A plan that fails its start check goes back to the Orchestrator once; the person sees a problem only if that fails. */
describe('a plan that fails its start check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.snapshot = { run: { id: 'run', workspaceId: 'ws', projectId: 'project', requestKey: 'key', revision: 3, planVersion: 2, status: 'awaiting_plan_approval', plan: { goal: 'Add login' } }, tasks: [{ ownerAgentId: 'frontend' }] };
    mocks.start.mockRejectedValue(new DomainRefusal(issue.detail, 'plan_check', [], [issue]));
  });

  it('is corrected into the next version, which waits for the person to start it', async () => {
    const corrected = { ...mocks.snapshot, run: { ...mocks.snapshot.run, revision: 4, planVersion: 3 } };
    mocks.correct.mockResolvedValue({ snapshot: corrected, reason: issue.detail, changes: ['Removed "Check the API".'] });
    const result = await executeOrchestrationDecision(input);
    expect(mocks.correct).toHaveBeenCalledWith(input.context, 'run', [issue]);
    expect(result.run.status).toBe('awaiting_plan_approval');
    expect(result.corrected).toEqual({ planVersion: 3, reason: issue.detail, changes: ['Removed "Check the API".'] });
    expect(mocks.notice).toHaveBeenCalledWith(expect.anything(), corrected, issue.detail, ['Removed "Check the API".']);
    expect(mocks.start).toHaveBeenCalledTimes(1);
  });

  it('asks the person, with the reason and next steps, when the one correction fails', async () => {
    const failure = new OrchestrationPlanningError('The Orchestrator tried one correction, but the plan still did not pass its checks.', 'invalid_plan');
    mocks.correct.mockRejectedValue(failure);
    const error = await executeOrchestrationDecision(input).catch(value => value);
    expect(error).toBeInstanceOf(PlanNeedsYouError);
    expect(error.message).toContain('This plan cannot start yet: No task is assigned to selected repository acme/api.');
    expect(error.message).toContain('Tell the Orchestrator what to change, or stop the plan.');
    expect(error.toBody()).toMatchObject({ code: 'plan_needs_you', actions: ['ask_orchestrator', 'open_plan', 'stop_plan'], issues: [issue] });
    expect(mocks.saveRejected).toHaveBeenCalledWith(failure, { projectId: 'project', requestKey: 'key', goal: 'Add login' });
    expect(mocks.notice).not.toHaveBeenCalled();
  });

  it('never sends anything other than a failed plan check to the Orchestrator', async () => {
    mocks.start.mockRejectedValue(new Error('The build plan changed after you opened it.'));
    await expect(executeOrchestrationDecision(input)).rejects.toThrow('changed after you opened it');
    expect(mocks.correct).not.toHaveBeenCalled();
  });
});
