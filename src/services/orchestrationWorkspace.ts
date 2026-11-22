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

/**
 * The repository options every plan check on a saved run must use: the run's codebases, and the
 * ones a plan may leave without tasks. Use this, never the bare repository list, so a codebase the
 * planner was allowed to skip is not refused later at start, revision or milestone expansion.
 */
export function planRepositoryCoverage(run: OrchestrationRunRecord): { repositories: string[]; optionalRepositories: string[] } {
  const repositories = authorizedRepositoriesForRun(run);
  const workspaces = run.repositoryWorkspaces ?? [];
  if (workspaces.some(item => typeof item.optional === 'boolean')) {
    return { repositories, optionalRepositories: workspaces.filter(item => item.optional).map(item => item.repository) };
  }
  // Saved before the flag existed. That plan passed the full check when it was made, so a codebase
  // it left without tasks or milestone was optional then and stays optional.
  const used = new Set([
    ...(run.plan?.tasks ?? []).map(task => task.repository),
    ...(run.plan?.milestones ?? []).flatMap(milestone => milestone.repositories)
  ].filter((value): value is string => Boolean(value)).map(canonicalRepository));
  return { repositories, optionalRepositories: repositories.filter(repository => !used.has(canonicalRepository(repository))) };
}

