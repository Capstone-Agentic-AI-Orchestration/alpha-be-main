import { ALPHA_ORCHESTRATION_ENABLED } from '../config/env.js';
import { sqliteService } from './sqliteService.js';
import { runWithWorkspace } from './workspaceContext.js';
import { workspaceRegistry, type WorkspaceContext } from './workspaceRegistry.js';

/** Shared action boundary for chat and the existing HTTP controls. */
export async function executeOrchestrationDecision(input: {
  context: WorkspaceContext; projectId: string; runId: string;
  action: 'start' | 'approve' | 'retry_publication'; expectedRevision?: number;
  threadId?: string; planVersion?: number;
}) {
  const { context, projectId, runId, action, expectedRevision } = input;
  if (!workspaceRegistry.can(context.role, action === 'start' ? 'squad.run' : 'deployment.manage') ||
      !workspaceRegistry.canAccessLiveBuildRoom(context, projectId)) throw new Error('Your workspace role cannot authorize this build action.');
  const snapshot = runWithWorkspace(context.workspaceId, () => sqliteService.getOrchestrationSnapshot(runId));
  if (!snapshot || snapshot.run.workspaceId !== context.workspaceId || snapshot.run.projectId !== projectId ||
      (input.threadId && snapshot.run.originChatThreadId !== input.threadId)) throw new Error('This build does not belong to this conversation and project.');
  if (input.threadId && (snapshot.run.revision !== expectedRevision || snapshot.run.planVersion !== input.planVersion)) {
    throw new Error('This plan or review changed. Read the current revision on the right, then reply again in the main chat.');
  }
  if (action === 'start') {
    if (!ALPHA_ORCHESTRATION_ENABLED) throw new Error('The Orchestrator is unavailable on this desktop.');
    if (snapshot.run.status !== 'awaiting_plan_approval') throw new Error('This plan is no longer waiting to start.');
    const visibility = await Promise.all([...new Set(snapshot.tasks.map(task => task.ownerAgentId))].map(id =>
      workspaceRegistry.canAccessProjectAgentRun(context, projectId, id)));
    if (visibility.some(value => !value)) throw new Error('A specialist in this plan is no longer available to this project.');
  } else if (input.threadId && (action === 'approve' ? snapshot.run.status !== 'awaiting_approval' : snapshot.run.status !== 'publishing')) {
    throw new Error('This build is not waiting for that publication decision.');
  }
  const { orchestrationService } = await import('./orchestrationRuntime.js');
  return action === 'start'
    ? orchestrationService.startPlannedWork({ workspaceId: context.workspaceId, runId, expectedRevision: expectedRevision!, actorId: context.userId })
    : orchestrationService.approveAndPublish({ workspaceId: context.workspaceId, runId, expectedRevision, actorId: context.userId });
}
