import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Agent, PrototypeRun } from '../models/index.js';
import {
  ORCHESTRATION_AGENT_REPORT_SCHEMA_VERSION,
  MAX_INITIAL_PLAN_TASKS,
  ensureTaskAssignmentReasons,
  parseOrchestrationPlan,
  validateOrchestrationPlan,
  type OrchestrationRequiredCheck,
  type OrchestrationTaskKind
} from './orchestrationContract.js';
import { parseAgentReport } from './orchestrationAgentReport.js';
export { parseAgentReport } from './orchestrationAgentReport.js';
import { initialTaskRecords, selectNextReadyTask, allRequiredTasksAccepted, type OrchestrationSnapshot } from './orchestrationStateMachine.js';
import { SQLiteService } from './sqliteService.js';
import { runWithWorkspace } from './workspaceContext.js';
import type { OrchestrationReviewAmendment } from './orchestrationReviewWorkflow.js';
import { getCurrentBranch, getGitChangedPaths, getGitDiffPatch, getGitTrackedPaths, getHeadCommit, isGitRepo, isGitWorkingTreeClean } from '../utils/gitUtils.js';
import { pathMatchesScope } from '../utils/pathScope.js';
import { assertOrchestrationApprovalCheckpointCurrent, getOrchestrationFinalValidationEvidence } from './orchestrationReviewService.js';
import { OrchestrationPublicationService } from './orchestrationPublication.js';
import { repositoryWorkspaceForTask } from './orchestrationWorkspace.js';
import {
  ALPHA_ORCHESTRATION_MAX_BUILD_AGE_MS,
  ALPHA_ORCHESTRATION_MAX_COST_USD,
  ALPHA_ORCHESTRATION_MAX_TOKENS
} from '../config/env.js';
import { AUTO_REPAIR_ATTEMPT_LIMIT, MAX_REPAIR_ATTEMPTS_PER_EPISODE, MAX_RECOVERY_GUIDANCE_CHARS, MAX_REPORT_FORMAT_CORRECTIONS, hasRepeatedRecoveryFailure, reportFormatCorrectionCount, safeRecoveryGuidance, workAttemptCount } from './orchestrationRecoveryPolicy.js';

const MAX_REVIEW_CONTEXT_BYTES = 64 * 1024;
const MAX_REVIEW_SOURCE_FILES = 12;
const MAX_REVIEW_SOURCE_FILE_BYTES = 16 * 1024;
const REVIEW_SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]sx?|vue|svelte|html?|css|scss|less|json|md|ya?ml)$/i;
const SENSITIVE_REVIEW_PATH = /(?:^|\/)(?:\.env(?:\.|$)|secrets?(?:\/|\.|$)|credentials?(?:\/|\.|$)|private[-_]?key|id_rsa|id_ed25519)/i;
const CODE_TASK_KINDS = new Set<OrchestrationTaskKind>(['database', 'backend', 'frontend', 'mobile']);
const NON_REPAIRABLE_AGENT_FAILURE = /\b(?:provider|429|rate.?limit|quota|network|connection|timed? ?out|credential|authentication|permission|access denied|eacces|eperm|enoent|eio|worktree|working tree|branch|checkpoint|workspace|runtime|not ready|executable|spawn|disk full|enospc|read.only file system|no such file or directory)\b/i;

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
  packageVersion: 6;
  reportSchemaVersion: number;
  goal: string;
  projectContext: string;
  exclusions: string[];
  task: {
    id: string;
    title: string;
    kind: OrchestrationTaskKind;
    repository: string;
    description: string;
    acceptanceCriteria: string[];
    requiredChecks: OrchestrationRequiredCheck[];
    scope: { includePaths: string[]; excludePaths: string[] };
  };
  requirements: Array<{ id: string; description: string }>;
  acceptedDependencies: Array<{
    taskId: string;
    taskKind: OrchestrationTaskKind;
    ownerAgentId: string;
    acceptedRevision: number;
    summary: string;
    resultCommit?: string;
    resultArtifactHash?: string;
    requirementCoverage: Array<{ requirementId: string; evidence: string }>;
    deliverables: Array<{ summary: string; paths: string[] }>;
    verificationStatus: 'passed' | 'failed' | 'skipped' | 'cancelled' | 'not_recorded';
    missingScripts: string[];
    observedChecks: Array<{ script: string; result: 'passed' | 'failed' | 'not_run' }>;
    changedPaths: string[];
  }>;
  reviewInputs: Array<{
    taskId: string;
    title: string;
    repository: string;
    ownerAgentId: string;
    startingCommit: string;
    resultCommit: string;
    changedPaths: string[];
    diff: string;
    diffHash: string;
    sourceFiles?: Array<{ path: string; content: string; contentHash: string }>;
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
  /** Explicit project-owner clarification for one bounded recovery retry. */
  developerGuidance?: string;
  /** Bounded, read-only retries used only to repair an invalid task report. */
  reportCorrection?: {
    validationErrors: string[];
    previousResponse: string;
    /** Original code-attempt base, retained so acceptance/review still inspect that patch. */
    startingCommit?: string;
  };
}

function taskExecutionAttemptCount(snapshot: OrchestrationSnapshot, taskId: string): number {
  return workAttemptCount(snapshot, taskId);
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
  repositoryWorkspaces?: OrchestrationSnapshot['run']['repositoryWorkspaces'];
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

/**
 * Deterministic, single-active-task orchestrator. It validates and saves a plan
 * first; a human starts the planned work before any specialist is dispatched.
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
            publicationBaseBranch: publicationTarget.publicationBaseBranch,
            publicationTargets: publicationTarget.publicationTargets
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

      const publications = await this.publication.publishAll(snapshot);
      const publication = publications.find(item => item.repository?.toLowerCase() === snapshot.run.repository.toLowerCase()) ?? publications[0];
      if (!publication) throw new Error('No codebase pull request was published.');
      const completed = this.store.transitionOrchestrationRun({
        runId: input.runId,
        expectedRevision: snapshot.run.revision,
        nextStatus: 'completed',
        actorId: input.actorId,
        now: input.now,
        evidence: {
          ...approval.payload.evidence as Record<string, unknown>,
          publication,
          publications
        }
      });
      await this.publication.synchronizePublishedIssue(completed);
      return this.store.getOrchestrationSnapshot(input.runId)!;
    }));
  }

  async start(input: StartOrchestrationInput): Promise<OrchestrationSnapshot> {
    return runWithWorkspace(input.workspaceId, async () => {
      const plan = ensureTaskAssignmentReasons(parseOrchestrationPlan(input.plan), input.eligibleAgents);
      const issues = validateOrchestrationPlan(plan, input.eligibleAgents, {
        maxTaskCount: MAX_INITIAL_PLAN_TASKS,
        initialPlan: true,
        repositories: input.repositoryWorkspaces?.map(item => item.repository)
      });
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
        repositoryWorkspaces: input.repositoryWorkspaces,
        createdAt: now,
        updatedAt: now
      }, initialTaskRecords(plan), input.planSource ?? 'template', input.planningOwnerSessionId);
      return this.store.transitionOrchestrationRun({
        runId: run.run.id,
        expectedRevision: run.run.revision,
        nextStatus: 'awaiting_plan_approval',
        actorId: input.createdBy,
        now,
        evidence: { decision: 'plan_ready_for_review', taskCount: plan.tasks.length, planVersion: run.run.planVersion }
      });
    });
  }

  /** Recheck the saved assignments and start only after an authorized user reviews the plan. */
  async startPlannedWork(input: {
    workspaceId: string;
    runId: string;
    expectedRevision: number;
    actorId: string;
    now?: string;
  }): Promise<OrchestrationSnapshot> {
    return runWithWorkspace(input.workspaceId, () => this.serialize(input.workspaceId, input.runId, async () => {
      const snapshot = this.store.getOrchestrationSnapshot(input.runId);
      if (!snapshot) throw new Error('Orchestration run not found.');
      if (snapshot.run.status === 'executing') {
        return snapshot.run.currentTaskId ? snapshot : this.dispatchNextUnlocked(snapshot, input.actorId, undefined, input.now);
      }
      if (snapshot.run.status !== 'awaiting_plan_approval') {
        throw new Error('This build plan is no longer waiting to start. Refresh the Live Build Room to see its current state.');
      }
      if (!Number.isSafeInteger(input.expectedRevision) || snapshot.run.revision !== input.expectedRevision) {
        throw new Error('The build plan changed after you opened it. Refresh the Live Build Room before starting work.');
      }
      const eligibleAgents = this.store.getAgents().filter(agent => !agent.isArchived);
      if (eligibleAgents.length) {
        const issues = validateOrchestrationPlan(snapshot.run.plan, eligibleAgents, {
          maxTaskCount: MAX_INITIAL_PLAN_TASKS,
          initialPlan: true,
          repositories: snapshot.run.repositoryWorkspaces?.map(item => item.repository)
        });
        if (issues.length) throw new OrchestrationPlanError(issues);
      }
      const executing = this.store.transitionOrchestrationRun({
        runId: input.runId,
        expectedRevision: snapshot.run.revision,
        nextStatus: 'executing',
        actorId: input.actorId,
        now: input.now,
        evidence: { decision: 'plan_approved', approvedBy: input.actorId, approvedAt: input.now ?? new Date().toISOString() }
      });
      return this.dispatchNextUnlocked(executing, input.actorId, undefined, input.now);
    }));
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
    canonicalReport?: Record<string, unknown>;
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
    canonicalReport?: Record<string, unknown>;
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
        canonicalReport: input.canonicalReport,
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
    expectedRunRevision?: number;
    actorId: string;
    startingCommit?: string;
    reportCorrection?: { validationErrors: string[]; previousResponse: string; startingCommit?: string };
    developerGuidance?: string;
    now?: string;
  }): Promise<OrchestrationSnapshot> {
    return runWithWorkspace(input.workspaceId, () => this.serialize(input.workspaceId, input.runId, async () => {
      let snapshot = this.store.getOrchestrationSnapshot(input.runId);
      if (!snapshot) throw new Error('Orchestration run not found.');
      if (input.expectedRunRevision !== undefined && snapshot.run.revision !== input.expectedRunRevision) {
        throw new Error('The build changed since this recovery was opened. Refresh before retrying.');
      }
      if (!['executing', 'blocked'].includes(snapshot.run.status)) {
        throw new Error(snapshot.run.status === 'recovery_required'
          ? 'Review the preserved attempt and use Resume before retrying an interrupted task.'
          : 'This build is not in a retryable state. Refresh the workflow before trying again.');
      }
      const task = snapshot.tasks.find(item => item.id === input.taskId);
      if (!task) throw new Error('Orchestration task not found.');
      if (!['failed', 'blocked'].includes(task.status)) throw new Error('Only a failed or blocked task can be retried.');
      const executionAttempts = taskExecutionAttemptCount(snapshot, task.id);
      const developerGuidance = input.developerGuidance?.trim();
      if (developerGuidance && developerGuidance.length > MAX_RECOVERY_GUIDANCE_CHARS) {
        throw new Error(`Keep developer guidance under ${MAX_RECOVERY_GUIDANCE_CHARS.toLocaleString()} characters.`);
      }
      if (input.reportCorrection) {
        if (reportFormatCorrectionCount(snapshot, task.id) >= MAX_REPORT_FORMAT_CORRECTIONS) {
          throw new Error('Two automatic report-only corrections and one developer-authorized correction have already been used. Review the saved response and exact field error before starting a new build.');
        }
      } else if (executionAttempts >= MAX_REPAIR_ATTEMPTS_PER_EPISODE ||
          (executionAttempts >= AUTO_REPAIR_ATTEMPT_LIMIT && !developerGuidance)) {
        throw new Error(executionAttempts >= MAX_REPAIR_ATTEMPTS_PER_EPISODE
          ? 'This recovery reached its four-work-attempt limit. Review the saved changes before starting a fresh build.'
          : 'This task reached its automatic retry limit. Provide clear direction to authorize one bounded recovery retry.');
      }
      snapshot = this.store.transitionOrchestrationTask({
        runId: input.runId,
        taskId: input.taskId,
        expectedRevision: input.expectedTaskRevision,
        nextStatus: 'ready',
        actorId: input.actorId,
        reason: input.reportCorrection
          ? 'The same specialist is being asked to fix the report format only. No code changes or checks are requested.'
          : 'Authorized retry requested.',
        now: input.now
      });
      if (snapshot.run.status === 'blocked') {
        snapshot = this.store.transitionOrchestrationRun({
          runId: input.runId,
          expectedRevision: snapshot.run.revision,
          nextStatus: 'executing',
          actorId: input.actorId,
          clearStoppedReason: true,
          now: input.now
        });
      }
      return this.dispatchNextUnlocked(snapshot, input.actorId, input.startingCommit, input.now, input.reportCorrection, developerGuidance);
    }));
  }

  async resume(input: {
    workspaceId: string;
    runId: string;
    expectedRunRevision?: number;
    actorId?: string;
    now?: string;
  }): Promise<OrchestrationSnapshot> {
    return runWithWorkspace(input.workspaceId, () => this.serialize(input.workspaceId, input.runId, async () => {
      const snapshot = this.store.getOrchestrationSnapshot(input.runId);
      if (!snapshot) throw new Error('Orchestration run not found.');
      if (input.expectedRunRevision !== undefined && snapshot.run.revision !== input.expectedRunRevision) {
        throw new Error('The build changed since this recovery was opened. Refresh before resuming.');
      }
      if (snapshot.run.currentTaskId || !['executing', 'paused', 'blocked', 'recovery_required'].includes(snapshot.run.status)) return snapshot;
      let ready = snapshot;
      if (snapshot.run.status === 'recovery_required') {
        await this.assertRecoverableCheckpoint(snapshot);
        const interruptedTasks = snapshot.tasks.filter(task => task.status === 'blocked' &&
          snapshot.attempts.some(attempt => attempt.taskId === task.id && attempt.status === 'recovery_required'));
        if (interruptedTasks.length > 1) {
          throw new Error('More than one interrupted task needs reconciliation. Review the workflow before resuming.');
        }
        const interruptedTask = interruptedTasks[0];
        if (interruptedTask && taskExecutionAttemptCount(snapshot, interruptedTask.id) >= MAX_REPAIR_ATTEMPTS_PER_EPISODE) {
          throw new Error(`The interrupted task reached its ${MAX_REPAIR_ATTEMPTS_PER_EPISODE}-attempt limit. Review the saved changes before starting a fresh build.`);
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
          actorId: input.actorId ?? 'orchestrator', clearPauseRequest: true, clearStoppedReason: true, now: input.now
        });
      }
      return this.dispatchNextUnlocked(ready, input.actorId ?? 'orchestrator', undefined, input.now);
    }));
  }

  private async assertRecoverableCheckpoint(snapshot: OrchestrationSnapshot): Promise<void> {
    const interruptedTask = snapshot.tasks.find(task => task.status === 'blocked' &&
      snapshot.attempts.some(attempt => attempt.taskId === task.id && attempt.status === 'recovery_required'));
    const interruptedAttempt = interruptedTask && [...snapshot.attempts].reverse().find(attempt =>
      attempt.taskId === interruptedTask.id && attempt.status === 'recovery_required');
    if (interruptedAttempt) {
      if (!interruptedAttempt.prototypeRunId) {
        throw new Error('Alpha cannot confirm whether the interrupted specialist started. Review the saved work and process state before resuming.');
      }
      const prototypeRun = this.store.getPrototypeRuns().find(run => run.id === interruptedAttempt.prototypeRunId);
      if (!prototypeRun || ['queued', 'running', 'validating'].includes(prototypeRun.status)) {
        throw new Error('The previous specialist may still be active. Alpha will not start another writer until that process is confirmed stopped.');
      }
      if (prototypeRun.status === 'completed') {
        throw new Error('The interrupted specialist has a completed run that still needs result reconciliation. Refresh the build before retrying.');
      }
    }

    const workspaces = snapshot.run.repositoryWorkspaces?.length
      ? snapshot.run.repositoryWorkspaces
      : snapshot.run.worktreePath && snapshot.run.repository && snapshot.run.branchName && snapshot.run.baseRef && snapshot.run.baseCommit
        ? [{ repository: snapshot.run.repository, worktreePath: snapshot.run.worktreePath, branchName: snapshot.run.branchName, baseRef: snapshot.run.baseRef, baseCommit: snapshot.run.baseCommit }]
        : [];
    if (!workspaces.length) throw new Error('The saved build has no recorded private workspace. Review the saved work before resuming.');
    for (const workspace of workspaces) {
      const worktree = path.resolve(workspace.worktreePath);
      if (!fs.existsSync(worktree) || !(await isGitRepo(worktree))) {
        throw new Error(`The saved ${workspace.repository} worktree is missing or unreadable. Preserve it and reconcile the checkpoint before resuming.`);
      }
      const [branch, head, clean] = await Promise.all([
        getCurrentBranch(worktree), getHeadCommit(worktree), isGitWorkingTreeClean(worktree)
      ]);
      if (branch !== workspace.branchName) {
        throw new Error(`The saved ${workspace.repository} worktree is on branch ${branch}, but this build owns ${workspace.branchName}. Review the branch before resuming.`);
      }
      if (!clean) {
        throw new Error(`The saved ${workspace.repository} worktree contains uncheckpointed changes. Review or preserve them before resuming.`);
      }
      const latestAccepted = [...snapshot.attempts].reverse().find(attempt => {
        const task = snapshot.tasks.find(item => item.id === attempt.taskId);
        return attempt.status === 'accepted' && attempt.resultCommit && task &&
          (task.repository ?? snapshot.run.repository).toLowerCase() === workspace.repository.toLowerCase();
      });
      const expectedCommit = latestAccepted?.resultCommit ?? workspace.baseCommit;
      if (!expectedCommit || head !== expectedCommit) {
        throw new Error(`The saved ${workspace.repository} HEAD no longer matches its last accepted checkpoint. Preserve the current commit and reconcile it before resuming.`);
      }
    }
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

  async pauseRun(input: {
    workspaceId: string;
    runId: string;
    expectedRevision: number;
    actorId: string;
    now?: string;
  }): Promise<OrchestrationSnapshot> {
    return runWithWorkspace(input.workspaceId, () => this.serialize(input.workspaceId, input.runId, async () =>
      this.store.requestOrchestrationPause({
        runId: input.runId,
        expectedRevision: input.expectedRevision,
        actorId: input.actorId,
        now: input.now
      })
    ));
  }

  async cancelRun(input: {
    workspaceId: string;
    runId: string;
    expectedRevision?: number;
    actorId: string;
    reason?: string;
    now?: string;
  }): Promise<OrchestrationSnapshot> {
    return runWithWorkspace(input.workspaceId, () => this.serialize(input.workspaceId, input.runId, async () => {
      let snapshot = this.store.getOrchestrationSnapshot(input.runId);
      if (!snapshot) throw new Error('Orchestration run not found.');
      if (input.expectedRevision !== undefined && snapshot.run.revision !== input.expectedRevision) {
        throw new Error('The build changed since this recovery was opened. Refresh before cancelling.');
      }
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

  async retryFinalValidation(input: {
    workspaceId: string;
    runId: string;
    expectedRunRevision: number;
    actorId: string;
    now?: string;
  }): Promise<OrchestrationSnapshot> {
    return runWithWorkspace(input.workspaceId, () => this.serialize(input.workspaceId, input.runId, async () => {
      const snapshot = this.store.getOrchestrationSnapshot(input.runId);
      if (!snapshot) throw new Error('Orchestration run not found.');
      if (snapshot.run.revision !== input.expectedRunRevision) {
        throw new Error('The build changed since this recovery was opened. Refresh before rechecking.');
      }
      if (snapshot.run.status !== 'blocked' || snapshot.run.currentTaskId ||
          !snapshot.tasks.filter(task => task.required).every(task => task.status === 'accepted')) {
        throw new Error('Final checks can only be rechecked after all required tasks are accepted and the build is stopped at final validation.');
      }
      const validationEvent = this.store.listOrchestrationEvents(input.runId, 0, 500).slice().reverse()
        .find(event => ['run_blocked', 'run_recovery_required'].includes(event.type) &&
          event.payload.evidence && typeof event.payload.evidence === 'object' &&
          (event.payload.evidence as Record<string, unknown>).validationVersion === 1);
      if (!validationEvent) throw new Error('Alpha could not confirm that this blocker came from final validation. Review the saved changes before continuing.');
      const savedEvidence = validationEvent.payload.evidence as Record<string, unknown>;
      if (['workspace_checkpoint', 'final_scope', 'workspace_missing'].includes(String(savedEvidence.check ?? ''))) {
        throw new Error('This blocker needs workspace or scope reconciliation before final checks can be repeated. Review the saved branch and changed files first.');
      }
      return this.store.transitionOrchestrationRun({
        runId: input.runId,
        expectedRevision: snapshot.run.revision,
        nextStatus: 'validating',
        actorId: input.actorId,
        clearStoppedReason: true,
        reason: 'The developer requested a fresh run of the saved final checks.',
        now: input.now
      });
    }));
  }

  async amendFinalValidation(input: {
    workspaceId: string;
    runId: string;
    expectedRunRevision: number;
    actorId: string;
    amendment: OrchestrationReviewAmendment;
    evidence: Record<string, unknown>;
    now?: string;
  }): Promise<OrchestrationSnapshot> {
    return runWithWorkspace(input.workspaceId, () => this.serialize(input.workspaceId, input.runId, async () => {
      const snapshot = this.store.appendOrchestrationFinalValidationAmendment({
        runId: input.runId,
        expectedRunRevision: input.expectedRunRevision,
        expectedPlanVersion: this.store.getOrchestrationSnapshot(input.runId)?.run.planVersion ?? -1,
        actorId: input.actorId,
        evidence: input.evidence,
        plan: input.amendment.plan,
        addedTasks: input.amendment.addedTasks,
        findings: input.amendment.findings,
        now: input.now
      });
      return this.dispatchNextUnlocked(snapshot, input.actorId, undefined, input.now);
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
      const expectedReportSchemaVersion = typeof attempt.contextManifest.reportSchemaVersion === 'number'
        ? attempt.contextManifest.reportSchemaVersion
        : undefined;
      const agentReport = parseAgentReport(rawSummary, expectedReportSchemaVersion);
      const agentSummary = typeof agentReport.report?.summary === 'string'
        ? agentReport.report.summary
        : 'The specialist response did not match Alpha’s required task-report format.';
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
          agentReportSchemaVersionExpected: expectedReportSchemaVersion ?? ORCHESTRATION_AGENT_REPORT_SCHEMA_VERSION,
          agentReportSchemaVersionReceived: agentReport.schemaVersion,
          // Keep bounded raw output next to the canonical report so every
          // normalisation and correction remains auditable after restart.
          agentReportResponse: rawSummary.slice(0, 12_000),
          agentReportResponseTruncated: rawSummary.length > 12_000,
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
      const isVerificationFailure = failedStage?.id === 'tests'
        && (run.verificationEvidence?.status === 'failed' || /verification failed|could not prepare .*dependencies/i.test(run.testSummary ?? ''));
      const isRepairableImplementationFailure = failedStage?.id === 'implementation' && CODE_TASK_KINDS.has(task.kind) &&
        !NON_REPAIRABLE_AGENT_FAILURE.test(failedStage.logs.slice(-30).join('\n'));
      const verificationOutput = failedStage?.logs.slice(-30).join('\n').slice(-4_000);
      const reason = isVerificationFailure
        ? [run.testSummary || 'The repository verification check failed.', verificationOutput].filter(Boolean).join('\n')
        : failedStage?.logs.slice(-30).join('\n').slice(-4_000)
          || run.testSummary
          || 'The specialist runner failed before submitting a result.';
      return this.failActiveAttempt(snapshot, task.id, attempt.id, reason,
        (isVerificationFailure || isRepairableImplementationFailure) && CODE_TASK_KINDS.has(task.kind));
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

  private async failActiveAttempt(
    snapshot: OrchestrationSnapshot,
    taskId: string,
    attemptId: string,
    reason: string,
    autoRepairableFailure = false
  ): Promise<OrchestrationSnapshot> {
    const task = snapshot.tasks.find(item => item.id === taskId)!;
    const reportOnlyAttempt = snapshot.attempts.some(attempt => attempt.id === attemptId &&
      attempt.contextManifest.reportOnlyReportRetry === true);
    const shouldAutoRepairFailure = autoRepairableFailure && !reportOnlyAttempt;
    const pauseWasRequested = Boolean(snapshot.run.pauseRequestedAt);
    const failed = this.store.failOrchestrationAttempt({
      runId: snapshot.run.id,
      taskId,
      attemptId,
      expectedTaskRevision: task.revision,
      reason,
      actorId: 'orchestrator'
    });
    if (failed.run.status !== 'executing') return failed;
    const issue = reason.split(/\r?\n/, 1)[0].slice(0, 400);
    const attemptsUsed = taskExecutionAttemptCount(failed, taskId);
    const repeatedFailure = shouldAutoRepairFailure && hasRepeatedRecoveryFailure(failed, taskId, 'project_code', reason);
    const canAutomaticallyRepair = shouldAutoRepairFailure && !pauseWasRequested &&
      attemptsUsed < AUTO_REPAIR_ATTEMPT_LIMIT && !repeatedFailure;
    const repairAction = pauseWasRequested
      ? `The current specialist failed while a pause was pending. The work is preserved for review; inspect the failed checks before retrying.`
      : repeatedFailure
        ? `The same failure remained after a focused repair. Alpha stopped automatic retries early and saved the latest result. Provide direction before another bounded attempt.`
      : shouldAutoRepairFailure
      ? attemptsUsed >= AUTO_REPAIR_ATTEMPT_LIMIT
        ? `The Orchestrator reviewed the failure, but it remains after ${attemptsUsed} execution attempts. The two automatic repair attempts are used. Review the latest failure details, then provide a new direction or start a fresh build.`
        : `The Orchestrator reviewed the reported failure (${issue}) and assigned ${task.ownerAgentId} to make a focused repair. It will check the new result before handing work to another specialist.`
      : 'Specialist execution failed; Alpha preserved the work and error details for the developer to review in project chat.';
    const blocked = this.store.transitionOrchestrationRun({
      runId: failed.run.id,
      expectedRevision: failed.run.revision,
      nextStatus: 'blocked',
      actorId: 'orchestrator',
      reason: repairAction,
      clearPauseRequest: pauseWasRequested,
      evidence: repeatedFailure ? { recoveryVersion: 1, repeatedFailure: true, taskId } : undefined
    });
    if (pauseWasRequested) return blocked;
    const failedTask = blocked.tasks.find(candidate => candidate.id === taskId);
    if (!canAutomaticallyRepair || !failedTask) return blocked;

    return this.retryFailedTaskUnlocked(blocked, failedTask, reason);
  }

  private async retryFailedTaskUnlocked(
    snapshot: OrchestrationSnapshot,
    task: OrchestrationSnapshot['tasks'][number],
    failureReason: string
  ): Promise<OrchestrationSnapshot> {
    if (!['executing', 'blocked'].includes(snapshot.run.status) || !['failed', 'blocked'].includes(task.status) ||
        taskExecutionAttemptCount(snapshot, task.id) >= AUTO_REPAIR_ATTEMPT_LIMIT) {
      return snapshot;
    }
    let next = this.store.transitionOrchestrationTask({
      runId: snapshot.run.id,
      taskId: task.id,
      expectedRevision: task.revision,
      nextStatus: 'ready',
      actorId: 'orchestrator',
      reason: `The Orchestrator reviewed the failed checks and assigned ${task.ownerAgentId} to fix the reported problem.`,
    });
    if (next.run.status === 'blocked') {
      next = this.store.transitionOrchestrationRun({
        runId: next.run.id,
        expectedRevision: next.run.revision,
        nextStatus: 'executing',
        actorId: 'orchestrator',
        reason: `Repair assigned to ${task.ownerAgentId}: ${failureReason.slice(0, 500)}`
      });
    }
    return this.dispatchNextUnlocked(next, 'orchestrator');
  }

  private async dispatchNextUnlocked(
    snapshot: OrchestrationSnapshot,
    actorId: string,
    startingCommit?: string,
    now?: string,
    reportCorrection?: { validationErrors: string[]; previousResponse: string; startingCommit?: string },
    developerGuidance?: string
  ): Promise<OrchestrationSnapshot> {
    if (snapshot.run.status !== 'executing' || snapshot.run.currentTaskId) return snapshot;
    if (snapshot.run.pauseRequestedAt) {
      return this.store.transitionOrchestrationRun({
        runId: snapshot.run.id,
        expectedRevision: snapshot.run.revision,
        nextStatus: 'paused',
        actorId,
        reason: 'The current step is complete. The build is paused before the next specialist handoff.',
        clearPauseRequest: true,
        now
      });
    }
    const next = selectNextReadyTask(snapshot.run.plan, snapshot.tasks);
    if (!next) return this.closeSchedulingWindow(snapshot, actorId, now);

    const budgetStop = this.recoveryBudgetStop(snapshot);
    if (budgetStop) {
      return this.store.transitionOrchestrationRun({
        runId: snapshot.run.id,
        expectedRevision: snapshot.run.revision,
        nextStatus: 'blocked',
        actorId,
        reason: budgetStop.reason,
        evidence: { recoveryBudgetVersion: 1, ...budgetStop.evidence },
        now
      });
    }

    const attemptId = `attempt-${randomUUID()}`;
    const contextManifest = {
      ...this.createFixtureManifest(snapshot, next.id),
      ...(reportCorrection ? {
        reportOnlyReportRetry: true,
        ...(reportCorrection.startingCommit ? { reportOnlyBaselineCommit: reportCorrection.startingCommit } : {})
      } : {})
    };
    let baseRequest: OrchestrationLaunchRequest;
    let prepared: PreparedOrchestrationTask = {};
    try {
      const taskRepository = next.repository ?? snapshot.run.repository;
      const taskWorkspace = repositoryWorkspaceForTask(snapshot, next.id) ?? legacySingleRepositoryWorkspace(snapshot.run, taskRepository);
      if (!taskWorkspace) throw new Error(`The repository assigned to task ${next.id} is not part of this build.`);
      const taskPackage = await this.createTaskPackage(snapshot, next.id, reportCorrection, developerGuidance);
      baseRequest = {
        runId: snapshot.run.id,
        workspaceId: snapshot.run.workspaceId,
        projectId: snapshot.run.projectId,
        issueId: snapshot.run.issueId,
        repository: taskWorkspace.repository,
        planVersion: snapshot.run.planVersion,
        branchName: taskWorkspace.branchName,
        workingDir: taskWorkspace.worktreePath,
        baseRef: taskWorkspace.baseRef,
        baseCommit: taskWorkspace.baseCommit,
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
      try {
        prepared = await this.executor.prepare?.(baseRequest) ?? {};
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'The task workspace or persona could not be prepared.';
        const started = this.store.startOrchestrationAttempt({
          runId: snapshot.run.id,
          taskId: next.id,
          expectedTaskRevision: next.revision,
          attemptId,
          startingCommit: baseRequest.baseCommit,
          contextManifest: { ...contextManifest, orchestrationPreparationFailed: true },
          actorId,
          now
        });
        const failedTask = started.tasks.find(item => item.id === next.id);
        if (!failedTask) throw new Error('The failed preparation attempt could not be read after it was persisted.');
        const failed = this.store.failOrchestrationAttempt({
          runId: started.run.id,
          taskId: next.id,
          attemptId,
          expectedTaskRevision: failedTask.revision,
          reason,
          actorId: 'orchestrator'
        });
        return failed.run.status === 'executing'
          ? this.store.transitionOrchestrationRun({
              runId: failed.run.id,
              expectedRevision: failed.run.revision,
              nextStatus: 'blocked',
              actorId,
              reason: `The task could not be prepared for its specialist: ${reason}`,
              now
            })
          : failed;
      }
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
      ...(prepared.contextManifest ?? {}),
      packageVersion: baseRequest.taskPackage.packageVersion,
      reportSchemaVersion: baseRequest.taskPackage.reportSchemaVersion
    };
    if (prepared.branchName && prepared.workingDir && prepared.baseRef && prepared.startingCommit) {
      this.store.bindOrchestrationWorkspace({
        runId: snapshot.run.id,
        repository: baseRequest.repository,
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
        const launchError = error instanceof Error ? error.message : 'The executor failed to start the task.';
        const failed = this.store.failOrchestrationAttempt({
          runId: started.run.id,
          taskId: next.id,
          attemptId,
          expectedTaskRevision: currentTask.revision,
          reason: launchError,
          actorId
        });
        if (failed.run.status === 'executing') {
          return this.store.transitionOrchestrationRun({
            runId: failed.run.id,
            expectedRevision: failed.run.revision,
            nextStatus: 'blocked',
            actorId,
            reason: `Specialist launch failed before the task could run: ${launchError}`,
          });
        }
        return failed;
      });
    }
  }

  private recoveryBudgetStop(snapshot: OrchestrationSnapshot): { reason: string; evidence: Record<string, unknown> } | undefined {
    if (ALPHA_ORCHESTRATION_MAX_BUILD_AGE_MS > 0) {
      const createdAt = Date.parse(snapshot.run.createdAt);
      if (!Number.isFinite(createdAt)) {
        return {
          reason: 'Alpha could not verify the build age limit because its start time is missing. Review the saved build before continuing.',
          evidence: { budgetType: 'elapsed_time', measuredMs: null, limitMs: ALPHA_ORCHESTRATION_MAX_BUILD_AGE_MS }
        };
      }
      const elapsedMs = Math.max(0, Date.now() - createdAt);
      if (elapsedMs >= ALPHA_ORCHESTRATION_MAX_BUILD_AGE_MS) {
        return {
          reason: `The build reached its configured elapsed-time budget (${Math.round(elapsedMs / 60_000)} of ${Math.round(ALPHA_ORCHESTRATION_MAX_BUILD_AGE_MS / 60_000)} minutes). Saved work is preserved; increase the limit or review the build before continuing.`,
          evidence: { budgetType: 'elapsed_time', measuredMs: elapsedMs, limitMs: ALPHA_ORCHESTRATION_MAX_BUILD_AGE_MS }
        };
      }
    }

    const prototypeRunIds = [...new Set(snapshot.attempts.flatMap(attempt => attempt.prototypeRunId ? [attempt.prototypeRunId] : []))];
    const prototypeRuns = new Map(this.store.getPrototypeRuns()
      .filter(run => prototypeRunIds.includes(run.id)).map(run => [run.id, run]));
    const usageRuns = prototypeRunIds.map(id => prototypeRuns.get(id));
    if (ALPHA_ORCHESTRATION_MAX_TOKENS > 0) {
      const missing = usageRuns.filter(run => !run?.usage || typeof run.usage.inputTokens !== 'number' || typeof run.usage.outputTokens !== 'number').length;
      const measuredTokens = usageRuns.reduce((total, run) => total + (run?.usage?.inputTokens ?? 0) + (run?.usage?.outputTokens ?? 0), 0);
      if (missing) {
        return {
          reason: `Alpha cannot verify the configured token budget because ${missing} agent run${missing === 1 ? ' has' : 's have'} incomplete usage data. Review the saved build or use a provider that reports both input and output tokens before continuing.`,
          evidence: { budgetType: 'tokens', measuredTokens, limitTokens: ALPHA_ORCHESTRATION_MAX_TOKENS, runsMissingUsage: missing }
        };
      }
      if (measuredTokens >= ALPHA_ORCHESTRATION_MAX_TOKENS) {
        return {
          reason: `The build reached its configured token budget (${measuredTokens.toLocaleString()} of ${ALPHA_ORCHESTRATION_MAX_TOKENS.toLocaleString()} tokens). Saved work is preserved; increase the limit or review the build before continuing.`,
          evidence: { budgetType: 'tokens', measuredTokens, limitTokens: ALPHA_ORCHESTRATION_MAX_TOKENS }
        };
      }
    }
    if (ALPHA_ORCHESTRATION_MAX_COST_USD > 0) {
      const missing = usageRuns.filter(run => typeof run?.usage?.costUsd !== 'number').length;
      const measuredCostUsd = usageRuns.reduce((total, run) => total + (run?.usage?.costUsd ?? 0), 0);
      if (missing) {
        return {
          reason: `Alpha cannot verify the configured cost budget because ${missing} agent run${missing === 1 ? ' has' : 's have'} no reported cost. Review the saved build or use a provider that reports cost before continuing.`,
          evidence: { budgetType: 'cost', measuredCostUsd, limitCostUsd: ALPHA_ORCHESTRATION_MAX_COST_USD, runsMissingCost: missing }
        };
      }
      if (measuredCostUsd >= ALPHA_ORCHESTRATION_MAX_COST_USD) {
        return {
          reason: `The build reached its configured cost budget ($${measuredCostUsd.toFixed(2)} of $${ALPHA_ORCHESTRATION_MAX_COST_USD.toFixed(2)}). Saved work is preserved; increase the limit or review the build before continuing.`,
          evidence: { budgetType: 'cost', measuredCostUsd, limitCostUsd: ALPHA_ORCHESTRATION_MAX_COST_USD }
        };
      }
    }
    return undefined;
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
      reportSchemaVersion: ORCHESTRATION_AGENT_REPORT_SCHEMA_VERSION,
      runId: snapshot.run.id,
      planVersion: snapshot.run.planVersion,
      taskId,
      ownerAgentId: task.ownerAgentId,
      requirementIds: task.requirementIds,
      acceptedDependencies
    };
  }

  private async createTaskPackage(
    snapshot: OrchestrationSnapshot,
    taskId: string,
    reportCorrection?: { validationErrors: string[]; previousResponse: string; startingCommit?: string },
    developerGuidance?: string
  ): Promise<OrchestrationTaskPackage> {
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
        const report = result.agentReport && typeof result.agentReport === 'object'
          ? result.agentReport as Record<string, unknown>
          : {};
        const acceptanceEvidence = result.acceptanceEvidence && typeof result.acceptanceEvidence === 'object'
          ? result.acceptanceEvidence as Record<string, unknown>
          : {};
        const verification = result.verification && typeof result.verification === 'object'
          ? result.verification as Record<string, unknown>
          : {};
        const observed = verification.observed && typeof verification.observed === 'object'
          ? verification.observed as Record<string, unknown>
          : {};
        const commands = Array.isArray(observed.commands)
          ? observed.commands as Array<Record<string, unknown>>
          : [];
        const verificationStatus: OrchestrationTaskPackage['acceptedDependencies'][number]['verificationStatus'] =
          ['passed', 'failed', 'skipped', 'cancelled'].includes(String(observed.status))
          ? observed.status as 'passed' | 'failed' | 'skipped' | 'cancelled'
          : 'not_recorded';
        const missingScripts = Array.isArray(observed.missingScripts)
          ? observed.missingScripts.filter((script): script is string => typeof script === 'string').slice(0, 20)
          : [];
        const coverage = Array.isArray(report.requirementCoverage)
          ? report.requirementCoverage as Array<Record<string, unknown>>
          : [];
        const deliverables = Array.isArray(report.deliverables)
          ? report.deliverables as Array<Record<string, unknown>>
          : [];
        const artifact = acceptedAttempt && snapshot.artifacts.find(candidate =>
          candidate.attemptId === acceptedAttempt.id && candidate.type === 'task_result'
        );
        return {
          taskId: item.id,
          taskKind: item.kind,
          ownerAgentId: item.ownerAgentId,
          acceptedRevision: item.acceptedRevision ?? item.revision,
          summary,
          resultCommit: acceptedAttempt?.resultCommit,
          resultArtifactHash: artifact?.contentHash,
          requirementCoverage: coverage.slice(0, 12).flatMap(item =>
            typeof item.requirementId === 'string' && typeof item.evidence === 'string'
              ? [{ requirementId: item.requirementId.slice(0, 80), evidence: item.evidence.slice(0, 500) }]
              : []
          ),
          deliverables: deliverables.slice(0, 20).flatMap(item =>
            typeof item.summary === 'string'
              ? [{
                  summary: item.summary.slice(0, 500),
                  paths: Array.isArray(item.paths)
                    ? item.paths.filter((filePath): filePath is string => typeof filePath === 'string').slice(0, 60)
                    : []
                }]
              : []
          ),
          verificationStatus,
          missingScripts,
          observedChecks: commands.slice(0, 20).map(command => {
            const commandInfo = command.command && typeof command.command === 'object'
              ? command.command as Record<string, unknown>
              : {};
            const script = command.script ?? commandInfo.script ?? command.display ?? commandInfo.display;
            const exitCode = command.exitCode;
            const signal = command.signal;
            return {
              script: typeof script === 'string' ? script.slice(0, 180) : 'Registered check',
              result: exitCode === 0 && (signal === null || signal === undefined)
                ? 'passed' as const
                : exitCode === null || exitCode === undefined ? 'not_run' as const : 'failed' as const
            };
          }),
          changedPaths: Array.isArray(acceptanceEvidence.changedPaths)
            ? acceptanceEvidence.changedPaths.filter((filePath): filePath is string => typeof filePath === 'string').slice(0, 60)
            : []
        };
      });
    const reviewInputs = task.kind === 'review' && !reportCorrection
      ? await this.createReviewInputs(snapshot, task)
      : [];
    const taskPackage: OrchestrationTaskPackage = {
      packageVersion: 6,
      reportSchemaVersion: ORCHESTRATION_AGENT_REPORT_SCHEMA_VERSION,
      goal: snapshot.run.plan.goal,
      projectContext: snapshot.run.plan.projectContext ?? '',
      exclusions: snapshot.run.plan.exclusions,
      task: {
        id: task.id,
        title: task.title,
        kind: task.kind,
        repository: task.repository ?? snapshot.run.repository,
        description: task.description,
        acceptanceCriteria: task.acceptanceCriteria,
        requiredChecks: task.requiredChecks,
        scope: task.scope
      },
      requirements: snapshot.run.plan.requirements.filter(requirement => requirementIds.has(requirement.id)),
      acceptedDependencies: reportCorrection ? [] : acceptedDependencies,
      reviewInputs,
      corrections: reportCorrection ? [] : snapshot.findings
        .filter(finding => finding.correctionTaskId === taskId && finding.status === 'open')
        .map(finding => {
          const evidence = finding.evidence;
          const instruction = typeof evidence.instruction === 'string' ? evidence.instruction
            : typeof evidence.message === 'string' ? evidence.message
              : typeof evidence.reason === 'string' ? evidence.reason
                : 'Resolve the recorded acceptance finding and provide evidence.';
          const title = typeof evidence.title === 'string' ? evidence.title.slice(0, 240) : undefined;
          const detail = typeof evidence.evidence === 'string' ? evidence.evidence
            : typeof evidence.detail === 'string' ? evidence.detail
              : typeof evidence.reason === 'string' ? evidence.reason : undefined;
          const location = finding.path ? `Path: ${finding.path}. ` : '';
          const failure = detail ? `Evidence: ${detail.slice(0, 1_000)} ` : '';
          return `[finding:${finding.id}] ${title ? `${title}. ` : ''}${location}${failure}Requested: ${instruction.slice(0, 2_000)}`;
        }),
      findingIds: reportCorrection ? [] : snapshot.findings
        .filter(finding => finding.correctionTaskId === taskId && finding.status === 'open')
        .map(finding => finding.id)
    };
    if (!reportCorrection && developerGuidance?.trim()) {
      taskPackage.developerGuidance = developerGuidance.trim().slice(0, MAX_RECOVERY_GUIDANCE_CHARS);
    }
    if (reportCorrection) {
      taskPackage.reportCorrection = {
        validationErrors: reportCorrection.validationErrors.slice(0, 8).map(error => error.slice(0, 500)),
        previousResponse: reportCorrection.previousResponse.slice(0, 12_000)
      };
    }
    const priorFailure = [...snapshot.attempts].reverse().find(attempt =>
      attempt.taskId === taskId && attempt.status === 'failed' && attempt.failureReason
    );
    if (!reportCorrection && priorFailure?.failureReason) {
      taskPackage.corrections.push(
        `[orchestrator-repair] Review the previous specialist failure and correct its cause before resubmitting. Evidence: ${safeRecoveryGuidance(priorFailure.failureReason).slice(0, 4_000)}`
      );
    }
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

    if (!codeTasks.size) return [];

    const results: OrchestrationTaskPackage['reviewInputs'] = [];
    let totalBytes = 0;
    for (const codeTask of codeTasks.values()) {
      const repositoryWorkspace = repositoryWorkspaceForTask(snapshot, codeTask.id);
      if (!repositoryWorkspace) throw new Error(`The accepted code task ${codeTask.id} has no authorized repository workspace. Preserve the build and use human review.`);
      const worktree = repositoryWorkspace.worktreePath;
      const attempt = [...snapshot.attempts].reverse().find(item => item.taskId === codeTask.id && item.status === 'accepted');
      const acceptanceEvidence = attempt?.result?.acceptanceEvidence && typeof attempt.result.acceptanceEvidence === 'object'
        ? attempt.result.acceptanceEvidence as Record<string, unknown>
        : undefined;
      const diffStartingCommit = typeof acceptanceEvidence?.diffStartingCommit === 'string'
        ? acceptanceEvidence.diffStartingCommit
        : attempt?.startingCommit;
      if (!diffStartingCommit || !attempt?.resultCommit) {
        throw new Error(`Accepted task ${codeTask.id} is missing its immutable diff commits. Preserve the build and use human review.`);
      }
      const [diff, changedPaths] = await Promise.all([
        getGitDiffPatch(worktree, diffStartingCommit, attempt.resultCommit),
        getGitChangedPaths(worktree, diffStartingCommit, attempt.resultCommit)
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
        repository: repositoryWorkspace.repository,
        ownerAgentId: codeTask.ownerAgentId,
        startingCommit: diffStartingCommit,
        resultCommit: attempt.resultCommit,
        changedPaths,
        diff,
        diffHash,
        ...(diff.trim() ? {} : { sourceFiles: await this.readReviewSourceContext(worktree, codeTask, attempt) }),
        relatedFindings
      });
      for (const file of results.at(-1)?.sourceFiles ?? []) {
        totalBytes += Buffer.byteLength(file.content, 'utf8');
        if (totalBytes > MAX_REVIEW_CONTEXT_BYTES) {
          throw new Error(`The empty-patch review needs more than ${MAX_REVIEW_CONTEXT_BYTES / 1024} KiB of approved source and test context. Narrow the task scope or request human review.`);
        }
      }
    }
    return results;
  }

  private async readReviewSourceContext(
    worktree: string,
    task: OrchestrationSnapshot['tasks'][number],
    acceptedAttempt: OrchestrationSnapshot['attempts'][number]
  ): Promise<NonNullable<OrchestrationTaskPackage['reviewInputs'][number]['sourceFiles']>> {
    if (!task.scope.includePaths.length) {
      throw new Error(`Review input missing for ${task.id}: the accepted patch is empty and the task has no approved source paths. Add a concrete source/test path or request human review.`);
    }
    const report = acceptedAttempt.result?.agentReport as { deliverables?: Array<{ paths?: string[] }> } | undefined;
    const reportedPaths = (report?.deliverables ?? []).flatMap(deliverable => deliverable.paths ?? []);
    const tracked = await getGitTrackedPaths(worktree);
    const included = (filePath: string) => task.scope.includePaths.some(pattern => pathMatchesScope(filePath, pattern)) &&
      !task.scope.excludePaths.some(pattern => pathMatchesScope(filePath, pattern));
    const candidates = tracked.filter(filePath =>
      included(filePath) && REVIEW_SOURCE_EXTENSIONS.test(filePath) && !SENSITIVE_REVIEW_PATH.test(filePath)
    );
    const acceptedReportedPaths = [...new Set(reportedPaths)].filter(filePath => candidates.includes(filePath));
    const words = `${task.title} ${task.description} ${task.acceptanceCriteria.join(' ')}`
      .toLowerCase().match(/[a-z0-9_]{4,}/g) ?? [];
    const keywords = [...new Set(words.filter(word => !new Set([
      'with', 'from', 'that', 'this', 'should', 'must', 'when', 'then', 'including', 'provide', 'support', 'complete', 'changes'
    ]).has(word)))];
    const keywordScore = (filePath: string) => {
      const normalized = filePath.toLowerCase();
      return keywords.reduce((score, word) => score + (normalized.includes(word) ? 1 : 0), 0);
    };
    const ordered = [
      ...acceptedReportedPaths,
      ...candidates.filter(filePath => !acceptedReportedPaths.includes(filePath))
        .sort((left, right) => keywordScore(right) - keywordScore(left) || left.localeCompare(right))
    ].slice(0, MAX_REVIEW_SOURCE_FILES);
    const root = path.resolve(worktree);
    const files: NonNullable<OrchestrationTaskPackage['reviewInputs'][number]['sourceFiles']> = [];
    let contextBytes = 0;
    for (const relativePath of ordered) {
      const segments = relativePath.split('/');
      if (path.isAbsolute(relativePath) || segments.some(segment => !segment || segment === '.' || segment === '..')) continue;
      const absolutePath = path.resolve(root, ...segments);
      const relation = path.relative(root, absolutePath);
      if (!relation || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) continue;
      try {
        const stat = await fs.promises.lstat(absolutePath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_REVIEW_SOURCE_FILE_BYTES) continue;
        const realPath = await fs.promises.realpath(absolutePath);
        const realRelation = path.relative(root, realPath);
        if (!realRelation || realRelation.startsWith(`..${path.sep}`) || path.isAbsolute(realRelation)) continue;
        const content = await fs.promises.readFile(absolutePath, 'utf8');
        const size = Buffer.byteLength(content, 'utf8');
        if (size > MAX_REVIEW_SOURCE_FILE_BYTES || content.includes('\u0000')) continue;
        if (contextBytes + size > MAX_REVIEW_CONTEXT_BYTES) break;
        contextBytes += size;
        files.push({ path: relativePath, content, contentHash: createHash('sha256').update(content).digest('hex') });
      } catch {
        // A file can disappear between Git's listing and the safe read. Omit it;
        // a review still needs at least one readable scoped file below.
      }
    }
    if (!files.length) {
      throw new Error(`Review input missing for ${task.id}: the accepted patch is empty and no readable source or test file was found within its approved paths. No reviewer attempt was started.`);
    }
    return files;
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

/** Preserve direct one-repository service integrations while product builds use saved per-repository workspaces. */
function legacySingleRepositoryWorkspace(
  run: OrchestrationSnapshot['run'],
  repository: string
): { repository: string; branchName: string; baseRef: string; baseCommit: string; worktreePath: string } | undefined {
  const canonical = (value: string) => value.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/$/, '').toLowerCase();
  if (run.repositoryWorkspaces?.length || canonical(repository) !== canonical(run.repository)) return undefined;
  const suffix = run.id.replace(/[^a-zA-Z0-9]/g, '').slice(-20).toLowerCase();
  if (!suffix) return undefined;
  return {
    repository: run.repository,
    branchName: run.branchName ?? `alpha/orchestration/${suffix}`,
    baseRef: run.baseRef ?? 'HEAD',
    baseCommit: run.baseCommit ?? '',
    worktreePath: run.worktreePath ?? ''
  };
}

export function orchestrationRequestFingerprint(input: {
  workspaceId: string;
  projectId: string;
  issueId: string;
  repository: string;
  repositories?: readonly string[];
  createdBy: string;
  originalRequest: string;
}): string {
  const repositories = [...new Set((input.repositories ?? [input.repository]).map(value =>
    value.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/$/, '').toLowerCase()
  ))].sort();
  return createHash('sha256').update(JSON.stringify({ ...input, repositories })).digest('hex');
}
