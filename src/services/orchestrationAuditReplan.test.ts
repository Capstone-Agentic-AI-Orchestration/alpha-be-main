import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { SQLiteService } from './sqliteService.js';
import { OrchestrationService, type OrchestrationLaunchRequest } from './orchestrationService.js';
import { parseOrchestrationPlan } from './orchestrationContract.js';
import { runWithWorkspace } from './workspaceContext.js';

let directory = ''; let store: SQLiteService;
afterEach(() => { vi.restoreAllMocks(); store?.close(); if (directory) fs.rmSync(directory, { recursive: true, force: true }); });

it('preserves a blocked run and saves a versioned Security plan without dispatch; rejects stale and invalid replacements atomically', async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-audit-replan-'));
  store = new SQLiteService({ dbPath: path.join(directory, 'alpha.db'), seedDefaults: false });
  const agents = [{ id: 'backend', role: 'Backend Agent' }, { id: 'security', role: 'Security / Code Quality Agent' }, { id: 'qa', role: 'Validation / Checking Agent' }] as const;
  vi.spyOn(store, 'getAgents').mockReturnValue(agents as any);
  const oldPlan = parseOrchestrationPlan({ schemaVersion: 1, goal: 'Remediate dependency vulnerabilities.', requirements: [{ id: 'SEC', description: 'Resolve security findings.' }], tasks: [
    { id: 'old-fix', title: 'Fix dependencies', description: 'Use the available findings.', kind: 'backend', ownerAgentId: 'backend', repository: 'acme/api', requirementIds: ['SEC'], acceptanceCriteria: ['Dependencies are safe.'] }
  ] });
  const launch = vi.fn(async (_request: OrchestrationLaunchRequest) => ({ prototypeRunId: 'approved-audit-prototype' }));
  const revised = parseOrchestrationPlan({ ...oldPlan, tasks: [
    { id: 'baseline', title: 'Baseline audit', description: 'Gather current findings.', kind: 'audit', ownerAgentId: 'security', dependsOn: [], dependencyAudit: { scanner: 'npm', purpose: 'baseline' } }
  ].map(task => ({ ...task, repository: 'acme/api', requirementIds: ['SEC'], acceptanceCriteria: ['Evidence is recorded.'] })) });
  const planner = vi.fn(async () => ({ tasks: revised.tasks, checkpoints: [] }));
  const service = new OrchestrationService(store, { launch }, undefined, planner);
  let snapshot = await service.start({ workspaceId: 'ws-default', projectId: 'p', issueId: 'i', repository: 'acme/api', requestKey: 'audit-request', requestFingerprint: 'audit', createdBy: 'user', executorId: 'desktop', eligibleAgents: agents.slice(0, 1), plan: oldPlan });
  snapshot = runWithWorkspace('ws-default', () => store.transitionOrchestrationRun({ runId: snapshot.run.id, expectedRevision: snapshot.run.revision, nextStatus: 'blocked', actorId: 'orchestrator', reason: 'Missing dependency audit evidence.' }));
  const input = { workspaceId: 'ws-default', runId: snapshot.run.id, expectedRevision: snapshot.run.revision, actorId: 'user' };
  // Failure cannot partially replace the old plan or its tasks.
  expect(() => runWithWorkspace('ws-default', () => store.replaceBlockedAuditPlan({ ...input, plan: { ...revised, tasks: revised.tasks.map(task => ({ ...task, ownerAgentId: 'backend' })) } })) ).toThrow();
  expect(store.getOrchestrationSnapshot(snapshot.run.id)?.run.planVersion).toBe(1);
  const saved = await service.proposeAuditReplan(input);
  expect(saved.run).toMatchObject({ id: snapshot.run.id, status: 'awaiting_plan_approval', planVersion: 2 });
  expect(saved.tasks.find(task => task.id === 'old-fix')).toMatchObject({ required: false, status: 'superseded' });
  expect(saved.tasks.find(task => task.kind === 'audit')).toMatchObject({ ownerAgentId: 'security', dependencyAudit: { purpose: 'baseline', level: 'low' } });
  expect(store.ensureOrchestrationPlanDocuments(snapshot.run.id).map(document => document.version)).toEqual([1, 2]);
  expect(launch).not.toHaveBeenCalled(); expect(planner).toHaveBeenCalledTimes(1);
  expect(saved.run.plan.schemaVersion).toBe(2);
  expect(saved.run.plan.milestones).toHaveLength(2);
  expect(saved.tasks.filter(task => task.required)).toHaveLength(1);
  await expect(service.proposeAuditReplan(input)).rejects.toThrow(/changed/);
  expect(store.getOrchestrationSnapshot(snapshot.run.id)?.run.planVersion).toBe(2);
  vi.spyOn(store, 'getAgents').mockReturnValue(agents.slice(1) as any);
  const approved = await service.startPlannedWork({ ...input, expectedRevision: saved.run.revision });
  expect(approved.run.status).toBe('executing');
  expect(launch).toHaveBeenCalledTimes(1);
  expect(launch.mock.calls[0][0]).toMatchObject({ ownerAgentId: 'security', taskKind: 'audit' });
});
