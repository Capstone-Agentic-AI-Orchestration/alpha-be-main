import { randomUUID } from 'node:crypto';

import type { Issue, IssuePriority, Project } from '../models/index.js';
import { issueStore, projectStore } from '../store/stores.js';
import { boardBuildSourceHash, requestBoardBuild, type BoardBuildRequest } from './boardBuildRequests.js';
import type { OrchestrationSnapshot } from './orchestrationStateMachine.js';
import { sqliteService } from './sqliteService.js';
import { runWithWorkspace } from './workspaceContext.js';
import { workspaceRegistry, type WorkspaceContext } from './workspaceRegistry.js';

/**
 * A board run: a developer asks agents to work through chosen board tasks one
 * after another, from a project chat, within limits they set.
 *
 * What it may do on their behalf, and what it may not:
 * - It queues each task's build through the ordinary board request path, with all
 *   of its checks (role, task unchanged, repository free).
 * - With the developer's say-so at the start, it approves each task's plan, but only
 *   for tasks in the list, only while the run is active, and only if the task has not
 *   changed since the run started.
 * - It never publishes. Every task waits at "ready for your review" until a person
 *   approves its pull request. It never merges and never marks a task done.
 * - It stops on anything unexpected (a blocked or failed build, a changed task, lost
 *   access, a limit reached) and says why, rather than skipping on.
 */

export type BoardRunStatus = 'running' | 'waiting_on_you' | 'paused' | 'stopped' | 'completed';
export type BoardRunTaskState = 'queued' | 'held' | 'planning' | 'working' | 'waiting_on_you' | 'done' | 'stopped';

export interface BoardRunTask {
  issueId: string;
  identifier: string;
  title: string;
  priority: IssuePriority;
  state: BoardRunTaskState;
  sourceHash: string;
  requestId?: string;
  orchestrationRunId?: string;
  reason?: string;
}

export interface BoardRun {
  [key: string]: unknown;
  id: string;
  workspaceId: string;
  ownerId: string;
  projectId: string;
  threadId: string;
  status: BoardRunStatus;
  tasks: BoardRunTask[];
  maxTasks: number;
  maxTokens: number | null;
  maxCostUsd: number | null;
  preApprovePlans: boolean;
  usage: { tokens: number; costUsd: number; unmeasuredBuilds: number };
  reason?: string;
  events: Array<{ at: string; message: string }>;
  createdAt: string;
  updatedAt: string;
}

export const BOARD_RUN_MAX_TASKS = 20;
const ACTIVE: BoardRunStatus[] = ['running', 'waiting_on_you', 'paused'];
const PRIORITY_RANK: Record<IssuePriority, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };

/** What the run reads and does, so tests can stand in for the stores and the Orchestrator. */
export interface BoardRunDeps {
  now(): string;
  listRuns(workspaceId?: string): BoardRun[];
  saveRun(run: BoardRun): void;
  listIssues(workspaceId: string): Promise<Issue[]>;
  getProject(workspaceId: string, projectId: string): Promise<Project | null>;
  getSpecVersion(issueId: string): number;
  resolveContext(ownerId: string, workspaceId: string): Promise<WorkspaceContext | null>;
  requestBuild(input: Parameters<typeof requestBoardBuild>[0]): Promise<BoardBuildRequest>;
  listRequests(workspaceId: string): BoardBuildRequest[];
  cancelRequest(request: BoardBuildRequest): void;
  snapshot(workspaceId: string, runId: string): OrchestrationSnapshot | null;
  startPlan(context: WorkspaceContext, projectId: string, runId: string, revision: number): Promise<unknown>;
  pauseBuild(workspaceId: string, runId: string, revision: number, actorId: string): Promise<unknown>;
  usage(workspaceId: string, runIds: string[]): { tokens: number; costUsd: number; unmeasuredBuilds: number };
}

/**
 * Highest priority first, then board order. A task waits behind the tasks in the run it
 * depends on; one that depends on an unfinished task outside the run is held, with why.
 */
export function orderRunTasks(issues: Issue[], allIssues: Issue[]): Array<{ issue: Issue; heldReason?: string }> {
  const chosen = new Set(issues.map(issue => issue.id));
  const byId = new Map(allIssues.map(issue => [issue.id, issue]));
  const sorted = [...issues].sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
  const ordered: Issue[] = [];
  const placed = new Set<string>();
  const visit = (issue: Issue, trail: Set<string>) => {
    if (placed.has(issue.id) || trail.has(issue.id)) return;
    trail.add(issue.id);
    for (const dependency of issue.dependsOnIssueIds ?? []) {
      const required = byId.get(dependency);
      if (required && chosen.has(dependency)) visit(required, trail);
    }
    placed.add(issue.id);
    ordered.push(issue);
  };
  for (const issue of sorted) visit(issue, new Set());
  return ordered.map(issue => {
    const outside = (issue.dependsOnIssueIds ?? [])
      .map(id => byId.get(id))
      .filter((dependency): dependency is Issue => Boolean(dependency) && !chosen.has(dependency!.id) && dependency!.status !== 'done');
    return outside.length
      ? { issue, heldReason: `Waits for ${outside.map(item => item.identifier).join(', ')}, which is not in this run and not done.` }
      : { issue };
  });
}

function canRunBuilds(context: WorkspaceContext, projectId: string): boolean {
  return context.role === 'dev' && workspaceRegistry.can(context.role, 'agent.run') && workspaceRegistry.can(context.role, 'squad.run')
    && workspaceRegistry.can(context.role, 'chat.write') && workspaceRegistry.canAccessProjectBuilds(context, projectId);
}

function positiveOrNull(value: unknown, name: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`The ${name} must be a positive number, or left empty.`);
  return value;
}

function note(run: BoardRun, deps: BoardRunDeps, message: string): void {
  run.events = [...run.events, { at: deps.now(), message }].slice(-100);
}

function save(run: BoardRun, deps: BoardRunDeps): BoardRun {
  run.updatedAt = deps.now();
  deps.saveRun(run);
  return run;
}

function halt(run: BoardRun, deps: BoardRunDeps, status: 'paused' | 'stopped' | 'completed', reason: string): BoardRun {
  run.status = status;
  run.reason = reason;
  note(run, deps, reason);
  return save(run, deps);
}

export interface StartBoardRunInput {
  context: WorkspaceContext;
  projectId: string;
  threadId: string;
  issueIds: string[];
  maxTasks: number;
  maxTokens?: number | null;
  maxCostUsd?: number | null;
  preApprovePlans: boolean;
}

/** Start a run the developer asked for, after checking every task and limit. */
export async function startBoardRun(input: StartBoardRunInput, deps: BoardRunDeps = defaultDeps): Promise<BoardRun> {
  const { context, projectId } = input;
  if (!canRunBuilds(context, projectId)) throw new Error('Only a developer who can run builds in this project can start a board run.');
  if (!Number.isInteger(input.maxTasks) || input.maxTasks < 1 || input.maxTasks > BOARD_RUN_MAX_TASKS) {
    throw new Error(`Choose between 1 and ${BOARD_RUN_MAX_TASKS} tasks for one run.`);
  }
  const maxTokens = positiveOrNull(input.maxTokens, 'token limit');
  const maxCostUsd = positiveOrNull(input.maxCostUsd, 'cost limit');
  const ids = [...new Set(input.issueIds)];
  if (!ids.length) throw new Error('Choose at least one task for the run.');
  if (deps.listRuns(context.workspaceId).some(run => run.projectId === projectId && ACTIVE.includes(run.status))) {
    throw new Error('This project already has a board run. Stop it before starting another.');
  }
  const project = await deps.getProject(context.workspaceId, projectId);
  if (!project) throw new Error('Project not found.');
  const all = await deps.listIssues(context.workspaceId);
  const chosen = ids.map(id => all.find(issue => issue.id === id));
  if (chosen.some(issue => !issue || issue.projectId !== projectId || issue.status === 'done' || issue.archivedAt)) {
    throw new Error('Every task in a run must be an open task in this project.');
  }
  const now = deps.now();
  const run: BoardRun = {
    id: 'board-run-' + randomUUID(), workspaceId: context.workspaceId, ownerId: context.userId, projectId, threadId: input.threadId,
    status: 'running', maxTasks: input.maxTasks, maxTokens, maxCostUsd, preApprovePlans: input.preApprovePlans,
    usage: { tokens: 0, costUsd: 0, unmeasuredBuilds: 0 }, events: [], createdAt: now, updatedAt: now,
    tasks: orderRunTasks(chosen as Issue[], all).slice(0, input.maxTasks).map(({ issue, heldReason }) => ({
      issueId: issue.id, identifier: issue.identifier, title: issue.title, priority: issue.priority,
      state: heldReason ? 'held' : 'queued', reason: heldReason,
      sourceHash: boardBuildSourceHash(issue, project, deps.getSpecVersion(issue.id))
    }))
  };
  note(run, deps, `Started by ${context.userId}: ${run.tasks.length} task(s), plans ${run.preApprovePlans ? 'approved for these tasks' : 'approved one by one'}; every pull request waits for approval.`);
  save(run, deps);
  return advanceBoardRun(run, deps);
}

/** The task the run is on: the first one not finished or held. */
function currentTask(run: BoardRun): BoardRunTask | undefined {
  return run.tasks.find(task => !['done', 'held', 'stopped'].includes(task.state));
}

function overLimit(run: BoardRun): string | null {
  if (run.maxTokens !== null && run.usage.tokens >= run.maxTokens) {
    return `The run reached its token limit (${run.usage.tokens.toLocaleString()} of ${run.maxTokens.toLocaleString()}).`;
  }
  if (run.maxCostUsd !== null && run.usage.costUsd >= run.maxCostUsd) {
    return `The run reached its cost limit ($${run.usage.costUsd.toFixed(2)} of $${run.maxCostUsd.toFixed(2)}).`;
  }
  return null;
}

/** Queue a task's build in the run's chat, through the ordinary board request path. */
async function startTask(run: BoardRun, task: BoardRunTask, context: WorkspaceContext, deps: BoardRunDeps): Promise<BoardRun> {
  const [issue, project] = await Promise.all([
    deps.listIssues(run.workspaceId).then(items => items.find(item => item.id === task.issueId)),
    deps.getProject(run.workspaceId, run.projectId)
  ]);
  if (!issue || !project || issue.status === 'done' || issue.archivedAt) {
    task.state = 'stopped';
    return halt(run, deps, 'paused', `${task.identifier} is no longer an open task. Review the run before resuming.`);
  }
  if (boardBuildSourceHash(issue, project, deps.getSpecVersion(issue.id)) !== task.sourceHash) {
    return halt(run, deps, 'paused', `${task.identifier} changed after the run started. Review it, then start a new run.`);
  }
  const request = await deps.requestBuild({ context, issue, project, requestId: `board-request-${run.id}-${task.issueId}`,
    instructions: '', queue: true, threadId: run.threadId });
  task.requestId = request.id;
  task.state = 'planning';
  note(run, deps, `Queued ${task.identifier} for planning.`);
  return save(run, deps);
}

type Step = (run: BoardRun, task: BoardRunTask, snapshot: OrchestrationSnapshot, context: WorkspaceContext, deps: BoardRunDeps) => Promise<BoardRun>;

const approvePlan: Step = async (run, task, snapshot, context, deps) => {
  if (!run.preApprovePlans) {
    task.state = 'waiting_on_you';
    run.status = 'waiting_on_you';
    run.reason = `Approve the plan for ${task.identifier} in the chat.`;
    return save(run, deps);
  }
  const [issue, project] = await Promise.all([
    deps.listIssues(run.workspaceId).then(items => items.find(item => item.id === task.issueId)),
    deps.getProject(run.workspaceId, run.projectId)
  ]);
  if (!issue || !project || boardBuildSourceHash(issue, project, deps.getSpecVersion(issue.id)) !== task.sourceHash) {
    return halt(run, deps, 'paused', `${task.identifier} changed after the run started, so its plan was not approved. Review it in the chat.`);
  }
  await deps.startPlan(context, run.projectId, snapshot.run.id, snapshot.run.revision);
  task.state = 'working';
  run.status = 'running';
  note(run, deps, `Approved the plan for ${task.identifier} on behalf of ${run.ownerId}, as agreed when the run started.`);
  return save(run, deps);
};

const STOPS = ['blocked', 'failed', 'recovery_required', 'cancelled', 'cancelling'];

/** Act on the current task's build, as its status says. */
async function followBuild(run: BoardRun, task: BoardRunTask, context: WorkspaceContext, deps: BoardRunDeps): Promise<BoardRun> {
  const snapshot = task.orchestrationRunId ? deps.snapshot(run.workspaceId, task.orchestrationRunId) : null;
  if (!snapshot) return run;
  const status = snapshot.run.status;
  if (status === 'awaiting_plan_approval') return approvePlan(run, task, snapshot, context, deps);
  if (status === 'awaiting_approval') {
    if (run.status !== 'waiting_on_you') {
      task.state = 'waiting_on_you';
      run.status = 'waiting_on_you';
      run.reason = `${task.identifier} is ready for your review. Approve its pull request in the chat to continue.`;
      note(run, deps, run.reason);
      save(run, deps);
    }
    return run;
  }
  if (status === 'completed') {
    task.state = 'done';
    run.status = 'running';
    run.reason = undefined;
    note(run, deps, `${task.identifier} is done.`);
    save(run, deps);
    return advanceBoardRun(run, deps);
  }
  if (STOPS.includes(status)) {
    return halt(run, deps, 'paused', `${task.identifier} stopped (${status.replace(/_/g, ' ')}): ${snapshot.run.stoppedReason ?? 'see its build in the chat'}.`);
  }
  if (task.state !== 'working') { task.state = 'working'; save(run, deps); }
  return run;
}

/** Follow the queued request until it becomes a build, or stop the run if it cannot. */
async function followRequest(run: BoardRun, task: BoardRunTask, context: WorkspaceContext, deps: BoardRunDeps): Promise<BoardRun> {
  const request = deps.listRequests(run.workspaceId).find(item => item.id === task.requestId);
  if (!request) return halt(run, deps, 'paused', `${task.identifier}'s build request is missing. Review the run.`);
  if (['needs_review', 'failed', 'cancelled'].includes(request.status)) {
    return halt(run, deps, 'paused', `${task.identifier} could not be planned: ${request.reason ?? request.status}.`);
  }
  if (request.status !== 'accepted' || !request.result?.orchestrationRunId) return run;
  task.orchestrationRunId = request.result.orchestrationRunId;
  return followBuild(run, task, context, deps);
}

/** Note the build each queued task became, so its usage counts and limits can pause it. */
function linkBuilds(run: BoardRun, deps: BoardRunDeps): void {
  const requests = deps.listRequests(run.workspaceId);
  for (const task of run.tasks) {
    if (task.orchestrationRunId || !task.requestId) continue;
    const request = requests.find(item => item.id === task.requestId);
    if (request?.status === 'accepted' && request.result?.orchestrationRunId) task.orchestrationRunId = request.result.orchestrationRunId;
  }
}

function refreshUsage(run: BoardRun, deps: BoardRunDeps): void {
  linkBuilds(run, deps);
  const runIds = run.tasks.flatMap(task => task.orchestrationRunId ? [task.orchestrationRunId] : []);
  run.usage = deps.usage(run.workspaceId, runIds);
}

/** Pause the build that is running, after its current step, when a limit is reached. */
async function pauseCurrentBuild(run: BoardRun, deps: BoardRunDeps): Promise<void> {
  const task = currentTask(run);
  const snapshot = task?.orchestrationRunId ? deps.snapshot(run.workspaceId, task.orchestrationRunId) : null;
  if (snapshot && ['executing', 'validating'].includes(snapshot.run.status)) {
    await deps.pauseBuild(run.workspaceId, snapshot.run.id, snapshot.run.revision, run.ownerId).catch(() => undefined);
  }
}

/** One step of a run: re-check access and limits, then follow or start the current task. */
export async function advanceBoardRun(run: BoardRun, deps: BoardRunDeps = defaultDeps): Promise<BoardRun> {
  if (!ACTIVE.includes(run.status) || run.status === 'paused') return run;
  const context = await deps.resolveContext(run.ownerId, run.workspaceId);
  if (!context || !canRunBuilds(context, run.projectId)) {
    return halt(run, deps, 'paused', `${run.ownerId} can no longer run builds in this project, so the run stopped taking tasks.`);
  }
  refreshUsage(run, deps);
  const limit = overLimit(run);
  if (limit) {
    await pauseCurrentBuild(run, deps);
    return halt(run, deps, 'paused', `${limit} Raise the limit or stop the run.`);
  }
  const task = currentTask(run);
  if (!task) {
    const held = run.tasks.filter(item => item.state === 'held');
    return halt(run, deps, 'completed', held.length
      ? `Finished. ${held.map(item => item.identifier).join(', ')} stayed held for dependencies outside the run.`
      : 'Finished every task in the run.');
  }
  return task.requestId ? followRequest(run, task, context, deps) : startTask(run, task, context, deps);
}

/** Stop taking tasks. A build already in progress stays for its owner to finish or stop. */
export function stopBoardRun(run: BoardRun, actorId: string, deps: BoardRunDeps = defaultDeps): BoardRun {
  const waiting = deps.listRequests(run.workspaceId).find(item => item.id === currentTask(run)?.requestId && item.status === 'waiting');
  if (waiting) deps.cancelRequest(waiting);
  for (const task of run.tasks) if (['queued', 'held'].includes(task.state)) task.state = 'stopped';
  return halt(run, deps, 'stopped', `Stopped by ${actorId}. No new tasks will start.`);
}

export function pauseBoardRun(run: BoardRun, actorId: string, deps: BoardRunDeps = defaultDeps): BoardRun {
  return halt(run, deps, 'paused', `Paused by ${actorId}. The current build is unchanged; no new task starts until you resume.`);
}

/** Resume after a pause, with every check made again on the next step. */
export async function resumeBoardRun(run: BoardRun, actorId: string, limits: { maxTokens?: number | null; maxCostUsd?: number | null } = {},
  deps: BoardRunDeps = defaultDeps): Promise<BoardRun> {
  if (run.status !== 'paused') throw new Error('Only a paused run can be resumed.');
  if ('maxTokens' in limits) run.maxTokens = positiveOrNull(limits.maxTokens, 'token limit');
  if ('maxCostUsd' in limits) run.maxCostUsd = positiveOrNull(limits.maxCostUsd, 'cost limit');
  run.status = 'running';
  run.reason = undefined;
  note(run, deps, `Resumed by ${actorId}.`);
  save(run, deps);
  return advanceBoardRun(run, deps);
}

/** Every active run, one step each. Called from the board request queue's timer. */
export async function advanceBoardRuns(deps: BoardRunDeps = defaultDeps): Promise<void> {
  for (const run of deps.listRuns().filter(item => ['running', 'waiting_on_you'].includes(item.status))) {
    try {
      await runWithWorkspace(run.workspaceId, () => advanceBoardRun(run, deps));
    } catch (error) {
      halt(run, deps, 'paused', `The run stopped on an error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** Tokens and cost reported by the agent runs of these builds; builds without usage are counted, not guessed. */
function buildUsage(workspaceId: string, runIds: string[]): BoardRun['usage'] {
  return runWithWorkspace(workspaceId, () => {
    const prototypeRuns = new Map(sqliteService.getPrototypeRuns().map(run => [run.id, run]));
    let tokens = 0;
    let costUsd = 0;
    let unmeasuredBuilds = 0;
    for (const runId of runIds) {
      const snapshot = sqliteService.getOrchestrationSnapshot(runId);
      const agentRuns = [...new Set(snapshot?.attempts.flatMap(attempt => attempt.prototypeRunId ? [attempt.prototypeRunId] : []) ?? [])]
        .map(id => prototypeRuns.get(id));
      if (agentRuns.some(run => typeof run?.usage?.inputTokens !== 'number')) unmeasuredBuilds += 1;
      for (const run of agentRuns) {
        tokens += (run?.usage?.inputTokens ?? 0) + (run?.usage?.outputTokens ?? 0);
        costUsd += run?.usage?.costUsd ?? 0;
      }
    }
    return { tokens, costUsd, unmeasuredBuilds };
  });
}

export const defaultDeps: BoardRunDeps = {
  now: () => new Date().toISOString(),
  listRuns: workspaceId => sqliteService.listBoardRuns(workspaceId) as BoardRun[],
  saveRun: run => sqliteService.saveBoardRun(run),
  listIssues: workspaceId => issueStore().list(workspaceId),
  getProject: (workspaceId, projectId) => projectStore().get(workspaceId, projectId),
  getSpecVersion: issueId => sqliteService.getFeatureSpec(issueId)?.version ?? 0,
  resolveContext: (ownerId, workspaceId) => workspaceRegistry.resolve(ownerId, workspaceId),
  requestBuild: input => requestBoardBuild(input),
  listRequests: workspaceId => sqliteService.listBoardBuildRequests(workspaceId) as BoardBuildRequest[],
  cancelRequest: request => sqliteService.saveBoardBuildRequest({ ...request, status: 'cancelled', updatedAt: new Date().toISOString() }),
  snapshot: (workspaceId, runId) => runWithWorkspace(workspaceId, () => sqliteService.getOrchestrationSnapshot(runId) ?? null),
  startPlan: async (context, projectId, runId, revision) => {
    const { executeOrchestrationDecision } = await import('./orchestrationDecision.js');
    return executeOrchestrationDecision({ context, projectId, runId, action: 'start', expectedRevision: revision });
  },
  pauseBuild: async (workspaceId, runId, revision, actorId) => {
    const { orchestrationService } = await import('./orchestrationRuntime.js');
    return orchestrationService.pauseRun({ workspaceId, runId, expectedRevision: revision, actorId });
  },
  usage: buildUsage
};
