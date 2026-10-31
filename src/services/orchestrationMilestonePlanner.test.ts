import { beforeEach, describe, expect, it, vi } from 'vitest';
import { milestonePlanner } from './orchestrationMilestonePlanner.js';
import { parseOrchestrationPlan } from './orchestrationContract.js';

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(), can: vi.fn(), access: vi.fn(), clean: vi.fn(), head: vi.fn(), file: vi.fn(), changed: vi.fn(), createPlan: vi.fn()
}));
vi.mock('./workspaceRegistry.js', () => ({ workspaceRegistry: { resolve: mocks.resolve, can: mocks.can, canAccessProjectBuilds: mocks.can, canAccessProjectAgentRun: mocks.access } }));
vi.mock('./agentReadiness.js', () => ({ agentReadiness: () => ({ status: 'ready' }) }));
vi.mock('./personaService.js', () => ({ resolveAgent: (agent: any) => ({ ...agent, modelProvider: 'OpenAI', modelName: 'fixture' }) }));
vi.mock('./projectBuildOrchestrator.js', () => ({ plannerModelName: () => 'fixture', repositoryPlanningContext: () => ({ context: 'Current source tree', scripts: ['test'] }) }));
vi.mock('../utils/gitUtils.js', () => ({ isGitWorkingTreeClean: mocks.clean, getHeadCommit: mocks.head, getGitChangedPaths: mocks.changed, getGitFileAtCommit: mocks.file }));

const task = { id: 'next', title: 'Use actual API', description: 'Call the accepted createTask API.', kind: 'backend', repository: 'acme/api', ownerAgentId: 'backend', requirementIds: ['R2'], acceptanceCriteria: ['Uses accepted contract.'], requiredChecks: ['test'], scope: { includePaths: ['src/client.ts'], excludePaths: [] } };
const milestone = { id: 'second', title: 'API client', objective: 'Use accepted API.', requirementIds: ['R2'], repositories: ['acme/api'] };
const snapshot: any = { run: { id: 'run', workspaceId: 'workspace', projectId: 'project', createdBy: 'user', planVersion: 1,
  repository: 'acme/api', repositoryWorkspaces: [{ repository: 'acme/api', worktreePath: 'C:/fixture', baseCommit: 'a'.repeat(40) }],
  plan: { goal: 'Create an API and client.', exclusions: [], requirements: [{ id: 'R1', description: 'API' }, { id: 'R2', description: 'Client' }], milestones: [{ id: 'first' }, milestone] } },
  tasks: [{ id: 'prior', repository: 'acme/api', status: 'accepted' }], attempts: [{ taskId: 'prior', status: 'accepted', resultCommit: 'b'.repeat(40) }] };
const store: any = { getProjects: () => [{ id: 'project', key: 'PRJ' }], getRuntimes: () => [], getAgents: () => [
  { id: 'planner', name: 'Orchestrator', role: 'Orchestrator Agent' }, { id: 'backend', name: 'Backend', role: 'Backend Agent' }
] };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.resolve.mockResolvedValue({ role: 'admin', workspaceId: 'workspace', userId: 'user' });
  mocks.can.mockReturnValue(true); mocks.access.mockResolvedValue(true);
  mocks.clean.mockResolvedValue(true); mocks.head.mockResolvedValue('b'.repeat(40));
  mocks.changed.mockResolvedValue(['src/tasks.ts']); mocks.file.mockResolvedValue('export function createTask(title: string) { return { id: 1, title }; }');
  mocks.createPlan.mockResolvedValue({ plan: parseOrchestrationPlan({ schemaVersion: 1, goal: 'Client', requirements: [{ id: 'R2', description: 'Client' }], tasks: [task] }) });
});

describe('just-in-time milestone evidence', () => {
  it('passes accepted source and only the approved milestone requirements to the planner', async () => {
    const result = await milestonePlanner(store, { createPlan: mocks.createPlan } as any)(snapshot, milestone);
    const input = mocks.createPlan.mock.calls[0][0];
    expect(input.goal).toBe(snapshot.run.plan.goal);
    expect(input.approvedRequirements).toEqual([{ id: 'R2', description: 'Client' }]);
    expect(input.acceptedEvidence).toContain('createTask(title: string)');
    expect(input.acceptedEvidence).toContain('b'.repeat(40));
    expect(result.tasks[0]).toMatchObject({ milestoneId: 'second', id: expect.stringMatching(/^m2-/) });
    expect(result.checkpoints).toEqual([{ repository: 'acme/api', commit: 'b'.repeat(40) }]);
    expect(mocks.resolve).toHaveBeenCalledTimes(2);
  });

  it('does not call the planner when a repository differs from the accepted checkpoint', async () => {
    mocks.head.mockResolvedValue('c'.repeat(40));
    await expect(milestonePlanner(store, { createPlan: mocks.createPlan } as any)(snapshot, milestone)).rejects.toThrow(/accepted checkpoint/);
    expect(mocks.createPlan).not.toHaveBeenCalled();
  });

  it('rejects a plan if the checkpoint or authorization changes during planning', async () => {
    mocks.head.mockResolvedValueOnce('b'.repeat(40)).mockResolvedValue('c'.repeat(40));
    await expect(milestonePlanner(store, { createPlan: mocks.createPlan } as any)(snapshot, milestone)).rejects.toThrow(/changed during milestone planning/);
    mocks.head.mockResolvedValue('b'.repeat(40));
    mocks.resolve.mockResolvedValueOnce({ role: 'admin' }).mockResolvedValueOnce(null);
    await expect(milestonePlanner(store, { createPlan: mocks.createPlan } as any)(snapshot, milestone)).rejects.toThrow(/access changed/);
  });
});
