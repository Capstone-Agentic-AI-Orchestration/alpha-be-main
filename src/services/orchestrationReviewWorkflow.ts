import { createHash } from 'node:crypto';
import type { Agent } from '../models/index.js';
import {
  MAX_PLAN_TASKS,
  orchestrationPlanSchema,
  validateOrchestrationPlan,
  type OrchestrationAgentReport,
  type OrchestrationPlan,
  type OrchestrationTaskDefinition
} from './orchestrationContract.js';
import type { OrchestrationSnapshot, OrchestrationTaskRecord } from './orchestrationStateMachine.js';

export type OrchestrationReviewFinding = NonNullable<OrchestrationAgentReport['reviewFindings']>[number];

export interface PersistedReviewFinding {
  taskId: string;
  sourceTaskId: string;
  severity: OrchestrationReviewFinding['severity'];
  requirementId?: string;
  path?: string;
  evidence: Record<string, unknown>;
  correctionTaskId?: string;
}

export interface OrchestrationReviewAmendment {
  plan: OrchestrationPlan;
  addedTasks: OrchestrationTaskRecord[];
  findings: PersistedReviewFinding[];
}

export class OrchestrationReviewPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrchestrationReviewPlanError';
  }
}

const CODE_TASK_KINDS = new Set(['database', 'backend', 'frontend', 'mobile']);
export const MAX_REVIEW_CORRECTION_CYCLES = 2;

function correctionTaskId(rootTaskId: string, cycle: number): string {
  const compactSource = createHash('sha256').update(rootTaskId).digest('hex').slice(0, 12);
  return `correction-${compactSource}-${cycle}`;
}

function ancestorsFor(tasks: readonly OrchestrationTaskDefinition[], taskId: string): Set<string> {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const found = new Set<string>();
  const visit = (id: string) => {
    for (const dependencyId of byId.get(id)?.dependsOn ?? []) {
      if (found.has(dependencyId)) continue;
      found.add(dependencyId);
      visit(dependencyId);
    }
  };
  visit(taskId);
  return found;
}

function rootTaskFor(task: OrchestrationTaskRecord, snapshot: OrchestrationSnapshot): OrchestrationTaskRecord {
  const rootId = task.correctionOfTaskId ?? task.id;
  const root = snapshot.tasks.find(candidate => candidate.id === rootId);
  if (!root || !CODE_TASK_KINDS.has(root.kind)) {
    throw new OrchestrationReviewPlanError('The finding does not map to a persisted implementation task. Keep the build blocked for human review.');
  }
  return root;
}

function asPlanTask(task: OrchestrationTaskRecord): OrchestrationTaskDefinition {
  const {
    status: _status,
    revision: _revision,
    attemptCount: _attemptCount,
    acceptedRevision: _acceptedRevision,
    updatedAt: _updatedAt,
    correctionOfTaskId: _correctionOfTaskId,
    correctionCycle: _correctionCycle,
    ...definition
  } = task;
  return definition;
}

/**
 * Route independently reported review findings into a new immutable plan
 * version. The original tasks and evidence remain intact; correction attempts
 * get their own IDs and a new independent review/validation chain.
 */
export function buildOrchestrationReviewAmendment(
  snapshot: OrchestrationSnapshot,
  reviewTask: OrchestrationTaskRecord,
  reviewFindings: readonly OrchestrationReviewFinding[],
  eligibleAgents: readonly Pick<Agent, 'id' | 'role'>[]
): OrchestrationReviewAmendment {
  if (reviewTask.kind !== 'review' || reviewTask.status !== 'submitted' || snapshot.run.currentTaskId !== reviewTask.id) {
    throw new OrchestrationReviewPlanError('Only the active submitted review task can amend this plan.');
  }

  const sourceByFinding = reviewFindings.map(finding => {
    const target = snapshot.tasks.find(task => task.id === finding.targetTaskId);
    if (!target || target.status !== 'accepted' || !CODE_TASK_KINDS.has(target.kind) || target.ownerAgentId === reviewTask.ownerAgentId) {
      throw new OrchestrationReviewPlanError(`Finding “${finding.title}” does not identify accepted code owned by a different specialist. Keep the build blocked for human review.`);
    }
    const root = rootTaskFor(target, snapshot);
    if (finding.requirementId && !root.requirementIds.includes(finding.requirementId)) {
      throw new OrchestrationReviewPlanError(`Finding “${finding.title}” names a requirement outside task ${root.id}. Keep the build blocked for human review.`);
    }
    return { finding, target, root };
  });

  const blockingByRoot = new Map<string, typeof sourceByFinding>();
  for (const item of sourceByFinding) {
    if (!['blocking', 'critical'].includes(item.finding.severity)) continue;
    const group = blockingByRoot.get(item.root.id) ?? [];
    group.push(item);
    blockingByRoot.set(item.root.id, group);
  }

  const nextPlanVersion = snapshot.run.planVersion + 1;
  const findings: PersistedReviewFinding[] = [];
  const correctionDefinitions: OrchestrationTaskDefinition[] = [];
  const addedTasks: OrchestrationTaskRecord[] = [];
  const correctionIds = new Map<string, string>();

  for (const [rootId, items] of blockingByRoot) {
    const root = items[0].root;
    const completedCycles = snapshot.tasks
      .filter(task => task.correctionOfTaskId === rootId)
      .reduce((maximum, task) => Math.max(maximum, task.correctionCycle ?? 0), 0);
    const cycle = completedCycles + 1;
    if (cycle > MAX_REVIEW_CORRECTION_CYCLES) {
      throw new OrchestrationReviewPlanError(`Task ${rootId} reached the ${MAX_REVIEW_CORRECTION_CYCLES}-cycle review-correction limit. Keep the build blocked for a human plan decision.`);
    }
    const id = correctionTaskId(rootId, cycle);
    if (snapshot.tasks.some(task => task.id === id)) {
      throw new OrchestrationReviewPlanError('A correction task with this identity already exists. Reconcile the current plan before retrying.');
    }
    correctionIds.set(rootId, id);
    const correction: OrchestrationTaskDefinition = {
      id,
      title: `Resolve review findings: ${root.title}`.slice(0, 240),
      description: `Correct the accepted ${root.kind} deliverable from task ${root.id}. Follow the linked review findings and keep all changes inside this task’s original scope.`,
      kind: root.kind,
      repository: root.repository ?? snapshot.run.repository,
      ownerAgentId: root.ownerAgentId,
      dependsOn: [reviewTask.id],
      requirementIds: [...root.requirementIds],
      acceptanceCriteria: [...root.acceptanceCriteria],
      requiredChecks: [...root.requiredChecks],
      scope: { includePaths: [...root.scope.includePaths], excludePaths: [...root.scope.excludePaths] },
      required: true
    };
    correctionDefinitions.push(correction);
    addedTasks.push({
      ...correction,
      correctionOfTaskId: rootId,
      correctionCycle: cycle,
      status: 'ready', revision: 0, attemptCount: 0
    });
  }

  for (const { finding, root } of sourceByFinding) {
    findings.push({
      taskId: root.id,
      sourceTaskId: reviewTask.id,
      severity: finding.severity,
      requirementId: finding.requirementId,
      path: finding.path,
      correctionTaskId: correctionIds.get(root.id),
      evidence: {
        origin: 'independent_review',
        title: finding.title,
        evidence: finding.evidence,
        instruction: finding.instruction,
        targetTaskId: finding.targetTaskId
      }
    });
  }

  if (!correctionDefinitions.length) {
    return { plan: snapshot.run.plan, addedTasks, findings };
  }
  if (correctionDefinitions.length > 8) {
    throw new OrchestrationReviewPlanError('This review produced more correction owners than the plan can safely coordinate in one cycle. Keep the build blocked for human review.');
  }

  const existingTasks = snapshot.run.plan.tasks.map(task => ({ ...task }));
  const requiredValidators = existingTasks.filter(task => task.kind === 'validation' && task.required);
  if (requiredValidators.length > 1) {
    throw new OrchestrationReviewPlanError('The plan has multiple required validation gates; review correction needs a reviewed plan amendment before it can continue.');
  }
  const priorValidationIds = new Set(requiredValidators.map(task => task.id));
  for (const validator of requiredValidators) validator.required = false;

  const nextReviewId = `review-${nextPlanVersion}`;
  const { buildStepId: _reviewBuildStepId, ...reviewBase } = asPlanTask(reviewTask);
  const reviewDefinition: OrchestrationTaskDefinition = {
    ...reviewBase,
    id: nextReviewId,
    title: `Independently review corrections (plan ${nextPlanVersion})`,
    description: `Review the updated implementation after correction tasks from plan ${snapshot.run.planVersion}. Confirm each linked finding is fixed, all requirements still hold, and no new defect was introduced. Do not change repository files.`,
    dependsOn: correctionDefinitions.map(task => task.id),
    required: true
  };
  correctionDefinitions.push(reviewDefinition);
  addedTasks.push({ ...reviewDefinition, status: 'pending', revision: 0, attemptCount: 0 });

  const validationTemplate = requiredValidators[0];
  let nextValidationId: string | undefined;
  if (validationTemplate) {
    nextValidationId = `validation-${nextPlanVersion}`;
    const { buildStepId: _validationBuildStepId, ...validationBase } = validationTemplate;
    const validationDefinition: OrchestrationTaskDefinition = {
      ...validationBase,
      id: nextValidationId,
      title: `Revalidate corrected implementation (plan ${nextPlanVersion})`,
      description: `Repeat the configured integration validation after independent review of the correction tasks.`,
      dependsOn: [nextReviewId],
      required: true
    };
    correctionDefinitions.push(validationDefinition);
    addedTasks.push({ ...validationDefinition, status: 'pending', revision: 0, attemptCount: 0 });
  }

  const replacementDependency = nextValidationId ?? nextReviewId;
  const retargetedTasks = existingTasks.map(task => {
    if (task.kind !== 'delivery') return task;
    const dependsOn = task.dependsOn.filter(id => !priorValidationIds.has(id));
    if (!dependsOn.includes(replacementDependency)) dependsOn.push(replacementDependency);
    return { ...task, dependsOn };
  });
  const parsedPlan = orchestrationPlanSchema.parse({
    ...snapshot.run.plan,
    tasks: [...retargetedTasks, ...correctionDefinitions]
  });
  if (parsedPlan.tasks.length > MAX_PLAN_TASKS) {
    throw new OrchestrationReviewPlanError(`The corrected workflow would exceed the ${MAX_PLAN_TASKS}-task plan limit. Keep the build blocked for a human plan decision.`);
  }
  const issues = validateOrchestrationPlan(parsedPlan, eligibleAgents);
  if (issues.length) {
    throw new OrchestrationReviewPlanError(`The correction plan did not pass its graph and role checks: ${issues.map(issue => issue.detail).join(' ')}`);
  }

  const normalizedTasks = addedTasks.map(task => ({ ...task }));
  // Ensure no derived UI/build-step marker can be mistaken for a new project step.
  for (const task of normalizedTasks) delete (task as OrchestrationTaskRecord & { buildStepId?: string }).buildStepId;
  return { plan: parsedPlan, addedTasks: normalizedTasks, findings };
}
