import { describe, expect, it, vi } from 'vitest';
import type { CliTurnOptions, CliTurnResult } from './cliRunner.js';
import { checklistFromSpec, FeatureSpecError, featureSpecSourceHash, parseFeatureSpec, plannerRequirementsFromSpec, specPlanningBrief, type FeatureSpec } from './featureSpecContract.js';
import { tickSpecChecklist } from './orchestrationFinalization.js';
import { OrchestrationPlanner } from './orchestrationPlanner.js';
import type { OrchestrationSnapshot } from './orchestrationStateMachine.js';

const spec: FeatureSpec = {
  schemaVersion: 1,
  epicTitle: 'Empty states for the task board',
  summary: 'Developers see what to do next when a project has no tasks.',
  personas: [{ id: 'P1', name: 'Developer', goal: 'Start work on a new project quickly.' }],
  journeys: [{ id: 'J1', personaId: 'P1', title: 'Open an empty board', steps: ['Open the project', 'See the empty state', 'Create the first task'] }],
  requirements: [
    { id: 'REQ-1', behavior: 'An empty board explains what tasks are.', acceptanceCriteria: ['The empty board shows a heading and one sentence.'], journeyIds: ['J1'] },
    { id: 'REQ-2', behavior: 'The empty state offers to create a task.', acceptanceCriteria: ['Clicking Create task opens the new task dialog.'], journeyIds: ['J1'] }
  ],
  exclusions: ['No onboarding tour.'],
  openQuestions: []
};

const response = (content: string): CliTurnResult => ({ content, thinking: '', tools: [], sessionId: null, bin: 'fixture', failureDetail: null, failureKind: null });

const requirements = plannerRequirementsFromSpec(spec);
const backendTask = (id: string, requirementIds: string[], extra: Record<string, unknown> = {}) => ({
  id, title: id, description: 'Implement ' + id + '.', kind: 'backend', ownerAgentId: 'backend-agent', dependsOn: [],
  requirementIds, acceptanceCriteria: ['It works.'], requiredChecks: ['test'], scope: { includePaths: ['src/**'], excludePaths: [] }, required: true, ...extra
});
const input = {
  runId: 'run-spec', cwd: 'D:/repositories/tasks', goal: 'Add empty states to the task board.',
  repositoryContext: 'TypeScript app.', availableScripts: ['test'],
  eligibleAgents: [{ id: 'backend-agent', role: 'Backend Agent' as const }],
  planner: { id: 'orchestrator', name: 'Orchestrator', role: 'Orchestrator Agent' as const, provider: 'OpenAI', modelName: 'fixture', systemPrompt: 'Plan.' },
  approvedSpec: { requirements, exclusions: spec.exclusions, brief: specPlanningBrief(spec) }
};

describe('feature spec contract', () => {
  it('rejects a journey for an unknown persona with a readable reason', () => {
    expect(() => parseFeatureSpec({ ...spec, journeys: [{ ...spec.journeys[0], personaId: 'P9' }] })).toThrow(FeatureSpecError);
    expect(() => parseFeatureSpec({ ...spec, journeys: [{ ...spec.journeys[0], personaId: 'P9' }] })).toThrow(/unknown persona/);
  });

  it('writes acceptance criteria into the planner requirements without changing their IDs', () => {
    expect(requirements.map(item => item.id)).toEqual(['REQ-1', 'REQ-2']);
    expect(requirements[0].description).toBe('An empty board explains what tasks are. Acceptance: (1) The empty board shows a heading and one sentence.');
  });

  it('replaces earlier spec checklist items, keeps human items, and keeps a ticked requirement ticked', () => {
    const current = [
      { id: 'spec-REQ-1', title: 'REQ-1: old wording', completed: true, source: 'spec' as const, requirementId: 'REQ-1' },
      { id: 'spec-REQ-9', title: 'REQ-9: dropped', completed: false, source: 'spec' as const, requirementId: 'REQ-9' },
      { id: 'sub-1', title: 'Ask design for copy', completed: false }
    ];
    const next = checklistFromSpec(spec, current);
    expect(next.map(item => item.id)).toEqual(['spec-REQ-1', 'spec-REQ-2', 'sub-1']);
    expect(next[0]).toMatchObject({ completed: true, title: 'REQ-1: An empty board explains what tasks are.' });
  });

  it('goes stale when the task title or description changes', () => {
    const issue = { title: 'Empty states', description: 'Add them.' };
    expect(featureSpecSourceHash(issue)).toBe(featureSpecSourceHash({ ...issue, description: 'Add them.  ' }));
    expect(featureSpecSourceHash(issue)).not.toBe(featureSpecSourceHash({ ...issue, description: 'Add them everywhere.' }));
  });

  it('ticks only spec items whose requirement an accepted report gave evidence for', () => {
    const snapshot = { run: { plan: { requirements } }, tasks: [
      { id: 'validate', kind: 'validation', required: true, status: 'accepted', requirementIds: ['REQ-1', 'REQ-2'] }
    ], attempts: [
      { taskId: 'validate', attemptNumber: 2, status: 'accepted', result: { agentReport: { requirementCoverage: [{ requirementId: 'REQ-1', evidence: 'src/Board.tsx renders the heading.' }] } } },
      { taskId: 'validate', attemptNumber: 1, status: 'rejected', result: { agentReport: { requirementCoverage: [{ requirementId: 'REQ-2', evidence: 'Rejected attempt.' }] } } }
    ] } as unknown as OrchestrationSnapshot;
    const ticked = tickSpecChecklist(checklistFromSpec(spec, [{ id: 'sub-1', title: 'REQ-2 by hand', completed: false }]), snapshot);
    expect(ticked.map(item => [item.id, item.completed])).toEqual([['spec-REQ-1', true], ['spec-REQ-2', false], ['sub-1', false]]);
  });
});

describe('planning from an approved feature spec', () => {
  it('sends the spec to the planner and keeps its requirements and exclusions', async () => {
    const plan = { schemaVersion: 1, goal: input.goal, exclusions: spec.exclusions, requirements, tasks: [backendTask('empty-state', ['REQ-1', 'REQ-2'])] };
    const turn = vi.fn(async (_options: CliTurnOptions) => response(JSON.stringify(plan)));
    const result = await new OrchestrationPlanner(turn).createPlan(input);
    expect(turn.mock.calls[0][0].prompt).toContain('A person approved approvedSpec');
    expect(turn.mock.calls[0][0].prompt).toContain('Open an empty board');
    expect(result.plan.requirements).toEqual(requirements);
  });

  it('rejects reworded requirements and a dropped exclusion', async () => {
    const reworded = { schemaVersion: 1, goal: input.goal, exclusions: spec.exclusions,
      requirements: [{ ...requirements[0], description: 'Something else.' }, requirements[1]], tasks: [backendTask('empty-state', ['REQ-1', 'REQ-2'])] };
    await expect(new OrchestrationPlanner(vi.fn(async () => response(JSON.stringify(reworded)))).createPlan(input))
      .rejects.toThrow(/approved feature spec requirements exactly/);
    const dropped = { schemaVersion: 1, goal: input.goal, exclusions: [], requirements, tasks: [backendTask('empty-state', ['REQ-1', 'REQ-2'])] };
    await expect(new OrchestrationPlanner(vi.fn(async () => response(JSON.stringify(dropped)))).createPlan(input))
      .rejects.toThrow(/Keep every exclusion/);
  });

  it('still allows a milestone roadmap', async () => {
    const roadmap = {
      schemaVersion: 2, goal: input.goal, exclusions: spec.exclusions, requirements,
      milestones: [
        { id: 'm1', title: 'Explain the empty board', objective: 'Explain tasks.', requirementIds: ['REQ-1'], repositories: ['acme/app'] },
        { id: 'm2', title: 'Create from the empty board', objective: 'Offer creation.', requirementIds: ['REQ-2'], repositories: ['acme/app'] }
      ],
      tasks: [backendTask('explain', ['REQ-1'], { milestoneId: 'm1', repository: 'acme/app' })]
    };
    const result = await new OrchestrationPlanner(vi.fn(async () => response(JSON.stringify(roadmap)))).createPlan({
      ...input, repositories: [{ repository: 'acme/app', repositoryContext: 'TypeScript app.', availableScripts: ['test'] }]
    });
    expect(result.plan.schemaVersion).toBe(2);
    expect(result.plan.milestones).toHaveLength(2);
  });
});

