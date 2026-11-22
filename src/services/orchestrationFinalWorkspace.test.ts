import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseOrchestrationPlan } from './orchestrationContract.js';
import { SQLiteService } from './sqliteService.js';
import { OrchestrationService } from './orchestrationService.js';
import { initialTaskRecords } from './orchestrationStateMachine.js';
import { recoveryAvailableActions } from './orchestrationRecoveryPolicy.js';

const agents = [{ id: 'frontend', role: 'Frontend Agent' }] as const;
const plan = parseOrchestrationPlan({ schemaVersion: 1, goal: 'Add login.', requirements: [{ id: 'login', description: 'Login screen.' }],
  tasks: [{ id: 'login-form', title: 'Login form', description: 'Add the form.', kind: 'frontend', repository: 'acme/web', ownerAgentId: 'frontend',
    requirementIds: ['login'], acceptanceCriteria: ['It renders.'], requiredChecks: ['test'], scope: { includePaths: ['src/**'] } }] });

/** Final checks that stopped on the working copy itself are repaired by checking again, not left for the person. */
describe('final checks stopped on a working copy', () => {
  let directory = '';
  let store: SQLiteService | undefined;
  afterEach(() => { vi.restoreAllMocks(); store?.close(); store = undefined; if (directory) fs.rmSync(directory, { recursive: true, force: true }); directory = ''; });

  async function blockedAtFinalChecks(check: string, ensureWorkspaces = vi.fn(async () => undefined)) {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-final-workspace-'));
    store = new SQLiteService({ dbPath: path.join(directory, 'alpha.db'), seedDefaults: false });
    vi.spyOn(store, 'getAgents').mockReturnValue(agents as any);
    store.addAllowedPath(directory, 'Final workspace fixture');
    const now = new Date().toISOString();
    const created = store.createOrchestrationSnapshot({ id: `final-${check}`, workspaceId: 'ws-default', projectId: 'p', issueId: 'i', repository: 'acme/web',
      requestKey: `final-${check}`, requestFingerprint: 'f', createdBy: 'user', executorId: 'test', ownershipEpoch: 1, workflowVersion: 1, planVersion: 1, plan,
      status: 'planning', revision: 0, baseCommit: 'a'.repeat(40), createdAt: now, updatedAt: now,
      repositoryWorkspaces: [{ repository: 'acme/web', branchName: 'alpha/b', baseRef: 'main', baseCommit: 'a'.repeat(40), worktreePath: path.join(directory, 'missing-copy'), optional: false }]
    }, initialTaskRecords(plan).map(task => ({ ...task, status: 'accepted' })), 'template');
    let snapshot = store.transitionOrchestrationRun({ runId: created.run.id, expectedRevision: created.run.revision, nextStatus: 'executing', actorId: 'test' });
    snapshot = store.transitionOrchestrationRun({ runId: snapshot.run.id, expectedRevision: snapshot.run.revision, nextStatus: 'validating', actorId: 'test' });
    snapshot = store.transitionOrchestrationRun({ runId: snapshot.run.id, expectedRevision: snapshot.run.revision, nextStatus: 'blocked', actorId: 'test',
      reason: 'Final checks stopped on the working copy.', evidence: { validationVersion: 1, check } });
    const service = new OrchestrationService(store, { launch: vi.fn(async () => ({ prototypeRunId: 'p' })), ensureWorkspaces });
    return { service, snapshot, ensureWorkspaces };
  }

  it('offers to check again, which rebuilds a missing working copy first', async () => {
    const { service, snapshot, ensureWorkspaces } = await blockedAtFinalChecks('workspace_missing');
    expect(recoveryAvailableActions({ snapshot, category: 'final_validation', canControl: true, episodeAgeMs: 0 }).availableActions).toContain('recheck_prerequisite');
    const rechecking = await service.retryFinalValidation({ workspaceId: 'ws-default', runId: snapshot.run.id, expectedRunRevision: snapshot.run.revision, actorId: 'user' });
    expect(ensureWorkspaces).toHaveBeenCalledTimes(1);
    expect(rechecking.run.status).toBe('validating');
  });

  it('still asks the person when a changed file belongs to no accepted task', async () => {
    const { service, snapshot } = await blockedAtFinalChecks('final_scope');
    await expect(service.retryFinalValidation({ workspaceId: 'ws-default', runId: snapshot.run.id, expectedRunRevision: snapshot.run.revision, actorId: 'user' }))
      .rejects.toThrow(/belongs to no accepted task/);
  });
});
