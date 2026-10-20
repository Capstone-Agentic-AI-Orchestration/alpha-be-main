import type { OrchestrationPlan, OrchestrationTaskDefinition } from './orchestrationContract.js';

export type OrchestrationRunStatus =
  | 'planning'
  | 'awaiting_plan_approval'
  | 'executing'
  | 'validating'
  | 'awaiting_approval'
  | 'publishing'
  | 'cancelling'
  | 'completed'
  | 'blocked'
  | 'recovery_required'
  | 'failed'
  | 'cancelled';

export type OrchestrationTaskStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'submitted'
  | 'accepted'
  | 'blocked'
  | 'failed'
  | 'cancelled'
  | 'superseded';

export interface OrchestrationTaskRecord extends OrchestrationTaskDefinition {
  /** Root implementation task when this task is an orchestrator-created correction. */
  correctionOfTaskId?: string;
  /** One-based bounded correction cycle for the originating implementation task. */
  correctionCycle?: number;
  status: OrchestrationTaskStatus;
  revision: number;
  attemptCount: number;
  acceptedRevision?: number;
  updatedAt?: string;
}

export type OrchestrationAttemptStatus =
  | 'starting'
  | 'running'
  | 'submitted'
  | 'accepted'
  | 'rejected'
  | 'failed'
  | 'cancelled'
  | 'recovery_required';

export interface OrchestrationAttemptRecord {
  id: string;
  runId: string;
  taskId: string;
  attemptNumber: number;
  agentId: string;
  prototypeRunId?: string;
  startingCommit?: string;
  resultCommit?: string;
  personaHash?: string;
  modelProvider?: string;
  modelName?: string;
  contextManifest: Record<string, unknown>;
  status: OrchestrationAttemptStatus;
  result?: Record<string, unknown>;
  failureReason?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface OrchestrationEventRecord {
  id: number;
  eventId: string;
  runId: string;
  sequence: number;
  actorId?: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

/** Minimal event metadata safe to publish over the local realtime channel. */
export interface OrchestrationOutboxDeliveryRecord {
  workspaceId: string;
  runId: string;
  eventId: string;
  sequence: number;
  type: string;
  createdAt: string;
  attempts: number;
}

export interface OrchestrationArtifactRecord {
  id: string;
  runId: string;
  taskId: string;
  attemptId: string;
  type: string;
  version: number;
  contentHash: string;
  contentReference?: string;
  content?: string;
  metadata: Record<string, unknown>;
  status: string;
  createdAt: string;
}

export interface OrchestrationFindingRecord {
  id: string;
  runId: string;
  taskId: string;
  sourceTaskId: string;
  severity: string;
  requirementId?: string;
  artifactId?: string;
  path?: string;
  evidence: Record<string, unknown>;
  status: string;
  correctionTaskId?: string;
  createdAt: string;
  resolvedAt?: string;
}

export interface OrchestrationSnapshot {
  run: OrchestrationRunRecord;
  tasks: OrchestrationTaskRecord[];
  attempts: OrchestrationAttemptRecord[];
  artifacts: OrchestrationArtifactRecord[];
  findings: OrchestrationFindingRecord[];
}

/** One isolated branch and worktree belonging to a shared product build. */
export interface OrchestrationRepositoryWorkspace {
  repository: string;
  branchName: string;
  baseRef: string;
  baseCommit: string;
  /** Executor-local path; never include this field in a shared cloud projection. */
  worktreePath: string;
}

export interface OrchestrationPublicationRecord {
  repository?: string;
  branchName: string;
  baseBranch: string;
  resultCommit: string;
  pullRequestUrl: string;
  publishedAt: string;
}

export interface OrchestrationRunRecord {
  id: string;
  workspaceId: string;
  projectId: string;
  issueId: string;
  repository: string;
  requestKey: string;
  requestFingerprint: string;
  createdBy: string;
  executorId: string;
  ownershipEpoch: number;
  workflowVersion: number;
  planVersion: number;
  plan: OrchestrationPlan;
  status: OrchestrationRunStatus;
  revision: number;
  currentTaskId?: string;
  stoppedReason?: string;
  branchName?: string;
  baseRef?: string;
  baseCommit?: string;
  /** Executor-local path; never include this field in a shared cloud projection. */
  worktreePath?: string;
  /** Every selected codebase participating in this one coordinated product build. */
  repositoryWorkspaces?: OrchestrationRepositoryWorkspace[];
  /** Remote publication reconciled after explicit human approval. */
  publication?: OrchestrationPublicationRecord;
  /** All pull requests opened for a coordinated multi-codebase product build. */
  publications?: OrchestrationPublicationRecord[];
  createdAt: string;
  updatedAt: string;
}

export const RUN_TRANSITIONS: Readonly<Record<OrchestrationRunStatus, ReadonlySet<OrchestrationRunStatus>>> = {
  planning: new Set(['awaiting_plan_approval', 'executing', 'blocked', 'failed', 'cancelled']),
  awaiting_plan_approval: new Set(['executing', 'blocked', 'cancelling', 'cancelled']),
  executing: new Set(['validating', 'blocked', 'recovery_required', 'failed', 'cancelling', 'cancelled']),
  validating: new Set(['executing', 'awaiting_approval', 'blocked', 'recovery_required', 'failed', 'cancelling', 'cancelled']),
  awaiting_approval: new Set(['publishing', 'cancelling', 'cancelled']),
  publishing: new Set(['completed']),
  completed: new Set(),
  blocked: new Set(['planning', 'executing', 'validating', 'failed', 'cancelling', 'cancelled']),
  recovery_required: new Set(['executing', 'failed', 'cancelling', 'cancelled']),
  cancelling: new Set(['recovery_required', 'cancelled']),
  failed: new Set(),
  cancelled: new Set()
};

export const TASK_TRANSITIONS: Readonly<Record<OrchestrationTaskStatus, ReadonlySet<OrchestrationTaskStatus>>> = {
  pending: new Set(['ready', 'blocked', 'cancelled', 'superseded']),
  ready: new Set(['running', 'blocked', 'cancelled', 'superseded']),
  running: new Set(['submitted', 'blocked', 'failed', 'cancelled']),
  submitted: new Set(['accepted', 'blocked', 'failed', 'cancelled']),
  accepted: new Set(['superseded']),
  blocked: new Set(['ready', 'cancelled', 'superseded']),
  failed: new Set(['ready', 'cancelled', 'superseded']),
  cancelled: new Set(),
  superseded: new Set()
};

export class OrchestrationTransitionError extends Error {
  constructor(message: string, readonly code: 'invalid_transition' | 'stale_revision' | 'dependencies_incomplete') {
    super(message);
    this.name = 'OrchestrationTransitionError';
  }
}

export function transitionTask(
  task: OrchestrationTaskRecord,
  nextStatus: OrchestrationTaskStatus,
  expectedRevision: number,
  acceptedDependencyIds: ReadonlySet<string>,
  now = new Date().toISOString()
): OrchestrationTaskRecord {
  if (task.revision !== expectedRevision) {
    throw new OrchestrationTransitionError('Task changed since this operation was prepared.', 'stale_revision');
  }
  if (!TASK_TRANSITIONS[task.status].has(nextStatus)) {
    throw new OrchestrationTransitionError(`Cannot move task from ${task.status} to ${nextStatus}.`, 'invalid_transition');
  }
  if (nextStatus === 'ready' && task.dependsOn.some(id => !acceptedDependencyIds.has(id))) {
    throw new OrchestrationTransitionError('Task dependencies are not all accepted.', 'dependencies_incomplete');
  }
  return {
    ...task,
    status: nextStatus,
    revision: task.revision + 1,
    attemptCount: task.attemptCount + (nextStatus === 'running' ? 1 : 0),
    acceptedRevision: nextStatus === 'accepted' ? task.revision + 1 : undefined,
    updatedAt: now
  };
}

export function transitionRun(
  run: OrchestrationRunRecord,
  nextStatus: OrchestrationRunStatus,
  expectedRevision: number,
  now = new Date().toISOString()
): OrchestrationRunRecord {
  if (run.revision !== expectedRevision) {
    throw new OrchestrationTransitionError('Build changed since this operation was prepared.', 'stale_revision');
  }
  if (!RUN_TRANSITIONS[run.status].has(nextStatus)) {
    throw new OrchestrationTransitionError(`Cannot move build from ${run.status} to ${nextStatus}.`, 'invalid_transition');
  }
  return { ...run, status: nextStatus, revision: run.revision + 1, updatedAt: now };
}

/**
 * Return the first ready task in immutable plan order whose dependencies have
 * been accepted. Multiple tasks for the same agent remain separate entries.
 */
export function selectNextReadyTask(
  plan: OrchestrationPlan,
  tasks: readonly OrchestrationTaskRecord[]
): OrchestrationTaskRecord | undefined {
  const byId = new Map(tasks.map(task => [task.id, task]));
  // An optional task only runs when a required task depends on it. This keeps
  // optional planner suggestions from turning into extra specialist calls.
  const requiredTaskIds = new Set(plan.tasks.filter(task => task.required).map(task => task.id));
  const requiredWorkClosure = new Set<string>();
  const includeDependencies = (taskId: string) => {
    if (requiredWorkClosure.has(taskId)) return;
    requiredWorkClosure.add(taskId);
    const task = byId.get(taskId);
    for (const dependencyId of task?.dependsOn ?? []) includeDependencies(dependencyId);
  };
  for (const taskId of requiredTaskIds) includeDependencies(taskId);

  return plan.tasks
    .map(definition => byId.get(definition.id))
    .find((task): task is OrchestrationTaskRecord => Boolean(task)
      && task!.status === 'ready'
      && requiredWorkClosure.has(task!.id)
      && task!.dependsOn.every(dependencyId => byId.get(dependencyId)?.status === 'accepted'));
}

export function initialTaskRecords(plan: OrchestrationPlan): OrchestrationTaskRecord[] {
  const taskIds = new Set(plan.tasks.map(task => task.id));
  return plan.tasks.map(task => ({
    ...task,
    status: task.dependsOn.some(id => taskIds.has(id)) ? 'pending' as const : 'ready' as const,
    revision: 0,
    attemptCount: 0
  }));
}

export function allRequiredTasksAccepted(tasks: readonly OrchestrationTaskRecord[]): boolean {
  return tasks.filter(task => task.required).every(task => task.status === 'accepted');
}
