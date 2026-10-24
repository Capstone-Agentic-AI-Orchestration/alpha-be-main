import { z } from 'zod';
import type { Agent } from '../models/index.js';
import { roleCanOwnTask } from './agentRoleContracts.js';
import { dependencyAuditSpecSchema } from './dependencyAuditContract.js';

/**
 * Versioned, provider-independent contract for a task-driven build plan.
 * Model output is untrusted input: parse it, then validate the graph against
 * the selected project squad before persisting or dispatching anything.
 */
export const ORCHESTRATION_PLAN_SCHEMA_VERSION = 1 as const;
/** Version expected in every specialist's structured task report. */
export const ORCHESTRATION_AGENT_REPORT_SCHEMA_VERSION = 1 as const;
export const MAX_INITIAL_PLAN_TASKS = 12;
export const MAX_PLAN_TASKS = 64;
export const MAX_TASK_DEPENDENCIES = 8;
export const MAX_TASK_REQUIREMENTS = 12;
export const MAX_TASK_ACCEPTANCE_CRITERIA = 12;
export const MAX_PROJECT_CONTEXT_CHARS = 8_000;

export const orchestrationTaskKindSchema = z.enum([
  'requirements',
  'architecture',
  'database',
  'backend',
  'frontend',
  'mobile',
  'audit',
  'review',
  'validation',
  'delivery'
]);

export type OrchestrationTaskKind = z.infer<typeof orchestrationTaskKindSchema>;

export const orchestrationRequiredCheckSchema = z.enum([
  'verify', 'check', 'validate', 'ci', 'test', 'typecheck', 'lint'
]);

export type OrchestrationRequiredCheck = z.infer<typeof orchestrationRequiredCheckSchema>;

const shortText = z.string().trim().min(1).max(240);
const detailText = z.string().trim().min(1).max(4_000);
const identifier = z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const scopePattern = z.string().trim().min(1).max(240).refine(value =>
  !value.startsWith('/') &&
  !value.includes('\\') &&
  !value.includes(':') &&
  !value.split('/').some(segment => segment === '..' || segment === '.' || segment === '')
, 'Scope patterns must be relative repository paths without dot segments.');

export const orchestrationPlanSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  /** Alpha stamps new plans; absent only on saved plans predating role separation. */
  roleContractVersion: z.union([z.literal(1), z.literal(2)]).optional(),
  milestones: z.array(z.object({
    id: identifier,
    title: shortText,
    objective: detailText,
    requirementIds: z.array(identifier).min(1).max(20),
    repositories: z.array(z.string().trim().min(1).max(200)).min(1).max(10)
  }).strict()).min(2).max(6).optional(),
  goal: z.string().trim().min(1).max(4_000),
  /** Snapshot of saved project rules carried to each specialist. Set by Alpha, not trusted from model output. */
  projectContext: z.string().max(MAX_PROJECT_CONTEXT_CHARS).optional(),
  exclusions: z.array(shortText).max(20).default([]),
  requirements: z.array(z.object({
    id: identifier,
    description: detailText
  }).strict()).min(1).max(20),
  tasks: z.array(z.object({
    id: identifier,
    buildStepId: identifier.optional(),
    milestoneId: identifier.optional(),
    title: shortText,
    description: detailText,
    kind: orchestrationTaskKindSchema,
    dependencyAudit: dependencyAuditSpecSchema.optional(),
    /** Selected project repository this task changes. Omitted only for older single-repository plans. */
    repository: z.string().trim().min(1).max(200).optional(),
    ownerAgentId: identifier,
    /** Short, user-visible role-fit explanation; never private model reasoning. */
    assignmentReason: z.string().trim().min(1).max(500).optional(),
    dependsOn: z.array(identifier).max(MAX_TASK_DEPENDENCIES).default([]),
    requirementIds: z.array(identifier).min(1).max(MAX_TASK_REQUIREMENTS),
    acceptanceCriteria: z.array(detailText).min(1).max(MAX_TASK_ACCEPTANCE_CRITERIA),
    requiredChecks: z.array(orchestrationRequiredCheckSchema).max(7).default([]),
    scope: z.object({
      includePaths: z.array(scopePattern).max(60).default([]),
      excludePaths: z.array(scopePattern).max(60).default([])
    }).strict().default({ includePaths: [], excludePaths: [] }),
    required: z.boolean().default(true)
  }).strict()).min(1).max(MAX_PLAN_TASKS)
}).strict();

export type OrchestrationPlan = z.infer<typeof orchestrationPlanSchema>;
export type OrchestrationTaskDefinition = OrchestrationPlan['tasks'][number];

const repositoryPath = z.string().trim().min(1).max(1_000).refine(value =>
  !value.startsWith('/') &&
  !value.includes('\\') &&
  !value.includes(':') &&
  !value.split('/').some(segment => segment === '..' || segment === '.' || segment === '')
, 'Deliverable paths must be relative repository paths without dot segments.');

/** Provider-independent specialist submission; Alpha adds trusted run evidence separately. */
export const orchestrationAgentReportSchema = z.object({
  schemaVersion: z.literal(ORCHESTRATION_AGENT_REPORT_SCHEMA_VERSION),
  taskId: identifier,
  summary: z.string().trim().min(1).max(4_000),
  requirementCoverage: z.array(z.object({
    requirementId: identifier,
    evidence: detailText
  }).strict()).max(MAX_TASK_REQUIREMENTS),
  criteriaEvidence: z.array(z.object({
    criterion: detailText,
    evidence: detailText
  }).strict()).max(MAX_TASK_ACCEPTANCE_CRITERIA),
  deliverables: z.array(z.object({
    summary: detailText,
    paths: z.array(repositoryPath).max(60)
  }).strict()).min(1).max(20),
  reportedChecks: z.array(z.object({
    script: shortText,
    result: z.enum(['passed', 'failed', 'not_run']),
    evidence: detailText
  }).strict()).max(20),
  reviewFindings: z.array(z.object({
    targetTaskId: identifier,
    severity: z.enum(['warning', 'blocking', 'critical']),
    title: shortText,
    requirementId: identifier.optional(),
    path: repositoryPath.optional(),
    evidence: detailText,
    instruction: detailText
  }).strict()).max(20).optional(),
  findingCoverage: z.array(z.object({
    findingId: identifier,
    evidence: detailText
  }).strict()).max(20).optional(),
  auditEvidenceIds: z.array(z.string().regex(/^audit-[a-f0-9-]{36}$/)).max(10).optional(),
  blockers: z.array(shortText).max(10).default([])
}).strict();

export type OrchestrationAgentReport = z.infer<typeof orchestrationAgentReportSchema>;

export interface PlanValidationIssue {
  code: 'duplicate_id' | 'duplicate_requirement_id' | 'no_required_tasks' | 'unknown_owner' | 'role_mismatch' | 'unknown_dependency'
    | 'self_dependency' | 'dependency_cycle' | 'unknown_requirement' | 'uncovered_requirement' | 'too_many_tasks'
    | 'missing_independent_review' | 'review_not_independent' | 'review_dependency_missing' | 'validation_after_review_missing'
    | 'unknown_repository' | 'unassigned_repository' | 'invalid_milestone'
    | 'duplicate_requirements_brief' | 'requirements_dependency_missing'
    | 'audit_authority' | 'audit_dependency_missing' | 'audit_verification_missing';
  taskId?: string;
  detail: string;
}

export function roleCanOwnOrchestrationTask(kind: OrchestrationTaskKind, role: string): boolean {
  return roleCanOwnTask(kind, role);
}

/** Compatibility is confined to persisted old plans, never new routing or planning. */
export function roleCanOwnSavedTask(kind: OrchestrationTaskKind, role: string, version?: number): boolean {
  return roleCanOwnTask(kind, role) || (version === undefined && kind === 'requirements' &&
    ['orchestrator agent', 'architect', 'architecture agent'].includes(role.trim().toLowerCase()));
}

/**
 * Validate task ownership and dependencies deterministically. No model is
 * allowed to choose an agent by roster position or broaden its permissions.
 */
export function validateOrchestrationPlan(
  plan: OrchestrationPlan,
  eligibleAgents: readonly Pick<Agent, 'id' | 'role'>[],
  options: { maxTaskCount?: number; initialPlan?: boolean; repositories?: readonly string[]; auditMilestone?: boolean } = {}
): PlanValidationIssue[] {
  const issues: PlanValidationIssue[] = [];
  const maxTaskCount = options.maxTaskCount ?? MAX_PLAN_TASKS;
  if (plan.tasks.length > maxTaskCount) {
    issues.push({ code: 'too_many_tasks', detail: `A plan may contain at most ${maxTaskCount} tasks at this stage.` });
  }
  const tasks = new Map<string, OrchestrationTaskDefinition>();
  for (const task of plan.tasks) {
    if (tasks.has(task.id)) {
      issues.push({ code: 'duplicate_id', taskId: task.id, detail: `Task ID "${task.id}" is repeated.` });
    } else {
      tasks.set(task.id, task);
    }
  }

  const uniqueRequirements = new Set<string>();
  for (const requirement of plan.requirements) {
    if (uniqueRequirements.has(requirement.id)) {
      issues.push({ code: 'duplicate_requirement_id', detail: `Requirement ID "${requirement.id}" is repeated.` });
    }
    uniqueRequirements.add(requirement.id);
  }
  if (!plan.tasks.some(task => task.required)) {
    issues.push({ code: 'no_required_tasks', detail: 'A build plan must contain at least one required task.' });
  }

  const agents = new Map(eligibleAgents.map(agent => [agent.id, agent]));
  const repositories = options.repositories ? new Set(options.repositories.map(value => value.toLowerCase())) : undefined;
  const assignedRepositories = new Set<string>();
  const requirementIds = new Set(plan.requirements.map(requirement => requirement.id));
  const covered = new Set<string>();

  const milestones = plan.milestones ?? [];
  const invalidMilestone = (detail: string) => issues.push({ code: 'invalid_milestone' as const, detail });
  if ((plan.schemaVersion === 2) !== Boolean(milestones.length)) invalidMilestone('Schema v2 requires a milestone roadmap; direct plans use v1.');
  if (new Set(milestones.map(item => item.id)).size !== milestones.length) invalidMilestone('Milestone IDs must be unique.');
  const plannedMilestones = new Set(plan.tasks.map(task => task.milestoneId).filter(Boolean));
  let deferred = false;
  for (const milestone of milestones) {
    if (milestone.requirementIds.some(id => !requirementIds.has(id))) invalidMilestone(`Milestone ${milestone.id} contains an unknown requirement.`);
    if (repositories && milestone.repositories.some(repo => !repositories.has(repo.toLowerCase()))) invalidMilestone(`Milestone ${milestone.id} names an unselected repository.`);
    if (!plannedMilestones.has(milestone.id)) deferred = true;
    else {
      if (deferred) invalidMilestone('Milestones must be planned in roadmap order.');
      const required = plan.tasks.filter(task => task.milestoneId === milestone.id && task.required);
      for (const id of milestone.requirementIds) if (!required.some(task => task.requirementIds.includes(id))) invalidMilestone(`Milestone ${milestone.id} does not cover ${id}.`);
      for (const repo of milestone.repositories) if (!required.some(task => task.repository?.toLowerCase() === repo.toLowerCase())) invalidMilestone(`Milestone ${milestone.id} has no required task for ${repo}.`);
    }
  }
  if (milestones.length && !plannedMilestones.has(milestones[0].id)) invalidMilestone('The first milestone must have executable tasks.');
  if (options.initialPlan && milestones.length && plannedMilestones.size !== 1) invalidMilestone('Initially detail only the first milestone.');
  for (const task of plan.tasks) {
    const milestone = milestones.find(item => item.id === task.milestoneId);
    if (milestones.length && !milestone) invalidMilestone(`Task ${task.id} needs an approved milestone.`);
    if (!milestones.length && task.milestoneId) invalidMilestone('Direct tasks cannot name milestones.');
    if (milestone && (task.requirementIds.some(id => !milestone.requirementIds.includes(id)) || !task.repository || !milestone.repositories.some(repo => repo.toLowerCase() === task.repository!.toLowerCase()))) invalidMilestone(`Task ${task.id} exceeds its milestone requirements or repositories.`);
  }

  for (const task of plan.tasks) {
    if (task.repository) {
      if (repositories && !repositories.has(task.repository.toLowerCase())) {
        issues.push({ code: 'unknown_repository', taskId: task.id, detail: `Task ${task.id} names a repository that was not selected for this build.` });
      } else {
        assignedRepositories.add(task.repository.toLowerCase());
      }
    } else if (repositories?.size && repositories.size > 1) {
      issues.push({ code: 'unknown_repository', taskId: task.id, detail: `Task ${task.id} must name the selected repository it belongs to.` });
    } else if (repositories?.size === 1) {
      // Legacy single-repository plans omit the per-task repository field.
      assignedRepositories.add([...repositories][0]);
    }
    const owner = agents.get(task.ownerAgentId);
    if (!owner) {
      issues.push({ code: 'unknown_owner', taskId: task.id, detail: `Task owner "${task.ownerAgentId}" is not an eligible project specialist.` });
    } else if (!roleCanOwnSavedTask(task.kind, owner.role, plan.roleContractVersion)) {
      issues.push({ code: 'role_mismatch', taskId: task.id, detail: `${owner.role} is not an approved owner role for ${task.kind} tasks.` });
    }

    for (const requirementId of task.requirementIds) {
      if (!requirementIds.has(requirementId)) {
        issues.push({ code: 'unknown_requirement', taskId: task.id, detail: `Task references unknown requirement "${requirementId}".` });
      } else if (task.required) {
        covered.add(requirementId);
      }
    }

    for (const dependencyId of task.dependsOn) {
      if (dependencyId === task.id) {
        issues.push({ code: 'self_dependency', taskId: task.id, detail: 'A task cannot depend on itself.' });
      } else if (!tasks.has(dependencyId)) {
        issues.push({ code: 'unknown_dependency', taskId: task.id, detail: `Task depends on unknown task "${dependencyId}".` });
      }
    }
  }

  for (const repository of repositories ?? []) {
    if (!assignedRepositories.has(repository) && !milestones.some(item => item.repositories.some(repo => repo.toLowerCase() === repository))) {
      issues.push({ code: 'unassigned_repository', detail: `No task is assigned to selected repository ${repository}.` });
    }
  }

  for (const requirement of plan.requirements) {
    if (!covered.has(requirement.id) && !milestones.some(item => item.requirementIds.includes(requirement.id))) {
      issues.push({ code: 'uncovered_requirement', detail: `No task is assigned to requirement "${requirement.id}".` });
    }
  }

  // Depth-first search detects cycles without relying on task ordering.
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cycleTasks = new Set<string>();
  const visit = (taskId: string, trail: string[]) => {
    if (visiting.has(taskId)) {
      const start = trail.indexOf(taskId);
      for (const member of trail.slice(Math.max(start, 0))) cycleTasks.add(member);
      return;
    }
    if (visited.has(taskId)) return;
    visiting.add(taskId);
    const task = tasks.get(taskId);
    for (const dependencyId of task?.dependsOn ?? []) {
      if (tasks.has(dependencyId)) visit(dependencyId, [...trail, taskId]);
    }
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const taskId of tasks.keys()) visit(taskId, []);
  for (const taskId of cycleTasks) {
    issues.push({ code: 'dependency_cycle', taskId, detail: `Task "${taskId}" participates in a dependency cycle.` });
  }

  const codeTasks = plan.tasks.filter(task => task.required && ['database', 'backend', 'frontend', 'mobile'].includes(task.kind));
  const codeOwnerIds = new Set(codeTasks.map(task => task.ownerAgentId));
  const availableIndependentReviewers = eligibleAgents.filter(agent =>
    roleCanOwnOrchestrationTask('review', agent.role) && !codeOwnerIds.has(agent.id)
  );
  const requiredReviewTasks = plan.tasks.filter(task => task.required && task.kind === 'review');
  const requiredValidationTasks = plan.tasks.filter(task => task.required && task.kind === 'validation');
  const ancestorsOf = (taskId: string): Set<string> => {
    const ancestors = new Set<string>();
    const visit = (currentId: string) => {
      for (const dependencyId of tasks.get(currentId)?.dependsOn ?? []) {
        if (ancestors.has(dependencyId)) continue;
        ancestors.add(dependencyId);
        visit(dependencyId);
      }
    };
    visit(taskId);
    return ancestors;
  };

  const audits = plan.tasks.filter(task => task.dependencyAudit);
  const repositoryOf = (task: OrchestrationTaskDefinition) => (task.repository ?? options.repositories?.[0] ?? '').toLowerCase();
  const milestoneIndex = (task: OrchestrationTaskDefinition) => task.milestoneId ? plan.milestones?.findIndex(item => item.id === task.milestoneId) ?? -1 : -1;
  const follows = (task: OrchestrationTaskDefinition, dependency: OrchestrationTaskDefinition) => ancestorsOf(task.id).has(dependency.id) ||
    (milestoneIndex(dependency) >= 0 && milestoneIndex(task) > milestoneIndex(dependency));
  for (const task of plan.tasks) {
    const spec = task.dependencyAudit;
    const role = agents.get(task.ownerAgentId)?.role ?? '';
    if ((task.kind === 'audit' && (!spec || spec.purpose === 'self-check')) ||
        (spec && (spec.purpose === 'self-check'
          ? !['database', 'backend', 'frontend', 'mobile', 'validation'].includes(task.kind)
          : !['audit', 'review'].includes(task.kind) || !roleCanOwnTask('audit', role)))) {
      issues.push({ code: 'audit_authority', taskId: task.id, detail: 'Independent audits require a Security audit/review owner; specialists may self-check only their assigned implementation/validation work.' });
    }
    if (spec && !task.repository) issues.push({ code: 'audit_authority', taskId: task.id, detail: 'An audit capability must name exactly one selected repository.' });
  }
  for (const baseline of audits.filter(task => task.required && task.dependencyAudit?.purpose === 'baseline')) {
    const fixes = codeTasks.filter(task => repositoryOf(task) === repositoryOf(baseline));
    for (const fix of fixes.filter(fix => milestoneIndex(fix) < 0 || milestoneIndex(fix) >= milestoneIndex(baseline))) if (!follows(fix, baseline)) {
      issues.push({ code: 'audit_dependency_missing', taskId: fix.id, detail: 'Dependency remediation must wait for its repository’s required baseline Security audit.' });
    }
    // A baseline-only adaptive milestone is valid; final acceptance checks the whole roadmap.
    if (!plan.milestones && !options.auditMilestone && !audits.some(task => task.required && task.dependencyAudit?.purpose === 'verification' &&
        repositoryOf(task) === repositoryOf(baseline) && ancestorsOf(task.id).has(baseline.id) && fixes.every(fix => ancestorsOf(task.id).has(fix.id)))) {
      issues.push({ code: 'audit_verification_missing', taskId: baseline.id, detail: 'A direct dependency-audit plan needs a required Security re-audit after the repository’s remediation (or baseline when no fix is needed).' });
    }
  }
  for (const verification of audits.filter(task => task.required && task.dependencyAudit?.purpose === 'verification')) {
    const levels = ['low', 'moderate', 'high', 'critical'];
    if (audits.some(baseline => baseline.required && baseline.dependencyAudit?.purpose === 'baseline' && repositoryOf(baseline) === repositoryOf(verification) &&
        levels.indexOf(verification.dependencyAudit!.level) > levels.indexOf(baseline.dependencyAudit!.level))) {
      issues.push({ code: 'audit_authority', taskId: verification.id, detail: 'Security verification cannot weaken the baseline vulnerability threshold.' });
    }
    const fixes = codeTasks.filter(task => repositoryOf(task) === repositoryOf(verification) && !ancestorsOf(task.id).has(verification.id) &&
      (milestoneIndex(task) < 0 || milestoneIndex(task) <= milestoneIndex(verification)));
    if (fixes.some(fix => fix.ownerAgentId === verification.ownerAgentId || !follows(verification, fix))) {
      issues.push({ code: 'audit_dependency_missing', taskId: verification.id, detail: 'Security verification must be independent and follow all implementation in its repository.' });
    }
    if (fixes.length && verification.kind !== 'review' && !requiredReviewTasks.some(review => follows(verification, review) && fixes.every(fix => follows(review, fix)))) {
      issues.push({ code: 'audit_dependency_missing', taskId: verification.id, detail: 'Security re-audit must follow independent review of the relevant implementation.' });
    }
    for (const validation of requiredValidationTasks.filter(task => repositoryOf(task) === repositoryOf(verification) && (milestoneIndex(task) < 0 || milestoneIndex(task) >= milestoneIndex(verification)))) {
      if (!follows(validation, verification)) issues.push({ code: 'audit_dependency_missing', taskId: validation.id, detail: 'Functional validation must follow its repository’s final Security audit.' });
    }
  }

  if (plan.roleContractVersion !== undefined) {
    const briefs = plan.tasks.filter(task => task.kind === 'requirements' && agents.get(task.ownerAgentId)?.role.trim().toLowerCase() === 'manager agent');
    const groups = new Map<string, number>();
    for (const brief of briefs) {
      const key = brief.milestoneId ?? 'direct';
      groups.set(key, (groups.get(key) ?? 0) + 1);
      if (groups.get(key)! > 1) issues.push({ code: 'duplicate_requirements_brief', taskId: brief.id, detail: 'Assign Manager at most once per milestone; do not duplicate requirements analysis.' });
      for (const implementation of codeTasks.filter(task => task.milestoneId === brief.milestoneId)) {
        if (!brief.required || !ancestorsOf(implementation.id).has(brief.id)) issues.push({ code: 'requirements_dependency_missing', taskId: implementation.id, detail: 'Implementation must wait for the required Manager brief; unresolved requirements must block work.' });
      }
    }
  }

  if (options.initialPlan && codeTasks.length && availableIndependentReviewers.length && !requiredReviewTasks.length) {
    issues.push({
      code: 'missing_independent_review',
      detail: 'Code work needs a required review task owned by an eligible specialist who did not implement it.'
    });
  }
  if (options.initialPlan && codeTasks.length && availableIndependentReviewers.length && requiredReviewTasks.length > 1) {
    const reviewScopes = new Set<string>();
    for (const review of requiredReviewTasks) {
      const scope = plan.roleContractVersion === 2 ? JSON.stringify([review.milestoneId ?? 'direct', repositoryOf(review)]) : 'legacy';
      if (reviewScopes.has(scope)) {
        issues.push({ code: 'missing_independent_review', taskId: review.id,
          detail: 'Use one initial independent review task per repository and milestone; Alpha will create bounded follow-up reviews when corrections are needed.' });
        break;
      }
      reviewScopes.add(scope);
    }
  }

  for (const reviewTask of requiredReviewTasks) {
    const ancestors = ancestorsOf(reviewTask.id);
    const reviewedCode = codeTasks.filter(task => ancestors.has(task.id));
    if (reviewedCode.some(task => task.ownerAgentId === reviewTask.ownerAgentId)) {
      issues.push({ code: 'review_not_independent', taskId: reviewTask.id, detail: 'A review task must be owned by an agent who did not own the code task being reviewed.' });
    }
  }
  if (options.initialPlan && codeTasks.length && availableIndependentReviewers.length) {
    for (const task of codeTasks) if (!requiredReviewTasks.some(review => (plan.roleContractVersion !== 2 || repositoryOf(review) === repositoryOf(task)) && follows(review, task))) {
      issues.push({ code: 'review_dependency_missing', taskId: task.id, detail: 'Every required code task needs a downstream independent review in its repository.' });
    }
  }
  if (codeTasks.length && requiredReviewTasks.length) {
    for (const task of codeTasks) {
      if (!requiredReviewTasks.some(review => ancestorsOf(review.id).has(task.id))) {
        issues.push({ code: 'review_dependency_missing', taskId: task.id, detail: `Required code task "${task.id}" has no downstream independent review.` });
      }
    }
    for (const validation of requiredValidationTasks) {
      if (!requiredReviewTasks.some(review => ancestorsOf(validation.id).has(review.id))) {
        issues.push({ code: 'validation_after_review_missing', taskId: validation.id, detail: 'Required validation must run after the independent review and any review corrections.' });
      }
    }
  }

  return issues;
}

export function ensureTaskAssignmentReasons(
  plan: OrchestrationPlan,
  eligibleAgents: readonly Pick<Agent, 'id' | 'role'>[]
): OrchestrationPlan {
  const agents = new Map(eligibleAgents.map(agent => [agent.id, agent]));
  return {
    ...plan,
    tasks: plan.tasks.map(task => ({
      ...task,
      assignmentReason: task.assignmentReason?.trim() ||
        `This task needs ${agents.get(task.ownerAgentId)?.role ?? 'specialist'} expertise for ${task.kind} work.`
    }))
  };
}

export function parseOrchestrationPlan(input: unknown): OrchestrationPlan {
  return orchestrationPlanSchema.parse(input);
}
