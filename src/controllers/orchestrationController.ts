import { Request, Response, Router } from 'express';
import { ALPHA_ORCHESTRATION_ENABLED } from '../config/env.js';
import { projectStore } from '../store/stores.js';
import { sqliteService } from '../services/sqliteService.js';
import { getOrchestrationDiffPreview } from '../services/orchestrationReviewService.js';
import { inspectOrchestrationPlanningWorktree, getOrchestrationPlanningRecoveryPreview, removeStaleOrchestrationPlanningWorktree } from '../services/orchestrationPlanningRecovery.js';
import { resolveProjectWorkspace } from '../services/workspaceService.js';
import { orchestrationSessionId } from '../services/orchestrationSession.js';
import { runWithWorkspace } from '../services/workspaceContext.js';
import { workspaceRegistry } from '../services/workspaceRegistry.js';
import { route } from './asyncRoute.js';
import { desktopOnly } from './desktopOnly.js';
import { requireProjectWorkspace, requireWorkspaceCapability } from './workspaceContext.js';

export const orchestrationRouter = Router();

function errorResponse(res: Response, error: unknown): void {
  const message = error instanceof Error ? error.message : 'The task workflow action failed.';
  const status = /not found|unavailable/i.test(message) ? 404
    : /cannot|only |already|changed|retry|stale|no longer|disabled|validation|review/i.test(message) ? 409
      : 500;
  res.status(status).json({ error: message });
}

function authorizedProject(req: Request, res: Response, capability = 'squad.run'): boolean {
  if (!requireWorkspaceCapability(req, res, capability as 'squad.run' | 'deployment.manage')) return false;
  if (!requireProjectWorkspace(req, res, req.params.projectId)) return false;
  if (!workspaceRegistry.canAccessLiveBuildRoom(req.workspace!, req.params.projectId)) {
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
  if (!authorizedProject(req, res)) return;
  const snapshot = scopedSnapshot(req, res);
  if (!snapshot) return;
  try {
    res.json(await getOrchestrationDiffPreview(snapshot));
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
    return res.status(409).json({ error: 'This planner still belongs to the active Alpha session. Refresh the room after it finishes.' });
  }
  const project = await projectStore().get(workspaceId, req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  const repositoryWorkspace = runWithWorkspace(workspaceId, () => resolveProjectWorkspace(project, reservation.repository));
  if (!repositoryWorkspace) return res.status(409).json({ error: 'The repository checkout is not available on this desktop. Restore its project binding before recovering the planning workspace.' });

  const inspection = await runWithWorkspace(workspaceId, () =>
    inspectOrchestrationPlanningWorktree({ projectId: project.id, reservation }));
  if (inspection.safeToRetire || inspection.state === 'missing') {
    const removed = await runWithWorkspace(workspaceId, () => removeStaleOrchestrationPlanningWorktree({
      repositoryDir: repositoryWorkspace.dir,
      projectId: project.id,
      reservation
    }));
    if (!removed) return res.status(409).json({ error: 'The saved workspace changed during inspection. It was preserved; refresh the room to review it.' });
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
      ? 'Planning stopped before a task plan was activated. The saved private workspace differs from its reserved clean base and has been preserved for review.'
      : 'Planning stopped before a task plan was activated. Alpha could not verify the saved workspace identity, so it was preserved and repository admission remains paused.'
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
  try {
    const { orchestrationService } = await import('../services/orchestrationRuntime.js');
    const next = await orchestrationService.retryTask({
      workspaceId: req.workspace!.workspaceId,
      runId: snapshot.run.id,
      taskId: task.id,
      expectedTaskRevision,
      actorId: req.workspace!.userId
    });
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
    return res.status(409).json({ error: 'The orchestrator is disabled on this desktop. Enable it before resuming this build.' });
  }
  const pausedByKillSwitch = snapshot.run.status === 'blocked' &&
    snapshot.run.stoppedReason?.toLowerCase().includes('orchestrator is disabled');
  const needsRecovery = snapshot.run.status === 'recovery_required';
  if (snapshot.run.currentTaskId || (!pausedByKillSwitch && !needsRecovery)) {
    return res.status(409).json({ error: 'This build is not paused at a resumable checkpoint.' });
  }
  try {
    const { orchestrationService } = await import('../services/orchestrationRuntime.js');
    const next = await orchestrationService.resume({
      workspaceId: req.workspace!.workspaceId,
      runId: snapshot.run.id,
      actorId: req.workspace!.userId
    });
    res.json({ runId: next.run.id, status: next.run.status, currentTaskId: next.run.currentTaskId });
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
      actorId: req.workspace!.userId
    });
    res.json({ runId: cancelled.run.id, status: cancelled.run.status });
  } catch (error) {
    errorResponse(res, error);
  }
}));

orchestrationRouter.post('/projects/:projectId/orchestrations/:runId/approve', desktopOnly, route(async (req: Request, res: Response) => {
  if (!authorizedProject(req, res, 'deployment.manage')) return;
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
    const { orchestrationService } = await import('../services/orchestrationRuntime.js');
    const published = await orchestrationService.approveAndPublish({
      workspaceId,
      runId: snapshot.run.id,
      expectedRevision: Number.isSafeInteger(expectedRevision) ? expectedRevision : undefined,
      actorId: req.workspace!.userId
    });
    res.json({ runId: published.run.id, status: published.run.status, issueId: published.run.issueId, publication: published.run.publication });
  } catch (error) {
    errorResponse(res, error);
  }
}));
