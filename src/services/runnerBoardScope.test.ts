import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ run: null as any, role: 'dev' as string | null }));
vi.mock('./sqliteService.js', async importOriginal => {
  const actual = await importOriginal<any>();
  return { ...actual, sqliteService: new Proxy(actual.sqliteService, {
    get: (target, key) => key === 'getOrchestrationSnapshot' ? () => (state.run ? { run: state.run } : null) : Reflect.get(target, key)
  }) };
});
vi.mock('./workspaceRegistry.js', async importOriginal => {
  const actual = await importOriginal<any>();
  return { ...actual, workspaceRegistry: new Proxy(actual.workspaceRegistry, {
    get: (target, key) => key === 'resolve'
      ? async (userId: string, workspaceId: string) => (state.role ? { userId, workspaceId, role: state.role } : null)
      : Reflect.get(target, key)
  }) };
});

import { specialistBoardScope } from './runnerService.js';

describe('a specialist\'s board access in a build', () => {
  beforeEach(() => {
    state.run = { createdBy: 'lloyd', workspaceId: 'ws', projectId: 'p', issueId: 'issue-7' };
    state.role = 'dev';
  });

  it('may comment on its own card, as the developer who started the build', async () => {
    expect(await specialistBoardScope('run-1', 'agent-backend', 'Backend Agent')).toMatchObject({
      access: 'comment', ownIssueId: 'issue-7', actorLogin: 'lloyd', projectId: 'p', agentName: 'Backend Agent'
    });
  });

  it('gets nothing when the build\'s starter can no longer operate agents, or the run is unknown', async () => {
    state.role = 'client';
    expect(await specialistBoardScope('run-1', 'agent-backend', 'Backend Agent')).toBeUndefined();
    state.role = 'dev';
    state.run = null;
    expect(await specialistBoardScope('run-1', 'agent-backend', 'Backend Agent')).toBeUndefined();
  });
});

