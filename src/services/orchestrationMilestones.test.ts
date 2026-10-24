import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseOrchestrationPlan, validateOrchestrationPlan } from './orchestrationContract.js';
import { orchestrationPlanDocument } from './orchestrationPlanDocument.js';
import { SQLiteService } from './sqliteService.js';
import { OrchestrationService } from './orchestrationService.js';
import type { OrchestrationSnapshot } from './orchestrationStateMachine.js';
import { initialTaskRecords } from './orchestrationStateMachine.js';
import type { MilestoneExpansion, PlanNextMilestone } from './orchestrationMilestonePlanner.js';

const agents = [{ id: 'architect', role: 'Architecture Agent' }] as const;
const plan = parseOrchestrationPlan({ schemaVersion: 2, goal: 'Design the service, then its client.',
  requirements: [{ id: 'service', description: 'Define the service contract.' }, { id: 'client', description: 'Define a client of the accepted service.' }],
  milestones: [
    { id: 'first', title: 'Service contract', objective: 'Define service interfaces.', requirementIds: ['service'], repositories: ['acme/service'] },
    { id: 'second', title: 'Client contract', objective: 'Use the accepted service interfaces.', requirementIds: ['client'], repositories: ['acme/service'] }
  ],
  tasks: [{ id: 'design-service', milestoneId: 'first', title: 'Design service', description: 'Define the service contract.', kind: 'architecture', repository: 'acme/service', ownerAgentId: 'architect', requirementIds: ['service'], acceptanceCriteria: ['Contract is documented.'] }]
});
const expansion: MilestoneExpansion = { checkpoints: [{ repository: 'acme/service', commit: 'a'.repeat(40) }], tasks: [{ ...plan.tasks[0], id: 'design-client', milestoneId: 'second', repository: 'acme/service', requirementIds: ['client'], title: 'Design client' }] };

describe('adaptive milestone boundaries', () => {
  let directory = '';
  let store: SQLiteService | undefined;
  afterEach(() => { vi.restoreAllMocks(); store?.close(); store = undefined; if (directory) fs.rmSync(directory, { recursive: true, force: true }); directory = ''; });

  it('preserves the current role contract when saving reviews for two repositories in the next milestone', () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-milestones-'));
    store = new SQLiteService({ dbPath: path.join(directory, 'alpha.db'), seedDefaults: false });
    vi.spyOn(store, 'getAgents').mockReturnValue([...agents, { id: 'backend', role: 'Backend Agent' },
      { id: 'frontend', role: 'Frontend Agent' }, { id: 'security', role: 'Security / Code Quality Agent' }] as any);
    const roadmap = parseOrchestrationPlan({ ...plan, roleContractVersion: 2,
      milestones: plan.milestones!.map(item => item.id === 'second' ? { ...item, repositories: ['acme/service', 'acme/client'] } : item) });
    const now = new Date().toISOString();
    store.addAllowedPath(directory, 'Milestone contract fixture');
    const initial = store.createOrchestrationSnapshot({ id: 'scoped-milestone', workspaceId: 'ws-default', projectId: 'p', issueId: 'i',
      repository: 'acme/service', requestKey: 'scoped-milestone', requestFingerprint: 'scoped-milestone', createdBy: 'user', executorId: 'test',
      ownershipEpoch: 1, workflowVersion: 2, planVersion: 1, plan: roadmap, status: 'planning', revision: 0,
      baseCommit: 'a'.repeat(40), createdAt: now, updatedAt: now,
      repositoryWorkspaces: ['acme/service', 'acme/client'].map(repository => ({ repository, baseCommit: 'a'.repeat(40),
        baseRef: 'main', branchName: 'alpha/orchestration/milestone-test', worktreePath: path.join(directory, repository) }))
    }, initialTaskRecords(roadmap).map(task => ({ ...task, status: 'accepted' })), 'template');
    const snapshot = store.transitionOrchestrationRun({ runId: initial.run.id, expectedRevision: initial.run.revision,
      nextStatus: 'executing', actorId: 'test' });
    const stage = parseOrchestrationPlan({ schemaVersion: 1, roleContractVersion: 2, goal: 'Implement both codebases.',
      requirements: roadmap.requirements.filter(item => item.id === 'client'), tasks: ['backend', 'frontend'].flatMap((kind, index) => [
        { id: `fix-${kind}`, title: `Fix ${kind}`, description: 'Implement scoped changes.', kind, ownerAgentId: kind, repository: index ? 'acme/client' : 'acme/service',
          requirementIds: ['client'], acceptanceCriteria: ['Requested behavior is implemented.'], scope: { includePaths: ['src/**'] } },
        { id: `review-${kind}`, title: `Review ${kind}`, description: 'Independently inspect the accepted changes.', kind: 'review', ownerAgentId: 'security',
          repository: index ? 'acme/client' : 'acme/service', dependsOn: [`fix-${kind}`], requirementIds: ['client'], acceptanceCriteria: ['Accepted changes are reviewed.'] }
      ]) });
    const saved = store.appendOrchestrationMilestone({ runId: snapshot.run.id, expectedRevision: snapshot.run.revision, expectedPlanVersion: 1,
      milestoneId: 'second', actorId: 'orchestrator', tasks: stage.tasks.map(task => ({ ...task, milestoneId: 'second' })),
      checkpoints: ['acme/service', 'acme/client'].map(repository => ({ repository, commit: 'a'.repeat(40) })) });
    expect(saved.run.planVersion).toBe(2);
    expect(saved.run.plan.roleContractVersion).toBe(2);
    expect(saved.tasks.filter(task => task.kind === 'review')).toHaveLength(2);
  });

  it('allows deferred coverage only through a complete ordered roadmap', () => {
    const options = { initialPlan: true, repositories: ['acme/service'] };
    expect(validateOrchestrationPlan(plan, agents, options)).toEqual([]);
    expect(validateOrchestrationPlan({ ...plan, milestones: undefined }, agents, options).map(issue => issue.code)).toContain('invalid_milestone');
    expect(validateOrchestrationPlan({ ...plan, tasks: [...plan.tasks, ...expansion.tasks] }, agents, options).map(issue => issue.code)).toContain('invalid_milestone');
    expect(validateOrchestrationPlan({ ...plan, tasks: [{ ...plan.tasks[0], requirementIds: ['client'] }] }, agents, options).map(issue => issue.code)).toContain('invalid_milestone');
  });

  it('renders deterministic downloadable Markdown without active model markup', () => {
    const malicious = { ...plan, goal: '<script>alert(1)</script> ![track](https://example.com)' };
    const document = orchestrationPlanDocument(malicious, 1);
    expect(document).toEqual(orchestrationPlanDocument(malicious, 1));
    expect(document.fileName).toBe('build-plan-v1.md');
    expect(document.content).toContain('## Milestone roadmap');
    expect(document.content).not.toContain('<script>');
    expect(document.content).not.toContain('![track]');
    expect(document.content).toContain('Tasks will be planned from accepted repository evidence.');
  });

  async function setup(next: PlanNextMilestone) {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-milestones-'));
    store = new SQLiteService({ dbPath: path.join(directory, 'alpha.db'), seedDefaults: false });
    vi.spyOn(store, 'getAgents').mockReturnValue(agents as any);
    const launch = vi.fn(async (request: { attemptId: string }) => ({ prototypeRunId: `prototype-${request.attemptId}` }));
    const service = new OrchestrationService(store, { launch }, undefined, next);
    // No physical worktrees are needed for this deterministic scheduler test.
    const initial = await service.start({ workspaceId: 'ws-default', projectId: 'project', issueId: 'issue', repository: 'acme/service',
      requestKey: 'request', requestFingerprint: 'request-hash', createdBy: 'user', executorId: 'executor', eligibleAgents: agents, plan });
    expect(store.ensureOrchestrationPlanDocuments(initial.run.id)[0].content).toContain('Service contract');
    const active = await service.startPlannedWork({ workspaceId: 'ws-default', runId: initial.run.id, expectedRevision: initial.run.revision, actorId: 'user' });
    return { service, active, launch };
  }
  async function submit(service: OrchestrationService, active: OrchestrationSnapshot) {
    const task = active.tasks.find(task => task.id === active.run.currentTaskId)!;
    const attempt = active.attempts.find(attempt => attempt.taskId === task.id)!;
    const submitted = await service.submitResult({ workspaceId: 'ws-default', runId: active.run.id, taskId: task.id, attemptId: attempt.id,
      expectedTaskRevision: task.revision, result: { summary: 'Contract accepted.' }, resultCommit: 'a'.repeat(40) });
    return () => service.acceptAttempt({ workspaceId: 'ws-default', runId: active.run.id, taskId: task.id, attemptId: attempt.id,
      expectedTaskRevision: submitted.tasks.find(item => item.id === task.id)!.revision, acceptedBy: 'orchestrator', evidence: { verified: true } });
  }

  it('persists the next document before dispatch, preserves prior tasks and does not plan twice', async () => {
    const next = vi.fn(async () => expansion);
    const { service, active, launch } = await setup(next);
    expect(next).not.toHaveBeenCalled();
    const accept = await submit(service, active);
    const expanded = await accept();
    expect(expanded.run.planVersion).toBe(2);
    expect(expanded.run.currentTaskId).toBe('design-client');
    expect(expanded.tasks[0].status).toBe('accepted');
    expect(expanded.run.plan.tasks[0]).toEqual(active.run.plan.tasks[0]);
    expect(next).toHaveBeenCalledTimes(1);
    expect(store!.ensureOrchestrationPlanDocuments(active.run.id).map(document => document.version)).toEqual([1, 2]);
    await service.resume({ workspaceId: 'ws-default', runId: active.run.id, actorId: 'user' });
    expect(next).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledTimes(2);
    const finish = await submit(service, expanded);
    expect((await finish()).run.status).toBe('validating');
    expect(() => store!.appendOrchestrationMilestone({ runId: active.run.id, expectedRevision: active.run.revision, expectedPlanVersion: 1,
      milestoneId: 'second', ...expansion, actorId: 'user' })).toThrow(/changed/);
  });

  it('keeps an unfinished roadmap blocked when planning fails', async () => {
    const { service, active, launch } = await setup(async () => { throw new Error('Provider unavailable'); });
    const accept = await submit(service, active);
    const stopped = await accept();
    expect(stopped.run.status).toBe('blocked');
    expect(stopped.run.planVersion).toBe(1);
    expect(stopped.run.stoppedReason).toContain('Provider unavailable');
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch when Markdown storage fails and resumes without duplicating work', async () => {
    const next = vi.fn(async () => expansion);
    const { service, active, launch } = await setup(next);
    const accept = await submit(service, active);
    vi.spyOn(store!, 'ensureOrchestrationPlanDocuments').mockImplementationOnce(() => { throw new Error('Disk unavailable'); });
    const stopped = await accept();
    expect(stopped.run.status).toBe('blocked');
    expect(stopped.run.stoppedReason).toContain('Plan document could not be saved');
    expect(launch).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
    const resumed = await service.resume({ workspaceId: 'ws-default', runId: active.run.id, actorId: 'user' });
    expect(resumed.run.planVersion).toBe(2);
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it.each(['pause', 'cancel'] as const)('honors %s while the next planning call is in flight', async action => {
    let release!: (value: MilestoneExpansion) => void;
    let signalStarted!: () => void;
    const started = new Promise<void>(resolve => { signalStarted = resolve; });
    const { service, active, launch } = await setup(async () => { signalStarted(); return new Promise(resolve => { release = resolve; }); });
    const accept = await submit(service, active);
    const pending = accept();
    await started;
    const latest = store!.getOrchestrationSnapshot(active.run.id)!;
    const input = { workspaceId: 'ws-default', runId: active.run.id, expectedRevision: latest.run.revision, actorId: 'user' };
    if (action === 'pause') await service.pauseRun(input); else await service.cancelRun(input);
    release(expansion);
    const stopped = await pending;
    expect(stopped.run.status).toBe(action === 'pause' ? 'paused' : 'cancelled');
    expect(stopped.run.planVersion).toBe(1);
    expect(launch).toHaveBeenCalledTimes(1);
  });
});
