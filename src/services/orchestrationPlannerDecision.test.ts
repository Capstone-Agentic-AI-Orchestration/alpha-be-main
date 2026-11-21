import { describe, expect, it, vi } from 'vitest';
import type { CliTurnOptions, CliTurnResult } from './cliRunner.js';
import { MAX_PLANNING_QUESTIONS, OrchestrationPlanner, OrchestrationPlanningError } from './orchestrationPlanner.js';

const response = (content: string): CliTurnResult => ({ content, thinking: '', tools: [], sessionId: null, bin: 'fixture', failureDetail: null, failureKind: null });
const input = {
  runId: 'run-decision', cwd: 'D:/repositories/project-a', goal: 'Build the expense workflow.',
  projectContext: 'I want project a to be a informational website', repositoryContext: '', availableScripts: ['test'],
  eligibleAgents: [{ id: 'frontend-agent', role: 'Frontend Agent' }],
  planner: { id: 'orchestrator', name: 'Orchestrator', role: 'Orchestrator Agent', provider: 'OpenAI', modelName: 'fixture-model', systemPrompt: '' }
};

describe('planner questions for the person', () => {
  it('returns a decision instead of a plan, without a repair turn', async () => {
    const turn = vi.fn(async (_options: CliTurnOptions) => response(JSON.stringify({
      needsDecision: { question: 'Should Project A stay informational or become an expense tracker?',
        options: [{ label: 'Expense tracker', description: 'Build the expense cards.' }, 'Informational website', { nope: true }] }
    })));
    const error = await new OrchestrationPlanner(turn).createPlan(input).catch(caught => caught);
    expect(error).toBeInstanceOf(OrchestrationPlanningError);
    expect(error.code).toBe('needs_decision');
    expect(error.decision).toEqual({ question: 'Should Project A stay informational or become an expense tracker?',
      options: [{ label: 'Expense tracker', description: 'Build the expense cards.' }, { label: 'Informational website' }] });
    expect(turn).toHaveBeenCalledTimes(1);
    expect(turn.mock.calls[0][0].prompt).toContain('needsDecision');
  });

  it('gives the planner earlier answers as settled, and stops it asking after the limit', async () => {
    const turn = vi.fn(async (_options: CliTurnOptions) => response('{}'));
    const settled = [{ question: 'Informational or expenses?', answer: 'Expenses' }];
    await new OrchestrationPlanner(turn).createPlan({ ...input, settledDecisions: settled }).catch(() => undefined);
    expect(turn.mock.calls[0][0].prompt).toContain('"settledDecisions"');
    expect(turn.mock.calls[0][0].prompt).toContain('never ask about them again');

    turn.mockClear();
    const many = Array.from({ length: MAX_PLANNING_QUESTIONS }, (_, index) => ({ question: 'Q' + index, answer: 'A' + index }));
    await new OrchestrationPlanner(turn).createPlan({ ...input, settledDecisions: many }).catch(() => undefined);
    expect(turn.mock.calls[0][0].prompt).toContain('Do not return needsDecision');
  });
});
