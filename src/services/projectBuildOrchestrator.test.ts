import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

const selectedRepo = 'acme/shop-fe';
const repositoryList = [selectedRepo, 'acme/shop-be'];
const project = { id: 'project-1', name: 'Calculator', leadSquadId: 'squad-1', resources: [] };
const agents = [
  { id: 'agent-1', name: 'Planner', role: 'Research Agent', modelProvider: 'OpenAI', modelName: 'test-model', isArchived: false },
  { id: 'agent-2', name: 'Frontend Builder', role: 'Frontend Agent', modelProvider: 'OpenAI', modelName: 'test-model', isArchived: false }
];
const steps = [
  { id: 'step-1', position: 1, enabled: true, label: 'Plan acceptance criteria', phase: 'requirements', agentId: 'agent-1' },
  { id: 'step-2', position: 2, enabled: true, label: 'Build calculator interface', phase: 'implementation', agentId: 'agent-2' }
];

let checkoutDir: string;
let issueRows: any[];
let squadRuns: any[];
let createdIssue: ReturnType<typeof vi.fn>;
let startSquadRun: ReturnType<typeof vi.fn>;
let plannerCreatePlan: ReturnType<typeof vi.fn>;
let startOrchestration: ReturnType<typeof vi.fn>;
let reservePlanning: ReturnType<typeof vi.fn>;
let releasePlanning: ReturnType<typeof vi.fn>;
let removeWorktree: ReturnType<typeof vi.fn>;
let recordPlanningRecovery: ReturnType<typeof vi.fn>;
let previousOrchestrationFlag: string | undefined;

async function load(orchestrationEnabled = false, staleReservation?: any) {
  checkoutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-project-build-'));
  if (typeof staleReservation === 'function') staleReservation = staleReservation(checkoutDir);
  previousOrchestrationFlag = process.env.ALPHA_ORCHESTRATION_ENABLED;
  if (orchestrationEnabled) process.env.ALPHA_ORCHESTRATION_ENABLED = '1';
  else delete process.env.ALPHA_ORCHESTRATION_ENABLED;
  issueRows = [];
  squadRuns = [];
  createdIssue = vi.fn(async (_workspaceId: string, input: any) => {
    const issueNumber = issueRows.length + 1;
    const issue = {
      ...input,
      identifier: `CALC-${issueNumber}`,
      createdAt: '2026-10-18T00:00:00.000Z'
    };
    issueRows.push(issue);
    return issue;
  });
  startSquadRun = vi.fn(async (input: any) => {
    const runNumber = squadRuns.length + 1;
    const run = {
      id: `squad-run-${runNumber}`,
      squadId: input.squadId,
      issueId: input.issueId,
      projectId: project.id,
      branchName: `build/CALC-${runNumber}`,
      memberAgentIds: input.memberAgentIds,
      currentMemberIndex: 0,
      status: 'running',
      mission: input.mission,
      plan: input.plan,
      createdAt: '2026-10-18T00:00:00.000Z',
      updatedAt: '2026-10-18T00:00:00.000Z'
    };
    squadRuns.push(run);
    return run;
  });
  const plan = {
    schemaVersion: 1,
    goal: 'Build a calculator interface.',
    exclusions: [],
    requirements: [{ id: 'REQ-1', description: 'The calculator interface supports keyboard input.' }],
    tasks: [
      {
        id: 'requirements-task', buildStepId: 'step-1', title: 'Confirm requirements',
        description: 'Record the keyboard interaction contract.', kind: 'requirements', ownerAgentId: 'agent-1',
        dependsOn: [], requirementIds: ['REQ-1'], acceptanceCriteria: ['The interaction contract is explicit.'],
        requiredChecks: [], scope: { includePaths: [], excludePaths: [] }, required: true
      },
      {
        id: 'frontend-task', buildStepId: 'step-2', title: 'Implement the calculator interface',
        description: 'Implement the interface for the approved interaction contract.', kind: 'frontend', ownerAgentId: 'agent-2',
        dependsOn: ['requirements-task'], requirementIds: ['REQ-1'], acceptanceCriteria: ['Keyboard input is supported.'],
        requiredChecks: ['test'], scope: { includePaths: ['src'], excludePaths: [] }, required: true
      }
    ]
  };
  plannerCreatePlan = vi.fn(async () => ({ plan, planSource: 'model', planHash: 'plan-hash', formatRepairCount: 0 }));
  startOrchestration = vi.fn(async (input: any) => ({
    run: {
      id: input.runId ?? 'orchestration-planned', workspaceId: input.workspaceId, projectId: input.projectId,
      issueId: input.issueId, repository: input.repository, requestKey: input.requestKey,
      requestFingerprint: input.requestFingerprint, createdBy: input.createdBy,
      executorId: input.executorId, ownershipEpoch: 1, workflowVersion: 1, planVersion: 1,
      plan, status: 'executing', revision: 1, currentTaskId: 'requirements-task',
      branchName: input.branchName, baseRef: input.baseRef, baseCommit: input.baseCommit,
      worktreePath: input.worktreePath, createdAt: '2026-10-18T00:00:00.000Z', updatedAt: '2026-10-18T00:00:00.000Z'
    },
    tasks: [{ id: 'requirements-task', title: 'Confirm requirements', ownerAgentId: 'agent-1' }],
    attempts: [], artifacts: [], findings: []
  }));
  reservePlanning = vi.fn((input: any) => ({
    ...input,
    repositoryKey: selectedRepo,
    createdAt: '2026-10-18T00:00:00.000Z',
    created: true
  }));
  releasePlanning = vi.fn(() => true);
  recordPlanningRecovery = vi.fn((input: any) => ({
    runId: input.reservation.runId, repository: input.reservation.repository,
    branchName: input.reservation.branchName, baseCommit: input.reservation.baseCommit,
    state: input.state, reason: input.reason, revision: 0,
    createdAt: input.reservation.createdAt, updatedAt: input.reservation.createdAt
  }));
  removeWorktree = vi.fn(async (_repositoryDir: string, worktreePath: string) => {
    fs.rmSync(worktreePath, { recursive: true, force: true });
  });
  const activeWorkflow = vi.fn();
  if (staleReservation) {
    activeWorkflow.mockReturnValueOnce({
      runId: staleReservation.runId, repository: staleReservation.repository, status: 'planning'
    }).mockReturnValue(undefined);
  } else {
    activeWorkflow.mockReturnValue(undefined);
  }

  vi.resetModules();
  vi.doMock('../store/stores.js', () => ({
    projectStore: () => ({
      get: vi.fn(async () => project),
      getBuildSteps: vi.fn(async () => steps)
    }),
    issueStore: () => ({
      list: vi.fn(async () => issueRows),
      create: createdIssue
    }),
    squadStore: () => ({ list: vi.fn(async () => [{ id: 'squad-1', name: 'Product Squad', topology: 'Sequential', memberAgentIds: ['agent-1', 'agent-2'] }]) })
  }));
  vi.doMock('../utils/gitUtils.js', () => ({
    isGitRepo: vi.fn(async () => true),
    getCurrentBranch: vi.fn(async () => staleReservation?.branchName ?? 'main'),
    getHeadCommit: vi.fn(async () => 'a'.repeat(40)),
    isGitWorkingTreeClean: vi.fn(async (directory: string) => directory !== staleReservation?.worktreePath || staleReservation?.clean !== false),
    addBranchWorktree: vi.fn(async (_repositoryDir: string, worktreePath: string) => fs.mkdirSync(worktreePath, { recursive: true })),
    removeDetachedWorktree: removeWorktree
  }));
  vi.doMock('./workspaceService.js', () => ({
    resolveProjectWorkspace: vi.fn(() => ({ dir: checkoutDir, repo: selectedRepo, owner: 'acme' })),
    allowAttachedWorkspace: vi.fn(),
    projectRunWorkspacePath: vi.fn((projectId: string, runId: string) => path.join(checkoutDir, '_runs', projectId, runId))
  }));
  vi.doMock('./projectBindings.js', () => ({ cloneAndBindProject: vi.fn() }));
  vi.doMock('../services/workspaceContext.js', () => ({ runWithWorkspace: (_workspaceId: string, operation: () => unknown) => operation() }));
  vi.doMock('./workspaceRegistry.js', () => ({
    workspaceRegistry: {
      can: () => true,
      canAccessProject: () => true,
      canAccessSquad: () => true,
      listSquadProjectAssignments: vi.fn(async () => [{ squadId: 'squad-1', status: 'active' }]),
      bind: vi.fn()
    }
  }));
  vi.doMock('./squadRunner.js', () => ({
    isSupportedTopology: () => true,
    orderedMembers: (squad: any) => squad.memberAgentIds,
    squadRunner: { startSquadRun }
  }));
  vi.doMock('../services/agentReadiness.js', () => ({ agentReadiness: () => ({ status: 'ready', detail: 'Ready' }) }));
  vi.doMock('./personaService.js', () => ({
    resolveAgent: (agent: any) => ({
      id: agent.id, name: agent.name, role: agent.role, modelProvider: 'OpenAI', modelName: 'test-model',
      reasoningEffort: 'medium', systemPrompt: `You are the ${agent.role}.`
    })
  }));
  vi.doMock('./orchestrationPlanner.js', () => ({
    OrchestrationPlanner: class { createPlan(input: any) { return plannerCreatePlan(input); } },
    OrchestrationPlanningError: class extends Error {}
  }));
  vi.doMock('./orchestrationRuntime.js', () => ({ orchestrationService: { start: startOrchestration } }));
  vi.doMock('../services/githubIssueMapping.js', () => ({ reposForProject: () => repositoryList }));
  vi.doMock('./sqliteService.js', () => ({
    sqliteService: {
      getAgents: () => agents,
      getRuntimes: () => [],
      getSquadRuns: () => squadRuns,
      getRunsForSquadRun: () => [],
      getIssues: () => issueRows,
      getActiveOrchestrationForProject: activeWorkflow,
      getOrchestrationByRequestKey: () => undefined,
      getOrchestrationPlanningReservation: () => staleReservation,
      getOrchestrationPlanningReservationByRun: () => staleReservation ? { ...staleReservation, repositoryKey: selectedRepo } : undefined,
      recordOrchestrationPlanningRecovery: recordPlanningRecovery,
      getActiveAgentCallProjectLock: () => undefined,
      reserveOrchestrationPlanning: reservePlanning,
      releaseOrchestrationPlanningReservation: releasePlanning,
      getProjectOrchestrationSetting: () => ({ enabled: orchestrationEnabled })
    }
  }));
  vi.doMock('./boardWriteThrough.js', () => ({ addCommentAndShare: vi.fn() }));
  vi.doMock('./supabaseService.js', () => ({ supabaseService: { shareIssue: vi.fn(async () => {}) } }));

  return await import('./projectBuildOrchestrator.js');
}

afterEach(() => {
  if (checkoutDir) fs.rmSync(checkoutDir, { recursive: true, force: true });
  for (const mod of [
    '../store/stores.js', '../utils/gitUtils.js', './workspaceService.js', './projectBindings.js',
    '../services/workspaceContext.js', './workspaceRegistry.js', './squadRunner.js',
    '../services/agentReadiness.js', '../services/githubIssueMapping.js', './sqliteService.js',
    './boardWriteThrough.js', './supabaseService.js', './personaService.js',
    './orchestrationPlanner.js', './orchestrationRuntime.js'
  ]) vi.doUnmock(mod);
  if (previousOrchestrationFlag === undefined) delete process.env.ALPHA_ORCHESTRATION_ENABLED;
  else process.env.ALPHA_ORCHESTRATION_ENABLED = previousOrchestrationFlag;
  vi.resetModules();
});

describe('project builds triggered from chat', () => {
  it('targets the selected repository, starts the configured agents in order, and deduplicates retries', async () => {
    const service = await load();
    const input = {
      context: { workspaceId: 'workspace-1', userId: 'user-1', role: 'pm' } as any,
      projectId: project.id,
      threadId: 'thread-1',
      messageId: `message-${crypto.randomUUID()}`,
      content: 'Build a calculator with keyboard support.',
      requestedRepository: selectedRepo
    };

    const first = await service.startProjectBuild(input);
    const retry = await service.startProjectBuild(input);

    expect(first).toMatchObject({ status: 'started', repository: selectedRepo, issueIdentifier: 'CALC-1', branchName: 'build/CALC-1' });
    expect(retry).toMatchObject({ status: 'in_progress', repository: selectedRepo, issueIdentifier: 'CALC-1' });
    expect(issueRows).toHaveLength(1);
    expect(issueRows[0]).toMatchObject({ projectId: project.id, githubRepo: selectedRepo, createdBy: 'user-1' });
    expect(issueRows[0].description).toContain('Complete your assigned build stage in the project repository');
    expect(startSquadRun).toHaveBeenCalledTimes(1);
    expect(startSquadRun).toHaveBeenCalledWith(expect.objectContaining({
      squadId: 'squad-1',
      issueId: issueRows[0].id,
      baseWorkspaceDir: checkoutDir,
      memberAgentIds: ['agent-1', 'agent-2'],
      memberAssignments: [
        expect.objectContaining({
          agentId: 'agent-1',
          stageLabel: 'Plan acceptance criteria',
          phase: 'requirements',
          instructions: expect.stringContaining('Do not begin implementation')
        }),
        expect.objectContaining({
          agentId: 'agent-2',
          stageLabel: 'Build calculator interface',
          phase: 'implementation',
          instructions: expect.stringContaining('Implement only the feature slice')
        })
      ]
    }));
    const squadCall = startSquadRun.mock.calls[0][0];
    expect(squadCall.plan.join('\n')).not.toContain('Implement the complete project change');
    expect(squadCall.plan.join('\n')).not.toContain('final agent must run');
  });

  it('starts and deduplicates separate sequential builds for every selected repository', async () => {
    const service = await load();
    const input = {
      context: { workspaceId: 'workspace-1', userId: 'user-1', role: 'pm' } as any,
      projectId: project.id,
      threadId: 'thread-1',
      messageId: `message-${crypto.randomUUID()}`,
      content: 'Build a full stack calculator.',
      repositories: [selectedRepo, 'acme/shop-be']
    };

    const first = await service.startProjectBuildBatch(input);
    const retry = await service.startProjectBuildBatch(input);

    expect(first).toMatchObject([
      { status: 'started', repository: selectedRepo, issueIdentifier: 'CALC-1', branchName: 'build/CALC-1' },
      { status: 'started', repository: 'acme/shop-be', issueIdentifier: 'CALC-2', branchName: 'build/CALC-2' }
    ]);
    expect(retry).toMatchObject([
      { status: 'in_progress', repository: selectedRepo, issueIdentifier: 'CALC-1' },
      { status: 'in_progress', repository: 'acme/shop-be', issueIdentifier: 'CALC-2' }
    ]);
    expect(issueRows).toHaveLength(2);
    expect(issueRows.map(issue => issue.githubRepo)).toEqual([selectedRepo, 'acme/shop-be']);
    expect(startSquadRun).toHaveBeenCalledTimes(2);
  });

  it('does not guess a single repository when a multi-repo build has no selection', async () => {
    const service = await load();
    const result = await service.startProjectBuild({
      context: { workspaceId: 'workspace-1', userId: 'user-1', role: 'pm' } as any,
      projectId: project.id,
      threadId: 'thread-1',
      messageId: `message-${crypto.randomUUID()}`,
      content: 'Build a full stack calculator.'
    });

    expect(result).toMatchObject({ status: 'blocked', reason: 'Choose one or more repositories to build: acme/shop-fe, acme/shop-be.' });
    expect(createdIssue).not.toHaveBeenCalled();
    expect(startSquadRun).not.toHaveBeenCalled();
  });

  it('does not split an opted-in task plan across multiple repositories', async () => {
    const service = await load(true);
    const result = await service.startProjectBuildBatch({
      context: { workspaceId: 'workspace-1', userId: 'user-1', role: 'pm' } as any,
      projectId: project.id,
      threadId: 'thread-1',
      messageId: `message-${crypto.randomUUID()}`,
      content: 'Build a full stack calculator.',
      repositories: [selectedRepo, 'acme/shop-be']
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      status: 'blocked',
      reason: 'Task-based builds support one repository per plan. Choose a single repository; this request was not split into unrelated workflows.'
    });
    expect(createdIssue).not.toHaveBeenCalled();
    expect(startSquadRun).not.toHaveBeenCalled();
  });

  it('routes an opted-in single-repository chat build through the planner and task orchestrator', async () => {
    const service = await load(true);
    const input = {
      context: { workspaceId: 'workspace-1', userId: 'user-1', role: 'pm' } as any,
      projectId: project.id,
      threadId: 'thread-1',
      messageId: `message-${crypto.randomUUID()}`,
      content: 'Build a calculator with keyboard support.',
      requestedRepository: selectedRepo
    };

    const result = await service.startProjectBuild(input);

    expect(result).toMatchObject({
      status: 'started', repository: selectedRepo, issueIdentifier: 'CALC-1',
      orchestrationRunId: expect.any(String), orchestrationCurrentTask: {
        id: 'requirements-task', ownerAgentId: 'agent-1'
      }
    });
    expect(reservePlanning).toHaveBeenCalledWith(expect.objectContaining({
      projectId: project.id, repository: selectedRepo, ownerSessionId: expect.any(String)
    }));
    expect(plannerCreatePlan).toHaveBeenCalledWith(expect.objectContaining({
      goal: 'Build a calculator with keyboard support.',
      planner: expect.objectContaining({ id: 'agent-1', role: 'Research Agent' }),
      eligibleAgents: [
        { id: 'agent-1', role: 'Research Agent', ready: true },
        { id: 'agent-2', role: 'Frontend Agent', ready: true }
      ]
    }));
    expect(startOrchestration).toHaveBeenCalledWith(expect.objectContaining({
      projectId: project.id, repository: selectedRepo, planSource: 'model',
      planningOwnerSessionId: expect.any(String), plan: expect.objectContaining({ tasks: expect.any(Array) })
    }));
    expect(startSquadRun).not.toHaveBeenCalled();
  });

  it('reconciles a clean planning reservation from a stopped daemon before starting a new build', async () => {
    let reservation: any;
    const service = await load(true, (root: string) => {
      reservation = {
        runId: 'orchestration-old', repository: selectedRepo, requestKey: 'old-request',
        requestFingerprint: 'old-fingerprint', branchName: 'alpha/orchestration/old',
        baseCommit: 'a'.repeat(40), worktreePath: path.join(root, '_runs', project.id, 'orchestration-old'),
        ownerSessionId: 'old-session', createdAt: '2026-10-17T00:00:00.000Z'
      };
      fs.mkdirSync(reservation.worktreePath, { recursive: true });
      return reservation;
    });
    const input = {
      context: { workspaceId: 'workspace-1', userId: 'user-1', role: 'pm' } as any,
      projectId: project.id,
      threadId: 'thread-1',
      messageId: `message-${crypto.randomUUID()}`,
      content: 'Build a calculator with keyboard support.',
      requestedRepository: selectedRepo
    };

    const result = await service.startProjectBuild(input);

    expect(result.status).toBe('started');
    expect(removeWorktree).toHaveBeenCalledWith(checkoutDir, reservation.worktreePath);
    expect(fs.existsSync(reservation.worktreePath)).toBe(false);
    expect(releasePlanning).toHaveBeenCalledWith('old-request', 'old-fingerprint', 'old-session');
    expect(reservePlanning).toHaveBeenCalledTimes(1);
    expect(startOrchestration).toHaveBeenCalledTimes(1);
  });

  it('persists a reviewable recovery instead of removing a changed stale planning worktree', async () => {
    let reservation: any;
    const service = await load(true, (root: string) => {
      reservation = {
        runId: 'orchestration-old', repository: selectedRepo, requestKey: 'old-request',
        requestFingerprint: 'old-fingerprint', branchName: 'alpha/orchestration/old',
        baseCommit: 'a'.repeat(40), worktreePath: path.join(root, '_runs', project.id, 'orchestration-old'),
        ownerSessionId: 'old-session', createdAt: '2026-10-17T00:00:00.000Z', clean: false
      };
      fs.mkdirSync(reservation.worktreePath, { recursive: true });
      return reservation;
    });
    const result = await service.startProjectBuild({
      context: { workspaceId: 'workspace-1', userId: 'user-1', role: 'pm' } as any,
      projectId: project.id, threadId: 'thread-1', messageId: `message-${crypto.randomUUID()}`,
      content: 'Build a calculator with keyboard support.', requestedRepository: selectedRepo
    });

    expect(result.status).toBe('blocked');
    expect(result.reason).toContain('preserved it and paused this repository');
    expect(fs.existsSync(reservation.worktreePath)).toBe(true);
    expect(removeWorktree).not.toHaveBeenCalled();
    expect(recordPlanningRecovery).toHaveBeenCalledWith(expect.objectContaining({
      projectId: project.id, state: 'needs_review', reservation: expect.objectContaining({ runId: reservation.runId })
    }));
    expect(reservePlanning).not.toHaveBeenCalled();
  });
});
