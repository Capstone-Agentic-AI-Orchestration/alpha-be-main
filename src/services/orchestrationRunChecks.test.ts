import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { Agent } from '../models/index.js';
import type { CliTurnOptions, CliTurnResult } from './cliRunner.js';
import { parseOrchestrationPlan } from './orchestrationContract.js';
import { describePlanChanges } from './orchestrationPlanChanges.js';
import { OrchestrationPlanner, OrchestrationPlanningError, type OrchestrationPlanningInput } from './orchestrationPlanner.js';
import { checkNewRunPlan, checkRunPlan } from './orchestrationRunChecks.js';
import type { OrchestrationRunRecord } from './orchestrationStateMachine.js';

const agents = [{ id: 'frontend', role: 'Frontend Agent' }, { id: 'backend', role: 'Backend Agent' }] as unknown as Pick<Agent, 'id' | 'role'>[];
const task = (id: string, repository: string, owner = 'frontend') => ({ id, title: `Task ${id}`, description: 'Do the work.', kind: owner, repository,
  ownerAgentId: owner, requirementIds: ['login'], acceptanceCriteria: ['It works.'], requiredChecks: ['test'], scope: { includePaths: ['src/**'] } });
const frontendOnly = parseOrchestrationPlan({ schemaVersion: 1, goal: 'Add login.', requirements: [{ id: 'login', description: 'Login screen.' }],
  tasks: [task('login-form', 'acme/web')] });

const run = (optional: Record<string, boolean | undefined>) => ({ repository: 'acme/web', plan: frontendOnly,
  repositoryWorkspaces: Object.entries(optional).map(([repository, flag]) => ({ repository, branchName: 'b', baseRef: 'main', baseCommit: 'a'.repeat(40),
    worktreePath: `/w/${repository}`, ...(flag === undefined ? {} : { optional: flag }) })) }) as unknown as OrchestrationRunRecord;

describe('one rule for every saved-run plan check', () => {
  it('accepts at start, revision and milestone exactly what planning accepted', () => {
    expect(checkNewRunPlan(frontendOnly, agents, { repositories: ['acme/web', 'acme/api'], optionalRepositories: ['acme/api'] })).toEqual([]);
    for (const saved of [run({ 'acme/web': false, 'acme/api': true }), run({ 'acme/web': undefined, 'acme/api': undefined })]) {
      for (const purpose of ['start', 'revision', 'milestone'] as const) expect(checkRunPlan(saved, frontendOnly, purpose, agents)).toEqual([]);
    }
  });

  it('still refuses a required codebase without tasks, wherever it is checked', () => {
    const required = run({ 'acme/web': false, 'acme/api': false });
    for (const purpose of ['start', 'revision', 'milestone'] as const) {
      expect(checkRunPlan(required, frontendOnly, purpose, agents).map(issue => issue.code)).toContain('unassigned_repository');
    }
  });

  it('has no other place that checks a plan its own way', () => {
    // A new direct call would bring back a rule written twice. Use checkRunPlan, checkMilestoneStage or checkNewRunPlan.
    const allowed = new Set(['orchestrationContract.ts', 'orchestrationPlanner.ts', 'orchestrationRunChecks.ts']);
    const strays: string[] = [];
    for (const folder of ['src/services', 'src/controllers']) {
      for (const file of fs.readdirSync(folder, { recursive: true }) as string[]) {
        if (!file.endsWith('.ts') || file.endsWith('.test.ts') || allowed.has(path.basename(file))) continue;
        if (fs.readFileSync(path.join(folder, file), 'utf8').includes('validateOrchestrationPlan(')) strays.push(path.join(folder, file));
      }
    }
    expect(strays).toEqual([]);
  });
});

describe('what a corrected plan changed', () => {
  it('names added, removed and moved tasks in a few short lines', () => {
    const after = parseOrchestrationPlan({ ...frontendOnly, tasks: [{ ...task('login-form', 'acme/web', 'backend'), kind: 'frontend' }, task('session-api', 'acme/api', 'backend')] });
    expect(describePlanChanges(frontendOnly, after)).toEqual(['Gave "Task login-form" to another specialist.', 'Added "Task session-api" in api.']);
    expect(describePlanChanges(after, frontendOnly)).toEqual(['Gave "Task login-form" to another specialist.', 'Removed "Task session-api".']);
    expect(describePlanChanges(frontendOnly, frontendOnly)).toEqual(['Reworded the plan; no task was added, removed or moved.']);
  });
});

describe("the Orchestrator's one correction", () => {
  const response = (content: string): CliTurnResult => ({ content, thinking: '', tools: [], sessionId: null, bin: 'fixture', failureDetail: null, failureKind: null });
  const directory = () => fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-correct-plan-'));
  const input = (cwd: string) => ({ runId: 'run-correct', cwd, goal: 'Add login.', repositoryContext: 'React app.', availableScripts: ['test'],
    eligibleAgents: agents, planner: { id: 'orchestrator', name: 'Orchestrator', role: 'Orchestrator Agent', provider: 'OpenAI', modelName: 'fixture', systemPrompt: 'Plan.' } }) as unknown as OrchestrationPlanningInput;
  const ghost = parseOrchestrationPlan({ ...frontendOnly, tasks: [{ ...task('login-form', 'acme/web'), ownerAgentId: 'ghost' }] });

  it('gets the plan and what was wrong, and returns a plan that passes, in one model call', async () => {
    const cwd = directory();
    try {
      const turn = vi.fn(async (_options: CliTurnOptions) => response(JSON.stringify(frontendOnly)));
      const corrected = await new OrchestrationPlanner(turn).correctPlan(input(cwd), ghost, new OrchestrationPlanningError('Unknown owner ghost.', 'invalid_plan'));
      expect(corrected.tasks[0].ownerAgentId).toBe('frontend');
      expect(turn).toHaveBeenCalledTimes(1);
      expect(turn.mock.calls[0][0].prompt).toContain('Unknown owner ghost.');
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });

  it('stops after that one try, keeping both plans', async () => {
    const cwd = directory();
    try {
      const turn = vi.fn(async (_options: CliTurnOptions) => response(JSON.stringify(ghost)));
      const error = await new OrchestrationPlanner(turn).correctPlan(input(cwd), ghost, new OrchestrationPlanningError('Unknown owner ghost.', 'invalid_plan')).catch(value => value);
      expect(error).toBeInstanceOf(OrchestrationPlanningError);
      expect(error.message).toContain('tried one correction');
      expect(error.rejectedPlans).toMatchObject({ proposed: ghost });
      expect(turn).toHaveBeenCalledTimes(1);
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });
});
