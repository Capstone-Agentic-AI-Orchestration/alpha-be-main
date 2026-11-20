import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A restart must not leave work looking alive.
 *
 * Runs are child processes of the daemon and squad runs are advanced by an
 * in-memory listener map, so neither survives a restart — but the rows do. An
 * interrupted run stayed `running`, its squad stayed `running`, and its card
 * stayed in Agent Running for ever, with nothing behind it and no way to clear
 * it from the UI.
 *
 * These start the data layer against a temp directory, plant the state a crash
 * would leave, and reconcile as a fresh process does at boot.
 */
let tmp: string;
let opened: { close(): void }[] = [];

async function startDaemon() {
  process.env.ALPHA_HOME = tmp;
  vi.resetModules();
  const sql = await import('./sqliteService.js');
  const rec = await import('./startupReconcile.js');
  opened.push(sql.sqliteService);
  return { svc: sql.sqliteService as any, reconcile: rec.reconcileInterruptedWork };
}

/** The rows a crash leaves behind, minus whichever parts a case does not need. */
function plantProject(svc: any) {
  if (!svc.getProjects().length) {
    svc.createProject({ id: 'proj-1', name: 'Repo', key: 'ALF', localPath: tmp });
  }
}

function plantIssue(svc: any, id: string, status = 'agent_running') {
  plantProject(svc);
  return svc.createIssue({
    id,
    projectId: 'proj-1',
    title: 'Add a thing',
    status,
    branchName: 'feat/alf-101-0001'
  });
}

function plantRun(svc: any, over: Record<string, unknown> = {}) {
  return svc.savePrototypeRun({
    id: 'run-1',
    issueId: 'iss-1',
    projectId: 'proj-1',
    agentId: 'agent-architect',
    status: 'running',
    plan: [],
    currentStageIndex: 1,
    branchName: 'feat/alf-101-0001',
    stages: [
      { id: 'workspace', label: 'Preparing workspace', description: '', status: 'success', logs: [] },
      { id: 'analysis', label: 'Analyzing context', description: '', status: 'running', logs: [] },
      { id: 'implementation', label: 'Implementing changes', description: '', status: 'pending', logs: [] }
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over
  });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-reconcile-'));
  opened = [];
});

afterEach(() => {
  for (const svc of opened) {
    try { svc.close(); } catch { /* already closed */ }
  }
  delete process.env.ALPHA_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('reconcileInterruptedWork', () => {
  it('does nothing when there was nothing in flight', async () => {
    const { svc, reconcile } = await startDaemon();
    plantIssue(svc, 'iss-1', 'todo');
    plantRun(svc, { status: 'completed' });

    expect(reconcile()).toEqual({ runs: [], squadRuns: [], issues: [], agentCalls: [] });
    expect(svc.getPrototypeRuns()[0].status).toBe('completed');
  });

  it('fails a queued or running independent call and releases its repository lock after restart', async () => {
    const { svc, reconcile } = await startDaemon();
    plantProject(svc);
    svc.createChatThread({ id: 'thread-agent-call', projectId: 'proj-1', ownerId: 'user-1' });
    svc.saveAgentCallWithProjectLock({
      id: 'call-interrupted', workspaceId: 'ws-default', projectId: 'proj-1',
      threadId: 'thread-agent-call', squadId: 'squad-1', agentId: 'agent-1',
      requestedBy: 'user-1', operationMode: 'revise', origin: 'agent_call',
      status: 'queued', instruction: 'Prepare a focused code proposal.',
      createdAt: new Date().toISOString(), artifacts: [], activities: []
    }, 'acme/tasks');
    svc.updateAgentCall('call-interrupted', { status: 'running', startedAt: new Date().toISOString() });

    const result = reconcile();

    expect(result.agentCalls).toEqual(['call-interrupted']);
    expect(svc.getAgentCall('call-interrupted')).toMatchObject({
      status: 'failed', error: expect.stringContaining('interrupted when Alpha stopped')
    });
    expect(svc.getActiveAgentCallProjectLock('proj-1', 'acme/tasks')).toBeUndefined();
  });

  it('fails an interrupted run and moves its issue back', async () => {
    const { svc, reconcile } = await startDaemon();
    plantIssue(svc, 'iss-1');
    plantRun(svc);

    const result = reconcile();

    expect(result.runs).toEqual(['run-1']);
    expect(result.issues).toEqual(['iss-1']);
    expect(svc.getPrototypeRuns()[0].status).toBe('failed');
    expect(svc.getIssues()[0].status).toBe('in_progress');
  });

  it('closes the stage that was cut off, not the ones that finished', async () => {
    // A stage left 'running' keeps a spinner turning for a run that has ended.
    const { svc, reconcile } = await startDaemon();
    plantIssue(svc, 'iss-1');
    plantRun(svc);
    reconcile();

    const stages = svc.getPrototypeRuns()[0].stages;
    expect(stages.map((s: any) => s.status)).toEqual(['success', 'failed', 'pending']);
    expect(stages[1].logs.join(' ')).toContain('daemon stopped');
  });

  it('closes a queued run too', async () => {
    // A run that never got its turn is just as orphaned as one mid-flight.
    const { svc, reconcile } = await startDaemon();
    plantIssue(svc, 'iss-1');
    plantRun(svc, { status: 'queued' });

    expect(reconcile().runs).toEqual(['run-1']);
    expect(svc.getPrototypeRuns()[0].status).toBe('failed');
  });

  it('leaves versioned orchestration children for their parent recovery workflow', async () => {
    const { svc, reconcile } = await startDaemon();
    plantIssue(svc, 'iss-1');
    plantRun(svc, {
      orchestrationRunId: 'orchestration-1',
      orchestrationTaskId: 'task-1',
      orchestrationAttemptId: 'attempt-1'
    });

    expect(reconcile()).toEqual({ runs: [], squadRuns: [], issues: [], agentCalls: [] });
    expect(svc.getPrototypeRuns()[0].status).toBe('running');
    expect(svc.getIssues()[0].status).toBe('agent_running');
  });

  it('stops an interrupted squad run and says where it got to', async () => {
    const { svc, reconcile } = await startDaemon();
    plantIssue(svc, 'iss-1');
    svc.saveSquadRun({
      id: 'sr-1',
      squadId: 'squad-core',
      issueId: 'iss-1',
      projectId: 'proj-1',
      branchName: 'feat/alf-101-squad-0001',
      memberAgentIds: ['a', 'b', 'c', 'd'],
      currentMemberIndex: 1,
      status: 'running',
      mission: 'Do the thing',
      plan: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    expect(reconcile().squadRuns).toEqual(['sr-1']);

    const sr = svc.getSquadRuns()[0];
    expect(sr.status).toBe('failed');
    // The position matters: it tells you which member's work is on the branch.
    expect(sr.stoppedReason).toContain('member 2 of 4');
    expect(sr.stoppedReason).toContain('feat/alf-101-squad-0001');
  });

  it('leaves a finished squad run alone', async () => {
    const { svc, reconcile } = await startDaemon();
    plantIssue(svc, 'iss-1', 'review');
    svc.saveSquadRun({
      id: 'sr-1',
      squadId: 'squad-core',
      issueId: 'iss-1',
      projectId: 'proj-1',
      branchName: 'b',
      memberAgentIds: ['a'],
      currentMemberIndex: 0,
      status: 'awaiting_approval',
      mission: 'm',
      plan: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    expect(reconcile().squadRuns).toEqual([]);
    expect(svc.getSquadRuns()[0].status).toBe('awaiting_approval');
  });

  /**
   * Only cards belonging to work that was actually closed.
   *
   * Scanning for `agent_running` instead would sweep up an issue a *running*
   * daemon owns — there is a moment between a run being created and its first
   * stage landing where that status is entirely correct.
   */
  it('does not touch an agent_running issue with no interrupted run', async () => {
    const { svc, reconcile } = await startDaemon();
    plantIssue(svc, 'iss-1');
    plantIssue(svc, 'iss-2');
    plantRun(svc, { issueId: 'iss-1' });

    reconcile();

    const byId = Object.fromEntries(svc.getIssues().map((i: any) => [i.id, i.status]));
    expect(byId['iss-1']).toBe('in_progress');
    expect(byId['iss-2']).toBe('agent_running');
  });

  it('moves the card back without commenting on it', async () => {
    const { svc, reconcile } = await startDaemon();
    plantIssue(svc, 'iss-1');
    plantRun(svc);
    reconcile();

    // Task comments are for people; the interrupted run is visible on the run itself.
    expect(svc.getIssues()[0].status).toBe('in_progress');
    expect(svc.getIssues()[0].comments ?? []).toEqual([]);
  });

  it('is safe to run twice', async () => {
    // The daemon may restart repeatedly; the second pass must find nothing.
    const { svc, reconcile } = await startDaemon();
    plantIssue(svc, 'iss-1');
    plantRun(svc);

    reconcile();
    expect(reconcile()).toEqual({ runs: [], squadRuns: [], issues: [], agentCalls: [] });
    expect(svc.getIssues()[0].comments ?? []).toEqual([]);
  });
});
