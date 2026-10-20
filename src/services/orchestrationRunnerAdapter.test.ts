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
import type { OrchestrationAttemptRecord } from './orchestrationStateMachine.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' }).toString().trim();

describe('orchestration runner adapter', () => {
  let root = '';
  let source = '';
  let worktree = '';
  let adapter: OrchestrationRunnerAdapter;
  let startRun: ReturnType<typeof vi.fn>;
  let bindAttempt: ReturnType<typeof vi.fn>;
  let baseCommit: string | undefined;
  let attempts: OrchestrationAttemptRecord[];
  let tasks: Array<{ id: string; repository?: string }>;
  let agent: Agent;
  let request: OrchestrationLaunchRequest;

  const acceptedAttempt = (taskId: string, resultCommit: string): OrchestrationAttemptRecord => ({
    id: `attempt-${taskId}`, runId: 'orchestration-run-123', taskId, attemptNumber: 1,
    agentId: 'backend-agent', status: 'accepted', resultCommit, contextManifest: {},
    createdAt: new Date().toISOString()
  });

  const commitChange = (message: string) => {
    fs.appendFileSync(path.join(worktree, 'README.md'), `${message}\n`);
    git(worktree, 'add', '-A');
    git(worktree, 'commit', '-m', message);
    return git(worktree, 'rev-parse', 'HEAD');
  };

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
    agent = {
      id: 'backend-agent', name: 'Backend Specialist', role: 'Backend Agent', modelProvider: 'OpenAI', modelName: 'gpt-test'
    } as Agent;
    baseCommit = undefined;
    attempts = [];
    tasks = [{ id: 'create-endpoint', repository: 'example/tasks' }];
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
          baseCommit,
          worktreePath: worktree
        }]
      }, attempts, tasks }),
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
    const taskPackage: OrchestrationTaskPackage = {
      packageVersion: 3,
      goal: 'Create and complete tasks.',
      projectContext: '',
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
    request = {
      runId: 'orchestration-run-123', workspaceId: 'workspace-test', projectId: 'project-1', issueId: 'issue-1',
      repository: 'example/tasks', planVersion: 1, taskId: 'create-endpoint', taskTitle: 'Create endpoint',
      taskDescription: 'Implement task creation.', taskKind: 'backend', ownerAgentId: 'backend-agent',
      attemptId: 'attempt-1', attemptNumber: 1, taskPackage, contextManifest: { manifestVersion: 1 }
    };
  });

  afterEach(async () => {
    if (fs.existsSync(worktree)) await removeDetachedWorktree(source, worktree);
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = '';
  });

  it('prepares a role-matched shared task branch and binds the real runner to one task package', async () => {
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
        branchName: prepared.branchName, taskPackage: request.taskPackage
      })
    }));
  });

  it.each([
    ['review', 'Security / Code Quality Agent'],
    ['validation', 'Validation / Checking Agent']
  ] as const)('starts a new %s task from the latest accepted repository checkpoint', async (kind, role) => {
    await adapter.prepare(request);
    baseCommit = git(source, 'rev-parse', 'HEAD');
    const firstCommit = commitChange('implementation');
    const latestCommit = commitChange('accepted correction');
    tasks.push({ id: 'correction', repository: 'https://github.com/Example/Tasks.git' });
    attempts.push(acceptedAttempt('create-endpoint', firstCommit), acceptedAttempt('correction', latestCommit));
    agent.role = role;

    const prepared = await adapter.prepare({ ...request, taskId: kind, taskKind: kind });

    expect(prepared.startingCommit).toBe(latestCommit);
    expect(prepared.contextManifest).toMatchObject({ baseCommit, startingCommit: latestCommit });
    expect(await isGitWorkingTreeClean(worktree)).toBe(true);
  });

  it('still rejects unexpected commits before the first build task', async () => {
    await adapter.prepare(request);
    baseCommit = git(source, 'rev-parse', 'HEAD');
    commitChange('unexpected change');

    await expect(adapter.prepare(request)).rejects.toThrow('planning worktree no longer matches its recorded base commit');
  });

  it('rejects a clean worktree that drifted beyond the accepted checkpoint', async () => {
    await adapter.prepare(request);
    baseCommit = git(source, 'rev-parse', 'HEAD');
    attempts.push(acceptedAttempt('create-endpoint', commitChange('accepted implementation')));
    commitChange('unexpected change');

    await expect(adapter.prepare(request)).rejects.toThrow('handoff worktree no longer matches its latest accepted checkpoint');
  });

  it('ignores newer checkpoints from another repository and unaccepted attempts', async () => {
    await adapter.prepare(request);
    baseCommit = git(source, 'rev-parse', 'HEAD');
    const acceptedCommit = commitChange('accepted implementation');
    tasks.push({ id: 'other-repository', repository: 'example/other' });
    attempts.push(
      acceptedAttempt('create-endpoint', acceptedCommit),
      acceptedAttempt('other-repository', 'a'.repeat(40)),
      { ...acceptedAttempt('create-endpoint', 'b'.repeat(40)), status: 'rejected' }
    );

    expect((await adapter.prepare(request)).startingCommit).toBe(acceptedCommit);
  });

  it('uses the planning base when only another repository has accepted work', async () => {
    await adapter.prepare(request);
    baseCommit = git(source, 'rev-parse', 'HEAD');
    tasks.push({ id: 'other-repository', repository: 'example/other' });
    attempts.push(acceptedAttempt('other-repository', 'a'.repeat(40)));

    expect((await adapter.prepare(request)).startingCommit).toBe(baseCommit);
    commitChange('unexpected change');
    await expect(adapter.prepare(request)).rejects.toThrow('planning worktree no longer matches its recorded base commit');
  });

  it('retains dirty-worktree and wrong-branch protection after acceptance', async () => {
    await adapter.prepare(request);
    baseCommit = git(source, 'rev-parse', 'HEAD');
    attempts.push(acceptedAttempt('create-endpoint', commitChange('accepted implementation')));
    fs.writeFileSync(path.join(worktree, 'uncheckpointed.txt'), 'pending work');

    await expect(adapter.prepare(request)).rejects.toThrow('uncheckpointed changes');
    git(worktree, 'add', '-A');
    git(worktree, 'commit', '-m', 'preserve pending work');
    git(worktree, 'checkout', '-b', 'unexpected-branch');
    await expect(adapter.prepare(request)).rejects.toThrow('expected alpha/orchestration/');
  });

  it('preserves checkpointed work for a failed task retry', async () => {
    await adapter.prepare(request);
    baseCommit = git(source, 'rev-parse', 'HEAD');
    const retryCommit = commitChange('preserved failed attempt');
    attempts.push({ ...acceptedAttempt('create-endpoint', retryCommit), status: 'rejected' });

    expect((await adapter.prepare({ ...request, attemptNumber: 2 })).startingCommit).toBe(retryCommit);
  });
});
