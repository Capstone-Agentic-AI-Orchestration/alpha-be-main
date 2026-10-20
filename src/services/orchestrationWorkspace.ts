import type { OrchestrationRunRecord, OrchestrationSnapshot, OrchestrationRepositoryWorkspace } from './orchestrationStateMachine.js';

function canonicalRepository(value: string): string {
  return value.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/$/, '').toLowerCase();
}

/** Resolve the authorized private branch for one repository in a product build. */
export function repositoryWorkspaceForRun(
  run: OrchestrationRunRecord,
  repository = run.repository
): OrchestrationRepositoryWorkspace | undefined {
  const wanted = canonicalRepository(repository);
  const saved = run.repositoryWorkspaces?.find(item => canonicalRepository(item.repository) === wanted);
  if (saved) return saved;
  if (wanted !== canonicalRepository(run.repository) || !run.branchName || !run.baseRef || !run.baseCommit || !run.worktreePath) return undefined;
  return {
    repository: run.repository,
    branchName: run.branchName,
    baseRef: run.baseRef,
    baseCommit: run.baseCommit,
    worktreePath: run.worktreePath
  };
}

/** Resolve the codebase selected on a task, falling back to old one-repository plans. */
export function repositoryWorkspaceForTask(
  snapshot: OrchestrationSnapshot,
  taskId: string
): OrchestrationRepositoryWorkspace | undefined {
  const definition = snapshot.run.plan.tasks.find(item => item.id === taskId);
  return repositoryWorkspaceForRun(snapshot.run, definition?.repository ?? snapshot.run.repository);
}

export function authorizedRepositoriesForRun(run: OrchestrationRunRecord): string[] {
  const saved = run.repositoryWorkspaces?.map(item => item.repository).filter(Boolean) ?? [];
  return saved.length ? saved : [run.repository];
}

