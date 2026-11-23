import { createHash } from 'node:crypto';
import { isImplementationTask } from './agentRoleContracts.js';
import { sameRepository } from '../utils/repositoryName.js';
import path from 'node:path';
import { taskAuditEvidence, finalDependencyAuditProblem } from './orchestrationAuditEvidence.js';
import type { PrototypeRun, RunVerificationEvidence } from '../models/index.js';
import { normalizeAndValidateAgentReport } from './orchestrationAgentReport.js';
import { getCurrentBranch, getGitChangedPaths, getGitFileAtCommit, getHeadCommit, isGitWorkingTreeClean } from '../utils/gitUtils.js';
import { runVerification, type VerificationResult } from './verificationService.js';
import { projectRunWorkspacePath } from './workspaceService.js';
import { runWithWorkspace } from './workspaceContext.js';
import { SQLiteService } from './sqliteService.js';
import { OrchestrationService } from './orchestrationService.js';
import { buildFinalValidationAmendment, buildOrchestrationReviewAmendment, OrchestrationReviewPlanError } from './orchestrationReviewWorkflow.js';
import type { OrchestrationAttemptRecord, OrchestrationSnapshot, OrchestrationTaskRecord } from './orchestrationStateMachine.js';
import { repositoryWorkspaceForRun, repositoryWorkspaceForTask } from './orchestrationWorkspace.js';
import { pathMatchesScope, scopeAllowsPath } from '../utils/pathScope.js';
import { buildTaskRequiredChecks, repositoryChecks } from './repositoryChecks.js';
import { taskChangeBaseline } from './orchestrationCheckpoints.js';
import {
  AUTO_REPAIR_ATTEMPT_LIMIT,
  MAX_AUTOMATIC_REPORT_FORMAT_CORRECTIONS,
  hasRepeatedRecoveryFailure,
  hasRepairableFinalValidationEvidence,
  isAlphaOwnedGitBlocker,
  isToolOrEnvironmentBlocker,
  REPORT_FORMAT_CHECKS,
  TOOL_BLOCKER_PREFIX,
  reportFormatCorrectionCount,
  safeRecoverySummary,
  safeRecoveryGuidance,
  workAttemptCount
} from './orchestrationRecoveryPolicy.js';
export { pathMatchesScope } from '../utils/pathScope.js';
export { isAlphaOwnedGitBlocker } from './orchestrationRecoveryPolicy.js';

export interface TaskAcceptanceOutcome {
  decision: 'accepted' | 'rejected' | 'blocked' | 'retrying' | 'awaiting_approval' | 'completed';
  snapshot: OrchestrationSnapshot;
  reason?: string;
  evidence?: Record<string, unknown>;
}

interface AcceptanceDependencies {
  getCurrentBranch: typeof getCurrentBranch;
  getHeadCommit: typeof getHeadCommit;
  isGitWorkingTreeClean: typeof isGitWorkingTreeClean;
  getGitChangedPaths: typeof getGitChangedPaths;
  getGitFileAtCommit: typeof getGitFileAtCommit;
  worktreePathFor: typeof projectRunWorkspacePath;
  runVerification: typeof runVerification;
}

const REPORT_ONLY_CORRECTION_CHECKS = REPORT_FORMAT_CHECKS;
const AUTOMATIC_CODE_REPAIR_CHECKS = new Set([
  'scope_violation', 'accepted_artifact_mutation', 'accepted_artifact_weakened', 'required_check', 'verification_failed', 'tool_blocker'
]);

/** Test files whose cases and assertions an update to accepted work must keep. */
const TEST_FILE = /(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const TEST_CASE = /\b(?:it|test)(?:\.(?:each|only|skip)\s*\([^)]*\))?\s*\(/g;
const ASSERTION = /\bexpect\s*\(|\bassert(?:\.\w+)?\s*\(/g;
const MAX_WEAKENING_CHECK_BYTES = 1024 * 1024;

/** Same case rule as the write tool (pathMatchesScope), so a file it allowed is never rejected here. */
function taskAllowsPath(task: OrchestrationTaskRecord, filePath: string): boolean {
  return isImplementationTask(task.kind) &&
    scopeAllowsPath(task.scope, filePath);
}

/** Title of a finding, as the reviewer or Alpha's acceptance gate wrote it. */
function findingTitle(finding: OrchestrationSnapshot['findings'][number]): string {
  const { title, instruction } = finding.evidence;
  if (typeof title === 'string' && title.trim()) return title.trim();
  if (typeof instruction === 'string' && instruction.trim()) return instruction.trim();
  return finding.path ? `Finding in ${finding.path}` : 'Unnamed finding';
}

/**
 * Why final validation stopped, naming the exact failed commands or open findings so
 * the person (and the chat) can see what is wrong instead of a generic sentence.
 */
export function finalValidationBlockReason(
  results: ReadonlyArray<{ repository: string; verification: VerificationResult }>,
  openBlockingFindings: ReadonlyArray<OrchestrationSnapshot['findings'][number]>
): string {
  const short = (repository: string) => repository.split('/').pop() || repository;
  const failed = results.flatMap(result => result.verification.commands
    .filter(command => command.exitCode !== 0 || command.signal !== null)
    .map(command => `${short(result.repository)}: ${command.command.display} (${command.signal ? 'stopped by ' + command.signal : 'exit ' + command.exitCode})`));
  const parts: string[] = [];
  if (failed.length) parts.push(`Final checks failed: ${failed.join('; ')}.`);
  else if (results.some(result => result.verification.status !== 'passed')) parts.push(`Final checks did not pass: ${results.map(result => short(result.repository) + ': ' + result.verification.summary).join(' ')}`);
  if (openBlockingFindings.length) {
    const titles = openBlockingFindings.slice(0, 3).map(finding => `“${findingTitle(finding)}”`).join(', ');
    const more = openBlockingFindings.length > 3 ? ` and ${openBlockingFindings.length - 3} more` : '';
    parts.push(`${failed.length ? 'Also, ' : 'Every final check passed, but '}${openBlockingFindings.length} blocking review ${openBlockingFindings.length === 1 ? 'finding is' : 'findings are'} still open: ${titles}${more}.`);
  }
  return parts.join(' ') || 'Final validation failed.';
}

/**
 * Whether a task may change a file an accepted task delivered. Both cases need the file in the
 * task's own approved scope, so the plan the person approved names it:
 * - the task builds on the owner (depends on it, directly or through other tasks). Repository
 *   checks and shared code reach across files, so later work must be able to update earlier
 *   files, tests included; the change is recorded as evolvedAcceptedPaths for the review.
 * - the owner sits in an earlier milestone (a persisted later milestone is a scoped amendment).
 * Tasks the plan runs side by side stay strict: neither may rewrite the other's accepted work.
 */
function mayEvolveAcceptedPath(
  snapshot: OrchestrationSnapshot,
  task: OrchestrationTaskRecord,
  filePath: string,
  ownerTaskId: string
): boolean {
  if (!taskAllowsPath(task, filePath)) return false;
  if (dependsTransitivelyOn(task, ownerTaskId, snapshot.tasks)) return true;
  const owner = snapshot.tasks.find(candidate => candidate.id === ownerTaskId);
  const milestones = snapshot.run.plan.milestones ?? [];
  const prior = milestones.findIndex(item => item.id === owner?.milestoneId);
  const current = milestones.findIndex(item => item.id === task.milestoneId);
  return prior >= 0 && current > prior;
}

function dependsTransitivelyOn(
  task: OrchestrationTaskRecord,
  dependencyId: string,
  tasks: readonly OrchestrationTaskRecord[]
): boolean {
  const byId = new Map(tasks.map(candidate => [candidate.id, candidate]));
  const seen = new Set<string>();
  const visit = (taskId: string): boolean => {
    for (const id of byId.get(taskId)?.dependsOn ?? []) {
      if (id === dependencyId) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      if (visit(id)) return true;
    }
    return false;
  };
  return visit(task.id);
}

/**
 * Where this task's changes are measured from, across all its attempts (taskChangeBaseline).
 * Report-only and code retries alike: both continue the earlier attempt's saved work.
 */
function taskBaseline(snapshot: OrchestrationSnapshot, taskId: string, attempt: OrchestrationAttemptRecord): string | undefined {
  return taskChangeBaseline(snapshot, taskId, repositoryWorkspaceForTask(snapshot, taskId)?.baseCommit) ?? attempt.startingCommit;
}

function reviewRootTask(task: OrchestrationTaskRecord, tasks: readonly OrchestrationTaskRecord[]): OrchestrationTaskRecord | undefined {
  return tasks.find(candidate => candidate.id === (task.correctionOfTaskId ?? task.id));
}

function previousAgentReportResponse(result: Record<string, unknown> | undefined): string {
  if (typeof result?.agentReportResponse === 'string') {
    const response = result.agentReportResponse;
    if (result.agentReportResponseTruncated === true) {
      const marker = '\n[Alpha saved only the first part of the original response.]';
      return `${response.slice(0, Math.max(0, 12_000 - marker.length))}${marker}`;
    }
    return response.slice(0, 12_000);
  }
  if (result?.agentReport && typeof result.agentReport === 'object') {
    return JSON.stringify(result.agentReport).slice(0, 12_000);
  }
  return typeof result?.summary === 'string' ? result.summary.slice(0, 12_000) : '';
}

function validateAttemptReport(attempt: OrchestrationAttemptRecord) {
  const expectedVersion = typeof attempt.contextManifest.reportSchemaVersion === 'number'
    ? attempt.contextManifest.reportSchemaVersion
    : undefined;
  return normalizeAndValidateAgentReport(attempt.result?.agentReport, expectedVersion);
}

export class TaskAcceptanceService {
  private readonly dependencies: AcceptanceDependencies;

  constructor(
    private readonly store: SQLiteService,
    private readonly orchestration: OrchestrationService,
    dependencies: Partial<AcceptanceDependencies> = {}
  ) {
    this.dependencies = {
      getCurrentBranch,
      getHeadCommit,
      isGitWorkingTreeClean,
      getGitChangedPaths,
      getGitFileAtCommit,
      worktreePathFor: projectRunWorkspacePath,
      runVerification,
      ...dependencies
    };
  }

  async evaluateAndAccept(input: {
    workspaceId: string;
    runId: string;
    taskId: string;
    attemptId: string;
    acceptedBy: string;
    dispatchNext?: boolean;
    now?: string;
  }): Promise<TaskAcceptanceOutcome> {
    try {
      return await this.evaluateAndAcceptSubmitted(input);
    } catch (error) {
      return runWithWorkspace(input.workspaceId, (): TaskAcceptanceOutcome => {
        const latest = this.store.getOrchestrationSnapshot(input.runId);
        const task = latest?.tasks.find(item => item.id === input.taskId);
        const attempt = latest?.attempts.find(item => item.id === input.attemptId);
        if (!latest || !task || !attempt) throw error;
        if (attempt.status === 'accepted') return { decision: 'accepted', snapshot: latest };
        if (latest.run.status !== 'executing' || latest.run.currentTaskId !== task.id ||
            attempt.taskId !== task.id || attempt.status !== 'submitted') {
          return {
            decision: 'blocked', snapshot: latest,
            reason: 'Alpha could not finish recording this handoff. The current build state was preserved for review.'
          };
        }
        return this.blockAcceptanceFailure(latest, task, attempt, input.acceptedBy, error, input.now);
      });
    }
  }

  private evaluateAndAcceptSubmitted(input: {
    workspaceId: string;
    runId: string;
    taskId: string;
    attemptId: string;
    acceptedBy: string;
    dispatchNext?: boolean;
    now?: string;
  }): Promise<TaskAcceptanceOutcome> {
    return runWithWorkspace(input.workspaceId, async (): Promise<TaskAcceptanceOutcome> => {
      const snapshot = this.store.getOrchestrationSnapshot(input.runId);
      const task = snapshot?.tasks.find(item => item.id === input.taskId);
      const attempt = snapshot?.attempts.find(item => item.id === input.attemptId);
      if (!snapshot || !task || !attempt) throw new Error('The submitted task or attempt is unavailable.');
      if (attempt.status === 'accepted') return { decision: 'accepted', snapshot };
      if (snapshot.run.status !== 'executing' || snapshot.run.currentTaskId !== task.id || attempt.taskId !== task.id || attempt.status !== 'submitted') {
        return { decision: 'blocked', snapshot, reason: 'This submission is stale or no longer owns the active task.' };
      }

      let rejection: Awaited<ReturnType<TaskAcceptanceService['inspectSubmission']>>;
      try {
        rejection = await this.inspectSubmission(snapshot, task, attempt);
      } catch (error) {
        return this.blockAcceptanceFailure(snapshot, task, attempt, input.acceptedBy, error, input.now);
      }
      if (rejection) {
        const rejected = this.store.rejectOrchestrationAttempt({
          runId: snapshot.run.id,
          taskId: task.id,
          attemptId: attempt.id,
          expectedTaskRevision: task.revision,
          rejectedBy: input.acceptedBy,
          reason: rejection.reason,
          findings: rejection.findings,
          now: input.now
        });
        const reportCanBeRepaired = rejection.findings.every(finding =>
          typeof finding.evidence.check === 'string' && REPORT_ONLY_CORRECTION_CHECKS.has(finding.evidence.check));
        const automaticReportCorrectionsUsed = reportFormatCorrectionCount(rejected, task.id);
        if (reportCanBeRepaired && automaticReportCorrectionsUsed < MAX_AUTOMATIC_REPORT_FORMAT_CORRECTIONS && input.dispatchNext !== false) {
          const correctionTask = rejected.tasks.find(item => item.id === task.id);
          if (correctionTask) {
            try {
              const correction = await this.orchestration.retryTask({
                workspaceId: input.workspaceId,
                runId: input.runId,
                taskId: task.id,
                expectedTaskRevision: correctionTask.revision,
                actorId: input.acceptedBy,
                now: input.now,
                reportCorrection: {
                  validationErrors: rejection.findings.map(finding => {
                    const detail = finding.evidence.detail;
                    return typeof detail === 'string' ? detail : rejection.reason;
                  }),
                  previousResponse: previousAgentReportResponse(attempt.result),
                  startingCommit: taskBaseline(rejected, task.id, attempt)
                }
              });
              if (correction.run.status === 'executing' && correction.run.currentTaskId === task.id) {
                return {
                  decision: 'retrying',
                  snapshot: correction,
                  reason: `The report format was invalid. The same specialist received the exact error for read-only format correction ${automaticReportCorrectionsUsed + 1} of ${MAX_AUTOMATIC_REPORT_FORMAT_CORRECTIONS}; no code changes or new checks were requested.`
                };
              }
              return {
                decision: 'blocked',
                snapshot: correction,
                reason: correction.run.stoppedReason ?? 'The report was rejected, and Alpha could not prepare its read-only format correction.'
              };
            } catch (error) {
              return {
                decision: 'blocked',
                snapshot: rejected,
                reason: error instanceof Error ? error.message : rejection.reason
              };
            }
          }
        }
        // A tool failure is retried for any task kind; code failures only for implementation tasks.
        const onlyToolFailures = rejection.findings.length > 0 && rejection.findings.every(finding => finding.evidence.check === 'tool_blocker');
        const repairableCodeFailure = (isImplementationTask(task.kind) || onlyToolFailures) && rejection.findings.length > 0 &&
          rejection.findings.every(finding => typeof finding.evidence.check === 'string' &&
            AUTOMATIC_CODE_REPAIR_CHECKS.has(finding.evidence.check) &&
            (finding.evidence.check !== 'required_check' ||
              !Array.isArray(finding.evidence.missingScripts) || finding.evidence.missingScripts.length === 0));
        if (repairableCodeFailure && input.dispatchNext !== false &&
            workAttemptCount(rejected, task.id) < AUTO_REPAIR_ATTEMPT_LIMIT &&
            !hasRepeatedRecoveryFailure(rejected, task.id, 'project_code', rejection.reason)) {
          const correctionTask = rejected.tasks.find(item => item.id === task.id);
          if (correctionTask) {
            try {
              const correction = await this.orchestration.retryTask({
                workspaceId: input.workspaceId,
                runId: input.runId,
                taskId: task.id,
                expectedTaskRevision: correctionTask.revision,
                actorId: input.acceptedBy,
                now: input.now
              });
              if (correction.run.status === 'executing' && correction.run.currentTaskId === task.id) {
                return {
                  decision: 'retrying',
                  snapshot: correction,
                  reason: `Alpha sent the failed acceptance checks and saved finding to ${correctionTask.ownerAgentId} for automatic repair (${workAttemptCount(rejected, task.id)} of ${AUTO_REPAIR_ATTEMPT_LIMIT} work attempts). It will recheck the result before continuing.`
                };
              }
              return {
                decision: 'blocked',
                snapshot: correction,
                reason: correction.run.stoppedReason ?? 'Alpha could not safely restart the failed task from its saved checkpoint.'
              };
            } catch (error) {
              return { decision: 'blocked', snapshot: rejected, reason: error instanceof Error ? error.message : rejection.reason };
            }
          }
        }
        return { decision: 'rejected', snapshot: rejected, reason: rejection.reason };
      }

      const reportValidation = validateAttemptReport(attempt);
      if (!reportValidation.success) {
        return this.blockAcceptanceFailure(snapshot, task, attempt, input.acceptedBy,
          new Error(reportValidation.error), input.now);
      }
      const canonicalReport = reportValidation.report as unknown as Record<string, unknown>;

      let evidence: Record<string, unknown>;
      try {
        evidence = await this.acceptanceEvidence(snapshot, task, attempt);
      } catch (error) {
        return this.blockAcceptanceFailure(snapshot, task, attempt, input.acceptedBy, error, input.now);
      }
      if (task.kind === 'review') {
        const report = reportValidation.report;
        let amendment;
        try {
          amendment = buildOrchestrationReviewAmendment(
            snapshot,
            task,
            report.reviewFindings!,
            this.store.getAgents().filter(agent => !agent.isArchived).map(agent => ({ id: agent.id, role: agent.role }))
          );
        } catch (error) {
          const reason = error instanceof OrchestrationReviewPlanError
            ? error.message
            : 'The reviewer findings could not be routed safely. Keep the build blocked for human review.';
          const rejected = this.store.rejectOrchestrationAttempt({
            runId: snapshot.run.id, taskId: task.id, attemptId: attempt.id,
            expectedTaskRevision: task.revision, rejectedBy: input.acceptedBy, reason,
            findings: [{ severity: 'blocking', evidence: { origin: 'review-routing', instruction: reason } }], now: input.now
          });
          return { decision: 'rejected', snapshot: rejected, reason };
        }
        evidence.reviewFindingCount = report.reviewFindings!.length;
        evidence.routedCorrectionTaskIds = [...new Set(amendment.findings.flatMap(finding => finding.correctionTaskId ? [finding.correctionTaskId] : []))];
        let accepted = await this.orchestration.acceptReviewOutcome({
          workspaceId: input.workspaceId,
          runId: snapshot.run.id,
          taskId: task.id,
          attemptId: attempt.id,
          expectedTaskRevision: task.revision,
          expectedPlanVersion: snapshot.run.planVersion,
          acceptedBy: input.acceptedBy,
          evidence,
          canonicalReport,
          amendment,
          dispatchNext: input.dispatchNext,
          now: input.now
        });
        if (accepted.run.status === 'validating') {
          const finalized = await this.finalValidation(accepted, input.acceptedBy, input.now);
          accepted = finalized.snapshot;
          return finalized;
        }
        return { decision: 'accepted', snapshot: accepted, evidence };
      }
      let accepted = await this.orchestration.acceptAttempt({
        workspaceId: input.workspaceId,
        runId: snapshot.run.id,
        taskId: task.id,
        attemptId: attempt.id,
        expectedTaskRevision: task.revision,
        acceptedBy: input.acceptedBy,
        evidence,
        canonicalReport,
        dispatchNext: input.dispatchNext,
        now: input.now
      });
      if (accepted.run.status === 'validating') {
        const finalized = await this.finalizeSafely(accepted, input.acceptedBy, input.now);
        accepted = finalized.snapshot;
        return finalized;
      }
      return { decision: 'accepted', snapshot: accepted, evidence };
    });
  }

  async validateFinalState(input: {
    workspaceId: string;
    runId: string;
    actorId: string;
    now?: string;
  }): Promise<TaskAcceptanceOutcome> {
    return runWithWorkspace(input.workspaceId, async () => {
      const snapshot = this.store.getOrchestrationSnapshot(input.runId);
      if (!snapshot) throw new Error('The orchestration run is unavailable.');
      if (snapshot.run.status !== 'validating') {
        return { decision: 'blocked', snapshot, reason: 'The build is not waiting for final validation.' };
      }
      return this.finalizeSafely(snapshot, input.actorId, input.now);
    });
  }

  private async finalizeSafely(
    snapshot: OrchestrationSnapshot,
    actorId: string,
    now?: string
  ): Promise<TaskAcceptanceOutcome> {
    try {
      return await this.finalValidation(snapshot, actorId, now);
    } catch (error) {
      const detail = safeRecoverySummary(error instanceof Error ? error.message : String(error));
      const reason = `Alpha could not complete final validation: ${detail || 'The verification service failed unexpectedly.'}`;
      const evidence = {
        validationVersion: 1,
        check: 'validation_system',
        repository: snapshot.run.repository,
        checks: { status: 'failed', missingScripts: [], observed: [], summary: reason }
      };
      const current = this.store.getOrchestrationSnapshot(snapshot.run.id) ?? snapshot;
      const blocked = current.run.status === 'validating'
        ? this.store.transitionOrchestrationRun({
            runId: current.run.id,
            expectedRevision: current.run.revision,
            nextStatus: 'blocked',
            actorId,
            reason,
            evidence,
            now
          })
        : current;
      return { decision: 'blocked', snapshot: blocked, reason, evidence };
    }
  }

  private blockAcceptanceFailure(
    snapshot: OrchestrationSnapshot,
    task: OrchestrationTaskRecord,
    attempt: OrchestrationAttemptRecord,
    rejectedBy: string,
    error: unknown,
    now?: string
  ): TaskAcceptanceOutcome {
    const detail = safeRecoverySummary(error instanceof Error ? error.message : String(error));
    const reason = `Alpha could not complete its acceptance checks: ${detail || 'The verification service failed unexpectedly.'}`;
    const evidence = { check: 'acceptance_system', origin: 'alpha_acceptance', detail };
    const blocked = this.store.rejectOrchestrationAttempt({
      runId: snapshot.run.id,
      taskId: task.id,
      attemptId: attempt.id,
      expectedTaskRevision: task.revision,
      rejectedBy,
      reason,
      findings: [{ severity: 'blocking', evidence: { instruction: reason, ...evidence } }],
      now
    });
    return { decision: 'blocked', snapshot: blocked, reason, evidence };
  }

  private async inspectSubmission(
    snapshot: OrchestrationSnapshot,
    task: OrchestrationTaskRecord,
    attempt: OrchestrationAttemptRecord
  ): Promise<{ reason: string; findings: Array<{ severity: 'blocking'; requirementId?: string; path?: string; evidence: Record<string, unknown> }>; evidence?: Record<string, unknown> } | null> {
    const result = attempt.result;
    const fail = (reason: string, evidence: Record<string, unknown>, filePath?: string) => ({
      reason,
      findings: [{ severity: 'blocking' as const, path: filePath, evidence: { instruction: reason, ...evidence } }]
    });
    if (!result || result.resultSchemaVersion !== 1 || typeof result.summary !== 'string' || !result.summary.trim()) {
      return fail('The task result is missing the required versioned summary.', { check: 'result_schema' });
    }
    const reportValidation = validateAttemptReport(attempt);
    if (!reportValidation.success) {
      const detail = typeof result.agentReportError === 'string' ? result.agentReportError : reportValidation.error;
      return fail(`The specialist report is invalid: ${detail}`, {
        check: 'agent_report', detail,
        instruction: `The report could not be read: ${detail}`
      });
    }
    const report = reportValidation.report;
    if (report.taskId !== task.id) {
      const detail = `Expected taskId "${task.id}" but received "${report.taskId}".`;
      return fail(`The specialist report names a different task. ${detail}`, {
        check: 'report_identity', detail, expectedTaskId: task.id, reportedTaskId: report.taskId
      });
    }
    if (task.kind === 'review') {
      if (!report.reviewFindings) {
        return fail('The independent reviewer must return a reviewFindings array, including an explicit empty array when no defect is found.', {
          check: 'review_findings_missing', detail: 'The report must include "reviewFindings": [].'
        });
      }
      const seenFindings = new Set<string>();
      for (const finding of report.reviewFindings) {
        const key = `${finding.targetTaskId}\0${finding.path ?? ''}\0${finding.title.toLowerCase()}`;
        if (seenFindings.has(key)) return fail('The independent review contains a duplicate finding.', { check: 'duplicate_review_finding', title: finding.title });
        seenFindings.add(key);
        const target = snapshot.tasks.find(candidate => candidate.id === finding.targetTaskId);
        const root = target && reviewRootTask(target, snapshot.tasks);
        if (!target || target.status !== 'accepted' || !isImplementationTask(target.kind) || !root ||
            target.ownerAgentId === task.ownerAgentId || !dependsTransitivelyOn(task, target.id, snapshot.tasks)) {
          return fail(`Review finding “${finding.title}” does not refer to accepted code owned by a different specialist and included in this review's dependencies.`, {
            check: 'review_target', targetTaskId: finding.targetTaskId
          });
        }
        if (finding.requirementId && !root.requirementIds.includes(finding.requirementId)) {
          return fail(`Review finding “${finding.title}” names a requirement outside task ${root.id}.`, {
            check: 'review_requirement', requirementId: finding.requirementId
          });
        }
        if (finding.path && !taskAllowsPath(target, finding.path)) {
          return fail(`Review finding “${finding.title}” points to ${finding.path}, which is outside the owning task's authorized scope.`, {
            check: 'review_path_scope', path: finding.path, targetTaskId: target.id
          }, finding.path);
        }
      }
    }
    if (task.correctionOfTaskId) {
      const expectedFindingIds = snapshot.findings
        .filter(finding => finding.status === 'open' && finding.correctionTaskId === task.id)
        .map(finding => finding.id).sort();
      const reportedFindingCoverage = report.findingCoverage?.map(item => item.findingId).sort() ?? [];
      if (!expectedFindingIds.length || expectedFindingIds.length !== reportedFindingCoverage.length ||
          expectedFindingIds.some((id, index) => id !== reportedFindingCoverage[index]) ||
          report.findingCoverage?.some(item => !item.evidence.trim())) {
        return fail('The correction report must address every linked reviewer finding exactly once with concrete evidence.', {
          check: 'review_finding_coverage', expectedFindingIds, reportedFindingIds: reportedFindingCoverage
        });
      }
    }
    const coveredRequirementIds = report.requirementCoverage.map(item => item.requirementId);
    if (new Set(coveredRequirementIds).size !== coveredRequirementIds.length ||
        task.requirementIds.length !== coveredRequirementIds.length ||
        task.requirementIds.some(id => !coveredRequirementIds.includes(id)) ||
        report.requirementCoverage.some(item => !item.evidence.trim())) {
      return fail('The specialist report does not provide evidence for every assigned requirement exactly once.', {
        check: 'requirement_coverage', expected: task.requirementIds, reported: coveredRequirementIds
      });
    }
    const reportedCriteria = report.criteriaEvidence.map(item => item.criterion);
    if (new Set(reportedCriteria).size !== reportedCriteria.length ||
        task.acceptanceCriteria.length !== reportedCriteria.length ||
        task.acceptanceCriteria.some(criterion => !reportedCriteria.includes(criterion))) {
      return fail('The specialist report does not address every acceptance criterion exactly once.', {
        check: 'acceptance_criteria', expected: task.acceptanceCriteria, reported: reportedCriteria
      });
    }
    // Alpha stages and commits the specialist's changes itself, so a sandbox refusing the
    // agent's own git add or commit is expected and says nothing about the task.
    const unresolvedBlockers = report.blockers.filter(blocker => !isAlphaOwnedGitBlocker(blocker));
    // A refused tool call or an environment error is not missing information: the specialist
    // gets one more try with the error and how to get past it, before anyone is asked.
    const needsPerson = unresolvedBlockers.find(blocker => !isToolOrEnvironmentBlocker(blocker));
    if (needsPerson) {
      return fail(`The specialist reported a blocker: ${needsPerson}`, {
        check: 'agent_blocker', blockers: report.blockers
      });
    }
    if (unresolvedBlockers.length) {
      return fail(`${TOOL_BLOCKER_PREFIX} ${unresolvedBlockers.join(' ')} This is not a product blocker. Re-read the file and retry with project_edit_file and a longer, unique old_text, or replace the file with its current content as expected_content (line endings do not matter).`, {
        check: 'tool_blocker', blockers: report.blockers
      });
    }
    const authorizedWorkspace = repositoryWorkspaceForTask(snapshot, task.id);
    if (!authorizedWorkspace) return fail('The task repository is not part of this build.', { check: 'repository_authority' });
    if (result.prototypeRunId !== attempt.prototypeRunId || result.branchName !== authorizedWorkspace.branchName) {
      return fail('The submitted result does not match this attempt and its authorized branch.', {
        check: 'attempt_identity', expectedRunId: attempt.prototypeRunId, resultRunId: result.prototypeRunId,
        expectedBranch: authorizedWorkspace.branchName, resultBranch: result.branchName
      });
    }
    if (attempt.contextManifest.planVersion !== snapshot.run.planVersion || attempt.contextManifest.taskId !== task.id) {
      return fail('The task attempt was created from a different plan version or task identity.', {
        check: 'context_freshness', expectedPlanVersion: snapshot.run.planVersion,
        attemptPlanVersion: attempt.contextManifest.planVersion, expectedTaskId: task.id,
        attemptTaskId: attempt.contextManifest.taskId
      });
    }
    if (!attempt.resultCommit || !/^[a-f0-9]{40,64}$/i.test(attempt.resultCommit)) {
      return fail('The submission has no valid checkpoint commit.', { check: 'checkpoint_identity' });
    }
    const artifact = snapshot.artifacts.find(item => item.attemptId === attempt.id && item.type === 'task_result' && item.status === 'submitted');
    if (!artifact?.content || createHash('sha256').update(artifact.content).digest('hex') !== artifact.contentHash) {
      return fail('The submitted result artifact is missing or its content hash does not match.', { check: 'artifact_integrity' });
    }
    if (artifact.content !== JSON.stringify(result)) {
      return fail('The saved result artifact differs from the attempt result.', { check: 'artifact_consistency', artifactId: artifact.id });
    }

    const worktreePath = path.resolve(authorizedWorkspace.worktreePath);
    if (task.dependencyAudit) {
      try { taskAuditEvidence(snapshot, task, attempt, worktreePath, report.auditEvidenceIds); }
      catch (error) { return fail(error instanceof Error ? error.message : 'Dependency audit evidence could not be checked.', { check: 'dependency_audit' }); }
    }
    if (!authorizedWorkspace.branchName || !this.store.isPathAllowed(worktreePath)) {
      return fail('The orchestration branch or approved local worktree is missing.', { check: 'workspace_authority' });
    }
    const [branchResult, commitResult, cleanResult] = await Promise.allSettled([
      this.dependencies.getCurrentBranch(worktreePath),
      this.dependencies.getHeadCommit(worktreePath),
      this.dependencies.isGitWorkingTreeClean(worktreePath)
    ] as const);
    if (branchResult.status === 'rejected') throw branchResult.reason;
    if (commitResult.status === 'rejected') throw commitResult.reason;
    if (cleanResult.status === 'rejected') throw cleanResult.reason;
    const branchName = branchResult.value;
    const currentCommit = commitResult.value;
    const isClean = cleanResult.value;
    if (branchName !== authorizedWorkspace.branchName || currentCommit !== attempt.resultCommit || !isClean) {
      return fail('The repository changed after submission or has uncheckpointed edits. Reconcile it before acceptance.', {
        check: 'freshness', expectedBranch: authorizedWorkspace.branchName, currentBranch: branchName,
        submittedCommit: attempt.resultCommit, currentCommit, workingTreeClean: isClean
      });
    }
    const diffStartingCommit = taskBaseline(snapshot, task.id, attempt);
    if (!diffStartingCommit) {
      return fail('The attempt has no recorded starting commit, so its changed-file scope cannot be verified.', { check: 'starting_commit' });
    }
    const changedPaths = await this.dependencies.getGitChangedPaths(worktreePath, diffStartingCommit, attempt.resultCommit);
    const declaredDeliverablePaths = new Set(report.deliverables.flatMap(deliverable => deliverable.paths));
    const undeclaredChangedPath = changedPaths.find(filePath => !declaredDeliverablePaths.has(filePath));
    if (undeclaredChangedPath) {
      return fail(`The specialist report does not identify changed file ${undeclaredChangedPath} as a deliverable.`, {
        check: 'deliverable_traceability', changedPath: undeclaredChangedPath
      }, undeclaredChangedPath);
    }
    if (!authorizedWorkspace.baseCommit) {
      return fail('The orchestration has no recorded base commit, so cumulative change scope cannot be verified.', { check: 'base_commit' });
    }
    const cumulativeChangedPaths = await this.dependencies.getGitChangedPaths(worktreePath, authorizedWorkspace.baseCommit, attempt.resultCommit);
    const readOnlyTask = !isImplementationTask(task.kind);
    if (readOnlyTask && changedPaths.length) {
      return fail('This planning, review, validation, or delivery task changed repository files.', {
        check: 'read_only_scope', changedPaths
      }, changedPaths[0]);
    }
    if (changedPaths.length && !task.scope.includePaths.length && !readOnlyTask) {
      return fail('This code task has no approved path scope. Add an explicit scope before accepting repository changes.', {
        check: 'scope_unconfigured', changedPaths
      }, changedPaths[0]);
    }
    const correctionPaths = new Set(snapshot.findings
      .filter(finding => finding.status === 'open' && finding.correctionTaskId === task.id && finding.path)
      .map(finding => finding.path!));
    const correctionLineageTaskIds = new Set(task.correctionOfTaskId
      ? [task.correctionOfTaskId, ...snapshot.tasks.filter(candidate => candidate.correctionOfTaskId === task.correctionOfTaskId).map(candidate => candidate.id)]
      : [task.id]);
    const { owners: acceptedPathOwners, restored: restoredAcceptedPaths } =
      await this.acceptedPathOwnership(snapshot, task, worktreePath, attempt.resultCommit);
    const outsideScope = changedPaths.find(filePath => !taskAllowsPath(task, filePath) &&
      !(correctionPaths.has(filePath) &&
        (!cumulativeChangedPaths.includes(filePath) ||
          restoredAcceptedPaths.has(filePath))));
    if (outsideScope) {
      return fail(`The task changed ${outsideScope}, which is outside its approved path scope.`, {
        check: 'scope_violation', changedPath: outsideScope,
        includePaths: task.scope.includePaths, excludePaths: task.scope.excludePaths
      }, outsideScope);
    }
    const modifiedAcceptedPath = changedPaths.find(filePath =>
      acceptedPathOwners.has(filePath) && !restoredAcceptedPaths.has(filePath) &&
      !mayEvolveAcceptedPath(snapshot, task, filePath, acceptedPathOwners.get(filePath)!.taskId) &&
      !(task.correctionOfTaskId && correctionPaths.has(filePath) &&
        correctionLineageTaskIds.has(acceptedPathOwners.get(filePath)!.taskId) && taskAllowsPath(task, filePath)));
    if (modifiedAcceptedPath) {
      const owner = acceptedPathOwners.get(modifiedAcceptedPath)!;
      // Only reached when this task does not build on the owner: the plan runs them as separate
      // work, so this is a real conflict. Name only ways out that exist for a started build.
      return fail(`This task changed ${modifiedAcceptedPath}, which accepted task ${owner.taskId} delivered, and this task does not build on ${owner.taskId}. Restore that file to its accepted version, or cancel this build and plan the change with ${owner.taskId}'s work.`, {
        check: 'accepted_artifact_mutation', changedPath: modifiedAcceptedPath,
        acceptedTaskId: owner.taskId, acceptedCommit: owner.commit
      }, modifiedAcceptedPath);
    }
    // Building on a task allows updating its files, never removing them or weakening its tests:
    // fail closed here rather than trusting the reviewer to notice.
    for (const filePath of changedPaths) {
      const owner = acceptedPathOwners.get(filePath);
      if (!owner || owner.taskId === task.id || restoredAcceptedPaths.has(filePath) ||
          !taskAllowsPath(task, filePath) || !dependsTransitivelyOn(task, owner.taskId, snapshot.tasks)) continue;
      const weakened = await this.acceptedFileWeakening(worktreePath, filePath, owner.commit, attempt.resultCommit);
      if (weakened) {
        return fail(`This task ${weakened} in ${filePath}, which accepted task ${owner.taskId} delivered. Work that builds on ${owner.taskId} may update its files but not delete them or remove their tests or assertions. Restore what was removed and keep the update.`, {
          check: 'accepted_artifact_weakened', changedPath: filePath,
          acceptedTaskId: owner.taskId, acceptedCommit: owner.commit
        }, filePath);
      }
    }
    const scopeOwners = snapshot.tasks.filter(candidate =>
      (candidate.status === 'accepted' || candidate.id === task.id) &&
      sameRepository((candidate.repository ?? snapshot.run.repository), (task.repository ?? snapshot.run.repository)));
    const outsideBuildScope = cumulativeChangedPaths.find(filePath =>
      !scopeOwners.some(candidate => taskAllowsPath(candidate, filePath)));
    if (outsideBuildScope) {
      return fail(`The build still contains a change to ${outsideBuildScope} that no accepted or active task owns.`, {
        check: 'cumulative_scope_violation', changedPath: outsideBuildScope,
        authorizedTaskIds: scopeOwners.filter(candidate => taskAllowsPath(candidate, outsideBuildScope)).map(candidate => candidate.id)
      }, outsideBuildScope);
    }

    const verification = result.verification && typeof result.verification === 'object'
      ? (result.verification as Record<string, unknown>).observed as RunVerificationEvidence | null
      : null;
    const observedCommands = verification?.commands ?? [];
    const missingScripts = verification?.missingScripts ?? [];
    const requiredChecks = buildTaskRequiredChecks(snapshot, task);
    const failedCheck = requiredChecks.find(script => missingScripts.includes(script) ||
      !observedCommands.some(command => command.script === script && command.exitCode === 0 && command.signal === null));
    if (failedCheck) {
      return fail(`Required check “${failedCheck}” was not observed passing on this attempt.`, {
        check: 'required_check', requiredScript: failedCheck, missingScripts, observedCommands
      });
    }
    if (isImplementationTask(task.kind) && (!verification || verification.status !== 'passed' || !observedCommands.length || missingScripts.length)) {
      return fail('No complete, passing repository check evidence is available for this code task.', {
        check: 'verification_evidence', verification: verification ?? null
      });
    }
    if (verification?.status === 'failed' || observedCommands.some(command => command.exitCode !== 0 || command.signal !== null)) {
      return fail('One or more observed verification commands failed.', {
        check: 'verification_failed', verification
      });
    }
    return null;
  }

  private async acceptanceEvidence(
    snapshot: OrchestrationSnapshot,
    task: OrchestrationTaskRecord,
    attempt: OrchestrationAttemptRecord
  ): Promise<Record<string, unknown>> {
    const authorizedWorkspace = repositoryWorkspaceForTask(snapshot, task.id);
    if (!authorizedWorkspace) throw new Error(`Task ${task.id} has no authorized repository workspace.`);
    const worktree = authorizedWorkspace.worktreePath;
    const diffStartingCommit = taskBaseline(snapshot, task.id, attempt);
    const changedPaths = diffStartingCommit && attempt.resultCommit
      ? await this.dependencies.getGitChangedPaths(worktree, diffStartingCommit, attempt.resultCommit)
      : [];
    // Files this task changed that an earlier accepted task delivered (allowed by mayEvolveAcceptedPath).
    // Recorded so the reviewers that depend on this task look at what changed in accepted work.
    const ownership = attempt.resultCommit
      ? await this.acceptedPathOwnership(snapshot, task, worktree, attempt.resultCommit)
      : undefined;
    const evolvedAcceptedPaths = ownership
      ? changedPaths.flatMap(filePath => {
        const owner = ownership.owners.get(filePath);
        return owner && owner.taskId !== task.id && !ownership.restored.has(filePath) ? [{ path: filePath, ownerTaskId: owner.taskId }] : [];
      })
      : [];
    return {
      acceptanceVersion: 1,
      attemptId: attempt.id,
      diffStartingCommit,
      artifactId: snapshot.artifacts.find(item => item.attemptId === attempt.id && item.type === 'task_result')?.id,
      resultCommit: attempt.resultCommit,
      currentHead: attempt.resultCommit,
      branchName: authorizedWorkspace.branchName,
      repository: authorizedWorkspace.repository,
      changedPaths,
      cumulativeChangedPaths: authorizedWorkspace.baseCommit && attempt.resultCommit
        ? await this.dependencies.getGitChangedPaths(worktree, authorizedWorkspace.baseCommit, attempt.resultCommit)
        : [],
      ...(evolvedAcceptedPaths.length ? { evolvedAcceptedPaths } : {}),
      scope: { includePaths: task.scope.includePaths, excludePaths: task.scope.excludePaths, passed: true },
      requiredChecks: buildTaskRequiredChecks(snapshot, task),
      verification: attempt.result?.verification,
      semanticReviewRequired: isImplementationTask(task.kind),
      ...(task.dependencyAudit ? { dependencyAudits: taskAuditEvidence(snapshot, task, attempt, worktree,
        validateAttemptReport(attempt).success ? (attempt.result?.agentReport as { auditEvidenceIds?: string[] }).auditEvidenceIds : undefined) } : {})
    };
  }

  /**
   * How a change weakened an accepted file, or undefined when it did not: deleted it, or (for a test
   * file) left fewer test cases or assertions than the accepted version. The counts are a heuristic for
   * JavaScript and TypeScript tests; a file too large to read is treated as weakened (fail closed).
   */
  private async acceptedFileWeakening(worktreePath: string, filePath: string, acceptedCommit: string, resultCommit: string): Promise<string | undefined> {
    const read = (commit: string) => this.dependencies.getGitFileAtCommit(worktreePath, commit, filePath, MAX_WEAKENING_CHECK_BYTES)
      .then(content => content ?? null, () => undefined);
    const after = await read(resultCommit);
    if (after === undefined) return 'deleted a file';
    if (!TEST_FILE.test(filePath)) return undefined;
    const before = await read(acceptedCommit);
    if (before === null || after === null) return 'changed a test file too large to compare';
    if (before === undefined) return undefined;
    const count = (source: string, pattern: RegExp) => source.match(pattern)?.length ?? 0;
    if (count(after, TEST_CASE) < count(before, TEST_CASE)) return 'removed test cases';
    if (count(after, ASSERTION) < count(before, ASSERTION)) return 'removed assertions';
    return undefined;
  }

  /**
   * Which accepted task delivered each file in this task's repository (the later task when two did),
   * and which of those files are back at their accepted version at `resultCommit`.
   */
  private async acceptedPathOwnership(
    snapshot: OrchestrationSnapshot,
    task: OrchestrationTaskRecord,
    worktreePath: string,
    resultCommit: string
  ): Promise<{ owners: Map<string, { taskId: string; commit: string }>; restored: Set<string> }> {
    const owners = new Map<string, { taskId: string; commit: string }>();
    for (const acceptedTask of snapshot.tasks.filter(candidate => candidate.status === 'accepted' &&
      sameRepository((candidate.repository ?? snapshot.run.repository), (task.repository ?? snapshot.run.repository)))) {
      const acceptedAttempt = [...snapshot.attempts].reverse().find(candidate =>
        candidate.taskId === acceptedTask.id && candidate.status === 'accepted' && candidate.resultCommit);
      const acceptedEvidence = acceptedAttempt?.result?.acceptanceEvidence;
      const acceptedChangedPaths = acceptedEvidence && typeof acceptedEvidence === 'object'
        ? (acceptedEvidence as Record<string, unknown>).changedPaths
        : undefined;
      if (!acceptedAttempt?.resultCommit || !Array.isArray(acceptedChangedPaths)) continue;
      for (const acceptedPath of acceptedChangedPaths) {
        if (typeof acceptedPath === 'string') owners.set(acceptedPath, {
          taskId: acceptedTask.id, commit: acceptedAttempt.resultCommit
        });
      }
    }
    const pathsChangedSinceAccepted = new Map<string, Set<string>>();
    for (const acceptedCommit of new Set([...owners.values()].map(owner => owner.commit))) {
      pathsChangedSinceAccepted.set(acceptedCommit,
        new Set(await this.dependencies.getGitChangedPaths(worktreePath, acceptedCommit, resultCommit)));
    }
    const restored = new Set([...owners]
      .filter(([filePath, owner]) => !pathsChangedSinceAccepted.get(owner.commit)?.has(filePath))
      .map(([filePath]) => filePath));
    return { owners, restored };
  }

  private async finalValidation(
    snapshot: OrchestrationSnapshot,
    actorId: string,
    now?: string
  ): Promise<TaskAcceptanceOutcome> {
    const current = await this.store.getOrchestrationSnapshot(snapshot.run.id);
    if (!current) throw new Error('The orchestration run disappeared before final validation.');
    if (current.run.plan.milestones?.some(milestone => !current.run.plan.tasks.some(task => task.milestoneId === milestone.id))) {
      throw new Error('The approved milestone roadmap is incomplete; plan and accept its remaining work before final validation.');
    }
    const reportOnly = !current.tasks.some(task => isImplementationTask(task.kind));
    const repositoryResults: Array<Record<string, unknown> & { repository: string; worktree: string; branchName: string; resultCommit: string; baseCommit: string; cumulativeChangedPaths: string[]; verification: VerificationResult }> = [];
    for (const workspace of current.run.repositoryWorkspaces?.length
      ? current.run.repositoryWorkspaces
      : [repositoryWorkspaceForRun(current.run, current.run.repository)].filter((item): item is NonNullable<typeof item> => Boolean(item))) {
      const worktree = path.resolve(workspace.worktreePath);
      const auditProblem = finalDependencyAuditProblem(current, workspace.repository, worktree, this.store.getAgents());
      if (auditProblem) {
        const evidence = { validationVersion: 1, check: 'dependency_audit', repository: workspace.repository };
        const blocked = this.store.transitionOrchestrationRun({ runId: current.run.id, expectedRevision: current.run.revision, nextStatus: 'blocked', actorId, reason: auditProblem, evidence, now });
        return { decision: 'blocked', snapshot: blocked, reason: auditProblem, evidence };
      }
      const [branchName, currentCommit, clean] = await Promise.all([
        this.dependencies.getCurrentBranch(worktree), this.dependencies.getHeadCommit(worktree), this.dependencies.isGitWorkingTreeClean(worktree)
      ]);
      const taskCommits = current.attempts.filter(attempt => attempt.status === 'accepted' &&
        sameRepository(current.tasks.find(task => task.id === attempt.taskId)?.repository ?? current.run.repository, workspace.repository))
        .map(attempt => attempt.resultCommit).filter((value): value is string => Boolean(value));
      const latestTaskCommit = taskCommits[taskCommits.length - 1];
      if (branchName !== workspace.branchName || !clean || (latestTaskCommit && currentCommit !== latestTaskCommit)) {
        const reason = `The ${workspace.repository} branch changed after its last accepted task; final checks need a fresh review.`;
        const evidence = {
          validationVersion: 1, check: 'workspace_checkpoint', repository: workspace.repository,
          expectedBranch: workspace.branchName, branchName, expectedCommit: latestTaskCommit ?? workspace.baseCommit,
          resultCommit: currentCommit, workingTreeClean: clean
        };
        const blocked = this.store.transitionOrchestrationRun({ runId: current.run.id, expectedRevision: current.run.revision, nextStatus: 'blocked', actorId, reason, evidence, now });
        return { decision: 'blocked', snapshot: blocked, reason, evidence };
      }
      const cumulativeChangedPaths = await this.dependencies.getGitChangedPaths(worktree, workspace.baseCommit, currentCommit);
      const acceptedCodeTasks = current.tasks.filter(task => task.status === 'accepted' && isImplementationTask(task.kind) &&
        sameRepository((task.repository ?? current.run.repository), workspace.repository));
      const unownedPath = cumulativeChangedPaths.find(filePath => !acceptedCodeTasks.some(task => taskAllowsPath(task, filePath)));
      if (unownedPath) {
        const reason = `Final checks found ${unownedPath} in ${workspace.repository}, outside the accepted task assignments.`;
        const evidence = { validationVersion: 1, check: 'final_scope', repository: workspace.repository, changedPath: unownedPath, cumulativeChangedPaths };
        const blocked = this.store.transitionOrchestrationRun({ runId: current.run.id, expectedRevision: current.run.revision, nextStatus: 'blocked', actorId, reason, evidence, now });
        return { decision: 'blocked', snapshot: blocked, reason, evidence };
      }
      const requiredScripts = repositoryChecks(current.tasks.filter(task => task.required), workspace.repository, current.run.repository);
      let verification: VerificationResult;
      try {
        verification = reportOnly && !requiredScripts.length ? {
          status: 'passed', missingScripts: [], commands: [], summary: 'Accepted read-only reports; no source changes or assigned repository checks.'
        } : await this.dependencies.runVerification({
          runId: `orchestration-final-${current.run.id}-${Buffer.from(workspace.repository).toString('hex').slice(0, 16)}`,
          cwd: worktree,
          requiredScripts: requiredScripts.length ? requiredScripts : undefined
        });
      } catch (error) {
        const detail = safeRecoverySummary(error instanceof Error ? error.message : String(error));
        verification = {
          status: 'failed',
          missingScripts: [],
          commands: [],
          summary: `Alpha could not start final validation: ${detail || 'The verification service failed unexpectedly.'}`
        };
      }
      repositoryResults.push({ repository: workspace.repository, worktree, branchName, resultCommit: currentCommit, baseCommit: workspace.baseCommit, cumulativeChangedPaths, verification });
    }
    const primary = repositoryResults[0];
    const verification: VerificationResult = repositoryResults.length === 1 ? primary.verification : {
      status: repositoryResults.every(item => item.verification.status === 'passed') ? 'passed' : 'failed',
      missingScripts: repositoryResults.flatMap(item => item.verification.missingScripts.map(script => `${item.repository}: ${script}`)),
      commands: repositoryResults.flatMap(item => item.verification.commands),
      summary: repositoryResults.map(item => `${item.repository}: ${item.verification.summary}`).join('\n')
    };
    if (!primary) {
      const reason = 'No selected repository has a private build workspace to validate.';
      const evidence = { validationVersion: 1, check: 'workspace_missing' };
      const blocked = this.store.transitionOrchestrationRun({ runId: current.run.id, expectedRevision: current.run.revision, nextStatus: 'blocked', actorId, reason, evidence, now });
      return { decision: 'blocked', snapshot: blocked, reason, evidence };
    }
    const finalRepositoryEvidence = repositoryResults.map(item => ({
      repository: item.repository, baseCommit: item.baseCommit, resultCommit: item.resultCommit,
      branchName: item.branchName, cumulativeChangedPaths: item.cumulativeChangedPaths,
      checks: { status: item.verification.status, missingScripts: item.verification.missingScripts, observed: item.verification.commands.map(command => ({
        script: command.command.script, display: command.command.display, exitCode: command.exitCode, signal: command.signal,
        outputSummary: safeRecoveryGuidance(command.output).slice(0, 1_500)
      })) }
    }));
    const evidence = {
      validationVersion: 1,
      repository: primary.repository,
      resultCommit: primary.resultCommit,
      branchName: primary.branchName,
      repositories: finalRepositoryEvidence,
      acceptedRequiredTaskIds: current.tasks.filter(task => task.required && task.status === 'accepted').map(task => task.id),
      cumulativeChangedPaths: primary.cumulativeChangedPaths,
      checks: {
        status: verification.status,
        missingScripts: verification.missingScripts,
        observed: verification.commands.map(command => ({
          script: command.command.script,
          display: command.command.display,
          exitCode: command.exitCode,
          signal: command.signal,
          outputSummary: safeRecoveryGuidance(command.output).slice(0, 1_500)
        })),
        summary: verification.summary
      },
      noOpenBlockingFindings: !current.findings.some(finding => finding.status === 'open' && ['blocking', 'critical'].includes(finding.severity))
    };
    const reportNeedsNoChecks = reportOnly && current.tasks.every(task => !task.requiredChecks.length);
    if (verification.status !== 'passed' || verification.missingScripts.length || (!verification.commands.length && !reportNeedsNoChecks) || !evidence.noOpenBlockingFindings) {
      const reason = verification.summary.startsWith('Alpha could not start final validation:')
        ? verification.summary
        : verification.missingScripts.length
        ? `Final validation could not run required checks: ${verification.missingScripts.join(', ')}.`
        : verification.commands.length
          ? finalValidationBlockReason(repositoryResults, current.findings.filter(finding => finding.status === 'open' && ['blocking', 'critical'].includes(finding.severity)))
          : 'No configured automated checks were observed; add a validation path before approval.';
      const blocked = this.store.transitionOrchestrationRun({
        runId: current.run.id, expectedRevision: current.run.revision, nextStatus: 'blocked', actorId, reason,
        evidence, now
      });
      if (hasRepairableFinalValidationEvidence(evidence) && !current.run.pauseRequestedAt) {
        try {
          const amendment = buildFinalValidationAmendment(
            blocked,
            evidence,
            this.store.getAgents().filter(agent => !agent.isArchived).map(agent => ({ id: agent.id, role: agent.role }))
          );
          const repairing = await this.orchestration.amendFinalValidation({
            workspaceId: current.run.workspaceId,
            runId: current.run.id,
            expectedRunRevision: blocked.run.revision,
            actorId,
            amendment,
            evidence,
            now
          });
          if (repairing.run.status === 'executing' && repairing.run.currentTaskId) {
            return {
              decision: 'retrying', snapshot: repairing,
              reason: 'Final checks failed. Alpha routed a bounded correction to the affected code owner, followed by an independent review and fresh validation.'
            };
          }
          return {
            decision: 'blocked', snapshot: repairing,
            reason: repairing.run.stoppedReason ?? 'Alpha saved the correction plan but could not start its next specialist. Review the recovery details in project chat.'
          };
        } catch (error) {
          const detail = error instanceof Error ? error.message : 'Alpha could not safely plan an owner correction.';
          return {
            decision: 'blocked', snapshot: blocked,
            reason: `${reason} Alpha could not safely assign an automatic correction: ${detail}`,
            evidence: { ...evidence, automaticRepairError: detail }
          };
        }
      }
      return { decision: 'blocked', snapshot: blocked, reason, evidence };
    }
    const completedReport = reportOnly && repositoryResults.every(item => item.cumulativeChangedPaths.length === 0);
    const awaitingApproval = this.store.transitionOrchestrationRun({
      runId: current.run.id,
      expectedRevision: current.run.revision,
      nextStatus: completedReport ? 'completed' : 'awaiting_approval',
      actorId,
      evidence: completedReport ? { ...evidence, completionType: 'report_only' } : evidence,
      now
    });
    return { decision: completedReport ? 'completed' : 'awaiting_approval', snapshot: awaitingApproval, evidence };
  }
}
