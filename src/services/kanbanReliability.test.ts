import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { worktreeChangesHash } from './orchestrationWorktreeRecovery.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SQLiteService } from './sqliteService.js';
import { OrchestrationService } from './orchestrationService.js';
import { parseOrchestrationPlan } from './orchestrationContract.js';
import { runWithWorkspace } from './workspaceContext.js';
import { isManagedTask } from './managedTaskExecution.js';
import { workAttemptCount, totalWorkAttemptCount } from './orchestrationRecoveryPolicy.js';
import type { OrchestrationSnapshot } from './orchestrationStateMachine.js';

describe('Kanban lifecycle ownership and preserved planning', () => {
  let dir = ''; let store: SQLiteService | undefined;
  afterEach(() => { vi.restoreAllMocks(); store?.close(); store = undefined; if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = ''; });
  async function planned() {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-kanban-reliability-'));
    store = new SQLiteService({ dbPath: path.join(dir, 'alpha.db'), seedDefaults: false });
    store.addAllowedPath(dir, 'reliability fixture');
    const agents = [{ id: 'backend', role: 'Backend Agent' as const }];
    vi.spyOn(store, 'getAgents').mockReturnValue(agents as any);
    const plan = parseOrchestrationPlan({ schemaVersion: 1, goal: 'Persist tasks.', requirements: [{ id: 'REQ-1', description: 'Tasks survive reload.' }],
      tasks: [{ id: 'implement', kind: 'backend', ownerAgentId: 'backend', title: 'Persist tasks', description: 'Save tasks.', dependsOn: [], requirementIds: ['REQ-1'], acceptanceCriteria: ['A task survives reload.'], scope: { includePaths: ['src/**'], excludePaths: [] } }] });
    const engine = new OrchestrationService(store, { launch: vi.fn(async request => ({ prototypeRunId: `prototype-${request.attemptId}` })) });
    const snapshot = await engine.start({ workspaceId: 'workspace', projectId: 'project-one', issueId: 'issue-one', repository: 'Acme/App',
      requestKey: 'request-one', requestFingerprint: 'fingerprint', createdBy: 'developer', executorId: 'desktop', eligibleAgents: agents, plan });
    return { snapshot, plan, engine };
  }
  it('recognizes historical managed tasks and parent-linked members as managed', () => {
    expect(isManagedTask({ labels: ['alpha:task-orchestration'] })).toBe(true);
    expect(isManagedTask({ labels: [] }, { orchestrationRunId: 'old-parent' })).toBe(true);
    expect(isManagedTask({ labels: [] })).toBe(false);
  });
  it('finds an owner across projects and refuses another repository reservation', async () => {
    const { snapshot } = await planned();
    runWithWorkspace('workspace', () => {
      expect(store!.getActiveOrchestrationForProject('project-two', 'https://github.com/acme/app.git')).toMatchObject({ runId: snapshot.run.id, issueId: 'issue-one' });
      expect(() => store!.reserveOrchestrationPlanning({ projectId: 'project-two', repository: 'acme/app', requestKey: 'different', requestFingerprint: 'different', createdBy: 'developer', runId: 'other', branchName: 'other', baseCommit: 'a'.repeat(40), worktreePath: path.join(dir, 'other'), ownerSessionId: 'session' })).toThrow(/owns/);
    });
  });
  it('atomically replaces only an unstarted plan and preserves its original version', async () => {
    const { snapshot, plan } = await planned();
    runWithWorkspace('workspace', () => {
      const changed = { ...plan, tasks: plan.tasks.map(task => ({ ...task, title: 'Revised task persistence' })) };
      const next = store!.replaceUnstartedPlan({ runId: snapshot.run.id, expectedRevision: snapshot.run.revision, plan: changed, actorId: 'developer', reason: 'Prefer the existing module.' });
      expect(next.run.status).toBe('awaiting_plan_approval'); expect(next.run.planVersion).toBe(2); expect(next.attempts).toHaveLength(0);
      expect(store!.ensureOrchestrationPlanDocuments(snapshot.run.id)).toHaveLength(2);
      expect(() => store!.replaceUnstartedPlan({ runId: snapshot.run.id, expectedRevision: snapshot.run.revision, plan: changed, actorId: 'developer', reason: 'Stale competing revision.' })).toThrow(/changed/);
      expect(() => store!.replaceUnstartedPlan({ runId: snapshot.run.id, expectedRevision: next.run.revision, plan: { ...changed, requirements: [{ id: 'REQ-1', description: 'Different scope' }] }, actorId: 'developer', reason: 'Bad revision' })).toThrow(/requirements/);
      expect(store!.getOrchestrationSnapshot(snapshot.run.id)!.run.planVersion).toBe(2);
    });
  });
  it('persists queued requests without storing credentials and preserves cancellation on reload', async () => {
    await planned();
    const record = { id: 'queued-one', workspaceId: 'workspace', ownerId: 'developer', projectId: 'project-one', issueId: 'issue-one', status: 'cancelled' };
    store!.saveBoardBuildRequest(record); store!.close(); store = new SQLiteService({ dbPath: path.join(dir, 'alpha.db'), seedDefaults: false });
    expect(store.listBoardBuildRequests('workspace')).toEqual([record]); expect(store.listBoardBuildRequests('other')).toEqual([]);
  });
  it('uses a reviewed episode boundary without erasing cumulative attempts', () => {
    const snapshot = { attempts: Array.from({ length: 5 }, (_, i) => ({ taskId: 'step', attemptNumber: i + 1, status: 'failed', prototypeRunId: `run-${i}`, contextManifest: {} })),
      recoveryAuthorizations: [{ taskId: 'step', afterWorkAttempts: 4 }] } as unknown as OrchestrationSnapshot;
    expect(workAttemptCount(snapshot, 'step')).toBe(1); expect(totalWorkAttemptCount(snapshot, 'step')).toBe(5); expect(snapshot.attempts).toHaveLength(5);
  });
  it('requires an inspected unchanged candidate to restart an exhausted step and keeps every attempt', async () => {
    const { snapshot, engine } = await planned();
    const cwd = path.join(dir, 'source'); fs.mkdirSync(cwd); const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
    git('init', '-b', 'main'); fs.mkdirSync(path.join(cwd, 'src')); fs.writeFileSync(path.join(cwd, 'src/app.ts'), 'base\n'); git('add', '.'); git('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-m', 'base');
    let current = await engine.startPlannedWork({ workspaceId: 'workspace', runId: snapshot.run.id, expectedRevision: snapshot.run.revision, actorId: 'developer' });
    current = runWithWorkspace('workspace', () => store!.bindOrchestrationWorkspace({ runId: snapshot.run.id, branchName: 'main', baseRef: 'main', baseCommit: git('rev-parse', 'HEAD'), worktreePath: cwd }));
    for (let index = 0; index < 4; index++) {
      const attempt = current.attempts[current.attempts.length - 1];
      current = runWithWorkspace('workspace', () => {
        const failed = store!.failOrchestrationAttempt({ runId: current.run.id, taskId: 'implement', attemptId: attempt.id, expectedTaskRevision: current.tasks[0].revision, reason: 'Execution timed out.' });
        return store!.transitionOrchestrationRun({ runId: current.run.id, expectedRevision: failed.run.revision, nextStatus: 'blocked', reason: 'Execution timed out.' });
      });
      if (index < 3) current = await engine.retryTask({ workspaceId: 'workspace', runId: current.run.id, taskId: 'implement', expectedTaskRevision: current.tasks[0].revision, actorId: 'developer', developerGuidance: 'Continue the same scoped work and verify it.' });
    }
    const retry = { workspaceId: 'workspace', runId: current.run.id, taskId: 'implement', expectedTaskRevision: current.tasks[0].revision, expectedRunRevision: current.run.revision, actorId: 'developer', developerGuidance: 'The runtime issue is fixed. Continue and verify the saved candidate.' };
    await expect(engine.retryTask(retry)).rejects.toThrow(/four-work-attempt/);
    await expect(engine.retryTask({ ...retry, reviewedCandidateHash: 'a'.repeat(64) })).rejects.toThrow(/candidate changed/);
    current = await engine.retryTask({ ...retry, reviewedCandidateHash: await worktreeChangesHash(cwd) });
    expect(current.attempts).toHaveLength(5); expect(totalWorkAttemptCount(current, 'implement')).toBe(5); expect(workAttemptCount(current, 'implement')).toBe(1);
    expect(current.recoveryAuthorizations).toHaveLength(1); expect(current.run.status).toBe('executing');
    await expect(engine.retryTask({ ...retry, reviewedCandidateHash: await worktreeChangesHash(cwd) })).rejects.toThrow(/changed/);
  });
});
