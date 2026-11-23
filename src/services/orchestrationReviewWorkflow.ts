import { createHash } from 'node:crypto';
import { isImplementationTask } from './agentRoleContracts.js';
import { sameRepository } from '../utils/repositoryName.js';
import path from 'node:path';
import type { Agent } from '../models/index.js';
import {
  MAX_PLAN_TASKS,
  orchestrationPlanSchema,
  roleCanOwnOrchestrationTask,
  type OrchestrationAgentReport,
  type OrchestrationPlan,
  type OrchestrationTaskDefinition
} from './orchestrationContract.js';
import type { OrchestrationSnapshot, OrchestrationTaskRecord } from './orchestrationStateMachine.js';
import { checkRunPlan } from './orchestrationRunChecks.js';
import { repositoryChecks } from './repositoryChecks.js';

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
  if (!root || !isImplementationTask(root.kind)) {
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
    if (!target || target.status !== 'accepted' || !isImplementationTask(target.kind) || target.ownerAgentId === reviewTask.ownerAgentId) {
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
      ...(root.dependencyAudit ? { dependencyAudit: root.dependencyAudit } : {}),
      ...(root.milestoneId ? { milestoneId: root.milestoneId } : {}),
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
  const validationTemplates = existingTasks.filter(task => task.kind === 'validation' &&
    sameRepository((task.repository ?? snapshot.run.repository), (reviewTask.repository ?? snapshot.run.repository)) &&
    (!reviewTask.milestoneId || task.milestoneId === reviewTask.milestoneId));
  const requiredValidators = validationTemplates.filter(task => task.required);
  if (requiredValidators.length > 1) {
    throw new OrchestrationReviewPlanError('The plan has multiple required validation gates; review correction needs a reviewed plan amendment before it can continue.');
  }
  const priorValidationIds = new Set(validationTemplates.map(task => task.id));
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

  const validationTemplate = requiredValidators[0] ?? validationTemplates[0];
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
    if (task.kind !== 'delivery' || (reviewTask.milestoneId && task.milestoneId !== reviewTask.milestoneId)) return task;
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
  const issues = checkRunPlan(snapshot.run, parsedPlan, 'review_correction', eligibleAgents);
  if (issues.length) {
    throw new OrchestrationReviewPlanError(`The correction plan did not pass its graph and role checks: ${issues.map(issue => issue.detail).join(' ')}`);
  }

  const normalizedTasks = addedTasks.map(task => ({ ...task }));
  // Ensure no derived UI/build-step marker can be mistaken for a new project step.
  for (const task of normalizedTasks) delete (task as OrchestrationTaskRecord & { buildStepId?: string }).buildStepId;
  return { plan: parsedPlan, addedTasks: normalizedTasks, findings };
}

/**
 * Convert failed, observed final checks into the same bounded owner/review/
 * validation chain used by independent review. Owners are selected only from
 * accepted code tasks that contributed files in the affected repository.
 */
export function buildFinalValidationAmendment(
  snapshot: OrchestrationSnapshot,
  evidence: Record<string, unknown>,
  eligibleAgents: readonly Pick<Agent, 'id' | 'role'>[]
): OrchestrationReviewAmendment {
  const checks = evidence.checks && typeof evidence.checks === 'object'
    ? evidence.checks as Record<string, unknown>
    : undefined;
  const observed = Array.isArray(checks?.observed) ? checks.observed as Array<Record<string, unknown>> : [];
  const failedChecks = observed.filter(check => check.exitCode !== 0 || check.signal != null);
  if (checks?.status !== 'failed' || !failedChecks.length ||
      (Array.isArray(checks.missingScripts) && checks.missingScripts.length)) {
    throw new OrchestrationReviewPlanError('The saved evidence does not identify a failed repository check that can be safely routed to code owners. Keep the build blocked for human review.');
  }

  const repositories = Array.isArray(evidence.repositories)
    ? evidence.repositories as Array<Record<string, unknown>>
    : [];
  const evidenceByRepository = new Map<string, Record<string, unknown>>();
  for (const repository of repositories) {
    if (typeof repository.repository === 'string') evidenceByRepository.set(repository.repository.toLowerCase(), repository);
  }
  const primaryRepository = typeof evidence.repository === 'string' ? evidence.repository : snapshot.run.repository;
  if (!evidenceByRepository.size) evidenceByRepository.set(primaryRepository.toLowerCase(), {
    repository: primaryRepository,
    cumulativeChangedPaths: Array.isArray(evidence.cumulativeChangedPaths) ? evidence.cumulativeChangedPaths : [],
    checks
  });

  const taskChanges = acceptedCodeChanges(snapshot);

  const reportFindings: OrchestrationReviewFinding[] = [];
  for (const [repositoryKey, repositoryEvidence] of evidenceByRepository) {
    const repository = typeof repositoryEvidence.repository === 'string' ? repositoryEvidence.repository : repositoryKey;
    const repositoryChecks = repositoryEvidence.checks && typeof repositoryEvidence.checks === 'object'
      ? repositoryEvidence.checks as Record<string, unknown>
      : checks;
    const commands = Array.isArray(repositoryChecks?.observed)
      ? repositoryChecks.observed as Array<Record<string, unknown>>
      : failedChecks;
    const repoFailed = commands.filter(check => check.exitCode !== 0 || check.signal != null);
    if (!repoFailed.length) continue;
    const repoTasks = snapshot.tasks.filter(task => task.status === 'accepted' && isImplementationTask(task.kind) &&
      (task.repository ?? snapshot.run.repository).toLowerCase() === repositoryKey && (taskChanges.get(task.id)?.length ?? 0) > 0);
    if (!repoTasks.length) {
      throw new OrchestrationReviewPlanError(`Final checks failed in ${repository}, but no accepted implementation task can be tied to changed files there. Keep the build blocked for human review.`);
    }
    const outputText = repoFailed.map(check => `${String(check.display ?? check.script ?? 'Repository check')} ${String(check.exitCode ?? check.signal ?? 'failed')}: ${String(check.outputSummary ?? '')}`).join('\n').toLowerCase();
    const allPaths = [...new Set(repoTasks.flatMap(task => taskChanges.get(task.id) ?? []))];
    const matchedPaths = allPaths.filter(filePath => outputText.includes(filePath.toLowerCase()) ||
      outputText.includes(path.posix.basename(filePath).toLowerCase()));
    const affectedTasks = matchedPaths.length
      ? repoTasks.filter(task => (taskChanges.get(task.id) ?? []).some(filePath => matchedPaths.includes(filePath)))
      : repoTasks;
    for (const target of affectedTasks) {
      const implicatedPaths = (taskChanges.get(target.id) ?? []).filter(filePath => !matchedPaths.length || matchedPaths.includes(filePath));
      const checkLabels = repoFailed.map(check => String(check.display ?? check.script ?? 'Repository check')).slice(0, 8);
      reportFindings.push({
        targetTaskId: target.id,
        title: `Final validation failed: ${checkLabels.join(', ')}`.slice(0, 240),
        severity: 'blocking',
        path: implicatedPaths[0],
        evidence: `The final repository checks failed after all required tasks were accepted: ${repoFailed.map(check => `${String(check.display ?? check.script ?? 'check')} exited ${String(check.exitCode ?? check.signal ?? 'with an error')}`).join('; ')}.`,
        instruction: `Review the saved final-check evidence and correct only files owned by this task. Keep changes inside task ${target.id}'s original path scope, rerun its required checks, and report any issue that cannot be tied to this scope.`
      });
    }
  }
  if (!reportFindings.length || reportFindings.length > 20) {
    throw new OrchestrationReviewPlanError('Final validation did not map to a bounded set of accepted code owners. Keep the build blocked for human review.');
  }

  return routeOwnerFindings(snapshot, reportFindings, eligibleAgents, 'final_validation');
}

export type OwnerCorrectionOrigin = 'final_validation' | 'human_review';

const OWNER_CORRECTION_COPY: Record<OwnerCorrectionOrigin, { label: string; keep: string }> = {
  final_validation: { label: 'Final-check corrections', keep: 'Keep the build blocked for human review.' },
  human_review: { label: 'Requested changes', keep: 'The build stays in review; describe the change as a new build instead.' }
};

/** Files each accepted implementation task changed, from its accepted attempt evidence. */
function acceptedCodeChanges(snapshot: OrchestrationSnapshot): Map<string, string[]> {
  const taskChanges = new Map<string, string[]>();
  for (const task of snapshot.tasks.filter(candidate => candidate.status === 'accepted' && isImplementationTask(candidate.kind))) {
    const attempt = [...snapshot.attempts].reverse().find(candidate => candidate.taskId === task.id && candidate.status === 'accepted');
    const acceptance = attempt?.result?.acceptanceEvidence;
    const changedPaths = acceptance && typeof acceptance === 'object'
      ? (acceptance as Record<string, unknown>).changedPaths
      : undefined;
    taskChanges.set(task.id, Array.isArray(changedPaths) ? changedPaths.filter((item): item is string => typeof item === 'string') : []);
  }
  return taskChanges;
}

/**
 * Route owner findings through the shared correction chain: scoped owner
 * corrections, a fresh independent review by a different specialist, then
 * revalidation. Failed final checks and a reviewer sending finished work back
 * both use it, so both obey the same plan, scope, and correction-cycle limits.
 */
function routeOwnerFindings(
  snapshot: OrchestrationSnapshot,
  reportFindings: readonly OrchestrationReviewFinding[],
  eligibleAgents: readonly Pick<Agent, 'id' | 'role'>[],
  origin: OwnerCorrectionOrigin
): OrchestrationReviewAmendment {
  const copy = OWNER_CORRECTION_COPY[origin];
  const ownerIds = new Set(reportFindings.flatMap(finding => {
    const task = snapshot.tasks.find(candidate => candidate.id === finding.targetTaskId);
    return task ? [task.ownerAgentId] : [];
  }));
  const reviewAgentId = eligibleAgents.find(agent => roleCanOwnOrchestrationTask('review', agent.role) && !ownerIds.has(agent.id))?.id ??
    snapshot.tasks.find(task => task.kind === 'review' && task.status === 'accepted' && !ownerIds.has(task.ownerAgentId))?.ownerAgentId;
  const reviewTemplate = snapshot.tasks.find(task => task.kind === 'review' && task.status === 'accepted');
  if (!reviewTemplate || !reviewAgentId) {
    throw new OrchestrationReviewPlanError(`${copy.label} require an available reviewer who is different from every correction owner. ${copy.keep}`);
  }

  const syntheticReview: OrchestrationTaskRecord = { ...reviewTemplate, ownerAgentId: reviewAgentId, status: 'submitted' };
  const amendmentSnapshot: OrchestrationSnapshot = {
    ...snapshot,
    run: { ...snapshot.run, currentTaskId: syntheticReview.id },
    tasks: snapshot.tasks.map(task => task.id === syntheticReview.id ? syntheticReview : task)
  };
  let amendment = buildOrchestrationReviewAmendment(amendmentSnapshot, syntheticReview, reportFindings, eligibleAgents);
  if (!amendment.addedTasks.some(task => task.kind === 'validation')) {
    const validator = eligibleAgents.find(agent => roleCanOwnOrchestrationTask('validation', agent.role));
    const followupReview = amendment.addedTasks.find(task => task.kind === 'review');
    if (!validator || !followupReview) {
      throw new OrchestrationReviewPlanError(`${copy.label} need an available validation specialist after independent review. ${copy.keep}`);
    }
    const nextValidationId = `validation-${snapshot.run.planVersion + 1}`;
    if (amendment.plan.tasks.some(task => task.id === nextValidationId)) {
      throw new OrchestrationReviewPlanError('A validation task with this identity already exists. Reconcile the current plan before retrying.');
    }
    const validationTask: OrchestrationTaskDefinition = {
      id: nextValidationId,
      title: `Revalidate corrected implementation (plan ${snapshot.run.planVersion + 1})`,
      description: 'Run the configured repository checks after independent review of the owner corrections. Do not change repository files.',
      kind: 'validation',
      ...(followupReview.milestoneId ? { milestoneId: followupReview.milestoneId } : {}),
      repository: followupReview.repository ?? snapshot.run.repository,
      ownerAgentId: validator.id,
      assignmentReason: `A ${validator.role} specialist is assigned to verify the corrected implementation after independent review.`,
      dependsOn: [followupReview.id],
      requirementIds: [followupReview.requirementIds[0]],
      acceptanceCriteria: ['Record what the configured checks confirm after the independent review.'],
      requiredChecks: repositoryChecks(snapshot.run.plan.tasks.filter(task => task.required), snapshot.run.repository, snapshot.run.repository),
      scope: { includePaths: [], excludePaths: [] },
      required: true
    };
    const plan = orchestrationPlanSchema.parse({
      ...amendment.plan,
      tasks: amendment.plan.tasks.map(task => task.kind === 'delivery' && task.dependsOn.includes(followupReview.id)
        ? { ...task, dependsOn: [...task.dependsOn.filter(id => id !== followupReview.id), validationTask.id] }
        : task).concat(validationTask)
    });
    if (plan.tasks.length > MAX_PLAN_TASKS) {
      throw new OrchestrationReviewPlanError(`The correction plan would exceed the ${MAX_PLAN_TASKS}-task limit. ${copy.keep}`);
    }
    const issues = checkRunPlan(snapshot.run, plan, 'review_correction', eligibleAgents);
    if (issues.length) {
      throw new OrchestrationReviewPlanError(`The fresh validation gate did not pass its role and dependency checks: ${issues.map(issue => issue.detail).join(' ')}`);
    }
    amendment = {
      ...amendment,
      plan,
      addedTasks: [...amendment.addedTasks, { ...validationTask, status: 'pending', revision: 0, attemptCount: 0 }]
    };
  }
  return {
    ...amendment,
    findings: amendment.findings.map(finding => ({
      ...finding,
      sourceTaskId: finding.taskId,
      evidence: { ...finding.evidence, origin }
    }))
  };
}

export const MAX_REVIEW_FEEDBACK_CHARS = 2_000;

/**
 * Turn a reviewer's "send it back" into owner corrections on the same build.
 *
 * The build must be waiting for final review with every required task accepted.
 * The feedback goes to each accepted implementation task that changed files,
 * narrowed to the tasks whose files the reviewer named when they named any.
 * Each owner keeps its original path scope; the corrections are reviewed and
 * validated again before the build returns to review.
 */
export function buildHumanReviewAmendment(
  snapshot: OrchestrationSnapshot,
  feedback: string,
  eligibleAgents: readonly Pick<Agent, 'id' | 'role'>[]
): OrchestrationReviewAmendment {
  const request = feedback.trim();
  if (!request) throw new OrchestrationReviewPlanError('Describe what should change before sending the work back.');
  if (request.length > MAX_REVIEW_FEEDBACK_CHARS) {
    throw new OrchestrationReviewPlanError(`Keep the requested changes under ${MAX_REVIEW_FEEDBACK_CHARS.toLocaleString()} characters.`);
  }
  if (snapshot.run.status !== 'awaiting_approval' || snapshot.run.currentTaskId) {
    throw new OrchestrationReviewPlanError('Only a build that is waiting for final review can be sent back.');
  }
  if (!snapshot.tasks.filter(task => task.required).every(task => task.status === 'accepted')) {
    throw new OrchestrationReviewPlanError('Every required task must be accepted before the work can be sent back.');
  }
  const taskChanges = acceptedCodeChanges(snapshot);
  const owners = snapshot.tasks.filter(task => task.status === 'accepted' && isImplementationTask(task.kind) &&
    (taskChanges.get(task.id)?.length ?? 0) > 0);
  if (!owners.length) {
    throw new OrchestrationReviewPlanError('No accepted implementation task changed files in this build, so there is no owner to correct. Describe the change as a new build instead.');
  }
  const lowered = request.toLowerCase();
  const mentions = (filePath: string) => lowered.includes(filePath.toLowerCase()) ||
    lowered.includes(path.posix.basename(filePath).toLowerCase());
  const named = owners.filter(task => (taskChanges.get(task.id) ?? []).some(mentions));
  // One finding per implementation root, on its most recent accepted correction when it has one.
  const byRoot = new Map<string, OrchestrationTaskRecord>();
  for (const task of named.length ? named : owners) {
    const rootId = task.correctionOfTaskId ?? task.id;
    const current = byRoot.get(rootId);
    if (!current || (task.correctionCycle ?? 0) >= (current.correctionCycle ?? 0)) byRoot.set(rootId, task);
  }
  const findings: OrchestrationReviewFinding[] = [...byRoot.values()].map(target => {
    const changed = taskChanges.get(target.id) ?? [];
    return {
      targetTaskId: target.id,
      severity: 'blocking' as const,
      title: `Reviewer requested changes: ${target.title}`.slice(0, 240),
      path: changed.find(mentions) ?? changed[0],
      evidence: `The reviewer sent the finished work back before publication with this request: ${request}`,
      instruction: `Apply the parts of the reviewer's request that belong to task ${target.id}: "${request}". Keep every change inside this task's original path scope, rerun its required checks, and report any requested change outside this scope as a blocker instead of making it.`
    };
  });
  return routeOwnerFindings(snapshot, findings, eligibleAgents, 'human_review');
}
