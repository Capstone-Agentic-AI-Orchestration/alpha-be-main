import { ALPHA_ORCHESTRATION_ENABLED } from '../config/env.js';
import { sqliteService } from './sqliteService.js';
import { runWithWorkspace } from './workspaceContext.js';
import { workspaceRegistry, type WorkspaceContext } from './workspaceRegistry.js';
import type { OrchestrationSnapshot } from './orchestrationStateMachine.js';
import { DomainRefusal, PlanNeedsYouError, type RefusalIssue } from './domainRefusal.js';

/** Shared action boundary for chat and the existing HTTP controls. */
/** A start that the Orchestrator turned into a corrected plan, waiting for the person to start it. */
export interface StartedOrCorrected extends OrchestrationSnapshot {
  corrected?: { planVersion: number; reason: string; changes: string[] };
}

/**
 * The saved plan failed its start check: it goes back to the Orchestrator once (never to the
 * person first). A corrected plan is saved as the next version and waits for Start again, with
 * a note in the conversation; if the correction fails, the person gets the reason and next steps.
 */
async function correctBeforeStart(context: WorkspaceContext, snapshot: OrchestrationSnapshot, failure: DomainRefusal & { issues: RefusalIssue[] }): Promise<StartedOrCorrected> {
  const { correctPlanBeforeStart } = await import('./boardPlanRevision.js');
  try {
    const correction = await correctPlanBeforeStart(context, snapshot.run.id, failure.issues);
    const { postPlanCorrectedNotice } = await import('./orchestrationChatNotice.js');
    await postPlanCorrectedNotice(sqliteService, correction.snapshot, correction.reason, correction.changes);
    return { ...correction.snapshot, corrected: { planVersion: correction.snapshot.run.planVersion, reason: correction.reason, changes: correction.changes } };
  } catch (error) {
    const { OrchestrationPlanningError } = await import('./orchestrationPlanner.js');
    if (error instanceof OrchestrationPlanningError) {
      const { saveRejectedPlans } = await import('./projectBuildOrchestrator.js');
      saveRejectedPlans(error, { projectId: snapshot.run.projectId, requestKey: snapshot.run.requestKey, goal: snapshot.run.plan.goal });
    }
    const detail = error instanceof Error ? error.message : 'The correction could not be made.';
    throw new PlanNeedsYouError(`This plan cannot start yet: ${failure.message} The Orchestrator tried one fix, but it did not work: ${detail} Tell the Orchestrator what to change, or stop the plan.`, failure.issues);
  }
}

export async function executeOrchestrationDecision(input: {
  context: WorkspaceContext; projectId: string; runId: string;
  action: 'start' | 'approve' | 'retry_publication'; expectedRevision?: number;
  threadId?: string; planVersion?: number;
}): Promise<StartedOrCorrected> {
  const { context, projectId, runId, action, expectedRevision } = input;
  if (!workspaceRegistry.can(context.role, action === 'start' ? 'squad.run' : 'build.publish') ||
      !workspaceRegistry.canAccessProjectBuilds(context, projectId)) throw new Error('Your workspace role cannot authorize this build action.');
  const snapshot = runWithWorkspace(context.workspaceId, () => sqliteService.getOrchestrationSnapshot(runId));
  if (!snapshot || snapshot.run.workspaceId !== context.workspaceId || snapshot.run.projectId !== projectId ||
      (input.threadId && snapshot.run.originChatThreadId !== input.threadId)) throw new Error('This build does not belong to this conversation and project.');
  if (input.threadId && (snapshot.run.revision !== expectedRevision || snapshot.run.planVersion !== input.planVersion)) {
    throw new Error('This plan or review changed. Read the current revision on the right, then reply again in the main chat.');
  }
  if (input.threadId && !runWithWorkspace(context.workspaceId, () => sqliteService.getOrchestrationPlans(runId))
    .some(plan => plan.version === input.planVersion)) throw new Error('The approved plan version is unavailable. Refresh the review.');
  if (input.threadId && runWithWorkspace(context.workspaceId, () => sqliteService.listChatPendingDecisions(projectId, input.threadId!)).length > 1) {
    throw new Error('More than one build is waiting for a decision in this conversation. Resolve the extra pending build first.');
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
  if (action !== 'start') return orchestrationService.approveAndPublish({ workspaceId: context.workspaceId, runId, expectedRevision, actorId: context.userId });
  let started: OrchestrationSnapshot;
  try {
    started = await orchestrationService.startPlannedWork({ workspaceId: context.workspaceId, runId, expectedRevision: expectedRevision!, actorId: context.userId });
  } catch (error) {
    // Only a failed plan check goes back to the Orchestrator; anything else is reported as it is.
    if (!(error instanceof DomainRefusal) || error.code !== 'plan_check') throw error;
    return correctBeforeStart(context, snapshot, error);
  }
  // Started from the card or from chat, the conversation says so and follows the agents from here.
  if (started.run.status === 'executing') {
    const { postStartedNotice } = await import('./orchestrationChatNotice.js');
    await postStartedNotice(sqliteService, started);
  }
  return started;
}
