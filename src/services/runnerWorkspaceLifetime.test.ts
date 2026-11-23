import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpawnOptions } from './processManager.js';

/** Actual RunnerService + actual WorkspaceQueue; only external effects and data
 * are test doubles. No CLI, Git, provider, cloud or live user data is contacted.
 */
let tmp: string;
let dirtyWorktree = false;
let runner: import('./runnerService.js').RunnerService;
let queue: import('./workspaceQueue.js').WorkspaceQueue;
let rows: Map<string, any>;
let issues: any[];
let projects: any[];
let processes: { options: SpawnOptions; child: EventEmitter; exited: boolean }[];
let stopWaiters: Map<string, () => void>;
let verify: ReturnType<typeof vi.fn>;
let createBranch: ReturnType<typeof vi.fn>;
let diff: ReturnType<typeof vi.fn>;
let spawn: ReturnType<typeof vi.fn>;
let squads: Map<string, any>;
let invocations: any[];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const passedVerification = () => ({ status: 'passed', commands: [], summary: 'Fixture checks passed.' });

beforeEach(async () => {
  dirtyWorktree = false;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-run-lifetime-'));
  vi.resetModules(); rows = new Map(); squads = new Map(); issues = []; projects = []; processes = []; stopWaiters = new Map();
  let time = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => ++time);
  invocations = [];
  const agent = {
    id: 'agent-fixture', name: 'Research Agent', role: 'Research Agent', description: 'Clarifies requirements.',
    systemPrompt: 'You are the Research Agent. Do not write implementation code.', avatar: '', autonomyLevel: 'supervised'
  };
  const secondAgent = {
    id: 'agent-second', name: 'Frontend Agent', role: 'Frontend Agent', description: 'Builds user interfaces.',
    systemPrompt: 'You are the Frontend Agent. Implement assigned UI work only.', avatar: '', autonomyLevel: 'supervised'
  };
  const sql = {
    saveChatUsage: vi.fn(),
    isPathAllowed: () => true, addAllowedPath: vi.fn(),
    getPrototypeRuns: () => [...rows.values()].map(value => structuredClone(value)),
    savePrototypeRun: (value: any) => rows.set(value.id, structuredClone(value)),
    getIssues: () => issues.map(value => structuredClone(value)), getProjects: () => projects,
    getAgents: () => [agent, secondAgent], getRuntimes: () => [], recordRemoteAction: vi.fn(),
    getSquads: () => [{ id: 'squad-fixture', name: 'Fixture squad', topology: 'Sequential', memberAgentIds: ['agent-fixture', 'agent-second'] }],
    getSquadRun: (id: string) => structuredClone(squads.get(id)),
    saveSquadRun: (value: any) => squads.set(value.id, structuredClone(value)),
    getRunsForSquadRun: (id: string) => [...rows.values()].filter(value => value.squadRunId === id).map(value => structuredClone(value)),
    updateIssue: (id: string, changes: any) => Object.assign(issues.find(issue => issue.id === id), changes),
  };
  spawn = vi.fn((options: SpawnOptions) => {
    const child = new EventEmitter();
    processes.push({ options, child, exited: false });
    return child;
  });
  verify = vi.fn(async () => passedVerification());
  createBranch = vi.fn(async () => undefined);
  diff = vi.fn(async () => ({ changedFiles: 0, insertions: 0, deletions: 0 }));
  vi.doMock('./sqliteService.js', () => ({ sqliteService: sql }));
  vi.doMock('./workspaceRegistry.js', () => ({ workspaceRegistry: { bind: vi.fn() } }));
  vi.doMock('./processManager.js', () => ({ processManager: { spawnProcess: spawn,
    killProcess: vi.fn(async () => undefined),
    terminateProcessAndWait: vi.fn(async (runId: string) => {
      if (!processes.some(process => process.options.runId === runId && !process.exited)) return;
      await new Promise<void>(resolve => stopWaiters.set(runId, resolve));
    }),
    isRunActive: (runId: string) => processes.some(process => process.options.runId === runId && !process.exited) } }));
  vi.doMock('./supabaseService.js', () => ({ supabaseService: {
    isConfigured: () => false,
    workspaceMcpRuntime: vi.fn(async () => null),
    sharesBoard: () => false
  } }));
  vi.doMock('./boardWriteThrough.js', () => ({ addCommentAndShare: vi.fn(),
    updateIssueAndPush: (id: string, changes: any) => Object.assign(issues.find(issue => issue.id === id), changes) }));
  vi.doMock('./workspaceService.js', () => ({ resolveProjectWorkspace: (project: any) => ({ dir: project.cwd }), allowAttachedWorkspace: vi.fn() }));
  vi.doMock('../utils/gitUtils.js', () => ({ createBranch, createBranchFrom: createBranch, checkoutBranch: createBranch,
    getCurrentBranch: async () => 'alpha/orchestration/fixture', isGitWorkingTreeClean: async () => !dirtyWorktree,
    getHeadCommit: async () => 'a'.repeat(40),
    remoteHasDevBranch: async () => false, getGitDiffStats: diff, isGitRepo: async () => true }));
  vi.doMock('./githubService.js', () => ({ githubService: {} }));
  vi.doMock('./verificationService.js', () => ({
    runVerification: verify,
    shouldRunRepositoryVerification: (kind?: string, checks: readonly string[] = []) =>
      checks.length > 0 || !['requirements', 'architecture', 'audit', 'review', 'delivery'].includes(kind ?? '')
  }));
  vi.doMock('./agentReadiness.js', () => ({ agentReadiness: () => ({ status: 'ready' }) }));
  vi.doMock('./personaService.js', () => ({
    resolveAgent: (input: any) => ({ systemPrompt: input.systemPrompt || '' }),
    resolveAgentLogged: (input: any) => ({ name: input.name, role: input.role, personaHash: 'fixture-hash', autonomyLevel: 'supervised',
    modelProvider: 'Anthropic', modelName: 'fixture-model', systemPrompt: input.systemPrompt, mcpServers: [] }) }));
  vi.doMock('./cliRunner.js', () => ({ writeTurnPersona: () => undefined, buildTurnInvocation: (options: any) => {
    invocations.push(options);
    return { bin: 'test-only-not-spawned', args: [], family: 'claude', env: {} };
  } }));
  vi.doMock('./mcpConfigService.js', () => ({ writeRunMcpConfig: () => ({ serverNames: [] }), cleanupRunMcpConfig: vi.fn(), hostingScopeFor: () => undefined }));
  vi.doMock('./orchestrationWorktreeRecovery.js', () => ({ worktreeChangesHash: async () => 'verified-snapshot' }));
  vi.doMock('./customCliArgs.js', () => ({ buildEnv: () => ({ env: {} }), reportIgnoredProjectEnv: vi.fn() }));
  vi.doMock('./gitCredentialIsolation.js', () => ({ agentCredentialEnv: () => ({}) }));
  vi.doMock('../config/env.js', async () => ({ ...await vi.importActual('../config/env.js'), RUNS_DIR: path.join(tmp, 'runs') }));
  runner = (await import('./runnerService.js')).runnerService;
  queue = (await import('./workspaceQueue.js')).workspaceQueue;
});

afterEach(async () => {
  // Drain only test doubles before removing this fixture's temporary folder.
  createBranch.mockResolvedValue(undefined); verify.mockResolvedValue(passedVerification()); diff.mockResolvedValue({ changedFiles: 0, insertions: 0, deletions: 0 });
  await vi.waitFor(async () => {
    for (let index = 0; index < processes.length; index++) if (!processes[index].exited) await exit(index, 1);
    expect(queue.activeKeys()).toEqual([]);
  });
  vi.restoreAllMocks(); fs.rmSync(tmp, { recursive: true, force: true });
});

function work(id: string, checkout = 'shared-checkout') {
  const cwd = path.join(tmp, checkout); fs.mkdirSync(cwd, { recursive: true });
  projects.push({ id: `project-${id}`, name: id, key: 'FIX', cwd });
  issues.push({ id, projectId: `project-${id}`, identifier: `FIX-${id}`, title: id, description: 'Fixture work.', status: 'todo' });
  return { cwd, start: () => runner.startRun({ issueId: id, agentId: 'agent-fixture', plan: [] }) };
}
async function exit(index: number, code = 0, reason?: Parameters<NonNullable<SpawnOptions['onExit']>>[2]) {
  const process = processes[index]; process.exited = true;
  await process.options.onExit?.(code, reason ? 'SIGTERM' : null, reason);
  stopWaiters.get(process.options.runId)?.();
  stopWaiters.delete(process.options.runId);
}

describe('RunnerService workspace ownership lifetime', () => {
  it.each([
    ['clean', false, undefined, true],
    ['retained candidate', true, 'verified-snapshot', true],
    ['candidate removed after preparation', false, 'stale-snapshot', false],
    ['candidate changed after preparation', true, 'stale-snapshot', false]
  ] as const)('checks %s work and keeps native tools disabled', async (_label, dirty, resumedWorktreeHash, allowed) => {
    dirtyWorktree = dirty;
    const fixture = work('scoped');
    fs.writeFileSync(path.join(fixture.cwd, 'package.json'), JSON.stringify({ packageManager: 'pnpm@9.0.0', scripts: { test: 'vitest run' } }));
    await runner.startRun({ issueId: 'scoped', agentId: 'agent-fixture', plan: [], workingDir: fixture.cwd,
      orchestration: { orchestrationRunId: 'workflow-1', taskId: 'brief', attemptId: 'attempt-1',
        resumedWorktreeHash,
        branchName: 'alpha/orchestration/fixture', planVersion: 1, personaHash: 'fixture-hash', modelProvider: 'Anthropic', modelName: 'fixture-model',
        taskPackage: { packageVersion: 6, reportSchemaVersion: 1, goal: 'Clarify requirements', projectContext: '', exclusions: [],
          task: { id: 'brief', title: 'Requirements brief', kind: 'requirements', repository: 'test/repo', description: 'Clarify observable behavior.',
            acceptanceCriteria: ['Cites behavior'], requiredChecks: [], scope: { includePaths: [], excludePaths: [] } },
          requirements: [{ id: 'REQ-1', description: 'Explain behavior' }], acceptedDependencies: [], reviewInputs: [], corrections: [], findingIds: [] } as any } });
    if (!allowed) {
      await vi.waitFor(() => expect([...rows.values()][0]?.status).toBe('failed'));
      expect(processes).toHaveLength(0);
      return;
    }
    await vi.waitFor(() => expect(invocations).toHaveLength(1));
    expect(invocations[0]).toMatchObject({ mode: 'chat', approvalMode: 'ask', skills: [],
      projectRoots: [{ name: 'repo', repo: 'test/repo', dir: fixture.cwd }] });
    expect(processes[0].options.cwd).not.toBe(fixture.cwd);
    expect(processes[0].options.idleTimeoutMs).toBe(300_000);
    expect(path.basename(processes[0].options.cwd)).toBe('context');
    expect(invocations[0].systemPrompt).toContain('Native file tools and terminal commands are disabled');
    expect(invocations[0].systemPrompt).toContain('Alpha-managed Git workspace (verified by the runner before execution)');
    expect(invocations[0].systemPrompt).toContain('attempt starts at ' + 'a'.repeat(40));
    expect(invocations[0].prompt).toContain('Package manager: pnpm.');
    expect(invocations[0].prompt).toContain('test: pnpm run test');
    expect(invocations[0].prompt).toContain('Alpha manages website previews from accepted frontend checkpoints.');
    await exit(0, 1);
  });
  it('does not let a second run switch the checkout while the first agent is working', async () => {
    const a = work('a'); const b = work('b'); await a.start(); await b.start();
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    expect(createBranch).toHaveBeenCalledTimes(1); expect(queue.depth(a.cwd)).toBe(2);
    await exit(0); await vi.waitFor(() => expect(processes).toHaveLength(2));
    expect(createBranch).toHaveBeenCalledTimes(2); await exit(1);
  });
  it('holds the checkout through verification after the agent exits', async () => {
    const check = deferred<ReturnType<typeof passedVerification>>(); verify.mockReturnValueOnce(check.promise);
    const a = work('a'); await a.start(); await work('b').start();
    await vi.waitFor(() => expect(processes).toHaveLength(1)); const finishing = exit(0);
    await vi.waitFor(() => expect(verify).toHaveBeenCalledOnce());
    expect(processes).toHaveLength(1); expect(createBranch).toHaveBeenCalledTimes(1);
    check.resolve(passedVerification()); await finishing;
    await vi.waitFor(() => expect(processes).toHaveLength(2)); await exit(1);
  });
  it('holds the checkout through final diff/review preparation', async () => {
    const stats = deferred<{ changedFiles: number; insertions: number; deletions: number }>(); diff.mockReturnValueOnce(stats.promise);
    await work('a').start(); await work('b').start();
    await vi.waitFor(() => expect(processes).toHaveLength(1)); const finishing = exit(0);
    await vi.waitFor(() => expect(diff).toHaveBeenCalledOnce()); expect(processes).toHaveLength(1);
    stats.resolve({ changedFiles: 0, insertions: 0, deletions: 0 }); await finishing;
    await vi.waitFor(() => expect(processes).toHaveLength(2)); await exit(1);
  });
  it('still runs different checkouts concurrently', async () => {
    await work('a', 'checkout-a').start(); await work('b', 'checkout-b').start();
    await vi.waitFor(() => expect(processes).toHaveLength(2)); await Promise.all([exit(0), exit(1)]);
  });
  it('runs the same squad concurrently in different project workspaces with independent run state', async () => {
    work('project-a-issue', 'project-a-checkout');
    work('project-b-issue', 'project-b-checkout');
    const squadRunner = new (await import('./squadRunner.js')).SquadRunner();

    const [projectA, projectB] = await Promise.all([
      squadRunner.startSquadRun({ squadId: 'squad-fixture', issueId: 'project-a-issue' }),
      squadRunner.startSquadRun({ squadId: 'squad-fixture', issueId: 'project-b-issue' })
    ]);

    await vi.waitFor(() => expect(processes).toHaveLength(2));
    expect(projectA.id).not.toBe(projectB.id);
    expect(projectA.squadId).toBe(projectB.squadId);
    expect(new Set(processes.map(process => process.options.cwd)).size).toBe(2);
    expect(new Set([...rows.values()].map(run => run.squadRunId).filter(Boolean))).toEqual(new Set([projectA.id, projectB.id]));
    expect(squads.get(projectA.id).currentMemberIndex).toBe(0);
    expect(squads.get(projectB.id).currentMemberIndex).toBe(0);
  });
  it('releases the checkout after a failed process', async () => {
    const a = await work('a').start(); await work('b').start();
    await vi.waitFor(() => expect(processes).toHaveLength(1)); await exit(0, 1);
    expect(rows.get(a.id).status).toBe('failed'); await vi.waitFor(() => expect(processes).toHaveLength(2)); await exit(1);
  });
  it('releases the checkout after a failed spawn with no process', async () => {
    spawn.mockImplementationOnce(() => { throw new Error('Executable missing'); });
    const a = await work('a').start(); await work('b').start();
    await vi.waitFor(() => expect(rows.get(a.id).status).toBe('failed'));
    await vi.waitFor(() => expect(processes).toHaveLength(1)); await exit(0);
  });
  it('releases on asynchronous spawn failure reported by ProcessManager', async () => {
    const a = await work('a').start(); await work('b').start();
    await vi.waitFor(() => expect(processes).toHaveLength(1)); await exit(0, 1, 'spawn_error');
    expect(rows.get(a.id).testSummary).toContain('could not be started');
    await vi.waitFor(() => expect(processes).toHaveLength(2)); await exit(1);
  });
  it('releases on finalization failure without an unhandled exit callback', async () => {
    verify.mockRejectedValueOnce(new Error('Verification infrastructure unavailable'));
    const a = await work('a').start(); await work('b').start();
    await vi.waitFor(() => expect(processes).toHaveLength(1)); await exit(0);
    await vi.waitFor(() => expect(rows.get(a.id).status).toBe('failed'));
    await vi.waitFor(() => expect(processes).toHaveLength(2)); await exit(1);
  });
  it('does not release on cancellation until the active child actually exits', async () => {
    const a = await work('a').start(); await work('b').start();
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    const stopping = runner.cancelRun(a.id);
    await vi.waitFor(() => expect(stopWaiters.has(a.id)).toBe(true));
    expect(processes).toHaveLength(1); await exit(0, 1, 'cancelled'); await stopping;
    await vi.waitFor(() => expect(processes).toHaveLength(2)); expect(rows.get(a.id).status).toBe('cancelled'); await exit(1);
  });
  it('stops a sequential squad without starting its next member', async () => {
    work('squad-cancel-issue');
    const squadRunner = new (await import('./squadRunner.js')).SquadRunner();
    const squadRun = await squadRunner.startSquadRun({ squadId: 'squad-fixture', issueId: 'squad-cancel-issue' });

    await vi.waitFor(() => expect(processes).toHaveLength(1));
    const stopping = squadRunner.cancelSquadRun(squadRun.id);
    await vi.waitFor(() => expect(stopWaiters.has(processes[0].options.runId)).toBe(true));
    await exit(0, 1, 'cancelled');
    const stopped = await stopping;

    expect(stopped).toMatchObject({ status: 'cancelled', stoppedReason: 'Build stopped by the user.' });
    expect(squads.get(squadRun.id).status).toBe('cancelled');
    expect([...rows.values()].filter(value => value.squadRunId === squadRun.id).map(value => value.status))
      .toEqual(['cancelled']);
    expect(processes).toHaveLength(1);
  });
  it('skips a queued cancelled run without spawning it', async () => {
    await work('a').start(); const b = await work('b').start();
    await vi.waitFor(() => expect(processes).toHaveLength(1)); await runner.cancelRun(b.id); await exit(0);
    await vi.waitFor(() => expect(queue.activeKeys()).toEqual([])); expect(processes).toHaveLength(1);
    expect(rows.get(b.id).status).toBe('cancelled');
  });
  it('rechecks cancellation after asynchronous branch preparation, before spawn', async () => {
    const prepared = deferred<void>(); createBranch.mockReturnValueOnce(prepared.promise);
    const a = await work('a').start(); await vi.waitFor(() => expect(createBranch).toHaveBeenCalledOnce());
    const stopping = runner.cancelRun(a.id);
    await new Promise(resolve => setTimeout(resolve, 0)); prepared.resolve(); await stopping;
    await vi.waitFor(() => expect(queue.activeKeys()).toEqual([])); expect(processes).toHaveLength(0);
  });
  it('does not publish a successful review after work failed during verification', async () => {
    const check = deferred<ReturnType<typeof passedVerification>>(); verify.mockReturnValueOnce(check.promise);
    const a = await work('a').start(); await vi.waitFor(() => expect(processes).toHaveLength(1));
    const finishing = exit(0); await vi.waitFor(() => expect(verify).toHaveBeenCalledOnce());
    rows.set(a.id, { ...rows.get(a.id), status: 'failed' });
    check.resolve(passedVerification()); await finishing;
    expect(rows.get(a.id).status).toBe('failed'); expect(diff).not.toHaveBeenCalled();
  });
  it('lets a real sequential squad enqueue its next member without a queue deadlock', async () => {
    work('squad-issue');
    const squadRunner = new (await import('./squadRunner.js')).SquadRunner();
    const squadRun = await squadRunner.startSquadRun({ squadId: 'squad-fixture', issueId: 'squad-issue' });
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    expect(invocations[0].systemPrompt).toContain('You are the Research Agent. Do not write implementation code.');
    expect(invocations[0].systemPrompt).toContain('Assigned stage: Requirements and research');
    expect(invocations[0].prompt).toContain('Your assigned stage: Requirements and research (requirements)');
    expect(invocations[0].prompt).not.toContain('Your assigned work:\nImplement only the user-facing interface');
    const firstRun = [...rows.values()].find(value => value.squadRunId === squadRun.id);
    rows.set(firstRun.id, {
      ...firstRun,
      activities: [{ id: 'handoff-note', sequence: 1, kind: 'assistant', isStreaming: false,
        message: 'The request needs a display, keyboard input, and chained arithmetic. Acceptance criteria are ready for implementation.' }]
    });
    await exit(0);
    await vi.waitFor(() => expect(processes).toHaveLength(2));
    expect(invocations[1].systemPrompt).toContain('You are the Frontend Agent. Implement assigned UI work only.');
    expect(invocations[1].systemPrompt).toContain('Assigned stage: Frontend implementation');
    expect(invocations[1].prompt).toContain('Your assigned stage: Frontend implementation (implementation)');
    expect(invocations[1].prompt).toContain('Acceptance criteria are ready for implementation.');
    expect(invocations[0].prompt).not.toBe(invocations[1].prompt);
    expect(squads.get(squadRun.id).currentMemberIndex).toBe(1);
    expect(issues.find(value => value.id === 'squad-issue').status).toBe('agent_running');
    await exit(1);
    await vi.waitFor(() => expect(squads.get(squadRun.id).status).toBe('awaiting_approval'));
    expect(issues.find(value => value.id === 'squad-issue').status).toBe('review');
  });
});
