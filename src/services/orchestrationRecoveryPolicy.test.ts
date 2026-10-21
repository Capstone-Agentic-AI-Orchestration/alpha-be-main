import { describe, expect, it } from 'vitest';
import type { OrchestrationSnapshot } from './orchestrationStateMachine.js';
import { classifyRecoveryCategory, recoveryAvailableActions } from './orchestrationRecoveryPolicy.js';

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

  it('offers a bounded report-only correction and removes it after the limit', () => {
    const available = recoveryAvailableActions({
      snapshot: blockedReviewSnapshot(0), category: 'report', taskId: 'review-calculator',
      canControl: true, episodeAgeMs: 0
    });
    const exhausted = recoveryAvailableActions({
      snapshot: blockedReviewSnapshot(2), category: 'report', taskId: 'review-calculator',
      canControl: true, episodeAgeMs: 0
    });

    expect(available.availableActions).toContain('retry_report_format');
    expect(exhausted.availableActions).not.toContain('retry_report_format');
    expect(exhausted.actionReasons.retry_report_format).toContain('two report-only corrections');
  });
});
