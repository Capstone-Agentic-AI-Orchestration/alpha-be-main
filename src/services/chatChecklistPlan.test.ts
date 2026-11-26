import { describe, expect, it, vi } from 'vitest';
import { plannedJson } from '../test/planFitFixture.js';
import type { CliTurnOptions, CliTurnResult } from './cliRunner.js';
import { parseAlphaRoute } from './chatRouter.js';
import { checklistIssues, OrchestrationPlanner } from './orchestrationPlanner.js';
import { agreedChecklistFor } from './projectBuildOrchestrator.js';

/** Alpha leads the build: the checklist it agrees in the chat is the plan the specialists follow. */

const step = (agentId: string, kind: string, instruction: string) => ({ agentId, kind, instruction, reason: 'Fits the role.' }) as any;
const decision = (assignments: unknown[]) => JSON.stringify({ contract: 'alpha_chat_v1', message: '', decision: {
  route: 'build', goal: 'Add a contact form that emails the clinic.', repositories: [], cards: [], assignments, evidence: '', instruction: '' } });

describe('Alpha\'s checklist in a build decision', () => {
  it('keeps the steps in order, and lets one specialist take several', () => {
    const parsed = parseAlphaRoute(decision([
      step('backend-agent', 'backend', 'Add an endpoint that sends the email.'),
      step('frontend-agent', 'frontend', 'Build the form with clear error messages.'),
      step('backend-agent', 'backend', 'Rate-limit the endpoint.')
    ]));
    expect(parsed.decision?.route).toBe('build');
    expect(parsed.decision?.assignments?.map(item => item.agentId)).toEqual(['backend-agent', 'frontend-agent', 'backend-agent']);
  });

  it('drops a checklist that is too long but still builds', () => {
    const parsed = parseAlphaRoute(decision(Array.from({ length: 9 }, (_, index) => step('frontend-agent', 'frontend', 'Step ' + index + '.'))));
    expect(parsed.decision?.route).toBe('build');
    expect(parsed.decision?.assignments).toBeUndefined();
  });

  it('still limits a question to specialists to four, each once', () => {
    const delegate = (assignments: unknown[]) => parseAlphaRoute(JSON.stringify({ contract: 'alpha_chat_v1', message: '', decision: {
      route: 'delegate', goal: 'Check it.', repositories: [], cards: [], assignments, evidence: '', instruction: '' } })).decision;
    expect(delegate([step('a', 'review', 'Look.'), step('a', 'review', 'Look again.')])).toBeUndefined();
    expect(delegate(['a', 'b', 'c', 'd', 'e'].map(id => step(id, 'review', 'Look.')))).toBeUndefined();
    expect(delegate([step('a', 'review', 'Look.')])?.assignments).toHaveLength(1);
  });
});

describe('the checklist reaching the plan', () => {
  it('keeps only steps an eligible specialist may own', () => {
    const agents = [{ id: 'frontend-agent', role: 'Frontend Agent' }, { id: 'security', role: 'Security / Code Quality Agent' }];
    const kept = agreedChecklistFor([
      step('frontend-agent', 'frontend', 'Build the form.'),
      step('frontend-agent', 'review', 'Review your own work.'),
      step('unknown-agent', 'backend', 'Add the endpoint.'),
      step('security', 'review', 'Review it for spam and security problems.')
    ], agents);
    expect(kept.map(item => item.instruction)).toEqual(['Build the form.', 'Review it for spam and security problems.']);
  });

  it('finds each step\'s task in order, allowing tasks in between', () => {
    const tasks = (...owners: string[]) => ({ tasks: owners.map(ownerAgentId => ({ ownerAgentId })) }) as any;
    const steps = [step('be', 'backend', 'Endpoint.'), step('fe', 'frontend', 'Form.')];
    expect(checklistIssues(tasks('be', 'security', 'fe'), steps)).toEqual([]);
    expect(checklistIssues(tasks('fe', 'be'), steps)).toEqual(['Step 2 of the checklist agreed with the person ("Form.") needs its own task owned by fe, after the task for step 1.']);
    expect(checklistIssues(tasks('be'), [step('be', 'backend', 'One.'), step('be', 'backend', 'Two.')])[0]).toContain('Step 2');
  });
});

describe('planning from the agreed checklist', () => {
  const response = (content: string): CliTurnResult => ({ content, thinking: '', tools: [], sessionId: null, bin: 'fixture', failureDetail: null, failureKind: null });
  const task = (id: string, ownerAgentId: string, kind: string) => ({ id, title: id, description: 'Do ' + id + '.', kind, ownerAgentId,
    dependsOn: [], requirementIds: ['REQ-1'], acceptanceCriteria: ['It works.'], requiredChecks: kind === 'review' ? [] : ['test'],
    scope: { includePaths: kind === 'review' ? [] : ['src/**'], excludePaths: [] }, required: true });
  const planWith = (...tasks: unknown[]) => ({ schemaVersion: 1, goal: 'Add a contact form.', exclusions: [],
    requirements: [{ id: 'REQ-1', description: 'People can contact the clinic.' }], tasks });
  const input = {
    runId: 'run-checklist', cwd: 'D:/repositories/site', goal: 'Add a contact form.', repositoryContext: 'TypeScript site; npm test.',
    availableScripts: ['test'],
    eligibleAgents: [{ id: 'backend-agent', role: 'Backend Agent' }, { id: 'frontend-agent', role: 'Frontend Agent' }],
    planner: { id: 'orchestrator', name: 'Orchestrator', role: 'Orchestrator Agent', provider: 'OpenAI', modelName: 'fixture-model', systemPrompt: '' },
    agreedChecklist: [step('backend-agent', 'backend', 'Add an endpoint that sends the email.'), step('frontend-agent', 'frontend', 'Build the form.')]
  };

  it('gives the planner the checklist, and has it correct a plan that leaves a step out', async () => {
    const missingForm = planWith(task('endpoint', 'backend-agent', 'backend'));
    const followed = planWith(task('endpoint', 'backend-agent', 'backend'), { ...task('form', 'frontend-agent', 'frontend'), dependsOn: ['endpoint'] });
    let calls = 0;
    const turn = vi.fn(async (_options: CliTurnOptions) => response(plannedJson(++calls === 1 ? missingForm : followed)));
    const result = await new OrchestrationPlanner(turn).createPlan(input as any);
    expect(turn.mock.calls[0][0].prompt).toContain('agreedChecklist is the plan you already agreed with the person');
    expect(turn.mock.calls[0][0].prompt).toContain('Add an endpoint that sends the email.');
    expect(turn).toHaveBeenCalledTimes(2);
    expect(turn.mock.calls[1][0].prompt).toContain('Step 2 of the checklist agreed with the person');
    expect(result.plan.tasks.map(item => item.ownerAgentId)).toEqual(['backend-agent', 'frontend-agent']);
  });
});
