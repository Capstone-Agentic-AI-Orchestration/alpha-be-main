import type { OrchestrationSnapshot } from './orchestrationStateMachine.js';
import { localPreviewService, redactPreviewLog, type LocalPreview } from './localPreviewService.js';
import { workspaceRegistry } from './workspaceRegistry.js';
import { sqliteService } from './sqliteService.js';
import { runWithWorkspace } from './workspaceContext.js';
import { randomUUID } from 'node:crypto';

/** Called once at task acceptance, never by polling the UI or reopening a panel. */
export async function prepareAcceptedWebsitePreview(snapshot: OrchestrationSnapshot, taskId: string): Promise<void> {
  const task = snapshot.tasks.find(task => task.id === taskId);
  const attempt = [...snapshot.attempts].reverse().find(attempt => attempt.taskId === taskId && attempt.status === 'accepted');
  const threadId = snapshot.run.originChatThreadId;
  const evidence = attempt?.result?.acceptanceEvidence as { changedPaths?: unknown } | undefined;
  if (!threadId || task?.kind !== 'frontend' || task.status !== 'accepted' || !attempt?.resultCommit ||
      !Array.isArray(evidence?.changedPaths) || !evidence.changedPaths.length || !['executing', 'validating', 'awaiting_approval', 'completed'].includes(snapshot.run.status)) return;
  const context = await workspaceRegistry.resolve(snapshot.run.createdBy, snapshot.run.workspaceId);
  if (!context) return;
  await localPreviewService.authorize(context, threadId);
  const repository = task.repository ?? snapshot.run.repository;
  const messageId = `${snapshot.run.id}:${task.id}:${attempt.resultCommit}`;
  const previous = await localPreviewService.list(context, threadId);
  if (previous.some(record => record.messageId === messageId)) return;
  try {
    await localPreviewService.start(context, threadId, repository, messageId, { runId: snapshot.run.id, taskId, commit: attempt.resultCommit });
  } catch (error) {
    // Keep setup failures readable in the right panel, even when no process could be created.
    const now = new Date().toISOString();
    const record: LocalPreview = { id: randomUUID(), workspaceId: context.workspaceId, ownerId: context.userId, threadId,
      projectId: snapshot.run.projectId, repository, commit: attempt.resultCommit, branch: snapshot.run.branchName ?? '',
      source: 'saved-build', state: 'failed', logs: '', error: redactPreviewLog((error as Error).message),
      createdAt: now, updatedAt: now, messageId, capability: randomUUID() };
    runWithWorkspace(context.workspaceId, () => sqliteService.saveLocalPreview(record));
    localPreviewService.emit('status', record);
  }
}
