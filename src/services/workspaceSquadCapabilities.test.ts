import { describe, expect, it } from 'vitest';

import { workspaceRegistry } from './workspaceRegistry.js';

describe('workspace squad management capabilities', () => {
  it('gives publication, UAT delivery and chat to every internal role, and none of it to clients', () => {
    for (const role of ['dev', 'pm', 'admin'] as const) {
      expect(workspaceRegistry.can(role, 'build.publish')).toBe(true);
      expect(workspaceRegistry.can(role, 'project.promote_uat')).toBe(true);
      expect(workspaceRegistry.can(role, 'chat.read')).toBe(true);
      expect(workspaceRegistry.can(role, 'chat.write')).toBe(true);
    }
    expect(workspaceRegistry.can('client', 'chat.read')).toBe(false);
    expect(workspaceRegistry.can('client', 'chat.write')).toBe(false);
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

  it('lets project managers run and configure agents, squads and MCP servers', () => {
    // The hosted web app hides all of this from a PM, and every route that starts agent work is
    // desktopOnly; the grants are the same in both runtimes because the desktop calls the cloud.
    for (const capability of ['agent.read', 'agent.run', 'agent.manage', 'squad.read', 'squad.run', 'squad.manage',
      'mcp.read', 'mcp.execute', 'mcp.manage', 'chat.read', 'chat.write'] as const) {
      expect(workspaceRegistry.can('pm', capability)).toBe(true);
    }
    expect(workspaceRegistry.can('pm', 'deployment.manage')).toBe(false);
    expect(workspaceRegistry.can('pm', 'operations.manage')).toBe(false);
  });

  it('lets developers, project managers and admins operate agents, and never clients', () => {
    for (const role of ['dev', 'pm', 'admin'] as const) expect(workspaceRegistry.canOperateAgents(role)).toBe(true);
    expect(workspaceRegistry.canOperateAgents('client')).toBe(false);
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
