import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseOrchestrationPlan } from './orchestrationContract.js';
import { SQLiteService } from './sqliteService.js';
import { OrchestrationService } from './orchestrationService.js';
import type { OrchestrationRepositoryWorkspace, OrchestrationRunRecord } from './orchestrationStateMachine.js';
import { planRepositoryCoverage } from './orchestrationWorkspace.js';

// A project with two codebases where the request only needs the frontend one.
const agents = [{ id: 'frontend', role: 'Frontend Agent' }] as const;
const frontendOnly = parseOrchestrationPlan({ schemaVersion: 1, goal: 'Add the login screen.',
  requirements: [{ id: 'login', description: 'Show a login screen.' }],
  tasks: [{ id: 'login-screen', title: 'Build the login screen', description: 'Add the login form.', kind: 'frontend', repository: 'acme/web',
    ownerAgentId: 'frontend', requirementIds: ['login'], acceptanceCriteria: ['The login form renders.'], scope: { includePaths: ['src/**'] } }]
});

function workspaces(directory: string, optional: Record<string, boolean | undefined>): OrchestrationRepositoryWorkspace[] {
  return Object.entries(optional).map(([repository, flag]) => ({ repository, branchName: 'alpha/orchestration/optional-test', baseRef: 'main',
    baseCommit: 'a'.repeat(40), worktreePath: path.join(directory, repository), ...(flag === undefined ? {} : { optional: flag }) }));
}

describe('codebases a plan may leave without tasks', () => {
  let directory = '';
  let store: SQLiteService | undefined;
  afterEach(() => { vi.restoreAllMocks(); store?.close(); store = undefined; if (directory) fs.rmSync(directory, { recursive: true, force: true }); directory = ''; });

  function service() {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-optional-repos-'));
    store = new SQLiteService({ dbPath: path.join(directory, 'alpha.db'), seedDefaults: false });
    vi.spyOn(store, 'getAgents').mockReturnValue(agents as any);
    store.addAllowedPath(directory, 'Optional repository fixture');
    const launch = vi.fn(async (request: { attemptId: string }) => ({ prototypeRunId: `prototype-${request.attemptId}` }));
    return new OrchestrationService(store, { launch });
  }

  function start(orchestration: OrchestrationService, optional: Record<string, boolean | undefined>, optionalRepositories: string[]) {
    return orchestration.start({ workspaceId: 'ws-default', projectId: 'project', issueId: 'issue', repository: 'acme/web',
      requestKey: 'request', requestFingerprint: 'request-hash', createdBy: 'user', executorId: 'executor', eligibleAgents: agents,
      plan: frontendOnly, repositoryWorkspaces: workspaces(directory, optional), optionalRepositories });
  }

  it('starts a plan that leaves an optional codebase without tasks', async () => {
    const orchestration = service();
    const ready = await start(orchestration, { 'acme/web': false, 'acme/api': true }, ['acme/api']);
    expect(ready.run.status).toBe('awaiting_plan_approval');
    const running = await orchestration.startPlannedWork({ workspaceId: 'ws-default', runId: ready.run.id, expectedRevision: ready.run.revision, actorId: 'user' });
    expect(running.run.status).toBe('executing');
  });

  it('keeps the exemption when the plan is revised before it starts', async () => {
    const orchestration = service();
    const ready = await start(orchestration, { 'acme/web': false, 'acme/api': true }, ['acme/api']);
    const revised = store!.replaceUnstartedPlan({ runId: ready.run.id, expectedRevision: ready.run.revision, actorId: 'user', reason: 'Clearer wording.',
      plan: { ...frontendOnly, tasks: [{ ...frontendOnly.tasks[0], title: 'Build the sign-in screen' }] } });
    expect(revised.run.plan.tasks[0].title).toBe('Build the sign-in screen');
  });

  it('starts a plan saved before the flag existed when it left a codebase without tasks', async () => {
    const orchestration = service();
    const ready = await start(orchestration, { 'acme/web': undefined, 'acme/api': undefined }, ['acme/api']);
    const running = await orchestration.startPlannedWork({ workspaceId: 'ws-default', runId: ready.run.id, expectedRevision: ready.run.revision, actorId: 'user' });
    expect(running.run.status).toBe('executing');
  });

  it('still refuses to start when a required codebase has no task', async () => {
    const orchestration = service();
    const ready = await start(orchestration, { 'acme/web': false, 'acme/api': false }, ['acme/api']);
    await expect(orchestration.startPlannedWork({ workspaceId: 'ws-default', runId: ready.run.id, expectedRevision: ready.run.revision, actorId: 'user' }))
      .rejects.toThrow(/No task is assigned to selected repository acme\/api/);
  });
});

describe('planRepositoryCoverage', () => {
  const run = (repositoryWorkspaces?: OrchestrationRepositoryWorkspace[]) => ({ repository: 'acme/web', plan: frontendOnly, repositoryWorkspaces }) as OrchestrationRunRecord;

  it('reads the saved flag', () => {
    expect(planRepositoryCoverage(run(workspaces('/x', { 'acme/web': false, 'acme/api': true })))).toEqual({ repositories: ['acme/web', 'acme/api'], optionalRepositories: ['acme/api'] });
    expect(planRepositoryCoverage(run(workspaces('/x', { 'acme/web': false, 'acme/api': false }))).optionalRepositories).toEqual([]);
  });

  it('treats a codebase an older saved plan never used as optional', () => {
    expect(planRepositoryCoverage(run(workspaces('/x', { 'acme/web': undefined, 'ACME/API': undefined }))).optionalRepositories).toEqual(['ACME/API']);
  });

  it('falls back to the run repository for one-codebase runs', () => {
    expect(planRepositoryCoverage(run())).toEqual({ repositories: ['acme/web'], optionalRepositories: [] });
  });
});
