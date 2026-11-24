import { createHash } from 'node:crypto';
import { isImplementationTask } from './agentRoleContracts.js';
import type { OrchestrationRecoveryActionName, OrchestrationRecoveryCategory } from '../models/index.js';
import type { OrchestrationSnapshot } from './orchestrationStateMachine.js';

/** Total execution attempts including the first specialist run; this permits two automatic repairs. */
export const AUTO_REPAIR_ATTEMPT_LIMIT = 3;
export const MAX_REPAIR_ATTEMPTS_PER_EPISODE = 4;

/**
 * Acceptance checks a report-only correction can fix (no code changes). Acceptance corrects
 * these automatically and recovery classifies them as report problems; one list, so a check
 * corrected automatically is never later treated as a code failure.
 */
export const REPORT_FORMAT_CHECKS: ReadonlySet<string> = new Set([
  'agent_report', 'report_identity', 'review_findings_missing', 'duplicate_review_finding',
  'review_target', 'review_requirement', 'review_path_scope', 'review_finding_coverage',
  'requirement_coverage', 'acceptance_criteria', 'deliverable_traceability'
]);
/** Alpha may ask the same specialist twice to correct a report without touching code. */
export const MAX_AUTOMATIC_REPORT_FORMAT_CORRECTIONS = 2;
/** Keep one additional correction available only after the developer reviews the escalation. */
export const MAX_REPORT_FORMAT_CORRECTIONS = MAX_AUTOMATIC_REPORT_FORMAT_CORRECTIONS + 1;
export const MAX_RECOVERY_GUIDANCE_CHARS = 2_000;

export function reportFormatCorrectionCount(snapshot: OrchestrationSnapshot, taskId: string): number {
  return snapshot.attempts.filter(attempt => attempt.taskId === taskId &&
    attempt.contextManifest.reportOnlyReportRetry === true).length;
}

export function hasRepairableFinalValidationEvidence(evidence: Record<string, unknown> | undefined): boolean {
  if (!evidence || evidence.validationVersion !== 1 || evidence.check !== undefined) return false;
  const checks = evidence.checks && typeof evidence.checks === 'object'
    ? evidence.checks as Record<string, unknown>
    : undefined;
  if (!checks || checks.status !== 'failed' ||
      (Array.isArray(checks.missingScripts) && checks.missingScripts.length > 0)) return false;
  const observed = Array.isArray(checks.observed) ? checks.observed as Array<Record<string, unknown>> : [];
  return observed.some(check => check.exitCode !== 0 || check.signal != null);
}

export function recoveryFailureFingerprint(category: OrchestrationRecoveryCategory, summary: string): string {
  const normalized = summary.toLowerCase().replace(/\b\d+\b/g, '#').replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(`${category}:${normalized}`).digest('hex');
}

export function hasRepeatedRecoveryFailure(
  snapshot: OrchestrationSnapshot,
  taskId: string,
  category: OrchestrationRecoveryCategory,
  summary: string
): boolean {
  const fingerprint = recoveryFailureFingerprint(category, summary);
  return snapshot.attempts.filter(attempt => attempt.taskId === taskId &&
    ['failed', 'rejected', 'recovery_required'].includes(attempt.status) &&
    recoveryFailureFingerprint(category, attempt.failureReason ??
      (typeof attempt.result?.rejectionReason === 'string' ? attempt.result.rejectionReason : '')) === fingerprint
  ).length >= 2;
}

export const SPECIALIST_BLOCKER_PREFIX = 'The specialist reported a blocker:';
/** How acceptance words a task a tool stopped (taskAcceptanceService); kept here so both agree. */
export const TOOL_BLOCKER_PREFIX = 'A tool stopped the specialist:';

/**
 * A blocker that only says the agent's own git staging or commit was refused. The build
 * worktree's git metadata sits outside the agent's sandbox, and Alpha commits the work as
 * a checkpoint after the run, so this never stops a task.
 */
export function isAlphaOwnedGitBlocker(blocker: string): boolean {
  return /\bgit\s+(?:add|commit|stage)\b[\s\S]*\b(?:refused|denied|permission|unable|fatal|not permitted)\b|index\.lock/i.test(blocker);
}

/** A specialist blocker that is only a refused git write, which Alpha handles itself. */
export function isAlphaOwnedGitFailure(reason: string | undefined): boolean {
  const text = reason?.trim() ?? '';
  return text.startsWith(SPECIALIST_BLOCKER_PREFIX) && isAlphaOwnedGitBlocker(text.slice(SPECIALIST_BLOCKER_PREFIX.length));
}

/**
 * A blocker that is a tool or environment failure, not missing information: a file tool that
 * refused a change, a guard that did not match, a permission error, a timeout. Another try,
 * with the error, usually gets past it, so it is retried instead of waiting for the person.
 */
export function isToolOrEnvironmentBlocker(blocker: string): boolean {
  return /\b(?:tool|guard)\b[\s\S]{0,120}\b(?:rejected|refused|denied|did not match|didn't match|failed|errored)\b/i.test(blocker) ||
    /\b(?:rejected|refused)\b[\s\S]{0,60}\b(?:edit|write|replacement|replace|delete)\b/i.test(blocker) ||
    /\bexact[- ]content\b|\bold_text\b|\bexpected_content\b/i.test(blocker) ||
    /\b(?:EPERM|EACCES|ENOENT|EBUSY|ETIMEDOUT)\b|\btimed? ?out\b|\bsandbox\b|permission denied/i.test(blocker);
}

/**
 * A task that stopped with work left in its build copy that no checkpoint recorded: edits made
 * after the report, or a runner that finished without a checkpoint commit. Retrying the same
 * task keeps that work (the runner adapter saves it aside and restores it), so it can continue.
 */
export function isLeftoverWorkFailure(reason: string | undefined): boolean {
  return /uncheckpointed edits|without a verifiable checkpoint commit/i.test(reason ?? '');
}

/** A build stopped between tasks while planning or saving its next step; resuming repeats that step. */
export function isBetweenTasksStop(stoppedReason: string | undefined): boolean {
  return /^(?:Milestone planning stopped before dispatch|Plan document could not be saved before dispatch)/i.test(stoppedReason?.trim() ?? '');
}

/** A task stopped by a tool or environment failure, as reported by the specialist or classified by acceptance. */
export function isToolFailure(reason: string | undefined): boolean {
  const text = reason?.trim() ?? '';
  return text.startsWith(TOOL_BLOCKER_PREFIX) ||
    (text.startsWith(SPECIALIST_BLOCKER_PREFIX) && isToolOrEnvironmentBlocker(text.slice(SPECIALIST_BLOCKER_PREFIX.length)));
}

/** The specialist stopped because it lacks information, not because its code or a tool failed. */
export function isSpecialistBlocker(reason: string | undefined): boolean {
  const text = reason?.trim() ?? '';
  return text.startsWith(SPECIALIST_BLOCKER_PREFIX) && !isAlphaOwnedGitFailure(reason) &&
    !isToolOrEnvironmentBlocker(text.slice(SPECIALIST_BLOCKER_PREFIX.length));
}

/** "continue", "go ahead", "fix it" and similar carry no new information for a blocked specialist. */
export function isContentFreeDirection(guidance: string | undefined): boolean {
  const text = (guidance ?? '').trim().toLowerCase().replace(/[.!\s]+$/g, '');
  return !text || /^(?:please\s+)?(?:continue|go ahead|go on|keep going|carry on|proceed|resume|retry|try again|fix(?: it)?(?: and continue)?|fix and continue|continue with the plan|continue the plan|do it|ok(?:ay)?|yes)(?:\s+please)?$/.test(text);
}

export function specialistBlockerDirectionMessage(reason: string): string {
  const blocker = reason.trim().slice(SPECIALIST_BLOCKER_PREFIX.length).trim();
  return `The specialist needs information it does not have: ${blocker} Sending the same task again will stop at the same point. Reply with the missing detail, or stop this build and ask again so the Orchestrator plans with it in mind.`;
}

export function workAttemptCount(snapshot: OrchestrationSnapshot, taskId: string): number {
  // An attempt that ended without ever reaching a specialist (preparation refused it, or
  // Alpha restarted before the launch) did no work, so it does not spend the repair budget.
  // Without this, a stalled launch and a refused preparation used the last retries and
  // left the build with no way forward.
  const total = totalWorkAttemptCount(snapshot, taskId);
  const boundary = Math.max(0, ...(snapshot.recoveryAuthorizations ?? []).filter(item => item.taskId === taskId).map(item => item.afterWorkAttempts));
  return Math.max(0, total - boundary);
}

export function totalWorkAttemptCount(snapshot: OrchestrationSnapshot, taskId: string): number {
  return snapshot.attempts.filter(attempt => attempt.taskId === taskId &&
    attempt.contextManifest.reportOnlyReportRetry !== true &&
    !(!attempt.prototypeRunId && ['failed', 'cancelled'].includes(attempt.status))).length;
}

export function classifyRecoveryCategory(input: {
  reason: string;
  taskKind?: string;
  hasTask: boolean;
  hasReportError: boolean;
  finalValidation: boolean;
}): OrchestrationRecoveryCategory {
  const text = input.reason.toLowerCase();
  // The working copy and its checkpoint are gone: a workspace problem that no retry can fix.
  if (text.trim().startsWith('build working copy lost:')) return 'workspace';
  if (/usage budget|token budget|cost budget|build age limit|elapsed.?time budget/i.test(text)) return 'budget';
  if (input.finalValidation) return 'final_validation';
  if (/audit evidence.{0,80}(?:not produced|missing|stale|failed)|audit report must reference completed tool evidence/i.test(text)) return 'alpha';
  // A review can first produce an invalid report, then a valid report that
  // identifies a real input blocker. Older open report findings must not hide
  // that newer blocker or strand the build in the report-correction path.
  if (input.taskKind === 'review' && /(?:could not|cannot|can't|unable to).{0,80}(?:inspect|read|access)|(?:inspection|read access|repository reads?|repository access).{0,100}(?:blocked|denied|unavailable|failed|required)/i.test(text)) {
    return 'review_input';
  }
  if (input.hasReportError) return 'report';
  if (/review (?:package|input|source)|review input|read-only.*(?:unavailable|failed)|no usable source/i.test(text)) return 'review_input';
  if (/\beacces\b|\beperm\b|permission denied|access denied|disk full|\benospc\b|read.only file system/i.test(text)) return 'workspace';
  if (/\benoent\b|missing executable|command not found|runtime.*(?:missing|not found)|persona.*(?:missing|unavailable)/i.test(text)) return 'configuration';
  if (/worktree|work tree|branch changed|unexpected head|dirty working|checkpoint|process.*(?:uncertain|stopped)|reconcil/i.test(text)) return 'workspace';
  if (/429|rate.?limit|quota|provider|network|connection|timed? ?out|authentication|credential|runtime.*(?:unavailable|not ready)|not signed in/i.test(text)) return 'provider';
  if (/setting|configuration|missing required|not configured|reconnect|install .*runtime/i.test(text)) return 'configuration';
  if (/orchestrator.*(?:disabled|unavailable)|alpha daemon|update the (?:desktop )?app/i.test(text)) return 'alpha';
  if (/alpha could not (?:complete|finish|safely verify).*acceptance checks|acceptance system failure/i.test(text)) return 'alpha';
  if (input.hasTask && isImplementationTask(input.taskKind ?? '')) return 'project_code';
  return 'unknown';
}

export function recoveryErrorCode(category: OrchestrationRecoveryCategory, source: string): string {
  const safe = `${source}_${category}`.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return safe.slice(0, 80) || 'unknown_failure';
}

export function recoveryAvailableActions(input: {
  snapshot: OrchestrationSnapshot;
  category: OrchestrationRecoveryCategory;
  taskId?: string;
  canControl: boolean;
  episodeAgeMs: number;
  repeatedFailure?: boolean;
  finalValidationCorrectionReady?: boolean;
  finalValidationCorrectionReason?: string;
  /** The Orchestrator's verified fix, held back for the person (a sensitive area or strict autonomy). */
  proposedFixReady?: boolean;
}): { availableActions: OrchestrationRecoveryActionName[]; actionReasons: Partial<Record<OrchestrationRecoveryActionName, string>> } {
  const { snapshot, category, taskId, canControl, episodeAgeMs, repeatedFailure = false,
    finalValidationCorrectionReady = false, finalValidationCorrectionReason, proposedFixReady = false } = input;
  const availableActions: OrchestrationRecoveryActionName[] = ['explain_failure', 'review_saved_changes'];
  const actionReasons: Partial<Record<OrchestrationRecoveryActionName, string>> = {};
  const task = taskId ? snapshot.tasks.find(item => item.id === taskId) : undefined;
  const attempts = task ? workAttemptCount(snapshot, task.id) : MAX_REPAIR_ATTEMPTS_PER_EPISODE;
  const latestFailedAttempt = task ? [...snapshot.attempts].reverse().find(attempt =>
    attempt.taskId === task.id && ['failed', 'rejected', 'recovery_required'].includes(attempt.status)) : undefined;
  const failedDuringPreparation = latestFailedAttempt?.contextManifest.orchestrationPreparationFailed === true;
  const failedDuringAcceptanceInfrastructure = task && snapshot.findings.some(finding =>
    finding.taskId === task.id && finding.status === 'open' && finding.evidence.check === 'acceptance_system');
  const preparationFailureReason = latestFailedAttempt?.failureReason ?? '';
  // "uncheckpointed changes" is a stopped attempt's leftovers, which the next preparation
  // saves aside; only a checkpoint mismatch itself keeps the build waiting for inspection.
  const preparationCheckpointIsUncertain = /\bcheckpoint|unexpected head|branch changed|dirty working|process.*(?:uncertain|active|stopped)|outside the run.scoped|not authorized/i.test(preparationFailureReason);
  const canAct = canControl && !['completed', 'failed', 'cancelled'].includes(snapshot.run.status);
  if (!canControl) actionReasons.provide_guidance = 'Your project role can inspect this build but cannot change it.';
  // Recovery episodes are durable. Their age alone does not invalidate a saved
  // checkpoint; retryTask and the runner adapter revalidate workspace identity.
  void episodeAgeMs;
  if (canAct && task && ['failed', 'blocked'].includes(task.status) && isAlphaOwnedGitFailure(latestFailedAttempt?.failureReason)) {
    // The agent tried to commit, which Alpha does for it; the work itself can simply be retried.
    if (attempts < AUTO_REPAIR_ATTEMPT_LIMIT) availableActions.push('repair_and_continue');
    else if (attempts < MAX_REPAIR_ATTEMPTS_PER_EPISODE) availableActions.push('provide_guidance');
  } else if (canAct && task && ['failed', 'blocked'].includes(task.status)) {
    // A blocker the specialist reported itself is answered with direction whatever its wording
    // classifies as ("permission denied" reads as a workspace problem), so the person can
    // always tell the agent how to proceed or simply retry.
    if (isSpecialistBlocker(latestFailedAttempt?.failureReason) && !['budget', 'final_validation', 'report'].includes(category)) {
      // A retry without new information meets the same blocker, so ask for the missing detail.
      if (attempts < MAX_REPAIR_ATTEMPTS_PER_EPISODE) {
        availableActions.push('provide_guidance');
        actionReasons.repair_and_continue = specialistBlockerDirectionMessage(latestFailedAttempt!.failureReason!);
      } else {
        actionReasons.provide_guidance = 'This build has used its four work attempts for this recovery. Review saved work on this task to inspect a bounded recovery restart. Overall budgets still apply.';
      }
    } else if (isToolFailure(latestFailedAttempt?.failureReason) && !['budget', 'final_validation', 'report'].includes(category)) {
      // A refused tool call or an environment error: another try usually gets past it, and the
      // person may add direction. Whatever its wording classifies as, it never leaves no action.
      if (attempts < AUTO_REPAIR_ATTEMPT_LIMIT) availableActions.push('repair_and_continue');
      if (attempts < MAX_REPAIR_ATTEMPTS_PER_EPISODE) availableActions.push('provide_guidance');
      else actionReasons.provide_guidance = 'This build has used its four work attempts for this recovery. Review saved work on this task to inspect a bounded recovery restart. Overall budgets still apply.';
    } else if (isLeftoverWorkFailure(latestFailedAttempt?.failureReason) && ['workspace', 'project_code', 'unknown'].includes(category)) {
      // Work the checkpoint did not record: the same specialist continues with it kept.
      if (attempts < MAX_REPAIR_ATTEMPTS_PER_EPISODE) availableActions.push('repair_and_continue');
      else actionReasons.repair_and_continue = 'This build has used its four work attempts for this recovery. Review saved work on this task to inspect a bounded recovery restart. Overall budgets still apply.';
    } else if (category === 'project_code') {
      if (repeatedFailure && attempts < MAX_REPAIR_ATTEMPTS_PER_EPISODE) availableActions.push('provide_guidance');
      else if (attempts < AUTO_REPAIR_ATTEMPT_LIMIT) availableActions.push('repair_and_continue');
      else if (attempts < MAX_REPAIR_ATTEMPTS_PER_EPISODE) availableActions.push('provide_guidance');
      else actionReasons.provide_guidance = 'This build has used its four work attempts for this recovery. Review saved work on this task to inspect a bounded recovery restart. Overall budgets still apply.';
    } else if (category === 'provider' || category === 'configuration') {
      if (attempts < AUTO_REPAIR_ATTEMPT_LIMIT) availableActions.push('recheck_prerequisite');
      else if (attempts < MAX_REPAIR_ATTEMPTS_PER_EPISODE) availableActions.push('provide_guidance');
      else actionReasons.recheck_prerequisite = `The task has used ${attempts} work attempts. Review the runtime or access issue and saved work before authorizing recovery.`;
    } else if (category === 'review_input') {
      if (attempts < AUTO_REPAIR_ATTEMPT_LIMIT) availableActions.push('recheck_prerequisite');
      else actionReasons.recheck_prerequisite = 'The reviewer still cannot read the accepted source. Review the provider setup or saved work before trying again.';
    } else if (category === 'report') {
      if (reportFormatCorrectionCount(snapshot, task.id) < MAX_REPORT_FORMAT_CORRECTIONS) {
        availableActions.push('retry_report_format');
      } else {
        actionReasons.retry_report_format = 'Alpha has used two automatic report-only corrections and one developer-authorized correction for this task. Review the exact field error and saved responses before starting a new build.';
      }
    } else if (category === 'workspace') {
      if ((failedDuringPreparation || failedDuringAcceptanceInfrastructure) && !preparationCheckpointIsUncertain &&
          attempts < AUTO_REPAIR_ATTEMPT_LIMIT) {
        availableActions.push('recheck_prerequisite');
      } else {
        actionReasons.resume_checkpoint = 'The saved branch or process needs inspection before Alpha can continue safely.';
      }
    } else if (category === 'final_validation') {
      actionReasons.recheck_prerequisite = 'Final checks need to be reviewed in the build plan before they can be repeated.';
    } else if (category === 'budget') {
      actionReasons.recheck_prerequisite = 'Execution budget reached. Review saved work and the configured desktop execution limit before retrying.';
    } else {
      if (attempts < AUTO_REPAIR_ATTEMPT_LIMIT) availableActions.push('repair_and_continue');
      else if (attempts < MAX_REPAIR_ATTEMPTS_PER_EPISODE) availableActions.push('provide_guidance');
    }
  }

  // The Orchestrator's verified fix runs through the same guided retry and acceptance gate as
  // direction the person types, so it is offered exactly where that direction would be.
  if (proposedFixReady && canAct && task && ['failed', 'blocked'].includes(task.status)) {
    if (attempts < MAX_REPAIR_ATTEMPTS_PER_EPISODE) availableActions.push('apply_proposed_fix');
    else actionReasons.apply_proposed_fix = 'This build has used its four work attempts for this recovery. Review saved work on this task to inspect a bounded recovery restart. Overall budgets still apply.';
  }
  if (canAct && snapshot.run.status === 'recovery_required' && !snapshot.run.currentTaskId) {
    availableActions.push('resume_checkpoint');
  }
  if (canAct && snapshot.run.status === 'blocked' && category === 'final_validation' && !snapshot.run.currentTaskId &&
      snapshot.tasks.filter(item => item.required).every(item => item.status === 'accepted')) {
    availableActions.push('recheck_prerequisite');
    if (finalValidationCorrectionReady) availableActions.push('plan_final_validation_corrections');
    else actionReasons.plan_final_validation_corrections = finalValidationCorrectionReason ??
      'The saved evidence does not map a failed check to a bounded, independent owner-and-review chain.';
  }
  if (canAct && snapshot.run.status === 'blocked' && category === 'budget' && !snapshot.run.currentTaskId) {
    availableActions.push('recheck_prerequisite');
  }
  if (canAct && snapshot.run.status === 'blocked' && category === 'alpha' && !snapshot.run.currentTaskId &&
      /orchestrator is (?:disabled|unavailable)/i.test(snapshot.run.stoppedReason ?? '')) {
    availableActions.push('resume_checkpoint');
  }
  // Stopped between tasks (planning the next milestone, saving its plan): continuing repeats that step.
  if (canAct && snapshot.run.status === 'blocked' && !snapshot.run.currentTaskId && isBetweenTasksStop(snapshot.run.stoppedReason) &&
      !availableActions.includes('resume_checkpoint')) {
    availableActions.push('resume_checkpoint');
  }
  if (canAct && ['blocked', 'paused'].includes(snapshot.run.status)) availableActions.push('keep_paused');
  if (canAct && !['completed', 'failed', 'cancelled'].includes(snapshot.run.status)) availableActions.push('cancel_build');
  if (!task && category === 'final_validation' && canAct) {
    actionReasons.recheck_prerequisite = actionReasons.recheck_prerequisite ?? 'The saved validation evidence is available in the build plan.';
  }
  if (!task && category === 'budget' && canAct) {
    actionReasons.recheck_prerequisite = actionReasons.recheck_prerequisite ?? 'Review saved work and the configured desktop execution limit before retrying.';
  }
  return { availableActions: [...new Set(availableActions)], actionReasons };
}

/**
 * Removes what must never leave this machine or reach a person's screen: control characters,
 * private key blocks, local paths, bearer tokens, credential values, provider tokens and
 * credentials in URLs. Keeps line breaks, tabs and length, so each caller decides its own shape.
 * Every recovery text (summaries, direction, the Orchestrator's fixes and evidence) goes through it.
 */
export function redactSensitiveText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi, '[redacted private key]')
    .replace(/(?:[a-z]:\\|\\\\[^\s]+|\/(?:Users|home|private|tmp|var|mnt)\/)[^\s,;)]*/gi, '[local path]')
    .replace(/\b(bearer)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]')
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|password|passwd|secret|authorization)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1$2[redacted]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/g, '[redacted token]')
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@');
}

/** One short line: redacted, whitespace collapsed, at most 500 characters. */
export function safeRecoverySummary(value: string): string {
  return redactSensitiveText(value)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

/** Direction for a specialist (the person's or the Orchestrator's fix): redacted, line breaks kept. */
export function safeRecoveryGuidance(value: string): string {
  return redactSensitiveText(value)
    .trim()
    .slice(0, MAX_RECOVERY_GUIDANCE_CHARS);
}
