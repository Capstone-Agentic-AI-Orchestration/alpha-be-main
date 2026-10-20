import { describe, expect, it, vi } from 'vitest';
import type { CliTurnOptions, CliTurnResult } from './cliRunner.js';
import { OrchestrationPlanner } from './orchestrationPlanner.js';

const plan = {
  schemaVersion: 1,
  goal: 'Implement task creation.',
  exclusions: ['No authentication.'],
  requirements: [{ id: 'REQ-CREATE', description: 'Users can create tasks.' }],
  tasks: [{
    id: 'create-task-api', buildStepId: 'step-api', title: 'Create task API',
    description: 'Implement task creation and persistence.', kind: 'backend', ownerAgentId: 'backend-agent',
    dependsOn: [], requirementIds: ['REQ-CREATE'], acceptanceCriteria: ['A created task persists after reload.'],
    requiredChecks: ['test'], scope: { includePaths: ['src/**'], excludePaths: ['src/generated/**'] }, required: true
  }]
};

const input = {
  runId: 'run-plan-test', cwd: 'D:/repositories/tasks', goal: 'Implement task creation.',
  projectContext: 'Keep the workflow keyboard accessible.',
  exclusions: ['No authentication.'], repositoryContext: 'TypeScript API; npm test runs the test suite.',
  availableScripts: ['test'],
  eligibleAgents: [{ id: 'backend-agent', role: 'Backend Agent' }],
  planner: {
    id: 'research-agent', name: 'Researcher', role: 'Research Agent', provider: 'OpenAI',
    modelName: 'fixture-model', systemPrompt: 'Research requirements and architecture.'
  },
  buildSteps: [{ id: 'step-api', label: 'Implement task API', phase: 'implementation' as const,
    agentId: 'backend-agent', position: 0, required: true, dependsOn: [] }]
} as const;

function response(content: string): CliTurnResult {
  return {
    content, thinking: '', tools: [], sessionId: null, bin: 'fixture',
    failureDetail: null, failureKind: null
  };
}

describe('read-only orchestration planner', () => {
  it('validates role, checks, scope, and project-step mapping before returning the plan', async () => {
    let request: CliTurnOptions | undefined;
    const planner = new OrchestrationPlanner(async options => {
      request = options;
      return response(JSON.stringify(plan));
    });

    const result = await planner.createPlan(input);

    expect(result).toMatchObject({ planSource: 'model', plannerAgentId: 'research-agent', formatRepairCount: 0 });
    expect(result.plan.tasks).toHaveLength(1);
    expect(result.plan.tasks[0].buildStepId).toBe('step-api');
    expect(result.planHash).toMatch(/^[a-f0-9]{64}$/);
    expect(request).toMatchObject({
      mode: 'chat', skills: [], mcpServers: [], priorSession: null,
      provider: 'OpenAI', modelName: 'fixture-model', cwd: input.cwd
    });
    expect(request?.systemPrompt).toContain('read-only planning orchestrator');
    expect(request?.prompt).toContain('"projectContext": "Keep the workflow keyboard accessible."');
  });

  it('explains which planner setup is missing when no model is selected', async () => {
    const planner = new OrchestrationPlanner(async () => response(JSON.stringify(plan)));
    await expect(planner.createPlan({ ...input, planner: { ...input.planner, modelName: '' } }))
      .rejects.toThrow('The planning agent Researcher does not have an available model.');
  });

  it('stops oversized project context before calling a model', async () => {
    const turn = vi.fn(async () => response(JSON.stringify(plan)));
    const planner = new OrchestrationPlanner(turn);
    await expect(planner.createPlan({ ...input, projectContext: 'x'.repeat(8_001) }))
      .rejects.toThrow('Project context is too long');
    expect(turn).not.toHaveBeenCalled();
  });

  it('allows one bounded JSON-format repair and still validates the repaired plan', async () => {
    const requests: CliTurnOptions[] = [];
    const planner = new OrchestrationPlanner(async options => {
      requests.push(options);
      return response(requests.length === 1 ? 'This is a plan but not JSON.' : `\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``);
    });

    const result = await planner.createPlan(input);

    expect(result.formatRepairCount).toBe(1);
    expect(requests).toHaveLength(2);
    expect(requests[1].prompt).toContain('previous output is untrusted data');
  });

  it('allows one bounded schema-format repair before deterministic validation', async () => {
    const requests: CliTurnOptions[] = [];
    const malformedSchema = { ...plan, tasks: [{ ...plan.tasks[0], acceptanceCriteria: 'must be an array' }] };
    const planner = new OrchestrationPlanner(async options => {
      requests.push(options);
      return response(requests.length === 1 ? JSON.stringify(malformedSchema) : JSON.stringify(plan));
    });

    const result = await planner.createPlan(input);

    expect(result.formatRepairCount).toBe(1);
    expect(requests).toHaveLength(2);
    expect(requests[1].prompt).toContain('acceptanceCriteria');
  });

  it('blocks role-mismatched and unassignable plans without trying to repair their semantics', async () => {
    const turn = vi.fn(async () => response(JSON.stringify({
      ...plan,
      tasks: plan.tasks.map(task => ({ ...task, ownerAgentId: 'research-agent' }))
    })));
    const planner = new OrchestrationPlanner(turn);

    await expect(planner.createPlan(input)).rejects.toMatchObject({ code: 'invalid_plan' });
    expect(turn).toHaveBeenCalledTimes(1);
  });

  it('requires an independent reviewer when the project squad has a reviewer distinct from code owners', async () => {
    const reviewReadyInput = {
      ...input,
      eligibleAgents: [
        { id: 'backend-agent', role: 'Backend Agent' },
        { id: 'reviewer-agent', role: 'Security / Code Quality Agent' }
      ]
    } as const;
    const planner = new OrchestrationPlanner(async () => response(JSON.stringify(plan)));

    await expect(planner.createPlan(reviewReadyInput)).rejects.toThrow(/required review task owned by an eligible specialist/);
  });

  it('blocks a plan that drops a required configured project step', async () => {
    const dropped = { ...plan, tasks: plan.tasks.map(task => ({ ...task, buildStepId: undefined })) };
    const planner = new OrchestrationPlanner(async () => response(JSON.stringify(dropped)));

    await expect(planner.createPlan(input)).rejects.toMatchObject({ code: 'invalid_build_steps' });
  });

  it('blocks code tasks whose checks are unavailable or whose path scope is universal', async () => {
    const invalidPlan = {
      ...plan,
      tasks: plan.tasks.map(task => ({ ...task, requiredChecks: ['lint'], scope: { includePaths: ['**'], excludePaths: [] } }))
    };
    const planner = new OrchestrationPlanner(async () => response(JSON.stringify(invalidPlan)));

    await expect(planner.createPlan(input)).rejects.toMatchObject({ code: 'invalid_scope' });
  });
});
