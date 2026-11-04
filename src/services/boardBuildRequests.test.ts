import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Issue, Project } from '../models/index.js';
import type { WorkspaceContext } from './workspaceRegistry.js';

const fixture = vi.hoisted(() => ({ records: new Map<string, any>(), blocker: true, spec: 1,
  start: vi.fn(async (_input: unknown) => ({ status: 'plan_ready', orchestrationRunId: 'parent-build' })), resolve: vi.fn(), issue: {} as any, project: {} as any }));
vi.mock('./sqliteService.js', () => ({ sqliteService: {
  listBoardBuildRequests: (workspaceId?: string) => [...fixture.records.values()].filter(item => !workspaceId || item.workspaceId === workspaceId),
  saveBoardBuildRequest: (record: any) => fixture.records.set(record.id, structuredClone(record)),
  getFeatureSpec: () => ({ version: fixture.spec }),
  getActiveOrchestrationForProject: () => fixture.blocker ? { runId: 'blocking-run', projectId: 'project', issueId: 'other-task', status: 'blocked' } : undefined,
  getOrchestrationPlanningReservation: () => undefined
} }));
vi.mock('../store/stores.js', () => ({ issueStore: () => ({ get: async () => fixture.issue, update: vi.fn(async () => fixture.issue) }), projectStore: () => ({ get: async () => fixture.project }) }));
vi.mock('./workspaceRegistry.js', () => ({ workspaceRegistry: { can: () => true, canAccessProjectBuilds: () => true, resolve: fixture.resolve } }));
vi.mock('./boardThreadService.js', () => ({ ensureBoardThread: () => ({ thread: { id: 'task-private' } }) }));
vi.mock('./projectBuildOrchestrator.js', () => ({ startProjectBuild: fixture.start }));
vi.mock('./chatService.js', () => ({ chatService: { sendMessage: async (input: any) => ({ build: await fixture.start({ messageId: input.clientMessageId, issueId: input.buildRequest.issueId, threadId: input.threadId }) }), finishTurn: vi.fn() } }));
import { requestBoardBuild, startBoardBuildQueue } from './boardBuildRequests.js';

describe('durable board planning requests', () => {
  const context = { workspaceId: 'workspace', userId: 'developer', role: 'dev' } as WorkspaceContext;
  let stop: (() => void) | undefined;
  beforeEach(() => {
    vi.useFakeTimers(); fixture.records.clear(); fixture.blocker = true; fixture.spec = 1; fixture.start.mockClear();
    fixture.issue = { id: 'issue', identifier: 'CAP-102', projectId: 'project', title: 'Task', description: 'Saved scope', subtasks: [], labels: ['alpha:task-orchestration'], status: 'todo' } as unknown as Issue;
    fixture.project = { id: 'project', resources: [{ type: 'github_repo', pathOrUrl: 'https://github.com/acme/app' }] } as Project;
    fixture.resolve.mockResolvedValue(context);
  });
  afterEach(() => { stop?.(); stop = undefined; vi.useRealTimers(); });
  const submit = (extra = {}) => requestBoardBuild({ context, issue: fixture.issue, project: fixture.project, requestId: 'request-one', instructions: 'Keep the saved scope.', queue: true, ...extra });

  it('does not run or spend an attempt while waiting; replay resolves to one saved request', async () => {
    expect((await submit()).status).toBe('waiting');
    expect((await submit()).id).toBe('request-one');
    expect(fixture.records.size).toBe(1); expect(fixture.start).not.toHaveBeenCalled();
    stop = startBoardBuildQueue(); fixture.blocker = false;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fixture.start).toHaveBeenCalledTimes(1);
    expect(fixture.start.mock.calls[0][0]).toMatchObject({ messageId: 'request-one', issueId: 'issue', threadId: 'task-private' });
    expect(fixture.records.get('request-one').status).toBe('accepted');
    await vi.advanceTimersByTimeAsync(20_000); expect(fixture.start).toHaveBeenCalledTimes(1);
  });
  it('requires explicit queueing and refuses PM and admin AI access before saving', async () => {
    await expect(submit({ queue: false })).rejects.toThrow(/queue/);
    for (const role of ['pm', 'admin', 'client']) await expect(submit({ context: { ...context, role } })).rejects.toThrow(/developer/);
    expect(fixture.records.size).toBe(0);
  });
  it('revalidates changed requirements and revoked access after a restart', async () => {
    await submit(); fixture.spec = 2; fixture.blocker = false; stop = startBoardBuildQueue();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fixture.records.get('request-one').status).toBe('needs_review'); expect(fixture.start).not.toHaveBeenCalled();
    stop(); stop = undefined; fixture.records.clear(); fixture.spec = 1; fixture.blocker = true; await submit();
    fixture.resolve.mockResolvedValue(null); stop = startBoardBuildQueue();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fixture.records.get('request-one').status).toBe('needs_review'); expect(fixture.start).not.toHaveBeenCalled();
  });
  it('never dispatches a removed queue request or exposes another owner’s private request', async () => {
    await submit();
    await expect(submit({ requestId: 'other-request', context: { ...context, userId: 'another-developer' } })).rejects.toThrow(/another developer/);
    fixture.records.get('request-one').status = 'cancelled'; fixture.blocker = false; stop = startBoardBuildQueue();
    await vi.advanceTimersByTimeAsync(10_000); expect(fixture.start).not.toHaveBeenCalled();
  });
});
