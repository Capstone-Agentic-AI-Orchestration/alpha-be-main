import { describe, expect, it } from 'vitest';

import { workspaceRegistry } from './workspaceRegistry.js';

describe('workspace squad management capabilities', () => {
  it('gives publication and UAT delivery authority to internal roles without granting chat to non-developers', () => {
    for (const role of ['dev', 'pm', 'admin'] as const) {
      expect(workspaceRegistry.can(role, 'build.publish')).toBe(true);
      expect(workspaceRegistry.can(role, 'project.promote_uat')).toBe(true);
    }
    expect(workspaceRegistry.can('dev', 'chat.read')).toBe(true);
    expect(workspaceRegistry.can('dev', 'chat.write')).toBe(true);
    for (const role of ['client', 'pm', 'admin'] as const) {
      expect(workspaceRegistry.can(role, 'chat.read')).toBe(false);
      expect(workspaceRegistry.can(role, 'chat.write')).toBe(false);
    }
    expect(workspaceRegistry.can('client', 'build.publish')).toBe(false);
  });

  it('keeps unrestricted deployment management and manual merge authority admin-only', () => {
    expect(workspaceRegistry.can('admin', 'deployment.manage')).toBe(true);
    expect(workspaceRegistry.can('dev', 'deployment.manage')).toBe(false);
    expect(workspaceRegistry.can('pm', 'deployment.manage')).toBe(false);
  });

  it('allows developers to manage squads they own', () => {
    expect(workspaceRegistry.can('dev', 'squad.manage')).toBe(true);
  });

  it('keeps squad management restricted from project managers', () => {
    expect(workspaceRegistry.can('pm', 'squad.manage')).toBe(false);
  });

  it('keeps PMs in review mode for agents and Orchestrator runs', () => {
    expect(workspaceRegistry.can('pm', 'agent.read')).toBe(true);
    expect(workspaceRegistry.can('pm', 'squad.read')).toBe(true);
    expect(workspaceRegistry.can('pm', 'agent.manage')).toBe(false);
    expect(workspaceRegistry.can('pm', 'agent.run')).toBe(false);
    expect(workspaceRegistry.can('pm', 'mcp.execute')).toBe(false);
    expect(workspaceRegistry.can('pm', 'squad.run')).toBe(false);
    expect(workspaceRegistry.can('pm', 'deployment.manage')).toBe(false);
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
