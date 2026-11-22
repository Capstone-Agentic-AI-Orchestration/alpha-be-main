import type { OrchestrationPlan } from './orchestrationContract.js';

type Task = OrchestrationPlan['tasks'][number];

const MAX_LINES = 8;
const repoName = (repository?: string) => (repository ?? '').split('/').pop() || 'the codebase';

/**
 * What a corrected plan changed, one short line each, for the person approving it again:
 * tasks added or removed, and tasks moved to another codebase, owner or set of prerequisites.
 */
export function describePlanChanges(before: OrchestrationPlan, after: OrchestrationPlan): string[] {
  const old = new Map(before.tasks.map(task => [task.id, task]));
  const next = new Map(after.tasks.map(task => [task.id, task]));
  const lines: string[] = [];
  for (const task of after.tasks) {
    const previous = old.get(task.id);
    if (!previous) lines.push(`Added "${task.title}" in ${repoName(task.repository)}.`);
    else lines.push(...taskChanges(previous, task));
  }
  for (const task of before.tasks) if (!next.has(task.id)) lines.push(`Removed "${task.title}".`);
  if (lines.length > MAX_LINES) return [...lines.slice(0, MAX_LINES - 1), `And ${lines.length - MAX_LINES + 1} more changes; the plan has them all.`];
  return lines.length ? lines : ['Reworded the plan; no task was added, removed or moved.'];
}

function taskChanges(before: Task, after: Task): string[] {
  const lines: string[] = [];
  if ((before.repository ?? '') !== (after.repository ?? '')) lines.push(`Moved "${after.title}" to ${repoName(after.repository)}.`);
  if (before.ownerAgentId !== after.ownerAgentId) lines.push(`Gave "${after.title}" to another specialist.`);
  if ([...before.dependsOn].sort().join() !== [...after.dependsOn].sort().join()) lines.push(`Changed what "${after.title}" waits for.`);
  if (before.required !== after.required) lines.push(`Made "${after.title}" ${after.required ? 'required' : 'optional'}.`);
  return lines;
}
