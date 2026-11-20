import type { Issue, IssueSubtask } from '../models/index.js';
import type { IssueStore } from '../store/issueStore.js';
import { issueStore } from '../store/stores.js';
import type { OrchestrationSnapshot } from './orchestrationStateMachine.js';
import { checklistRequirementId } from './issueChecklist.js';
import { shareCard } from './boardShareQueue.js';
import { supabaseService } from './supabaseService.js';
import { logError } from '../utils/logger.js';

/**
 * The team's board, for a card this machine moved.
 *
 * On a desktop the issue store is the machine's own copy, and it deliberately
 * never publishes (the board pull writes through it too). A finished build is
 * this machine's own change, so it has to be sent on, or the card reads Todo
 * for everyone but the person whose desktop ran the build.
 */
export interface TeamBoard {
  /** Send the card; false when it was queued for a retry. */
  share(issue: Issue, workspaceId: string): Promise<boolean>;
  /**
   * Whether the team board's copy of the card is behind this one, read before
   * a repair so an unchanged card is never written: every write reaches every
   * teammate's next sync, so a no-op write still costs each of them a download.
   */
  isBehind(issue: Issue): Promise<boolean>;
}

export const teamBoard: TeamBoard = {
  share: (issue, workspaceId) => shareCard(issue, workspaceId),
  async isBehind(issue) {
    if (!supabaseService.sharesBoard()) return false;
    try {
      const shared = await supabaseService.sharedIssueState(issue.id);
      return !shared || shared.status !== issue.status || shared.prUrl !== (issue.prUrl ?? null);
    } catch (error) {
      // Unreachable now; the next start checks again rather than queueing blind writes.
      logError(`Could not compare ${issue.identifier} with the team board:`, error instanceof Error ? error.message : String(error));
      return false;
    }
  }
};

/** Evidence must cover every current required task, including validation.
 * Superseded work and earlier accepted attempts cannot prove the current work.
 */
function evidencedRequirementIds(snapshot: OrchestrationSnapshot): Set<string> {
  const ids = new Set<string>();
  for (const requirement of snapshot.run.plan.requirements) {
    const tasks = snapshot.tasks.filter(task => task.required && task.status !== 'superseded' && task.requirementIds.includes(requirement.id));
    if (!tasks.some(task => task.kind === 'validation') || !tasks.every(task => {
      if (task.status !== 'accepted') return false;
      const attempt = snapshot.attempts.filter(item => item.taskId === task.id)
        .sort((a, b) => b.attemptNumber - a.attemptNumber)[0];
      if (attempt?.status !== 'accepted') return false;
      const report = attempt.result?.agentReport;
      const coverage = report && typeof report === 'object' ? (report as Record<string, unknown>).requirementCoverage : undefined;
      return Array.isArray(coverage) && coverage.some(item => item && typeof item === 'object' &&
        item.requirementId === requirement.id && typeof item.evidence === 'string' && item.evidence.trim());
    })) continue;
    ids.add(requirement.id);
  }
  return ids;
}

/**
 * Tick unchanged checklist items whose requirement has accepted validation evidence.
 * Runs once, in the same update that records the pull request, so a build never
 * writes the shared task while it is running.
 */
export function tickSpecChecklist(subtasks: readonly IssueSubtask[], snapshot: OrchestrationSnapshot): IssueSubtask[] {
  // Old persisted snapshots may predate task plans. Never infer completion.
  if (!snapshot.run?.plan?.requirements || !snapshot.tasks?.length) return [...subtasks];
  const evidenced = evidencedRequirementIds(snapshot);
  return subtasks.map(item => {
    const requirementId = item.source === 'spec' ? item.requirementId : checklistRequirementId(item);
    const requirement = snapshot.run.plan.requirements.find(entry => entry.id === requirementId);
    // Spec titles are a bounded rendering of the approved behavior. A person
    // can edit them too, so check the wording before applying old evidence.
    const specTitle = requirement ? `${requirement.id}: ${requirement.description.split(' Acceptance: ')[0]}` : '';
    const unchanged = item.source !== 'spec' || item.title === (specTitle.length > 140 ? `${specTitle.slice(0, 137)}...` : specTitle);
    return !item.completed && unchanged && requirementId && evidenced.has(requirementId)
      ? { ...item, completed: true }
      : item;
  });
}

/**
 * Synchronize durable completion (a published change or a read-only report) to the board.
 *
 * Moves the card and sends it to the team's board. It writes no comment: task
 * comments are for people, and the build's progress lives in its chat.
 */
export async function synchronizePublishedOrchestrationIssue(
  snapshot: OrchestrationSnapshot,
  store: Pick<IssueStore, 'get' | 'update'> = issueStore(),
  board: TeamBoard = teamBoard
): Promise<void> {
  const publication = snapshot.run.publication;
  const reportOnly = snapshot.run.status === 'completed' && !publication && snapshot.tasks?.length > 0 &&
    snapshot.tasks.every(task => !['database', 'backend', 'frontend', 'mobile'].includes(task.kind)) &&
    snapshot.tasks.filter(task => task.required).every(task => task.status === 'accepted');
  if (reportOnly) {
    const issue = await store.get(snapshot.run.workspaceId, snapshot.run.issueId);
    if (!issue || issue.projectId !== snapshot.run.projectId) throw new Error('The project task for this completed report is unavailable. Retry to synchronize it.');
    if (issue.status === 'done' || issue.status === 'review') return shareIfBehind(issue, snapshot, board);
    const saved = await store.update(snapshot.run.workspaceId, issue.id, { status: 'review' });
    if (!saved) throw new Error('The report is complete, but its project task could not be synchronized.');
    await board.share(saved, snapshot.run.workspaceId);
    return;
  }
  if (snapshot.run.status !== 'completed' || !publication) {
    throw new Error('A reconciled pull request is required before the project task can move to review.');
  }

  const issue = await store.get(snapshot.run.workspaceId, snapshot.run.issueId);
  if (!issue || issue.projectId !== snapshot.run.projectId) {
    throw new Error('The project task for this published build is unavailable. Retry to synchronize it.');
  }

  // A human may have completed the issue after the PR was opened; do not move
  // it backwards, but always reconcile the durable branch and PR references.
  const status = issue.status === 'done' ? 'done' : 'review';
  const subtasks = tickSpecChecklist(issue.subtasks ?? [], snapshot);
  const checklistChanged = subtasks.some((item, index) => item.completed !== issue.subtasks[index]?.completed);
  if (issue.status !== status || issue.prUrl !== publication.pullRequestUrl || issue.branchName !== publication.branchName || checklistChanged) {
    const savedIssue = await store.update(snapshot.run.workspaceId, issue.id, {
      status,
      prUrl: publication.pullRequestUrl,
      branchName: publication.branchName,
      ...(checklistChanged ? { subtasks } : {})
    });
    if (!savedIssue) {
      throw new Error('The pull request is open, but the project task could not be synchronized. Retry to update it.');
    }
    await board.share(savedIssue, snapshot.run.workspaceId);
    return;
  }
  // Already right here. The team board may not be: before this was sent on,
  // a finished build moved the card on the machine that ran it and nowhere else.
  await shareIfBehind(issue, snapshot, board);
}

async function shareIfBehind(issue: Issue, snapshot: OrchestrationSnapshot, board: TeamBoard): Promise<void> {
  if (await board.isBehind(issue)) await board.share(issue, snapshot.run.workspaceId);
}

export async function replayPublishedOrchestrationIssueEffects(
  snapshots: readonly OrchestrationSnapshot[],
  store: Pick<IssueStore, 'get' | 'update'> = issueStore(),
  board: TeamBoard = teamBoard
): Promise<{ synchronized: string[]; failed: Array<{ runId: string; reason: string }> }> {
  const synchronized: string[] = [];
  const failed: Array<{ runId: string; reason: string }> = [];
  for (const snapshot of snapshots) {
    try {
      await synchronizePublishedOrchestrationIssue(snapshot, store, board);
      synchronized.push(snapshot.run.id);
    } catch (error) {
      failed.push({
        runId: snapshot.run.id,
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return { synchronized, failed };
}
