import { describe, expect, it } from 'vitest';

import { workspaceRegistry } from './workspaceRegistry.js';

describe('workspace squad management capabilities', () => {
  it('allows developers to manage squads they own', () => {
    expect(workspaceRegistry.can('dev', 'squad.manage')).toBe(true);
  });

  it('keeps squad management restricted from project managers', () => {
    expect(workspaceRegistry.can('pm', 'squad.manage')).toBe(false);
  });

  it('allows workspace administrators to manage squads', () => {
    expect(workspaceRegistry.can('admin', 'squad.manage')).toBe(true);
  });

  it('lets developers and project managers assign shared squads on projects they can edit', () => {
    expect(workspaceRegistry.can('dev', 'project.update')).toBe(true);
    expect(workspaceRegistry.can('pm', 'project.update')).toBe(true);
  });

  it('limits shared-squad changes to its owner or a workspace admin', () => {
    const squadId = 'shared-squad';
    const context = (userId: string, role: 'dev' | 'pm' | 'admin') => ({
      workspaceId: 'workspace-1',
      userId,
      role,
      access: {
        squadOwners: new Map([[squadId, 'creator']]),
        workspaceRows: { projects: new Set<string>(), squads: new Set([squadId]) }
      }
    }) as any;

    expect(workspaceRegistry.canManageSquad(context('creator', 'dev'), squadId)).toBe(true);
    expect(workspaceRegistry.canManageSquad(context('teammate', 'dev'), squadId)).toBe(false);
    expect(workspaceRegistry.canManageSquad(context('manager', 'pm'), squadId)).toBe(false);
    expect(workspaceRegistry.canManageSquad(context('admin', 'admin'), squadId)).toBe(true);
  });

  it('lets every internal role see squads in the workspace but not client accounts', () => {
    const squadId = 'shared-squad';
    const context = (userId: string, role: 'dev' | 'pm' | 'admin' | 'client') => ({
      workspaceId: 'workspace-1',
      userId,
      role,
      access: {
        squadOwners: new Map([[squadId, 'creator']]),
        workspaceRows: { projects: new Set<string>(), squads: new Set([squadId]) }
      }
    }) as any;

    expect(workspaceRegistry.canAccessSquad(context('teammate', 'dev'), squadId)).toBe(true);
    expect(workspaceRegistry.canAccessSquad(context('manager', 'pm'), squadId)).toBe(true);
    expect(workspaceRegistry.canAccessSquad(context('admin', 'admin'), squadId)).toBe(true);
    expect(workspaceRegistry.canAccessSquad(context('client', 'client'), squadId)).toBe(false);
    expect(workspaceRegistry.canAccessSquad(context('teammate', 'dev'), 'other-workspace-squad')).toBe(false);
  });
});
