import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { DB_PATH } from '../config/env.js';
import { DEFAULT_WORKSPACE_ID } from './workspaceContext.js';

export type WorkspaceRole = 'client' | 'dev' | 'pm' | 'admin';
export type WorkspaceMemberStatus = 'invited' | 'active' | 'suspended' | 'removed';

export interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  status: 'active' | 'archived';
  role: WorkspaceRole;
  memberCount: number;
  joinCode?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceContext {
  userId: string;
  workspaceId: string;
  role: WorkspaceRole;
  workspace: WorkspaceSummary;
}

export interface WorkspaceProjectAssignment {
  id: string;
  workspaceId: string;
  projectId: string;
  userId: string;
  status: 'active' | 'removed';
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceSquadProjectAssignment {
  id: string;
  workspaceId: string;
  squadId: string;
  projectId: string;
  relationship: 'owned' | 'assigned';
  status: 'active' | 'removed';
  createdAt: string;
  updatedAt: string;
}

type EntityType =
  | 'projects'
  | 'issues'
  | 'agents'
  | 'squads'
  | 'prototype_runs'
  | 'squad_runs'
  | 'chat_threads';

export type WorkspaceCapability =
  | 'workspace.read'
  | 'workspace.read_members'
  | 'workspace.manage_members'
  | 'workspace.manage_settings'
  | 'project.read'
  | 'project.create'
  | 'project.manage'
  | 'issue.read'
  | 'issue.manage'
  | 'agent.read'
  | 'agent.run'
  | 'agent.manage'
  | 'squad.read'
  | 'squad.run'
  | 'squad.manage'
  | 'chat.read'
  | 'chat.write'
  | 'deployment.read'
  | 'deployment.manage'
  | 'analytics.read'
  | 'intake.submit';

const CAPABILITIES: Record<WorkspaceRole, readonly WorkspaceCapability[]> = {
  client: [
    'workspace.read',
    'project.read',
    'chat.read',
    'chat.write',
    'intake.submit'
  ],
  dev: [
    'workspace.read',
    'project.read',
    'issue.read',
    'issue.manage',
    'agent.read',
    'agent.run',
    'squad.read',
    'squad.run',
    'squad.manage',
    'chat.read',
    'chat.write',
    'deployment.read'
  ],
  pm: [
    'workspace.read',
    'workspace.read_members',
    'project.read',
    'project.create',
    'project.manage',
    'issue.read',
    'issue.manage',
    'agent.read',
    'squad.read',
    'chat.read',
    'chat.write',
    'deployment.read',
    'deployment.manage',
    'analytics.read',
    'workspace.manage_settings'
  ],
  admin: [
    'workspace.read',
    'workspace.read_members',
    'workspace.manage_members',
    'workspace.manage_settings',
    'project.read',
    'project.create',
    'project.manage',
    'issue.read',
    'issue.manage',
    'agent.read',
    'agent.run',
    'agent.manage',
    'squad.read',
    'squad.run',
    'squad.manage',
    'chat.read',
    'chat.write',
    'deployment.read',
    'deployment.manage',
    'analytics.read'
  ]
};

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || `workspace-${Date.now()}`;
}

function roleOrAdmin(value: unknown): WorkspaceRole {
  return value === 'client' || value === 'dev' || value === 'pm' || value === 'admin'
    ? value
    : 'admin';
}

/**
 * Product workspaces are deliberately separate from machine working-copy
 * directories. This registry stores collaboration membership and a normalized
 * binding for local entities without forcing a destructive rewrite of the
 * existing SQLite tables. Unbound legacy records belong to the default
 * workspace; newly created records are explicitly bound to the active one.
 */
class WorkspaceRegistry {
  private readonly db: Database.Database;
  // Must match the id sqliteService seeds, and the id currentWorkspaceId()
  // falls back to. A second literal here meant the registry looked up a
  // workspace whose INSERT was silently dropped by the UNIQUE slug it shared
  // with the seeded row, so every membership lookup hit a dangling FK.
  private readonly defaultWorkspaceId = DEFAULT_WORKSPACE_ID;

  constructor() {
    this.db = new Database(DB_PATH);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'active',
        join_code TEXT NOT NULL UNIQUE,
        created_by TEXT NOT NULL,
        settings_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workspace_members (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(workspace_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS workspace_entity_bindings (
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY(entity_type, entity_id)
      );

      CREATE TABLE IF NOT EXISTS workspace_project_assignments (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(workspace_id, project_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS workspace_squad_owners (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        squad_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(workspace_id, squad_id)
      );

      CREATE TABLE IF NOT EXISTS workspace_squad_projects (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        squad_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        relationship TEXT NOT NULL DEFAULT 'assigned',
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(workspace_id, squad_id, project_id)
      );

      CREATE INDEX IF NOT EXISTS idx_workspace_members_user
        ON workspace_members(user_id, status);
      CREATE INDEX IF NOT EXISTS idx_workspace_bindings_workspace
        ON workspace_entity_bindings(workspace_id, entity_type);
      CREATE INDEX IF NOT EXISTS idx_workspace_project_assignments_user
        ON workspace_project_assignments(workspace_id, user_id, status);
      CREATE INDEX IF NOT EXISTS idx_workspace_project_assignments_project
        ON workspace_project_assignments(workspace_id, project_id, status);
      CREATE INDEX IF NOT EXISTS idx_workspace_squad_owners_user
        ON workspace_squad_owners(workspace_id, user_id, status);
      CREATE INDEX IF NOT EXISTS idx_workspace_squad_projects_project
        ON workspace_squad_projects(workspace_id, project_id, status);
    `);

    try {
      this.db.exec("ALTER TABLE workspaces ADD COLUMN settings_json TEXT NOT NULL DEFAULT '{}'");
    } catch {
      // Existing installations already have the column.
    }

    try {
      this.db.exec("ALTER TABLE workspaces ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
    } catch {
      // Existing installations already have the column.
    }

    try {
      this.db.exec("ALTER TABLE workspaces ADD COLUMN created_by TEXT NOT NULL DEFAULT 'system'");
    } catch {
      // Existing installations already have the column.
    }

    // SQLite refuses ADD COLUMN with a UNIQUE constraint, so join_code lands
    // nullable and a partial index supplies the uniqueness. The predicate skips
    // the NULLs that rows predating this column already carry.
    try {
      this.db.exec('ALTER TABLE workspaces ADD COLUMN join_code TEXT');
    } catch {
      // Existing installations already have the column.
    }

    try {
      this.db.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_join_code ' +
          'ON workspaces(join_code) WHERE join_code IS NOT NULL'
      );
    } catch {
      // Existing installations already have the index.
    }

    try {
      this.db.exec("ALTER TABLE workspace_squad_projects ADD COLUMN relationship TEXT NOT NULL DEFAULT 'assigned'");
    } catch {
      // Existing installations already have the column.
    }

    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT OR IGNORE INTO workspaces
        (id, name, slug, status, join_code, created_by, created_at, updated_at)
      VALUES (?, ?, ?, 'active', ?, ?, ?, ?)
    `).run(
      this.defaultWorkspaceId,
      'Alpha Workspace',
      'alpha-workspace',
      'alpha-default',
      'system',
      now,
      now
    );
  }

  close(): void {
    this.db.close();
  }

  private rowSummary(row: any, role: WorkspaceRole, includeJoinCode = false): WorkspaceSummary {
    const memberCount = Number((this.db
      .prepare("SELECT COUNT(*) AS count FROM workspace_members WHERE workspace_id = ? AND status = 'active'")
      .get(row.id) as { count?: number } | undefined)?.count ?? 0);

    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      status: row.status,
      role,
      memberCount,
      ...(includeJoinCode ? { joinCode: row.join_code } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  ensureMember(userId: string, suggestedRole?: WorkspaceRole): void {
    const existing = this.db.prepare(
      'SELECT id FROM workspace_members WHERE workspace_id = ? AND user_id = ?'
    ).get(this.defaultWorkspaceId, userId);
    if (existing) return;

    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO workspace_members
        (id, workspace_id, user_id, role, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?)
    `).run(
      `member-${randomUUID()}`,
      this.defaultWorkspaceId,
      userId,
      suggestedRole ?? 'admin',
      now,
      now
    );
  }

  listForUser(userId: string, suggestedRole?: WorkspaceRole): WorkspaceSummary[] {
    this.ensureMember(userId, suggestedRole);
    const rows = this.db.prepare(`
      SELECT w.*, m.role
      FROM workspaces w
      INNER JOIN workspace_members m ON m.workspace_id = w.id
      WHERE m.user_id = ? AND m.status = 'active' AND w.status = 'active'
      ORDER BY w.created_at ASC
    `).all(userId) as any[];

    return rows.map(row => this.rowSummary(row, roleOrAdmin(row.role), row.role === 'admin'));
  }

  resolve(userId: string, requestedWorkspaceId?: string, suggestedRole?: WorkspaceRole): WorkspaceContext | null {
    const available = this.listForUser(userId, suggestedRole);
    const targetId = requestedWorkspaceId || available[0]?.id;
    if (!targetId) return null;

    const row = this.db.prepare(`
      SELECT w.*, m.role
      FROM workspaces w
      INNER JOIN workspace_members m ON m.workspace_id = w.id
      WHERE w.id = ? AND m.user_id = ? AND m.status = 'active' AND w.status = 'active'
    `).get(targetId, userId) as any;
    if (!row) return null;

    const role = roleOrAdmin(row.role);
    return {
      userId,
      workspaceId: row.id,
      role,
      workspace: this.rowSummary(row, role, role === 'admin')
    };
  }

  createWorkspace(userId: string, input: { name: string; slug?: string }): WorkspaceSummary {
    const name = input.name.trim();
    if (!name) throw new Error('Workspace name is required.');

    const now = new Date().toISOString();
    const id = `workspace-${randomUUID()}`;
    const slugBase = slugify(input.slug || name);
    let slug = slugBase;
    let suffix = 2;
    while (this.db.prepare('SELECT 1 FROM workspaces WHERE slug = ?').get(slug)) {
      slug = `${slugBase}-${suffix++}`;
    }
    const joinCode = `${slug}-${randomUUID().slice(0, 8)}`;

    const tx = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO workspaces
          (id, name, slug, status, join_code, created_by, created_at, updated_at)
        VALUES (?, ?, ?, 'active', ?, ?, ?, ?)
      `).run(id, name, slug, joinCode, userId, now, now);

      this.db.prepare(`
        INSERT INTO workspace_members
          (id, workspace_id, user_id, role, status, created_at, updated_at)
        VALUES (?, ?, ?, 'admin', 'active', ?, ?)
      `).run(`member-${randomUUID()}`, id, userId, now, now);
    });
    tx();

    const row = this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as any;
    return this.rowSummary(row, 'admin', true);
  }

  joinWorkspace(userId: string, code: string, suggestedRole: WorkspaceRole = 'dev'): WorkspaceSummary {
    const value = code.trim();
    const row = this.db.prepare(
      "SELECT * FROM workspaces WHERE (join_code = ? OR slug = ? OR id = ?) AND status = 'active'"
    ).get(value, value, value) as any;
    if (!row) throw new Error('Workspace invite code was not found.');

    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO workspace_members
        (id, workspace_id, user_id, role, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?)
      ON CONFLICT(workspace_id, user_id)
      DO UPDATE SET status = 'active', updated_at = excluded.updated_at
    `).run(`member-${randomUUID()}`, row.id, userId, suggestedRole, now, now);

    return this.rowSummary(row, suggestedRole, suggestedRole === 'admin');
  }

  listMembers(workspaceId: string): Array<{
    id: string;
    userId: string;
    role: WorkspaceRole;
    status: WorkspaceMemberStatus;
    createdAt: string;
    updatedAt: string;
  }> {
    const rows = this.db.prepare(
      'SELECT * FROM workspace_members WHERE workspace_id = ? ORDER BY created_at ASC'
    ).all(workspaceId) as any[];
    return rows.map(row => ({
      id: row.id,
      userId: row.user_id,
      role: roleOrAdmin(row.role),
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  updateMember(workspaceId: string, memberId: string, input: { role?: WorkspaceRole; status?: WorkspaceMemberStatus }) {
    const current = this.db.prepare(
      'SELECT * FROM workspace_members WHERE id = ? AND workspace_id = ?'
    ).get(memberId, workspaceId) as any;
    if (!current) return null;

    const role = input.role ?? roleOrAdmin(current.role);
    const status = input.status ?? current.status;
    const updatedAt = new Date().toISOString();
    this.db.prepare(`
      UPDATE workspace_members SET role = ?, status = ?, updated_at = ?
      WHERE id = ? AND workspace_id = ?
    `).run(role, status, updatedAt, memberId, workspaceId);
    return this.listMembers(workspaceId).find(member => member.id === memberId) ?? null;
  }

  updateWorkspace(workspaceId: string, input: { name?: string; slug?: string }): WorkspaceSummary | null {
    const current = this.db.prepare('SELECT * FROM workspaces WHERE id = ? AND status = \'active\'').get(workspaceId) as any;
    if (!current) return null;
    const name = input.name === undefined ? current.name : input.name.trim();
    const slug = input.slug === undefined ? current.slug : slugify(input.slug);
    if (!name) throw new Error('Workspace name is required.');
    const collision = this.db.prepare('SELECT id FROM workspaces WHERE slug = ? AND id <> ?').get(slug, workspaceId);
    if (collision) throw new Error('That workspace slug is already in use.');
    const updatedAt = new Date().toISOString();
    this.db.prepare('UPDATE workspaces SET name = ?, slug = ?, updated_at = ? WHERE id = ?')
      .run(name, slug, updatedAt, workspaceId);
    const row = this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId) as any;
    const membership = this.db.prepare(
      "SELECT role FROM workspace_members WHERE workspace_id = ? AND status = 'active' ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'pm' THEN 1 WHEN 'dev' THEN 2 ELSE 3 END LIMIT 1"
    ).get(workspaceId) as { role?: string } | undefined;
    return this.rowSummary(row, roleOrAdmin(membership?.role));
  }

  can(role: WorkspaceRole, capability: WorkspaceCapability): boolean {
    return CAPABILITIES[role].includes(capability);
  }

  /**
   * PMs and admins have workspace-wide project visibility. Clients and
   * developers are assignment-scoped, and an empty assignment set is
   * intentionally empty rather than a reason to fall back to all projects.
   */
  canAccessProject(context: WorkspaceContext, projectId: string): boolean {
    if (!this.belongsTo('projects', projectId, context.workspaceId)) return false;
    if (context.role === 'pm' || context.role === 'admin') return true;
    return Boolean(this.db.prepare(`
      SELECT 1 FROM workspace_project_assignments
      WHERE workspace_id = ? AND project_id = ? AND user_id = ? AND status = 'active'
    `).get(context.workspaceId, projectId, context.userId));
  }

  projectIdsFor(context: WorkspaceContext, projectIds: string[]): Set<string> {
    const inWorkspace = new Set(
      projectIds.filter(projectId => this.belongsTo('projects', projectId, context.workspaceId))
    );
    if (context.role === 'pm' || context.role === 'admin') return inWorkspace;

    const rows = this.db.prepare(`
      SELECT project_id FROM workspace_project_assignments
      WHERE workspace_id = ? AND user_id = ? AND status = 'active'
    `).all(context.workspaceId, context.userId) as Array<{ project_id: string }>;
    return new Set(rows.map(row => row.project_id).filter(projectId => inWorkspace.has(projectId)));
  }

  scopeProjects<T extends { id: string }>(rows: T[], context: WorkspaceContext): T[] {
    const allowed = this.projectIdsFor(context, rows.map(row => row.id));
    return this.scope('projects', rows, context.workspaceId).filter(row => allowed.has(row.id));
  }

  canAccessSquad(context: WorkspaceContext, squadId: string): boolean {
    if (!this.belongsTo('squads', squadId, context.workspaceId)) return false;
    if (context.role === 'pm' || context.role === 'admin') return true;
    return Boolean(this.db.prepare(`
      SELECT 1 FROM workspace_squad_owners
      WHERE workspace_id = ? AND squad_id = ? AND user_id = ? AND status = 'active'
    `).get(context.workspaceId, squadId, context.userId));
  }

  scopeSquads<T extends { id: string }>(rows: T[], context: WorkspaceContext): T[] {
    return this.scope('squads', rows, context.workspaceId)
      .filter(row => this.canAccessSquad(context, row.id));
  }

  squadOwnerId(workspaceId: string, squadId: string): string | undefined {
    const row = this.db.prepare(`
      SELECT user_id FROM workspace_squad_owners
      WHERE workspace_id = ? AND squad_id = ? AND status = 'active'
    `).get(workspaceId, squadId) as { user_id?: string } | undefined;
    return row?.user_id;
  }

  bindSquadOwner(workspaceId: string, squadId: string, userId: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO workspace_squad_owners
        (id, workspace_id, squad_id, user_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?)
      ON CONFLICT(workspace_id, squad_id)
      DO UPDATE SET user_id = excluded.user_id, status = 'active', updated_at = excluded.updated_at
    `).run(`squad-owner-${randomUUID()}`, workspaceId, squadId, userId, now, now);
  }

  squadAssignedToProject(workspaceId: string, squadId: string, projectId: string): boolean {
    this.ensureLegacySquadProjectAssignments();
    return Boolean(this.db.prepare(`
      SELECT 1 FROM workspace_squad_projects
      WHERE workspace_id = ? AND squad_id = ? AND project_id = ? AND status = 'active'
    `).get(workspaceId, squadId, projectId));
  }

  assignSquadProject(
    workspaceId: string,
    squadId: string,
    projectId: string,
    relationship: 'owned' | 'assigned' = 'assigned'
  ): WorkspaceSquadProjectAssignment {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO workspace_squad_projects
        (id, workspace_id, squad_id, project_id, relationship, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
      ON CONFLICT(workspace_id, squad_id, project_id)
      DO UPDATE SET relationship = excluded.relationship, status = 'active', updated_at = excluded.updated_at
    `).run(`squad-project-${randomUUID()}`, workspaceId, squadId, projectId, relationship, now, now);
    return this.listSquadProjectAssignments(workspaceId, projectId).find(
      assignment => assignment.squadId === squadId
    )!;
  }

  removeSquadProject(workspaceId: string, squadId: string, projectId: string): boolean {
    const result = this.db.prepare(`
      UPDATE workspace_squad_projects SET status = 'removed', updated_at = ?
      WHERE workspace_id = ? AND squad_id = ? AND project_id = ? AND status = 'active'
    `).run(new Date().toISOString(), workspaceId, squadId, projectId);
    return result.changes > 0;
  }

  listSquadProjectAssignments(workspaceId: string, projectId?: string): WorkspaceSquadProjectAssignment[] {
    this.ensureLegacySquadProjectAssignments();
    const rows = this.db.prepare(`
      SELECT * FROM workspace_squad_projects
      WHERE workspace_id = ? ${projectId ? 'AND project_id = ?' : ''}
      ORDER BY created_at ASC
    `).all(...(projectId ? [workspaceId, projectId] : [workspaceId])) as any[];
    return rows.map(row => ({
      id: row.id,
      workspaceId: row.workspace_id,
      squadId: row.squad_id,
      projectId: row.project_id,
      relationship: row.relationship === 'owned' ? 'owned' : 'assigned',
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  listProjectSquadIds(workspaceId: string, projectId: string): string[] {
    return this.listSquadProjectAssignments(workspaceId, projectId)
      .filter(assignment => assignment.status === 'active')
      .map(assignment => assignment.squadId);
  }

  /**
   * Squads that are both assigned to a project and visible to this caller.
   * Project assignment is a separate relationship from squad ownership: a
   * reusable squad may serve several projects, while a developer still only
   * sees squads they own and projects they are assigned to.
   */
  projectSquadIdsFor(context: WorkspaceContext, projectId: string): string[] {
    if (!this.canAccessProject(context, projectId)) return [];
    return this.listProjectSquadIds(context.workspaceId, projectId)
      .filter(squadId => this.canAccessSquad(context, squadId));
  }

  /**
   * Authorize one concrete agent call without trusting a client-supplied
   * roster. The agent must be a member of an active squad assignment for the
   * project, the caller must be allowed to use that squad, and the agent's own
   * visibility setting must allow the caller.
   */
  canAccessProjectAgent(
    context: WorkspaceContext,
    projectId: string,
    squadId: string,
    agentId: string
  ): boolean {
    if (!this.canAccessProject(context, projectId)) return false;
    if (!this.squadAssignedToProject(context.workspaceId, squadId, projectId)) return false;
    if (!this.canAccessSquad(context, squadId)) return false;

    const squad = this.db.prepare('SELECT member_agent_ids FROM squads WHERE id = ?').get(squadId) as
      | { member_agent_ids?: string }
      | undefined;
    const members = this.parseIds(squad?.member_agent_ids);
    if (!members.includes(agentId)) return false;

    const agent = this.db.prepare(`
      SELECT allowed_users, owner, is_archived
      FROM agents
      WHERE id = ?
    `).get(agentId) as {
      allowed_users?: string | null;
      owner?: string | null;
      is_archived?: number;
    } | undefined;
    if (!agent || Boolean(agent.is_archived)) return false;
    if (!this.belongsTo('agents', agentId, context.workspaceId)) return false;

    const visibility = agent.allowed_users ?? 'team';
    if (visibility === 'admins') return context.role === 'admin';
    if (visibility === 'private') return agent.owner === context.userId;
    if (visibility === 'team') return context.role !== 'client';
    return visibility === 'everyone';
  }

  private parseIds(value?: string | null): string[] {
    if (!value) return [];
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : [];
    } catch {
      return [];
    }
  }

  canAccessLiveBuildRoom(context: WorkspaceContext, projectId: string): boolean {
    if (context.role === 'client' || !this.canAccessProject(context, projectId)) return false;
    return this.listProjectSquadIds(context.workspaceId, projectId)
      .some(squadId => this.canAccessSquad(context, squadId));
  }

  scopeProjectChildrenFromIds<T extends { id: string }>(
    entityType: EntityType,
    rows: T[],
    context: WorkspaceContext,
    allowedProjectIds: Set<string>,
    projectIdOf: (row: T) => string | undefined
  ): T[] {
    return this.scope(entityType, rows, context.workspaceId)
      .filter(row => {
        const projectId = projectIdOf(row);
        return projectId ? allowedProjectIds.has(projectId) : false;
      });
  }

  listProjectAssignments(workspaceId: string, projectId?: string): WorkspaceProjectAssignment[] {
    const rows = this.db.prepare(`
      SELECT * FROM workspace_project_assignments
      WHERE workspace_id = ? ${projectId ? 'AND project_id = ?' : ''}
      ORDER BY created_at ASC
    `).all(...(projectId ? [workspaceId, projectId] : [workspaceId])) as any[];
    return rows.map(row => ({
      id: row.id,
      workspaceId: row.workspace_id,
      projectId: row.project_id,
      userId: row.user_id,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  assignProject(workspaceId: string, projectId: string, userId: string): WorkspaceProjectAssignment {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO workspace_project_assignments
        (id, workspace_id, project_id, user_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?)
      ON CONFLICT(workspace_id, project_id, user_id)
      DO UPDATE SET status = 'active', updated_at = excluded.updated_at
    `).run(`project-assignment-${randomUUID()}`, workspaceId, projectId, userId, now, now);
    return this.listProjectAssignments(workspaceId, projectId).find(row => row.userId === userId)!;
  }

  removeProjectAssignment(workspaceId: string, projectId: string, userId: string): boolean {
    const result = this.db.prepare(`
      UPDATE workspace_project_assignments
      SET status = 'removed', updated_at = ?
      WHERE workspace_id = ? AND project_id = ? AND user_id = ? AND status = 'active'
    `).run(new Date().toISOString(), workspaceId, projectId, userId);
    return result.changes > 0;
  }

  entityWorkspace(entityType: EntityType, entityId: string): string | null {
    const row = this.db.prepare(
      'SELECT workspace_id FROM workspace_entity_bindings WHERE entity_type = ? AND entity_id = ?'
    ).get(entityType, entityId) as { workspace_id: string } | undefined;
    return row?.workspace_id ?? null;
  }

  bind(entityType: EntityType, entityId: string, workspaceId: string): void {
    this.db.prepare(`
      INSERT INTO workspace_entity_bindings (entity_type, entity_id, workspace_id, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(entity_type, entity_id) DO UPDATE SET workspace_id = excluded.workspace_id
    `).run(entityType, entityId, workspaceId, new Date().toISOString());
  }

  unbind(entityType: EntityType, entityId: string): void {
    this.db.prepare(
      'DELETE FROM workspace_entity_bindings WHERE entity_type = ? AND entity_id = ?'
    ).run(entityType, entityId);
    if (entityType === 'squads') {
      this.db.prepare('UPDATE workspace_squad_owners SET status = \'removed\', updated_at = ? WHERE squad_id = ?')
        .run(new Date().toISOString(), entityId);
    }
  }

  belongsTo(entityType: EntityType, entityId: string, workspaceId: string): boolean {
    const bound = this.entityWorkspace(entityType, entityId);
    return bound ? bound === workspaceId : workspaceId === this.defaultWorkspaceId;
  }

  scope<T extends { id: string }>(entityType: EntityType, rows: T[], workspaceId: string): T[] {
    return rows.filter(row => this.belongsTo(entityType, row.id, workspaceId));
  }

  /**
   * Preserve legacy issue-level squad assignments while the normalized
   * project/squad relation is introduced. This is intentionally idempotent and
   * read-triggered so existing installations do not need a destructive data
   * migration before the room becomes useful.
   */
  private ensureLegacySquadProjectAssignments(): void {
    try {
      const rows = this.db.prepare(`
        SELECT DISTINCT project_id, assigned_squad_id
        FROM issues
        WHERE project_id IS NOT NULL
          AND assigned_squad_id IS NOT NULL
          AND assigned_squad_id <> ''
      `).all() as Array<{ project_id: string; assigned_squad_id: string }>;
      if (!rows.length) return;

      const now = new Date().toISOString();
      const insert = this.db.prepare(`
        INSERT INTO workspace_squad_projects
          (id, workspace_id, squad_id, project_id, relationship, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'assigned', 'active', ?, ?)
        ON CONFLICT(workspace_id, squad_id, project_id)
        DO UPDATE SET status = 'active', updated_at = excluded.updated_at
      `);
      const tx = this.db.transaction(() => {
        for (const row of rows) {
          insert.run(
            `squad-project-legacy-${row.assigned_squad_id}-${row.project_id}`,
            this.defaultWorkspaceId,
            row.assigned_squad_id,
            row.project_id,
            now,
            now
          );
        }
      });
      tx();
    } catch {
      // A fresh database may not have the issues table yet. The next access
      // will retry after the regular SQLite migrations have completed.
    }
  }

  getDefaultWorkspaceId(): string {
    return this.defaultWorkspaceId;
  }
}

export const workspaceRegistry = new WorkspaceRegistry();
