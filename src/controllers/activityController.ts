import { Request, Response, Router } from 'express';
import { route } from './asyncRoute.js';
import { desktopOnly } from './desktopOnly.js';
import { requireWorkspaceCapability } from './workspaceContext.js';
import { agentStore, chatStore, issueStore, projectStore, runStore } from '../store/stores.js';
import { chatService } from '../services/chatService.js';
import { runnerService } from '../services/runnerService.js';
import { runningWork } from '../services/runningWork.js';
import { sqliteService } from '../services/sqliteService.js';
import { runWithWorkspace } from '../services/workspaceContext.js';
import { workspaceRegistry } from '../services/workspaceRegistry.js';

export const activityRouter = Router();

/**
 * What is running on this desktop right now, from the engine's live processes, plus
 * runs saved as running that nothing is executing (interrupted). Only projects the
 * caller can see and the caller's own chats are included.
 */
activityRouter.get('/activity/running', desktopOnly, route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'squad.read')) return;
  const { workspaceId, userId } = req.workspace!;
  const projects = (await projectStore().list(workspaceId)).filter(project => workspaceRegistry.canAccessProjectBuilds(req.workspace!, project.id));
  const visible = new Set(projects.map(project => project.id));
  const liveRunIds = runnerService.liveRunIds();
  const live = new Set(liveRunIds);
  const [issues, runs, agents, threads] = await Promise.all([
    issueStore().list(workspaceId),
    runStore().listSummaries(workspaceId),
    agentStore().list(workspaceId),
    chatStore().listThreads(workspaceId, userId)
  ]);
  const orchestrations = runWithWorkspace(workspaceId, () => sqliteService.listActiveOrchestrationSnapshots())
    .filter(snapshot => visible.has(snapshot.run.projectId));
  res.json(runningWork({
    workspaceId, userId, liveRunIds, liveTurns: chatService.liveTurns(), orchestrations,
    runs: runs.filter(run => visible.has(run.projectId) && (live.has(run.id) || run.status === 'running')),
    issues: issues.filter(issue => visible.has(issue.projectId)),
    agentNames: new Map(agents.map(agent => [agent.id, agent.name])),
    threads: new Map(threads
      .filter(thread => !thread.projectId || visible.has(thread.projectId))
      .map(thread => [thread.id, { title: thread.title, projectId: thread.projectId }]))
  }));
}));
