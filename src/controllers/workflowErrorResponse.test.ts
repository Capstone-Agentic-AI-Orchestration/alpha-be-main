import { describe, expect, it } from 'vitest';

import { DomainRefusal, PlanNeedsYouError } from '../services/domainRefusal.js';
import { workflowErrorAnswer } from './workflowErrorResponse.js';

/** A refusal reaches the app as a reason with next steps; only a real failure is a 500. */
describe('the answer for a failed workflow action', () => {
  it('answers an expected refusal with 409, its reason and the next steps', () => {
    const issue = { code: 'unassigned_repository', detail: 'No task is assigned to selected repository acme/api.' };
    expect(workflowErrorAnswer(new PlanNeedsYouError('This plan cannot start yet.', [issue]))).toEqual({ status: 409,
      body: { error: 'This plan cannot start yet.', code: 'plan_needs_you', actions: ['ask_orchestrator', 'open_plan', 'stop_plan'], issues: [issue] } });
    expect(workflowErrorAnswer(new DomainRefusal(issue.detail, 'plan_check')).status).toBe(409);
  });

  it('keeps the older wording rules, and treats anything else as an unexpected failure', () => {
    expect(workflowErrorAnswer(new Error('Task build not found.')).status).toBe(404);
    expect(workflowErrorAnswer(new Error('This plan is no longer waiting to start.')).status).toBe(409);
    expect(workflowErrorAnswer(new TypeError('x is not a function'))).toEqual({ status: 500, body: { error: 'x is not a function' } });
  });
});
