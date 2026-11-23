import { isImplementationTask } from './agentRoleContracts.js';
import { CI_CHECKS, type OrchestrationRequiredCheck } from './orchestrationContract.js';
import type { OrchestrationSnapshot, OrchestrationTaskRecord } from './orchestrationStateMachine.js';
import { repositoryWorkspaceForTask } from './orchestrationWorkspace.js';
import { definedCheckScripts } from './repositoryExecution.js';
import { sameRepository } from '../utils/repositoryName.js';

interface CheckedTask {
  kind: string;
  repository?: string;
  requiredChecks: readonly OrchestrationRequiredCheck[];
}

/**
 * Every check a build runs in one repository: the requiredChecks of all its tasks there,
 * first-declared order. Use this, never a local union of requiredChecks.
 */
export function repositoryChecks(
  tasks: readonly CheckedTask[],
  repository: string | undefined,
  runRepository: string
): OrchestrationRequiredCheck[] {
  return [...new Set(tasks
    .filter(task => sameRepository(task.repository ?? runRepository, repository ?? runRepository))
    .flatMap(task => task.requiredChecks))];
}

/**
 * The checks a task must pass. Repository checks such as `eslint src tests` or `tsc` cover the
 * whole repository, not the task's files, so a code task accepted with fewer checks than a later
 * task leaves failures the later task cannot fix: they sit in files the earlier task owns. A code
 * task therefore passes every check its repository runs, plus each CI check (CI_CHECKS) among
 * `availableScripts`, the scripts its repository defines. Other tasks keep their own list.
 */
export function taskRequiredChecks(
  task: CheckedTask,
  tasks: readonly CheckedTask[],
  runRepository: string,
  availableScripts: readonly string[] = []
): OrchestrationRequiredCheck[] {
  if (!isImplementationTask(task.kind)) return [...task.requiredChecks];
  const ciChecks = CI_CHECKS.filter(script => availableScripts.includes(script));
  return [...new Set([...repositoryChecks(tasks, task.repository, runRepository), ...ciChecks])];
}

/** taskRequiredChecks for a task of a running build, with the scripts its working copy defines now. */
export function buildTaskRequiredChecks(snapshot: OrchestrationSnapshot, task: OrchestrationTaskRecord): OrchestrationRequiredCheck[] {
  const worktree = repositoryWorkspaceForTask(snapshot, task.id)?.worktreePath;
  return taskRequiredChecks(task, snapshot.tasks, snapshot.run.repository, worktree ? definedCheckScripts(worktree) : []);
}
