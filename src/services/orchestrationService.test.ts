import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SQLiteService } from './sqliteService.js';
import { parseOrchestrationPlan } from './orchestrationContract.js';
import { OrchestrationService, repairGuidanceForFailure, type OrchestrationExecutor, type OrchestrationLaunchRequest } from './orchestrationService.js';
import { runWithWorkspace } from './workspaceContext.js';

const plan = parseOrchestrationPlan({
  schemaVersion: 1,
  goal: 'Add task creation and completion.',
  projectContext: 'Keep all new flows keyboard accessible.',
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

async function startAndApprove(orchestrator: OrchestrationService, input: {
  workspaceId: string;
  createdBy: string;
  requestKey: string;
  [key: string]: unknown;
}) {
  const savedPlan = await orchestrator.start(input as any);
  return orchestrator.startPlannedWork({
    workspaceId: input.workspaceId,
    runId: savedPlan.run.id,
    expectedRevision: savedPlan.run.revision,
    actorId: input.createdBy
  });
}

describe('deterministic orchestration orchestrator', () => {
  let directory = '';
  let store: SQLiteService | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    store?.close();
    store = undefined;
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    directory = '';
  });

  it('turns common dependency failures into bounded repair guidance', () => {
    const guidance = repairGuidanceForFailure(
      'FAIL tests/unit/App.spec.tsx\nIncompatible React versions: react and react-dom must match exactly.'
    );

    expect(guidance).toContain('align react, react-dom, and react-test-renderer');
    expect(guidance).toContain('Do not skip or weaken the test');
    expect(guidance).toContain('Incompatible React versions');
  });

  it('runs only the next task owner and waits for acceptance before dispatching dependent work', async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-orchestration-orchestrator-'));
    store = new SQLiteService({ dbPath: path.join(directory, 'alpha.db'), seedDefaults: false });
    runWithWorkspace('workspace-test', () => store!.createProject({
      id: 'project-test', name: 'Task project', key: 'TASK', description: 'Keep all new flows keyboard accessible.'
    }));
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
    expect(snapshot.run.status).toBe('awaiting_plan_approval');
    expect(snapshot.tasks.map(task => task.status)).toEqual(['ready', 'pending']);
    expect(launches).toHaveLength(0);
    snapshot = await orchestrator.startPlannedWork({
      workspaceId: input.workspaceId, runId: snapshot.run.id,
      expectedRevision: snapshot.run.revision, actorId: input.createdBy
    });
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
    expect(launches[0].taskPackage.projectContext).toBe('Keep all new flows keyboard accessible.');

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
      activities: [{ id: 'summary', sequence: 1, kind: 'assistant', message: JSON.stringify({
        schemaVersion: 1,
        taskId: firstAttempt.taskId,
        summary: 'Endpoint submitted.',
        requirementCoverage: [{ requirementId: 'REQ-CREATE', evidence: 'The endpoint creates a task.' }],
        criteriaEvidence: [{ criterion: 'A created task survives a database reload.', evidence: 'Persistence is implemented.' }],
        deliverables: [{ summary: 'Task creation endpoint.', paths: ['src/tasks.ts'] }],
        reportedChecks: [{
          script: 'npm test', result: 'blocked', evidence: 'The check could not run because the test runner was unavailable.'
        }],
        blockers: []
      }), createdAt: '2026-10-19T00:00:00.000Z' }],
      stages: [{ id: 'tests', status: 'success' }]
    } as any;
    snapshot = (await orchestrator.handleRunnerCompleted(runEvent))!;
    expect(snapshot.tasks[0].status).toBe('submitted');
    expect(snapshot.attempts[0].result).toMatchObject({
      summary: 'Endpoint submitted.',
      verification: { stageStatus: 'success' },
      agentReport: { reportedChecks: [{ script: 'npm test', result: 'not_run' }] }
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

  it('finishes the active specialist, pauses before the next handoff, and resumes the saved plan', async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-orchestration-pause-'));
    store = new SQLiteService({ dbPath: path.join(directory, 'alpha.db'), seedDefaults: false });
    runWithWorkspace('workspace-pause-test', () => store!.createProject({
      id: 'project-pause-test', name: 'Pause project', key: 'PAUSE'
    }));
    const launches: OrchestrationLaunchRequest[] = [];
    const executor: OrchestrationExecutor = {
      async launch(request) {
        launches.push(request);
        return { prototypeRunId: `prototype-${request.attemptId}` };
      }
    };
    const orchestrator = new OrchestrationService(store, executor);
    const input = {
      workspaceId: 'workspace-pause-test',
      projectId: 'project-pause-test',
      issueId: 'issue-pause-test',
      repository: 'example/pause',
      requestKey: 'request-pause-test',
      requestFingerprint: 'fingerprint-pause-test',
      createdBy: 'user-pause-test',
      executorId: 'desktop-pause-test',
      eligibleAgents: [{ id: 'backend-agent', role: 'Backend Agent' }] as const,
      plan
    };

    let snapshot = await startAndApprove(orchestrator, input);
    expect(snapshot.run.currentTaskId).toBe('create-endpoint');
    expect(launches).toHaveLength(1);
    const pendingPause = await orchestrator.pauseRun({
      workspaceId: input.workspaceId,
      runId: snapshot.run.id,
      expectedRevision: snapshot.run.revision,
      actorId: input.createdBy,
      now: '2026-10-21T01:00:00.000Z'
    });
    expect(pendingPause.run.status).toBe('executing');
    expect(pendingPause.run.pauseRequestedAt).toBe('2026-10-21T01:00:00.000Z');
    expect(pendingPause.run.currentTaskId).toBe('create-endpoint');

    const attempt = pendingPause.attempts[0];
    snapshot = (await orchestrator.handleRunnerCompleted({
      id: attempt.prototypeRunId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      issueId: input.issueId,
      agentId: 'backend-agent',
      orchestrationRunId: pendingPause.run.id,
      orchestrationTaskId: attempt.taskId,
      orchestrationAttemptId: attempt.id,
      status: 'completed',
      checkpointCommit: 'b'.repeat(40),
      activities: [{ id: 'summary', sequence: 1, kind: 'assistant', message: 'Endpoint submitted.', createdAt: '2026-10-21T01:01:00.000Z' }],
      stages: [{ id: 'tests', status: 'success' }]
    } as any))!;
    snapshot = await orchestrator.acceptAttempt({
      workspaceId: input.workspaceId,
      runId: snapshot.run.id,
      taskId: attempt.taskId,
      attemptId: attempt.id,
      expectedTaskRevision: snapshot.tasks.find(task => task.id === attempt.taskId)!.revision,
      acceptedBy: 'orchestrator',
      evidence: { contractCheck: 'passed' }
    });

    expect(snapshot.run.status).toBe('paused');
    expect(snapshot.run.currentTaskId).toBeUndefined();
    expect(snapshot.run.pauseRequestedAt).toBeUndefined();
    expect(snapshot.tasks.map(task => task.status)).toEqual(['accepted', 'ready']);
    expect(launches).toHaveLength(1);
    expect(runWithWorkspace(input.workspaceId, () => store!.listOrchestrationEvents(snapshot.run.id).map(event => event.type))).toContain('run_paused');

    snapshot = await orchestrator.resume({ workspaceId: input.workspaceId, runId: snapshot.run.id, actorId: input.createdBy });
    expect(snapshot.run.status).toBe('executing');
    expect(snapshot.run.currentTaskId).toBe('complete-endpoint');
    expect(snapshot.run.pauseRequestedAt).toBeUndefined();
    expect(launches.map(request => request.taskId)).toEqual(['create-endpoint', 'complete-endpoint']);
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

    let snapshot = await startAndApprove(orchestrator, input);
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
    const savedPlan = await orchestrator.start(input);
    expect(savedPlan.run.status).toBe('awaiting_plan_approval');
    await expect(orchestrator.start({ ...input, requestFingerprint: 'changed-fingerprint' }))
      .rejects.toThrow(/different build request/);
  });

  it('self-repairs an agent execution failure, retries only its owner, and ignores a late old result', async () => {
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

    let snapshot = await startAndApprove(orchestrator, input);
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
    expect(failed?.run.status).toBe('executing');
    expect(failed?.attempts[0].status).toBe('failed');
    snapshot = failed!;
    expect(launches).toHaveLength(2);
    expect(launches[1].taskId).toBe(firstRequest.taskId);
    expect(launches[1].ownerAgentId).toBe('backend-agent');
    expect(launches[1].taskPackage.corrections.join('\n')).toContain('fixture failure');

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

  it('escalates provider failures without asking a project agent to repair the runtime', async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-orchestration-provider-failure-'));
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
      requestKey: 'request-provider-failure', requestFingerprint: 'fingerprint-provider-failure', createdBy: 'user-test',
      executorId: 'desktop-test', eligibleAgents: [{ id: 'backend-agent', role: 'Backend Agent' }] as const, plan
    };

    const snapshot = await startAndApprove(orchestrator, input);
    const firstRequest = launches[0];
    const failed = await orchestrator.handleRunnerFailed({
      id: `prototype-${firstRequest.attemptId}`,
      workspaceId: input.workspaceId,
      orchestrationRunId: snapshot.run.id,
      orchestrationTaskId: firstRequest.taskId,
      orchestrationAttemptId: firstRequest.attemptId,
      status: 'failed',
      stages: [{ id: 'implementation', status: 'failed', logs: ['Provider connection timed out.'] }]
    } as any);

    expect(failed?.run.status).toBe('blocked');
    expect(failed?.run.stoppedReason).toContain('developer to review in project chat');
    expect(launches).toHaveLength(1);
  });

  it('persists a bounded recovery attempt when specialist preparation fails before launch', async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-orchestration-prepare-failure-'));
    store = new SQLiteService({ dbPath: path.join(directory, 'alpha.db'), seedDefaults: false });
    const launches: OrchestrationLaunchRequest[] = [];
    const orchestrator = new OrchestrationService(store, {
      async prepare() { throw new Error('EACCES: permission denied while preparing the saved worktree.'); },
      async launch(request) {
        launches.push(request);
        return { prototypeRunId: `prototype-${request.attemptId}` };
      }
    });
    const input = {
      workspaceId: 'workspace-test', projectId: 'project-test', issueId: 'issue-test', repository: 'example/tasks',
      requestKey: 'request-prepare-failure', requestFingerprint: 'fingerprint-prepare-failure', createdBy: 'user-test',
      executorId: 'desktop-test', eligibleAgents: [{ id: 'backend-agent', role: 'Backend Agent' }] as const, plan
    };

    const snapshot = await startAndApprove(orchestrator, input);

    expect(snapshot.run.status).toBe('blocked');
    expect(snapshot.tasks.find(task => task.id === 'create-endpoint')?.status).toBe('failed');
    expect(snapshot.attempts).toHaveLength(1);
    expect(snapshot.attempts[0]).toMatchObject({
      status: 'failed',
      failureReason: 'EACCES: permission denied while preparing the saved worktree.'
    });
    expect(snapshot.attempts[0].contextManifest.orchestrationPreparationFailed).toBe(true);
    expect(launches).toHaveLength(0);
  });

  it('automatically retries a timed-out code task once and stops when the same timeout repeats', async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-orchestration-timeout-repair-'));
    store = new SQLiteService({ dbPath: path.join(directory, 'alpha.db'), seedDefaults: false });
    const launches: OrchestrationLaunchRequest[] = [];
    const orchestrator = new OrchestrationService(store, {
      async launch(request) { launches.push(request); return { prototypeRunId: `prototype-${request.attemptId}` }; }
    });
    const input = {
      workspaceId: 'workspace-test', projectId: 'project-test', issueId: 'issue-test', repository: 'example/tasks',
      requestKey: 'request-timeout-repair', requestFingerprint: 'fingerprint-timeout-repair', createdBy: 'user-test',
      executorId: 'desktop-test', eligibleAgents: [{ id: 'backend-agent', role: 'Backend Agent' }] as const, plan
    };
    let snapshot = await startAndApprove(orchestrator, input);
    for (let index = 0; index < 2; index++) {
      const request = launches[index];
      snapshot = (await orchestrator.handleRunnerFailed({
        id: `prototype-${request.attemptId}`, workspaceId: input.workspaceId,
        orchestrationRunId: snapshot.run.id, orchestrationTaskId: request.taskId,
        orchestrationAttemptId: request.attemptId, status: 'failed', testSummary: 'Run failed: Process timed out.',
        stages: [{ id: 'analyze', status: 'failed', logs: ['Error: Process timed out.'] }]
      } as any))!;
      expect(snapshot.run.status).toBe(index === 0 ? 'executing' : 'blocked');
    }
    expect(launches).toHaveLength(2);
    expect(launches[1].taskId).toBe(launches[0].taskId);
    expect(snapshot.tasks.find(task => task.id === 'complete-endpoint')?.status).toBe('pending');
  });

  it('assigns bounded verification repairs, gives each the failure evidence, then stops for human review', async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-orchestration-verification-repair-'));
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
      requestKey: 'request-verification-repair', requestFingerprint: 'fingerprint-verification-repair', createdBy: 'user-test',
      executorId: 'desktop-test', eligibleAgents: [{ id: 'backend-agent', role: 'Backend Agent' }] as const, plan
    };

    let snapshot = await startAndApprove(orchestrator, input);
    const first = launches[0];
    snapshot = (await orchestrator.handleRunnerFailed({
      id: `prototype-${first.attemptId}`, workspaceId: input.workspaceId,
      orchestrationRunId: snapshot.run.id, orchestrationTaskId: first.taskId,
      orchestrationAttemptId: first.attemptId, status: 'failed',
      testSummary: 'npm run test failed: operable program or batch file.',
      verificationEvidence: {
        status: 'failed', missingScripts: [],
        commands: [{ script: 'test', display: 'npm run test', exitCode: 1, signal: null }]
      },
      stages: [{ id: 'tests', status: 'failed', logs: ['npm run test', 'operable program or batch file.'] }]
    } as any))!;

    expect(snapshot.run.status).toBe('executing');
    expect(snapshot.tasks.find(task => task.id === first.taskId)?.status).toBe('running');
    expect(launches).toHaveLength(2);
    expect(launches[1]).toMatchObject({ taskId: first.taskId, ownerAgentId: first.ownerAgentId });
    expect(launches[1].taskPackage.corrections.join('\n')).toContain('operable program or batch file');

    const repair = launches[1];
    snapshot = (await orchestrator.handleRunnerFailed({
      id: `prototype-${repair.attemptId}`, workspaceId: input.workspaceId,
      orchestrationRunId: snapshot.run.id, orchestrationTaskId: repair.taskId,
      orchestrationAttemptId: repair.attemptId, status: 'failed',
      testSummary: 'npm run test still exits with code 1.',
      verificationEvidence: {
        status: 'failed', missingScripts: [],
        commands: [{ script: 'test', display: 'npm run test', exitCode: 1, signal: null }]
      },
      stages: [{ id: 'tests', status: 'failed', logs: ['The test command still fails.'] }]
    } as any))!;
    expect(snapshot.run.status).toBe('executing');
    expect(launches).toHaveLength(3);

    const secondRepair = launches[2];
    expect(secondRepair).toMatchObject({ taskId: first.taskId, ownerAgentId: first.ownerAgentId });
    expect(secondRepair.taskPackage.corrections.join('\n')).toContain('npm run test still exits with code 1');
    snapshot = (await orchestrator.handleRunnerFailed({
      id: `prototype-${secondRepair.attemptId}`, workspaceId: input.workspaceId,
      orchestrationRunId: snapshot.run.id, orchestrationTaskId: secondRepair.taskId,
      orchestrationAttemptId: secondRepair.attemptId, status: 'failed',
      testSummary: 'The targeted assertion still fails after the second repair.',
      verificationEvidence: {
        status: 'failed', missingScripts: [],
        commands: [{ script: 'test', display: 'npm run test', exitCode: 1, signal: null }]
      },
      stages: [{ id: 'tests', status: 'failed', logs: ['The targeted assertion still fails.'] }]
    } as any))!;

    expect(snapshot.run.status).toBe('blocked');
    expect(snapshot.tasks.find(task => task.id === secondRepair.taskId)?.attemptCount).toBe(3);
    expect(snapshot.attempts.find(attempt => attempt.id === secondRepair.attemptId)?.failureReason).toContain('targeted assertion still fails');
    expect(launches).toHaveLength(3);
    expect(snapshot.run.stoppedReason).toContain('Review the latest failure details');
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

    const started = await startAndApprove(orchestrator, input);
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
    const started = await startAndApprove(orchestrator, input);

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
    const started = await startAndApprove(orchestrator, input);

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
    const testTempRoot = path.resolve(process.cwd(), '..', '.tmp-tests');
    fs.mkdirSync(testTempRoot, { recursive: true });
    directory = fs.mkdtempSync(path.join(testTempRoot, 'alpha-orchestration-recovery-'));
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
    const started = await startAndApprove(orchestrator, input);
    const repository = path.join(directory, 'repository');
    fs.mkdirSync(repository, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: repository, stdio: 'ignore' });
    fs.writeFileSync(path.join(repository, 'README.md'), '# Recovery fixture\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repository, stdio: 'ignore' });
    execFileSync('git', [
      '-c', 'user.name=Alpha Test', '-c', 'user.email=alpha-test@example.com', 'commit', '-m', 'Initial fixture'
    ], { cwd: repository, stdio: 'ignore' });
    const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
    store.addAllowedPath(directory, 'orchestration recovery fixture');
    const withWorkspace = runWithWorkspace(input.workspaceId, () => store!.bindOrchestrationWorkspace({
      runId: started.run.id,
      branchName: 'main',
      baseRef: 'refs/heads/main',
      baseCommit,
      worktreePath: repository
    }));
    runWithWorkspace(input.workspaceId, () => store!.markOrchestrationRecoveryRequired({
      runId: withWorkspace.run.id,
      actorId: 'orchestrator',
      reason: 'The daemon stopped during this task.'
    }));
    const interruptedAttempt = started.attempts[0];
    vi.spyOn(store!, 'getPrototypeRuns').mockReturnValue([{
      id: interruptedAttempt.prototypeRunId!, status: 'failed'
    } as any]);

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

describe('specialist launch safety', () => {
  let directory = '';
  let store: SQLiteService | undefined;

  afterEach(() => {
    delete process.env.ALPHA_ORCHESTRATION_LAUNCH_TIMEOUT_MS;
    vi.restoreAllMocks();
    store?.close();
    store = undefined;
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    directory = '';
  });

  const request = (requestKey: string) => ({
    workspaceId: 'workspace-test', projectId: 'project-test', issueId: 'issue-test', repository: 'example/tasks',
    requestKey, requestFingerprint: 'fingerprint-' + requestKey, createdBy: 'user-test',
    executorId: 'desktop-test', eligibleAgents: [{ id: 'backend-agent', role: 'Backend Agent' }] as const, plan
  });

  /** A committed repository bound to the run, as a real build worktree would be. */
  function bindRepository(runId: string) {
    const repository = path.join(directory, 'repository');
    fs.mkdirSync(repository, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: repository, stdio: 'ignore' });
    fs.writeFileSync(path.join(repository, 'README.md'), '# Launch fixture\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repository, stdio: 'ignore' });
    execFileSync('git', ['-c', 'user.name=Alpha Test', '-c', 'user.email=alpha-test@example.com', 'commit', '-m', 'Initial fixture'], { cwd: repository, stdio: 'ignore' });
    const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
    store!.addAllowedPath(directory, 'orchestration launch fixture');
    runWithWorkspace('workspace-test', () => store!.bindOrchestrationWorkspace({ runId, branchName: 'main', baseRef: 'refs/heads/main', baseCommit, worktreePath: repository }));
  }

  /** A build whose first launch never returns, left the way a restarted daemon finds it. */
  async function interruptedBeforeLaunch(requestKey: string) {
    const testTempRoot = path.resolve(process.cwd(), '..', '.tmp-tests');
    fs.mkdirSync(testTempRoot, { recursive: true });
    directory = fs.mkdtempSync(path.join(testTempRoot, 'alpha-orchestration-launch-'));
    store = new SQLiteService({ dbPath: path.join(directory, 'alpha.db'), seedDefaults: false });
    const stalled = new OrchestrationService(store, { launch: () => new Promise(() => undefined) });
    const saved = await stalled.start(request(requestKey) as any);
    void stalled.startPlannedWork({ workspaceId: 'workspace-test', runId: saved.run.id, expectedRevision: saved.run.revision, actorId: 'user-test' });
    await vi.waitFor(() => expect(runWithWorkspace('workspace-test', () => store!.getOrchestrationSnapshot(saved.run.id)!.attempts[0]?.status)).toBe('starting'));
    bindRepository(saved.run.id);
    runWithWorkspace('workspace-test', () => store!.markOrchestrationRecoveryRequired({ runId: saved.run.id, actorId: 'orchestrator', reason: 'The daemon restarted.' }));
    return saved.run.id;
  }

  it('stops waiting for a launch that never returns, and stops a process that starts late', async () => {
    process.env.ALPHA_ORCHESTRATION_LAUNCH_TIMEOUT_MS = '50';
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-orchestration-launch-'));
    store = new SQLiteService({ dbPath: path.join(directory, 'alpha.db'), seedDefaults: false });
    let release: (receipt: { prototypeRunId: string }) => void = () => undefined;
    const cancelled: string[] = [];
    const orchestrator = new OrchestrationService(store, {
      launch: () => new Promise(resolve => { release = resolve; }),
      async cancel(prototypeRunId) { cancelled.push(prototypeRunId); }
    });

    const result = await startAndApprove(orchestrator, request('request-hung'));

    expect(result.run.status).toBe('blocked');
    expect(result.run.currentTaskId).toBeUndefined();
    expect(result.attempts.map(attempt => attempt.status)).toEqual(['failed']);
    expect(result.attempts[0].failureReason).toMatch(/did not start within/);
    release({ prototypeRunId: 'late-process' });
    await vi.waitFor(() => expect(cancelled).toEqual(['late-process']));
  });

  it('retries an interrupted attempt that never reached a specialist', async () => {
    const runId = await interruptedBeforeLaunch('request-never-started');
    const launches: OrchestrationLaunchRequest[] = [];
    const restarted = new OrchestrationService(store!, {
      async launch(launch) { launches.push(launch); return { prototypeRunId: 'prototype-' + launch.attemptId }; }
    });

    const resumed = await restarted.resume({ workspaceId: 'workspace-test', runId, actorId: 'user-test' });

    expect(resumed.run.status).toBe('executing');
    expect(resumed.run.currentTaskId).toBe('create-endpoint');
    expect(resumed.attempts.map(attempt => attempt.status)).toEqual(['failed', 'running']);
    expect(launches).toHaveLength(1);
  });

  it('still holds an attempt without a process id when a run was recorded for it', async () => {
    const runId = await interruptedBeforeLaunch('request-recorded-run');
    const attemptId = runWithWorkspace('workspace-test', () => store!.getOrchestrationSnapshot(runId)!.attempts[0].id);
    vi.spyOn(store!, 'getPrototypeRuns').mockReturnValue([{ id: 'unbound-run', status: 'running', orchestrationAttemptId: attemptId } as any]);
    const launches: OrchestrationLaunchRequest[] = [];
    const restarted = new OrchestrationService(store!, {
      async launch(launch) { launches.push(launch); return { prototypeRunId: 'prototype-' + launch.attemptId }; }
    });

    await expect(restarted.resume({ workspaceId: 'workspace-test', runId, actorId: 'user-test' })).rejects.toThrow(/cannot confirm/);
    expect(launches).toHaveLength(0);
  });
});
