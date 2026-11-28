import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { plannedJson } from '../test/planFitFixture.js';
import type { CliTurnOptions, CliTurnResult } from './cliRunner.js';
import { OrchestrationPlanner } from './orchestrationPlanner.js';
import { readPlannerReads, recordPlannerRead, unreadPlannedFiles } from './plannerReads.js';
import type { OrchestrationPlan } from './orchestrationContract.js';

function response(content: string): CliTurnResult {
  return { content, thinking: '', tools: [], sessionId: null, bin: 'fixture', failureDetail: null, failureKind: null };
}

function withRepository(run: (dir: string) => Promise<void> | void) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-planner-reads-'));
    try {
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(path.join(dir, 'src', 'tasks.ts'), 'export const tasks = [];');
      await run(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

const task = (includePaths: string[], kind = 'backend') => ({
  id: 'create-task-api', title: 'Create task API', description: 'Implement task creation.', kind, ownerAgentId: 'backend-agent',
  repository: 'acme/api', dependsOn: [], requirementIds: ['REQ-CREATE'], acceptanceCriteria: ['A created task persists.'],
  requiredChecks: ['test'], scope: { includePaths, excludePaths: [] }, required: true
});
const planWith = (includePaths: string[], kind = 'backend') => ({
  schemaVersion: 1, goal: 'Implement task creation.', exclusions: [],
  requirements: [{ id: 'REQ-CREATE', description: 'Users can create tasks.' }],
  tasks: [task(includePaths, kind)]
});

describe('the files a planner opened', () => {
  it('reads each recorded file once, and nothing when no log was started', withRepository(dir => {
    const log = path.join(dir, 'reads.jsonl');
    expect(readPlannerReads(log)).toBeNull();
    recordPlannerRead(log, { repository: 'acme/api', path: 'src/tasks.ts' });
    recordPlannerRead(log, { repository: 'acme/api', path: 'src/tasks.ts' });
    fs.appendFileSync(log, 'not json\n');
    expect(readPlannerReads(log)).toEqual([{ repository: 'acme/api', path: 'src/tasks.ts' }]);
  }));

  it('flags an existing file a code task changes without the planner opening it', withRepository(dir => {
    const roots = [{ name: 'api', repo: 'acme/api', dir }];
    const plan = planWith(['src/tasks.ts', 'src/new-file.ts', 'src/**']) as unknown as OrchestrationPlan;
    expect(unreadPlannedFiles(plan, [], roots)).toEqual(['src/tasks.ts (task create-task-api)']);
    expect(unreadPlannedFiles(plan, [{ repository: 'acme/api', path: 'src/tasks.ts' }], roots)).toEqual([]);
  }));

  it('leaves analysis tasks alone, since they change no files', withRepository(dir => {
    const plan = planWith(['src/tasks.ts'], 'architecture') as unknown as OrchestrationPlan;
    expect(unreadPlannedFiles(plan, [], [{ name: 'api', repo: 'acme/api', dir }])).toEqual([]);
  }));
});

describe('planning with proof of reading', () => {
  const baseInput = (dir: string) => ({
    runId: 'run-reads', cwd: dir, goal: 'Implement task creation.', exclusions: [], repositoryContext: 'TypeScript API.',
    availableScripts: ['test'], eligibleAgents: [{ id: 'backend-agent', role: 'Backend Agent' as const }], buildSteps: [],
    planner: { id: 'research-agent', name: 'Researcher', role: 'Research Agent' as const, provider: 'OpenAI', modelName: 'fixture-model', systemPrompt: '' },
    repositories: [{ repository: 'acme/api', repositoryContext: 'TypeScript API.', availableScripts: ['test'] }],
    repositoryRoots: [{ name: 'api', repo: 'acme/api', dir }]
  });

  /** What alpha-project-files does: start the log, then record each file opened. */
  const openFiles = (options: CliTurnOptions, files: string[]) => {
    fs.appendFileSync(options.readLogPath!, '');
    for (const file of files) recordPlannerRead(options.readLogPath!, { repository: 'acme/api', path: file });
  };

  it('keeps the files the planner opened with the plan', withRepository(async dir => {
    const turn = vi.fn(async (options: CliTurnOptions) => {
      openFiles(options, ['src/tasks.ts']);
      return response(plannedJson(planWith(['src/tasks.ts'])));
    });
    const result = await new OrchestrationPlanner(turn).createPlan(baseInput(dir));
    expect(turn).toHaveBeenCalledTimes(1);
    expect(result.plan.plannerReads).toEqual([{ repository: 'acme/api', path: 'src/tasks.ts' }]);
    expect(fs.existsSync(turn.mock.calls[0][0].readLogPath!)).toBe(false);
  }));

  it('sends a plan that changes an unread file back to the planner once', withRepository(async dir => {
    let calls = 0;
    const turn = vi.fn(async (options: CliTurnOptions) => {
      openFiles(options, ++calls === 1 ? [] : ['src/tasks.ts']);
      return response(plannedJson(planWith(['src/tasks.ts'])));
    });
    const result = await new OrchestrationPlanner(turn).createPlan(baseInput(dir));
    expect(turn).toHaveBeenCalledTimes(2);
    expect(turn.mock.calls[1][0].prompt).toContain('never opened: src/tasks.ts');
    expect(result.plan.plannerReads).toEqual([{ repository: 'acme/api', path: 'src/tasks.ts' }]);
  }));

  it('asks for one correction, then lets the plan through when the file is still unopened', withRepository(async dir => {
    const turn = vi.fn(async (options: CliTurnOptions) => {
      openFiles(options, []);
      return response(plannedJson(planWith(['src/tasks.ts'])));
    });
    // The specialist reads the file before changing it and acceptance judges the real diff,
    // so a second miss no longer stops the build before anyone starts.
    const result = await new OrchestrationPlanner(turn).createPlan(baseInput(dir));
    expect(result.plan.tasks.length).toBeGreaterThan(0);
    expect(turn).toHaveBeenCalledTimes(2);
  }));

  it('does not require proof from a runtime without Alpha file tools', withRepository(async dir => {
    const turn = vi.fn(async () => response(plannedJson(planWith(['src/tasks.ts']))));
    const result = await new OrchestrationPlanner(turn).createPlan(baseInput(dir));
    expect(turn).toHaveBeenCalledTimes(1);
    expect(result.plan.plannerReads).toBeUndefined();
  }));

  it('never takes a list of opened files from the model', withRepository(async dir => {
    const turn = vi.fn(async (options: CliTurnOptions) => {
      openFiles(options, []);
      return response(plannedJson({ ...planWith(['src/**']), plannerReads: [{ repository: 'acme/api', path: 'src/tasks.ts' }] }));
    });
    const result = await new OrchestrationPlanner(turn).createPlan(baseInput(dir));
    expect(result.plan.plannerReads).toBeUndefined();
  }));
});

