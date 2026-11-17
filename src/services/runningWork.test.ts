import { describe, expect, it } from 'vitest';
import type { PrototypeRun } from '../models/index.js';
import type { OrchestrationSnapshot } from './orchestrationStateMachine.js';
import { taskThreadId } from './boardThreads.js';
import { runningWork, type RunningWorkInput } from './runningWork.js';

const issues = [
  { id: 'i-104', identifier: 'TES2-104', title: 'Fix the CI workflow', projectId: 'p1' },
  { id: 'i-102', identifier: 'ECO-102', title: 'Review the CI/CD workflows', projectId: 'p1' }
];

const run = (id: string, status: PrototypeRun['status'], extra: Partial<PrototypeRun> = {}) =>
  ({ id, status, issueId: 'i-104', projectId: 'p1', agentId: 'agent-fe', createdAt: '2026-11-18T01:00:00Z', updatedAt: '2026-11-18T01:05:00Z', ...extra }) as PrototypeRun;

const build = (id: string, status: string, issueId = 'i-104', tasks: Array<{ id: string; kind: string }> = []) =>
  ({ run: { id, status, issueId }, tasks }) as unknown as OrchestrationSnapshot;

const input = (overrides: Partial<RunningWorkInput>): RunningWorkInput => ({
  workspaceId: 'ws', userId: 'me', liveRunIds: [], liveTurns: [], runs: [], issues,
  agentNames: new Map([['agent-fe', 'Frontend Agent']]), threads: new Map(), orchestrations: [], ...overrides
});

describe('runningWork', () => {
  it('lists a live agent run with its task, agent and what it is doing', () => {
    const work = runningWork(input({
      liveRunIds: ['r1'],
      runs: [run('r1', 'running', { orchestrationRunId: 'o1', orchestrationTaskId: 't-fe' })],
      orchestrations: [build('o1', 'executing', 'i-104', [{ id: 't-fe', kind: 'frontend' }])]
    }));
    expect(work.running).toEqual([expect.objectContaining({ kind: 'agent', identifier: 'TES2-104', agentName: 'Frontend Agent', activity: 'Writing code', startedAt: '2026-11-18T01:00:00Z' })]);
    expect(work.interrupted).toEqual([]);
  });

  it('says a validation run is checking the work', () => {
    const work = runningWork(input({
      liveRunIds: ['r1'],
      runs: [run('r1', 'running', { orchestrationRunId: 'o1', orchestrationTaskId: 't-check' })],
      orchestrations: [build('o1', 'executing', 'i-104', [{ id: 't-check', kind: 'validation' }])]
    }));
    expect(work.running[0].activity).toBe('Checking the work');
  });

  it('reports a run saved as running with no live process as interrupted, not running', () => {
    const work = runningWork(input({ runs: [run('r1', 'running', { orchestrationRunId: 'o1' })], orchestrations: [build('o1', 'executing')] }));
    expect(work.running).toEqual([]);
    expect(work.interrupted).toEqual([expect.objectContaining({ identifier: 'TES2-104', activity: 'Nothing is running it any more' })]);
  });

  it('ignores the leftover record of a build that was already stopped', () => {
    // As found on ECO-102: its build was cancelled, but the agent run record still says running.
    const work = runningWork(input({ runs: [run('r1', 'running', { issueId: 'i-102', orchestrationRunId: 'o-cancelled' })] }));
    expect(work).toEqual({ running: [], interrupted: [] });
  });

  it('shows the Orchestrator drafting a plan in the task conversation', () => {
    const work = runningWork(input({
      liveTurns: [{ threadId: taskThreadId('ws', 'me', 'i-102'), agentName: 'Orchestrator', startedAt: '2026-11-18T02:00:00Z' }],
      orchestrations: [build('o2', 'planning', 'i-102')]
    }));
    expect(work.running).toEqual([expect.objectContaining({ kind: 'chat', identifier: 'ECO-102', agentName: 'Orchestrator', activity: 'Drafting a plan' })]);
  });

  it("lists the person's own chats and never anyone else's", () => {
    const work = runningWork(input({
      liveTurns: [
        { threadId: 'mine', agentName: 'Architect', startedAt: '2026-11-18T02:00:00Z' },
        { threadId: 'theirs', agentName: 'Developer', startedAt: '2026-11-18T02:01:00Z' },
        { threadId: taskThreadId('ws', 'someone-else', 'i-104'), startedAt: '2026-11-18T02:02:00Z' }
      ],
      threads: new Map([['mine', { title: 'API questions', projectId: 'p1' }]])
    }));
    expect(work.running.map(item => item.title)).toEqual(['API questions']);
    expect(work.running[0].threadId).toBe('mine');
    expect(work.running[0].activity).toBe('Replying in chat');
  });

  it('lists the oldest work first', () => {
    const work = runningWork(input({
      liveRunIds: ['late', 'early'],
      runs: [run('late', 'running', { createdAt: '2026-11-18T03:00:00Z' }), run('early', 'running', { createdAt: '2026-11-18T01:00:00Z' })]
    }));
    expect(work.running.map(item => item.id)).toEqual(['run:early', 'run:late']);
  });
});
