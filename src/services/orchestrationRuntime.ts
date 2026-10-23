import { sqliteService } from './sqliteService.js';
import { OrchestrationService } from './orchestrationService.js';
import { OrchestrationRunnerAdapter } from './orchestrationRunnerAdapter.js';
import { TaskAcceptanceService } from './taskAcceptanceService.js';
import { replayPublishedOrchestrationIssueEffects } from './orchestrationFinalization.js';
import { startOrchestrationEventOutboxWorker, type OrchestrationEventNotification } from './orchestrationEventDelivery.js';
import { logError, logInfo } from '../utils/logger.js';
import { runWithWorkspace } from './workspaceContext.js';
import { ALPHA_ORCHESTRATION_ENABLED } from '../config/env.js';
import { orchestrationRecoveryService } from './orchestrationRecoveryService.js';
import { milestonePlanner } from './orchestrationMilestonePlanner.js';

/** One local orchestrator/runner pair for the desktop's authoritative executor. */
export const orchestrationRunnerAdapter = new OrchestrationRunnerAdapter({ store: sqliteService });
export const orchestrationService = new OrchestrationService(sqliteService, orchestrationRunnerAdapter, undefined, milestonePlanner(sqliteService));
export const taskAcceptanceService = new TaskAcceptanceService(sqliteService, orchestrationService);

export function startOrchestrationEventDelivery(
  publish: (event: OrchestrationEventNotification) => void | Promise<void>,
  onFailure?: (error: unknown) => void
): () => void {
  return startOrchestrationEventOutboxWorker({ store: sqliteService, publish, onFailure });
}

orchestrationRunnerAdapter.attachResultHandlers({
  async handleRunnerCompleted(run) {
    const submitted = await orchestrationService.handleRunnerCompleted(run);
    if (!submitted?.run.currentTaskId) return submitted;
    const task = submitted.tasks.find(item => item.id === submitted.run.currentTaskId);
    const attempt = task && [...submitted.attempts].reverse().find(item => item.taskId === task.id && item.status === 'submitted');
    if (!task || !attempt) return submitted;
    const outcome = await taskAcceptanceService.evaluateAndAccept({
      workspaceId: submitted.run.workspaceId,
      runId: submitted.run.id,
      taskId: task.id,
      attemptId: attempt.id,
      acceptedBy: 'orchestrator',
      dispatchNext: ALPHA_ORCHESTRATION_ENABLED
    });
    if (!ALPHA_ORCHESTRATION_ENABLED && outcome.snapshot.run.status === 'executing') {
      await orchestrationService.pauseScheduling({
        workspaceId: submitted.run.workspaceId, runId: submitted.run.id,
        reason: 'The task result was saved, but the Orchestrator is unavailable in this desktop version. Update the app before continuing the build.'
      });
    }
    const latest = runWithWorkspace(submitted.run.workspaceId, () => sqliteService.getOrchestrationSnapshot(submitted.run.id));
    if (latest) {
      orchestrationRecoveryService.reconcileSnapshot(latest);
      await orchestrationRecoveryService.flushPendingMilestones();
    }
    return latest;
  },
  async handleRunnerFailed(run) {
    const snapshot = await orchestrationService.handleRunnerFailed(run);
    if (snapshot) {
      orchestrationRecoveryService.reconcileSnapshot(snapshot);
      await orchestrationRecoveryService.flushPendingMilestones();
    }
    return snapshot;
  },
  async handleRunnerCancelled(run) {
    const snapshot = await orchestrationService.handleRunnerCancelled(run);
    if (snapshot) {
      orchestrationRecoveryService.reconcileSnapshot(snapshot);
      await orchestrationRecoveryService.flushPendingMilestones();
    }
    return snapshot;
  }
});

/** Reconcile local task state after legacy run recovery has closed orphaned processes. */
export async function reconcileInterruptedOrchestrations(): Promise<void> {
  for (const snapshot of sqliteService.listAllActiveOrchestrationSnapshots()) {
    try {
      if (snapshot.run.status === 'validating') {
        await taskAcceptanceService.validateFinalState({
          workspaceId: snapshot.run.workspaceId, runId: snapshot.run.id, actorId: 'orchestrator'
        });
        continue;
      }
      if (snapshot.run.status === 'publishing') {
        await orchestrationService.approveAndPublish({
          workspaceId: snapshot.run.workspaceId,
          runId: snapshot.run.id,
          actorId: 'orchestrator'
        });
        continue;
      }
      if (snapshot.run.status === 'cancelling') {
        const activeTask = snapshot.run.currentTaskId
          ? snapshot.tasks.find(task => task.id === snapshot.run.currentTaskId)
          : undefined;
        const activeAttempt = activeTask && [...snapshot.attempts].reverse().find(attempt =>
          attempt.taskId === activeTask.id && ['starting', 'running', 'submitted'].includes(attempt.status));
        const prototypeRun = activeAttempt?.prototypeRunId
          ? runWithWorkspace(snapshot.run.workspaceId, () => sqliteService.getPrototypeRuns().find(run => run.id === activeAttempt.prototypeRunId))
          : undefined;
        if (prototypeRun?.status === 'cancelled') {
          runWithWorkspace(snapshot.run.workspaceId, () => sqliteService.cancelOrchestrationRun({
            runId: snapshot.run.id,
            actorId: 'orchestrator',
            reason: snapshot.run.stoppedReason ?? 'The specialist had stopped before Alpha restarted.'
          }));
        } else {
          runWithWorkspace(snapshot.run.workspaceId, () => sqliteService.markOrchestrationRecoveryRequired({
            runId: snapshot.run.id,
            actorId: 'orchestrator',
            reason: 'Alpha restarted before it could confirm that the specialist process stopped. Inspect the saved branch and process state before resuming.'
          }));
        }
        continue;
      }
      if (snapshot.run.status !== 'executing') continue;
      if (!snapshot.run.currentTaskId) {
        runWithWorkspace(snapshot.run.workspaceId, () => sqliteService.markOrchestrationRecoveryRequired({
          runId: snapshot.run.id,
          actorId: 'orchestrator',
          reason: 'The Alpha daemon restarted between tasks. The accepted checkpoint is preserved; review it and explicitly resume before another specialist starts.'
        }));
        continue;
      }
      const activeTask = snapshot.tasks.find(task => task.id === snapshot.run.currentTaskId);
      const activeAttempt = activeTask && [...snapshot.attempts].reverse().find(attempt =>
        attempt.taskId === activeTask.id && ['starting', 'running', 'submitted'].includes(attempt.status));
      if (activeTask?.status === 'submitted' && activeAttempt?.status === 'submitted') {
        const outcome = await taskAcceptanceService.evaluateAndAccept({
          workspaceId: snapshot.run.workspaceId, runId: snapshot.run.id,
          taskId: activeTask.id, attemptId: activeAttempt.id, acceptedBy: 'orchestrator',
          dispatchNext: false
        });
        if (outcome.snapshot.run.status === 'validating') {
          await taskAcceptanceService.validateFinalState({
            workspaceId: snapshot.run.workspaceId, runId: snapshot.run.id, actorId: 'orchestrator'
          });
        } else if (outcome.snapshot.run.status === 'executing' && !outcome.snapshot.run.currentTaskId) {
          runWithWorkspace(snapshot.run.workspaceId, () => sqliteService.markOrchestrationRecoveryRequired({
            runId: snapshot.run.id,
            actorId: 'orchestrator',
            reason: 'The last submitted result was recovered and checked. Review the accepted checkpoint and explicitly resume before Alpha dispatches another specialist.'
          }));
        }
        continue;
      }
      const prototypeRun = activeAttempt?.prototypeRunId
        ? runWithWorkspace(snapshot.run.workspaceId, () => sqliteService.getPrototypeRuns().find(run => run.id === activeAttempt.prototypeRunId))
        : undefined;
      if (activeAttempt && prototypeRun?.status === 'completed') {
        let recovered = await orchestrationService.handleRunnerCompleted(prototypeRun);
        const recoveredTask = recovered?.tasks.find(task => task.id === activeTask?.id);
        const recoveredAttempt = recovered?.attempts.find(attempt => attempt.id === activeAttempt.id);
        if (recovered && recoveredTask && recoveredAttempt?.status === 'submitted') {
          const outcome = await taskAcceptanceService.evaluateAndAccept({
            workspaceId: snapshot.run.workspaceId, runId: snapshot.run.id,
            taskId: recoveredTask.id, attemptId: recoveredAttempt.id, acceptedBy: 'orchestrator',
            dispatchNext: false
          });
          recovered = outcome.snapshot;
        }
        if (recovered?.run.status === 'validating') {
          await taskAcceptanceService.validateFinalState({
            workspaceId: snapshot.run.workspaceId, runId: snapshot.run.id, actorId: 'orchestrator'
          });
        } else if (recovered?.run.status === 'executing' && !recovered.run.currentTaskId) {
          runWithWorkspace(snapshot.run.workspaceId, () => sqliteService.markOrchestrationRecoveryRequired({
            runId: snapshot.run.id,
            actorId: 'orchestrator',
            reason: 'The completed process result was recovered and checked. Review the saved checkpoint and explicitly resume before Alpha dispatches more work.'
          }));
        }
        continue;
      }
      if (activeAttempt && prototypeRun?.status === 'failed') {
        await orchestrationService.handleRunnerFailed(prototypeRun);
        continue;
      }
      if (activeAttempt && prototypeRun?.status === 'cancelled') {
        await orchestrationService.handleRunnerCancelled(prototypeRun);
        continue;
      }
      // No process id and no run record: the launch never reached a specialist, so nothing
      // ran and the task is safe to retry. Saying so keeps the person from hunting for work.
      const neverStarted = activeAttempt?.status === 'starting' && !activeAttempt.prototypeRunId &&
        !runWithWorkspace(snapshot.run.workspaceId, () => sqliteService.getPrototypeRuns().some(run => run.orchestrationAttemptId === activeAttempt.id));
      runWithWorkspace(snapshot.run.workspaceId, () => sqliteService.markOrchestrationRecoveryRequired({
        runId: snapshot.run.id,
        actorId: 'orchestrator',
        reason: neverStarted
          ? 'Alpha restarted before the specialist started, so no agent ran and nothing changed. Continue to start the task again.'
          : 'The Alpha daemon restarted while a specialist was active. Its process is no longer attached; the branch and attempt evidence were preserved for review before a controlled retry.'
      }));
    } catch (error) {
      logError(`Could not reconcile task build ${snapshot.run.id}:`, error instanceof Error ? error.message : String(error));
    }
  }
  const issueReplay = await replayPublishedOrchestrationIssueEffects(
    sqliteService.listAllPublishedOrchestrationSnapshots()
  );
  for (const failure of issueReplay.failed) {
    logError(`Could not synchronize the approved task build ${failure.runId}:`, failure.reason);
  }
  for (const snapshot of sqliteService.listAllActiveOrchestrationSnapshots()) {
    try {
      orchestrationRecoveryService.reconcileSnapshot(snapshot);
    } catch (error) {
      logError(`Could not restore recovery details for task build ${snapshot.run.id}:`, error instanceof Error ? error.message : String(error));
    }
  }
  try {
    await orchestrationRecoveryService.flushPendingMilestones();
  } catch (error) {
    logError('Could not deliver saved orchestration recovery messages:', error instanceof Error ? error.message : String(error));
  }
  logInfo('Task orchestration recovery check completed.');
}
