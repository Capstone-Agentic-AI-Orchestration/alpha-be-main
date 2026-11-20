import { describe, expect, it, vi } from 'vitest';
import type { CliTurnOptions, CliTurnResult } from './cliRunner.js';
import { OrchestrationPlanner, OrchestrationPlanningError } from './orchestrationPlanner.js';

const response = (content: string): CliTurnResult => ({ content, thinking: '', tools: [], sessionId: null, bin: 'fixture', failureDetail: null, failureKind: null });

describe('planner questions for the person', () => {
  it('returns a decision instead of a plan, without a repair turn', async () => {
    const turn = vi.fn(async (_options: CliTurnOptions) => response(JSON.stringify({
      needsDecision: { question: 'Should Project A stay an informational website or become an expense tracker?', options: ['Expense tracker', 'Informational website'] }
    })));
    const error = await new OrchestrationPlanner(turn).createPlan({
      runId: 'run-decision', cwd: 'D:/repositories/project-a', goal: 'Build the expense workflow.',
      projectContext: 'I want project a to be a informational website', repositoryContext: '', availableScripts: ['test'],
      eligibleAgents: [{ id: 'frontend-agent', role: 'Frontend Agent' }],
      planner: { id: 'orchestrator', name: 'Orchestrator', role: 'Orchestrator Agent', provider: 'OpenAI', modelName: 'fixture-model', systemPrompt: '' }
    }).catch(caught => caught);
    expect(error).toBeInstanceOf(OrchestrationPlanningError);
    expect(error.code).toBe('needs_decision');
    expect(error.decision).toEqual({ question: 'Should Project A stay an informational website or become an expense tracker?', options: ['Expense tracker', 'Informational website'] });
    expect(turn).toHaveBeenCalledTimes(1);
    expect(turn.mock.calls[0][0].prompt).toContain('needsDecision');
  });
});
