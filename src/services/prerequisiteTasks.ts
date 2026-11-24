import { isDeepStrictEqual } from 'node:util';
import type { Agent } from '../models/index.js';
import { isImplementationTask } from './agentRoleContracts.js';
import {
  MAX_PLAN_TASKS,
  MAX_TASK_DEPENDENCIES,
  UNIVERSAL_SCOPE_PATTERNS,
  orchestrationPlanSchema,
  roleCanOwnOrchestrationTask,
  type OrchestrationPlan,
  type OrchestrationTaskDefinition,
  type PlanFitCheckEntry
} from './orchestrationContract.js';
import type { OrchestrationSnapshot, OrchestrationTaskRecord } from './orchestrationStateMachine.js';
import { checkRunPlan } from './orchestrationRunChecks.js';
import { authorizedRepositoriesForRun } from './orchestrationWorkspace.js';
import { taskRequiredChecks } from './repositoryChecks.js';
import { appendFitCheck, fitCheckProblems } from './planFitCheck.js';
import { sameRepository } from '../utils/repositoryName.js';
import type { PrerequisiteTaskProposal } from './blockerResolutionTurn.js';

/** At most this many tasks one prerequisite resolution may add (an independent review Alpha adds is extra). */
export const MAX_PREREQUISITE_TASKS = 3;

/**
 * Missing prerequisite tasks (BLOCKER_RESOLUTION_PLAN phase 3). When a stopped code task needs work
 * the plan does not have (a frontend with no API to call, sign-in with no account store), the
 * Orchestrator proposes that work and Alpha amends the running plan: the tasks are added, the
 * stopped task waits for them, and the build continues.
 *
 * The model proposes the tasks; this code decides what they may be. Alpha sets their ids, milestone,
 * repository checks (taskRequiredChecks) and that they are required, adds an independent review
 * where no pending review in that repository follows the new work, and refuses (never trims) work
 * outside the build's repositories or the stopped task's requirements, too much work, or a plan
 * that fails the run's own plan check. The same check runs again inside the store's transaction.
 */

type Agents = readonly Pick<Agent, 'id' | 'role'>[];
type Snapshot = Pick<OrchestrationSnapshot, 'run' | 'tasks'>;

/**
 * Why Alpha will not add the proposed work on its own. `outside_scope`: another repository or
 * requirement than the stopped task's; `too_large`: over the task or dependency limits;
 * `fit_conflict`: the Orchestrator says it conflicts with the product (the person's call);
 * `plan_check`: the amended plan fails the run's plan or fit check.
 */
export type PrerequisiteRefusalReason = 'outside_scope' | 'too_large' | 'fit_conflict' | 'plan_check';

export class PrerequisiteRefusal extends Error {
  constructor(message: string, readonly reason: PrerequisiteRefusalReason) {
    super(message);
    this.name = 'PrerequisiteRefusal';
  }
}

export interface PrerequisiteProposal {
  tasks: readonly PrerequisiteTaskProposal[];
  fitCheck: readonly PlanFitCheckEntry[];
}

export interface PrerequisiteAmendment {
  plan: OrchestrationPlan;
  blockedTaskId: string;
  /** The Orchestrator's tasks under the ids Alpha saved them as. The stopped task waits for each. */
  prerequisiteIds: string[];
  /** Independent reviews Alpha added where no pending review of that repository follows the new work. */
  reviewIds: string[];
}

function refuse(message: string, reason: PrerequisiteRefusalReason): never {
  throw new PrerequisiteRefusal(message, reason);
}

/** Every task a task waits for, directly or through others. */
function ancestors(tasks: readonly OrchestrationTaskDefinition[], taskId: string): Set<string> {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const found = new Set<string>();
  const visit = (id: string) => {
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      if (found.has(dependency)) continue;
      found.add(dependency);
      visit(dependency);
    }
  };
  visit(taskId);
  return found;
}

/** Required reviews of `repository` that have not run yet and follow every one of `taskIds`. */
function pendingReviewsFollowing(snapshot: Snapshot, plan: readonly OrchestrationTaskDefinition[], repository: string, taskIds: readonly string[]): OrchestrationTaskDefinition[] {
  const status = new Map(snapshot.tasks.map(task => [task.id, task.status]));
  return plan.filter(task => task.kind === 'review' && task.required && status.get(task.id) !== 'accepted' &&
    sameRepository(task.repository ?? snapshot.run.repository, repository) &&
    taskIds.every(id => ancestors(plan, task.id).has(id)));
}

const broadScope = (patterns: readonly string[]) => !patterns.length || patterns.some(pattern => UNIVERSAL_SCOPE_PATTERNS.has(pattern));
const quoted = (title: string) => `“${title}”`;

/** What every added task is checked against: the stopped task, the build and the ids Alpha assigns. */
interface AmendmentContext {
  snapshot: Snapshot;
  blocked: OrchestrationTaskRecord;
  version: number;
  ids: Map<string, string>;
  repositories: string[];
  milestoneRepositories?: readonly string[];
  accepted: Set<string>;
  scripts(repository: string): readonly string[];
}

/** One proposed task as Alpha saves it, or a refusal saying why it may not be added. */
function addedTask(task: PrerequisiteTaskProposal, context: AmendmentContext): OrchestrationTaskDefinition {
  const { blocked, snapshot: { run } } = context;
  const repository = context.repositories.find(item => sameRepository(item, task.repository));
  if (!repository) refuse(`${task.repository} is not one of this build's repositories.`, 'outside_scope');
  if (context.milestoneRepositories && !context.milestoneRepositories.some(item => sameRepository(item, repository))) {
    refuse(`${repository} is not part of the milestone the stopped task belongs to.`, 'outside_scope');
  }
  const outside = task.requirementIds.find(id => !blocked.requirementIds.includes(id));
  if (outside) refuse(`${quoted(task.title)} serves requirement ${outside}, which the stopped task does not.`, 'outside_scope');
  if (broadScope(task.scope.includePaths)) refuse(`${quoted(task.title)} needs a narrow path scope.`, 'plan_check');
  const dependsOn = task.dependsOn.map(id => context.ids.get(id) ?? id);
  const added = new Set(context.ids.values());
  const waiting = dependsOn.find(id => !context.accepted.has(id) && !added.has(id));
  if (waiting) refuse(`${quoted(task.title)} may wait only for accepted work or the other added tasks, not ${waiting}.`, 'plan_check');
  const definition: OrchestrationTaskDefinition = {
    id: context.ids.get(task.id)!,
    ...(blocked.milestoneId ? { milestoneId: blocked.milestoneId } : {}),
    title: task.title, description: task.description, kind: task.kind, repository, ownerAgentId: task.ownerAgentId,
    ...(task.assignmentReason ? { assignmentReason: task.assignmentReason } : {}),
    dependsOn, requirementIds: [...task.requirementIds], acceptanceCriteria: [...task.acceptanceCriteria], requiredChecks: [],
    scope: { includePaths: [...task.scope.includePaths], excludePaths: [...task.scope.excludePaths] },
    required: true
  };
  const requiredChecks = taskRequiredChecks(definition, run.plan.tasks, run.repository, context.scripts(repository));
  if (!requiredChecks.length) refuse(`${repository} defines no checks for ${quoted(task.title)} to pass.`, 'plan_check');
  return { ...definition, requiredChecks };
}

/** The proposal's fit check under Alpha's ids. Mid-build nobody approves the plan, so only work that fits may be added. */
function addedFitCheck(proposal: PrerequisiteProposal, added: OrchestrationTaskDefinition[], context: AmendmentContext): PlanFitCheckEntry[] {
  const fitCheck = proposal.fitCheck.filter(entry => entry.subjectType === 'task' && context.ids.has(entry.subject))
    .map(entry => ({ ...entry, subject: context.ids.get(entry.subject)! }));
  const conflicts = fitCheck.filter(entry => entry.verdict === 'conflicts');
  if (conflicts.length) refuse(`The added work conflicts with the product: ${conflicts.map(entry => entry.reason).join(' ')}`, 'fit_conflict');
  const problems = fitCheckProblems({ ...context.snapshot.run.plan, tasks: added, fitCheck }, { cards: [], settledQuestions: [], decisionsVisible: false });
  if (problems.length) refuse(problems.join(' '), 'plan_check');
  return fitCheck;
}

/** An independent review for each repository whose new work no pending review already follows. */
function addedReviews(added: OrchestrationTaskDefinition[], agents: Agents, context: AmendmentContext): OrchestrationTaskDefinition[] {
  const { blocked, snapshot } = context;
  const waiting = [...snapshot.run.plan.tasks.map(task => task.id === blocked.id
    ? { ...task, dependsOn: [...task.dependsOn, ...added.map(item => item.id)] } : task), ...added];
  const groups = new Map<string, OrchestrationTaskDefinition[]>();
  for (const task of added) groups.set(task.repository!, [...groups.get(task.repository!) ?? [], task]);
  const reviews: OrchestrationTaskDefinition[] = [];
  for (const [repository, group] of groups) {
    if (pendingReviewsFollowing(snapshot, waiting, repository, group.map(task => task.id)).length) continue;
    const owners = new Set(group.map(task => task.ownerAgentId));
    const reviewer = agents.find(agent => roleCanOwnOrchestrationTask('review', agent.role) && !owners.has(agent.id));
    if (!reviewer) refuse(`No eligible reviewer independent of the added work in ${repository} is available.`, 'plan_check');
    const titles = group.map(task => quoted(task.title)).join(', ');
    reviews.push({
      id: `prerequisite-v${context.version}-review-${reviews.length + 1}`,
      ...(blocked.milestoneId ? { milestoneId: blocked.milestoneId } : {}),
      title: `Review the added work in ${repository}`,
      description: `Independently review the work Alpha added before ${quoted(blocked.title)}: ${titles}. Check it against its acceptance criteria and scope, and report findings. Do not change repository files.`,
      kind: 'review', repository, ownerAgentId: reviewer.id,
      assignmentReason: `A ${reviewer.role} who did not build the added work reviews it independently.`,
      dependsOn: group.map(task => task.id),
      requirementIds: [...new Set(group.flatMap(task => task.requirementIds))],
      acceptanceCriteria: ['The added work meets its acceptance criteria within its scope, or each gap is reported as a finding.'],
      requiredChecks: [], scope: { includePaths: [], excludePaths: [] }, required: true
    });
  }
  return reviews;
}

/** The plan with the Orchestrator's missing tasks added before the stopped task. Throws PrerequisiteRefusal. */
export function buildPrerequisiteAmendment(input: {
  snapshot: Snapshot;
  blockedTaskId: string;
  proposal: PrerequisiteProposal;
  agents: Agents;
  /** The check scripts a repository of the build defines now. */
  scripts(repository: string): readonly string[];
}): PrerequisiteAmendment {
  const { snapshot, proposal } = input;
  const { run } = snapshot;
  const blocked = snapshot.tasks.find(task => task.id === input.blockedTaskId);
  const blockedDefinition = run.plan.tasks.find(task => task.id === input.blockedTaskId);
  if (!blocked || !blockedDefinition || !isImplementationTask(blocked.kind)) refuse('Only a stopped code task can wait for added work.', 'plan_check');
  if (!proposal.tasks.length || proposal.tasks.length > MAX_PREREQUISITE_TASKS) {
    refuse(`Alpha adds at most ${MAX_PREREQUISITE_TASKS} missing tasks on its own; this needs ${proposal.tasks.length}.`, 'too_large');
  }
  const version = run.planVersion + 1;
  const ids = new Map(proposal.tasks.map((task, index) => [task.id, `prerequisite-v${version}-${index + 1}`]));
  if (ids.size !== proposal.tasks.length) refuse('The proposed tasks repeat an id.', 'plan_check');
  if ([...ids.values()].some(id => run.plan.tasks.some(task => task.id === id))) refuse('The plan already has tasks with these ids.', 'plan_check');
  const context: AmendmentContext = {
    snapshot, blocked, version, ids, scripts: input.scripts,
    repositories: authorizedRepositoriesForRun(run),
    milestoneRepositories: run.plan.milestones?.find(item => item.id === blocked.milestoneId)?.repositories,
    accepted: new Set(snapshot.tasks.filter(task => task.status === 'accepted').map(task => task.id))
  };
  const added = proposal.tasks.map(task => addedTask(task, context));
  const fitCheck = addedFitCheck(proposal, added, context);
  const reviews = addedReviews(added, input.agents, context);
  const prerequisiteIds = added.map(task => task.id);
  const reviewIds = reviews.map(task => task.id);
  const dependsOn = [...blockedDefinition.dependsOn, ...prerequisiteIds, ...reviewIds];
  if (dependsOn.length > MAX_TASK_DEPENDENCIES) refuse(`${quoted(blocked.title)} would wait for more than ${MAX_TASK_DEPENDENCIES} tasks.`, 'too_large');
  const tasks = [...run.plan.tasks.map(task => task.id === blocked.id ? { ...task, dependsOn } : task), ...added, ...reviews];
  if (tasks.length > MAX_PLAN_TASKS) refuse(`The plan would exceed ${MAX_PLAN_TASKS} tasks.`, 'too_large');
  const reviewFit: PlanFitCheckEntry[] = reviews.map(task => ({ subject: task.id, subjectType: 'task', verdict: 'fits',
    reason: 'An independent review Alpha added for the work it added; it builds nothing.' }));
  const parsed = orchestrationPlanSchema.safeParse({
    ...run.plan, tasks,
    // Plans saved before the fit check keep running without one (planFitCheck.ts).
    ...(run.plan.fitCheck ? { fitCheck: appendFitCheck(run.plan.fitCheck, [...fitCheck, ...reviewFit]) } : {})
  });
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 4).map(issue => issue.path.join('.') + ': ' + issue.message);
    refuse(`The added work is not a valid plan: ${issues.join('; ')}`, 'plan_check');
  }
  const plan = parsed.data;
  const problems = prerequisiteAmendmentProblems(snapshot, plan, blocked.id, input.agents);
  if (problems.length) refuse(problems.join(' '), 'plan_check');
  return { plan, blockedTaskId: blocked.id, prerequisiteIds, reviewIds };
}

const APPROVED_FIELDS = ['goal', 'requirements', 'exclusions', 'milestones', 'schemaVersion', 'roleContractVersion', 'decisions', 'projectContext'] as const;

/** Earlier tasks unchanged, except that the stopped task may wait for more. */
function earlierTaskProblems(before: OrchestrationPlan, after: Map<string, OrchestrationTaskDefinition>, blockedTaskId: string): string[] {
  return before.tasks.flatMap(task => {
    const next = after.get(task.id);
    if (!next) return [`Task ${task.id} disappeared from the plan.`];
    const { dependsOn: _before, ...stable } = task;
    const { dependsOn: nextDependsOn, ...nextStable } = next;
    const dependenciesKept = task.id === blockedTaskId
      ? task.dependsOn.every(id => nextDependsOn.includes(id))
      : isDeepStrictEqual(task.dependsOn, nextDependsOn);
    return isDeepStrictEqual(stable, nextStable) && dependenciesKept ? []
      : [`Earlier task ${task.id} was changed; only the stopped task may wait for the added work.`];
  });
}

/** Each added task required, in the build, in the stopped task's milestone and requirements. */
function addedTaskProblems(snapshot: Snapshot, plan: OrchestrationPlan, added: readonly OrchestrationTaskDefinition[], blocked: OrchestrationTaskDefinition): string[] {
  const repositories = authorizedRepositoriesForRun(snapshot.run);
  return added.flatMap(task => {
    const problems: string[] = [];
    if (!task.required) problems.push(`Added task ${task.id} must be required.`);
    if (!task.repository || !repositories.some(item => sameRepository(item, task.repository!))) problems.push(`Added task ${task.id} must be in one of this build's repositories.`);
    if ((task.milestoneId ?? '') !== (blocked.milestoneId ?? '')) problems.push(`Added task ${task.id} must belong to the stopped task's milestone.`);
    if (task.requirementIds.some(id => !blocked.requirementIds.includes(id))) problems.push(`Added task ${task.id} serves requirements the stopped task does not.`);
    if (!isImplementationTask(task.kind)) return problems;
    if (!task.requiredChecks.length) problems.push(`Added code task ${task.id} has no repository checks.`);
    if (broadScope(task.scope.includePaths)) problems.push(`Added code task ${task.id} needs a narrow path scope.`);
    if (!pendingReviewsFollowing(snapshot, plan.tasks, task.repository ?? snapshot.run.repository, [task.id]).length) {
      problems.push(`Added code task ${task.id} has no pending independent review in its repository.`);
    }
    return problems;
  });
}

/**
 * What is wrong with an amended plan, one sentence each; empty when it may be saved. The rules a
 * prerequisite amendment keeps whoever built it: the approved goal, requirements, exclusions and
 * milestones unchanged; every earlier task unchanged except that the stopped task waits for the new
 * work; new code tasks required, in the build's repositories, within the stopped task's
 * requirements, with repository checks and a pending independent review in their repository; and
 * the run's own plan check.
 */
export function prerequisiteAmendmentProblems(snapshot: Snapshot, plan: OrchestrationPlan, blockedTaskId: string, agents: Agents): string[] {
  const before = snapshot.run.plan;
  const blocked = before.tasks.find(task => task.id === blockedTaskId);
  const after = new Map(plan.tasks.map(task => [task.id, task]));
  const blockedNext = after.get(blockedTaskId);
  if (!blocked || !blockedNext) return ['The stopped task is not in the plan.'];
  const problems: string[] = [];
  if (!APPROVED_FIELDS.every(key => isDeepStrictEqual(plan[key], before[key]))) {
    problems.push('Added work cannot change the approved goal, requirements, exclusions, milestones or decisions.');
  }
  problems.push(...earlierTaskProblems(before, after, blockedTaskId));
  const added = plan.tasks.filter(task => !before.tasks.some(old => old.id === task.id));
  const code = added.filter(task => isImplementationTask(task.kind));
  if (!code.length || code.length > MAX_PREREQUISITE_TASKS) problems.push(`Add between 1 and ${MAX_PREREQUISITE_TASKS} code tasks.`);
  if (added.some(task => !isImplementationTask(task.kind) && task.kind !== 'review')) problems.push('Only code tasks and their reviews can be added before a stopped task.');
  const newDependencies = blockedNext.dependsOn.filter(id => !blocked.dependsOn.includes(id));
  if (newDependencies.some(id => !added.some(task => task.id === id)) || code.some(task => !blockedNext.dependsOn.includes(task.id))) {
    problems.push('The stopped task must wait for each added code task, and only for added work.');
  }
  problems.push(...addedTaskProblems(snapshot, plan, added, blocked));
  problems.push(...checkRunPlan(snapshot.run, plan, 'prerequisite', agents).map(issue => issue.detail));
  return problems;
}

/** What the added work is, in a line per task, for the person and the approval list. */
export function prerequisiteSummary(taskTitle: string, tasks: ReadonlyArray<{ title: string; kind: string; repository: string; description: string }>): string {
  const lead = tasks.length === 1 ? `Add one task before ${quoted(taskTitle)}:` : `Add ${tasks.length} tasks before ${quoted(taskTitle)}:`;
  return [lead, ...tasks.map(task => `- ${quoted(task.title)} (${task.kind}, ${task.repository}): ${task.description}`)].join('\n');
}
