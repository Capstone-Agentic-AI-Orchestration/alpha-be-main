import { describe, it, expect } from 'vitest';
import { chatBuildDecisionSchema } from './chatBuildDecision.js';
import { StreamParser } from './streamParser.js';

describe('structured chat build context', () => {
  it('accepts review context without a client action', () => {
    expect(chatBuildDecisionSchema.safeParse({ runId: 'run', expectedRevision: 3, planVersion: 2, evidenceReady: true }).success).toBe(true);
  });
  it('never accepts an action as authority, only the viewed revision', () => {
    expect(chatBuildDecisionSchema.safeParse({ action: 'delete', runId: 'run', expectedRevision: 3, planVersion: 2, evidenceReady: true }).success).toBe(false);
    expect(chatBuildDecisionSchema.safeParse({ runId: 'run', expectedRevision: -1, planVersion: 2, evidenceReady: true }).success).toBe(false);
  });
  it('carries native Claude structured output independently of narration', () => {
    const parser = new StreamParser('claude');
    const output = { intent: 'consent', target: 'plan', evidence: 'yes' };
    const events = parser.parseLine(JSON.stringify({ type: 'result', subtype: 'success', structured_output: output }));
    expect(events.find(event => event.type === 'result')?.structuredOutput).toEqual(output);
    expect(new StreamParser('claude').parseLine(JSON.stringify({ type: 'result', is_error: true, structured_output: output }))
      .find(event => event.type === 'result')?.structuredOutput).toBeUndefined();
  });
});
