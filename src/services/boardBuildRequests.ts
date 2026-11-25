import { createHash } from 'node:crypto';
import type { Issue, Project } from '../models/index.js';
import { issueStore, projectStore } from '../store/stores.js';
import { reposForProject } from './githubIssueMapping.js';
import { sqliteService } from './sqliteService.js';
import { runWithWorkspace } from './workspaceContext.js';
import { workspaceRegistry, type WorkspaceContext } from './workspaceRegistry.js';
import { shareCard } from './boardShareQueue.js';
import type { ProjectBuildStartResult } from './projectBuildOrchestrator.js';

export interface BoardBuildRequest {
  [key: string]: unknown;
  id: string; workspaceId: string; ownerId: string; projectId: string; issueId: string;
  threadId: string; instructions: string; sourceHash: string; createdAt: string; updatedAt: string;
  status: 'waiting' | 'planning' | 'accepted' | 'needs_review' | 'failed' | 'cancelled';
  reason?: string; result?: ProjectBuildStartResult;
}

export const boardBuildSourceHash = (issue: Issue, project: Project, specVersion: number) => createHash('sha256')
  .update(JSON.stringify([issue.id, issue.projectId, issue.title, issue.description, issue.subtasks, issue.status,
    reposForProject(project).map(item => item.toLowerCase()).sort(), specVersion])).digest('hex');

function save(request: BoardBuildRequest) {
  request.updatedAt = new Date().toISOString();
  sqliteService.saveBoardBuildRequest(request);
  return request;
}

export function boardBuildBlocker(project: Project) {
  for (const repository of reposForProject(project)) {
    const run = sqliteService.getActiveOrchestrationForProject(project.id, repository);
    if (run) {
      return { projectId: run.projectId, issueId: run.issueId, runId: run.runId, status: run.status, repository };
    }
    if (sqliteService.getOrchestrationPlanningReservation(project.id, repository)) {
      return { status: 'planning', repository };
    }
  }
  return undefined;
}

const active = new Map<string, Promise<BoardBuildRequest>>();

async function dispatch(request: BoardBuildRequest, context: WorkspaceContext): Promise<BoardBuildRequest> {
  if (active.has(request.id)) return active.get(request.id)!;
  const work = runWithWorkspace(request.workspaceId, async () => {
    try {
      if (!workspaceRegistry.canOperateAgents(context.role) || !workspaceRegistry.canAccessProjectBuilds(context, request.projectId)) {
        throw new Error('Agent execution access is required. Review this request after access is restored.');
      }
      const [issue, project] = await Promise.all([issueStore().get(request.workspaceId, request.issueId), projectStore().get(request.workspaceId, request.projectId)]);
      if (!issue || !project || issue.projectId !== project.id || issue.status === 'done' || issue.archivedAt) throw new Error('The task is no longer available for planning.');
      const spec = sqliteService.getFeatureSpec(issue.id);
      if (boardBuildSourceHash(issue, project, spec?.version ?? 0) !== request.sourceHash) {
        request.status = 'needs_review'; request.reason = 'The task, checklist, specification or repositories changed. Review and submit a new plan request.';
        return save(request);
      }
      const blocker = boardBuildBlocker(project);
      const current = (sqliteService.listBoardBuildRequests(request.workspaceId) as BoardBuildRequest[]).find(item => item.id === request.id);
      if (!current || current.status === 'cancelled') return current ?? request;
      // Replaying an acknowledged planning request uses the same message ID below.
      if (blocker && request.status !== 'planning') {
        request.reason = 'Waiting for the current repository build. Open its task to review its state.';
        return save(request);
      }
      request.status = 'planning'; request.reason = undefined; save(request);
      const content = [`Task ${issue.identifier}: ${issue.title}`, issue.description,
          'Acceptance checklist:', ...(issue.subtasks ?? []).map(item => `- ${item.title}`),
          request.instructions ? `Developer instructions:\n${request.instructions}` : ''].filter(Boolean).join('\n\n');
      // Reuse the exact chat build path: messages, private binding, approval,
      // recovery milestones and future Chat restoration retain one identity.
      const { chatService } = await import('./chatService.js');
      let result: ProjectBuildStartResult | undefined;
      try {
        const response = await chatService.sendMessage({ threadId: request.threadId, clientMessageId: request.id, content,
          projectId: project.id, workspaceId: context.workspaceId, userId: context.userId, workspaceRole: context.role,
          buildRequest: { context, issueId: issue.id } });
        result = response.build;
      } finally { chatService.finishTurn(request.threadId, request.id); }
      if (!result) throw new Error('The planning request did not return a build result. Review the task conversation.');
      request.result = result;
      request.status = result.orchestrationRunId ? 'accepted' : 'failed';
      request.reason = result.reason;
      return save(request);
    } catch (error) {
      request.status = 'failed'; request.reason = error instanceof Error ? error.message : 'Planning request failed.';
      return save(request);
    }
  });
  active.set(request.id, work);
  try { return await work; } finally { active.delete(request.id); }
}

/** A chat thread the requester owns, about this project; anything else is refused. */
function ownedProjectThread(threadId: string, context: WorkspaceContext, projectId: string) {
  const thread = sqliteService.getChatThreads().find(item => item.id === threadId);
  if (!thread || thread.ownerId !== context.userId || thread.projectId !== projectId) {
    throw new Error('That conversation is not your chat about this project.');
  }
  return thread;
}

export async function requestBoardBuild(input: { context: WorkspaceContext; issue: Issue; project: Project; requestId: string; instructions: string; queue: boolean;
  /** A board run posts its builds into the project chat it was started from, not each task's own thread. */
  threadId?: string }) {
  const { context, issue, project } = input;
  if (!workspaceRegistry.canOperateAgents(context.role) || !workspaceRegistry.canAccessProjectBuilds(context, project.id)) throw new Error('Your workspace role cannot request AI planning for this project.');
  return runWithWorkspace(context.workspaceId, async () => {
    const records = sqliteService.listBoardBuildRequests(context.workspaceId) as BoardBuildRequest[];
    const existing = records.find(item => item.id === input.requestId);
    if (existing) {
      if (existing.ownerId !== context.userId || existing.issueId !== issue.id || existing.instructions !== input.instructions) throw new Error('This request key already belongs to another submission.');
      return existing;
    }
    const pending = records.find(item => item.issueId === issue.id && ['waiting', 'planning'].includes(item.status));
    if (pending && pending.ownerId !== context.userId) throw new Error('This task already has a planning request owned by another developer.');
    if (pending) return pending;
    const blocker = boardBuildBlocker(project);
    if (blocker && !input.queue) throw new Error('Another build holds a selected repository. Open that task or explicitly queue this plan.');
    const spec = sqliteService.getFeatureSpec(issue.id);
    if (!issue.labels.includes('alpha:task-orchestration')) {
      const labelled = await issueStore().update(context.workspaceId, issue.id, { labels: [...issue.labels, 'alpha:task-orchestration'] });
      // This machine's own change: the local store never publishes it, so send it on.
      if (labelled) void shareCard(labelled, context.workspaceId);
    }
    const thread = input.threadId ? ownedProjectThread(input.threadId, context, project.id)
      : (await import('./boardThreadService.js')).ensureBoardThread({ workspaceId: context.workspaceId, ownerId: context.userId, projectId: project.id, issue }).thread;
    const now = new Date().toISOString();
    const request: BoardBuildRequest = { id: input.requestId, workspaceId: context.workspaceId, ownerId: context.userId,
      projectId: project.id, issueId: issue.id, threadId: thread.id, instructions: input.instructions,
      sourceHash: boardBuildSourceHash(issue, project, spec?.version ?? 0), status: 'waiting', createdAt: now, updatedAt: now };
    try { save(request); } catch (error) {
      if (error instanceof Error && /UNIQUE constraint/.test(error.message)) throw new Error('This task already has a pending planning request. Refresh its Build tab.');
      throw error;
    }
    if (!blocker) void dispatch(request, context);
    return request;
  });
}

/** Durable local requests, dispatched only after fresh membership and repository checks. */
export function startBoardBuildQueue(): () => void {
  let checking = false;
  const tick = async () => {
    if (checking) return;
    checking = true;
    try {
      const requests = sqliteService.listBoardBuildRequests() as BoardBuildRequest[];
      for (const request of requests.filter(item => ['waiting', 'planning'].includes(item.status))) {
        if (active.has(request.id)) continue;
        try {
          const context = await workspaceRegistry.resolve(request.ownerId, request.workspaceId);
          if (!context) throw new Error('Workspace membership unavailable.');
          void dispatch(request, context);
        } catch {
          runWithWorkspace(request.workspaceId, () => save({ ...request, status: 'needs_review', reason: 'Execution access could not be verified. Review this queued request.' }));
        }
      }
      // Board runs move to their next task here, on the same timer as the requests they queue.
      const { advanceBoardRuns } = await import('./boardRunService.js');
      await advanceBoardRuns();
    } finally { checking = false; }
  };
  const timer = setInterval(() => void tick().catch(() => undefined), 10_000);
  timer.unref();
  return () => clearInterval(timer);
}
