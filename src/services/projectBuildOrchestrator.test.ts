import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

const selectedRepo = 'acme/shop-fe';
const repositoryList = [selectedRepo, 'acme/shop-be'];
const project = { id: 'project-1', name: 'Calculator', leadSquadId: 'squad-1', resources: [] };
const agents = [
  { id: 'agent-1', name: 'Planner', isArchived: false },
  { id: 'agent-2', name: 'Frontend Builder', isArchived: false }
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

async function load() {
  checkoutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-project-build-'));
  issueRows = [];
  squadRuns = [];
  createdIssue = vi.fn(async (_workspaceId: string, input: any) => {
    const issue = {
      ...input,
      identifier: 'CALC-1',
      createdAt: '2026-10-18T00:00:00.000Z'
    };
    issueRows.push(issue);
    return issue;
  });
  startSquadRun = vi.fn(async (input: any) => {
    const run = {
      id: 'squad-run-1',
      squadId: input.squadId,
      issueId: input.issueId,
      projectId: project.id,
      branchName: 'build/CALC-1',
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
  vi.doMock('../utils/gitUtils.js', () => ({ isGitRepo: vi.fn(async () => true) }));
  vi.doMock('./workspaceService.js', () => ({
    resolveProjectWorkspace: vi.fn(() => ({ dir: checkoutDir, repo: selectedRepo, owner: 'acme' })),
    allowAttachedWorkspace: vi.fn()
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
  vi.doMock('../services/githubIssueMapping.js', () => ({ reposForProject: () => repositoryList }));
  vi.doMock('./sqliteService.js', () => ({
    sqliteService: {
      getAgents: () => agents,
      getRuntimes: () => [],
      getSquadRuns: () => squadRuns,
      getRunsForSquadRun: () => []
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
    './boardWriteThrough.js', './supabaseService.js'
  ]) vi.doUnmock(mod);
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
});
