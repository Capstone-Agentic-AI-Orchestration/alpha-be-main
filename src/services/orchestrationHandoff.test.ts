import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent, Issue, Project, PrototypeRun } from '../models/index.js';
import { addBranchWorktree, removeDetachedWorktree } from '../utils/gitUtils.js';
import { parseOrchestrationPlan, type OrchestrationTaskKind } from './orchestrationContract.js';
import { buildOrchestrationReviewAmendment, type OrchestrationReviewFinding } from './orchestrationReviewWorkflow.js';
import { OrchestrationRunnerAdapter, orchestrationBranchName } from './orchestrationRunnerAdapter.js';
import { OrchestrationService } from './orchestrationService.js';
import { SQLiteService } from './sqliteService.js';
import type { StartRunParams } from './runnerService.js';
import { runWithWorkspace } from './workspaceContext.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', [
  '-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args
], { cwd, stdio: 'pipe' }).toString().trim();

describe('persisted specialist handoffs with real Git worktrees', () => {
  let root = '';
  let store: SQLiteService | undefined;
  let worktrees: Array<{ source: string; worktreePath: string }> = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    store?.close();
    store = undefined;
    for (const workspace of worktrees) await removeDetachedWorktree(workspace.source, workspace.worktreePath);
    worktrees = [];
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = '';
  });

  it.each(['single repository', 'multiple repositories', 'review correction', 'blocked handoff retry'] as const)(
    'dispatches the complete workflow for %s without resetting the planning base', async scenario => {
      root = fs.mkdtempSync(path.join(process.cwd(), '.tmp-orchestration-handoff-'));
      store = new SQLiteService({ dbPath: path.join(root, 'alpha.db'), seedDefaults: false });
      store.addAllowedPath(root, 'handoff integration fixture');
      const runId = 'orchestration-handoff-test';
      const workspaceId = 'workspace-handoff';
      const branchName = orchestrationBranchName(runId);
      const repositories = scenario === 'multiple repositories' ? ['example/ui', 'example/api'] : ['example/ui'];
      const repositoryWorkspaces = [];
      for (const [index, repository] of repositories.entries()) {
        const source = path.join(root, `source-${index}`);
        fs.mkdirSync(source);
        git(source, 'init', '--initial-branch', 'main');
        fs.writeFileSync(path.join(source, 'README.md'), `${repository}\n`);
        git(source, 'add', '-A');
        git(source, 'commit', '-m', 'planning base');
        const baseCommit = git(source, 'rev-parse', 'HEAD');
        const worktreePath = path.join(root, `worktree-${index}`);
        await addBranchWorktree(source, worktreePath, branchName, baseCommit);
        worktrees.push({ source, worktreePath });
        repositoryWorkspaces.push({ repository, branchName, baseRef: baseCommit, baseCommit, worktreePath });
      }
      const agents = [
        { id: 'frontend', role: 'Frontend Agent' },
        { id: 'backend', role: 'Backend Agent' },
        { id: 'reviewer', role: 'Security / Code Quality Agent' },
        { id: 'validator', role: 'Validation / Checking Agent' },
        { id: 'delivery', role: 'GitHub Finalization Agent' }
      ].map(agent => ({ ...agent, name: agent.id, modelProvider: 'OpenAI', modelName: 'test' } as Agent));
      vi.spyOn(store, 'getAgents').mockReturnValue(agents);
      vi.spyOn(store, 'getProjects').mockReturnValue([{ id: 'project', key: 'TEST', name: 'Test project' } as Project]);
      vi.spyOn(store, 'getIssues').mockReturnValue([{ id: 'issue', projectId: 'project', githubRepo: repositories[0] } as Issue]);
      const startRun = vi.fn(async (_params: StartRunParams) => ({ id: 'unused-receipt' } as PrototypeRun));
      const adapter = new OrchestrationRunnerAdapter({
        store,
        runner: Object.assign(new EventEmitter(), { startRun }),
        resolveWorkspace: (_project, repository) => ({
          dir: worktrees[repositories.indexOf(repository)].source, managed: true, repo: repository
        }),
        allowWorkspace: vi.fn(),
        readinessFor: () => ({ status: 'ready', detail: 'Test runtime ready.' }),
        resolvePersona: agent => ({
          name: agent.name, role: agent.role, modelProvider: agent.modelProvider, modelName: agent.modelName,
          personaHash: 'test-persona', systemPrompt: 'Test persona', autonomyLevel: 'Supervised',
          skills: [], mcpServers: [], sources: []
        })
      });
      const orchestrator = new OrchestrationService(store, adapter);
      const task = (id: string, kind: OrchestrationTaskKind, ownerAgentId: string, repository: string, dependsOn: string[]) => ({
        id, kind, ownerAgentId, repository, dependsOn, title: id, description: `Complete ${id}.`,
        requirementIds: ['REQ-1'], acceptanceCriteria: [`${id} is verified.`],
        scope: { includePaths: ['README.md'], excludePaths: [] }
      });
      const plan = parseOrchestrationPlan({
        schemaVersion: 1, goal: 'Deliver a verified product.',
        requirements: [{ id: 'REQ-1', description: 'The product works.' }],
        tasks: [
          ...(repositories.length > 1 ? [task('implement-api', 'backend', 'backend', repositories[1], [])] : []),
          task('implement-ui', 'frontend', 'frontend', repositories[0], repositories.length > 1 ? ['implement-api'] : []),
          task('review', 'review', 'reviewer', repositories[0], ['implement-ui']),
          task('validate', 'validation', 'validator', repositories[0], ['review']),
          task('deliver', 'delivery', 'delivery', repositories[0], ['validate'])
        ]
      });
      let snapshot = await orchestrator.start({
        runId, workspaceId, projectId: 'project', issueId: 'issue', repository: repositories[0],
        repositoryWorkspaces, eligibleAgents: agents, plan, createdBy: 'user', executorId: 'test',
        requestKey: 'request', requestFingerprint: 'fingerprint'
      });
      snapshot = await orchestrator.startPlannedWork({ workspaceId, runId, expectedRevision: snapshot.run.revision, actorId: 'user' });
      const visited: OrchestrationTaskKind[] = [];
      const latestCommits = new Map(repositoryWorkspaces.map(workspace => [workspace.repository, workspace.baseCommit]));
      let correctionCreated = false;
      for (let step = 0; step < 10 && snapshot.run.currentTaskId; step++) {
        expect(snapshot.run.status).toBe('executing');
        const current = snapshot.tasks.find(item => item.id === snapshot.run.currentTaskId)!;
        const attempt = snapshot.attempts.find(item => item.taskId === current.id && item.status === 'running')!;
        expect(attempt).toBeDefined();
        const workspace = repositoryWorkspaces.find(item => item.repository === current.repository)!;
        expect(attempt.startingCommit).toBe(latestCommits.get(workspace.repository));
        visited.push(current.kind);
        const launched = startRun.mock.calls.at(-1)![0];
        expect(launched.orchestration?.taskId).toBe(current.id);
        if (current.kind === 'review') {
          expect(launched.orchestration?.taskPackage.reviewInputs.length).toBeGreaterThan(0);
        }
        if (current.kind === 'frontend' || current.kind === 'backend') {
          fs.appendFileSync(path.join(workspace.worktreePath, 'README.md'), `${current.id}\n`);
          git(workspace.worktreePath, 'add', '-A');
          git(workspace.worktreePath, 'commit', '-m', current.id);
        }
        const resultCommit = git(workspace.worktreePath, 'rev-parse', 'HEAD');
        const reviewFindings: OrchestrationReviewFinding[] = scenario === 'review correction' && current.kind === 'review' && !correctionCreated ? [{
          targetTaskId: 'implement-ui', severity: 'blocking', title: 'Correct the UI', requirementId: 'REQ-1',
          path: 'README.md', evidence: 'An acceptance criterion needs correction.', instruction: 'Correct it and review again.'
        }] : [];
        snapshot = await orchestrator.submitResult({
          workspaceId, runId, taskId: current.id, attemptId: attempt.id, expectedTaskRevision: current.revision,
          result: { summary: `${current.id} completed.`, agentReport: { reviewFindings } }, resultCommit
        });
        const acceptance = {
          workspaceId, runId, taskId: current.id, attemptId: attempt.id,
          expectedTaskRevision: snapshot.tasks.find(item => item.id === current.id)!.revision,
          acceptedBy: 'orchestrator', evidence: { fixture: 'passed' }
        };
        if (current.kind === 'review') {
          const amendment = buildOrchestrationReviewAmendment(snapshot, snapshot.tasks.find(item => item.id === current.id)!, reviewFindings, agents);
          snapshot = await orchestrator.acceptReviewOutcome({
            ...acceptance, expectedPlanVersion: snapshot.run.planVersion, amendment
          });
          correctionCreated = true;
        } else {
          const retryBlockedHandoff = scenario === 'blocked handoff retry' && current.kind === 'frontend';
          snapshot = await orchestrator.acceptAttempt({ ...acceptance, dispatchNext: !retryBlockedHandoff });
          if (retryBlockedHandoff) {
            const reviewer = snapshot.tasks.find(item => item.id === 'review')!;
            expect(reviewer.attemptCount).toBe(0);
            snapshot = runWithWorkspace(workspaceId, () => {
              const blocked = store!.transitionOrchestrationTask({
                runId, taskId: reviewer.id, expectedRevision: reviewer.revision, nextStatus: 'blocked',
                reason: 'The planning worktree no longer matches its recorded base commit.'
              });
              return store!.transitionOrchestrationRun({
                runId, expectedRevision: blocked.run.revision, nextStatus: 'blocked',
                reason: 'The planning worktree no longer matches its recorded base commit.'
              });
            });
            snapshot = await orchestrator.retryTask({
              workspaceId, runId, taskId: reviewer.id, actorId: 'user',
              expectedTaskRevision: snapshot.tasks.find(item => item.id === reviewer.id)!.revision
            });
            expect(snapshot.run.currentTaskId).toBe('review');
            expect(snapshot.tasks.find(item => item.id === 'review')?.attemptCount).toBe(1);
          }
        }
        latestCommits.set(workspace.repository, resultCommit);
        expect(snapshot.run.stoppedReason).toBeUndefined();
      }
      expect(snapshot.run.status).toBe('validating');
      expect(visited).toEqual([
        ...(repositories.length > 1 ? ['backend'] : []), 'frontend', 'review',
        ...(scenario === 'review correction' ? ['frontend', 'review'] : []), 'validation', 'delivery'
      ]);
      expect(snapshot.run.repositoryWorkspaces).toEqual(repositoryWorkspaces);
      expect(snapshot.findings.every(finding => finding.status === 'resolved')).toBe(true);
      expect(startRun).toHaveBeenCalledTimes(visited.length);
    }
  );
});
