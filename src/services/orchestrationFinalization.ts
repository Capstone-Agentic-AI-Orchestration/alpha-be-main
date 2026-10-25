import type { IssueStore } from '../store/issueStore.js';
import { issueStore } from '../store/stores.js';
import type { OrchestrationSnapshot } from './orchestrationStateMachine.js';

const PUBLISHED_COMMENT_SUFFIX = 'orchestration-published';

/** Synchronize durable completion (a published change or a read-only report) to the board. */
export async function synchronizePublishedOrchestrationIssue(
  snapshot: OrchestrationSnapshot,
  store: Pick<IssueStore, 'get' | 'update' | 'addComment'> = issueStore()
): Promise<void> {
  const publication = snapshot.run.publication;
  const reportOnly = snapshot.run.status === 'completed' && !publication && snapshot.tasks?.length > 0 &&
    snapshot.tasks.every(task => !['database', 'backend', 'frontend', 'mobile'].includes(task.kind)) &&
    snapshot.tasks.filter(task => task.required).every(task => task.status === 'accepted');
  if (reportOnly) {
    const issue = await store.get(snapshot.run.workspaceId, snapshot.run.issueId);
    if (!issue || issue.projectId !== snapshot.run.projectId) throw new Error('The project task for this completed report is unavailable. Retry to synchronize it.');
    const commentId = `comm-${snapshot.run.id}-orchestration-report-completed`;
    if (!issue.comments.some(comment => comment.id === commentId)) await store.addComment(snapshot.run.workspaceId, {
      id: commentId, issueId: issue.id, authorType: 'system', authorName: 'Alpha Task Workflow',
      content: 'Read-only investigation completed. No repository files changed. Review the specialist reports in this conversation.', createdAt: snapshot.run.updatedAt
    });
    if (issue.status !== 'done' && !await store.update(snapshot.run.workspaceId, issue.id, { status: 'done' })) throw new Error('The report is complete, but its project task could not be synchronized.');
    return;
  }
  if (snapshot.run.status !== 'completed' || !publication) {
    throw new Error('A reconciled pull request is required before the project task can move to review.');
  }

  const issue = await store.get(snapshot.run.workspaceId, snapshot.run.issueId);
  if (!issue || issue.projectId !== snapshot.run.projectId) {
    throw new Error('The project task for this published build is unavailable. Retry to synchronize it.');
  }

  const commentId = `comm-${snapshot.run.id}-${PUBLISHED_COMMENT_SUFFIX}`;
  const publications = snapshot.run.publications?.length ? snapshot.run.publications : [publication];
  const pullRequests = publications.map(item => `${item.repository ?? snapshot.run.repository}: ${item.pullRequestUrl}`).join('\n');
  if (!issue.comments.some(comment => comment.id === commentId)) {
    await store.addComment(snapshot.run.workspaceId, {
      id: commentId,
      issueId: issue.id,
      authorType: 'system',
      authorName: 'Alpha Task Workflow',
      content: `Orchestrator build approved and published for review:\n${pullRequests}`,
      createdAt: publication.publishedAt
    });
  }

  // A human may have completed the issue after the PR was opened; do not move
  // it backwards, but always reconcile the durable branch and PR references.
  const status = issue.status === 'done' ? 'done' : 'review';
  if (issue.status !== status || issue.prUrl !== publication.pullRequestUrl || issue.branchName !== publication.branchName) {
    const savedIssue = await store.update(snapshot.run.workspaceId, issue.id, {
      status,
      prUrl: publication.pullRequestUrl,
      branchName: publication.branchName
    });
    if (!savedIssue) {
      throw new Error('The pull request is open, but the project task could not be synchronized. Retry to update it.');
    }
  }
}

export async function replayPublishedOrchestrationIssueEffects(
  snapshots: readonly OrchestrationSnapshot[],
  store: Pick<IssueStore, 'get' | 'update' | 'addComment'> = issueStore()
): Promise<{ synchronized: string[]; failed: Array<{ runId: string; reason: string }> }> {
  const synchronized: string[] = [];
  const failed: Array<{ runId: string; reason: string }> = [];
  for (const snapshot of snapshots) {
    try {
      await synchronizePublishedOrchestrationIssue(snapshot, store);
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
