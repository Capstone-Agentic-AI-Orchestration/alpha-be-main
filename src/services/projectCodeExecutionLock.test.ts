import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentCall } from '../models/index.js';
import { SQLiteService } from './sqliteService.js';
import { runWithWorkspace } from './workspaceContext.js';

describe('project code execution admission', () => {
  let directory = '';
  let store: SQLiteService | undefined;
  let secondStore: SQLiteService | undefined;

  afterEach(() => {
    store?.close();
    secondStore?.close();
    store = undefined;
    secondStore = undefined;
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    directory = '';
  });

  function setup() {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-code-lock-'));
    store = new SQLiteService({ dbPath: path.join(directory, 'alpha.db'), seedDefaults: false });
    store.addAllowedPath(directory, 'code-lock fixture');
    runWithWorkspace('ws-default', () => {
      store!.createProject({ id: 'project-1', name: 'Tasks', key: 'TSK' });
      store!.createChatThread({ id: 'thread-1', projectId: 'project-1', ownerId: 'user-1' });
    });
  }

  function call(id: string, status: AgentCall['status'] = 'queued'): AgentCall {
    return {
      id,
      workspaceId: 'ws-default',
      projectId: 'project-1',
      threadId: 'thread-1',
      squadId: 'squad-1',
      agentId: 'agent-1',
      requestedBy: 'user-1',
      operationMode: 'revise',
      origin: 'agent_call',
      status,
      instruction: `Review code for ${id}.`,
      createdAt: '2026-10-20T00:00:00.000Z',
      artifacts: [],
      activities: []
    };
  }

  const reservation = (requestKey: string, repository = 'acme/tasks') => ({
    projectId: 'project-1',
    repository,
    requestKey,
    requestFingerprint: `fingerprint-${requestKey}`,
    createdBy: 'user-1',
    runId: `orchestration-${requestKey}`,
    branchName: `alpha/orchestration/${requestKey}`,
    baseCommit: 'a'.repeat(40),
    worktreePath: path.join(directory, requestKey),
    ownerSessionId: 'session-one'
  });

  it('serializes a build and a code call by canonical repository across SQLite connections', () => {
    setup();
    secondStore = new SQLiteService({ dbPath: path.join(directory, 'alpha.db'), seedDefaults: false });

    store!.saveAgentCallWithProjectLock(call('call-1'), 'https://github.com/Acme/Tasks.git');
    expect(secondStore.getActiveAgentCallProjectLock('project-1', 'ACME/tasks')).toMatchObject({
      agentCallId: 'call-1', repository: 'https://github.com/Acme/Tasks.git', purpose: 'call'
    });
    expect(() => runWithWorkspace('ws-default', () => secondStore!.reserveOrchestrationPlanning(reservation('build-1'))))
      .toThrow(/independent project code call or patch/);

    expect(() => secondStore!.saveAgentCallWithProjectLock(call('call-2'), 'acme/tasks'))
      .toThrow(/Another independent code call or patch/);
    expect(secondStore.getAgentCall('call-2')).toBeNull();

    store!.updateAgentCall('call-1', { status: 'completed', completedAt: '2026-10-20T00:01:00.000Z' });
    expect(secondStore.getActiveAgentCallProjectLock('project-1', 'acme/tasks')).toBeUndefined();
    expect(runWithWorkspace('ws-default', () => secondStore!.reserveOrchestrationPlanning(reservation('build-2'))).created).toBe(true);
  });

  it('checks the planning reservation when an implementation call is explicitly approved', () => {
    setup();
    const pending = call('call-pending', 'awaiting_confirmation');
    pending.operationMode = 'implement';
    store!.saveAgentCallWithProjectLock(pending, 'acme/tasks');

    runWithWorkspace('ws-default', () => store!.reserveOrchestrationPlanning(reservation('build-3')));
    expect(() => store!.queueAgentCallWithProjectLock('call-pending', 'acme/tasks', { status: 'queued' }))
      .toThrow(/task build is being planned/);
    expect(store!.getAgentCall('call-pending')?.status).toBe('awaiting_confirmation');
  });

  it('does not serialize calls that target different repositories', () => {
    setup();
    store!.saveAgentCallWithProjectLock(call('call-tasks'), 'acme/tasks');
    store!.saveAgentCallWithProjectLock(call('call-web'), 'acme/web');

    expect(store!.getActiveAgentCallProjectLock('project-1', 'acme/tasks')?.agentCallId).toBe('call-tasks');
    expect(store!.getActiveAgentCallProjectLock('project-1', 'acme/web')?.agentCallId).toBe('call-web');
  });
});
