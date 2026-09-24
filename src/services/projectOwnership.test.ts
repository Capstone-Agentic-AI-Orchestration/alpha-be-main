import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';

import { createTestDatabase, sqlFor } from '../store/testDatabase.js';
import { PostgresWorkspaceDirectory } from '../store/postgresWorkspaceDirectory.js';
import type { WorkspaceContext } from '../store/workspaceDirectory.js';
import { workspaceRegistry } from './workspaceRegistry.js';

let db: PGlite;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db?.close();
});

function context(role: WorkspaceContext['role']): WorkspaceContext {
  return {
    userId: role === 'dev' ? 'Dev1' : role === 'admin' ? 'Admin1' : 'PM1',
    workspaceId: 'ws-default',
    role,
    workspace: {
      id: 'ws-default',
      name: 'Alpha',
      slug: 'alpha',
      status: 'active',
      role,
      memberCount: 3,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    access: {
      assignedProjectIds: new Set(role === 'dev' ? ['assigned-pm-project'] : []),
      projectCreators: new Map([
        ['pm-project', 'PM1'],
        ['assigned-pm-project', 'PM1'],
        ['admin-project', 'Admin1']
      ]),
      projectManagerIds: new Set(['PM1']),
      squadOwners: new Map(),
      squadProjects: [],
      workspaceRows: {
        projects: new Set(['pm-project', 'assigned-pm-project', 'admin-project']),
        squads: new Set()
      }
    }
  };
}

describe('PM-owned project access', () => {
  it('gives project creation and management only to PMs', () => {
    expect(workspaceRegistry.can('pm', 'project.create')).toBe(true);
    expect(workspaceRegistry.can('pm', 'project.manage')).toBe(true);
    expect(workspaceRegistry.can('admin', 'project.create')).toBe(false);
    expect(workspaceRegistry.can('admin', 'project.manage')).toBe(false);
  });

  it('lets workspace developers discover PM projects without granting project work access', () => {
    const dev = context('dev');

    expect(workspaceRegistry.canDiscoverProject(dev, 'pm-project')).toBe(true);
    expect(workspaceRegistry.canDiscoverProject(dev, 'admin-project')).toBe(false);
    expect(workspaceRegistry.canAccessProject(dev, 'pm-project')).toBe(false);
    expect(workspaceRegistry.canAccessProject(dev, 'assigned-pm-project')).toBe(true);
  });

  it('keeps PM and admin visibility limited to active PM-owned projects', () => {
    expect(workspaceRegistry.canAccessProject(context('pm'), 'pm-project')).toBe(true);
    expect(workspaceRegistry.canAccessProject(context('admin'), 'pm-project')).toBe(true);
    expect(workspaceRegistry.canAccessProject(context('admin'), 'admin-project')).toBe(false);
  });

  it('loads creator and active-PM facts into a real cloud workspace context', async () => {
    const directory = new PostgresWorkspaceDirectory(sqlFor(db), 'ws-default');
    await directory.ensureDefaultWorkspace();
    await directory.addMember('ws-default', 'PM1', 'pm');
    await directory.addMember('ws-default', 'Dev1', 'dev');
    await db.exec(`
      insert into projects (id, workspace_id, name, key, created_by)
      values ('ownership-pm', 'ws-default', 'PM project', 'OWN', 'PM1'),
             ('ownership-admin', 'ws-default', 'Admin project', 'OWN2', 'Admin1')
    `);

    const dev = await directory.resolve('Dev1', 'ws-default', 'dev');
    expect(dev?.access.projectCreators?.get('ownership-pm')).toBe('PM1');
    expect(workspaceRegistry.canDiscoverProject(dev!, 'ownership-pm')).toBe(true);
    expect(workspaceRegistry.canDiscoverProject(dev!, 'ownership-admin')).toBe(false);
  });
});
