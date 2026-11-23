import { MAX_TASK_REQUIREMENTS } from './orchestrationContract.js';

type RawTask = Record<string, unknown> & { id?: unknown; requirementIds?: unknown; dependsOn?: unknown; title?: unknown };
type RawDecision = { about: string; decision: string };

const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

/** The parts of one oversized task: each covers the next requirements and waits for the part before it. */
function splitTask(task: RawTask & { id: string }, ids: unknown[]): RawTask[] {
  const parts: RawTask[] = [];
  for (let index = 0; index * MAX_TASK_REQUIREMENTS < ids.length; index += 1) {
    const requirementIds = ids.slice(index * MAX_TASK_REQUIREMENTS, (index + 1) * MAX_TASK_REQUIREMENTS);
    if (index === 0) { parts.push({ ...task, requirementIds }); continue; }
    const { buildStepId: _step, ...rest } = task;
    parts.push({ ...rest, id: task.id + '-part-' + (index + 1), requirementIds,
      title: (String(task.title ?? task.id) + ' (part ' + (index + 1) + ')').slice(0, 240),
      dependsOn: [...new Set([...list(task.dependsOn), parts[index - 1].id])] });
  }
  return parts;
}

/** Tasks that waited for a split task wait for its last part; its own later parts already wait in turn. */
function waitForLastParts(tasks: RawTask[], lastPart: ReadonlyMap<string, string>): void {
  for (const task of tasks) {
    if (!Array.isArray(task?.dependsOn)) continue;
    const own = typeof task.id === 'string' ? task.id : '';
    task.dependsOn = [...new Set(task.dependsOn.flatMap((dep: unknown) => {
      const last = typeof dep === 'string' ? lastPart.get(dep) : undefined;
      return last && !own.startsWith(dep + '-part-') ? [dep, last] : [dep];
    }))];
  }
}

/**
 * One task may cover at most 12 requirements. A plan whose review or
 * implementation task covered more used to be refused outright; the task is
 * split into consecutive parts instead. Runs on the model's raw JSON, before
 * the schema check.
 */
export function splitOversizedTasks(candidate: unknown): { candidate: unknown; decisions: RawDecision[] } {
  const plan = candidate as { tasks?: unknown } | null;
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.tasks)) return { candidate, decisions: [] };
  const decisions: RawDecision[] = [];
  const lastPart = new Map<string, string>();
  const tasks: RawTask[] = [];
  for (const task of plan.tasks as RawTask[]) {
    const ids = list(task?.requirementIds);
    if (typeof task?.id !== 'string' || ids.length <= MAX_TASK_REQUIREMENTS) { tasks.push(task); continue; }
    const parts = splitTask(task as RawTask & { id: string }, ids);
    tasks.push(...parts);
    lastPart.set(task.id, String(parts[parts.length - 1].id));
    decisions.push({ about: String(task.title ?? task.id).slice(0, 240),
      decision: 'Split into ' + parts.length + ' consecutive parts, because one task covers at most ' + MAX_TASK_REQUIREMENTS + ' requirements. Each part handles the next requirements, in order.' });
  }
  if (!lastPart.size) return { candidate, decisions };
  waitForLastParts(tasks, lastPart);
  const fitCheck = (plan as { fitCheck?: unknown }).fitCheck;
  return { candidate: { ...plan, tasks, ...(Array.isArray(fitCheck) ? { fitCheck: partsInFitCheck(fitCheck, lastPart) } : {}) }, decisions };
}

/** A split task's fit-check entry covers each of its parts: the parts are the same work. */
function partsInFitCheck(entries: unknown[], lastPart: ReadonlyMap<string, string>): unknown[] {
  return entries.flatMap(entry => {
    const subject = (entry as { subject?: unknown } | null)?.subject;
    const last = typeof subject === 'string' ? lastPart.get(subject) : undefined;
    if (!last || (entry as { subjectType?: unknown }).subjectType === 'card') return [entry];
    const count = Number(last.slice(last.lastIndexOf('-part-') + '-part-'.length));
    return [entry, ...Array.from({ length: count - 1 }, (_, index) => ({ ...(entry as object), subject: `${subject}-part-${index + 2}` }))];
  });
}
