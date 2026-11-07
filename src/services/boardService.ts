import { agentStore, issueStore, runStore } from '../store/stores.js';
import { IS_CLOUD } from '../config/env.js';
import { pushIssue, needsPush, publishNewIssue, publishedFields } from './githubBoardWrite.js';
import { issueIdFor } from './githubRepoDiscovery.js';
import { supabaseService } from './supabaseService.js';
import { sqliteService } from './sqliteService.js';
import { workspaceRegistry } from './workspaceRegistry.js';
import { runWithWorkspace } from './workspaceContext.js';
import type { Issue, IssueStatus } from '../models/index.js';

/**
 * The board's card rules, in one place.
 *
 * The board routes and the agent board tool both go through these, so an
 * agent can never do on the board what a person could not do by hand, and a
 * rule changed here changes for both. Callers check the caller's own access
 * (workspace, project) first; these functions check the card itself.
 */
export class BoardRuleError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 410) {
    super(message);
    this.name = 'BoardRuleError';
  }
}

export const ISSUE_STATUSES: readonly IssueStatus[] = [
  'backlog',
  'todo',
  'in_progress',
  'agent_running',
  'review',
  'done'
];

const ACTIVE_RUN_STATUSES = new Set([
  'queued',
  'running',
  'awaiting_approval',
  'validating'
]);

const SQUADS_REMOVED = 'Squads were removed. The Orchestrator assigns agents to each build task by role.';
const has = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

export function isIssueStatus(value: unknown): value is IssueStatus {
  return typeof value === 'string' && ISSUE_STATUSES.includes(value as IssueStatus);
}

/** An Orchestrator build on this card that has not completed, failed or been cancelled. */
export function hasUnfinishedManagedBuild(workspaceId: string, issue: Issue): boolean {
  if (IS_CLOUD) return false;
  const latest = runWithWorkspace(workspaceId, () => sqliteService.listLatestIssueBuilds([issue.projectId]).find(item => item.issueId === issue.id));
  return Boolean(latest && !['completed', 'failed', 'cancelled'].includes(latest.status));
}

export async function activeRunForIssue(workspaceId: string, issueId: string) {
  return (await runStore().listSummaries(workspaceId)).find(run =>
    run.issueId === issueId && ACTIVE_RUN_STATUSES.has(run.status)
  );
}

/**
 * Status is writable through the generic issue endpoint only for ordinary
 * planning moves. Starting an agent and completing reviewed work are commands
 * with their own endpoints; otherwise a caller could skip the preparation or
 * review gate by sending { status: 'agent_running' } or { status: 'done' } to
 * PUT /issues/:id.
 */
export async function statusTransitionError(workspaceId: string, issue: Issue, requestedStatus: unknown): Promise<string | null> {
  if (requestedStatus === undefined || requestedStatus === issue.status) return null;

  if (!isIssueStatus(requestedStatus)) {
    return 'status must be one of: ' + ISSUE_STATUSES.join(', ') + '.';
  }
  if (hasUnfinishedManagedBuild(workspaceId, issue)) return 'This task has an unfinished build. Open its Build tab before changing the task status.';

  const activeRun = await activeRunForIssue(workspaceId, issue.id);

  if (requestedStatus === 'agent_running') {
    return 'Start an agent run through POST /api/runs/start; direct status changes to Agent Running are not allowed.';
  }

  if (requestedStatus === 'done') {
    if (activeRun?.status === 'awaiting_approval') {
      return 'Run ' + activeRun.id + ' is awaiting approval; approve it through POST /api/runs/' + activeRun.id + '/approve.';
    }
    if (activeRun) {
      return 'Run ' + activeRun.id + ' is still ' + activeRun.status + '; wait for it to reach review before completing the task.';
    }
    if (issue.status === 'agent_running') {
      return 'A task with an agent running must reach review before it can be completed.';
    }
    return 'Complete the task only after a person has reviewed it; direct status changes to Done are not allowed.';
  }

  if (activeRun) {
    return 'This task has an active agent run (' + activeRun.id + ') still ' + activeRun.status + '; use the run controls before changing this task.';
  }

  return null;
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function normalizedScheduleDate(value: unknown): string | undefined {
  return value === '' || value === null || value === undefined ? undefined : value as string;
}

function issueDueDateError(value: unknown): string | null {
  return value === '' || value === null || value === undefined || isCalendarDate(value)
    ? null
    : 'Due date must be a valid calendar date.';
}

/** Reject malformed schedules and dependency links that leave a project or form a cycle. */
async function issueScheduleError(
  workspaceId: string,
  projectId: string,
  issueId: string | undefined,
  plannedStartDate: unknown,
  plannedEndDate: unknown,
  dependsOnIssueIds: unknown
): Promise<string | null> {
  const start = normalizedScheduleDate(plannedStartDate);
  const end = normalizedScheduleDate(plannedEndDate);
  if (start !== undefined && !isCalendarDate(start)) return 'Start date must be a valid calendar date.';
  if (end !== undefined && !isCalendarDate(end)) return 'End date must be a valid calendar date.';
  if (start && end && start > end) return 'End date must be on or after the start date.';

  const dependencies = dependsOnIssueIds ?? [];
  if (!Array.isArray(dependencies) || dependencies.some(id => typeof id !== 'string')) {
    return 'Dependencies must be a list of task IDs.';
  }
  if (new Set(dependencies).size !== dependencies.length) return 'A dependency can only be selected once.';
  if (dependencies.length === 0) return null;

  const issues = await issueStore().list(workspaceId);
  const byId = new Map(issues.map(issue => [issue.id, issue]));
  for (const dependencyId of dependencies as string[]) {
    if (dependencyId === issueId) return 'A task cannot depend on itself.';
    const dependency = byId.get(dependencyId);
    if (!dependency || dependency.projectId !== projectId) {
      return 'Dependencies must be tasks in the same project.';
    }
  }

  if (issueId) {
    const reachesIssue = (candidateId: string, visited = new Set<string>()): boolean => {
      if (candidateId === issueId) return true;
      if (visited.has(candidateId)) return false;
      visited.add(candidateId);
      const candidate = byId.get(candidateId);
      return (candidate?.dependsOnIssueIds ?? []).some(id => reachesIssue(id, visited));
    };
    if ((dependencies as string[]).some(id => reachesIssue(id))) {
      return 'This dependency would create a circular task dependency.';
    }
  }

  return null;
}

/** Keep a suggested work package under one top-level task in the same project. */
async function issueParentError(
  workspaceId: string,
  projectId: string,
  issueId: string | undefined,
  parentIssueId: unknown
): Promise<string | null> {
  if (parentIssueId === undefined || parentIssueId === null || parentIssueId === '') return null;
  if (typeof parentIssueId !== 'string') return 'Parent task must be a task ID.';
  if (parentIssueId === issueId) return 'A task cannot be its own parent.';

  const issues = await issueStore().list(workspaceId);
  const parent = issues.find(issue => issue.id === parentIssueId);
  if (!parent || parent.projectId !== projectId) return 'Parent and child tasks must be in the same project.';
  if (parent.parentIssueId || (issueId && issues.some(issue => issue.parentIssueId === issueId))) {
    return 'Work packages can be grouped under a top-level task only.';
  }
  return null;
}

/**
 * Check and normalise a new card. The caller has already checked that the
 * project is one the caller may use. Identifier and comments are the
 * daemon's, never the caller's.
 */
export async function prepareCardCreate(workspaceId: string, body: Record<string, any>): Promise<Record<string, any>> {
  const { identifier: _ignored, comments: _alsoIgnored, ...rest } = body ?? {};
  if (rest.assignedSquadId) throw new BoardRuleError(SQUADS_REMOVED, 410);
  delete rest.assignedSquadId;
  if (!rest.projectId || typeof rest.projectId !== 'string') {
    throw new BoardRuleError('A project is required for a task in this workspace.', 400);
  }
  const scheduleError = await issueScheduleError(
    workspaceId,
    rest.projectId,
    typeof rest.id === 'string' ? rest.id : undefined,
    rest.plannedStartDate,
    rest.plannedEndDate,
    rest.dependsOnIssueIds
  );
  if (scheduleError) throw new BoardRuleError(scheduleError, 400);
  rest.plannedStartDate = normalizedScheduleDate(rest.plannedStartDate);
  rest.plannedEndDate = normalizedScheduleDate(rest.plannedEndDate);
  const dueDateError = issueDueDateError(rest.dueDate);
  if (dueDateError) throw new BoardRuleError(dueDateError, 400);
  rest.dueDate = normalizedScheduleDate(rest.dueDate);
  const parentError = await issueParentError(workspaceId, rest.projectId, typeof rest.id === 'string' ? rest.id : undefined, rest.parentIssueId);
  if (parentError) throw new BoardRuleError(parentError, 400);
  if (rest.parentIssueId === '') rest.parentIssueId = undefined;
  rest.dependsOnIssueIds ??= [];
  if (rest.status === 'agent_running') {
    throw new BoardRuleError('Tasks enter Building only when a developer or admin starts an Orchestrator build.', 409);
  }
  return rest;
}

/**
 * Create a checked card: published to GitHub first so it is born under
 * GitHub's id, then saved, opened with a comment, and shared with the team.
 */
export async function createCard(
  workspaceId: string,
  rest: Record<string, any>,
  creatorLogin: string,
  openingComment?: string
): Promise<{ saved: Issue; syncWarning?: string }> {
  const draft = { status: 'todo', priority: 'medium', labels: [], ...rest, createdBy: rest.createdBy || creatorLogin } as unknown as Issue;

  /*
   * Published first, so the card is born under GitHub's id.
   *
   * It used to be created and then pushed, keeping the id it was created with,
   * while the cloud's sync and every teammate's desktop met the same issue on
   * GitHub and named it after GitHub's id instead: one issue, two cards, and a
   * run on either unknown to the other. Awaited because the response carries
   * the issue number, and a card that does not know which GitHub issue it is
   * cannot be updated later. A project with no repository publishes nothing.
   */
  const { published, error: publishError } = await publishNewIssue(draft, workspaceId);
  const issue = await issueStore().create(workspaceId, {
    ...draft,
    ...(published ? { id: issueIdFor(published.githubIssueId), ...publishedFields(published) } : {})
  });
  workspaceRegistry.bind('issues', issue.id, workspaceId);

  // Written where the real identifier is known.
  await issueStore().addComment(workspaceId, {
    id: `comm-${issue.id}-created`,
    issueId: issue.id,
    authorType: 'system',
    authorName: 'Alpha',
    content: openingComment ?? `${issue.identifier} created by ${creatorLogin}.`,
    createdAt: issue.createdAt
  });

  const saved = await issueStore().get(workspaceId, issue.id) ?? issue;
  // The issue first, since the database refuses a comment on an issue it does not have.
  await supabaseService.shareIssue(saved);
  for (const comment of saved.comments ?? []) void supabaseService.shareComment(comment);
  return publishError ? { saved, syncWarning: publishError } : { saved };
}

/**
 * Check and normalise changes to an existing card. The caller has already
 * checked access to the card's project and, when the card moves, to the new
 * project.
 */
export async function prepareCardUpdate(workspaceId: string, before: Issue, body: Record<string, any>): Promise<Record<string, any>> {
  const updates: Record<string, any> = body && typeof body === 'object' ? body : {};
  if (has(updates, 'dueDate')) {
    const dueDateError = issueDueDateError(updates.dueDate);
    if (dueDateError) throw new BoardRuleError(dueDateError, 400);
    updates.dueDate = normalizedScheduleDate(updates.dueDate);
  }
  const nextProjectId = typeof updates.projectId === 'string' ? updates.projectId : before.projectId;
  if (nextProjectId !== before.projectId && (await issueStore().list(workspaceId)).some(issue => issue.parentIssueId === before.id)) {
    throw new BoardRuleError('Move child tasks before moving this task to another project.', 400);
  }
  const nextParentIssueId = has(updates, 'parentIssueId') ? updates.parentIssueId : before.parentIssueId;
  const parentError = await issueParentError(workspaceId, nextProjectId, before.id, nextParentIssueId);
  if (parentError) throw new BoardRuleError(parentError, 400);
  if (has(updates, 'parentIssueId') && (updates.parentIssueId === '' || updates.parentIssueId === null)) updates.parentIssueId = undefined;
  const scheduleTouched = nextProjectId !== before.projectId ||
    ['plannedStartDate', 'plannedEndDate', 'dependsOnIssueIds'].some(field => has(updates, field));
  if (scheduleTouched) {
    const plannedStartDate = has(updates, 'plannedStartDate') ? updates.plannedStartDate : before.plannedStartDate;
    const plannedEndDate = has(updates, 'plannedEndDate') ? updates.plannedEndDate : before.plannedEndDate;
    const dependsOnIssueIds = has(updates, 'dependsOnIssueIds') ? updates.dependsOnIssueIds : before.dependsOnIssueIds;
    const scheduleError = await issueScheduleError(workspaceId, nextProjectId, before.id, plannedStartDate, plannedEndDate, dependsOnIssueIds);
    if (scheduleError) throw new BoardRuleError(scheduleError, 400);
    if (has(updates, 'plannedStartDate')) updates.plannedStartDate = normalizedScheduleDate(plannedStartDate);
    if (has(updates, 'plannedEndDate')) updates.plannedEndDate = normalizedScheduleDate(plannedEndDate);
    if (has(updates, 'dependsOnIssueIds')) updates.dependsOnIssueIds = dependsOnIssueIds ?? [];
  }

  // Empty strings are explicit clears from the owner selector; normalize before either store writes foreign keys.
  if (updates.assignedSquadId) throw new BoardRuleError(SQUADS_REMOVED, 410);
  if (has(updates, 'assignedSquadId')) updates.assignedSquadId = undefined;
  if (has(updates, 'assignedAgentId') && !updates.assignedAgentId) updates.assignedAgentId = undefined;
  if (updates.assignedAgentId && !(await agentStore().get(workspaceId, updates.assignedAgentId))) {
    throw new BoardRuleError('The selected agent is unavailable in this workspace.', 400);
  }
  const transitionError = await statusTransitionError(workspaceId, before, updates.status);
  if (transitionError) throw new BoardRuleError(transitionError, isIssueStatus(updates.status) ? 409 : 400);
  return updates;
}

/**
 * Save checked changes, push the fields GitHub owns when one of them moved,
 * and share the result with the team. A failed push is reported as a
 * warning: the local write already happened.
 */
export async function saveCardUpdate(
  workspaceId: string,
  before: Issue,
  updates: Record<string, any>
): Promise<{ saved: Issue; syncWarning?: string }> {
  const updated = await issueStore().update(workspaceId, before.id, updates);
  if (!updated) throw new BoardRuleError('Task not found', 404);

  // Only when a field GitHub owns actually moved: Alpha's own fields cost no GitHub request.
  if (!needsPush(before, updated)) {
    void supabaseService.shareIssue(updated);
    return { saved: updated };
  }

  const push = await pushIssue(updated, workspaceId);
  if (push.patch) await issueStore().update(workspaceId, updated.id, push.patch);
  const saved = await issueStore().get(workspaceId, updated.id) ?? updated;
  void supabaseService.shareIssue(saved);
  return push.error ? { saved, syncWarning: push.error } : { saved };
}

/** Why this card cannot be removed or archived right now, or null. */
export async function cardRemovalBlocker(workspaceId: string, issue: Issue, action: 'removing' | 'archiving' = 'removing'): Promise<string | null> {
  if (await activeRunForIssue(workspaceId, issue.id)) {
    return `This task has an active agent run; wait for it to stop before ${action} the task.`;
  }
  if (hasUnfinishedManagedBuild(workspaceId, issue)) {
    return `This task has an unfinished build. Finish, cancel or recover it in the Build tab before ${action} the task.`;
  }
  return null;
}

/** Remove a card everywhere it is shared. Check cardRemovalBlocker first. */
export async function removeCard(workspaceId: string, issueId: string): Promise<boolean> {
  const deleted = await issueStore().remove(workspaceId, issueId);
  if (deleted) {
    await workspaceRegistry.unbind('issues', issueId);
    void supabaseService.unshareIssue(issueId);
  }
  return deleted;
}

async function addSystemComment(workspaceId: string, issueId: string, content: string, kind: string): Promise<void> {
  const comment = await issueStore().addComment(workspaceId, {
    id: `comm-${issueId}-${kind}-${Date.now()}`,
    issueId,
    authorType: 'system',
    authorName: 'Alpha',
    content,
    createdAt: new Date().toISOString()
  });
  void supabaseService.shareComment(comment);
}

/**
 * Take a card off the board, keeping its comments and history. Leaves any
 * GitHub issue untouched. `archivedBy` names who did it, or the agent and the
 * person it acted for.
 */
export async function archiveCard(workspaceId: string, before: Issue, archivedBy: string): Promise<{ saved: Issue; syncWarning?: string }> {
  if (before.archivedAt) return { saved: before };
  const blocker = await cardRemovalBlocker(workspaceId, before, 'archiving');
  if (blocker) throw new BoardRuleError(blocker, 409);
  const result = await saveCardUpdate(workspaceId, before, { archivedAt: new Date().toISOString(), archivedBy });
  await addSystemComment(workspaceId, before.id, `Archived by ${archivedBy}.`, 'archived');
  return result;
}

/** Put an archived card back on the board where it was. */
export async function restoreCard(workspaceId: string, before: Issue, restoredBy: string): Promise<{ saved: Issue; syncWarning?: string }> {
  if (!before.archivedAt) return { saved: before };
  const result = await saveCardUpdate(workspaceId, before, { archivedAt: undefined, archivedBy: undefined });
  await addSystemComment(workspaceId, before.id, `Restored by ${restoredBy}.`, 'restored');
  return result;
}

/** Which cards a board read returns: on the board (default), archived only, or both. */
export function filterArchived<T extends Pick<Issue, 'archivedAt'>>(issues: T[], which: unknown): T[] {
  if (which === 'include') return issues;
  if (which === 'only') return issues.filter(issue => issue.archivedAt);
  return issues.filter(issue => !issue.archivedAt);
}

