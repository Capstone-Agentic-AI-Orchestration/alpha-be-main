import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, Project, PrototypeRun } from '../models/index.js';
import { addBranchWorktree, getHeadCommit, getCurrentBranch, isGitWorkingTreeClean, removeDetachedWorktree } from '../utils/gitUtils.js';
import type { SQLiteService } from './sqliteService.js';
import { OrchestrationRunnerAdapter } from './orchestrationRunnerAdapter.js';
import type { OrchestrationLaunchRequest, OrchestrationTaskPackage } from './orchestrationService.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' }).toString().trim();

describe('orchestration runner adapter', () => {
  let root = '';
  let source = '';
  let worktree = '';
  let adapter: OrchestrationRunnerAdapter;
  let startRun: ReturnType<typeof vi.fn>;
  let bindAttempt: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(process.cwd(), '.tmp-orchestration-adapter-'));
    source = path.join(root, 'source');
    worktree = path.join(root, 'runs', 'orchestration-run-123');
    fs.mkdirSync(source, { recursive: true });
    git(source, 'init', '--initial-branch', 'main');
    fs.writeFileSync(path.join(source, 'README.md'), 'base\n');
    git(source, 'add', '-A');
    git(source, 'commit', '-m', 'base');

    const issue = { id: 'issue-1', projectId: 'project-1', githubRepo: 'example/tasks' };
    const project = { id: 'project-1', key: 'tasks', name: 'Tasks' } as Project;
    const agent = {
      id: 'backend-agent', name: 'Backend Specialist', role: 'Backend Agent', modelProvider: 'OpenAI', modelName: 'gpt-test'
    } as Agent;
    const fakeStore = {
      getIssues: () => [issue],
      getProjects: () => [project],
      getAgents: () => [agent],
      getRuntimes: () => [],
      getOrchestrationSnapshot: (runId: string) => ({ run: {
        id: runId,
        repository: 'example/tasks',
        repositoryWorkspaces: [{
          repository: 'example/tasks',
          branchName: 'alpha/orchestration/orchestrationrun123',
          baseRef: 'HEAD',
          worktreePath: worktree
        }]
      } }),
      isPathAllowed: (candidate: string) => path.resolve(candidate).startsWith(path.resolve(root)),
      bindOrchestrationAttempt: bindAttempt = vi.fn()
    } as unknown as SQLiteService;
    const runner = Object.assign(new EventEmitter(), {
      startRun: startRun = vi.fn(async () => ({ id: 'run-attempt-1' } as PrototypeRun))
    });
    adapter = new OrchestrationRunnerAdapter({
      store: fakeStore,
      runner,
      resolveWorkspace: () => ({ dir: source, managed: true, repo: 'example/tasks' }),
      allowWorkspace: vi.fn(),
      worktreePathFor: () => worktree,
      resolvePersona: () => ({
        name: agent.name,
        role: agent.role,
        modelProvider: agent.modelProvider,
        modelName: agent.modelName,
        personaHash: 'persona-v1',
        systemPrompt: 'Backend persona',
        autonomyLevel: 'Supervised',
        skills: [], mcpServers: [], sources: []
      }),
      readinessFor: () => ({ status: 'ready', detail: 'Ready.' })
    });
  });

  afterEach(async () => {
    if (fs.existsSync(worktree)) await removeDetachedWorktree(source, worktree);
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = '';
  });

  it('prepares a role-matched shared task branch and binds the real runner to one task package', async () => {
    const taskPackage: OrchestrationTaskPackage = {
      packageVersion: 2,
      goal: 'Create and complete tasks.',
      exclusions: ['No authentication.'],
      task: {
        id: 'create-endpoint', title: 'Create endpoint', kind: 'backend', repository: 'example/tasks',
        description: 'Implement task creation.', acceptanceCriteria: ['Persists after reload.'], requiredChecks: ['test'],
        scope: { includePaths: ['src/services/**'], excludePaths: ['src/services/secrets/**'] }
      },
      requirements: [{ id: 'REQ-1', description: 'Users can create tasks.' }],
      acceptedDependencies: [],
      reviewInputs: [],
      corrections: [], findingIds: []
    };
    const request: OrchestrationLaunchRequest = {
      runId: 'orchestration-run-123', workspaceId: 'workspace-test', projectId: 'project-1', issueId: 'issue-1',
      repository: 'example/tasks', planVersion: 1, taskId: 'create-endpoint', taskTitle: 'Create endpoint',
      taskDescription: 'Implement task creation.', taskKind: 'backend', ownerAgentId: 'backend-agent',
      attemptId: 'attempt-1', attemptNumber: 1, taskPackage, contextManifest: { manifestVersion: 1 }
    };
    const prepared = await adapter.prepare(request);

    expect(prepared).toMatchObject({
      branchName: 'alpha/orchestration/orchestrationrun123',
      personaHash: 'persona-v1', modelProvider: 'OpenAI', modelName: 'gpt-test'
    });
    expect(prepared.startingCommit).toBe(await getHeadCommit(worktree));
    expect(await getCurrentBranch(worktree)).toBe(prepared.branchName);
    expect(await isGitWorkingTreeClean(worktree)).toBe(true);

    await adapter.launch({ ...request, ...prepared });

    expect(bindAttempt).toHaveBeenCalledWith(expect.objectContaining({
      runId: request.runId, attemptId: request.attemptId, prototypeRunId: 'run-attempt-1'
    }));
    expect(startRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-attempt-1', issueId: request.issueId, agentId: 'backend-agent',
      workingDir: worktree,
      orchestration: expect.objectContaining({
        orchestrationRunId: request.runId, taskId: 'create-endpoint', attemptId: 'attempt-1',
        branchName: prepared.branchName, taskPackage
      })
    }));
  });
});
