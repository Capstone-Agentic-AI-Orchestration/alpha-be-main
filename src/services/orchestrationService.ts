import { createHash, randomUUID } from 'node:crypto';
import type { Agent, PrototypeRun } from '../models/index.js';
import {
  orchestrationAgentReportSchema,
  MAX_INITIAL_PLAN_TASKS,
  parseOrchestrationPlan,
  validateOrchestrationPlan,
  type OrchestrationTaskKind
} from './orchestrationContract.js';
import { initialTaskRecords, selectNextReadyTask, allRequiredTasksAccepted, type OrchestrationSnapshot } from './orchestrationStateMachine.js';
import { SQLiteService } from './sqliteService.js';
import { runWithWorkspace } from './workspaceContext.js';
import type { OrchestrationReviewAmendment } from './orchestrationReviewWorkflow.js';
import { getGitChangedPaths, getGitDiffPatch } from '../utils/gitUtils.js';
import { assertOrchestrationApprovalCheckpointCurrent, getOrchestrationFinalValidationEvidence } from './orchestrationReviewService.js';
import { OrchestrationPublicationService } from './orchestrationPublication.js';

const MAX_REVIEW_CONTEXT_BYTES = 64 * 1024;

export interface OrchestrationLaunchRequest {
  runId: string;
  workspaceId: string;
  projectId: string;
  issueId: string;
  repository: string;
  planVersion: number;
  taskId: string;
  taskTitle: string;
  taskDescription: string;
  taskKind: OrchestrationTaskKind;
  ownerAgentId: string;
  attemptId: string;
  attemptNumber: number;
  taskPackage: OrchestrationTaskPackage;
  contextManifest: Record<string, unknown>;
  branchName?: string;
  workingDir?: string;
  baseRef?: string;
  baseCommit?: string;
  personaHash?: string;
  modelProvider?: string;
  modelName?: string;
}

export interface OrchestrationTaskPackage {
  packageVersion: 2;
  goal: string;
  exclusions: string[];
  task: {
    id: string;
    title: string;
    kind: OrchestrationTaskKind;
    description: string;
    acceptanceCriteria: string[];
    requiredChecks: Array<'verify' | 'check' | 'validate' | 'ci' | 'test' | 'typecheck' | 'lint'>;
    scope: { includePaths: string[]; excludePaths: string[] };
  };
  requirements: Array<{ id: string; description: string }>;
  acceptedDependencies: Array<{
    taskId: string;
    ownerAgentId: string;
    summary: string;
    resultCommit?: string;
  }>;
  reviewInputs: Array<{
    taskId: string;
    title: string;
    ownerAgentId: string;
    startingCommit: string;
    resultCommit: string;
    changedPaths: string[];
    diff: string;
    diffHash: string;
    relatedFindings: Array<{
      findingId: string;
      title: string;
      severity: string;
      path?: string;
      evidence: string;
      instruction: string;
    }>;
  }>;
  corrections: string[];
  findingIds: string[];
}

export interface PreparedOrchestrationTask {
  startingCommit?: string;
  personaHash?: string;
  modelProvider?: string;
  modelName?: string;
  contextManifest?: Record<string, unknown>;
  branchName?: string;
  workingDir?: string;
  baseRef?: string;
}

export interface OrchestrationLaunchReceipt {
  /** Existing prototype-run identity, used to reconcile real runner events. */
  prototypeRunId: string;
}

/** Execution boundary; tests use a fake, while M3 supplies the runner adapter. */
export interface OrchestrationExecutor {
  /** Prepare a bounded task workspace and persona snapshot before recording an attempt. */
  prepare?(request: OrchestrationLaunchRequest): Promise<PreparedOrchestrationTask>;
  launch(request: OrchestrationLaunchRequest): Promise<OrchestrationLaunchReceipt>;
  /** Stop a provider process when a concrete runner id is available. */
  cancel?(prototypeRunId: string): Promise<void>;
}

export interface StartOrchestrationInput {
  workspaceId: string;
  projectId: string;
  issueId: string;
  repository: string;
  requestKey: string;
  /** Stable hash of the original user request and authorized scope. */
  requestFingerprint: string;
  createdBy: string;
  executorId: string;
  /** Stable identity reserved before planning so a retried request resumes it. */
  runId?: string;
  /** Local planning reservation owner used to fence stale daemon sessions. */
  planningOwnerSessionId?: string;
  branchName?: string;
  baseRef?: string;
  baseCommit?: string;
  worktreePath?: string;
  eligibleAgents: readonly Pick<Agent, 'id' | 'role'>[];
  plan: unknown;
  planSource?: 'template' | 'model' | 'manual';
  startingCommit?: string;
  now?: string;
}

export class OrchestrationPlanError extends Error {
  constructor(readonly issues: ReturnType<typeof validateOrchestrationPlan>) {
    super(issues.map(issue => issue.detail).join(' '));
    this.name = 'OrchestrationPlanError';
  }
}

function parseAgentReport(text: string): { report?: Record<string, unknown>; error?: string } {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const payload = fenced ? fenced[1] : trimmed;
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return { error: 'The specialist response is not a single valid JSON task report.' };
  }
  const parsed = orchestrationAgentReportSchema.safeParse(value);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    return { error: `The specialist report does not match version 1: ${firstIssue?.path.join('.') || 'unknown field'} ${firstIssue?.message ?? 'invalid value'}.` };
  }
  return { report: parsed.data as unknown as Record<string, unknown> };
}

/**
 * Deterministic, single-active-task orchestrator. Planning is already complete
 * when this service is called; it validates the plan, persists it, selects one
 * owner at a time, and only dispatches the next task after acceptance.
 */
export class OrchestrationService {
  private readonly transitionQueues = new Map<string, Promise<unknown>>();
  private readonly publication: OrchestrationPublicationService;

  constructor(
    private readonly store: SQLiteService,
    private readonly executor: OrchestrationExecutor,
    publication?: OrchestrationPublicationService
  ) {
    this.publication = publication ?? new OrchestrationPublicationService({ store });
  }

  /** Record human approval, then reconcile one idempotent branch/PR publication. */
  async approveAndPublish(input: {
    workspaceId: string;
    runId: string;
    expectedRevision?: number;
    actorId: string;
    now?: string;
  }): Promise<OrchestrationSnapshot> {
    return runWithWorkspace(input.workspaceId, () => this.serialize(input.workspaceId, input.runId, async () => {
      let snapshot = this.store.getOrchestrationSnapshot(input.runId);
      if (!snapshot) throw new Error('Orchestration run not found.');

      if (snapshot.run.status === 'completed') {
        await this.publication.synchronizePublishedIssue(snapshot);
        return this.store.getOrchestrationSnapshot(input.runId)!;
      }

      if (snapshot.run.status === 'awaiting_approval') {
        if (!Number.isSafeInteger(input.expectedRevision) || snapshot.run.revision !== input.expectedRevision) {
          throw new Error('The build changed after this review was loaded. Refresh the review before approving it.');
        }
        await assertOrchestrationApprovalCheckpointCurrent(snapshot, this.store);
        const publicationTarget = await this.publication.prepare(snapshot);
        snapshot = this.store.transitionOrchestrationRun({
          runId: input.runId,
          expectedRevision: input.expectedRevision!,
          nextStatus: 'publishing',
          actorId: input.actorId,
          now: input.now,
          evidence: {
            decision: 'approved',
            approvedBy: input.actorId,
            approvedAt: input.now ?? new Date().toISOString(),
            resultCommit: publicationTarget.resultCommit,
            branchName: snapshot.run.branchName,
            publicationBaseBranch: publicationTarget.publicationBaseBranch
          }
        });
      }

      if (snapshot.run.status !== 'publishing') {
        throw new Error('This task build is not waiting for approval or publication recovery.');
      }

      const approvalEvents = runWithWorkspace(input.workspaceId, () => this.store.listOrchestrationEvents(input.runId, 0, 500));
      const approval = [...approvalEvents].reverse().find(event => event.type === 'run_publishing' &&
        event.payload.evidence && typeof event.payload.evidence === 'object' &&
        (event.payload.evidence as Record<string, unknown>).decision === 'approved');
      if (!approval) throw new Error('The durable human approval event is missing. Reopen the final review before retrying publication.');

      const publication = await this.publication.publish(snapshot);
      const completed = this.store.transitionOrchestrationRun({
        runId: input.runId,
        expectedRevision: snapshot.run.revision,
        nextStatus: 'completed',
        actorId: input.actorId,
        now: input.now,
        evidence: {
          ...approval.payload.evidence as Record<string, unknown>,
          publication
        }
      });
      await this.publication.synchronizePublishedIssue(completed);
      return this.store.getOrchestrationSnapshot(input.runId)!;
    }));
  }

  async start(input: StartOrchestrationInput): Promise<OrchestrationSnapshot> {
    return runWithWorkspace(input.workspaceId, async () => {
      const plan = parseOrchestrationPlan(input.plan);
      const issues = validateOrchestrationPlan(plan, input.eligibleAgents, { maxTaskCount: MAX_INITIAL_PLAN_TASKS, initialPlan: true });
      if (issues.length) throw new OrchestrationPlanError(issues);

      const existing = this.store.getOrchestrationByRequestKey(input.requestKey);
      if (existing) {
        if (existing.run.requestFingerprint !== input.requestFingerprint) {
          throw new Error('This request key is already attached to a different build request.');
        }
        return this.serialize(input.workspaceId, existing.run.id, async () => {
          const latest = this.store.getOrchestrationSnapshot(existing.run.id)!;
          return latest.run.status === 'executing' ? this.dispatchNextUnlocked(latest, input.createdBy) : latest;
        });
      }

      const now = input.now ?? new Date().toISOString();
      const run = this.store.createOrchestrationSnapshot({
        id: input.runId ?? `orchestration-${randomUUID()}`,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        issueId: input.issueId,
        repository: input.repository,
        requestKey: input.requestKey,
        requestFingerprint: input.requestFingerprint,
        createdBy: input.createdBy,
        executorId: input.executorId,
        ownershipEpoch: 1,
        workflowVersion: 1,
        planVersion: 1,
        plan,
        status: 'planning',
        revision: 0,
        branchName: input.branchName,
        baseRef: input.baseRef,
        baseCommit: input.baseCommit,
        worktreePath: input.worktreePath,
        createdAt: now,
        updatedAt: now
      }, initialTaskRecords(plan), input.planSource ?? 'template', input.planningOwnerSessionId);
      const executing = this.store.transitionOrchestrationRun({
        runId: run.run.id,
        expectedRevision: run.run.revision,
        nextStatus: 'executing',
        actorId: input.createdBy,
        now
      });
      return this.serialize(input.workspaceId, run.run.id, () => this.dispatchNextUnlocked(executing, input.createdBy, input.startingCommit));
    });
  }

  async submitResult(input: {
    workspaceId: string;
    runId: string;
    taskId: string;
    attemptId: string;
    expectedTaskRevision: number;
    result: Record<string, unknown>;
    resultCommit?: string;
    now?: string;
  }): Promise<OrchestrationSnapshot> {
    return runWithWorkspace(input.workspaceId, () => this.serialize(input.workspaceId, input.runId, async () =>
      this.store.submitOrchestrationAttempt(input)));
  }

  async acceptAttempt(input: {
    workspaceId: string;
    runId: string;
    taskId: string;
    attemptId: string;
    expectedTaskRevision: number;
    acceptedBy: string;
    evidence: Record<string, unknown>;
    dispatchNext?: boolean;
    now?: string;
  }): Promise<OrchestrationSnapshot> {
    return runWithWorkspace(input.workspaceId, () => this.serialize(input.workspaceId, input.runId, async () => {
      const snapshot = this.store.acceptOrchestrationAttempt(input);
      return input.dispatchNext === false
        ? snapshot
        : this.dispatchNextUnlocked(snapshot, input.acceptedBy, undefined, input.now);
    }));
  }

  async acceptReviewOutcome(input: {
    workspaceId: string;
    runId: string;
    taskId: string;
    attemptId: string;
    expectedTaskRevision: number;
    expectedPlanVersion: number;
    acceptedBy: string;
    evidence: Record<string, unknown>;
    amendment: OrchestrationReviewAmendment;
    dispatchNext?: boolean;
    now?: string;
  }): Promise<OrchestrationSnapshot> {
    return runWithWorkspace(input.workspaceId, () => this.serialize(input.workspaceId, input.runId, async () => {
      const snapshot = this.store.acceptOrchestrationReviewOutcome({
        runId: input.runId,
        taskId: input.taskId,
        attemptId: input.attemptId,
        expectedTaskRevision: input.expectedTaskRevision,
        expectedPlanVersion: input.expectedPlanVersion,
        acceptedBy: input.acceptedBy,
        evidence: input.evidence,
        plan: input.amendment.plan,
        addedTasks: input.amendment.addedTasks,
        findings: input.amendment.findings,
        now: input.now
      });
      return input.dispatchNext === false
        ? snapshot
        : this.dispatchNextUnlocked(snapshot, input.acceptedBy, undefined, input.now);
    }));
  }

  async retryTask(input: {
    workspaceId: string;
    runId: string;
    taskId: string;
    expectedTaskRevision: number;
    actorId: string;
    startingCommit?: string;
    now?: string;
  }): Promise<OrchestrationSnapshot> {
    return runWithWorkspace(input.workspaceId, () => this.serialize(input.workspaceId, input.runId, async () => {
      let snapshot = this.store.getOrchestrationSnapshot(input.runId);
      if (!snapshot) throw new Error('Orchestration run not found.');
      if (!['executing', 'blocked'].includes(snapshot.run.status)) {
        throw new Error(snapshot.run.status === 'recovery_required'
          ? 'Review the preserved attempt and use Resume before retrying an interrupted task.'
          : 'This build is not in a retryable state. Refresh the workflow before trying again.');
      }
      const task = snapshot.tasks.find(item => item.id === input.taskId);
      if (!task) throw new Error('Orchestration task not found.');
      if (!['failed', 'blocked'].includes(task.status)) throw new Error('Only a failed or blocked task can be retried.');
      if (task.attemptCount >= 2) throw new Error('This task reached its two-attempt limit and needs a plan amendment or human decision.');
      snapshot = this.store.transitionOrchestrationTask({
        runId: input.runId,
        taskId: input.taskId,
        expectedRevision: input.expectedTaskRevision,
        nextStatus: 'ready',
        actorId: input.actorId,
        reason: 'Authorized retry requested.',
        now: input.now
      });
      if (snapshot.run.status === 'blocked') {
        snapshot = this.store.transitionOrchestrationRun({
          runId: input.runId,
          expectedRevision: snapshot.run.revision,
          nextStatus: 'executing',
          actorId: input.actorId,
          now: input.now
        });
      }
      return this.dispatchNextUnlocked(snapshot, input.actorId, input.startingCommit, input.now);
    }));
  }

  async resume(input: {
    workspaceId: string;
    runId: string;
    actorId?: string;
    now?: string;
  }): Promise<OrchestrationSnapshot> {
    return runWithWorkspace(input.workspaceId, () => this.serialize(input.workspaceId, input.runId, async () => {
      const snapshot = this.store.getOrchestrationSnapshot(input.runId);
      if (!snapshot) throw new Error('Orchestration run not found.');
      if (snapshot.run.currentTaskId || !['executing', 'blocked', 'recovery_required'].includes(snapshot.run.status)) return snapshot;
      let ready = snapshot;
      if (snapshot.run.status === 'recovery_required') {
        const interruptedTasks = snapshot.tasks.filter(task => task.status === 'blocked' &&
          snapshot.attempts.some(attempt => attempt.taskId === task.id && attempt.status === 'recovery_required'));
        if (interruptedTasks.length > 1) {
          throw new Error('More than one interrupted task needs reconciliation. Review the workflow before resuming.');
        }
        const interruptedTask = interruptedTasks[0];
        if (interruptedTask && interruptedTask.attemptCount >= 2) {
          throw new Error('The interrupted task reached its two-attempt limit. Create a reviewed plan amendment before continuing.');
        }
        if (interruptedTask) {
          const interruptedAttempt = [...ready.attempts].reverse().find(attempt =>
            attempt.taskId === interruptedTask.id && attempt.status === 'recovery_required');
          if (!interruptedAttempt) throw new Error('The interrupted task has no recoverable attempt record. Review the workflow before resuming.');
          ready = this.store.settleOrchestrationRecoveryAttempt({
            runId: input.runId, taskId: interruptedTask.id, attemptId: interruptedAttempt.id,
            actorId: input.actorId ?? 'orchestrator',
            reason: 'The saved checkpoint was reviewed; this interrupted attempt is preserved as failed before a controlled retry.',
            now: input.now
          });
          ready = this.store.transitionOrchestrationTask({
            runId: input.runId, taskId: interruptedTask.id, expectedRevision: interruptedTask.revision,
            nextStatus: 'ready', actorId: input.actorId ?? 'orchestrator',
            reason: 'The saved branch was reviewed and the interrupted task is being retried.', now: input.now
          });
        }
      }
      if (ready.run.status !== 'executing') {
        ready = this.store.transitionOrchestrationRun({
          runId: input.runId, expectedRevision: ready.run.revision, nextStatus: 'executing',
          actorId: input.actorId ?? 'orchestrator', now: input.now
        });
      }
      return this.dispatchNextUnlocked(ready, input.actorId ?? 'orchestrator', undefined, input.now);
    }));
  }

  async pauseScheduling(input: {
    workspaceId: string;
    runId: string;
    actorId?: string;
    reason: string;
    now?: string;
  }): Promise<OrchestrationSnapshot> {
    return runWithWorkspace(input.workspaceId, () => this.serialize(input.workspaceId, input.runId, async () => {
      const snapshot = this.store.getOrchestrationSnapshot(input.runId);
      if (!snapshot) throw new Error('Orchestration run not found.');
      if (snapshot.run.status !== 'executing' || snapshot.run.currentTaskId) return snapshot;
      return this.store.transitionOrchestrationRun({
        runId: input.runId, expectedRevision: snapshot.run.revision, nextStatus: 'blocked',
        actorId: input.actorId ?? 'orchestrator', reason: input.reason, now: input.now
      });
    }));
  }

  async cancelRun(input: {
    workspaceId: string;
    runId: string;
    actorId: string;
    reason?: string;
    now?: string;
  }): Promise<OrchestrationSnapshot> {
    return runWithWorkspace(input.workspaceId, () => this.serialize(input.workspaceId, input.runId, async () => {
      let snapshot = this.store.getOrchestrationSnapshot(input.runId);
      if (!snapshot) throw new Error('Orchestration run not found.');
      if (['completed', 'failed', 'cancelled'].includes(snapshot.run.status)) return snapshot;
      if (snapshot.run.status === 'publishing') {
        throw new Error('This build has been approved and is reconciling its pull request. Wait for publication or retry it; cancellation cannot safely undo a remote change.');
      }
      const currentTask = snapshot.run.currentTaskId
        ? snapshot.tasks.find(task => task.id === snapshot!.run.currentTaskId)
        : undefined;
      const activeAttempt = currentTask
        ? [...snapshot.attempts].reverse().find(attempt =>
          attempt.taskId === currentTask.id && ['starting', 'running'].includes(attempt.status))
        : undefined;
      if (activeAttempt?.prototypeRunId) {
        if (!this.executor.cancel) {
          throw new Error('The configured task runner cannot confirm that an active specialist has stopped. The build remains unchanged.');
        }
        if (snapshot.run.status !== 'cancelling') {
          snapshot = this.store.transitionOrchestrationRun({
            runId: input.runId,
            expectedRevision: snapshot.run.revision,
            nextStatus: 'cancelling',
            actorId: input.actorId,
            reason: input.reason ?? 'Stop requested. Waiting for the specialist process to exit.',
            now: input.now
          });
        }
        await this.executor.cancel(activeAttempt.prototypeRunId);
        snapshot = this.store.getOrchestrationSnapshot(input.runId)!;
        if (snapshot.run.status === 'cancelled') return snapshot;
      }
      return this.store.cancelOrchestrationRun({
        runId: input.runId,
        actorId: input.actorId,
        reason: input.reason,
        now: input.now
      });
    }));
  }

  async handleRunnerCompleted(run: PrototypeRun): Promise<OrchestrationSnapshot | undefined> {
    if (run.status !== 'completed' || !run.workspaceId || !run.orchestrationRunId || !run.orchestrationTaskId || !run.orchestrationAttemptId) return undefined;
    return runWithWorkspace(run.workspaceId, () => this.serialize(run.workspaceId!, run.orchestrationRunId!, async () => {
      const snapshot = this.store.getOrchestrationSnapshot(run.orchestrationRunId!);
      const task = snapshot?.tasks.find(item => item.id === run.orchestrationTaskId);
      const attempt = snapshot?.attempts.find(item => item.id === run.orchestrationAttemptId);
      if (!snapshot || !task || !attempt) return snapshot;
      if (snapshot.run.status === 'cancelling' && snapshot.run.currentTaskId === task.id &&
          attempt.status === 'running' && attempt.prototypeRunId === run.id) {
        return this.store.cancelOrchestrationRun({
          runId: snapshot.run.id,
          actorId: 'orchestrator',
          reason: snapshot.run.stoppedReason ?? 'The specialist finished settling after the stop request.'
        });
      }
      if (snapshot.run.status !== 'executing' || snapshot.run.currentTaskId !== task.id ||
          attempt.status !== 'running' || attempt.prototypeRunId !== run.id) return snapshot;

      const resultCommit = run.checkpointCommit;
      if (!resultCommit || !/^[a-f0-9]{40,64}$/i.test(resultCommit)) {
        return this.failActiveAttempt(snapshot, task.id, attempt.id,
          'The runner reported completion without a verifiable checkpoint commit. Preserve the worktree and reconcile it before retrying.');
      }
      const rawSummary = [...(run.activities ?? [])].reverse()
        .find(activity => activity.kind === 'assistant' && !activity.isStreaming)?.message
        ?? [...(run.activities ?? [])].reverse().find(activity => activity.kind === 'summary')?.message
        ?? 'The runner completed without a structured specialist summary.';
      const agentReport = parseAgentReport(rawSummary);
      const agentSummary = typeof agentReport.report?.summary === 'string' ? agentReport.report.summary : rawSummary;
      const verificationStage = run.stages.find(stage => stage.id === 'tests');
      return this.store.submitOrchestrationAttempt({
        runId: snapshot.run.id,
        taskId: task.id,
        attemptId: attempt.id,
        expectedTaskRevision: task.revision,
        resultCommit,
        actorId: 'orchestrator',
        result: {
          resultSchemaVersion: 1,
          summary: agentSummary.slice(0, 4_000),
          prototypeRunId: run.id,
          branchName: run.branchName,
          agentReport: agentReport.report ?? null,
          agentReportError: agentReport.error,
          changedFiles: run.changedFiles ?? 0,
          insertions: run.insertions ?? 0,
          deletions: run.deletions ?? 0,
          verification: {
            stageStatus: verificationStage?.status ?? 'unavailable',
            observed: run.verificationEvidence ?? null,
            observedSummary: run.testSummary ?? null
          }
        }
      });
    }));
  }

  async handleRunnerFailed(run: PrototypeRun): Promise<OrchestrationSnapshot | undefined> {
    if (!run.workspaceId || !run.orchestrationRunId || !run.orchestrationTaskId || !run.orchestrationAttemptId) return undefined;
    return runWithWorkspace(run.workspaceId, () => this.serialize(run.workspaceId!, run.orchestrationRunId!, async () => {
      const snapshot = this.store.getOrchestrationSnapshot(run.orchestrationRunId!);
      const task = snapshot?.tasks.find(item => item.id === run.orchestrationTaskId);
      const attempt = snapshot?.attempts.find(item => item.id === run.orchestrationAttemptId);
      if (!snapshot || !task || !attempt) return snapshot;
      if (snapshot.run.status === 'cancelling' && snapshot.run.currentTaskId === task.id &&
          attempt.status === 'running' && attempt.prototypeRunId === run.id) {
        return this.store.cancelOrchestrationRun({
          runId: snapshot.run.id,
          actorId: 'orchestrator',
          reason: snapshot.run.stoppedReason ?? 'The specialist finished settling after the stop request.'
        });
      }
      if (snapshot.run.status !== 'executing' || snapshot.run.currentTaskId !== task.id ||
          attempt.status !== 'running' || attempt.prototypeRunId !== run.id) return snapshot;
      const failedStage = run.stages.find(stage => stage.status === 'failed');
      const reason = failedStage?.logs.slice(-3).join('\n').slice(0, 2_000)
        || run.testSummary
        || 'The specialist runner failed before submitting a result.';
      return this.failActiveAttempt(snapshot, task.id, attempt.id, reason);
    }));
  }

  async handleRunnerCancelled(run: PrototypeRun): Promise<OrchestrationSnapshot | undefined> {
    if (!run.workspaceId || !run.orchestrationRunId || !run.orchestrationTaskId || !run.orchestrationAttemptId) return undefined;
    return runWithWorkspace(run.workspaceId, () => this.serialize(run.workspaceId!, run.orchestrationRunId!, async () => {
      const snapshot = this.store.getOrchestrationSnapshot(run.orchestrationRunId!);
      const task = snapshot?.tasks.find(item => item.id === run.orchestrationTaskId);
      const attempt = snapshot?.attempts.find(item => item.id === run.orchestrationAttemptId);
      if (!snapshot || !task || !attempt) return snapshot;
      if (snapshot.run.status === 'cancelling' && snapshot.run.currentTaskId === task.id &&
          attempt.status === 'running' && attempt.prototypeRunId === run.id) {
        return this.store.cancelOrchestrationRun({
          runId: snapshot.run.id,
          actorId: 'orchestrator',
          reason: snapshot.run.stoppedReason ?? 'The specialist process stopped after a cancellation request.'
        });
      }
      if (snapshot.run.status !== 'executing' || snapshot.run.currentTaskId !== task.id ||
          attempt.status !== 'running' || attempt.prototypeRunId !== run.id) return snapshot;
      return this.store.cancelOrchestrationAttempt({
        runId: snapshot.run.id,
        taskId: task.id,
        attemptId: attempt.id,
        expectedTaskRevision: task.revision,
        actorId: 'orchestrator',
        reason: 'Specialist runner was cancelled. Partial work is preserved for reconciliation.'
      });
    }));
  }

  private failActiveAttempt(
    snapshot: OrchestrationSnapshot,
    taskId: string,
    attemptId: string,
    reason: string
  ): OrchestrationSnapshot {
    const task = snapshot.tasks.find(item => item.id === taskId)!;
    const failed = this.store.failOrchestrationAttempt({
      runId: snapshot.run.id,
      taskId,
      attemptId,
      expectedTaskRevision: task.revision,
      reason,
      actorId: 'orchestrator'
    });
    if (failed.run.status !== 'executing') return failed;
    return this.store.transitionOrchestrationRun({
      runId: failed.run.id,
      expectedRevision: failed.run.revision,
      nextStatus: 'blocked',
      actorId: 'orchestrator',
      reason: 'Specialist execution failed; review the preserved result before retrying.'
    });
  }

  private async dispatchNextUnlocked(
    snapshot: OrchestrationSnapshot,
    actorId: string,
    startingCommit?: string,
    now?: string
  ): Promise<OrchestrationSnapshot> {
    if (snapshot.run.status !== 'executing' || snapshot.run.currentTaskId) return snapshot;
    const next = selectNextReadyTask(snapshot.run.plan, snapshot.tasks);
    if (!next) return this.closeSchedulingWindow(snapshot, actorId, now);

    const attemptId = `attempt-${randomUUID()}`;
    const contextManifest = this.createFixtureManifest(snapshot, next.id);
    let baseRequest: OrchestrationLaunchRequest;
    let prepared: PreparedOrchestrationTask = {};
    try {
      const taskPackage = await this.createTaskPackage(snapshot, next.id);
      baseRequest = {
        runId: snapshot.run.id,
        workspaceId: snapshot.run.workspaceId,
        projectId: snapshot.run.projectId,
        issueId: snapshot.run.issueId,
        repository: snapshot.run.repository,
        planVersion: snapshot.run.planVersion,
        branchName: snapshot.run.branchName,
        workingDir: snapshot.run.worktreePath,
        baseRef: snapshot.run.baseRef,
        baseCommit: snapshot.run.baseCommit,
        taskId: next.id,
        taskTitle: next.title,
        taskDescription: next.description,
        taskKind: next.kind,
        ownerAgentId: next.ownerAgentId,
        attemptId,
        attemptNumber: next.attemptCount + 1,
        taskPackage,
        contextManifest
      };
      prepared = await this.executor.prepare?.(baseRequest) ?? {};
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'The task workspace or persona could not be prepared.';
      let blocked = this.store.transitionOrchestrationTask({
        runId: snapshot.run.id,
        taskId: next.id,
        expectedRevision: next.revision,
        nextStatus: 'blocked',
        actorId,
        reason,
        now
      });
      if (blocked.run.status === 'executing') {
        blocked = this.store.transitionOrchestrationRun({
          runId: blocked.run.id,
          expectedRevision: blocked.run.revision,
          nextStatus: 'blocked',
          actorId,
          reason,
          now
        });
      }
      return blocked;
    }
    const finalContextManifest = {
      ...contextManifest,
      ...(prepared.contextManifest ?? {})
    };
    if (prepared.branchName && prepared.workingDir && prepared.baseRef && prepared.startingCommit) {
      this.store.bindOrchestrationWorkspace({
        runId: snapshot.run.id,
        branchName: prepared.branchName,
        baseRef: prepared.baseRef,
        baseCommit: prepared.startingCommit,
        worktreePath: prepared.workingDir,
        actorId
      });
    }
    const started = this.store.startOrchestrationAttempt({
      runId: snapshot.run.id,
      taskId: next.id,
      expectedTaskRevision: next.revision,
      attemptId,
      startingCommit: prepared.startingCommit ?? startingCommit,
      personaHash: prepared.personaHash,
      modelProvider: prepared.modelProvider,
      modelName: prepared.modelName,
      contextManifest: finalContextManifest,
      actorId,
      now
    });
    const attempt = started.attempts.find(item => item.id === attemptId);
    if (!attempt) throw new Error('The specialist attempt could not be read after it was persisted.');

    const launch: OrchestrationLaunchRequest = {
      ...baseRequest,
      runId: started.run.id,
      attemptNumber: attempt.attemptNumber,
      contextManifest: finalContextManifest,
      branchName: prepared.branchName,
      workingDir: prepared.workingDir,
      baseRef: prepared.baseRef,
      personaHash: prepared.personaHash,
      modelProvider: prepared.modelProvider,
      modelName: prepared.modelName
    };
    try {
      const receipt = await this.executor.launch(launch);
      return runWithWorkspace(started.run.workspaceId, () => {
        return this.store.bindOrchestrationAttempt({
          runId: started.run.id,
          attemptId,
          prototypeRunId: receipt.prototypeRunId,
          actorId
        });
      });
    } catch (error) {
      return runWithWorkspace(started.run.workspaceId, () => {
        const current = this.store.getOrchestrationSnapshot(started.run.id);
        const currentTask = current?.tasks.find(item => item.id === next.id);
        const active = current?.attempts.find(item => item.id === attemptId);
        if (!current) throw new Error('Orchestration run disappeared while its task launch was being reconciled.');
        if (!currentTask || !active || !['starting', 'running'].includes(active.status)) return current;
        const failed = this.store.failOrchestrationAttempt({
          runId: started.run.id,
          taskId: next.id,
          attemptId,
          expectedTaskRevision: currentTask.revision,
          reason: error instanceof Error ? error.message : 'The executor failed to start the task.',
          actorId
        });
        if (failed.run.status === 'executing') {
          return this.store.transitionOrchestrationRun({
            runId: failed.run.id,
            expectedRevision: failed.run.revision,
            nextStatus: 'blocked',
            actorId,
            reason: 'Specialist launch failed; retry or adjust the plan.',
          });
        }
        return failed;
      });
    }
  }

  private closeSchedulingWindow(snapshot: OrchestrationSnapshot, actorId: string, now?: string): OrchestrationSnapshot {
    if (!allRequiredTasksAccepted(snapshot.tasks)) {
      return this.store.transitionOrchestrationRun({
        runId: snapshot.run.id,
        expectedRevision: snapshot.run.revision,
        nextStatus: 'blocked',
        actorId,
        reason: 'No eligible task can run, but required work remains unresolved.',
        now
      });
    }

    let current = snapshot;
    for (const task of current.tasks) {
      if (task.required || !['pending', 'ready', 'failed', 'blocked'].includes(task.status)) continue;
      current = this.store.transitionOrchestrationTask({
        runId: current.run.id,
        taskId: task.id,
        expectedRevision: task.revision,
        nextStatus: 'superseded',
        actorId,
        reason: 'Optional task omitted after all required work was accepted.',
        now
      });
    }
    return this.store.transitionOrchestrationRun({
      runId: current.run.id,
      expectedRevision: current.run.revision,
      nextStatus: 'validating',
      actorId,
      now
    });
  }

  private createFixtureManifest(snapshot: OrchestrationSnapshot, taskId: string): Record<string, unknown> {
    const task = snapshot.tasks.find(item => item.id === taskId)!;
    const acceptedDependencies = snapshot.tasks
      .filter(item => task.dependsOn.includes(item.id) && item.status === 'accepted')
      .map(item => ({ taskId: item.id, revision: item.acceptedRevision ?? item.revision }));
    return {
      manifestVersion: 1,
      runId: snapshot.run.id,
      planVersion: snapshot.run.planVersion,
      taskId,
      ownerAgentId: task.ownerAgentId,
      requirementIds: task.requirementIds,
      acceptedDependencies
    };
  }

  private async createTaskPackage(snapshot: OrchestrationSnapshot, taskId: string): Promise<OrchestrationTaskPackage> {
    const task = snapshot.tasks.find(item => item.id === taskId)!;
    const requirementIds = new Set(task.requirementIds);
    const acceptedDependencies = snapshot.tasks
      .filter(item => task.dependsOn.includes(item.id) && item.status === 'accepted')
      .map(item => {
        const acceptedAttempt = [...snapshot.attempts]
          .reverse()
          .find(attempt => attempt.taskId === item.id && attempt.status === 'accepted');
        const result = acceptedAttempt?.result ?? {};
        const summary = typeof result.summary === 'string' ? result.summary.slice(0, 2_000) : 'Accepted; no summary was submitted.';
        return {
          taskId: item.id,
          ownerAgentId: item.ownerAgentId,
          summary,
          resultCommit: acceptedAttempt?.resultCommit
        };
      });
    const reviewInputs = task.kind === 'review'
      ? await this.createReviewInputs(snapshot, task)
      : [];
    const taskPackage: OrchestrationTaskPackage = {
      packageVersion: 2,
      goal: snapshot.run.plan.goal,
      exclusions: snapshot.run.plan.exclusions,
      task: {
        id: task.id,
        title: task.title,
        kind: task.kind,
        description: task.description,
        acceptanceCriteria: task.acceptanceCriteria,
        requiredChecks: task.requiredChecks,
        scope: task.scope
      },
      requirements: snapshot.run.plan.requirements.filter(requirement => requirementIds.has(requirement.id)),
      acceptedDependencies,
      reviewInputs,
      corrections: snapshot.findings
        .filter(finding => finding.correctionTaskId === taskId && finding.status === 'open')
        .map(finding => {
          const evidence = finding.evidence;
          const instruction = typeof evidence.instruction === 'string' ? evidence.instruction
            : typeof evidence.message === 'string' ? evidence.message
              : typeof evidence.reason === 'string' ? evidence.reason
                : 'Resolve the recorded acceptance finding and provide evidence.';
          return `[finding:${finding.id}] ${instruction.slice(0, 2_000)}`;
        }),
      findingIds: snapshot.findings
        .filter(finding => finding.correctionTaskId === taskId && finding.status === 'open')
        .map(finding => finding.id)
    };
    if (task.kind === 'review' && Buffer.byteLength(JSON.stringify(taskPackage), 'utf8') > MAX_REVIEW_CONTEXT_BYTES) {
      throw new Error(`The independent review package exceeds Alpha’s ${MAX_REVIEW_CONTEXT_BYTES / 1024} KiB context limit. Split the work into smaller tasks or request human review.`);
    }
    return taskPackage;
  }

  private async createReviewInputs(
    snapshot: OrchestrationSnapshot,
    reviewTask: OrchestrationSnapshot['tasks'][number]
  ): Promise<OrchestrationTaskPackage['reviewInputs']> {
    const taskById = new Map(snapshot.tasks.map(item => [item.id, item]));
    const ancestors = new Set<string>();
    const visit = (taskId: string) => {
      for (const dependencyId of taskById.get(taskId)?.dependsOn ?? []) {
        if (ancestors.has(dependencyId)) continue;
        ancestors.add(dependencyId);
        visit(dependencyId);
      }
    };
    visit(reviewTask.id);

    const codeTasks = new Map<string, OrchestrationSnapshot['tasks'][number]>();
    for (const ancestorId of ancestors) {
      const candidate = taskById.get(ancestorId);
      if (!candidate || candidate.status !== 'accepted' || !['database', 'backend', 'frontend', 'mobile'].includes(candidate.kind)) continue;
      codeTasks.set(candidate.id, candidate);
      if (candidate.correctionOfTaskId) {
        const root = taskById.get(candidate.correctionOfTaskId);
        if (root?.status === 'accepted') codeTasks.set(root.id, root);
      }
    }

    const worktree = snapshot.run.worktreePath;
    if (!codeTasks.size) return [];
    if (!worktree) throw new Error('The independent reviewer has no authorized orchestration worktree. Preserve the build and use human review.');

    const results: OrchestrationTaskPackage['reviewInputs'] = [];
    let totalBytes = 0;
    for (const codeTask of codeTasks.values()) {
      const attempt = [...snapshot.attempts].reverse().find(item => item.taskId === codeTask.id && item.status === 'accepted');
      if (!attempt?.startingCommit || !attempt.resultCommit) {
        throw new Error(`Accepted task ${codeTask.id} is missing its immutable diff commits. Preserve the build and use human review.`);
      }
      const [diff, changedPaths] = await Promise.all([
        getGitDiffPatch(worktree, attempt.startingCommit, attempt.resultCommit),
        getGitChangedPaths(worktree, attempt.startingCommit, attempt.resultCommit)
      ]);
      totalBytes += Buffer.byteLength(diff, 'utf8');
      if (totalBytes > MAX_REVIEW_CONTEXT_BYTES) {
        throw new Error(`The independent review needs more than ${MAX_REVIEW_CONTEXT_BYTES / 1024} KiB of accepted code changes. Split the work into smaller tasks or request human review.`);
      }
      const relatedFindings = snapshot.findings
        .filter(finding => finding.status === 'open' && finding.correctionTaskId === codeTask.id)
        .map(finding => ({
          findingId: finding.id,
          title: typeof finding.evidence.title === 'string' ? finding.evidence.title.slice(0, 180) : 'Review finding',
          severity: finding.severity,
          path: finding.path,
          evidence: typeof finding.evidence.evidence === 'string' ? finding.evidence.evidence.slice(0, 350) : 'No evidence text was recorded.',
          instruction: typeof finding.evidence.instruction === 'string' ? finding.evidence.instruction.slice(0, 450) : 'Recheck the recorded issue.'
        }));
      const diffHash = createHash('sha256').update(diff).digest('hex');
      results.push({
        taskId: codeTask.id,
        title: codeTask.title,
        ownerAgentId: codeTask.ownerAgentId,
        startingCommit: attempt.startingCommit,
        resultCommit: attempt.resultCommit,
        changedPaths,
        diff,
        diffHash,
        relatedFindings
      });
    }
    return results;
  }

  private serialize<T>(workspaceId: string, runId: string, action: () => Promise<T>): Promise<T> {
    const key = `${workspaceId}:${runId}`;
    const previous = this.transitionQueues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(action);
    this.transitionQueues.set(key, current);
    void current.then(
      () => { if (this.transitionQueues.get(key) === current) this.transitionQueues.delete(key); },
      () => { if (this.transitionQueues.get(key) === current) this.transitionQueues.delete(key); }
    );
    return current;
  }
}

export function orchestrationRequestFingerprint(input: {
  workspaceId: string;
  projectId: string;
  issueId: string;
  repository: string;
  createdBy: string;
  originalRequest: string;
}): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}
