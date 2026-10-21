import { createHash } from 'node:crypto';
import type { OrchestrationRecoveryActionName, OrchestrationRecoveryCategory } from '../models/index.js';
import { ALPHA_ORCHESTRATION_RECOVERY_WINDOW_MS } from '../config/env.js';
import type { OrchestrationSnapshot } from './orchestrationStateMachine.js';

/** Total execution attempts including the first specialist run; this permits two automatic repairs. */
export const AUTO_REPAIR_ATTEMPT_LIMIT = 3;
export const MAX_REPAIR_ATTEMPTS_PER_EPISODE = 4;
export const MAX_RECOVERY_GUIDANCE_CHARS = 2_000;
export const MAX_RECOVERY_EPISODE_MS = ALPHA_ORCHESTRATION_RECOVERY_WINDOW_MS;

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

export function workAttemptCount(snapshot: OrchestrationSnapshot, taskId: string): number {
  return snapshot.attempts.filter(attempt => attempt.taskId === taskId &&
    attempt.contextManifest.reportOnlyReportRetry !== true).length;
}

export function classifyRecoveryCategory(input: {
  reason: string;
  taskKind?: string;
  hasTask: boolean;
  hasReportError: boolean;
  finalValidation: boolean;
}): OrchestrationRecoveryCategory {
  const text = input.reason.toLowerCase();
  if (input.hasReportError) return 'report';
  if (/usage budget|token budget|cost budget|build age limit|elapsed.?time budget/i.test(text)) return 'budget';
  if (input.finalValidation) return 'final_validation';
  if (/review (?:package|input|source)|review input|read-only.*(?:unavailable|failed)|no usable source/i.test(text)) return 'review_input';
  if (/worktree|work tree|branch changed|unexpected head|dirty working|checkpoint|process.*(?:uncertain|stopped)|reconcil/i.test(text)) return 'workspace';
  if (/429|rate.?limit|quota|provider|network|connection|timed? ?out|authentication|credential|runtime.*(?:unavailable|not ready)|not signed in/i.test(text)) return 'provider';
  if (/setting|configuration|missing required|not configured|reconnect|install .*runtime/i.test(text)) return 'configuration';
  if (/orchestrator.*(?:disabled|unavailable)|alpha daemon|update the (?:desktop )?app/i.test(text)) return 'alpha';
  if (input.hasTask && ['implement', 'validate', 'review'].includes(input.taskKind ?? '')) return 'project_code';
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
}): { availableActions: OrchestrationRecoveryActionName[]; actionReasons: Partial<Record<OrchestrationRecoveryActionName, string>> } {
  const { snapshot, category, taskId, canControl, episodeAgeMs, repeatedFailure = false,
    finalValidationCorrectionReady = false } = input;
  const availableActions: OrchestrationRecoveryActionName[] = ['explain_failure', 'review_saved_changes'];
  const actionReasons: Partial<Record<OrchestrationRecoveryActionName, string>> = {};
  const task = taskId ? snapshot.tasks.find(item => item.id === taskId) : undefined;
  const attempts = task ? workAttemptCount(snapshot, task.id) : MAX_REPAIR_ATTEMPTS_PER_EPISODE;
  const canAct = canControl && !['completed', 'failed', 'cancelled'].includes(snapshot.run.status);
  if (!canControl) actionReasons.provide_guidance = 'Your project role can inspect this build but cannot change it.';
  if (episodeAgeMs > MAX_RECOVERY_EPISODE_MS) actionReasons.provide_guidance = 'This recovery is over one hour old. Review the saved build and start a fresh, explicitly scoped request if needed.';

  if (canAct && task && ['failed', 'blocked'].includes(task.status) && episodeAgeMs <= MAX_RECOVERY_EPISODE_MS) {
    if (category === 'project_code') {
      if (repeatedFailure && attempts < MAX_REPAIR_ATTEMPTS_PER_EPISODE) availableActions.push('provide_guidance');
      else if (attempts < AUTO_REPAIR_ATTEMPT_LIMIT) availableActions.push('repair_and_continue');
      else if (attempts < MAX_REPAIR_ATTEMPTS_PER_EPISODE) availableActions.push('provide_guidance');
      else actionReasons.provide_guidance = 'This build has used its four work attempts for this recovery. Review the saved changes before starting a new build.';
    } else if (category === 'provider' || category === 'configuration') {
      if (attempts < AUTO_REPAIR_ATTEMPT_LIMIT) availableActions.push('recheck_prerequisite');
      else actionReasons.recheck_prerequisite = 'The task has reached its two-attempt limit. Fix the runtime or access issue, then review the saved build before trying again.';
    } else if (category === 'review_input') {
      if (attempts < AUTO_REPAIR_ATTEMPT_LIMIT) availableActions.push('recheck_prerequisite');
      else actionReasons.recheck_prerequisite = 'The reviewer still cannot read the accepted source. Review the provider setup or saved work before trying again.';
    } else if (category === 'report') {
      actionReasons.repair_and_continue = 'The reviewer response needs a format correction. Open the report details to see the exact missing field.';
    } else if (category === 'workspace') {
      actionReasons.resume_checkpoint = 'The saved branch or process needs inspection before Alpha can continue safely.';
    } else if (category === 'final_validation') {
      actionReasons.recheck_prerequisite = 'Final checks need to be reviewed in the build plan before they can be repeated.';
    } else if (category === 'budget') {
      actionReasons.recheck_prerequisite = 'The build reached a configured limit. Change the corresponding ALPHA_ORCHESTRATION limit in Alpha’s desktop configuration, restart Alpha, then recheck to continue.';
    } else {
      if (attempts < AUTO_REPAIR_ATTEMPT_LIMIT) availableActions.push('repair_and_continue');
      else if (attempts < MAX_REPAIR_ATTEMPTS_PER_EPISODE) availableActions.push('provide_guidance');
    }
  }

  if (canAct && snapshot.run.status === 'recovery_required' && !snapshot.run.currentTaskId) {
    availableActions.push('resume_checkpoint');
  }
  if (canAct && snapshot.run.status === 'blocked' && category === 'final_validation' && !snapshot.run.currentTaskId &&
      snapshot.tasks.filter(item => item.required).every(item => item.status === 'accepted')) {
    availableActions.push('recheck_prerequisite');
    if (finalValidationCorrectionReady) availableActions.push('plan_final_validation_corrections');
    else actionReasons.plan_final_validation_corrections = 'The saved evidence does not map a failed check to a bounded, independent owner-and-review chain.';
  }
  if (canAct && snapshot.run.status === 'blocked' && category === 'budget' && !snapshot.run.currentTaskId &&
      episodeAgeMs <= MAX_RECOVERY_EPISODE_MS) {
    availableActions.push('recheck_prerequisite');
  }
  if (canAct && snapshot.run.status === 'blocked' && category === 'alpha' && !snapshot.run.currentTaskId &&
      /orchestrator is (?:disabled|unavailable)/i.test(snapshot.run.stoppedReason ?? '')) {
    availableActions.push('resume_checkpoint');
  }
  if (canAct && ['blocked', 'paused'].includes(snapshot.run.status)) availableActions.push('keep_paused');
  if (canAct && !['completed', 'failed', 'cancelled'].includes(snapshot.run.status)) availableActions.push('cancel_build');
  if (!task && category === 'final_validation' && canAct) {
    actionReasons.recheck_prerequisite = actionReasons.recheck_prerequisite ?? 'The saved validation evidence is available in the build plan.';
  }
  if (!task && category === 'budget' && canAct) {
    actionReasons.recheck_prerequisite = actionReasons.recheck_prerequisite ?? 'Change the corresponding ALPHA_ORCHESTRATION limit in Alpha’s desktop configuration, restart Alpha, then recheck to continue.';
  }
  return { availableActions: [...new Set(availableActions)], actionReasons };
}

export function safeRecoverySummary(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/(?:[a-z]:\\|\\\\[^\s]+|\/(?:Users|home|private|tmp|var|mnt)\/)[^\s,;)]*/gi, '[local path]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

export function safeRecoveryGuidance(value: string): string {
  return value
    .replace(/\b(bearer)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]')
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization)\b(\s*[:=]\s*)[^\s,;]+/gi, '$1$2[redacted]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/g, '[redacted token]')
    .trim()
    .slice(0, MAX_RECOVERY_GUIDANCE_CHARS);
}
