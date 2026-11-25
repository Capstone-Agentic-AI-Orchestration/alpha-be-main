import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { canonicalRepository, sameRepository } from '../utils/repositoryName.js';
import { scopeAllowsPath } from '../utils/pathScope.js';
import { isImplementationTask } from './agentRoleContracts.js';
import { repositoryChecks, taskRequiredChecks } from './repositoryChecks.js';
import { workspaceRegistry } from './workspaceRegistry.js';

/**
 * A rule written twice drifts: a codebase allowed at planning was refused at start, a task
 * saved as a URL missed its own workspace. Each rule below has one home; these tests fail when
 * a new copy appears, and name the helper to use instead.
 */
function sources(): Array<{ file: string; lines: string[] }> {
  return ['src/services', 'src/controllers', 'src/mcp', 'src/utils'].flatMap(folder =>
    (fs.readdirSync(folder, { recursive: true }) as string[])
      .filter(file => file.endsWith('.ts') && !file.endsWith('.test.ts'))
      .map(file => ({ file: path.join(folder, file).replace(/\\/g, '/'), lines: fs.readFileSync(path.join(folder, file), 'utf8').split('\n') })));
}

function offenders(pattern: RegExp, allowed: string[]): string[] {
  return sources().filter(source => !allowed.some(name => source.file.endsWith(name)))
    .flatMap(source => source.lines.flatMap((line, index) => pattern.test(line) ? [`${source.file}:${index + 1}`] : []));
}

describe('one rule each', () => {
  it('compares repositories only with sameRepository / canonicalRepository', () => {
    expect(sameRepository('https://github.com/Acme/Web.git', 'acme/web/')).toBe(true);
    expect(canonicalRepository(' https://github.com/Acme/Web ')).toBe('acme/web');
    // Case-preserving spellings for GitHub calls (publication, the agent's GitHub scope) are separate on purpose.
    expect(offenders(/replace\(\/\^https\?:/, ['utils/repositoryName.ts', 'services/orchestrationPublication.ts', 'services/orchestrationRunnerAdapter.ts'])).toEqual([]);
    expect(offenders(/repository\)?\??\.toLowerCase\(\) === [\w.(? ]*repository[\w.)]*\.toLowerCase\(\)/, [])).toEqual([]);
  });

  it('names the code task kinds only in isImplementationTask', () => {
    expect(['database', 'backend', 'frontend', 'mobile'].every(isImplementationTask)).toBe(true);
    expect(isImplementationTask('review')).toBe(false);
    // runningWork counts delivery as work in progress, and the planner maps roles to kinds: different lists on purpose.
    expect(offenders(/'database', 'backend', 'frontend', 'mobile'/, ['services/agentRoleContracts.ts', 'services/runningWork.ts', 'services/orchestrationPlanner.ts', 'services/sqliteService.ts'])).toEqual([]);
    expect(offenders(/\bCODE_(?:TASK_)?KINDS\.has\(/, ['services/runningWork.ts'])).toEqual([]);
  });

  it('picks the planning agent only with selectPlanner', () => {
    // A new build also honours a configured planning step, so it keeps its own wording around the same choice;
    // chat only keeps the Orchestrator out of specialist replies, which is not choosing a planner.
    expect(offenders(/=== 'orchestrator agent'|=== 'Orchestrator Agent'/, ['services/planningAgents.ts', 'services/projectBuildOrchestrator.ts', 'services/chatService.ts'])).toEqual([]);
  });

  it('collects the checks a repository runs only with repositoryChecks / taskRequiredChecks', () => {
    const tasks = [
      { kind: 'database', repository: 'acme/api', requiredChecks: ['test'] as const },
      { kind: 'backend', repository: 'https://github.com/acme/api', requiredChecks: ['test', 'lint'] as const },
      { kind: 'validation', requiredChecks: ['typecheck'] as const },
      { kind: 'review', repository: 'acme/web', requiredChecks: ['lint'] as const }
    ];
    expect(repositoryChecks(tasks, 'acme/api', 'acme/api')).toEqual(['test', 'lint', 'typecheck']);
    expect(taskRequiredChecks(tasks[0], tasks, 'acme/api')).toEqual(['test', 'lint', 'typecheck']);
    expect(taskRequiredChecks(tasks[3], tasks, 'acme/api')).toEqual(['lint']);
    // A local union drifted from the rule: a task accepted without lint left errors later tasks could not fix.
    expect(offenders(/flatMap\(\(?\w+\)? => \w+\.requiredChecks\)/, ['services/repositoryChecks.ts'])).toEqual([]);
    // The planner kept its own list of checkable scripts and could never offer one the contract added.
    expect(offenders(/'verify', 'check', 'validate', 'ci', 'test'/, ['services/orchestrationContract.ts'])).toEqual([]);
  });

  it('decides whether a task may change a path only with scopeAllowsPath', () => {
    expect(scopeAllowsPath({ includePaths: ['src/**'], excludePaths: ['src/generated/**'] }, 'src/app.ts')).toBe(true);
    expect(scopeAllowsPath({ includePaths: ['src/**'], excludePaths: ['src/generated/**'] }, 'src/generated/x.ts')).toBe(false);
    expect(offenders(/includePaths\.some\(\w+ => pathMatchesScope\(/, ['utils/pathScope.ts'])).toEqual([]);
  });

  it('decides who may have agents work for them only with canOperateAgents, never a role name', () => {
    expect(['dev', 'pm', 'admin'].every(role => workspaceRegistry.canOperateAgents(role as 'dev'))).toBe(true);
    expect(workspaceRegistry.canOperateAgents('client')).toBe(false);
    // `role === 'dev'` once sat in a dozen agent checks and kept project managers out after their
    // capabilities allowed them in. Architecture diagrams are a separate developer view, the
    // default assistant picks a prompt for every non-client, and ticket audit events label who
    // acted: none of them decides who may use agents.
    expect(offenders(/role\s*[!=]==\s*'dev'/, ['controllers/projectRepoController.ts', 'services/defaultAssistant.ts',
      'services/workspaceRegistry.ts', 'services/ticketLifecycleRuntime.ts'])).toEqual([]);
  });
});
