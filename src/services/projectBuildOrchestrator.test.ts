import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

const selectedRepo = 'acme/shop-fe';
const repositoryList = [selectedRepo, 'acme/shop-be'];
const project = { id: 'project-1', name: 'Calculator', description: 'Keep the interface accessible.', leadName: 'Orchestrator', resources: [] };
const agents = [
  { id: 'agent-1', name: 'Planner', role: 'Research Agent', modelProvider: 'OpenAI', modelName: 'test-model', isArchived: false },
  { id: 'agent-2', name: 'Frontend Builder', role: 'Frontend Agent', modelProvider: 'OpenAI', modelName: 'test-model', isArchived: false },
  { id: 'agent-3', name: 'Backend Builder', role: 'Backend Agent', modelProvider: 'OpenAI', modelName: 'test-model', isArchived: false }
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

async function load(
  runtimeOrchestrationAvailable = true,
  staleReservation?: any,
  runtimeCatalog: any[] = [],
  plannerModel?: string,
  agentRoster: any[] = agents,
  projectDescription = project.description
) {
  checkoutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-project-build-'));
  const selectedProject = { ...project, description: projectDescription };
  if (typeof staleReservation === 'function') staleReservation = staleReservation(checkoutDir);
  previousOrchestrationFlag = process.env.ALPHA_ORCHESTRATION_ENABLED;
  if (runtimeOrchestrationAvailable) process.env.ALPHA_ORCHESTRATION_ENABLED = '1';
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
  plannerCreatePlan = vi.fn(async (input: any) => {
    const repositories = input.repositories ?? [{ repository: selectedRepo }];
    const plannedTasks: any[] = plan.tasks.map((task: any) => ({ ...task, repository: repositories[0].repository }));
    if (repositories.length > 1) plannedTasks.push({
      id: 'backend-task', title: 'Build the calculator service', description: 'Provide the API used by the calculator interface.',
      kind: 'backend', ownerAgentId: 'agent-3', repository: repositories[1].repository,
      dependsOn: ['requirements-task'], requirementIds: ['REQ-1'], acceptanceCriteria: ['The interface can load and save calculations.'],
      requiredChecks: ['test'], scope: { includePaths: ['src/**'], excludePaths: [] }, required: true
    });
    return { plan: { ...plan, tasks: plannedTasks }, planSource: 'model', planHash: 'plan-hash', formatRepairCount: 0 };
  });
  startOrchestration = vi.fn(async (input: any) => ({
    run: {
      id: input.runId ?? 'orchestration-planned', workspaceId: input.workspaceId, projectId: input.projectId,
      issueId: input.issueId, repository: input.repository, requestKey: input.requestKey,
      requestFingerprint: input.requestFingerprint, createdBy: input.createdBy,
      executorId: input.executorId, ownershipEpoch: 1, workflowVersion: 1, planVersion: 1,
      plan: input.plan, status: 'awaiting_plan_approval', revision: 1,
      branchName: input.branchName, baseRef: input.baseRef, baseCommit: input.baseCommit,
      worktreePath: input.worktreePath, repositoryWorkspaces: input.repositoryWorkspaces,
      createdAt: '2026-10-18T00:00:00.000Z', updatedAt: '2026-10-18T00:00:00.000Z'
    },
    tasks: input.plan.tasks.map((task: any) => ({ id: task.id, title: task.title, ownerAgentId: task.ownerAgentId, repository: task.repository })),
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
      get: vi.fn(async () => selectedProject),
      getBuildSteps: vi.fn(async () => steps)
    }),
    issueStore: () => ({
      list: vi.fn(async () => issueRows),
      create: createdIssue
    }),
    squadStore: () => ({ list: vi.fn(async () => []) })
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
      canAccessProjectAgentRun: vi.fn(async () => true),
      listSquadProjectAssignments: vi.fn(async () => []),
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
      id: agent.id, name: agent.name, role: agent.role, modelProvider: 'OpenAI', modelName: plannerModel ?? agent.modelName ?? '',
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
      getAgents: () => agentRoster,
      getRuntimes: () => runtimeCatalog,
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
      // Simulate a row written by an older build that had orchestration off.
      getProjectOrchestrationSetting: () => ({ enabled: false })
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
  it('routes project builds through the Orchestrator without a squad despite an old disabled setting', async () => {
    const service = await load();
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
      status: 'plan_ready', repository: selectedRepo, issueIdentifier: 'CALC-1',
      orchestrationRunId: expect.any(String), orchestrationCurrentTask: undefined
    });
    expect(issueRows).toHaveLength(1);
    expect(issueRows[0]).toMatchObject({ projectId: project.id, githubRepo: selectedRepo, createdBy: 'user-1' });
    expect(issueRows[0].assignedSquadId).toBeUndefined();
    expect(startOrchestration).toHaveBeenCalledTimes(1);
    expect(startOrchestration).toHaveBeenCalledWith(expect.objectContaining({
      projectId: project.id, repository: selectedRepo, planSource: 'model',
      planningOwnerSessionId: expect.any(String), plan: expect.objectContaining({ tasks: expect.any(Array) })
    }));
    expect(startSquadRun).not.toHaveBeenCalled();
  });

  it('creates one shared Orchestrator plan for frontend and backend repositories', async () => {
    const service = await load();
    const input = {
      context: { workspaceId: 'workspace-1', userId: 'user-1', role: 'pm' } as any,
      projectId: project.id,
      threadId: 'thread-1',
      messageId: `message-${crypto.randomUUID()}`,
      content: 'Build a full stack calculator.',
      repositories: [selectedRepo, 'acme/shop-be']
    };

    const result = await service.startProjectBuildBatch(input);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ status: 'plan_ready', repositories: repositoryList, orchestrationRunId: expect.any(String) });
    expect(createdIssue).toHaveBeenCalledTimes(1);
    expect(startOrchestration).toHaveBeenCalledTimes(1);
    expect(startOrchestration.mock.calls[0][0].repositoryWorkspaces.map((item: any) => item.repository)).toEqual(repositoryList);
    expect(startOrchestration.mock.calls[0][0].plan.tasks.map((task: any) => task.repository)).toEqual(expect.arrayContaining(repositoryList));
    expect(startOrchestration.mock.calls[0][0].plan.tasks.find((task: any) => task.id === 'backend-task')).toMatchObject({ repository: 'acme/shop-be', ownerAgentId: 'agent-3' });
    expect(startSquadRun).not.toHaveBeenCalled();
  });

  it('selects every attached repository when the user starts a product build without narrowing the list', async () => {
    const service = await load();
    const result = await service.startProjectBuild({
      context: { workspaceId: 'workspace-1', userId: 'user-1', role: 'pm' } as any,
      projectId: project.id,
      threadId: 'thread-1',
      messageId: `message-${crypto.randomUUID()}`,
      content: 'Build a full stack calculator.'
    });

    expect(result).toMatchObject({ status: 'plan_ready', repositories: repositoryList });
    expect(createdIssue).toHaveBeenCalledTimes(1);
    expect(startOrchestration.mock.calls[0][0].repositoryWorkspaces.map((item: any) => item.repository)).toEqual(repositoryList);
    expect(startSquadRun).not.toHaveBeenCalled();
  });

  it('does not fall back to the legacy squad runner if the desktop orchestrator is unavailable', async () => {
    const service = await load(false);
    const result = await service.startProjectBuild({
      context: { workspaceId: 'workspace-1', userId: 'user-1', role: 'pm' } as any,
      projectId: project.id,
      threadId: 'thread-1',
      messageId: `message-${crypto.randomUUID()}`,
      content: 'Build a calculator with keyboard support.',
      requestedRepository: selectedRepo
    });

    expect(result).toMatchObject({ status: 'blocked', reason: expect.stringContaining('Orchestrator is unavailable') });
    expect(createdIssue).not.toHaveBeenCalled();
    expect(startOrchestration).not.toHaveBeenCalled();
    expect(startSquadRun).not.toHaveBeenCalled();
  });

  it('routes a selected single-repository request through the planner and task orchestrator', async () => {
    const service = await load();
    const result = await service.startProjectBuildBatch({
      context: { workspaceId: 'workspace-1', userId: 'user-1', role: 'pm' } as any,
      projectId: project.id,
      threadId: 'thread-1',
      messageId: `message-${crypto.randomUUID()}`,
      content: 'Build a full stack calculator.',
      repositories: [selectedRepo]
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ status: 'plan_ready', repository: selectedRepo, orchestrationRunId: expect.any(String) });
    expect(reservePlanning).toHaveBeenCalledWith(expect.objectContaining({
      projectId: project.id, repository: selectedRepo, ownerSessionId: expect.any(String)
    }));
    expect(plannerCreatePlan).toHaveBeenCalledWith(expect.objectContaining({
      goal: 'Build a full stack calculator.',
      projectContext: 'Keep the interface accessible.',
      planner: expect.objectContaining({ id: 'agent-1', role: 'Research Agent' }),
      eligibleAgents: [
        { id: 'agent-1', role: 'Research Agent', ready: true },
        { id: 'agent-2', role: 'Frontend Agent', ready: true },
        { id: 'agent-3', role: 'Backend Agent', ready: true }
      ]
    }));
    expect(startOrchestration).toHaveBeenCalledTimes(1);
    expect(startSquadRun).not.toHaveBeenCalled();
  });

  it('uses a live runtime model when the planning agent intentionally has no pinned model', async () => {
    const service = await load(true, undefined, [{ id: 'codex', provider: 'OpenAI', status: 'online', models: ['gpt-default'] }], '');
    const result = await service.startProjectBuild({
      context: { workspaceId: 'workspace-1', userId: 'user-1', role: 'pm' } as any,
      projectId: project.id,
      threadId: 'thread-1',
      messageId: `message-${crypto.randomUUID()}`,
      content: 'Build a full stack calculator.',
      requestedRepository: selectedRepo
    });

    expect(result.status).toBe('plan_ready');
    expect(plannerCreatePlan).toHaveBeenCalledWith(expect.objectContaining({
      planner: expect.objectContaining({ modelName: 'gpt-default' }),
      projectContext: 'Keep the interface accessible.'
    }));
  });

  it('falls back to another planning-capable project agent when the Orchestrator has no usable model', async () => {
    const roster = [
      { ...agents[0], role: 'Orchestrator Agent', modelName: '' },
      agents[1],
      { ...agents[2], role: 'Architecture Agent', modelName: 'architecture-model' }
    ];
    const service = await load(true, undefined, [], undefined, roster);
    const result = await service.startProjectBuild({
      context: { workspaceId: 'workspace-1', userId: 'user-1', role: 'pm' } as any,
      projectId: project.id, threadId: 'thread-1', messageId: `message-${crypto.randomUUID()}`,
      content: 'Build a full stack calculator.', requestedRepository: selectedRepo
    });

    expect(result.status).toBe('plan_ready');
    expect(plannerCreatePlan).toHaveBeenCalledWith(expect.objectContaining({
      planner: expect.objectContaining({ id: 'agent-3', role: 'Architecture Agent', modelName: 'architecture-model' })
    }));
  });

  it('explains missing planner models before creating a task or reserving a workspace', async () => {
    const roster = agents.map(agent => ({ ...agent, modelName: '' }));
    const service = await load(true, undefined, [], undefined, roster);
    const result = await service.startProjectBuild({
      context: { workspaceId: 'workspace-1', userId: 'user-1', role: 'pm' } as any,
      projectId: project.id, threadId: 'thread-1', messageId: `message-${crypto.randomUUID()}`,
      content: 'Build a full stack calculator.', requestedRepository: selectedRepo
    });

    expect(result).toMatchObject({ status: 'blocked', reason: expect.stringContaining('No model is available') });
    expect(reservePlanning).not.toHaveBeenCalled();
    expect(createdIssue).not.toHaveBeenCalled();
    expect(plannerCreatePlan).not.toHaveBeenCalled();
  });

  it('rejects oversized ground rules before making a plan or reserving a workspace', async () => {
    const service = await load(true, undefined, [], undefined, agents, 'x'.repeat(8_001));
    const result = await service.startProjectBuild({
      context: { workspaceId: 'workspace-1', userId: 'user-1', role: 'pm' } as any,
      projectId: project.id, threadId: 'thread-1', messageId: `message-${crypto.randomUUID()}`,
      content: 'Build a full stack calculator.', requestedRepository: selectedRepo
    });

    expect(result).toMatchObject({ status: 'blocked', reason: expect.stringContaining('8,000 characters') });
    expect(reservePlanning).not.toHaveBeenCalled();
    expect(createdIssue).not.toHaveBeenCalled();
    expect(plannerCreatePlan).not.toHaveBeenCalled();
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

    expect(result.status).toBe('plan_ready');
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
    expect(result.reason).toContain('preserved');
    expect(result.reason).toContain('Review');
    expect(fs.existsSync(reservation.worktreePath)).toBe(true);
    expect(removeWorktree).not.toHaveBeenCalled();
    expect(recordPlanningRecovery).toHaveBeenCalledWith(expect.objectContaining({
      projectId: project.id, state: 'needs_review', reservation: expect.objectContaining({ runId: reservation.runId })
    }));
    expect(reservePlanning).not.toHaveBeenCalled();
  });
});
