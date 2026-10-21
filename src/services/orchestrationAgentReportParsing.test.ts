import { describe, expect, it } from 'vitest';
import { parseAgentReport } from './orchestrationService.js';

function validReviewReport(requirementCoverage: Record<string, unknown>[]) {
  return {
    schemaVersion: 1,
    taskId: 'review-calculator',
    summary: 'The assigned changes were reviewed.',
    requirementCoverage,
    criteriaEvidence: [{ criterion: 'The review checks the assigned changes.', evidence: 'The supplied patch was inspected.' }],
    deliverables: [{ summary: 'Review result.', paths: [] }],
    reportedChecks: [],
    reviewFindings: [],
    blockers: []
  };
}

describe('structured specialist report parsing', () => {
  it('recovers the unambiguous requirement field alias from a single JSON report', () => {
    const raw = JSON.stringify(validReviewReport([
      { requirement: 'REQ-1', evidence: 'The supplied code was inspected.' }
    ]));

    const parsed = parseAgentReport(`Final report:\n\n\`\`\`json\n${raw}\n\`\`\``);

    expect(parsed.error).toBeUndefined();
    expect(parsed.report?.requirementCoverage).toEqual([
      { requirementId: 'REQ-1', evidence: 'The supplied code was inspected.' }
    ]);
  });

  it('rejects conflicting requirement fields instead of choosing one silently', () => {
    const raw = JSON.stringify(validReviewReport([
      { requirementId: 'REQ-1', requirement: 'REQ-2', evidence: 'The supplied code was inspected.' }
    ]));

    const parsed = parseAgentReport(raw);

    expect(parsed.report).toBeUndefined();
    expect(parsed.error).toContain('requirement');
  });
});
