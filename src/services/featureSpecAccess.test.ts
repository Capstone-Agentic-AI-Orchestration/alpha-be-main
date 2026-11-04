import { describe, expect, it, vi } from 'vitest';

const access = vi.hoisted(() => vi.fn(async () => false));
const turn = vi.hoisted(() => vi.fn());
vi.mock('./workspaceRegistry.js', () => ({ workspaceRegistry: { canAccessProjectAgentRun: access } }));
vi.mock('./sqliteService.js', () => ({ sqliteService: { getAgents: () => [{ id: 'manager-private', templateKey: 'manager' }] } }));
vi.mock('./workspaceContext.js', () => ({ runWithWorkspace: (_id: string, fn: () => unknown) => fn() }));
vi.mock('./cliRunner.js', () => ({ runCliTurn: turn }));
vi.mock('./projectBuildOrchestrator.js', () => ({ repositoryPlanningContext: vi.fn() }));

import { draftFeatureSpec, proposeSystemEpics } from './featureSpecService.js';

describe('requirements agent access', () => {
  it('uses the same project-agent visibility check before any AI turn', async () => {
    const input = { workspaceId: 'workspace', context: { workspaceId: 'workspace', userId: 'dev', role: 'dev' },
      project: { id: 'project', name: 'Project' }, threadId: 'task-thread' } as any;
    await expect(proposeSystemEpics({ ...input, description: 'A task tracker.' })).rejects.toMatchObject({ status: 403 });
    await expect(draftFeatureSpec({ ...input, issue: { title: 'A task', description: '' } })).rejects.toMatchObject({ status: 403 });
    expect(access).toHaveBeenCalledWith(input.context, input.project.id, 'manager-private');
    expect(turn).not.toHaveBeenCalled();
  });
});
