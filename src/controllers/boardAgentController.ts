import { Request, Response, Router, NextFunction } from 'express';
import { desktopOnly } from './desktopOnly.js';
import { requireProjectWorkspace, requireWorkspaceCapability } from './workspaceContext.js';
import { workspaceRegistry } from '../services/workspaceRegistry.js';
import { runWithWorkspace } from '../services/workspaceContext.js';
import { sqliteService } from '../services/sqliteService.js';
import { projectStore } from '../store/stores.js';
import { boardGrantForToken, type BoardGrant } from '../services/boardGrant.js';
import { BoardRuleError } from '../services/boardService.js';
import {
  approveAgentChange,
  archiveForAgent,
  createCardForAgent,
  getCard,
  listAgentChanges,
  listCards,
  moveCardForAgent,
  rejectAgentChange,
  restoreForAgent,
  undoAgentChange,
  updateCardForAgent
} from '../services/boardAgentService.js';
import { currentIdentity } from '../services/identityService.js';

/**
 * The board for agents, and the decisions people make about what agents did.
 *
 * /agent-bridge/board/* is called by the alpha-board tool server with its
 * turn's board pass (see boardGrant): the pass names the developer the agent
 * acts for and the one project it may touch, and each call is checked as that
 * developer. Everything else here is for people: the change log, confirming
 * or rejecting held changes, undo, and switching the assistant off.
 */
export const boardAgentRouter = Router();

const AGENT_OPERATIONS: Record<string, (grant: BoardGrant, args: Record<string, unknown>) => Promise<unknown>> = {
  list: listCards,
  get: getCard,
  create: createCardForAgent,
  update: updateCardForAgent,
  move: moveCardForAgent,
  archive: archiveForAgent,
  restore: restoreForAgent
};

const answer = (res: Response, next: NextFunction, err: unknown) => {
  if (err instanceof BoardRuleError) return void res.status(err.status).json({ error: err.message });
  next(err);
};

boardAgentRouter.post('/agent-bridge/board/:operation', desktopOnly, async (req: Request, res: Response, next: NextFunction) => {
  const grant = boardGrantForToken(req.header('X-Alpha-Run-Token'));
  if (!grant) return res.status(401).json({ error: 'This tool call is not part of a running Alpha turn.' });
  const operation = AGENT_OPERATIONS[req.params.operation];
  if (!operation) return res.status(404).json({ error: 'Unknown board operation.' });
  try {
    res.json(await runWithWorkspace(grant.context.workspaceId, () => operation(grant, req.body && typeof req.body === 'object' ? req.body : {})));
  } catch (err) {
    answer(res, next, err);
  }
});

/** What agents did and asked to do on the board, newest first. Visible to everyone who can read the project's tasks. */
boardAgentRouter.get('/board/agent-changes', desktopOnly, (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'issue.read')) return;
  const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
  if (projectId && !requireProjectWorkspace(req, res, projectId)) return;
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const limit = Number(req.query.limit) || 50;
  const changes = listAgentChanges(req.workspace!, { projectId, status, limit })
    .filter(change => workspaceRegistry.canAccessProject(req.workspace!, change.projectId));
  res.json(changes);
});

const decision = (decide: (context: NonNullable<Request['workspace']>, id: string) => unknown) =>
  async (req: Request, res: Response, next: NextFunction) => {
    if (!requireWorkspaceCapability(req, res, 'issue.manage')) return;
    try {
      res.json(await decide(req.workspace!, req.params.id));
    } catch (err) {
      answer(res, next, err);
    }
  };

boardAgentRouter.post('/board/agent-changes/:id/approve', desktopOnly, decision(approveAgentChange));
boardAgentRouter.post('/board/agent-changes/:id/reject', desktopOnly, decision(rejectAgentChange));
boardAgentRouter.post('/board/agent-changes/:id/undo', desktopOnly, decision(undoAgentChange));

/** Whether agents may work on a project's board (or the whole workspace's, without a project). */
boardAgentRouter.get('/board/assistant-settings', desktopOnly, async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'issue.read')) return;
  const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : '';
  if (projectId && !requireProjectWorkspace(req, res, projectId)) return;
  const workspaceId = req.workspace!.workspaceId;
  res.json({
    projectId,
    enabled: runWithWorkspace(workspaceId, () => sqliteService.boardAssistantEnabled(workspaceId, projectId)),
    // Whoever may have agents work for them: the panel says why someone else sees no assistant.
    canUse: workspaceRegistry.canOperateAgents(req.workspace!.role),
    canChange: workspaceRegistry.can(req.workspace!.role, 'workspace.manage_settings')
  });
});

/** Admins and project managers can switch the board assistant off, for a project or the whole workspace. */
boardAgentRouter.put('/board/assistant-settings', desktopOnly, async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'workspace.manage_settings')) return;
  const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId : '';
  if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be true or false.' });
  if (projectId) {
    if (!requireProjectWorkspace(req, res, projectId)) return;
    if (!(await projectStore().get(req.workspace!.workspaceId, projectId))) return res.status(404).json({ error: 'Project not found' });
  }
  const workspaceId = req.workspace!.workspaceId;
  const login = (await currentIdentity()).login;
  runWithWorkspace(workspaceId, () => sqliteService.setBoardAssistantEnabled(workspaceId, projectId, req.body.enabled, login));
  res.json({ projectId, enabled: req.body.enabled });
});

