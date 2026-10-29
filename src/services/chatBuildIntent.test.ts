import { describe, it, expect } from 'vitest';
import { parseBuildIntent, chatBuildDecisionSchema } from './chatBuildDecision.js';
import { StreamParser } from './streamParser.js';

describe('structured build intent contract', () => {
  it('accepts review context without a client action', () => {
    expect(chatBuildDecisionSchema.safeParse({ runId: 'run', expectedRevision: 3, planVersion: 2, evidenceReady: true }).success).toBe(true);
  });
  it.each([
    'yes', '{}', '{"intent":"consent","target":"none","evidence":"yes"}',
    '{"intent":"consent","target":"plan","evidence":"yes","runId":"other"}',
    '```json\n{"intent":"consent","target":"plan","evidence":"yes"}\n```'
  ])('rejects malformed or extended model authority: %s', reply => {
    expect(parseBuildIntent(reply, 'yes').intent).toBe('clarify');
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
