import { Request, Response, Router } from 'express';
import type { Issue, Project } from '../models/index.js';
import { ensureBoardThread } from '../services/boardThreadService.js';
import {
  FeatureSpecError,
  MAX_SPEC_REQUEST_CHARS,
  MAX_SPEC_REVISION_CHARS,
  checklistFromSpec,
  featureSpecSourceHash,
  parseFeatureSpec,
  type FeatureSpecRecord
} from '../services/featureSpecContract.js';
import { draftFeatureSpec, proposeSystemEpics } from '../services/featureSpecService.js';
import { sqliteService } from '../services/sqliteService.js';
import { supabaseService } from '../services/supabaseService.js';
import { shareCard } from '../services/boardShareQueue.js';
import { runWithWorkspace } from '../services/workspaceContext.js';
import { issueStore, projectStore } from '../store/stores.js';
import { route } from './asyncRoute.js';
import { desktopOnly } from './desktopOnly.js';
import { requireEntityWorkspace, requireProjectWorkspace, requireWorkspaceCapability } from './workspaceContext.js';

/**
 * Feature specs on task cards, and epics proposed for a whole system.
 *
 * Drafting runs the Manager Agent, so it needs the same permissions as
 * starting a build from the board (agent.run and chat.write). Editing,
 * approving and removing a spec changes what the task asks for, so it needs
 * issue.manage. Specs are stored on this desktop; approval writes the
 * requirements onto the card as checklist items, which is the part the team
 * sees.
 */
export const featureSpecRouter = Router();

function fail(res: Response, error: unknown): void {
  if (error instanceof FeatureSpecError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  const message = error instanceof Error ? error.message : 'The feature spec action failed.';
  res.status(/changed since you opened it/.test(message) ? 409 : 500).json({ error: message });
}

function canDraft(req: Request, res: Response): boolean {
  if (req.workspace?.role === 'client') {
    res.status(403).json({ error: 'Feature specs are written by the internal project team.' });
    return false;
  }
  return requireWorkspaceCapability(req, res, 'agent.run') && requireWorkspaceCapability(req, res, 'chat.write');
}

async function taskFor(req: Request, res: Response): Promise<{ project: Project; issue: Issue } | null> {
  if (!requireProjectWorkspace(req, res, req.params.projectId)) return null;
  if (!requireEntityWorkspace(req, res, 'issues', req.params.issueId)) return null;
  const workspaceId = req.workspace!.workspaceId;
  const [project, issue] = await Promise.all([
    projectStore().get(workspaceId, req.params.projectId),
    issueStore().get(workspaceId, req.params.issueId)
  ]);
  if (!project || !issue || issue.projectId !== project.id) {
    res.status(404).json({ error: 'Task not found in this project.' });
    return null;
  }
  return { project, issue };
}

/** The saved record plus whether the task changed after approval. */
function view(record: FeatureSpecRecord | null, issue: Issue) {
  if (!record) return { spec: null };
  return { spec: { ...record, stale: record.status === 'approved' && record.sourceHash !== featureSpecSourceHash(issue) } };
}

const expectedVersionOf = (req: Request): number | null => {
  const value = req.body?.expectedVersion;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
};

featureSpecRouter.get('/projects/:projectId/issues/:issueId/feature-spec', desktopOnly, route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'issue.read')) return;
  const task = await taskFor(req, res);
  if (!task) return;
  res.json(view(runWithWorkspace(req.workspace!.workspaceId, () => sqliteService.getFeatureSpec(task.issue.id)), task.issue));
}));

/** Draft a spec, or revise the saved one with a short request. Saved as a draft. */
featureSpecRouter.post('/projects/:projectId/issues/:issueId/feature-spec/draft', desktopOnly, route(async (req: Request, res: Response) => {
  if (!canDraft(req, res)) return;
  const task = await taskFor(req, res);
  if (!task) return;
  const expectedVersion = expectedVersionOf(req);
  if (expectedVersion === null) return res.status(400).json({ error: 'expectedVersion must be a non-negative integer.' });
  const request = typeof req.body?.request === 'string' ? req.body.request.trim() : '';
  const revision = typeof req.body?.revision === 'string' ? req.body.revision.trim() : '';
  if (request.length > MAX_SPEC_REQUEST_CHARS) return res.status(400).json({ error: `Keep the request under ${MAX_SPEC_REQUEST_CHARS.toLocaleString()} characters.` });
  if (revision.length > MAX_SPEC_REVISION_CHARS) return res.status(400).json({ error: `Keep the revision under ${MAX_SPEC_REVISION_CHARS.toLocaleString()} characters.` });
  const workspaceId = req.workspace!.workspaceId;
  const ownerId = req.workspace!.userId;
  try {
    const current = runWithWorkspace(workspaceId, () => sqliteService.getFeatureSpec(task.issue.id));
    if ((current?.version ?? 0) !== expectedVersion) throw new Error('The feature spec changed since you opened it. Refresh and try again.');
    if (revision && !current) return res.status(400).json({ error: 'There is no spec to revise yet. Draft one first.' });
    const { thread } = runWithWorkspace(workspaceId, () => ensureBoardThread({ workspaceId, ownerId, projectId: task.project.id, issue: task.issue }));
    const spec = await draftFeatureSpec({
      workspaceId, context: req.workspace!, threadId: thread.id, project: task.project, issue: task.issue,
      request, previous: revision ? current!.spec : undefined, revision
    });
    const saved = runWithWorkspace(workspaceId, () => sqliteService.saveFeatureSpec({
      issueId: task.issue.id, expectedVersion, spec, status: 'draft',
      sourceHash: featureSpecSourceHash(task.issue), actorId: ownerId
    }));
    res.json(view(saved, task.issue));
  } catch (error) {
    fail(res, error);
  }
}));

/** Save a person's edits. Always a draft: an edited spec is approved again before it guides a build. */
featureSpecRouter.put('/projects/:projectId/issues/:issueId/feature-spec', desktopOnly, route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'issue.manage')) return;
  const task = await taskFor(req, res);
  if (!task) return;
  const expectedVersion = expectedVersionOf(req);
  if (expectedVersion === null) return res.status(400).json({ error: 'expectedVersion must be a non-negative integer.' });
  try {
    const spec = parseFeatureSpec(req.body?.spec);
    const saved = runWithWorkspace(req.workspace!.workspaceId, () => sqliteService.saveFeatureSpec({
      issueId: task.issue.id, expectedVersion, spec, status: 'draft',
      sourceHash: featureSpecSourceHash(task.issue), actorId: req.workspace!.userId
    }));
    res.json(view(saved, task.issue));
  } catch (error) {
    fail(res, error);
  }
}));

/**
 * Approve the spec for building.
 *
 * Open questions must be answered first. Approval records the task text it was
 * approved against and writes one checklist item per requirement onto the
 * card, in a single shared update.
 */
featureSpecRouter.post('/projects/:projectId/issues/:issueId/feature-spec/approve', desktopOnly, route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'issue.manage')) return;
  const task = await taskFor(req, res);
  if (!task) return;
  const expectedVersion = expectedVersionOf(req);
  if (expectedVersion === null) return res.status(400).json({ error: 'expectedVersion must be a non-negative integer.' });
  const workspaceId = req.workspace!.workspaceId;
  try {
    const current = runWithWorkspace(workspaceId, () => sqliteService.getFeatureSpec(task.issue.id));
    if (!current) return res.status(404).json({ error: 'There is no feature spec to approve.' });
    if (current.spec.openQuestions.length) {
      return res.status(409).json({ error: 'Answer or remove the open questions before approving the spec.' });
    }
    const saved = runWithWorkspace(workspaceId, () => sqliteService.saveFeatureSpec({
      issueId: task.issue.id, expectedVersion, spec: current.spec, status: 'approved',
      sourceHash: featureSpecSourceHash(task.issue), actorId: req.workspace!.userId
    }));
    const updated = await issueStore().update(workspaceId, task.issue.id, { subtasks: checklistFromSpec(saved.spec, task.issue.subtasks) });
    if (updated) void shareCard(updated);
    res.json({ ...view(saved, updated ?? task.issue), issue: updated ?? task.issue });
  } catch (error) {
    fail(res, error);
  }
}));

/** Remove the spec. Checklist items stay on the card for a person to keep or delete. */
featureSpecRouter.delete('/projects/:projectId/issues/:issueId/feature-spec', desktopOnly, route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'issue.manage')) return;
  const task = await taskFor(req, res);
  if (!task) return;
  const removed = runWithWorkspace(req.workspace!.workspaceId, () => sqliteService.deleteFeatureSpec(task.issue.id));
  if (!removed) return res.status(404).json({ error: 'There is no feature spec to remove.' });
  res.json({ success: true });
}));

/** Propose epics for a whole system. Nothing is created; the board adds the ones the person keeps. */
featureSpecRouter.post('/projects/:projectId/system-proposal', desktopOnly, route(async (req: Request, res: Response) => {
  if (!canDraft(req, res)) return;
  if (!requireProjectWorkspace(req, res, req.params.projectId)) return;
  const description = typeof req.body?.description === 'string' ? req.body.description.trim() : '';
  if (!description) return res.status(400).json({ error: 'Describe the system you want to build.' });
  if (description.length > MAX_SPEC_REQUEST_CHARS) return res.status(400).json({ error: `Keep the description under ${MAX_SPEC_REQUEST_CHARS.toLocaleString()} characters.` });
  const workspaceId = req.workspace!.workspaceId;
  const project = await projectStore().get(workspaceId, req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  try {
    const { thread } = runWithWorkspace(workspaceId, () => ensureBoardThread({ workspaceId, ownerId: req.workspace!.userId, projectId: project.id }));
    res.json(await proposeSystemEpics({ workspaceId, context: req.workspace!, threadId: thread.id, project, description }));
  } catch (error) {
    fail(res, error);
  }
}));
