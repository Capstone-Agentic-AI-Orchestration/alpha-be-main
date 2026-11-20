import { Request, Response, Router } from 'express';

import {
  BOARD_RUN_MAX_TASKS, defaultDeps, pauseBoardRun, resumeBoardRun, startBoardRun, stopBoardRun, type BoardRun
} from '../services/boardRunService.js';
import { runWithWorkspace } from '../services/workspaceContext.js';
import { workspaceRegistry } from '../services/workspaceRegistry.js';
import { route } from './asyncRoute.js';
import { desktopOnly } from './desktopOnly.js';
import { requireProjectWorkspace, requireWorkspaceCapability } from './workspaceContext.js';

/**
 * Board runs, started and followed from a project chat. Desktop only: the builds a run
 * starts run on this computer. A developer sees and controls only their own runs.
 */
export const boardRunRouter = Router();

function buildsAllowed(req: Request, res: Response): boolean {
  if (!requireWorkspaceCapability(req, res, 'agent.run') || !requireProjectWorkspace(req, res, req.params.projectId)) return false;
  if (!workspaceRegistry.canAccessProjectBuilds(req.workspace!, req.params.projectId)) {
    res.status(404).json({ error: 'This project build is not available to this account.' });
    return false;
  }
  return true;
}

function failure(res: Response, error: unknown): void {
  const message = error instanceof Error ? error.message : 'The board run action failed.';
  res.status(/not found/i.test(message) ? 404 : 409).json({ error: message });
}

function ownRun(req: Request, res: Response): BoardRun | null {
  const run = (defaultDeps.listRuns(req.workspace!.workspaceId)).find(item => item.id === req.params.runId
    && item.projectId === req.params.projectId && item.ownerId === req.workspace!.userId);
  if (!run) res.status(404).json({ error: 'Board run not found.' });
  return run ?? null;
}

const limitOk = (value: unknown) => value === null || value === undefined || (typeof value === 'number' && Number.isFinite(value) && value > 0);

boardRunRouter.post('/projects/:projectId/board-runs', desktopOnly, route(async (req: Request, res: Response) => {
  if (!buildsAllowed(req, res)) return;
  const { threadId, issueIds, maxTasks, maxTokens = null, maxCostUsd = null, preApprovePlans } = req.body ?? {};
  if (typeof threadId !== 'string' || !threadId || !Array.isArray(issueIds) || !issueIds.length || issueIds.length > BOARD_RUN_MAX_TASKS
      || issueIds.some(id => typeof id !== 'string') || typeof maxTasks !== 'number' || typeof preApprovePlans !== 'boolean'
      || !limitOk(maxTokens) || !limitOk(maxCostUsd)) {
    return res.status(400).json({ error: `Send the chat, 1 to ${BOARD_RUN_MAX_TASKS} tasks, a task limit, optional token and cost limits, and whether plans are approved up front.` });
  }
  try {
    const run = await runWithWorkspace(req.workspace!.workspaceId, () => startBoardRun({
      context: req.workspace!, projectId: req.params.projectId, threadId, issueIds, maxTasks, maxTokens, maxCostUsd, preApprovePlans
    }));
    res.status(201).json(run);
  } catch (error) { failure(res, error); }
}));

/** This developer's runs in the project, newest first. */
boardRunRouter.get('/projects/:projectId/board-runs', desktopOnly, route(async (req: Request, res: Response) => {
  if (!buildsAllowed(req, res)) return;
  const runs = defaultDeps.listRuns(req.workspace!.workspaceId)
    .filter(run => run.projectId === req.params.projectId && run.ownerId === req.workspace!.userId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 10);
  res.json(runs);
}));

boardRunRouter.post('/projects/:projectId/board-runs/:runId/:action(stop|pause|resume)', desktopOnly, route(async (req: Request, res: Response) => {
  if (!buildsAllowed(req, res)) return;
  const run = ownRun(req, res);
  if (!run) return;
  const actor = req.workspace!.userId;
  try {
    const action = req.params.action;
    if (action === 'stop') return res.json(stopBoardRun(run, actor));
    if (action === 'pause') return res.json(pauseBoardRun(run, actor));
    const { maxTokens, maxCostUsd } = req.body ?? {};
    if (!limitOk(maxTokens) || !limitOk(maxCostUsd)) return res.status(400).json({ error: 'Limits must be positive numbers, or empty.' });
    const limits = { ...(maxTokens !== undefined ? { maxTokens } : {}), ...(maxCostUsd !== undefined ? { maxCostUsd } : {}) };
    res.json(await runWithWorkspace(req.workspace!.workspaceId, () => resumeBoardRun(run, actor, limits)));
  } catch (error) { failure(res, error); }
}));
