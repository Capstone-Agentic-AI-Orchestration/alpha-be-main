import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ snapshot: {} as any, allowed: true, visible: true, start: vi.fn(), publish: vi.fn() }));
vi.mock('../config/env.js', () => ({ ALPHA_ORCHESTRATION_ENABLED: true }));
vi.mock('./sqliteService.js', () => ({ sqliteService: { getOrchestrationSnapshot: () => mocks.snapshot,
  getOrchestrationPlans: () => [{ version: 2 }], listChatPendingDecisions: () => [mocks.snapshot] } }));
vi.mock('./workspaceRegistry.js', () => ({ workspaceRegistry: {
  can: () => mocks.allowed, canAccessProjectBuilds: () => mocks.allowed,
  canAccessProjectAgentRun: async () => mocks.visible
} }));
vi.mock('./orchestrationRuntime.js', () => ({ orchestrationService: { startPlannedWork: mocks.start, approveAndPublish: mocks.publish } }));
import { executeOrchestrationDecision } from './orchestrationDecision.js';
import { chatBuildDecisionSchema } from './chatBuildDecision.js';
const input = { context: { userId: 'alice', workspaceId: 'ws', role: 'admin' } as any,
  projectId: 'project', runId: 'run', threadId: 'thread', expectedRevision: 3, planVersion: 2, action: 'start' as const };
beforeEach(() => {
  vi.clearAllMocks(); mocks.allowed = true; mocks.visible = true;
  mocks.snapshot = { run: { id: 'run', workspaceId: 'ws', projectId: 'project', originChatThreadId: 'thread', revision: 3, planVersion: 2, status: 'awaiting_plan_approval' }, tasks: [{ ownerAgentId: 'frontend' }] };
  mocks.start.mockResolvedValue(mocks.snapshot); mocks.publish.mockResolvedValue(mocks.snapshot);
});
describe('shared orchestration decision boundary', () => {
  it('uses the existing scheduler with the authenticated actor and displayed revision', async () => {
    await executeOrchestrationDecision(input);
    expect(mocks.start).toHaveBeenCalledWith({ workspaceId: 'ws', runId: 'run', expectedRevision: 3, actorId: 'alice' });
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it.each([{ threadId: 'other' }, { projectId: 'other' }, { expectedRevision: 2 }, { planVersion: 1 }])('rejects an incorrect or stale decision reference: %j', async override => {
    await expect(executeOrchestrationDecision({ ...input, ...override })).rejects.toThrow();
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it('rejects revoked role or specialist access', async () => {
    mocks.allowed = false; await expect(executeOrchestrationDecision(input)).rejects.toThrow('role');
    mocks.allowed = true; mocks.visible = false; await expect(executeOrchestrationDecision(input)).rejects.toThrow('specialist');
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it('does not turn start/continue into publication consent', async () => {
    mocks.snapshot.run.status = 'awaiting_approval';
    await expect(executeOrchestrationDecision(input)).rejects.toThrow('no longer');
    await executeOrchestrationDecision({ ...input, action: 'approve' });
    expect(mocks.publish).toHaveBeenCalledTimes(1);
  });
  it('retries only a previously approved publication', async () => {
    await expect(executeOrchestrationDecision({ ...input, action: 'retry_publication' })).rejects.toThrow('not waiting');
    mocks.snapshot.run.status = 'publishing';
    await executeOrchestrationDecision({ ...input, action: 'retry_publication' });
    expect(mocks.publish).toHaveBeenCalledTimes(1);
  });
  it('validates decision metadata', () => {
    expect(chatBuildDecisionSchema.safeParse({ action: 'approve', runId: 'run', expectedRevision: -1, planVersion: 1, evidenceReady: true }).success).toBe(false);
  });
});
