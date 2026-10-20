import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { SQLiteService } from './sqliteService.js';
import { parseOrchestrationPlan } from './orchestrationContract.js';
import { initialTaskRecords } from './orchestrationStateMachine.js';
import { runWithWorkspace } from './workspaceContext.js';

const plan = parseOrchestrationPlan({
  schemaVersion: 1,
  goal: 'Create and complete tasks.',
  exclusions: [],
  requirements: [
    { id: 'REQ-1', description: 'Create tasks.' },
    { id: 'REQ-2', description: 'Complete tasks.' }
  ],
  tasks: [
    { id: 'api-create', title: 'Create endpoint', description: 'Implement task creation.', kind: 'backend', ownerAgentId: 'backend', dependsOn: [], requirementIds: ['REQ-1'], acceptanceCriteria: ['Creation persists.'] },
    { id: 'api-complete', title: 'Complete endpoint', description: 'Implement task completion.', kind: 'backend', ownerAgentId: 'backend', dependsOn: ['api-create'], requirementIds: ['REQ-2'], acceptanceCriteria: ['Completion persists.'] }
  ]
});

describe('task orchestration persistence', () => {
  let directory = '';
  let store: SQLiteService | undefined;

  afterEach(() => {
    store?.close();
    store = undefined;
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    directory = '';
  });

  it('persists task identity, transitions, attempts, events, and workspace isolation atomically', () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-orchestration-'));
    const dbPath = path.join(directory, 'alpha.db');
    store = new SQLiteService({ dbPath, seedDefaults: false });
    const now = '2026-10-19T00:00:00.000Z';
    const initial = store.createOrchestrationSnapshot({
      id: 'orchestration-1',
      workspaceId: 'ws-default',
      projectId: 'project-1',
      issueId: 'issue-1',
      repository: 'acme/tasks',
      requestKey: 'request-1',
      requestFingerprint: 'sha256:request-1',
      createdBy: 'user-1',
      executorId: 'desktop-1',
      ownershipEpoch: 1,
      workflowVersion: 1,
      planVersion: 1,
      plan,
      status: 'planning',
      revision: 0,
      createdAt: now,
      updatedAt: now
    }, initialTaskRecords(plan), 'template');

    expect(store.getActiveOrchestrationForProject('project-1', 'ACME/tasks.git')).toMatchObject({
      runId: 'orchestration-1', repository: 'acme/tasks', status: 'planning'
    });
    expect(store.getActiveOrchestrationForProject('project-1', 'another/repository')).toBeUndefined();

    expect(initial.tasks.map(task => [task.id, task.status])).toEqual([
      ['api-create', 'ready'], ['api-complete', 'pending']
    ]);
    expect(store.getOrchestrationByRequestKey('request-1')?.run.id).toBe('orchestration-1');
    store.transitionOrchestrationRun({ runId: 'orchestration-1', expectedRevision: 0, nextStatus: 'executing', now });
    store.addAllowedPath(directory, 'orchestration fixture');
    const workspace = store.bindOrchestrationWorkspace({
      runId: 'orchestration-1', branchName: 'alpha/orchestration/test-run', baseRef: 'HEAD',
      baseCommit: 'a'.repeat(40), worktreePath: directory, actorId: 'user-1', now
    });
    expect(workspace.run).toMatchObject({
      branchName: 'alpha/orchestration/test-run', baseRef: 'HEAD', baseCommit: 'a'.repeat(40), worktreePath: directory
    });
    expect(store.bindOrchestrationWorkspace({
      runId: 'orchestration-1', branchName: 'alpha/orchestration/test-run', baseRef: 'HEAD',
      baseCommit: 'a'.repeat(40), worktreePath: directory, actorId: 'user-1', now
    }).run.revision).toBe(2);

    const started = store.startOrchestrationAttempt({
      runId: 'orchestration-1', taskId: 'api-create', expectedTaskRevision: 0,
      attemptId: 'attempt-1', startingCommit: 'base-sha', personaHash: 'persona-hash',
      modelProvider: 'OpenAI', modelName: 'test-model', contextManifest: { taskId: 'api-create', manifestVersion: 1 },
      actorId: 'user-1', now
    });
    expect(started.run.currentTaskId).toBe('api-create');
    expect(started.tasks[0].attemptCount).toBe(1);
    store.bindOrchestrationAttempt({ runId: 'orchestration-1', attemptId: 'attempt-1', prototypeRunId: 'prototype-run-1', now });
    store.submitOrchestrationAttempt({
      runId: 'orchestration-1', taskId: 'api-create', attemptId: 'attempt-1', expectedTaskRevision: 1,
      result: { summary: 'Creation endpoint implemented', reportedChecks: ['test'] }, resultCommit: 'result-sha', now
    });
    const accepted = store.acceptOrchestrationAttempt({
      runId: 'orchestration-1', taskId: 'api-create', attemptId: 'attempt-1', expectedTaskRevision: 2,
      acceptedBy: 'orchestrator', evidence: { check: 'endpoint-contract', passed: true }, now
    });

    expect(accepted.tasks.map(task => [task.id, task.status])).toEqual([
      ['api-create', 'accepted'], ['api-complete', 'ready']
    ]);
    expect(accepted.attempts[0]).toMatchObject({
      status: 'accepted', prototypeRunId: 'prototype-run-1', startingCommit: 'base-sha', resultCommit: 'result-sha'
    });
    expect(store.listOrchestrationEvents('orchestration-1').map(event => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(runWithWorkspace('other-workspace', () => store!.getOrchestrationSnapshot('orchestration-1'))).toBeUndefined();
    expect(() => store!.transitionOrchestrationTask({
      runId: 'orchestration-1', taskId: 'api-complete', expectedRevision: 0, nextStatus: 'running', now
    })).toThrow(/startOrchestrationAttempt/);

    store.close();
    store = new SQLiteService({ dbPath, seedDefaults: false });
    expect(store.getOrchestrationSnapshot('orchestration-1')).toMatchObject({
      run: { status: 'executing', revision: 4, currentTaskId: undefined, branchName: 'alpha/orchestration/test-run' },
      tasks: [{ id: 'api-create', status: 'accepted' }, { id: 'api-complete', status: 'ready' }]
    });
  });

  it('replays due event notifications with stable cursors and records delivery or retry state', () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-orchestration-outbox-'));
    store = new SQLiteService({ dbPath: path.join(directory, 'alpha.db'), seedDefaults: false });
    const now = '2026-10-19T00:00:00.000Z';
    store.createOrchestrationSnapshot({
      id: 'orchestration-outbox-1', workspaceId: 'ws-default', projectId: 'project-outbox', issueId: 'issue-outbox',
      repository: 'acme/tasks', requestKey: 'request-outbox', requestFingerprint: 'fingerprint-outbox',
      createdBy: 'user-1', executorId: 'desktop-1', ownershipEpoch: 1, workflowVersion: 1, planVersion: 1,
      plan, status: 'planning', revision: 0, createdAt: now, updatedAt: now
    }, initialTaskRecords(plan));

    const first = store.listDueOrchestrationOutbox(now, 1)[0];
    expect(first).toMatchObject({
      workspaceId: 'ws-default', runId: 'orchestration-outbox-1', sequence: 1, attempts: 0
    });
    expect(store.markOrchestrationOutboxDelivered(first.workspaceId, first.eventId, now)).toBe(true);
    expect(store.markOrchestrationOutboxDelivered(first.workspaceId, first.eventId, now)).toBe(false);
    store.transitionOrchestrationRun({ runId: 'orchestration-outbox-1', expectedRevision: 0, nextStatus: 'executing', now });

    const second = store.listDueOrchestrationOutbox(now, 1)[0];
    expect(second.eventId).not.toBe(first.eventId);
    expect(store.retryOrchestrationOutbox({
      workspaceId: second.workspaceId,
      eventId: second.eventId,
      nextAttemptAt: '2026-10-19T00:00:01.000Z',
      errorCode: 'notification_publish_failed'
    })).toBe(true);
    expect(store.listDueOrchestrationOutbox(now, 100).some(event => event.eventId === second.eventId)).toBe(false);
    store.close();
    store = new SQLiteService({ dbPath: path.join(directory, 'alpha.db'), seedDefaults: false });
    const replayed = store.listDueOrchestrationOutbox('2026-10-19T00:00:01.000Z', 100);
    expect(replayed).toContainEqual({
      ...second,
      attempts: 1
    });
    expect(store.markOrchestrationOutboxDelivered(second.workspaceId, second.eventId, '2026-10-19T00:00:02.000Z')).toBe(true);
    expect(store.listDueOrchestrationOutbox('2026-10-19T00:00:02.000Z', 100)).toEqual([]);
  });

  it('keeps desktop orchestration always on and workspace-scoped', () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-orchestration-setting-'));
    store = new SQLiteService({ dbPath: path.join(directory, 'alpha.db'), seedDefaults: false });
    runWithWorkspace('ws-default', () => store!.createProject({ id: 'project-opt-in', name: 'Opt in', key: 'OPT' }));

    expect(runWithWorkspace('ws-default', () => store!.getProjectOrchestrationSetting('project-opt-in').enabled)).toBe(true);
    runWithWorkspace('ws-default', () => {
      (store as any).db.prepare(`INSERT INTO project_orchestration_settings
        (workspace_id, project_id, enabled, updated_by, updated_at) VALUES (?, ?, 0, ?, ?)`)
        .run('ws-default', 'project-opt-in', 'legacy-user', '2026-10-20T00:00:00.000Z');
    });
    expect(runWithWorkspace('ws-default', () => store!.getProjectOrchestrationSetting('project-opt-in').enabled)).toBe(true);
    runWithWorkspace('ws-default', () => store!.setProjectOrchestrationEnabled('project-opt-in', true, 'user-1'));
    expect(runWithWorkspace('ws-default', () => store!.getProjectOrchestrationSetting('project-opt-in'))).toMatchObject({
      enabled: true, updatedBy: 'user-1'
    });
    expect(() => runWithWorkspace('other-workspace', () => store!.setProjectOrchestrationEnabled('project-opt-in', false, 'user-2'))).toThrow(/Project not found/);
    expect(runWithWorkspace('ws-default', () => store!.getProjectOrchestrationSetting('project-opt-in').enabled)).toBe(true);
    expect(() => runWithWorkspace('ws-default', () => store!.setProjectOrchestrationEnabled('project-opt-in', false, 'user-1'))).toThrow(/always enabled on desktop/);
  });

  it('adds orchestration tables when opening a populated database from before orchestration', () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-orchestration-legacy-db-'));
    const dbPath = path.join(directory, 'alpha.db');
    store = new SQLiteService({ dbPath, seedDefaults: false });
    runWithWorkspace('ws-default', () => store!.createProject({ id: 'legacy-project', name: 'Legacy', key: 'LEG' }));
    store.close();
    store = undefined;

    // This models a valid, populated Alpha database from before the
    // orchestration feature added its tables and per-project setting.
    const legacyDb = new Database(dbPath);
    legacyDb.pragma('foreign_keys = ON');
    legacyDb.exec(`
      DROP TABLE orchestration_outbox;
      DROP TABLE orchestration_events;
      DROP TABLE orchestration_findings;
      DROP TABLE orchestration_artifacts;
      DROP TABLE orchestration_attempts;
      DROP TABLE orchestration_tasks;
      DROP TABLE orchestration_plans;
      DROP TABLE orchestration_runs;
      DROP TABLE orchestration_planning_recoveries;
      DROP TABLE orchestration_planning_reservations;
      DROP TABLE project_code_execution_locks;
      DROP TABLE project_orchestration_settings;
    `);
    legacyDb.close();

    expect(() => { store = new SQLiteService({ dbPath, seedDefaults: false }); }).not.toThrow();
    expect(runWithWorkspace('ws-default', () => store!.getProjects().find(project => project.id === 'legacy-project'))).toMatchObject({
      id: 'legacy-project', name: 'Legacy', key: 'LEG'
    });
    expect(runWithWorkspace('ws-default', () => store!.getProjectOrchestrationSetting('legacy-project'))).toMatchObject({
      enabled: true
    });
    expect(store!.listDueOrchestrationOutbox(new Date().toISOString(), 10)).toEqual([]);
  });

  it('moves an unconfirmed stop into recovery after a daemon restart and keeps the repository reserved', () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-orchestration-stopping-recovery-'));
    store = new SQLiteService({ dbPath: path.join(directory, 'alpha.db'), seedDefaults: false });
    const now = '2026-10-20T00:00:00.000Z';
    const initial = store.createOrchestrationSnapshot({
      id: 'orchestration-stop-recovery', workspaceId: 'ws-default', projectId: 'project-stop-recovery',
      issueId: 'issue-stop-recovery', repository: 'acme/stop-recovery', requestKey: 'request-stop-recovery',
      requestFingerprint: 'fingerprint-stop-recovery', createdBy: 'user-1', executorId: 'desktop-1',
      ownershipEpoch: 1, workflowVersion: 1, planVersion: 1, plan, status: 'planning', revision: 0,
      createdAt: now, updatedAt: now
    }, initialTaskRecords(plan));
    store.transitionOrchestrationRun({ runId: initial.run.id, expectedRevision: 0, nextStatus: 'executing', now });
    store.startOrchestrationAttempt({
      runId: initial.run.id, taskId: initial.tasks[0].id, expectedTaskRevision: 0, attemptId: 'attempt-stop-recovery',
      startingCommit: 'base-sha', personaHash: 'persona-hash', modelProvider: 'OpenAI', modelName: 'test-model',
      contextManifest: { taskId: initial.tasks[0].id }, actorId: 'user-1', now
    });
    store.bindOrchestrationAttempt({ runId: initial.run.id, attemptId: 'attempt-stop-recovery', prototypeRunId: 'prototype-stop-recovery', now });
    const stopping = store.getOrchestrationSnapshot(initial.run.id)!;
    store.transitionOrchestrationRun({
      runId: initial.run.id, expectedRevision: stopping.run.revision, nextStatus: 'cancelling', actorId: 'user-1',
      reason: 'Waiting for process termination.', now
    });

    const recovered = store.markOrchestrationRecoveryRequired({
      runId: initial.run.id, actorId: 'orchestrator', reason: 'Restart occurred before process termination was confirmed.', now
    });

    expect(recovered.run.status).toBe('recovery_required');
    expect(recovered.tasks[0].status).toBe('blocked');
    expect(recovered.attempts[0].status).toBe('recovery_required');
    expect(store.getActiveOrchestrationForProject('project-stop-recovery', 'acme/stop-recovery')?.status).toBe('recovery_required');
  });

  it('reserves one canonical project repository during planning and atomically hands it to the activated run', () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-orchestration-reservation-'));
    store = new SQLiteService({ dbPath: path.join(directory, 'alpha.db'), seedDefaults: false });
    runWithWorkspace('ws-default', () => store!.createProject({ id: 'project-reserved', name: 'Reserved', key: 'RSV' }));
    store.addAllowedPath(directory, 'planning reservation fixture');
    const reservation = runWithWorkspace('ws-default', () => store!.reserveOrchestrationPlanning({
      projectId: 'project-reserved', repository: 'https://github.com/Acme/Tasks.git',
      requestKey: 'request-reserved', requestFingerprint: 'fingerprint-reserved',
      createdBy: 'user-1', runId: 'orchestration-reserved-1', branchName: 'alpha/orchestration/reserved1',
      baseCommit: 'a'.repeat(40), worktreePath: path.join(directory, 'worktree'), ownerSessionId: 'session-one'
    }));

    expect(reservation.created).toBe(true);
    expect(runWithWorkspace('ws-default', () => store!.getActiveOrchestrationForProject('project-reserved', 'acme/tasks')))
      .toMatchObject({ runId: reservation.runId, repository: 'https://github.com/Acme/Tasks.git', status: 'planning' });
    const retry = runWithWorkspace('ws-default', () => store!.reserveOrchestrationPlanning({
      projectId: 'project-reserved', repository: 'acme/tasks', requestKey: 'request-reserved',
      requestFingerprint: 'fingerprint-reserved', createdBy: 'user-1', runId: 'a-different-generated-id',
      branchName: 'a-different-branch', baseCommit: 'b'.repeat(40), worktreePath: path.join(directory, 'different'),
      ownerSessionId: 'session-two'
    }));
    expect(retry).toMatchObject({
      created: false, runId: 'orchestration-reserved-1', baseCommit: 'a'.repeat(40), ownerSessionId: 'session-one'
    });
    expect(runWithWorkspace('ws-default', () => store!.releaseOrchestrationPlanningReservation(
      reservation.requestKey, reservation.requestFingerprint, 'session-two'
    ))).toBe(false);
    expect(() => runWithWorkspace('ws-default', () => store!.reserveOrchestrationPlanning({
      projectId: 'project-reserved', repository: 'acme/tasks.git', requestKey: 'another-request',
      requestFingerprint: 'different-fingerprint', createdBy: 'user-2', runId: 'orchestration-reserved-2',
      branchName: 'alpha/orchestration/reserved2', baseCommit: 'c'.repeat(40), worktreePath: path.join(directory, 'other'),
      ownerSessionId: 'session-two'
    }))).toThrow(/already being planned/);

    const run = {
      id: reservation.runId, workspaceId: 'ws-default', projectId: 'project-reserved', issueId: 'issue-1',
      repository: 'https://github.com/Acme/Tasks.git', requestKey: reservation.requestKey,
      requestFingerprint: reservation.requestFingerprint, createdBy: 'user-1', executorId: 'desktop-1',
      ownershipEpoch: 1, workflowVersion: 1, planVersion: 1, plan,
      status: 'planning', revision: 0, branchName: reservation.branchName,
      baseRef: reservation.baseCommit, baseCommit: reservation.baseCommit,
      worktreePath: reservation.worktreePath, createdAt: reservation.createdAt, updatedAt: reservation.createdAt
    } as const;
    expect(() => runWithWorkspace('ws-default', () => store!.createOrchestrationSnapshot(
      run, initialTaskRecords(plan), 'model', 'session-two'
    ))).toThrow(/no longer owned by this Alpha session/);
    expect(runWithWorkspace('ws-default', () => store!.getOrchestrationSnapshot(reservation.runId))).toBeUndefined();
    const activated = runWithWorkspace('ws-default', () => store!.createOrchestrationSnapshot(
      run, initialTaskRecords(plan), 'model', 'session-one'
    ));

    expect(activated.run.id).toBe(reservation.runId);
    expect(runWithWorkspace('ws-default', () => store!.getOrchestrationPlanningReservation('project-reserved', 'acme/tasks'))).toBeUndefined();
    expect(runWithWorkspace('ws-default', () => store!.getActiveOrchestrationForProject('project-reserved', 'acme/tasks')))
      .toMatchObject({ runId: reservation.runId, status: 'planning' });
  });

  it('keeps a preserved planning worktree locked until a revision-checked retain decision', () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-orchestration-recovery-record-'));
    store = new SQLiteService({ dbPath: path.join(directory, 'alpha.db'), seedDefaults: false });
    runWithWorkspace('ws-default', () => store!.createProject({ id: 'project-recovery-record', name: 'Recovery', key: 'RCV' }));
    store.addAllowedPath(directory, 'planning recovery fixture');
    const worktreePath = path.join(directory, 'saved-worktree');
    fs.mkdirSync(worktreePath);
    const reservation = runWithWorkspace('ws-default', () => store!.reserveOrchestrationPlanning({
      projectId: 'project-recovery-record', repository: 'acme/recovery', requestKey: 'recovery-request',
      requestFingerprint: 'recovery-fingerprint', createdBy: 'user-1', runId: 'orchestration-recovery-1',
      branchName: 'alpha/orchestration/recovery1', baseCommit: 'd'.repeat(40), worktreePath, ownerSessionId: 'old-session'
    }));
    const recovery = runWithWorkspace('ws-default', () => store!.recordOrchestrationPlanningRecovery({
      projectId: 'project-recovery-record', reservation, state: 'needs_review',
      reason: 'The saved worktree changed before plan activation.'
    }));

    expect(recovery).toMatchObject({ runId: reservation.runId, state: 'needs_review', revision: 0 });
    expect(runWithWorkspace('ws-default', () => store!.getActiveOrchestrationForProject('project-recovery-record', 'acme/recovery')))
      .toMatchObject({ runId: reservation.runId, status: 'planning' });
    expect(() => runWithWorkspace('ws-default', () => store!.retainOrchestrationPlanningRecovery({
      projectId: 'project-recovery-record', runId: reservation.runId, expectedRevision: 1, actorId: 'user-1'
    }))).toThrow(/changed during review/);
    expect(runWithWorkspace('ws-default', () => store!.getOrchestrationPlanningReservationByRun('project-recovery-record', reservation.runId)))
      .toBeDefined();

    const retained = runWithWorkspace('ws-default', () => store!.retainOrchestrationPlanningRecovery({
      projectId: 'project-recovery-record', runId: reservation.runId, expectedRevision: 0, actorId: 'user-1'
    }));
    expect(retained).toMatchObject({ state: 'retained', revision: 1, resolvedBy: 'user-1' });
    expect(fs.existsSync(worktreePath)).toBe(true);
    expect(runWithWorkspace('ws-default', () => store!.getOrchestrationPlanningReservationByRun('project-recovery-record', reservation.runId)))
      .toBeUndefined();
    expect(runWithWorkspace('ws-default', () => store!.getActiveOrchestrationForProject('project-recovery-record', 'acme/recovery')))
      .toBeUndefined();
    expect(runWithWorkspace('ws-default', () => store!.listOrchestrationPlanningRecoveries('project-recovery-record')))
      .toMatchObject([{ runId: reservation.runId, state: 'retained' }]);
  });

  it('records and unlocks a manual recovery after a later safe clean inspection', () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-orchestration-recovery-clean-'));
    store = new SQLiteService({ dbPath: path.join(directory, 'alpha.db'), seedDefaults: false });
    runWithWorkspace('ws-default', () => store!.createProject({ id: 'project-recovery-clean', name: 'Recovery', key: 'RCVCLEAN' }));
    store.addAllowedPath(directory, 'planning recovery fixture');
    const reservation = runWithWorkspace('ws-default', () => store!.reserveOrchestrationPlanning({
      projectId: 'project-recovery-clean', repository: 'acme/recovery-clean', requestKey: 'clean-request',
      requestFingerprint: 'clean-fingerprint', createdBy: 'user-1', runId: 'orchestration-recovery-clean',
      branchName: 'alpha/orchestration/recoveryclean', baseCommit: 'e'.repeat(40),
      worktreePath: path.join(directory, 'clean-worktree'), ownerSessionId: 'old-session'
    }));
    runWithWorkspace('ws-default', () => store!.recordOrchestrationPlanningRecovery({
      projectId: 'project-recovery-clean', reservation, state: 'manual_review', reason: 'Workspace identity was uncertain.'
    }));

    const result = runWithWorkspace('ws-default', () => store!.cleanOrchestrationPlanningReservation({
      projectId: 'project-recovery-clean', runId: reservation.runId, reservation, actorId: 'user-1'
    }));

    expect(result).toEqual({ recoveryState: 'cleaned', revision: 1 });
    expect(runWithWorkspace('ws-default', () => store!.getOrchestrationPlanningReservationByRun('project-recovery-clean', reservation.runId)))
      .toBeUndefined();
    expect(runWithWorkspace('ws-default', () => store!.getOrchestrationPlanningRecovery('project-recovery-clean', reservation.runId)))
      .toMatchObject({ state: 'cleaned', resolvedBy: 'user-1', revision: 1 });
  });
});
