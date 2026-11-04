import type { Issue, PrototypeRun } from '../models/index.js';

/** Managed tasks have one lifecycle owner, including after an earlier build ended. */
export function isManagedTask(issue: Pick<Issue, 'labels'> | undefined, run?: Pick<PrototypeRun, 'orchestrationRunId'>): boolean {
  return Boolean(run?.orchestrationRunId || issue?.labels?.some(label =>
    label === 'alpha:task-orchestration' || label === 'alpha:chat-build'));
}

export const MANAGED_TASK_ACTION_ERROR = 'Open this task’s Build tab. Managed tasks must be planned, retried, stopped and reviewed through their build; individual agent controls cannot change them.';
