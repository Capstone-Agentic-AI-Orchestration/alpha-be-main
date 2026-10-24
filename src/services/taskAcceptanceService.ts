import { createHash } from 'node:crypto';
import path from 'node:path';
import { taskAuditEvidence, finalDependencyAuditProblem } from './orchestrationAuditEvidence.js';
import type { PrototypeRun, RunVerificationEvidence } from '../models/index.js';
import { normalizeAndValidateAgentReport } from './orchestrationAgentReport.js';
import { getCurrentBranch, getGitChangedPaths, getHeadCommit, isGitWorkingTreeClean } from '../utils/gitUtils.js';
import { runVerification, type VerificationResult } from './verificationService.js';
import { projectRunWorkspacePath } from './workspaceService.js';
import { runWithWorkspace } from './workspaceContext.js';
import { SQLiteService } from './sqliteService.js';
import { OrchestrationService } from './orchestrationService.js';
import { buildFinalValidationAmendment, buildOrchestrationReviewAmendment, OrchestrationReviewPlanError } from './orchestrationReviewWorkflow.js';
import type { OrchestrationAttemptRecord, OrchestrationSnapshot, OrchestrationTaskRecord } from './orchestrationStateMachine.js';
import { repositoryWorkspaceForRun, repositoryWorkspaceForTask } from './orchestrationWorkspace.js';
import { pathMatchesScope } from '../utils/pathScope.js';
import {
  AUTO_REPAIR_ATTEMPT_LIMIT,
  MAX_AUTOMATIC_REPORT_FORMAT_CORRECTIONS,
  hasRepeatedRecoveryFailure,
  hasRepairableFinalValidationEvidence,
  isAlphaOwnedGitBlocker,
  reportFormatCorrectionCount,
  safeRecoverySummary,
  safeRecoveryGuidance,
  workAttemptCount
} from './orchestrationRecoveryPolicy.js';
export { pathMatchesScope } from '../utils/pathScope.js';
export { isAlphaOwnedGitBlocker } from './orchestrationRecoveryPolicy.js';

export interface TaskAcceptanceOutcome {
  decision: 'accepted' | 'rejected' | 'blocked' | 'retrying' | 'awaiting_approval';
  snapshot: OrchestrationSnapshot;
  reason?: string;
  evidence?: Record<string, unknown>;
}

interface AcceptanceDependencies {
  getCurrentBranch: typeof getCurrentBranch;
  getHeadCommit: typeof getHeadCommit;
  isGitWorkingTreeClean: typeof isGitWorkingTreeClean;
  getGitChangedPaths: typeof getGitChangedPaths;
  worktreePathFor: typeof projectRunWorkspacePath;
  runVerification: typeof runVerification;
}

const CODE_TASK_KINDS = new Set(['database', 'backend', 'frontend', 'mobile']);
const REPORT_ONLY_CORRECTION_CHECKS = new Set([
  'agent_report', 'report_identity', 'review_findings_missing', 'duplicate_review_finding',
  'review_target', 'review_requirement', 'review_path_scope', 'review_finding_coverage',
  'requirement_coverage', 'acceptance_criteria', 'deliverable_traceability'
]);
const AUTOMATIC_CODE_REPAIR_CHECKS = new Set([
  'scope_violation', 'accepted_artifact_mutation', 'required_check', 'verification_failed'
]);

function taskAllowsPath(task: OrchestrationTaskRecord, filePath: string): boolean {
  return CODE_TASK_KINDS.has(task.kind) &&
    task.scope.includePaths.some(pattern => pathMatchesScope(filePath, pattern)) &&
    !task.scope.excludePaths.some(pattern => pathMatchesScope(filePath, pattern));
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

function reportChangeBaseline(
  snapshot: OrchestrationSnapshot,
  taskId: string,
  attempt: OrchestrationAttemptRecord
): string | undefined {
  if (attempt.contextManifest.reportOnlyReportRetry !== true) return attempt.startingCommit;
  const storedBaseline = attempt.contextManifest.reportOnlyBaselineCommit;
  if (typeof storedBaseline === 'string' && /^[a-f0-9]{40,64}$/i.test(storedBaseline)) return storedBaseline;
  const attemptIndex = snapshot.attempts.findIndex(item => item.id === attempt.id);
  for (let index = attemptIndex - 1; index >= 0; index -= 1) {
    const previous = snapshot.attempts[index];
    if (previous.taskId === taskId && previous.contextManifest.reportOnlyReportRetry !== true &&
        ['failed', 'rejected', 'recovery_required'].includes(previous.status) && previous.startingCommit) {
      return previous.startingCommit;
    }
  }
  return attempt.startingCommit;
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
                  startingCommit: reportChangeBaseline(rejected, task.id, attempt)
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
        const repairableCodeFailure = CODE_TASK_KINDS.has(task.kind) && rejection.findings.length > 0 &&
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
        if (!target || target.status !== 'accepted' || !CODE_TASK_KINDS.has(target.kind) || !root ||
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
    const unresolvedBlocker = report.blockers.find(blocker => !isAlphaOwnedGitBlocker(blocker));
    if (unresolvedBlocker) {
      return fail(`The specialist reported a blocker: ${unresolvedBlocker}`, {
        check: 'agent_blocker', blockers: report.blockers
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
    const diffStartingCommit = reportChangeBaseline(snapshot, task.id, attempt);
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
    const readOnlyTask = !CODE_TASK_KINDS.has(task.kind);
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
    const acceptedPathOwners = new Map<string, { taskId: string; commit: string }>();
    for (const acceptedTask of snapshot.tasks.filter(candidate => candidate.status === 'accepted' &&
      (candidate.repository ?? snapshot.run.repository).toLowerCase() === (task.repository ?? snapshot.run.repository).toLowerCase())) {
      const acceptedAttempt = [...snapshot.attempts].reverse().find(candidate =>
        candidate.taskId === acceptedTask.id && candidate.status === 'accepted' && candidate.resultCommit);
      const acceptedEvidence = acceptedAttempt?.result?.acceptanceEvidence;
      const acceptedChangedPaths = acceptedEvidence && typeof acceptedEvidence === 'object'
        ? (acceptedEvidence as Record<string, unknown>).changedPaths
        : undefined;
      if (!acceptedAttempt?.resultCommit || !Array.isArray(acceptedChangedPaths)) continue;
      for (const acceptedPath of acceptedChangedPaths) {
        if (typeof acceptedPath === 'string') acceptedPathOwners.set(acceptedPath, {
          taskId: acceptedTask.id, commit: acceptedAttempt.resultCommit
        });
      }
    }
    const acceptedCommits = new Set([...acceptedPathOwners.values()].map(owner => owner.commit));
    const pathsChangedSinceAccepted = new Map<string, Set<string>>();
    for (const acceptedCommit of acceptedCommits) {
      const changedSinceAccepted = await this.dependencies.getGitChangedPaths(worktreePath, acceptedCommit, attempt.resultCommit);
      pathsChangedSinceAccepted.set(acceptedCommit, new Set(changedSinceAccepted));
    }
    const restoredAcceptedPaths = new Set([...acceptedPathOwners]
      .filter(([filePath, owner]) => !pathsChangedSinceAccepted.get(owner.commit)?.has(filePath))
      .map(([filePath]) => filePath));
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
      // A persisted later milestone is an explicit scoped plan amendment. It may
      // evolve earlier accepted files, while same-milestone ownership stays strict.
      !(() => {
        const owner = snapshot.tasks.find(candidate => candidate.id === acceptedPathOwners.get(filePath)!.taskId);
        const milestones = snapshot.run.plan.milestones ?? [];
        const prior = milestones.findIndex(item => item.id === owner?.milestoneId);
        const current = milestones.findIndex(item => item.id === task.milestoneId);
        return prior >= 0 && current > prior && taskAllowsPath(task, filePath);
      })() &&
      !(task.correctionOfTaskId && correctionPaths.has(filePath) &&
        correctionLineageTaskIds.has(acceptedPathOwners.get(filePath)!.taskId) && taskAllowsPath(task, filePath)));
    if (modifiedAcceptedPath) {
      const owner = acceptedPathOwners.get(modifiedAcceptedPath)!;
      return fail(`This task changed ${modifiedAcceptedPath}, which belongs to already accepted task ${owner.taskId}. Restore the accepted artifact or request a plan amendment.`, {
        check: 'accepted_artifact_mutation', changedPath: modifiedAcceptedPath,
        acceptedTaskId: owner.taskId, acceptedCommit: owner.commit
      }, modifiedAcceptedPath);
    }
    const scopeOwners = snapshot.tasks.filter(candidate =>
      (candidate.status === 'accepted' || candidate.id === task.id) &&
      (candidate.repository ?? snapshot.run.repository).toLowerCase() === (task.repository ?? snapshot.run.repository).toLowerCase());
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
    const requiredChecks = task.requiredChecks;
    const failedCheck = requiredChecks.find(script => missingScripts.includes(script) ||
      !observedCommands.some(command => command.script === script && command.exitCode === 0 && command.signal === null));
    if (failedCheck) {
      return fail(`Required check “${failedCheck}” was not observed passing on this attempt.`, {
        check: 'required_check', requiredScript: failedCheck, missingScripts, observedCommands
      });
    }
    if (CODE_TASK_KINDS.has(task.kind) && (!verification || verification.status !== 'passed' || !observedCommands.length || missingScripts.length)) {
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
    const changedPaths = attempt.startingCommit && attempt.resultCommit
      ? await this.dependencies.getGitChangedPaths(worktree,
        reportChangeBaseline(snapshot, task.id, attempt) ?? attempt.startingCommit, attempt.resultCommit)
      : [];
    return {
      acceptanceVersion: 1,
      attemptId: attempt.id,
      diffStartingCommit: reportChangeBaseline(snapshot, task.id, attempt) ?? attempt.startingCommit,
      artifactId: snapshot.artifacts.find(item => item.attemptId === attempt.id && item.type === 'task_result')?.id,
      resultCommit: attempt.resultCommit,
      currentHead: attempt.resultCommit,
      branchName: authorizedWorkspace.branchName,
      repository: authorizedWorkspace.repository,
      changedPaths,
      cumulativeChangedPaths: authorizedWorkspace.baseCommit && attempt.resultCommit
        ? await this.dependencies.getGitChangedPaths(worktree, authorizedWorkspace.baseCommit, attempt.resultCommit)
        : [],
      scope: { includePaths: task.scope.includePaths, excludePaths: task.scope.excludePaths, passed: true },
      requiredChecks: task.requiredChecks,
      verification: attempt.result?.verification,
      semanticReviewRequired: CODE_TASK_KINDS.has(task.kind),
      ...(task.dependencyAudit ? { dependencyAudits: taskAuditEvidence(snapshot, task, attempt, worktree,
        validateAttemptReport(attempt).success ? (attempt.result?.agentReport as { auditEvidenceIds?: string[] }).auditEvidenceIds : undefined) } : {})
    };
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
        (current.tasks.find(task => task.id === attempt.taskId)?.repository ?? current.run.repository).toLowerCase() === workspace.repository.toLowerCase())
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
      const acceptedCodeTasks = current.tasks.filter(task => task.status === 'accepted' && CODE_TASK_KINDS.has(task.kind) &&
        (task.repository ?? current.run.repository).toLowerCase() === workspace.repository.toLowerCase());
      const unownedPath = cumulativeChangedPaths.find(filePath => !acceptedCodeTasks.some(task => taskAllowsPath(task, filePath)));
      if (unownedPath) {
        const reason = `Final checks found ${unownedPath} in ${workspace.repository}, outside the accepted task assignments.`;
        const evidence = { validationVersion: 1, check: 'final_scope', repository: workspace.repository, changedPath: unownedPath, cumulativeChangedPaths };
        const blocked = this.store.transitionOrchestrationRun({ runId: current.run.id, expectedRevision: current.run.revision, nextStatus: 'blocked', actorId, reason, evidence, now });
        return { decision: 'blocked', snapshot: blocked, reason, evidence };
      }
      const requiredScripts = [...new Set(current.tasks.filter(task => task.required &&
        (task.repository ?? current.run.repository).toLowerCase() === workspace.repository.toLowerCase()).flatMap(task => task.requiredChecks))];
      let verification: VerificationResult;
      try {
        verification = await this.dependencies.runVerification({
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
    if (verification.status !== 'passed' || verification.missingScripts.length || !verification.commands.length || !evidence.noOpenBlockingFindings) {
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
    const awaitingApproval = this.store.transitionOrchestrationRun({
      runId: current.run.id,
      expectedRevision: current.run.revision,
      nextStatus: 'awaiting_approval',
      actorId,
      evidence,
      now
    });
    return { decision: 'awaiting_approval', snapshot: awaitingApproval, evidence };
  }
}
