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

  it('normalizes common reported-check name/status aliases without changing their meaning', () => {
    const raw = JSON.stringify({
      ...validReviewReport([]),
      reportedChecks: [
        { name: 'npm test', status: 'SUCCESS', evidence: 'The specialist observed the test command pass.' },
        { script: 'npm run lint', result: 'not run', evidence: 'The specialist did not run this check.' }
      ]
    });

    const parsed = parseAgentReport(raw);

    expect(parsed.error).toBeUndefined();
    expect(parsed.report?.reportedChecks).toEqual([
      { script: 'npm test', result: 'passed', evidence: 'The specialist observed the test command pass.' },
      { script: 'npm run lint', result: 'not_run', evidence: 'The specialist did not run this check.' }
    ]);
  });

  it('records a blocked check as not_run and retains its explanation', () => {
    const raw = JSON.stringify({
      ...validReviewReport([]),
      reportedChecks: [{
        script: 'npm test', result: 'blocked', evidence: 'The test runner was unavailable, so this check did not execute.'
      }]
    });

    const parsed = parseAgentReport(raw);

    expect(parsed.error).toBeUndefined();
    expect(parsed.report?.reportedChecks).toEqual([{
      script: 'npm test', result: 'not_run', evidence: 'The test runner was unavailable, so this check did not execute.'
    }]);
  });

  it('binds a report to the version expected by its task and preserves the received version on rejection', () => {
    const parsed = parseAgentReport(JSON.stringify({ ...validReviewReport([]), schemaVersion: 2 }), 1);

    expect(parsed.report).toBeUndefined();
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.error).toContain('expects specialist report schema version 1');
    expect(parsed.error).toContain('returned version 2');
  });

  it('rejects an unknown report schema version instead of validating it as the current version', () => {
    const parsed = parseAgentReport(JSON.stringify({ ...validReviewReport([]), schemaVersion: 99 }));

    expect(parsed.report).toBeUndefined();
    expect(parsed.schemaVersion).toBe(99);
    expect(parsed.error).toContain('does not support specialist report schema version 99');
  });

  it('normalizes common review-finding aliases and severity labels', () => {
    const raw = JSON.stringify({
      ...validReviewReport([]),
      reviewFindings: [{
        taskId: 'backend-api', severity: 'high', title: 'Missing input validation', requirement: 'REQ-API',
        file: 'src/api.ts', evidence: 'An unchecked request reaches the handler.',
        recommendation: 'Validate the request before processing it.'
      }, {
        targetTaskId: 'backend-api', severity: 'medium', title: 'Missing edge-case coverage',
        evidence: 'The boundary case is not covered.', instruction: 'Add a focused boundary test.'
      }]
    });

    const parsed = parseAgentReport(raw);

    expect(parsed.error).toBeUndefined();
    expect(parsed.report?.reviewFindings).toEqual([{
      targetTaskId: 'backend-api', severity: 'blocking', title: 'Missing input validation', requirementId: 'REQ-API',
      path: 'src/api.ts', evidence: 'An unchecked request reaches the handler.',
      instruction: 'Validate the request before processing it.'
    }, {
      targetTaskId: 'backend-api', severity: 'blocking', title: 'Missing edge-case coverage',
      evidence: 'The boundary case is not covered.', instruction: 'Add a focused boundary test.'
    }]);
  });

  it('rejects conflicting or unknown reported-check aliases instead of guessing', () => {
    const conflicting = parseAgentReport(JSON.stringify({
      ...validReviewReport([]),
      reportedChecks: [{ script: 'npm test', name: 'npm run lint', result: 'passed', status: 'failed', evidence: 'Observed.' }]
    }));
    const unknown = parseAgentReport(JSON.stringify({
      ...validReviewReport([]),
      reportedChecks: [{ name: 'npm test', status: 'complete', evidence: 'Observed.' }]
    }));

    expect(conflicting.report).toBeUndefined();
    expect(conflicting.error).toContain('Unrecognized key');
    expect(unknown.report).toBeUndefined();
    expect(unknown.error).toContain('reportedChecks.0.result');
  });
});
