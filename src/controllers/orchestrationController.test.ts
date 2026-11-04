import http from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

async function startApi(role = 'admin') {
  vi.resetModules();
  const reservation = {
    runId: 'orchestration-planning-1', projectId: 'project-1', repository: 'acme/shop', repositoryKey: 'acme/shop',
    requestKey: 'request-1', requestFingerprint: 'fingerprint-1', branchName: 'alpha/orchestration/plan1',
    baseCommit: 'a'.repeat(40), worktreePath: 'D:/alpha/workspaces/_runs/project-1/plan1',
    ownerSessionId: 'stopped-session', createdAt: '2026-10-20T00:00:00.000Z'
  };
  const recovery = {
    ...reservation, state: 'needs_review', reason: 'Saved planning work needs review.', revision: 2,
    updatedAt: '2026-10-20T00:01:00.000Z'
  };
  const awaitingSnapshot = {
    run: {
      id: 'orchestration-approved-1', workspaceId: 'ws-test', projectId: 'project-1', issueId: 'issue-1',
      status: 'awaiting_approval', revision: 4, baseCommit: 'a'.repeat(40), branchName: 'alpha/orchestration/approved1'
    },
    attempts: [{ status: 'accepted', resultCommit: 'b'.repeat(40) }]
  };
  const approvedSnapshot = { ...awaitingSnapshot, run: { ...awaitingSnapshot.run, status: 'completed', revision: 6,
    publication: { branchName: 'alpha/orchestration/approved1', baseBranch: 'main', resultCommit: 'b'.repeat(40),
      pullRequestUrl: 'https://github.com/acme/shop/pull/42', publishedAt: '2026-10-20T00:02:00.000Z' } } };
  const calls = {
    deliveryAct: vi.fn(async () => ({ runId: 'orchestration-approved-1', stage: 'uat_checks' })),
    deliveryRefresh: vi.fn(async () => ({ runId: 'orchestration-approved-1', stage: 'dev_approval' })),
    documents: vi.fn(() => [{ version: 1, fileName: 'build-plan-v1.md', content: '# Approved plan\n', contentHash: 'hash' }]),
    getRecovery: vi.fn((): any => recovery),
    inspect: vi.fn(async () => ({ state: 'changed', safeToRetire: false, canPreview: true, changed: true })),
    remove: vi.fn(async () => false),
    record: vi.fn(() => recovery),
    clean: vi.fn(() => ({ recoveryState: 'cleaned', revision: 0 })),
    getSnapshot: vi.fn((): any => awaitingSnapshot),
    listEvents: vi.fn(() => [{
      id: 11, eventId: 'event-safe-1', runId: 'orchestration-approved-1', sequence: 4,
      actorId: 'user-1', type: 'task_accepted', payload: { localPath: 'D:/private/worktree' },
      createdAt: '2026-10-20T00:00:00.000Z'
    }]),
    approveAndPublish: vi.fn(async () => approvedSnapshot),
    preview: vi.fn(async () => ({
      baseCommit: reservation.baseCommit, headCommit: 'b'.repeat(40), branchName: reservation.branchName,
      changedPaths: ['README.md'], pathsTruncated: false, diff: '+saved', truncated: false
    })),
    retain: vi.fn(() => ({ ...recovery, state: 'retained', revision: 3, resolvedBy: 'user-1' }))
  };

  vi.doMock('../config/env.js', () => ({ IS_CLOUD: false, ALPHA_ORCHESTRATION_ENABLED: true }));
  vi.doMock('../store/stores.js', () => ({ projectStore: () => ({ get: vi.fn(async () => ({ id: 'project-1', name: 'Shop', resources: [] })) }) }));
  vi.doMock('../services/sqliteService.js', () => ({ sqliteService: {
    getOrchestrationPlanningRecovery: calls.getRecovery,
    getOrchestrationPlanningReservationByRun: vi.fn(() => reservation),
    releaseOrchestrationPlanningReservation: vi.fn(() => true),
    recordOrchestrationPlanningRecovery: calls.record,
    retainOrchestrationPlanningRecovery: calls.retain,
    cleanOrchestrationPlanningReservation: calls.clean,
    getOrchestrationSnapshot: calls.getSnapshot,
    ensureOrchestrationPlanDocuments: calls.documents,
    listOrchestrationEvents: calls.listEvents
  } }));
  vi.doMock('../services/orchestrationReviewService.js', () => ({
    getOrchestrationDiffPreview: vi.fn()
  }));
  vi.doMock('../services/orchestrationPlanningRecovery.js', () => ({
    inspectOrchestrationPlanningWorktree: calls.inspect,
    removeStaleOrchestrationPlanningWorktree: calls.remove,
    getOrchestrationPlanningRecoveryPreview: calls.preview
  }));
  vi.doMock('../services/workspaceService.js', () => ({ resolveProjectWorkspace: () => ({ dir: 'D:/alpha/repository' }) }));
  vi.doMock('../services/workspaceRegistry.js', () => ({ workspaceRegistry: { can: () => true, canAccessProjectBuilds: () => true } }));
  vi.doMock('../services/orchestrationRuntime.js', () => ({ orchestrationService: { approveAndPublish: calls.approveAndPublish } }));
  vi.doMock('../services/orchestrationDeliveryRuntime.js', () => ({
    orchestrationDeliveryService: { ensure: () => ({}), refresh: calls.deliveryRefresh },
    deliveryServiceForActor: async () => ({ act: calls.deliveryAct })
  }));
  vi.doMock('./workspaceContext.js', () => ({
    requireWorkspaceCapability: (_req: any, res: any, capability: string) => {
      if (capability === 'project.promote' && role === 'dev') { res.status(403).json({ error: 'PM authorization required.' }); return false; }
      const allowed: Record<string, string[]> = {
        'build.publish': ['dev', 'pm', 'admin'],
        'project.promote_uat': ['dev', 'pm', 'admin'],
        'deployment.manage': ['admin'],
        'squad.read': ['dev', 'pm', 'admin'],
        'squad.run': ['dev', 'admin']
      };
      if (allowed[capability] && !allowed[capability].includes(role)) { res.status(403).json({ error: 'This role cannot perform the action.' }); return false; }
      return true;
    },
    requireProjectWorkspace: () => true
  }));

  const { orchestrationRouter } = await import('./orchestrationController.js');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).workspace = { workspaceId: 'ws-test', userId: 'user-1', role };
    next();
  });
  app.use('/api', orchestrationRouter);
  return { app, calls, reservation, recovery, awaitingSnapshot, approvedSnapshot };
}

async function call(app: express.Express, method: string, url: string, body?: unknown) {
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  try {
    const response = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, body: await response.json() as any };
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

afterEach(() => {
  for (const mod of [
    '../config/env.js', '../store/stores.js', '../services/sqliteService.js',
    '../services/orchestrationPlanningRecovery.js', '../services/workspaceService.js',
    '../services/orchestrationFinalization.js', '../services/orchestrationReviewService.js', '../services/orchestrationRuntime.js',
    '../services/workspaceRegistry.js', '../services/orchestrationDeliveryRuntime.js', './workspaceContext.js'
  ]) vi.doUnmock(mod);
  vi.resetModules();
});

describe('developer-only board planning admission', () => {
  it.each(['pm', 'admin', 'client'])('refuses %s before creating a queued request or invoking a planner', async role => {
    const { app } = await startApi(role);
    const response = await call(app, 'POST', '/api/projects/project-1/issues/issue-1/build-request', { requestId: 'test-request-one', queue: true });
    expect(response.status).toBe(403);
  });
});

describe('task workflow project routes', () => {
  it('exposes delivery only for the matching project and workspace', async () => {
    const { app, calls, awaitingSnapshot } = await startApi();
    const url = `/api/projects/project-1/orchestrations/${awaitingSnapshot.run.id}/delivery`;
    expect((await call(app, 'GET', url)).body.delivery.stage).toBe('dev_approval');
    calls.getSnapshot.mockReturnValue({ ...awaitingSnapshot, run: { ...awaitingSnapshot.run, projectId: 'other' } });
    expect((await call(app, 'GET', url)).status).toBe(404);
    expect(calls.deliveryRefresh).toHaveBeenCalledTimes(1);
  });
  it('allows UAT actions from a developer without a PM capability', async () => {
    const { app, calls, awaitingSnapshot } = await startApi('dev');
    const result = await call(app, 'POST', `/api/projects/project-1/orchestrations/${awaitingSnapshot.run.id}/delivery/actions`,
      { action: 'merge_uat', expectedRevision: 1, key: 'delivery-key-1' });
    expect(result.status).toBe(200); expect(calls.deliveryAct).toHaveBeenCalledWith(expect.objectContaining({ context: expect.objectContaining({ role: 'dev' }) }));
  });
  it('allows PMs to review and authorize publication and UAT delivery', async () => {
    const { app, calls, awaitingSnapshot } = await startApi('pm');
    const delivery = await call(app, 'GET', `/api/projects/project-1/orchestrations/${awaitingSnapshot.run.id}/delivery`);
    expect(delivery).toMatchObject({ status: 200, body: { canControl: true, canPromote: true } });
    const publication = await call(app, 'POST', `/api/projects/project-1/orchestrations/${awaitingSnapshot.run.id}/approve`, { expectedRevision: 4 });
    expect(publication).toMatchObject({ status: 200, body: { status: 'completed' } });
    expect(calls.approveAndPublish).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'user-1' }));
  });
  it('validates delivery action identity and passes the server-resolved actor', async () => {
    const { app, calls, awaitingSnapshot } = await startApi();
    const url = `/api/projects/project-1/orchestrations/${awaitingSnapshot.run.id}/delivery/actions`;
    expect((await call(app, 'POST', url, { action: 'merge_uat', expectedRevision: -1, key: 'delivery-key-1' })).status).toBe(400);
    expect((await call(app, 'POST', url, { action: 'merge_uat', expectedRevision: 1, key: 'delivery-key-1', actorId: 'forged' })).status).toBe(200);
    expect(calls.deliveryAct).toHaveBeenCalledWith(expect.objectContaining({ context: expect.objectContaining({ userId: 'user-1', role: 'admin' }),
      projectId: 'project-1', action: 'merge_uat' }));
  });
  it('serves plan Markdown only for a matching project and workspace', async () => {
    const { app, calls, awaitingSnapshot } = await startApi();
    const url = `/api/projects/project-1/orchestrations/${awaitingSnapshot.run.id}/plans`;
    expect(await call(app, 'GET', url)).toMatchObject({ status: 200, body: { documents: [{ fileName: 'build-plan-v1.md', content: '# Approved plan\n' }] } });
    expect(calls.documents).toHaveBeenCalledTimes(1);
    calls.getSnapshot.mockReturnValue({ ...awaitingSnapshot, run: { ...awaitingSnapshot.run, projectId: 'other-project' } });
    expect((await call(app, 'GET', url)).status).toBe(404);
    calls.getSnapshot.mockReturnValue({ ...awaitingSnapshot, run: { ...awaitingSnapshot.run, workspaceId: 'other-workspace' } });
    expect((await call(app, 'GET', url)).status).toBe(404);
    expect(calls.documents).toHaveBeenCalledTimes(1);
  });
  it('serves a bounded project-scoped event cursor without exposing event payloads', async () => {
    const { app, calls, approvedSnapshot } = await startApi();

    const response = await call(app, 'GET', `/api/projects/project-1/orchestrations/${approvedSnapshot.run.id}/events?after=10&limit=25`);

    expect(response).toMatchObject({
      status: 200,
      body: {
        runId: approvedSnapshot.run.id,
        events: [{ id: 11, eventId: 'event-safe-1', sequence: 4, type: 'task_accepted' }],
        nextCursor: 11,
        hasMore: false
      }
    });
    expect(response.body.events[0]).not.toHaveProperty('payload');
    expect(calls.listEvents).toHaveBeenCalledWith(approvedSnapshot.run.id, 10, 25);
  });

  it('rejects malformed event cursors and excessive limits', async () => {
    const { app, approvedSnapshot } = await startApi();
    const malformed = await call(app, 'GET', `/api/projects/project-1/orchestrations/${approvedSnapshot.run.id}/events?after=-1`);
    const excessive = await call(app, 'GET', `/api/projects/project-1/orchestrations/${approvedSnapshot.run.id}/events?limit=501`);

    expect(malformed.status).toBe(400);
    expect(excessive.status).toBe(400);
  });

  it('inspects a stale reservation and records changed work without removing it', async () => {
    const { app, calls, reservation } = await startApi();
    calls.getRecovery.mockReturnValueOnce(undefined);

    const response = await call(app, 'POST', `/api/projects/project-1/planning-recoveries/${reservation.runId}/inspect`, {});

    expect(response).toMatchObject({ status: 200, body: { state: 'needs_review', revision: 2 } });
    expect(calls.inspect).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'project-1', reservation }));
    expect(calls.record).toHaveBeenCalledWith(expect.objectContaining({ state: 'needs_review', reservation }));
    expect(calls.remove).not.toHaveBeenCalled();
  });

  it('serves a project-scoped bounded preview and records an explicit keep decision', async () => {
    const { app, calls, reservation } = await startApi();

    const preview = await call(app, 'GET', `/api/projects/project-1/planning-recoveries/${reservation.runId}/diff`);
    const retained = await call(app, 'POST', `/api/projects/project-1/planning-recoveries/${reservation.runId}/retain`, { expectedRevision: 2 });

    expect(preview).toMatchObject({ status: 200, body: { changedPaths: ['README.md'], diff: '+saved' } });
    expect(retained).toMatchObject({ status: 200, body: { runId: reservation.runId, state: 'retained', revision: 3 } });
    expect(calls.preview).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'project-1', runId: reservation.runId }));
    expect(calls.retain).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1', runId: reservation.runId, expectedRevision: 2, actorId: 'user-1'
    }));
  });

  it('removes and unlocks an interrupted worktree only after the safe-clean check passes', async () => {
    const { app, calls, reservation } = await startApi();
    calls.getRecovery.mockReturnValueOnce(undefined);
    calls.inspect.mockResolvedValueOnce({ state: 'clean', safeToRetire: true, canPreview: true, changed: false });
    calls.remove.mockResolvedValueOnce(true);

    const response = await call(app, 'POST', `/api/projects/project-1/planning-recoveries/${reservation.runId}/inspect`, {});

    expect(response).toMatchObject({ status: 200, body: { runId: reservation.runId, state: 'cleaned', revision: 0 } });
    expect(calls.remove).toHaveBeenCalledTimes(1);
    expect(calls.clean).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1', runId: reservation.runId, reservation, actorId: 'user-1'
    }));
    expect(calls.record).not.toHaveBeenCalled();
  });

  it('approves the exact validated revision and reconciles its pull request', async () => {
    const { app, calls, approvedSnapshot } = await startApi();

    const response = await call(app, 'POST', '/api/projects/project-1/orchestrations/orchestration-approved-1/approve', { expectedRevision: 4 });

    expect(response).toMatchObject({ status: 200, body: {
      runId: approvedSnapshot.run.id, status: 'completed', issueId: 'issue-1',
      publication: { pullRequestUrl: 'https://github.com/acme/shop/pull/42' }
    } });
    expect(calls.approveAndPublish).toHaveBeenCalledWith({
      workspaceId: 'ws-test', runId: approvedSnapshot.run.id, expectedRevision: 4, actorId: 'user-1'
    });
  });

  it('retries a recorded approval after a remote publication timeout', async () => {
    const { app, calls } = await startApi();
    calls.approveAndPublish.mockRejectedValueOnce(new Error('GitHub timed out after creating the pull request.'));

    const first = await call(app, 'POST', '/api/projects/project-1/orchestrations/orchestration-approved-1/approve', { expectedRevision: 4 });
    const retry = await call(app, 'POST', '/api/projects/project-1/orchestrations/orchestration-approved-1/approve', { expectedRevision: 4 });

    expect(first.status).toBe(500);
    expect(retry).toMatchObject({ status: 200, body: { status: 'completed' } });
    expect(calls.approveAndPublish).toHaveBeenCalledTimes(2);
  });
});
