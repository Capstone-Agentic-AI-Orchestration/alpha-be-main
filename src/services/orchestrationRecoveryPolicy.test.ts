import { describe, expect, it } from 'vitest';
import type { OrchestrationSnapshot } from './orchestrationStateMachine.js';
import { classifyRecoveryCategory, recoveryAvailableActions, safeRecoverySummary } from './orchestrationRecoveryPolicy.js';

function blockedReviewSnapshot(reportOnlyRetries: number): OrchestrationSnapshot {
  return {
    run: { status: 'blocked' },
    tasks: [{ id: 'review-calculator', status: 'failed' }],
    attempts: Array.from({ length: reportOnlyRetries }, (_, index) => ({
      taskId: 'review-calculator',
      contextManifest: { reportOnlyReportRetry: true },
      id: `report-retry-${index}`
    })),
    findings: []
  } as unknown as OrchestrationSnapshot;
}

describe('orchestration recovery classification and report retry', () => {
  it('routes a reviewer that could not read its assigned material to review-input recovery', () => {
    expect(classifyRecoveryCategory({
      reason: 'The reviewer could not inspect the supplied source because repository reads were blocked.',
      taskKind: 'review',
      hasTask: true,
      hasReportError: false,
      finalValidation: false
    })).toBe('review_input');
  });

  it('prioritizes a current repository-access blocker over stale report-format findings', () => {
    const reason = 'The specialist reported a blocker: Repository read access is required to inspect the current source and tests and complete the independent review.';
    const category = classifyRecoveryCategory({
      reason,
      taskKind: 'review',
      hasTask: true,
      hasReportError: true,
      finalValidation: false
    });
    const recovery = recoveryAvailableActions({
      snapshot: blockedReviewSnapshot(3),
      category,
      taskId: 'review-calculator',
      canControl: true,
      episodeAgeMs: 0
    });

    expect(category).toBe('review_input');
    expect(recovery.availableActions).toContain('recheck_prerequisite');
    expect(recovery.availableActions).not.toContain('retry_report_format');
  });

  it('classifies local permission and missing-runtime preparation errors before offering code repair', () => {
    expect(classifyRecoveryCategory({
      reason: 'spawn git ENOENT', taskKind: 'backend', hasTask: true, hasReportError: false, finalValidation: false
    })).toBe('configuration');
    expect(classifyRecoveryCategory({
      reason: 'EACCES: permission denied opening the saved worktree', taskKind: 'backend', hasTask: true,
      hasReportError: false, finalValidation: false
    })).toBe('workspace');
  });

  it('redacts credentials and local paths from chat-safe recovery details', () => {
    const safe = safeRecoverySummary('Request failed for https://builder:supersecret@example.test/api with Authorization: Bearer ghp_12345678901234567890 at C:\\Users\\Francis\\repo');
    expect(safe).not.toContain('supersecret');
    expect(safe).not.toContain('ghp_12345678901234567890');
    expect(safe).not.toContain('C:\\Users\\Francis');
    expect(safe).toContain('[redacted]');
    expect(safe).toContain('[local path]');
  });

  it('offers bounded rechecks after a saved workspace-preparation failure', () => {
    const snapshot = {
      run: { status: 'blocked' },
      tasks: [{ id: 'implement', status: 'blocked' }],
      attempts: [{ id: 'attempt-1', taskId: 'implement', status: 'failed', contextManifest: { orchestrationPreparationFailed: true } }],
      findings: []
    } as unknown as OrchestrationSnapshot;
    const available = recoveryAvailableActions({
      snapshot, category: 'workspace', taskId: 'implement', canControl: true, episodeAgeMs: 0
    });
    expect(available.availableActions).toContain('recheck_prerequisite');
  });

  it('offers a bounded report-only correction and removes it after the limit', () => {
    const available = recoveryAvailableActions({
      snapshot: blockedReviewSnapshot(0), category: 'report', taskId: 'review-calculator',
      canControl: true, episodeAgeMs: 0
    });
    const developerDecision = recoveryAvailableActions({
      snapshot: blockedReviewSnapshot(2), category: 'report', taskId: 'review-calculator',
      canControl: true, episodeAgeMs: 0
    });
    const exhausted = recoveryAvailableActions({
      snapshot: blockedReviewSnapshot(3), category: 'report', taskId: 'review-calculator',
      canControl: true, episodeAgeMs: 0
    });

    expect(available.availableActions).toContain('retry_report_format');
    expect(developerDecision.availableActions).toContain('retry_report_format');
    expect(exhausted.availableActions).not.toContain('retry_report_format');
    expect(exhausted.actionReasons.retry_report_format).toContain('two automatic report-only corrections');
    expect(exhausted.actionReasons.retry_report_format).toContain('one developer-authorized correction');
  });

  it('keeps a verified saved checkpoint recoverable after the old one-hour window', () => {
    const stale = recoveryAvailableActions({
      snapshot: blockedReviewSnapshot(0), category: 'project_code', taskId: 'review-calculator',
      canControl: true, episodeAgeMs: 10 * 24 * 60 * 60_000
    });

    expect(stale.availableActions).toContain('repair_and_continue');
    expect(stale.actionReasons.provide_guidance).toBeUndefined();
  });
});
