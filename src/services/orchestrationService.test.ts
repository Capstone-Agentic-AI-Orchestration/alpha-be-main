import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SQLiteService } from './sqliteService.js';
import { parseOrchestrationPlan } from './orchestrationContract.js';
import { OrchestrationService, type OrchestrationExecutor, type OrchestrationLaunchRequest } from './orchestrationService.js';
import { runWithWorkspace } from './workspaceContext.js';

const plan = parseOrchestrationPlan({
  schemaVersion: 1,
  goal: 'Add task creation and completion.',
  requirements: [
    { id: 'REQ-CREATE', description: 'Users can create tasks.' },
    { id: 'REQ-COMPLETE', description: 'Users can complete tasks.' }
  ],
  tasks: [
    {
      id: 'create-endpoint', title: 'Create task endpoint', description: 'Persist a task from an API request.',
      kind: 'backend', ownerAgentId: 'backend-agent', dependsOn: [], requirementIds: ['REQ-CREATE'],
      acceptanceCriteria: ['A created task survives a database reload.']
    },
    {
      id: 'complete-endpoint', title: 'Complete task endpoint', description: 'Mark an existing task complete.',
      kind: 'backend', ownerAgentId: 'backend-agent', dependsOn: ['create-endpoint'], requirementIds: ['REQ-COMPLETE'],
      acceptanceCriteria: ['A task can be completed once and retains its completed state.']
    }
  ]
});

describe('deterministic orchestration orchestrator', () => {
  let directory = '';
  let store: SQLiteService | undefined;

  afterEach(() => {
    store?.close();
    store = undefined;
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    directory = '';
  });

  it('runs only the next task owner and waits for acceptance before dispatching dependent work', async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-orchestration-orchestrator-'));
    store = new SQLiteService({ dbPath: path.join(directory, 'alpha.db'), seedDefaults: false });
    const launches: OrchestrationLaunchRequest[] = [];
    const executor: OrchestrationExecutor = {
      async launch(request) {
        launches.push(request);
        return { prototypeRunId: `prototype-${request.attemptId}` };
      }
    };
    const orchestrator = new OrchestrationService(store, executor);
    const input = {
      workspaceId: 'workspace-test',
      projectId: 'project-test',
      issueId: 'issue-test',
      repository: 'example/tasks',
      requestKey: 'request-test',
      requestFingerprint: 'fingerprint-test',
      createdBy: 'user-test',
      executorId: 'desktop-test',
      eligibleAgents: [
        { id: 'backend-agent', role: 'Backend Agent' },
        { id: 'mobile-agent', role: 'Mobile Agent' }
      ] as const,
      plan
    };

    let snapshot = await orchestrator.start(input);
    const branchName = 'alpha/orchestration/test-run';
    store.addAllowedPath(directory, 'orchestration test workspace');
    snapshot = runWithWorkspace(input.workspaceId, () => store!.bindOrchestrationWorkspace({
      runId: snapshot.run.id,
      branchName,
      baseRef: 'refs/heads/main',
      baseCommit: 'a'.repeat(40),
      worktreePath: directory
    }));
    expect(snapshot.run.status).toBe('executing');
    expect(snapshot.run.currentTaskId).toBe('create-endpoint');
    expect(snapshot.tasks.map(task => task.status)).toEqual(['running', 'pending']);
    expect(launches.map(request => [request.taskId, request.ownerAgentId])).toEqual([
      ['create-endpoint', 'backend-agent']
    ]);

    // Retrying the same chat request resumes its persisted run; it never starts
    // a second attempt while the first is active.
    snapshot = await orchestrator.start(input);
    expect(snapshot.attempts).toHaveLength(1);
    expect(launches).toHaveLength(1);

    const firstAttempt = snapshot.attempts[0];
    const runEvent = {
      id: firstAttempt.prototypeRunId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      issueId: input.issueId,
      agentId: 'backend-agent',
      orchestrationRunId: snapshot.run.id,
      orchestrationTaskId: firstAttempt.taskId,
      orchestrationAttemptId: firstAttempt.id,
      status: 'completed',
      branchName: 'alpha/orchestration/test-run',
      checkpointCommit: 'b'.repeat(40),
      changedFiles: 1,
      insertions: 4,
      deletions: 0,
      activities: [{ id: 'summary', sequence: 1, kind: 'assistant', message: 'Endpoint submitted.', createdAt: '2026-10-19T00:00:00.000Z' }],
      stages: [{ id: 'tests', status: 'success' }]
    } as any;
    snapshot = (await orchestrator.handleRunnerCompleted(runEvent))!;
    expect(snapshot.tasks[0].status).toBe('submitted');
    expect(snapshot.attempts[0].result).toMatchObject({
      summary: 'Endpoint submitted.', verification: { stageStatus: 'success' }
    });
    // A repeated process event is ignored after the durable submission.
    const submittedEventCount = store.listOrchestrationEvents(snapshot.run.id).length;
    snapshot = (await orchestrator.handleRunnerCompleted(runEvent))!;
    expect(store.listOrchestrationEvents(snapshot.run.id)).toHaveLength(submittedEventCount);
    snapshot = await orchestrator.acceptAttempt({
      workspaceId: input.workspaceId,
      runId: snapshot.run.id,
      taskId: 'create-endpoint',
      attemptId: firstAttempt.id,
      expectedTaskRevision: snapshot.tasks.find(task => task.id === 'create-endpoint')!.revision,
      acceptedBy: 'orchestrator',
      evidence: { contractCheck: 'passed' }
    });

    expect(snapshot.run.currentTaskId).toBe('complete-endpoint');
    expect(snapshot.tasks.map(task => task.status)).toEqual(['accepted', 'running']);
    expect(launches.map(request => request.taskId)).toEqual(['create-endpoint', 'complete-endpoint']);
    expect(launches.every(request => request.ownerAgentId === 'backend-agent')).toBe(true);
    expect(launches.some(request => request.ownerAgentId === 'mobile-agent')).toBe(false);

    const secondAttempt = snapshot.attempts.find(attempt => attempt.taskId === 'complete-endpoint')!;
    snapshot = await orchestrator.submitResult({
      workspaceId: input.workspaceId,
      runId: snapshot.run.id,
      taskId: 'complete-endpoint',
      attemptId: secondAttempt.id,
      expectedTaskRevision: snapshot.tasks.find(task => task.id === 'complete-endpoint')!.revision,
      result: { summary: 'Completion endpoint submitted.' },
      resultCommit: 'commit-complete'
    });
    snapshot = await orchestrator.acceptAttempt({
      workspaceId: input.workspaceId,
      runId: snapshot.run.id,
      taskId: 'complete-endpoint',
      attemptId: secondAttempt.id,
      expectedTaskRevision: snapshot.tasks.find(task => task.id === 'complete-endpoint')!.revision,
      acceptedBy: 'orchestrator',
      evidence: { contractCheck: 'passed' }
    });

    expect(snapshot.run.status).toBe('validating');
    expect(snapshot.run.currentTaskId).toBeUndefined();
    expect(snapshot.tasks.every(task => task.status === 'accepted')).toBe(true);
    expect(launches).toHaveLength(2);

    snapshot = runWithWorkspace(input.workspaceId, () => store!.transitionOrchestrationRun({
      runId: snapshot.run.id, expectedRevision: snapshot.run.revision, nextStatus: 'awaiting_approval',
      actorId: 'orchestrator', evidence: {
        validationVersion: 1, resultCommit: 'b'.repeat(40), branchName: snapshot.run.branchName,
        noOpenBlockingFindings: true, checks: { status: 'passed', missingScripts: [], observed: [{ command: 'npm test', exitCode: 0, signal: null }] }
      }
    }));
    expect(snapshot.run.status).toBe('awaiting_approval');
    snapshot = runWithWorkspace(input.workspaceId, () => store!.transitionOrchestrationRun({
      runId: snapshot.run.id, expectedRevision: snapshot.run.revision, nextStatus: 'publishing',
      actorId: 'reviewer-user', evidence: {
        decision: 'approved', approvedBy: 'reviewer-user', approvedAt: '2026-10-20T00:00:00.000Z',
        resultCommit: 'b'.repeat(40), branchName: snapshot.run.branchName, publicationBaseBranch: 'main'
      }
    }));
    expect(() => runWithWorkspace(input.workspaceId, () => store!.transitionOrchestrationRun({
      runId: snapshot.run.id, expectedRevision: snapshot.run.revision, nextStatus: 'completed',
      actorId: 'reviewer-user', evidence: {
        decision: 'approved', approvedBy: 'reviewer-user',
        publication: {
          branchName: snapshot.run.branchName!, baseBranch: 'main', resultCommit: 'c'.repeat(40),
          pullRequestUrl: 'https://github.com/example/tasks/pull/12', publishedAt: '2026-10-20T00:01:00.000Z'
        }
      }
    }))).toThrow(/validated commit/);
    snapshot = runWithWorkspace(input.workspaceId, () => store!.transitionOrchestrationRun({
      runId: snapshot.run.id, expectedRevision: snapshot.run.revision, nextStatus: 'completed',
      actorId: 'reviewer-user', evidence: {
        decision: 'approved', approvedBy: 'reviewer-user',
        publication: {
          branchName: snapshot.run.branchName!, baseBranch: 'main', resultCommit: 'b'.repeat(40),
          pullRequestUrl: 'https://github.com/example/tasks/pull/12', publishedAt: '2026-10-20T00:01:00.000Z'
        }
      }
    }));
    expect(snapshot.run.status).toBe('completed');
    expect(runWithWorkspace(input.workspaceId, () => store!.listOrchestrationEvents(snapshot.run.id).at(-1)))
      .toMatchObject({ type: 'run_completed', payload: { evidence: { decision: 'approved', approvedBy: 'reviewer-user' } } });
    expect(runWithWorkspace(input.workspaceId, () => store!.listAllPublishedOrchestrationSnapshots().map(item => item.run.id)))
      .toEqual([snapshot.run.id]);
    await expect(orchestrator.cancelRun({ workspaceId: input.workspaceId, runId: snapshot.run.id, actorId: 'reviewer-user' }))
      .resolves.toMatchObject({ run: { status: 'completed' } });
  });

  it('skips unrelated optional tasks and runs optional work only when required work depends on it', async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-orchestration-necessary-work-'));
    store = new SQLiteService({ dbPath: path.join(directory, 'alpha.db'), seedDefaults: false });
    const launches: OrchestrationLaunchRequest[] = [];
    const optionalPlan = parseOrchestrationPlan({
      ...plan,
      tasks: [
        {
          id: 'unused-mobile-polish', title: 'Polish mobile layout', description: 'Add mobile-specific styling.',
          kind: 'mobile', ownerAgentId: 'mobile-agent', dependsOn: [], requirementIds: ['REQ-CREATE'],
          acceptanceCriteria: ['Mobile-only layout polish is complete.'], required: false
        },
        ...plan.tasks
      ]
    });
    const orchestrator = new OrchestrationService(store, {
      async launch(request) {
        launches.push(request);
        return { prototypeRunId: `prototype-${request.attemptId}` };
      }
    });
    const input = {
      workspaceId: 'workspace-test', projectId: 'project-test', issueId: 'issue-test', repository: 'example/tasks',
      requestKey: 'request-necessary-work', requestFingerprint: 'fingerprint-necessary-work', createdBy: 'user-test',
      executorId: 'desktop-test', eligibleAgents: [
        { id: 'backend-agent', role: 'Backend Agent' }, { id: 'mobile-agent', role: 'Mobile Agent' }
      ] as const, plan: optionalPlan
    };

    let snapshot = await orchestrator.start(input);
    expect(launches.map(request => request.taskId)).toEqual(['create-endpoint']);
    for (const taskId of ['create-endpoint', 'complete-endpoint']) {
      const attempt = snapshot.attempts.find(item => item.taskId === taskId)!;
      const task = snapshot.tasks.find(item => item.id === taskId)!;
      snapshot = await orchestrator.submitResult({
        workspaceId: input.workspaceId, runId: snapshot.run.id, taskId, attemptId: attempt.id,
        expectedTaskRevision: task.revision, result: { summary: `${task.title} submitted.` },
        resultCommit: `${taskId.replace(/-/g, '').padEnd(40, 'a')}`
      });
      const submittedTask = snapshot.tasks.find(item => item.id === taskId)!;
      snapshot = await orchestrator.acceptAttempt({
        workspaceId: input.workspaceId, runId: snapshot.run.id, taskId, attemptId: attempt.id,
        expectedTaskRevision: submittedTask.revision, acceptedBy: 'orchestrator', evidence: { accepted: true }
      });
    }

    expect(snapshot.run.status).toBe('validating');
    expect(snapshot.tasks.find(task => task.id === 'unused-mobile-polish')).toMatchObject({ status: 'superseded', attemptCount: 0 });
    expect(launches.map(request => request.ownerAgentId)).toEqual(['backend-agent', 'backend-agent']);
    expect(launches.some(request => request.ownerAgentId === 'mobile-agent')).toBe(false);
  });

  it('rejects a reused request key whose request fingerprint changed', async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-orchestration-idempotency-'));
    store = new SQLiteService({ dbPath: path.join(directory, 'alpha.db'), seedDefaults: false });
    const orchestrator = new OrchestrationService(store, {
      async launch(request) { return { prototypeRunId: `prototype-${request.attemptId}` }; }
    });
    const input = {
      workspaceId: 'workspace-test', projectId: 'project-test', issueId: 'issue-test', repository: 'example/tasks',
      requestKey: 'same-request', requestFingerprint: 'original-fingerprint', createdBy: 'user-test',
      executorId: 'desktop-test', eligibleAgents: [{ id: 'backend-agent', role: 'Backend Agent' }] as const, plan
    };
    await orchestrator.start(input);
    await expect(orchestrator.start({ ...input, requestFingerprint: 'changed-fingerprint' }))
      .rejects.toThrow(/different build request/);
  });

  it('blocks failed execution, retries only the owned task, and ignores the old attempt completing late', async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-orchestration-late-event-'));
    store = new SQLiteService({ dbPath: path.join(directory, 'alpha.db'), seedDefaults: false });
    const launches: OrchestrationLaunchRequest[] = [];
    const orchestrator = new OrchestrationService(store, {
      async launch(request) {
        launches.push(request);
        return { prototypeRunId: `prototype-${request.attemptId}` };
      }
    });
    const input = {
      workspaceId: 'workspace-test', projectId: 'project-test', issueId: 'issue-test', repository: 'example/tasks',
      requestKey: 'request-late-event', requestFingerprint: 'fingerprint-late-event', createdBy: 'user-test',
      executorId: 'desktop-test', eligibleAgents: [{ id: 'backend-agent', role: 'Backend Agent' }] as const, plan
    };

    let snapshot = await orchestrator.start(input);
    const firstRequest = launches[0];
    const failed = await orchestrator.handleRunnerFailed({
      id: `prototype-${firstRequest.attemptId}`,
      workspaceId: input.workspaceId,
      orchestrationRunId: snapshot.run.id,
      orchestrationTaskId: firstRequest.taskId,
      orchestrationAttemptId: firstRequest.attemptId,
      status: 'failed',
      stages: [{ id: 'implementation', status: 'failed', logs: ['fixture failure'] }]
    } as any);
    expect(failed?.run.status).toBe('blocked');
    expect(failed?.attempts[0].status).toBe('failed');

    snapshot = await orchestrator.retryTask({
      workspaceId: input.workspaceId,
      runId: snapshot.run.id,
      taskId: firstRequest.taskId,
      expectedTaskRevision: failed!.tasks.find(task => task.id === firstRequest.taskId)!.revision,
      actorId: 'user-test'
    });
    expect(launches).toHaveLength(2);
    expect(launches[1].taskId).toBe(firstRequest.taskId);
    expect(launches[1].ownerAgentId).toBe('backend-agent');

    const eventCount = runWithWorkspace(input.workspaceId, () => store!.listOrchestrationEvents(snapshot.run.id).length);
    const late = await orchestrator.handleRunnerCompleted({
      id: `prototype-${firstRequest.attemptId}`,
      workspaceId: input.workspaceId,
      orchestrationRunId: snapshot.run.id,
      orchestrationTaskId: firstRequest.taskId,
      orchestrationAttemptId: firstRequest.attemptId,
      status: 'completed',
      branchName: 'alpha/orchestration/test-run',
      checkpointCommit: 'c'.repeat(40),
      stages: [{ id: 'tests', status: 'success' }]
    } as any);
    expect(late?.attempts.find(attempt => attempt.id === firstRequest.attemptId)?.status).toBe('failed');
    expect(late?.attempts.find(attempt => attempt.id === launches[1].attemptId)?.status).toBe('running');
    expect(runWithWorkspace(input.workspaceId, () => store!.listOrchestrationEvents(snapshot.run.id))).toHaveLength(eventCount);
  });

  it('cancels the orchestration and ignores completion after cancellation', async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-orchestration-cancel-event-'));
    store = new SQLiteService({ dbPath: path.join(directory, 'alpha.db'), seedDefaults: false });
    const launches: OrchestrationLaunchRequest[] = [];
    const orchestrator = new OrchestrationService(store, {
      async launch(request) {
        launches.push(request);
        return { prototypeRunId: `prototype-${request.attemptId}` };
      }
    });
    const input = {
      workspaceId: 'workspace-test', projectId: 'project-test', issueId: 'issue-test', repository: 'example/tasks',
      requestKey: 'request-cancel-event', requestFingerprint: 'fingerprint-cancel-event', createdBy: 'user-test',
      executorId: 'desktop-test', eligibleAgents: [{ id: 'backend-agent', role: 'Backend Agent' }] as const, plan
    };

    const started = await orchestrator.start(input);
    const active = launches[0];
    const cancelled = await orchestrator.handleRunnerCancelled({
      id: `prototype-${active.attemptId}`,
      workspaceId: input.workspaceId,
      orchestrationRunId: started.run.id,
      orchestrationTaskId: active.taskId,
      orchestrationAttemptId: active.attemptId,
      status: 'cancelled'
    } as any);
    expect(cancelled?.run.status).toBe('cancelled');
    expect(cancelled?.attempts[0].status).toBe('cancelled');

    const eventCount = runWithWorkspace(input.workspaceId, () => store!.listOrchestrationEvents(started.run.id).length);
    await orchestrator.handleRunnerCompleted({
      id: `prototype-${active.attemptId}`,
      workspaceId: input.workspaceId,
      orchestrationRunId: started.run.id,
      orchestrationTaskId: active.taskId,
      orchestrationAttemptId: active.attemptId,
      status: 'completed',
      checkpointCommit: 'd'.repeat(40)
    } as any);
    expect(runWithWorkspace(input.workspaceId, () => store!.listOrchestrationEvents(started.run.id))).toHaveLength(eventCount);
    expect(runWithWorkspace(input.workspaceId, () => store!.getOrchestrationSnapshot(started.run.id)?.run.status)).toBe('cancelled');
  });

  it('keeps the repository reserved until the active specialist confirms it stopped', async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-orchestration-stop-wait-'));
    store = new SQLiteService({ dbPath: path.join(directory, 'alpha.db'), seedDefaults: false });
    const launches: OrchestrationLaunchRequest[] = [];
    let confirmStopped!: () => void;
    const stopConfirmation = new Promise<void>(resolve => { confirmStopped = resolve; });
    const orchestrator = new OrchestrationService(store, {
      async launch(request) {
        launches.push(request);
        return { prototypeRunId: `prototype-${request.attemptId}` };
      },
      async cancel() { await stopConfirmation; }
    });
    const input = {
      workspaceId: 'workspace-test', projectId: 'project-stop-wait', issueId: 'issue-stop-wait', repository: 'example/stop-wait',
      requestKey: 'request-stop-wait', requestFingerprint: 'fingerprint-stop-wait', createdBy: 'user-test',
      executorId: 'desktop-test', eligibleAgents: [{ id: 'backend-agent', role: 'Backend Agent' }] as const, plan
    };
    const started = await orchestrator.start(input);

    let stopped: Awaited<ReturnType<typeof orchestrator.cancelRun>> | undefined;
    const stopping = orchestrator.cancelRun({ workspaceId: input.workspaceId, runId: started.run.id, actorId: 'user-test' })
      .then(snapshot => { stopped = snapshot; });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(runWithWorkspace(input.workspaceId, () => store!.getOrchestrationSnapshot(started.run.id)?.run.status)).toBe('cancelling');
    expect(runWithWorkspace(input.workspaceId, () => store!.getActiveOrchestrationForProject(input.projectId, input.repository)?.status)).toBe('cancelling');
    expect(stopped).toBeUndefined();

    confirmStopped();
    await stopping;
    expect(stopped?.run.status).toBe('cancelled');
    expect(launches).toHaveLength(1);
  });

  it('keeps a failed stop request in cancelling state and does not release the repository', async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-orchestration-stop-unconfirmed-'));
    store = new SQLiteService({ dbPath: path.join(directory, 'alpha.db'), seedDefaults: false });
    const orchestrator = new OrchestrationService(store, {
      async launch(request) { return { prototypeRunId: `prototype-${request.attemptId}` }; },
      async cancel() { throw new Error('Process exit could not be confirmed.'); }
    });
    const input = {
      workspaceId: 'workspace-test', projectId: 'project-stop-unconfirmed', issueId: 'issue-stop-unconfirmed', repository: 'example/stop-unconfirmed',
      requestKey: 'request-stop-unconfirmed', requestFingerprint: 'fingerprint-stop-unconfirmed', createdBy: 'user-test',
      executorId: 'desktop-test', eligibleAgents: [{ id: 'backend-agent', role: 'Backend Agent' }] as const, plan
    };
    const started = await orchestrator.start(input);

    await expect(orchestrator.cancelRun({ workspaceId: input.workspaceId, runId: started.run.id, actorId: 'user-test' }))
      .rejects.toThrow('Process exit could not be confirmed.');

    expect(runWithWorkspace(input.workspaceId, () => store!.getOrchestrationSnapshot(started.run.id)?.run.status)).toBe('cancelling');
    expect(runWithWorkspace(input.workspaceId, () => store!.getActiveOrchestrationForProject(input.projectId, input.repository)?.status)).toBe('cancelling');

    const activeTask = started.tasks.find(task => task.id === started.run.currentTaskId)!;
    const activeAttempt = started.attempts.find(attempt => attempt.taskId === activeTask.id)!;
    await orchestrator.handleRunnerCompleted({
      id: activeAttempt.prototypeRunId,
      workspaceId: input.workspaceId,
      orchestrationRunId: started.run.id,
      orchestrationTaskId: activeTask.id,
      orchestrationAttemptId: activeAttempt.id,
      status: 'completed',
      checkpointCommit: 'c'.repeat(40)
    } as any);

    expect(runWithWorkspace(input.workspaceId, () => store!.getOrchestrationSnapshot(started.run.id)?.run.status)).toBe('cancelled');
    expect(runWithWorkspace(input.workspaceId, () => store!.getActiveOrchestrationForProject(input.projectId, input.repository))).toBeUndefined();
  });

  it('keeps an interrupted task stopped until explicit resume, then retries only that task', async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-orchestration-recovery-'));
    store = new SQLiteService({ dbPath: path.join(directory, 'alpha.db'), seedDefaults: false });
    const launches: OrchestrationLaunchRequest[] = [];
    const orchestrator = new OrchestrationService(store, {
      async launch(request) {
        launches.push(request);
        return { prototypeRunId: `prototype-${request.attemptId}` };
      }
    });
    const input = {
      workspaceId: 'workspace-test', projectId: 'project-test', issueId: 'issue-test', repository: 'example/tasks',
      requestKey: 'request-recovery', requestFingerprint: 'fingerprint-recovery', createdBy: 'user-test',
      executorId: 'desktop-test', eligibleAgents: [{ id: 'backend-agent', role: 'Backend Agent' }] as const, plan
    };
    const started = await orchestrator.start(input);
    runWithWorkspace(input.workspaceId, () => store!.markOrchestrationRecoveryRequired({
      runId: started.run.id,
      actorId: 'orchestrator',
      reason: 'The daemon stopped during this task.'
    }));

    const preserved = runWithWorkspace(input.workspaceId, () => store!.getOrchestrationSnapshot(started.run.id)!);
    expect(preserved.run.status).toBe('recovery_required');
    expect(preserved.run.currentTaskId).toBeUndefined();
    expect(preserved.tasks[0].status).toBe('blocked');
    expect(launches).toHaveLength(1);

    await expect(orchestrator.retryTask({
      workspaceId: input.workspaceId, runId: started.run.id, taskId: preserved.tasks[0].id,
      expectedTaskRevision: preserved.tasks[0].revision, actorId: 'user-test'
    })).rejects.toThrow(/use Resume/);
    expect(launches).toHaveLength(1);

    const resumed = await orchestrator.resume({
      workspaceId: input.workspaceId, runId: started.run.id, actorId: 'user-test'
    });

    expect(resumed.run.status).toBe('executing');
    expect(resumed.run.currentTaskId).toBe('create-endpoint');
    expect(resumed.tasks.map(task => task.status)).toEqual(['running', 'pending']);
    expect(resumed.attempts.filter(attempt => attempt.taskId === 'create-endpoint')).toHaveLength(2);
    expect(launches.map(request => request.taskId)).toEqual(['create-endpoint', 'create-endpoint']);
    expect(launches.every(request => request.ownerAgentId === 'backend-agent')).toBe(true);
  });
});
