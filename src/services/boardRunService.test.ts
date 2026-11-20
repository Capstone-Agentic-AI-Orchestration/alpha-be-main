import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Issue, Project } from '../models/index.js';
import type { WorkspaceContext } from './workspaceRegistry.js';

vi.mock('./sqliteService.js', () => ({ sqliteService: {} }));
vi.mock('../store/stores.js', () => ({ issueStore: () => ({}), projectStore: () => ({}) }));
vi.mock('./workspaceRegistry.js', () => ({ workspaceRegistry: {
  can: (role: string) => role === 'dev',
  canAccessProjectBuilds: () => true
} }));
import { boardBuildSourceHash, type BoardBuildRequest } from './boardBuildRequests.js';
import { advanceBoardRun, orderRunTasks, resumeBoardRun, startBoardRun, stopBoardRun, type BoardRun, type BoardRunDeps } from './boardRunService.js';

/**
 * A board run works through chosen tasks one after another. What matters is what it
 * will not do: publish, skip quietly, go past its limits, or act for someone who lost
 * access. A person approves every pull request.
 */
const project = { id: 'p', name: 'Project A', resources: [] } as unknown as Project;
const issue = (id: string, priority: Issue['priority'], over: Partial<Issue> = {}) => ({
  id, identifier: id.toUpperCase(), title: id, description: '', status: 'todo', priority, projectId: 'p',
  labels: [], subtasks: [], comments: [], createdAt: '', updatedAt: '', ...over
}) as Issue;
const dev = { workspaceId: 'w', userId: 'lloyd', role: 'dev' } as WorkspaceContext;

function world(issues: Issue[]) {
  const runs = new Map<string, BoardRun>();
  const requests = new Map<string, BoardBuildRequest>();
  const builds = new Map<string, { status: string; revision: number; stoppedReason?: string }>();
  const calls: string[] = [];
  let context: WorkspaceContext | null = dev;
  let usage = { tokens: 0, costUsd: 0, unmeasuredBuilds: 0 };
  const deps: BoardRunDeps = {
    now: () => '2026-11-20T10:00:00.000Z',
    listRuns: () => [...runs.values()],
    saveRun: run => { runs.set(run.id, structuredClone(run)); },
    listIssues: async () => issues,
    getProject: async () => project,
    getSpecVersion: () => 0,
    resolveContext: async () => context,
    requestBuild: async input => {
      calls.push(`request ${input.issue.id} in ${input.threadId}`);
      const request = { id: input.requestId, issueId: input.issue.id, status: 'waiting' } as BoardBuildRequest;
      requests.set(request.id, request);
      return request;
    },
    listRequests: () => [...requests.values()],
    cancelRequest: request => { calls.push(`cancel ${request.id}`); requests.set(request.id, { ...request, status: 'cancelled' }); },
    snapshot: (_w, runId) => {
      const build = builds.get(runId);
      return build ? { run: { id: runId, status: build.status, revision: build.revision, stoppedReason: build.stoppedReason } } as any : null;
    },
    startPlan: async (ctx, _p, runId) => { calls.push(`approve plan ${runId} as ${ctx.userId}`); builds.get(runId)!.status = 'executing'; },
    pauseBuild: async (_w, runId) => { calls.push(`pause build ${runId}`); },
    usage: () => usage
  };
  /** The Orchestrator accepting a request and its build reaching a status. */
  const plan = (issueId: string, status: string, extra: { stoppedReason?: string } = {}) => {
    const request = [...requests.values()].find(item => item.issueId === issueId)!;
    const runId = 'run-' + issueId;
    requests.set(request.id, { ...request, status: 'accepted', result: { orchestrationRunId: runId } } as BoardBuildRequest);
    builds.set(runId, { status, revision: 1, ...extra });
  };
  const latest = () => [...runs.values()][0];
  return { deps, calls, plan, latest, builds, requests,
    setContext: (value: WorkspaceContext | null) => { context = value; }, setUsage: (value: typeof usage) => { usage = value; } };
}

const start = (w: ReturnType<typeof world>, ids: string[], over: Partial<Parameters<typeof startBoardRun>[0]> = {}) =>
  startBoardRun({ context: dev, projectId: 'p', threadId: 'chat-1', issueIds: ids, maxTasks: 5, preApprovePlans: true, ...over }, w.deps);

describe('the order a board run works in', () => {
  it('goes by priority, keeps dependencies first, and holds a task waiting on work outside the run', () => {
    const all = [
      issue('low', 'low'),
      issue('high', 'high', { dependsOnIssueIds: ['medium'] }),
      issue('medium', 'medium'),
      issue('outside', 'urgent'),
      issue('blocked', 'urgent', { dependsOnIssueIds: ['outside'] })
    ];
    const order = orderRunTasks(all.filter(item => item.id !== 'outside'), all);
    expect(order.map(item => item.issue.id)).toEqual(['blocked', 'medium', 'high', 'low']);
    expect(order[0].heldReason).toMatch(/Waits for OUTSIDE/);
    expect(order.slice(1).every(item => !item.heldReason)).toBe(true);
  });
});

describe('a board run', () => {
  let w: ReturnType<typeof world>;
  beforeEach(() => { w = world([issue('a', 'high'), issue('b', 'medium')]); });

  it('queues the first task in the chat it was started from, and only that one', async () => {
    const run = await start(w, ['b', 'a']);
    expect(run.tasks.map(task => task.issueId)).toEqual(['a', 'b']);
    expect(w.calls).toEqual(['request a in chat-1']);
    expect(run.events[0].message).toMatch(/every pull request waits for approval/);
  });

  it('approves a plan it was allowed to, but stops at the pull request', async () => {
    await start(w, ['a', 'b']);
    w.plan('a', 'awaiting_plan_approval');
    let run = await advanceBoardRun(w.latest(), w.deps);
    expect(w.calls).toContain('approve plan run-a as lloyd');
    expect(run.events.at(-1)?.message).toMatch(/Approved the plan for A on behalf of lloyd/);

    w.builds.get('run-a')!.status = 'awaiting_approval';
    run = await advanceBoardRun(w.latest(), w.deps);
    expect(run.status).toBe('waiting_on_you');
    expect(run.reason).toMatch(/Approve its pull request/);
    // Nothing else starts while a person has not approved.
    expect(w.calls.filter(call => call.startsWith('request'))).toEqual(['request a in chat-1']);
  });

  it('waits for the person to approve each plan when it was not allowed to', async () => {
    await start(w, ['a'], { preApprovePlans: false });
    w.plan('a', 'awaiting_plan_approval');
    const run = await advanceBoardRun(w.latest(), w.deps);
    expect(run.status).toBe('waiting_on_you');
    expect(w.calls.some(call => call.startsWith('approve plan'))).toBe(false);
  });

  it('moves to the next task once the pull request is approved and the build is done', async () => {
    await start(w, ['a', 'b']);
    w.plan('a', 'completed');
    const run = await advanceBoardRun(w.latest(), w.deps);
    expect(run.tasks[0].state).toBe('done');
    expect(w.calls).toContain('request b in chat-1');
  });

  it('finishes when every task is done', async () => {
    await start(w, ['a']);
    w.plan('a', 'completed');
    const run = await advanceBoardRun(w.latest(), w.deps);
    expect(run.status).toBe('completed');
  });

  it('pauses with the reason when a build stops, instead of skipping to the next task', async () => {
    await start(w, ['a', 'b']);
    w.plan('a', 'blocked', { stoppedReason: 'A check failed' });
    const run = await advanceBoardRun(w.latest(), w.deps);
    expect(run.status).toBe('paused');
    expect(run.reason).toMatch(/A stopped \(blocked\): A check failed/);
    expect(w.calls).not.toContain('request b in chat-1');
  });

  it('does not approve the plan of a task that changed after the run started', async () => {
    const changing = issue('a', 'high');
    w = world([changing]);
    await start(w, ['a']);
    w.plan('a', 'awaiting_plan_approval');
    changing.title = 'Something else now';
    const run = await advanceBoardRun(w.latest(), w.deps);
    expect(run.status).toBe('paused');
    expect(run.reason).toMatch(/changed after the run started/);
    expect(w.calls.some(call => call.startsWith('approve plan'))).toBe(false);
  });

  it('pauses when a request could not be planned', async () => {
    await start(w, ['a']);
    const request = [...w.requests.values()][0];
    w.requests.set(request.id, { ...request, status: 'needs_review', reason: 'The task changed' } as BoardBuildRequest);
    const run = await advanceBoardRun(w.latest(), w.deps);
    expect(run.status).toBe('paused');
    expect(run.reason).toMatch(/could not be planned: The task changed/);
  });

  it('pauses itself and the running build at its token or cost limit', async () => {
    await start(w, ['a', 'b'], { maxTokens: 1000, maxCostUsd: 2 });
    w.plan('a', 'executing');
    w.setUsage({ tokens: 1500, costUsd: 0.5, unmeasuredBuilds: 0 });
    let run = await advanceBoardRun(w.latest(), w.deps);
    expect(run.status).toBe('paused');
    expect(run.reason).toMatch(/token limit/);
    expect(w.calls).toContain('pause build run-a');

    w.setUsage({ tokens: 10, costUsd: 3, unmeasuredBuilds: 0 });
    run = await resumeBoardRun(w.latest(), 'lloyd', { maxTokens: 5000 }, w.deps);
    expect(run.status).toBe('paused');
    expect(run.reason).toMatch(/cost limit/);
  });

  it('stops taking tasks when its starter can no longer run builds', async () => {
    await start(w, ['a', 'b']);
    w.setContext({ ...dev, role: 'client' } as WorkspaceContext);
    const run = await advanceBoardRun(w.latest(), w.deps);
    expect(run.status).toBe('paused');
    expect(run.reason).toMatch(/can no longer run builds/);
  });

  it('stops: cancels the waiting request and starts nothing new', async () => {
    const run = stopBoardRun(await start(w, ['a', 'b']), 'lloyd', w.deps);
    expect(run.status).toBe('stopped');
    expect(w.calls.some(call => call.startsWith('cancel'))).toBe(true);
    expect(run.tasks[1].state).toBe('stopped');
    expect((await advanceBoardRun(run, w.deps)).status).toBe('stopped');
  });

  it('is refused for a non-developer, a second run on the project, a done task, or bad limits', async () => {
    await expect(start(w, ['a'], { context: { ...dev, role: 'pm' } as WorkspaceContext })).rejects.toThrow(/Only a developer/);
    await expect(start(w, ['a'], { maxTasks: 0 })).rejects.toThrow(/between 1 and/);
    await expect(start(w, ['a'], { maxCostUsd: -1 })).rejects.toThrow(/positive number/);
    const done = world([issue('a', 'high', { status: 'done' })]);
    await expect(start(done, ['a'])).rejects.toThrow(/open task/);
    await start(w, ['a']);
    await expect(start(w, ['b'])).rejects.toThrow(/already has a board run/);
  });

  it('records the source of each task so a later change is noticed', async () => {
    const run = await start(w, ['a']);
    expect(run.tasks[0].sourceHash).toBe(boardBuildSourceHash(issue('a', 'high'), project, 0));
  });
});
