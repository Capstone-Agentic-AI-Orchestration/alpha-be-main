import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ snapshot: {} as any, replace: vi.fn() }));
vi.mock('./sqliteService.js', () => ({ sqliteService: {
  getOrchestrationSnapshot: () => mocks.snapshot,
  getAgents: () => [{ id: 'orchestrator', role: 'Orchestrator Agent', name: 'Orchestrator' }, { id: 'frontend', role: 'Frontend Agent', name: 'Frontend' }],
  getRuntimes: () => [],
  replaceUnstartedPlan: mocks.replace
} }));
vi.mock('./workspaceRegistry.js', () => ({ workspaceRegistry: { canAccessProjectAgentRun: async () => true } }));
vi.mock('./workspaceContext.js', () => ({ runWithWorkspace: (_id: string, fn: () => unknown) => fn() }));
vi.mock('./agentReadiness.js', () => ({ agentReadiness: () => ({ status: 'ready' }) }));
vi.mock('./personaService.js', () => ({ resolveAgent: (agent: { name: string; role: string }) => ({ name: agent.name, role: agent.role, modelProvider: 'OpenAI', modelName: 'fixture', systemPrompt: 'Plan.' }) }));
vi.mock('./projectBuildOrchestrator.js', () => ({ plannerModelName: () => 'fixture', repositoryPlanningContext: () => ({ context: 'React app.', scripts: ['test'] }) }));
vi.mock('./repositoryMemory.js', () => ({ readMemoryAtCommit: async () => undefined, renderProjectMemory: () => '' }));
vi.mock('../utils/gitUtils.js', () => ({ getCurrentBranch: async () => 'alpha/build', getHeadCommit: async () => 'a'.repeat(40), isGitWorkingTreeClean: async () => true }));

import { correctPlanBeforeStart, reviseBoardPlan } from './boardPlanRevision.js';

const plan = { goal: 'Add login.', exclusions: [], requirements: [{ id: 'login', description: 'Login screen.' }], projectContext: '',
  tasks: [{ id: 'login-form', title: 'Login form', repository: 'acme/web', ownerAgentId: 'frontend', dependsOn: [], required: true }] };
const workspace = (repository: string, optional: boolean) => ({ repository, branchName: 'alpha/build', baseRef: 'main', baseCommit: 'a'.repeat(40), worktreePath: `/w/${repository}`, optional });
const context = { userId: 'alice', workspaceId: 'ws', role: 'dev' } as any;

/** Planning again inside a saved build uses the rules the plan was made under: an optional codebase stays optional. */
describe('planning again inside a saved build', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.snapshot = { run: { id: 'run', projectId: 'project', revision: 4, status: 'awaiting_plan_approval', plan, repository: 'acme/web',
      repositoryWorkspaces: [workspace('acme/web', false), workspace('acme/api', true)] }, attempts: [], tasks: [] };
    mocks.replace.mockImplementation(({ plan: saved }) => ({ ...mocks.snapshot, run: { ...mocks.snapshot.run, plan: saved, planVersion: 2 } }));
  });

  it('tells the planner which codebases may stay without tasks when revising', async () => {
    const createPlan = vi.fn(async () => ({ plan: structuredClone(plan) }));
    await reviseBoardPlan(context, 'run', 4, 'Use a modal.', { createPlan } as any);
    const input = (createPlan.mock.calls[0] as any[])[0];
    expect(input.repositories).toEqual([
      expect.not.objectContaining({ optional: true }),
      expect.objectContaining({ repository: 'acme/api', optional: true })
    ]);
    expect(input.repositories[0].repository).toBe('acme/web');
  });

  it('corrects a plan before start once, saves it as the next version and lists what changed', async () => {
    const fixed = { ...structuredClone(plan), tasks: [...plan.tasks, { id: 'session', title: 'Session check', repository: 'acme/web', ownerAgentId: 'frontend', dependsOn: [], required: true }] };
    const correctPlan = vi.fn(async () => structuredClone(fixed));
    const result = await correctPlanBeforeStart(context, 'run', [{ detail: 'Task login-form depends on a missing task.' }], { correctPlan } as any);
    expect((correctPlan.mock.calls[0] as any[])[2].message).toBe('Task login-form depends on a missing task.');
    expect(mocks.replace).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run', expectedRevision: 4, actorId: 'alice',
      reason: 'The Orchestrator corrected the plan before it could start: Task login-form depends on a missing task.' }));
    expect(result.changes).toEqual(['Added "Session check" in web.']);
  });
});
