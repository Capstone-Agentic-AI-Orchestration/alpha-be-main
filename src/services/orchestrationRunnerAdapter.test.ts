import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
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
  let reserveTicket: ReturnType<typeof vi.fn>;
  let stopTicket: ReturnType<typeof vi.fn>;
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
    reserveTicket = vi.fn(async () => null);
    stopTicket = vi.fn(async () => {});
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
      readinessFor: () => ({ status: 'ready', detail: 'Ready.' }),
      reserveTicketExecution: reserveTicket,
      stopTicketExecution: stopTicket,
    });
    const taskPackage: OrchestrationTaskPackage = {
      packageVersion: 6,
      reportSchemaVersion: 1,
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
    if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    root = '';
  });

  it('prepares a role-matched shared task branch and binds the real runner to one task package', async () => {
    const prepared = await adapter.prepare(request);

    expect(prepared).toMatchObject({
      branchName: 'alpha/orchestration/orchestrationrun123',
      personaHash: 'persona-v1', modelProvider: 'OpenAI', modelName: 'gpt-test'
    });
    expect(prepared.contextManifest).toMatchObject({ packageVersion: 6, reportSchemaVersion: 1 });
    expect(prepared.startingCommit).toBe(await getHeadCommit(worktree));
    expect(await getCurrentBranch(worktree)).toBe(prepared.branchName);
    expect(await isGitWorkingTreeClean(worktree)).toBe(true);

    baseCommit = prepared.startingCommit;
    await adapter.launch({ ...request, ...prepared });

    expect(bindAttempt).toHaveBeenCalledWith(expect.objectContaining({
      runId: request.runId, attemptId: request.attemptId, prototypeRunId: 'run-attempt-1'
    }));
    expect(startRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-attempt-1', issueId: request.issueId, agentId: 'backend-agent',
      workingDir: worktree,
      orchestration: expect.objectContaining({
        orchestrationRunId: request.runId, taskId: 'create-endpoint', attemptId: 'attempt-1',
        branchName: prepared.branchName, taskPackage: request.taskPackage,
        baseRef: expect.any(String), baseCommit: expect.stringMatching(/^[a-f0-9]{40}$/)
      })
    }));
  });

  it('passes a positively reserved ticket scope to the runner with the attempt run ID', async () => {
    const ticketExecution = {
      workspaceId: 'workspace-test', issueId: 'issue-1', projectId: 'project-1',
      issueRevisionId: 'issue-revision-1', scopeVersionId: 'ticket-scope-1',
      claimId: 'claim-1', runId: 'run-attempt-1', executor: { kind: 'agent', id: 'backend-agent' }, memberOrder: 0,
    };
    reserveTicket.mockResolvedValue(ticketExecution);
    const prepared = await adapter.prepare(request);
    await adapter.launch({ ...request, ...prepared });

    expect(reserveTicket).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: request.workspaceId, projectId: request.projectId, issueId: request.issueId,
      runId: 'run-attempt-1', executor: { kind: 'agent', id: 'backend-agent' },
    }));
    expect(startRun).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-attempt-1', ticketExecution }));
  });

  it('releases a ticket reservation if the local runner refuses to start', async () => {
    const ticketExecution = {
      workspaceId: 'workspace-test', issueId: 'issue-1', projectId: 'project-1',
      issueRevisionId: 'issue-revision-1', scopeVersionId: 'ticket-scope-1',
      claimId: 'claim-1', runId: 'run-attempt-1', executor: { kind: 'agent', id: 'backend-agent' }, memberOrder: 0,
    };
    reserveTicket.mockResolvedValue(ticketExecution);
    startRun.mockRejectedValue(new Error('runner unavailable'));
    const prepared = await adapter.prepare(request);

    await expect(adapter.launch({ ...request, ...prepared })).rejects.toThrow('runner unavailable');
    expect(stopTicket).toHaveBeenCalledWith(ticketExecution);
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

  it('saves a stopped attempt\'s leftovers aside, but never while a specialist is active, and keeps wrong-branch protection', async () => {
    await adapter.prepare(request);
    baseCommit = git(source, 'rev-parse', 'HEAD');
    attempts.push(acceptedAttempt('create-endpoint', commitChange('accepted implementation')));
    const previousHome = process.env.ALPHA_HOME;
    process.env.ALPHA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-preserved-'));
    try {
      // While a specialist is active the changes are its work in progress: never touch them.
      attempts.push({ ...acceptedAttempt('create-endpoint', ''), id: 'attempt-active', status: 'running' });
      fs.writeFileSync(path.join(worktree, 'uncheckpointed.txt'), 'pending work');
      await expect(adapter.prepare(request)).rejects.toThrow('uncheckpointed changes');
      attempts.pop();

      // With nothing active they are a stopped attempt's leftovers: saved, then cleared.
      const prepared = await adapter.prepare(request);
      expect(fs.existsSync(path.join(worktree, 'uncheckpointed.txt'))).toBe(false);
      const saved = prepared.contextManifest?.preservedLeftovers as { folder: string; movedPaths: string[] };
      expect(saved.movedPaths).toEqual(['uncheckpointed.txt']);
      expect(fs.readFileSync(path.join(saved.folder, 'untracked', 'uncheckpointed.txt'), 'utf8')).toBe('pending work');
    } finally {
      if (previousHome === undefined) delete process.env.ALPHA_HOME; else process.env.ALPHA_HOME = previousHome;
    }

    fs.writeFileSync(path.join(worktree, 'uncheckpointed.txt'), 'pending work');
    git(worktree, 'add', '-A');
    git(worktree, 'commit', '-m', 'preserve pending work');
    git(worktree, 'checkout', '-b', 'unexpected-branch');
    await expect(adapter.prepare(request)).rejects.toThrow('expected alpha/orchestration/');
  });

  it('backs up and retains unfinished edits only for the same failed task', async () => {
    await adapter.prepare(request);
    baseCommit = git(worktree, 'rev-parse', 'HEAD');
    attempts.push({ ...acceptedAttempt(request.taskId, ''), status: 'failed' });
    request.attemptNumber = 2;
    fs.writeFileSync(path.join(worktree, 'unfinished.ts'), 'export const pending = true;');
    const previousHome = process.env.ALPHA_HOME;
    process.env.ALPHA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-retained-'));
    try {
      const prepared = await adapter.prepare(request);
      expect(fs.readFileSync(path.join(worktree, 'unfinished.ts'), 'utf8')).toContain('pending');
      expect(prepared.startingCommit).toBe(baseCommit);
      expect(prepared.contextManifest?.resumedWorktreeHash).toMatch(/^[a-f0-9]{64}$/);
      const saved = prepared.contextManifest?.preservedLeftovers as { folder: string };
      expect(fs.readFileSync(path.join(saved.folder, 'untracked', 'unfinished.ts'), 'utf8')).toContain('pending');
      await adapter.launch({ ...request, workingDir: worktree, branchName: prepared.branchName, contextManifest: prepared.contextManifest! });
      expect(startRun.mock.calls[0][0].orchestration.resumedWorktreeHash).toBe(prepared.contextManifest?.resumedWorktreeHash);
    } finally {
      if (previousHome === undefined) delete process.env.ALPHA_HOME; else process.env.ALPHA_HOME = previousHome;
    }
  });

  it('preserves checkpointed work for a failed task retry', async () => {
    await adapter.prepare(request);
    baseCommit = git(source, 'rev-parse', 'HEAD');
    const retryCommit = commitChange('preserved failed attempt');
    attempts.push({ ...acceptedAttempt('create-endpoint', retryCommit), status: 'rejected' });

    expect((await adapter.prepare({ ...request, attemptNumber: 2 })).startingCommit).toBe(retryCommit);
  });

  it('stops a retry when the branch no longer matches the failed attempt checkpoint', async () => {
    await adapter.prepare(request);
    baseCommit = git(source, 'rev-parse', 'HEAD');
    const savedCommit = commitChange('preserved failed attempt');
    attempts.push({ ...acceptedAttempt('create-endpoint', savedCommit), status: 'failed' });
    commitChange('unexpected later commit');

    await expect(adapter.prepare({ ...request, attemptNumber: 2 }))
      .rejects.toThrow('retry worktree no longer matches its latest saved checkpoint');
  });
});
