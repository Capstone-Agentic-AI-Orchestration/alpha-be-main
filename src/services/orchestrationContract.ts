import { z } from 'zod';
import type { Agent } from '../models/index.js';

/**
 * Versioned, provider-independent contract for a task-driven build plan.
 * Model output is untrusted input: parse it, then validate the graph against
 * the selected project squad before persisting or dispatching anything.
 */
export const ORCHESTRATION_PLAN_SCHEMA_VERSION = 1 as const;
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
  schemaVersion: z.literal(ORCHESTRATION_PLAN_SCHEMA_VERSION),
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
    title: shortText,
    description: detailText,
    kind: orchestrationTaskKindSchema,
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
  schemaVersion: z.literal(1),
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
  blockers: z.array(shortText).max(10).default([])
}).strict();

export type OrchestrationAgentReport = z.infer<typeof orchestrationAgentReportSchema>;

export interface PlanValidationIssue {
  code: 'duplicate_id' | 'duplicate_requirement_id' | 'no_required_tasks' | 'unknown_owner' | 'role_mismatch' | 'unknown_dependency'
    | 'self_dependency' | 'dependency_cycle' | 'unknown_requirement' | 'uncovered_requirement' | 'too_many_tasks'
    | 'missing_independent_review' | 'review_not_independent' | 'review_dependency_missing' | 'validation_after_review_missing'
    | 'unknown_repository' | 'unassigned_repository';
  taskId?: string;
  detail: string;
}

const ROLE_CAPABILITIES: Record<OrchestrationTaskKind, ReadonlySet<string>> = {
  requirements: new Set(['researcher', 'research agent', 'triager', 'manager agent', 'orchestrator agent', 'architect', 'architecture agent']),
  architecture: new Set(['architect', 'architecture agent']),
  database: new Set(['database agent', 'coder']),
  backend: new Set(['backend agent', 'coder']),
  frontend: new Set(['frontend agent', 'coder']),
  mobile: new Set(['mobile agent', 'coder']),
  review: new Set(['reviewer', 'security / code quality agent']),
  validation: new Set(['qa tester', 'validation / checking agent']),
  delivery: new Set(['devops', 'devops engineer', 'github finalization agent'])
};

export function roleCanOwnOrchestrationTask(kind: OrchestrationTaskKind, role: string): boolean {
  return ROLE_CAPABILITIES[kind].has(role.trim().toLowerCase());
}

/**
 * Validate task ownership and dependencies deterministically. No model is
 * allowed to choose an agent by roster position or broaden its permissions.
 */
export function validateOrchestrationPlan(
  plan: OrchestrationPlan,
  eligibleAgents: readonly Pick<Agent, 'id' | 'role'>[],
  options: { maxTaskCount?: number; initialPlan?: boolean; repositories?: readonly string[] } = {}
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

  for (const task of plan.tasks) {
    if (task.repository) {
      if (repositories && !repositories.has(task.repository.toLowerCase())) {
        issues.push({ code: 'unknown_repository', taskId: task.id, detail: `Task ${task.id} names a repository that was not selected for this build.` });
      } else {
        assignedRepositories.add(task.repository.toLowerCase());
      }
    } else if (repositories?.size && repositories.size > 1) {
      issues.push({ code: 'unknown_repository', taskId: task.id, detail: `Task ${task.id} must name the selected repository it belongs to.` });
    }
    const owner = agents.get(task.ownerAgentId);
    if (!owner) {
      issues.push({ code: 'unknown_owner', taskId: task.id, detail: `Task owner "${task.ownerAgentId}" is not an eligible project specialist.` });
    } else if (!roleCanOwnOrchestrationTask(task.kind, owner.role)) {
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
    if (!assignedRepositories.has(repository)) {
      issues.push({ code: 'unassigned_repository', detail: `No task is assigned to selected repository ${repository}.` });
    }
  }

  for (const requirement of plan.requirements) {
    if (!covered.has(requirement.id)) {
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

  if (options.initialPlan && codeTasks.length && availableIndependentReviewers.length && !requiredReviewTasks.length) {
    issues.push({
      code: 'missing_independent_review',
      detail: 'Code work needs a required review task owned by an eligible specialist who did not implement it.'
    });
  }
  if (options.initialPlan && codeTasks.length && availableIndependentReviewers.length && requiredReviewTasks.length > 1) {
    issues.push({ code: 'missing_independent_review', detail: 'Use one initial independent review task; Alpha will create bounded follow-up reviews when corrections are needed.' });
  }

  for (const reviewTask of requiredReviewTasks) {
    const ancestors = ancestorsOf(reviewTask.id);
    const reviewedCode = codeTasks.filter(task => ancestors.has(task.id));
    if (reviewedCode.some(task => task.ownerAgentId === reviewTask.ownerAgentId)) {
      issues.push({ code: 'review_not_independent', taskId: reviewTask.id, detail: 'A review task must be owned by an agent who did not own the code task being reviewed.' });
    }
  }
  if (options.initialPlan && codeTasks.length && availableIndependentReviewers.length) {
    const reviewTask = requiredReviewTasks[0];
    if (reviewTask && codeTasks.some(task => !ancestorsOf(reviewTask.id).has(task.id))) {
      issues.push({ code: 'review_dependency_missing', taskId: reviewTask.id, detail: 'The independent review must depend on every required code task so it sees the complete implementation.' });
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
