import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent, Issue, Project, PrototypeRun } from '../models/index.js';
import { addBranchWorktree, removeDetachedWorktree } from '../utils/gitUtils.js';
import { parseOrchestrationPlan, type OrchestrationTaskKind } from './orchestrationContract.js';
import { buildHumanReviewAmendment, buildOrchestrationReviewAmendment, OrchestrationReviewPlanError } from './orchestrationReviewWorkflow.js';
import { OrchestrationRunnerAdapter, orchestrationBranchName } from './orchestrationRunnerAdapter.js';
import { OrchestrationService } from './orchestrationService.js';
import type { OrchestrationSnapshot } from './orchestrationStateMachine.js';
import { SQLiteService } from './sqliteService.js';
import type { StartRunParams } from './runnerService.js';
import { runWithWorkspace } from './workspaceContext.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', [
  '-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args
], { cwd, stdio: 'pipe' }).toString().trim();

describe('sending finished work back from final review', () => {
  let root = '';
  let store: SQLiteService | undefined;
  let worktree: { source: string; worktreePath: string } | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    store?.close();
    store = undefined;
    if (worktree) await removeDetachedWorktree(worktree.source, worktree.worktreePath);
    worktree = undefined;
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = '';
  });

  async function buildToReview() {
    root = fs.mkdtempSync(path.join(process.cwd(), '.tmp-human-review-'));
    store = new SQLiteService({ dbPath: path.join(root, 'alpha.db'), seedDefaults: false });
    store.addAllowedPath(root, 'human review fixture');
    const runId = 'orchestration-human-review-test';
    const workspaceId = 'workspace-human-review';
    const repository = 'example/ui';
    const branchName = orchestrationBranchName(runId);
    const source = path.join(root, 'source');
    fs.mkdirSync(source);
    git(source, 'init', '--initial-branch', 'main');
    fs.writeFileSync(path.join(source, 'README.md'), 'start\n');
    git(source, 'add', '-A');
    git(source, 'commit', '-m', 'planning base');
    const baseCommit = git(source, 'rev-parse', 'HEAD');
    const worktreePath = path.join(root, 'worktree');
    await addBranchWorktree(source, worktreePath, branchName, baseCommit);
    worktree = { source, worktreePath };
    const repositoryWorkspaces = [{ repository, branchName, baseRef: baseCommit, baseCommit, worktreePath }];
    const agents = [
      { id: 'frontend', role: 'Frontend Agent' },
      { id: 'reviewer', role: 'Security / Code Quality Agent' },
      { id: 'validator', role: 'Validation / Checking Agent' },
      { id: 'delivery', role: 'GitHub Finalization Agent' }
    ].map(agent => ({ ...agent, name: agent.id, modelProvider: 'OpenAI', modelName: 'test' } as Agent));
    vi.spyOn(store, 'getAgents').mockReturnValue(agents);
    vi.spyOn(store, 'getProjects').mockReturnValue([{ id: 'project', key: 'TEST', name: 'Test project' } as Project]);
    vi.spyOn(store, 'getIssues').mockReturnValue([{ id: 'issue', projectId: 'project', githubRepo: repository } as Issue]);
    const startRun = vi.fn(async (_params: StartRunParams) => ({ id: 'unused-receipt' } as PrototypeRun));
    const adapter = new OrchestrationRunnerAdapter({
      store,
      runner: Object.assign(new EventEmitter(), { startRun }),
      resolveWorkspace: () => ({ dir: source, managed: true, repo: repository }),
      allowWorkspace: vi.fn(),
      readinessFor: () => ({ status: 'ready', detail: 'Test runtime ready.' }),
      resolvePersona: agent => ({
        name: agent.name, role: agent.role, modelProvider: agent.modelProvider, modelName: agent.modelName,
        personaHash: 'test-persona', systemPrompt: 'Test persona', autonomyLevel: 'Supervised',
        skills: [], mcpServers: [], sources: []
      })
    });
    const orchestrator = new OrchestrationService(store, adapter);
    const task = (id: string, kind: OrchestrationTaskKind, ownerAgentId: string, dependsOn: string[]) => ({
      id, kind, ownerAgentId, repository, dependsOn, title: id, description: `Complete ${id}.`,
      requirementIds: ['REQ-1'], acceptanceCriteria: [`${id} is verified.`],
      scope: { includePaths: ['README.md'], excludePaths: [] }
    });
    const plan = parseOrchestrationPlan({
      schemaVersion: 1, goal: 'Deliver a verified product.',
      requirements: [{ id: 'REQ-1', description: 'The product works.' }],
      tasks: [
        task('implement-ui', 'frontend', 'frontend', []),
        task('review', 'review', 'reviewer', ['implement-ui']),
        task('validate', 'validation', 'validator', ['review']),
        task('deliver', 'delivery', 'delivery', ['validate'])
      ]
    });
    let snapshot = await orchestrator.start({
      runId, workspaceId, projectId: 'project', issueId: 'issue', repository,
      repositoryWorkspaces, eligibleAgents: agents, plan, createdBy: 'user', executorId: 'test',
      requestKey: 'request', requestFingerprint: 'fingerprint'
    });
    snapshot = await orchestrator.startPlannedWork({ workspaceId, runId, expectedRevision: snapshot.run.revision, actorId: 'user' });
    const visited: string[] = [];
    const drive = async (current: OrchestrationSnapshot) => {
      let next = current;
      for (let step = 0; step < 12 && next.run.currentTaskId; step++) {
        const active = next.tasks.find(item => item.id === next.run.currentTaskId)!;
        const attempt = next.attempts.find(item => item.taskId === active.id && item.status === 'running')!;
        visited.push(active.id);
        if (active.kind === 'frontend') {
          fs.appendFileSync(path.join(worktreePath, 'README.md'), `${active.id}\n`);
          git(worktreePath, 'add', '-A');
          git(worktreePath, 'commit', '-m', active.id);
        }
        const resultCommit = git(worktreePath, 'rev-parse', 'HEAD');
        next = await orchestrator.submitResult({
          workspaceId, runId, taskId: active.id, attemptId: attempt.id, expectedTaskRevision: active.revision,
          result: { summary: `${active.id} completed.`, agentReport: { reviewFindings: [] } }, resultCommit
        });
        const acceptance = {
          workspaceId, runId, taskId: active.id, attemptId: attempt.id,
          expectedTaskRevision: next.tasks.find(item => item.id === active.id)!.revision,
          acceptedBy: 'orchestrator',
          evidence: active.kind === 'frontend' ? { changedPaths: ['README.md'] } : { fixture: 'passed' }
        };
        if (active.kind === 'review') {
          const amendment = buildOrchestrationReviewAmendment(next, next.tasks.find(item => item.id === active.id)!, [], agents);
          next = await orchestrator.acceptReviewOutcome({ ...acceptance, expectedPlanVersion: next.run.planVersion, amendment });
        } else {
          next = await orchestrator.acceptAttempt(acceptance);
        }
      }
      return next;
    };
    snapshot = await drive(snapshot);
    expect(snapshot.run.status).toBe('validating');
    snapshot = runWithWorkspace(workspaceId, () => store!.transitionOrchestrationRun({
      runId, expectedRevision: snapshot.run.revision, nextStatus: 'awaiting_approval', reason: 'Final checks passed.',
      evidence: { validationVersion: 1, repository, branchName, resultCommit: git(worktreePath, 'rev-parse', 'HEAD'), checks: { status: 'passed', observed: [] } }
    }));
    return { orchestrator, snapshot, agents, workspaceId, runId, drive, visited, startRun };
  }

  it('routes the request to the code owner, then reviews and validates again on the same branch', async () => {
    const { orchestrator, snapshot, agents, workspaceId, runId, drive, visited } = await buildToReview();
    expect(snapshot.run.status).toBe('awaiting_approval');
    const branchBefore = snapshot.run.repositoryWorkspaces?.[0].branchName;

    let next = await orchestrator.requestReviewChanges({
      workspaceId, runId, expectedRunRevision: snapshot.run.revision, actorId: 'reviewer-person',
      feedback: 'The empty state in README.md needs a clearer heading.', eligibleAgents: agents
    });
    expect(next.run.status).toBe('executing');
    expect(next.run.planVersion).toBe(snapshot.run.planVersion + 1);
    const correction = next.tasks.find(item => item.id === next.run.currentTaskId)!;
    expect(correction).toMatchObject({ kind: 'frontend', ownerAgentId: 'frontend', correctionOfTaskId: 'implement-ui' });
    expect(correction.scope.includePaths).toEqual(['README.md']);
    expect(next.findings).toEqual(expect.arrayContaining([expect.objectContaining({
      taskId: 'implement-ui', correctionTaskId: correction.id,
      evidence: expect.objectContaining({ origin: 'human_review' })
    })]));
    const amended = runWithWorkspace(workspaceId, () => store!.listOrchestrationEvents(runId, 0, 500))
      .find(event => event.type === 'plan_amended');
    expect(amended?.payload).toMatchObject({ reviewRequest: { request: 'The empty state in README.md needs a clearer heading.', requestedBy: 'reviewer-person' } });

    visited.length = 0;
    next = await drive(next);
    // Like final-check corrections, the already accepted delivery-readiness task is not repeated;
    // publication re-checks the newest validated commit instead.
    expect(visited).toEqual([correction.id, `review-${next.run.planVersion}`, `validation-${next.run.planVersion}`]);
    expect(next.run.status).toBe('validating');
    expect(next.run.repositoryWorkspaces?.[0].branchName).toBe(branchBefore);
    expect(next.findings.every(finding => finding.status === 'resolved')).toBe(true);
  });

  it('refuses a stale review, an empty request, and a build that is not waiting for review', async () => {
    const { orchestrator, snapshot, agents, workspaceId, runId } = await buildToReview();
    await expect(orchestrator.requestReviewChanges({
      workspaceId, runId, expectedRunRevision: snapshot.run.revision - 1, actorId: 'user', feedback: 'Change it.', eligibleAgents: agents
    })).rejects.toThrow(/changed since it was reviewed/);
    expect(() => buildHumanReviewAmendment(snapshot, '   ', agents)).toThrow(OrchestrationReviewPlanError);
    expect(() => buildHumanReviewAmendment({ ...snapshot, run: { ...snapshot.run, status: 'executing' } }, 'Change it.', agents))
      .toThrow(/waiting for final review/);
    const unchanged = runWithWorkspace(workspaceId, () => store!.getOrchestrationSnapshot(runId))!;
    expect(unchanged.run.status).toBe('awaiting_approval');
    expect(unchanged.run.planVersion).toBe(snapshot.run.planVersion);
  });

  it('needs a reviewer other than every correction owner', async () => {
    const { snapshot } = await buildToReview();
    const onlyOwner = [{ id: 'frontend', role: 'Frontend Agent' as const }];
    expect(() => buildHumanReviewAmendment(
      { ...snapshot, tasks: snapshot.tasks.map(task => task.kind === 'review' ? { ...task, ownerAgentId: 'frontend' } : task) },
      'Change README.md.', onlyOwner
    )).toThrow(/Requested changes require an available reviewer/);
  });
});

