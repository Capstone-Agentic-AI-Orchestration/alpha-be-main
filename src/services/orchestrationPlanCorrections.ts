import { MAX_TASK_DEPENDENCIES, type OrchestrationPlan } from './orchestrationContract.js';

/** Tasks that only write a report: changing their bounds never widens what code can change. */
const ANALYSIS_KINDS = new Set(['requirements', 'architecture']);
const CODE_KINDS = new Set(['database', 'backend', 'frontend', 'mobile']);

type PlanTask = OrchestrationPlan['tasks'][number];
type Milestone = NonNullable<OrchestrationPlan['milestones']>[number];

export interface PlanCorrections<P> {
  plan: P;
  /** What was changed, for the log. Empty when the plan was left as it was. */
  corrections: string[];
}

/**
 * Fix the planner's mistakes that have exactly one safe answer, before the plan
 * check, so an otherwise good plan does not end the build.
 *
 * A model-written plan drifts in small structural ways; the check is right to
 * insist on the structure, but each drift used to stop the build after one
 * correction turn. Only two kinds of change are made here, neither of which can
 * widen what any code task may touch:
 *
 * - An analysis task (requirements or architecture, report only) that reaches
 *   past its milestone is narrowed to that milestone: its requirements to the
 *   milestone's, its repository to one the milestone names.
 * - Code work that does not yet wait for its milestone's required Manager brief
 *   is made to wait for it. This only adds ordering, never work.
 *
 * Anything that would mean inventing work (a missing review, a missing task in a
 * named repository) is left for the planner and the check.
 */
export function correctPlanSafely<P extends OrchestrationPlan>(
  plan: P,
  agents: readonly { id: string; role: string }[]
): PlanCorrections<P> {
  const corrections: string[] = [];
  const tasks = plan.tasks.map(task => ({ ...task, dependsOn: [...task.dependsOn], requirementIds: [...task.requirementIds] }));
  narrowAnalysisTasks(tasks, plan.milestones ?? [], corrections);
  waitForManagerBriefs(tasks, agents, corrections);
  return corrections.length ? { plan: { ...plan, tasks }, corrections } : { plan, corrections };
}

function narrowAnalysisTasks(tasks: PlanTask[], milestones: readonly Milestone[], corrections: string[]): void {
  for (const task of tasks) {
    const milestone = ANALYSIS_KINDS.has(task.kind) ? milestones.find(item => item.id === task.milestoneId) : undefined;
    if (!milestone) continue;
    const inMilestone = task.requirementIds.filter(id => milestone.requirementIds.includes(id));
    if (inMilestone.length !== task.requirementIds.length) {
      task.requirementIds = inMilestone.length ? inMilestone : [...milestone.requirementIds];
      corrections.push(`Narrowed ${task.id} to the requirements of milestone ${milestone.id}.`);
    }
    const repositories = milestone.repositories.map(repo => repo.toLowerCase());
    if (repositories.length && !repositories.includes(task.repository?.toLowerCase() ?? '')) {
      task.repository = milestone.repositories[0];
      corrections.push(`Placed ${task.id} in ${milestone.repositories[0]}, a repository of milestone ${milestone.id}.`);
    }
  }
}

function waitForManagerBriefs(tasks: PlanTask[], agents: readonly { id: string; role: string }[], corrections: string[]): void {
  const roleOf = new Map(agents.map(agent => [agent.id, agent.role.trim().toLowerCase()]));
  const byId = new Map(tasks.map(task => [task.id, task]));
  const briefs = tasks.filter(task => task.kind === 'requirements' && task.required && roleOf.get(task.ownerAgentId) === 'manager agent');
  for (const brief of briefs) {
    // Two briefs in one milestone is the planner's call to resolve, not ours.
    if (briefs.some(other => other !== brief && other.milestoneId === brief.milestoneId)) continue;
    const waiting = tasks.filter(task => CODE_KINDS.has(task.kind) && task.milestoneId === brief.milestoneId && canWaitFor(task, brief, byId));
    for (const task of waiting) {
      task.dependsOn.push(brief.id);
      corrections.push(`Made ${task.id} wait for the Manager brief ${brief.id}.`);
    }
  }
}

/** Whether `task` should and can be made to wait for `brief`: not already, no cycle, under the dependency limit. */
function canWaitFor(task: PlanTask, brief: PlanTask, byId: ReadonlyMap<string, PlanTask>): boolean {
  return !waitsFor(task.id, brief.id, byId) && !waitsFor(brief.id, task.id, byId) && task.dependsOn.length < MAX_TASK_DEPENDENCIES;
}

/** Whether `from` depends on `target`, directly or through other tasks. */
function waitsFor(from: string, target: string, byId: ReadonlyMap<string, PlanTask>): boolean {
  const seen = new Set<string>();
  const stack = [...(byId.get(from)?.dependsOn ?? [])];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === target) return true;
    if (!seen.has(id)) {
      seen.add(id);
      stack.push(...(byId.get(id)?.dependsOn ?? []));
    }
  }
  return false;
}
