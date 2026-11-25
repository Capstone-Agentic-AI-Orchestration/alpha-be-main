import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ enabled: true, projectAccess: true }));
vi.mock('./sqliteService.js', () => ({ sqliteService: { boardAssistantEnabled: () => state.enabled } }));
vi.mock('./workspaceContext.js', async importOriginal => ({ ...(await importOriginal<object>()), runWithWorkspace: (_id: string, fn: () => unknown) => fn() }));
vi.mock('./workspaceRegistry.js', async () => {
  const roles: Record<string, string[]> = {
    dev: ['issue.manage', 'agent.run', 'chat.write'], admin: ['issue.manage', 'agent.run', 'chat.write'],
    pm: ['issue.manage', 'agent.run', 'chat.write'], client: []
  };
  const can = (role: string, capability: string) => roles[role]?.includes(capability) ?? false;
  return { workspaceRegistry: {
    can,
    canOperateAgents: (role: string) => can(role, 'agent.run') && can(role, 'chat.write'),
    canAccessProjectBuilds: () => state.projectAccess
  } };
});

import { BoardGrantRefused, boardAgentRefusal, boardGrantForToken, mintBoardGrant, revokeBoardGrant } from './boardGrant.js';

const context = (role: string) => ({ userId: 'u', workspaceId: 'ws', role }) as any;
const grant = (role: string) => ({ runId: 'turn', agentId: 'agent-manager', agentName: 'Manager Agent', context: context(role), actorLogin: 'lloyd', projectId: 'p', access: 'write' as const });

describe('board pass', () => {
  beforeEach(() => { state.enabled = true; state.projectAccess = true; });

  it('is for every role that operates agents, never a client', () => {
    for (const role of ['dev', 'pm', 'admin']) expect(boardAgentRefusal(context(role), 'p')).toBeNull();
    expect(boardAgentRefusal(context('client'), 'p')).toBe('Your workspace role cannot have agents change tasks.');
    expect(() => mintBoardGrant(grant('client'))).toThrow(BoardGrantRefused);
  });

  it('is refused for a project the developer cannot reach, or with the assistant off', () => {
    state.projectAccess = false;
    expect(boardAgentRefusal(context('dev'), 'p')).toMatch(/access/);
    state.projectAccess = true;
    state.enabled = false;
    expect(boardAgentRefusal(context('dev'), 'p')).toMatch(/turned off/);
  });

  it('works for one turn and stops when revoked', () => {
    const token = mintBoardGrant(grant('dev'));
    expect(boardGrantForToken(token)).toMatchObject({ runId: 'turn', actorLogin: 'lloyd', writes: 0 });
    expect(boardGrantForToken('f'.repeat(64))).toBeNull();
    revokeBoardGrant('turn');
    expect(boardGrantForToken(token)).toBeNull();
  });
});

