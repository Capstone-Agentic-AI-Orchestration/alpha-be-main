import { executeOrchestrationDecision } from '../services/orchestrationDecision.js';
import { errorResponse } from './workflowErrorResponse.js';
import { DomainRefusal } from '../services/domainRefusal.js';
import { localPreviewService } from '../services/localPreviewService.js';
import { Request, Response, Router } from 'express';
import { ALPHA_ORCHESTRATION_ENABLED } from '../config/env.js';
import { issueStore, projectStore } from '../store/stores.js';
import { sqliteService } from '../services/sqliteService.js';
import { getOrchestrationDiffPreview, getOrchestrationLiveChanges, lostApprovalWorkingCopy } from '../services/orchestrationReviewService.js';
import { inspectOrchestrationPlanningWorktree, getOrchestrationPlanningRecoveryPreview, removeStaleOrchestrationPlanningWorktree } from '../services/orchestrationPlanningRecovery.js';
import { resolveProjectWorkspace } from '../services/workspaceService.js';
import { orchestrationSessionId } from '../services/orchestrationSession.js';
import { runWithWorkspace } from '../services/workspaceContext.js';
import { workspaceRegistry } from '../services/workspaceRegistry.js';
import { orchestrationRecoveryService } from '../services/orchestrationRecoveryService.js';
import type { OrchestrationSnapshot } from '../services/orchestrationStateMachine.js';
import { MAX_REVIEW_FEEDBACK_CHARS } from '../services/orchestrationReviewWorkflow.js';
import { createHash } from 'node:crypto';
import { boardBuildBlocker, requestBoardBuild, type BoardBuildRequest } from '../services/boardBuildRequests.js';
import { route } from './asyncRoute.js';
import { desktopOnly } from './desktopOnly.js';
import { requireProjectWorkspace, requireWorkspaceCapability } from './workspaceContext.js';

export const orchestrationRouter = Router();

orchestrationRouter.get('/projects/:projectId/orchestrations/:runId/recovery-candidate', desktopOnly, route(async (req: Request, res: Response) => {
  if (!authorizedProject(req, res, 'squad.read')) return;
  const snapshot = scopedSnapshot(req, res);
  if (!snapshot) return;
  if (!['blocked', 'recovery_required', 'paused'].includes(snapshot.run.status)) return res.status(409).json({ error: 'Saved-work inspection is available for stopped builds.' });
  const task = [...snapshot.tasks].reverse().find(item => ['failed', 'blocked'].includes(item.status));
  if (!task) return res.status(409).json({ error: 'There is no failed step to restart.' });
  const { repositoryWorkspaceForTask } = await import('../services/orchestrationWorkspace.js');
  const { worktreeChangesHash } = await import('../services/orchestrationWorktreeRecovery.js');
  const { workAttemptCount, reportFormatCorrectionCount, MAX_REPORT_FORMAT_CORRECTIONS, MAX_REPAIR_ATTEMPTS_PER_EPISODE } = await import('../services/orchestrationRecoveryPolicy.js');
  const workspace = repositoryWorkspaceForTask(snapshot, task.id);
  if (!workspace) return res.status(409).json({ error: 'The saved workspace is unavailable.' });
  const changes = await getOrchestrationLiveChanges(snapshot);
  const { listSavedArchives } = await import('../services/orchestrationSavedArchives.js');
  res.json({ runRevision: snapshot.run.revision, taskId: task.id, taskRevision: task.revision,
    candidateHash: await worktreeChangesHash(workspace.worktreePath), changes, archives: listSavedArchives(snapshot, task),
    restartAvailable: workspaceRegistry.canOperateAgents(req.workspace!.role) && snapshot.run.status === 'blocked' && (workAttemptCount(snapshot, task.id) >= MAX_REPAIR_ATTEMPTS_PER_EPISODE || reportFormatCorrectionCount(snapshot, task.id) >= MAX_REPORT_FORMAT_CORRECTIONS) &&
      (snapshot.recoveryAuthorizations ?? []).filter(item => item.taskId === task.id).length < 2 });
}));

orchestrationRouter.post('/projects/:projectId/orchestrations/:runId/restore-archive', desktopOnly, route(async (req: Request, res: Response) => {
  if (!authorizedProject(req, res, 'agent.run') || !requireWorkspaceCapability(req, res, 'chat.write')) return;
  const snapshot = scopedSnapshot(req, res);
  if (!snapshot) return;
  const { expectedRevision, taskId, archiveId, archiveHash, candidateHash } = req.body ?? {};
  if (!workspaceRegistry.canOperateAgents(req.workspace!.role) || !Number.isSafeInteger(expectedRevision) || typeof taskId !== 'string' || typeof archiveId !== 'string' || archiveId.length > 200 ||
      typeof archiveHash !== 'string' || !/^[a-f0-9]{64}$/.test(archiveHash) || typeof candidateHash !== 'string' || !/^[a-f0-9]{64}$/.test(candidateHash)) return res.status(400).json({ error: 'Inspect the archive and current candidate before restoring.' });
  const task = snapshot.tasks.find(item => item.id === taskId);
  if (!task || !await workspaceRegistry.canAccessProjectAgentRun(req.workspace!, req.params.projectId, task.ownerAgentId)) return res.status(404).json({ error: 'Task not found in this project.' });
  try {
    const { orchestrationService } = await import('../services/orchestrationRuntime.js');
    res.json(await orchestrationService.restoreArchivedCandidate({ workspaceId: req.workspace!.workspaceId, runId: snapshot.run.id, expectedRevision, taskId, archiveId, archiveHash, candidateHash, actorId: req.workspace!.userId }));
  } catch (error) { errorResponse(res, error); }
}));

orchestrationRouter.post('/projects/:projectId/orchestrations/:runId/restart-recovery', desktopOnly, route(async (req: Request, res: Response) => {
  if (!authorizedProject(req, res, 'agent.run') || !requireWorkspaceCapability(req, res, 'chat.write')) return;
  const snapshot = scopedSnapshot(req, res);
  if (!snapshot) return;
  const { expectedRevision, taskId, taskRevision, candidateHash, guidance } = req.body ?? {};
  if (!workspaceRegistry.canOperateAgents(req.workspace!.role) || !Number.isSafeInteger(expectedRevision) || !Number.isSafeInteger(taskRevision) || typeof taskId !== 'string' ||
      typeof candidateHash !== 'string' || !/^[a-f0-9]{64}$/.test(candidateHash) || typeof guidance !== 'string' || guidance.trim().length < 20 || guidance.length > 2000) {
    return res.status(400).json({ error: 'Review the candidate and describe the changed condition in 20–2,000 characters.' });
  }
  const task = snapshot.tasks.find(item => item.id === taskId);
  if (!task || !await workspaceRegistry.canAccessProjectAgentRun(req.workspace!, req.params.projectId, task.ownerAgentId)) return res.status(404).json({ error: 'Task not found in this project.' });
  try {
    const { orchestrationService } = await import('../services/orchestrationRuntime.js');
    const next = await orchestrationService.retryTask({ workspaceId: req.workspace!.workspaceId, runId: snapshot.run.id,
      expectedRunRevision: expectedRevision, taskId, expectedTaskRevision: taskRevision, actorId: req.workspace!.userId,
      developerGuidance: guidance.trim(), reviewedCandidateHash: candidateHash });
    await reconcileRecovery(next);
    res.json({ runId: next.run.id, status: next.run.status });
  } catch (error) { errorResponse(res, error); }
}));

orchestrationRouter.post('/projects/:projectId/orchestrations/:runId/revise-plan', desktopOnly, route(async (req: Request, res: Response) => {
  if (!authorizedProject(req, res, 'agent.run') || !requireWorkspaceCapability(req, res, 'chat.write')) return;
  if (!scopedSnapshot(req, res)) return;
  const { expectedRevision, instruction } = req.body ?? {};
  if (!Number.isSafeInteger(expectedRevision) || typeof instruction !== 'string' || !instruction.trim() || instruction.length > 2000) return res.status(400).json({ error: 'Supply the current revision and a revision request under 2,000 characters.' });
  try {
    const { reviseBoardPlan } = await import('../services/boardPlanRevision.js');
    const snapshot = await reviseBoardPlan(req.workspace!, req.params.runId, expectedRevision, instruction.trim());
    res.json({ runId: snapshot.run.id, revision: snapshot.run.revision, planVersion: snapshot.run.planVersion });
  } catch (error) { errorResponse(res, error); }
}));

orchestrationRouter.get('/projects/:projectId/orchestrations/:runId/delivery', desktopOnly, route(async (req: Request, res: Response) => {
  if (!authorizedProject(req, res, 'squad.read')) return;
  const snapshot = scopedSnapshot(req, res);
  if (!snapshot) return;
  const { orchestrationDeliveryService } = await import('../services/orchestrationDeliveryRuntime.js');
  res.set('Cache-Control', 'no-store');
  const record = orchestrationDeliveryService.ensure(snapshot);
  res.json({ delivery: record ? await orchestrationDeliveryService.refresh(req.workspace!.workspaceId, snapshot.run.id) : null,
    canControl: workspaceRegistry.can(req.workspace!.role, 'project.promote_uat'),
    canPromote: workspaceRegistry.can(req.workspace!.role, 'project.promote_uat') });
}));

orchestrationRouter.get('/projects/:projectId/orchestrations/:runId/delivery/events', desktopOnly, route(async (req: Request, res: Response) => {
  if (!authorizedProject(req, res, 'squad.read') || !scopedSnapshot(req, res)) return;
  const after = req.query.afterRevision === undefined ? 0 : Number(req.query.afterRevision);
  if (!Number.isSafeInteger(after) || after < 0) return res.status(400).json({ error: 'Choose a valid event revision.' });
  res.set('Cache-Control', 'no-store');
  res.json(runWithWorkspace(req.workspace!.workspaceId, () => sqliteService.listOrchestrationDeliveryEvents(req.params.runId, after)));
}));

orchestrationRouter.post('/projects/:projectId/orchestrations/:runId/delivery/actions', desktopOnly, route(async (req: Request, res: Response) => {
  if (!authorizedProject(req, res, 'project.promote_uat')) return;
  const snapshot = scopedSnapshot(req, res);
  if (!snapshot) return;
  const { action, expectedRevision, key } = req.body ?? {};
  if (!['enable_uat', 'pause_delivery', 'resume_delivery', 'merge_dev', 'prepare_uat', 'merge_uat', 'prepare_repair'].includes(action) ||
    !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || typeof key !== 'string' || !/^[A-Za-z0-9:_-]{8,100}$/.test(key)) {
    return res.status(400).json({ error: 'Choose a valid delivery action and current revision.' });
  }
  try {
    const { deliveryServiceForActor } = await import('../services/orchestrationDeliveryRuntime.js');
    const service = await deliveryServiceForActor(req.workspace!);
    res.json(await service.act({ context: req.workspace!, runId: snapshot.run.id, projectId: req.params.projectId,
      action, expectedRevision, key }));
  } catch (error) {
    const { DeliveryError } = await import('../services/orchestrationDelivery.js');
    if (error instanceof DeliveryError) return res.status(error.status).json({ error: error.message });
    return res.status(409).json({ error: 'Delivery could not finish this action. Refresh to reconcile GitHub before retrying.' });
  }
}));

async function reconcileRecovery(snapshot: OrchestrationSnapshot): Promise<void> {
  try {
    orchestrationRecoveryService.reconcileSnapshot(snapshot);
    await orchestrationRecoveryService.flushPendingMilestones();
  } catch {
    // Recovery messages are durable in the outbox; a later read or startup pass retries delivery.
  }
}

function authorizedProject(req: Request, res: Response, capability: Parameters<typeof workspaceRegistry.can>[1] = 'squad.run'): boolean {
  if (!requireWorkspaceCapability(req, res, capability)) return false;
  if (!requireProjectWorkspace(req, res, req.params.projectId)) return false;
  if (!workspaceRegistry.canAccessProjectBuilds(req.workspace!, req.params.projectId)) {
    res.status(404).json({ error: 'This project build is not available to this account.' });
    return false;
  }
  return true;
}

function scopedSnapshot(req: Request, res: Response) {
  const snapshot = runWithWorkspace(req.workspace!.workspaceId, () => sqliteService.getOrchestrationSnapshot(req.params.runId));
  if (!snapshot || snapshot.run.projectId !== req.params.projectId || snapshot.run.workspaceId !== req.workspace!.workspaceId) {
    res.status(404).json({ error: 'Task build not found in this project.' });
    return null;
  }
  return snapshot;
}

/**
 * The latest Orchestrator build status for each issue the caller can see, so
 * board cards can show build progress without loading every project build snapshot.
 */
orchestrationRouter.get('/issues/build-status', desktopOnly, route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'squad.read')) return;
  const projects = (await projectStore().list(req.workspace!.workspaceId))
    .filter(project => workspaceRegistry.canAccessProjectBuilds(req.workspace!, project.id));
  const issues = await issueStore().list(req.workspace!.workspaceId);
  const rows = runWithWorkspace(req.workspace!.workspaceId, () => {
    const latest = sqliteService.listLatestIssueBuilds(projects.map(project => project.id));
    const requests = sqliteService.listBoardBuildRequests(req.workspace!.workspaceId) as BoardBuildRequest[];
    const blockers = new Map(projects.map(project => [project.id, boardBuildBlocker(project)]));
    return issues.filter(issue => projects.some(project => project.id === issue.projectId)).map(issue => {
      const project = projects.find(item => item.id === issue.projectId)!;
      const build = latest.find(item => item.issueId === issue.id);
      const owner = blockers.get(project.id);
      const blocker = owner && owner.issueId !== issue.id ? {
        status: owner.status, repository: owner.repository,
        ...(owner.projectId && workspaceRegistry.canAccessProjectBuilds(req.workspace!, owner.projectId)
          ? { projectId: owner.projectId, issueId: owner.issueId, runId: owner.runId,
            identifier: issues.find(item => item.id === owner.issueId)?.identifier } : {})
      } : undefined;
      const latestRequest = [...requests].reverse().find(item => item.issueId === issue.id && item.ownerId === req.workspace!.userId);
      const request = latestRequest && !['accepted', 'cancelled'].includes(latestRequest.status) ? latestRequest : undefined;
      return { ...(build ?? { issueId: issue.id, projectId: issue.projectId, runId: '', status: 'none', updatedAt: issue.updatedAt }),
        blocker, request: request ? { id: request.id, status: request.status, reason: request.reason } : undefined,
        fresh: true, observedAt: new Date().toISOString() };
    });
  });
  // Only builds waiting for approval are checked: their working copy must still hold the reviewed commit.
  for (const row of rows) {
    if (row.status !== 'awaiting_approval' || !row.runId) continue;
    const project = projects.find(item => item.id === row.projectId);
    const snapshot = runWithWorkspace(req.workspace!.workspaceId, () => sqliteService.getOrchestrationSnapshot(row.runId));
    if (!project || !snapshot) continue;
    const lost = await runWithWorkspace(req.workspace!.workspaceId, () =>
      lostApprovalWorkingCopy(snapshot, repository => resolveProjectWorkspace(project, repository)?.dir));
    if (lost) Object.assign(row, { workspaceLost: true });
  }
  res.json(rows);
}));

orchestrationRouter.post('/projects/:projectId/issues/:issueId/build-request', desktopOnly, route(async (req: Request, res: Response) => {
  if (!authorizedProject(req, res, 'agent.run') || !requireWorkspaceCapability(req, res, 'chat.write')) return;
  if (!workspaceRegistry.canOperateAgents(req.workspace!.role)) return res.status(403).json({ error: 'Your workspace role cannot request AI builds.' });
  const [project, issue] = await Promise.all([projectStore().get(req.workspace!.workspaceId, req.params.projectId), issueStore().get(req.workspace!.workspaceId, req.params.issueId)]);
  if (!project || !issue || issue.projectId !== project.id) return res.status(404).json({ error: 'Task not found in this project.' });
  const { requestId, instructions = '', queue = false } = req.body ?? {};
  if (typeof requestId !== 'string' || !/^[\w-]{8,100}$/.test(requestId) || typeof instructions !== 'string' || instructions.length > 2000 || typeof queue !== 'boolean') {
    return res.status(400).json({ error: 'Supply a request ID and at most 2,000 characters of developer instructions.' });
  }
  try {
    const id = 'board-request-' + createHash('sha256').update(JSON.stringify([req.workspace!.workspaceId, req.workspace!.userId, requestId])).digest('hex');
    const result = await requestBoardBuild({ context: req.workspace!, issue, project, requestId: id, instructions: instructions.trim(), queue });
    res.status(202).json({ id: result.id, threadId: result.threadId, status: result.status, reason: result.reason });
  } catch (error) { errorResponse(res, error); }
}));

orchestrationRouter.post('/projects/:projectId/build-requests/:requestId/cancel', desktopOnly, route(async (req: Request, res: Response) => {
  if (!authorizedProject(req, res, 'agent.run')) return;
  const record = sqliteService.listBoardBuildRequests(req.workspace!.workspaceId).find(item => item.id === req.params.requestId && item.ownerId === req.workspace!.userId && item.projectId === req.params.projectId);
  if (!record) return res.status(404).json({ error: 'Planning request not found.' });
  if (record.status !== 'waiting') return res.status(409).json({ error: 'Only a waiting request can be removed. Open the task build for accepted work.' });
  sqliteService.saveBoardBuildRequest({ ...record, status: 'cancelled', updatedAt: new Date().toISOString() } as BoardBuildRequest);
  res.json({ status: 'cancelled' });
}));

orchestrationRouter.get('/projects/:projectId/orchestrations/:runId/plans', desktopOnly, route(async (req: Request, res: Response) => {
  if (!authorizedProject(req, res, 'squad.read')) return;
  const snapshot = scopedSnapshot(req, res);
  if (!snapshot) return;
  const documents = runWithWorkspace(req.workspace!.workspaceId, () => sqliteService.ensureOrchestrationPlanDocuments(snapshot.run.id));
  res.json({ documents });
}));

orchestrationRouter.get('/projects/:projectId/orchestrations/:runId/recovery', desktopOnly, route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'squad.read')) return;
  if (!requireProjectWorkspace(req, res, req.params.projectId)) return;
  if (!workspaceRegistry.canAccessProjectBuilds(req.workspace!, req.params.projectId)) {
    return res.status(404).json({ error: 'This project build is not available to this account.' });
  }
  const snapshot = scopedSnapshot(req, res);
  if (!snapshot) return;
  try {
    const state = await orchestrationRecoveryService.getState({
      workspaceId: req.workspace!.workspaceId,
      runId: snapshot.run.id,
      canControl: workspaceRegistry.can(req.workspace!.role, 'squad.run')
    });
    res.json(state);
  } catch (error) {
    errorResponse(res, error);
  }
}));

orchestrationRouter.post('/projects/:projectId/orchestrations/:runId/recovery/actions', desktopOnly, route(async (req: Request, res: Response) => {
  if (!authorizedProject(req, res)) return;
  const snapshot = scopedSnapshot(req, res);
  if (!snapshot) return;
  const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
  const actionNames = ['explain_failure', 'retry_report_format', 'repair_and_continue', 'provide_guidance', 'apply_proposed_fix', 'retire_tests', 'recheck_prerequisite',
    'plan_final_validation_corrections', 'resume_checkpoint', 'review_saved_changes', 'keep_paused', 'cancel_build'] as const;
  const integerFields = ['expectedRunRevision', 'expectedRecoveryRevision'] as const;
  if (!integerFields.every(key => Number.isSafeInteger(body[key]) && Number(body[key]) >= 0) ||
      (body.expectedTaskRevision !== undefined && (!Number.isSafeInteger(body.expectedTaskRevision) || Number(body.expectedTaskRevision) < 0))) {
    return res.status(400).json({ error: 'The build and recovery versions must be non-negative whole numbers.' });
  }
  if (typeof body.recoveryId !== 'string' || body.recoveryId.length > 160 ||
      typeof body.idempotencyKey !== 'string' || !/^[A-Za-z0-9:_-]{8,160}$/.test(body.idempotencyKey) ||
      typeof body.action !== 'string' || !actionNames.includes(body.action as typeof actionNames[number])) {
    return res.status(400).json({ error: 'Choose a valid recovery action and refresh the build details before continuing.' });
  }
  if (body.guidance !== undefined && (typeof body.guidance !== 'string' || body.guidance.length > 2_000)) {
    return res.status(400).json({ error: 'Keep your direction under 2,000 characters.' });
  }
  if (body.threadId !== undefined && (typeof body.threadId !== 'string' || body.threadId.length > 200)) {
    return res.status(400).json({ error: 'This chat could not be linked to the selected build. Refresh and try again.' });
  }
  const episode = runWithWorkspace(req.workspace!.workspaceId, () =>
    sqliteService.getOrchestrationRecoveryEpisode(snapshot.run.id, body.recoveryId as string));
  if (episode?.taskId) {
    const task = snapshot.tasks.find(item => item.id === episode.taskId);
    if (!task || !await workspaceRegistry.canAccessProjectAgentRun(req.workspace!, req.params.projectId, task.ownerAgentId)) {
      return res.status(404).json({ error: 'This recovery is not available to this account.' });
    }
  }
  try {
    const result = await orchestrationRecoveryService.executeAction({
      workspaceId: req.workspace!.workspaceId,
      projectId: req.params.projectId,
      runId: snapshot.run.id,
      recoveryId: body.recoveryId as string,
      actorId: req.workspace!.userId,
      canControl: workspaceRegistry.can(req.workspace!.role, 'squad.run'),
      expectedRunRevision: Number(body.expectedRunRevision),
      expectedRecoveryRevision: Number(body.expectedRecoveryRevision),
      expectedTaskRevision: body.expectedTaskRevision === undefined ? undefined : Number(body.expectedTaskRevision),
      idempotencyKey: body.idempotencyKey as string,
      action: body.action as typeof actionNames[number],
      guidance: typeof body.guidance === 'string' ? body.guidance : undefined,
      threadId: typeof body.threadId === 'string' ? body.threadId : undefined
    });
    res.json(result);
  } catch (error) {
    errorResponse(res, error);
  }
}));

orchestrationRouter.get('/projects/:projectId/orchestrations/:runId/events', desktopOnly, route(async (req: Request, res: Response) => {
  if (!authorizedProject(req, res)) return;
  const snapshot = scopedSnapshot(req, res);
  if (!snapshot) return;

  const afterValue = req.query.after;
  const limitValue = req.query.limit;
  const after = afterValue === undefined ? 0
    : typeof afterValue === 'string' && /^(0|[1-9]\d*)$/.test(afterValue) ? Number(afterValue) : NaN;
  const limit = limitValue === undefined ? 100
    : typeof limitValue === 'string' && /^(0|[1-9]\d*)$/.test(limitValue) ? Number(limitValue) : NaN;
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    return res.status(400).json({ error: 'after must be a non-negative cursor and limit must be between 1 and 500.' });
  }

  const events = runWithWorkspace(req.workspace!.workspaceId, () =>
    sqliteService.listOrchestrationEvents(snapshot.run.id, after, limit));
  const safeEvents = events.map(event => ({
    id: event.id,
    eventId: event.eventId,
    sequence: event.sequence,
    type: event.type,
    createdAt: event.createdAt
  }));
  res.json({
    runId: snapshot.run.id,
    events: safeEvents,
    nextCursor: safeEvents.at(-1)?.id ?? after,
    hasMore: events.length === limit
  });
}));

orchestrationRouter.get('/projects/:projectId/orchestrations/:runId/diff', desktopOnly, route(async (req: Request, res: Response) => {
  if (!authorizedProject(req, res, 'squad.read')) return;
  const snapshot = scopedSnapshot(req, res);
  if (!snapshot) return;
  try {
    res.json(await getOrchestrationDiffPreview(snapshot));
  } catch (error) {
    errorResponse(res, error);
  }
}));

/** Live edits for the chat's side panel: what each worktree holds now, compared with where the build started. */
orchestrationRouter.get('/projects/:projectId/orchestrations/:runId/live-changes', desktopOnly, route(async (req: Request, res: Response) => {
  if (!authorizedProject(req, res, 'squad.read')) return;
  const snapshot = scopedSnapshot(req, res);
  if (!snapshot) return;
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await getOrchestrationLiveChanges(snapshot));
  } catch (error) {
    errorResponse(res, error);
  }
}));

orchestrationRouter.post('/projects/:projectId/orchestrations/:runId/start', desktopOnly, route(async (req: Request, res: Response) => {
  if (!authorizedProject(req, res)) return;
  const snapshot = scopedSnapshot(req, res);
  if (!snapshot) return;
  if (!ALPHA_ORCHESTRATION_ENABLED) {
    return res.status(409).json({ error: 'The Orchestrator is unavailable on this desktop. Update the desktop app before starting planned work.' });
  }
  const expectedRevision = req.body?.expectedRevision;
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    return res.status(400).json({ error: 'expectedRevision must be a non-negative integer.' });
  }
  if (snapshot.run.status !== 'awaiting_plan_approval') {
    return res.status(409).json({ error: 'This plan is no longer waiting to start. Refresh the project build review to see its current state.' });
  }
  const taskOwners = [...new Set(snapshot.tasks.map(task => task.ownerAgentId))];
  const ownerVisibility = await Promise.all(taskOwners.map(agentId =>
    workspaceRegistry.canAccessProjectAgentRun(req.workspace!, req.params.projectId, agentId)));
  if (ownerVisibility.some(visible => !visible)) {
    return res.status(409).json({ error: 'A specialist in this plan is no longer available to this project. Cancel this plan and create a fresh one.' });
  }
  try {
    const started = await executeOrchestrationDecision({
      context: req.workspace!, projectId: req.params.projectId, runId: snapshot.run.id,
      action: 'start', expectedRevision
    });
    await reconcileRecovery(started);
    res.json({ runId: started.run.id, status: started.run.status, currentTaskId: started.run.currentTaskId,
      ...(started.corrected ? { corrected: started.corrected } : {}) });
  } catch (error) {
    errorResponse(res, error);
  }
}));

orchestrationRouter.get('/projects/:projectId/planning-recoveries/:runId/diff', desktopOnly, route(async (req: Request, res: Response) => {
  if (!authorizedProject(req, res)) return;
  const recovery = runWithWorkspace(req.workspace!.workspaceId, () =>
    sqliteService.getOrchestrationPlanningRecovery(req.params.projectId, req.params.runId));
  if (!recovery || !['needs_review', 'retained'].includes(recovery.state)) {
    return res.status(404).json({ error: 'This saved planning workspace cannot be previewed safely.' });
  }
  try {
    res.json(await runWithWorkspace(req.workspace!.workspaceId, () => getOrchestrationPlanningRecoveryPreview({
      projectId: req.params.projectId,
      runId: req.params.runId,
      store: sqliteService
    })));
  } catch (error) {
    errorResponse(res, error);
  }
}));

orchestrationRouter.post('/projects/:projectId/planning-recoveries/:runId/inspect', desktopOnly, route(async (req: Request, res: Response) => {
  if (!authorizedProject(req, res)) return;
  const workspaceId = req.workspace!.workspaceId;
  const existing = runWithWorkspace(workspaceId, () =>
    sqliteService.getOrchestrationPlanningRecovery(req.params.projectId, req.params.runId));
  if (existing && existing.state !== 'manual_review') {
    return res.json({
      runId: existing.runId,
      state: existing.state,
      revision: existing.revision,
      reason: existing.reason
    });
  }
  const reservation = runWithWorkspace(workspaceId, () =>
    sqliteService.getOrchestrationPlanningReservationByRun(req.params.projectId, req.params.runId));
  if (!reservation) {
    if (existing) return res.json({ runId: existing.runId, state: existing.state, revision: existing.revision, reason: existing.reason });
    return res.status(404).json({ error: 'The interrupted planning reservation is no longer active.' });
  }
  if (reservation.ownerSessionId === orchestrationSessionId) {
    return res.status(409).json({ error: 'This planner still belongs to the active Alpha session. Refresh the build review after it finishes.' });
  }
  const project = await projectStore().get(workspaceId, req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  const repositoryWorkspace = runWithWorkspace(workspaceId, () => resolveProjectWorkspace(project, reservation.repository));
  if (!repositoryWorkspace) return res.status(409).json({ error: 'The repository checkout is not available on this desktop. Restore its project binding before recovering the planning workspace.' });

  const inspection = await runWithWorkspace(workspaceId, () =>
    inspectOrchestrationPlanningWorktree({ projectId: project.id, reservation, repositoryDir: repositoryWorkspace.dir }));
  if (inspection.safeToRetire || inspection.state === 'missing') {
    const removed = await runWithWorkspace(workspaceId, () => removeStaleOrchestrationPlanningWorktree({
      repositoryDir: repositoryWorkspace.dir,
      projectId: project.id,
      reservation
    }));
    if (!removed) return res.status(409).json({ error: 'The saved workspace changed during inspection. It was preserved; refresh the build review to review it.' });
    const cleaned = runWithWorkspace(workspaceId, () => sqliteService.cleanOrchestrationPlanningReservation({
      projectId: project.id, runId: reservation.runId, reservation, actorId: req.workspace!.userId
    }));
    return res.json({ runId: reservation.runId, state: cleaned.recoveryState, revision: cleaned.revision });
  }

  const recovery = runWithWorkspace(workspaceId, () => sqliteService.recordOrchestrationPlanningRecovery({
    projectId: project.id,
    reservation,
    state: inspection.canPreview ? 'needs_review' : 'manual_review',
    reason: inspection.canPreview
      ? `Planning stopped before a task plan was activated. The saved private workspace was preserved for review. ${inspection.reason ?? 'It differs from its reserved clean base.'}`
      : `Planning stopped before a task plan was activated. The saved workspace was preserved and repository admission remains paused. ${inspection.reason ?? 'Alpha could not verify the saved workspace identity.'}`
  }));
  res.json({ runId: recovery.runId, state: recovery.state, revision: recovery.revision, reason: recovery.reason });
}));

orchestrationRouter.post('/projects/:projectId/planning-recoveries/:runId/retain', desktopOnly, route(async (req: Request, res: Response) => {
  if (!authorizedProject(req, res)) return;
  const expectedRevision = req.body?.expectedRevision;
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    return res.status(400).json({ error: 'expectedRevision must be a non-negative integer.' });
  }
  try {
    const retained = runWithWorkspace(req.workspace!.workspaceId, () => sqliteService.retainOrchestrationPlanningRecovery({
      projectId: req.params.projectId,
      runId: req.params.runId,
      expectedRevision,
      actorId: req.workspace!.userId
    }));
    res.json({ runId: retained.runId, state: retained.state, revision: retained.revision });
  } catch (error) {
    errorResponse(res, error);
  }
}));

orchestrationRouter.post('/projects/:projectId/orchestrations/:runId/audit-plan', desktopOnly, route(async (req: Request, res: Response) => {
  if (!ALPHA_ORCHESTRATION_ENABLED) return res.status(409).json({ error: 'Task orchestration is disabled.' });
  if (!authorizedProject(req, res) || !scopedSnapshot(req, res)) return;
  const expectedRevision = req.body?.expectedRevision;
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return res.status(400).json({ error: 'expectedRevision must be a non-negative integer.' });
  try {
    const { orchestrationService } = await import('../services/orchestrationRuntime.js');
    const next = await orchestrationService.proposeAuditReplan({ workspaceId: req.workspace!.workspaceId, runId: req.params.runId, expectedRevision, actorId: req.workspace!.userId });
    res.json({ runId: next.run.id, status: next.run.status, revision: next.run.revision, planVersion: next.run.planVersion });
  } catch (error) { errorResponse(res, error); }
}));

orchestrationRouter.post('/projects/:projectId/orchestrations/:runId/tasks/:taskId/retry', desktopOnly, route(async (req: Request, res: Response) => {
  if (!authorizedProject(req, res)) return;
  const snapshot = scopedSnapshot(req, res);
  if (!snapshot) return;
  const task = snapshot.tasks.find(item => item.id === req.params.taskId);
  if (!task) return res.status(404).json({ error: 'Task not found in this build.' });
  if (!await workspaceRegistry.canAccessProjectAgentRun(req.workspace!, req.params.projectId, task.ownerAgentId)) {
    return res.status(404).json({ error: 'Task not found in this project.' });
  }
  const expectedTaskRevision = req.body?.expectedTaskRevision;
  if (!Number.isSafeInteger(expectedTaskRevision) || expectedTaskRevision < 0) {
    return res.status(400).json({ error: 'expectedTaskRevision must be a non-negative integer.' });
  }
  // The same rule as the recovery panel: a specialist that lacks information meets the same
  // blocker again on a plain retry, so it needs direction, from the panel or the chat.
  const { isSpecialistBlocker, specialistBlockerDirectionMessage } = await import('../services/orchestrationRecoveryPolicy.js');
  const latestFailure = [...snapshot.attempts].reverse().find(attempt => attempt.taskId === task.id && attempt.failureReason)?.failureReason;
  if (isSpecialistBlocker(latestFailure)) {
    return errorResponse(res, new DomainRefusal(specialistBlockerDirectionMessage(latestFailure!), 'needs_direction', ['ask_orchestrator']));
  }
  try {
    const { orchestrationService } = await import('../services/orchestrationRuntime.js');
    const next = await orchestrationService.retryTask({
      workspaceId: req.workspace!.workspaceId,
      runId: snapshot.run.id,
      taskId: task.id,
      expectedTaskRevision,
      actorId: req.workspace!.userId
    });
    await reconcileRecovery(next);
    res.json({ runId: next.run.id, status: next.run.status, currentTaskId: next.run.currentTaskId });
  } catch (error) {
    errorResponse(res, error);
  }
}));

orchestrationRouter.post('/projects/:projectId/orchestrations/:runId/resume', desktopOnly, route(async (req: Request, res: Response) => {
  if (!authorizedProject(req, res)) return;
  const snapshot = scopedSnapshot(req, res);
  if (!snapshot) return;
  if (!ALPHA_ORCHESTRATION_ENABLED) {
    return res.status(409).json({ error: 'The Orchestrator is unavailable in this desktop version. Update the app before continuing this build.' });
  }
  const userPaused = snapshot.run.status === 'paused';
  const pausedByKillSwitch = snapshot.run.status === 'blocked' &&
    /orchestrator is (?:disabled|unavailable)/i.test(snapshot.run.stoppedReason || '');
  const needsRecovery = snapshot.run.status === 'recovery_required';
  const { isBetweenTasksStop } = await import('../services/orchestrationRecoveryPolicy.js');
  const milestonePlanningStopped = snapshot.run.status === 'blocked' && isBetweenTasksStop(snapshot.run.stoppedReason);
  if (snapshot.run.currentTaskId || (!userPaused && !pausedByKillSwitch && !needsRecovery && !milestonePlanningStopped)) {
    return res.status(409).json({ error: 'This build is not paused at a resumable checkpoint.' });
  }
  try {
    const { orchestrationService } = await import('../services/orchestrationRuntime.js');
    const next = await orchestrationService.resume({
      workspaceId: req.workspace!.workspaceId,
      runId: snapshot.run.id,
      actorId: req.workspace!.userId
    });
    await reconcileRecovery(next);
    res.json({ runId: next.run.id, status: next.run.status, currentTaskId: next.run.currentTaskId });
  } catch (error) {
    errorResponse(res, error);
  }
}));

orchestrationRouter.post('/projects/:projectId/orchestrations/:runId/pause', desktopOnly, route(async (req: Request, res: Response) => {
  if (!authorizedProject(req, res)) return;
  const snapshot = scopedSnapshot(req, res);
  if (!snapshot) return;
  const expectedRevision = req.body?.expectedRevision;
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    return res.status(400).json({ error: 'expectedRevision must be a non-negative integer.' });
  }
  if (snapshot.run.status !== 'executing') {
    return res.status(409).json({ error: 'Only a running Orchestrator build can be paused.' });
  }
  try {
    const { orchestrationService } = await import('../services/orchestrationRuntime.js');
    const paused = await orchestrationService.pauseRun({
      workspaceId: req.workspace!.workspaceId,
      runId: snapshot.run.id,
      expectedRevision,
      actorId: req.workspace!.userId
    });
    res.json({ runId: paused.run.id, status: paused.run.status, pauseRequestedAt: paused.run.pauseRequestedAt });
  } catch (error) {
    errorResponse(res, error);
  }
}));

orchestrationRouter.post('/projects/:projectId/orchestrations/:runId/cancel', desktopOnly, route(async (req: Request, res: Response) => {
  if (!authorizedProject(req, res)) return;
  const snapshot = scopedSnapshot(req, res);
  if (!snapshot) return;
  try {
    const { orchestrationService } = await import('../services/orchestrationRuntime.js');
    const cancelled = await orchestrationService.cancelRun({
      workspaceId: req.workspace!.workspaceId,
      runId: snapshot.run.id,
      actorId: req.workspace!.userId,
      expectedRevision: Number.isSafeInteger(req.body?.expectedRevision) ? req.body.expectedRevision : snapshot.run.revision,
      reason: 'Stopped by the developer after confirmation. Saved work remains available for review.'
    });
    await localPreviewService.stopForBuild(req.workspace!.workspaceId, snapshot.run.id);
    await reconcileRecovery(cancelled);
    res.json({ runId: cancelled.run.id, status: cancelled.run.status });
  } catch (error) {
    errorResponse(res, error);
  }
}));

orchestrationRouter.post('/projects/:projectId/orchestrations/:runId/approve', desktopOnly, route(async (req: Request, res: Response) => {
  if (!authorizedProject(req, res, 'build.publish')) return;
  const snapshot = scopedSnapshot(req, res);
  if (!snapshot) return;
  const expectedRevision = req.body?.expectedRevision;
  if (snapshot.run.status === 'awaiting_approval' && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
    return res.status(400).json({ error: 'expectedRevision must be a non-negative integer.' });
  }
  if (snapshot.run.status === 'publishing' && expectedRevision !== undefined &&
      (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
    return res.status(400).json({ error: 'expectedRevision must be a non-negative integer when provided.' });
  }
  if (!['awaiting_approval', 'publishing', 'completed'].includes(snapshot.run.status)) {
    return res.status(409).json({ error: 'This task build is not waiting for approval or publication recovery.' });
  }

  const workspaceId = req.workspace!.workspaceId;
  try {
    const published = await executeOrchestrationDecision({
      context: req.workspace!, projectId: req.params.projectId, runId: snapshot.run.id,
      action: 'approve', expectedRevision: Number.isSafeInteger(expectedRevision) ? expectedRevision : undefined
    });
    res.json({ runId: published.run.id, status: published.run.status, issueId: published.run.issueId, publication: published.run.publication });
  } catch (error) {
    errorResponse(res, error);
  }
}));

/**
 * Send finished work back from final review with the reviewer's requested changes.
 *
 * Same permission as publishing, because both are the final-review decision.
 * The engine routes the request to the accepted implementation owners inside
 * their original scopes, then reviews and validates again on the same branch.
 */
orchestrationRouter.post('/projects/:projectId/orchestrations/:runId/request-changes', desktopOnly, route(async (req: Request, res: Response) => {
  if (!authorizedProject(req, res, 'build.publish')) return;
  // This action dispatches agent corrections, unlike normal PM review comments.
  if (!requireWorkspaceCapability(req, res, 'agent.run') || !requireWorkspaceCapability(req, res, 'chat.write')) return;
  const snapshot = scopedSnapshot(req, res);
  if (!snapshot) return;
  if (!ALPHA_ORCHESTRATION_ENABLED) {
    return res.status(409).json({ error: 'The Orchestrator is unavailable in this desktop version. Update the app before sending work back.' });
  }
  const expectedRevision = req.body?.expectedRevision;
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    return res.status(400).json({ error: 'expectedRevision must be a non-negative integer.' });
  }
  const feedback = typeof req.body?.feedback === 'string' ? req.body.feedback.trim() : '';
  if (!feedback) return res.status(400).json({ error: 'Describe what should change before sending the work back.' });
  if (feedback.length > MAX_REVIEW_FEEDBACK_CHARS) {
    return res.status(400).json({ error: `Keep the requested changes under ${MAX_REVIEW_FEEDBACK_CHARS.toLocaleString()} characters.` });
  }
  if (snapshot.run.status !== 'awaiting_approval') {
    return res.status(409).json({ error: 'Only a build that is waiting for final review can be sent back.' });
  }
  const workspaceId = req.workspace!.workspaceId;
  const agents = runWithWorkspace(workspaceId, () => sqliteService.getAgents()).filter(agent => !agent.isArchived);
  const visible = await Promise.all(agents.map(agent =>
    workspaceRegistry.canAccessProjectAgentRun(req.workspace!, req.params.projectId, agent.id)));
  try {
    const { orchestrationService } = await import('../services/orchestrationRuntime.js');
    const next = await orchestrationService.requestReviewChanges({
      workspaceId,
      runId: snapshot.run.id,
      expectedRunRevision: expectedRevision,
      actorId: req.workspace!.userId,
      feedback,
      eligibleAgents: agents.filter((_agent, index) => visible[index]).map(agent => ({ id: agent.id, role: agent.role }))
    });
    await reconcileRecovery(next);
    res.json({ runId: next.run.id, status: next.run.status, currentTaskId: next.run.currentTaskId, planVersion: next.run.planVersion });
  } catch (error) {
    errorResponse(res, error);
  }
}));
