import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

import {
  iso,
  knownRole,
  slugify,
  WorkspaceRequestError,
  type WorkspaceAccess,
  type WorkspaceContext,
  type WorkspaceDirectory,
  type WorkspaceMember,
  type WorkspaceMemberStatus,
  type WorkspaceProjectAssignment,
  type WorkspaceRole,
  type WorkspaceSquadProjectAssignment,
  type WorkspaceSummary
} from './workspaceDirectory.js';

/**
 * The directory on a developer's machine.
 *
 * SQLite, in the same file as everything else the desktop keeps, and
 * synchronous underneath -- the async surface is the interface's, not this
 * store's. One process serves one person here, so there is nothing to share
 * and nothing to survive a deploy.
 */
export class SqliteWorkspaceDirectory implements WorkspaceDirectory {
  constructor(
    private readonly db: Database.Database,
    private readonly defaultWorkspaceId: string
  ) {
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'active',
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
      CREATE INDEX IF NOT EXISTS idx_workspace_project_assignments_user
        ON workspace_project_assignments(workspace_id, user_id, status);
      CREATE INDEX IF NOT EXISTS idx_workspace_project_assignments_project
        ON workspace_project_assignments(workspace_id, project_id, status);
      CREATE INDEX IF NOT EXISTS idx_workspace_squad_owners_user
        ON workspace_squad_owners(workspace_id, user_id, status);
      CREATE INDEX IF NOT EXISTS idx_workspace_squad_projects_project
        ON workspace_squad_projects(workspace_id, project_id, status);
    `);

    // Columns added after the table shipped. `CREATE TABLE IF NOT EXISTS` is a
    // no-op on an existing table, so each one is attempted and its "duplicate
    // column" error ignored.
    for (const statement of [
      "ALTER TABLE workspaces ADD COLUMN settings_json TEXT NOT NULL DEFAULT '{}'",
      "ALTER TABLE workspaces ADD COLUMN status TEXT NOT NULL DEFAULT 'active'",
      "ALTER TABLE workspaces ADD COLUMN created_by TEXT NOT NULL DEFAULT 'system'",
      "ALTER TABLE workspace_squad_projects ADD COLUMN relationship TEXT NOT NULL DEFAULT 'assigned'",
      // Joining by code is gone, so the column it read goes too. The index
      // first: SQLite refuses to drop a column an index still names. A desktop
      // that never had either simply fails both, which this loop ignores.
      'DROP INDEX IF EXISTS idx_workspaces_join_code',
      'ALTER TABLE workspaces DROP COLUMN join_code'
    ]) {
      try {
        this.db.exec(statement);
      } catch {
        // Already applied on this installation.
      }
    }

    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO workspaces (id, name, slug, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, 'active', ?, ?, ?)`
      )
      .run(this.defaultWorkspaceId, 'Alpha Workspace', 'alpha-workspace', 'system', now, now);
  }

  private summary(row: any, role: WorkspaceRole): WorkspaceSummary {
    const memberCount = Number(
      (
        this.db
          .prepare("SELECT COUNT(*) AS count FROM workspace_members WHERE workspace_id = ? AND status = 'active'")
          .get(row.id) as { count?: number } | undefined
      )?.count ?? 0
    );

    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      status: row.status,
      role,
      memberCount,
      // The invite code is an admin's to hand out, and nobody else's to read.
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at)
    };
  }

  /**
   * Enrol a first-time caller in the default workspace, at the role GitHub
   * gave them.
   *
   * `suggestedRole ?? 'admin'` used to sit on that last field, and it was the
   * single most dangerous line in the permission system: any account this
   * function had not seen before became a workspace administrator.
   *
   * Now: no role, no membership. `identityService` refuses a GitHub account
   * that belongs to no mapped team before the request reaches this far, so a
   * missing role here means a path that bypassed that gate, and enrolling
   * nobody is the safe answer. Admin comes from the `admins` team, never from
   * arriving.
   */
  private ensureMember(userId: string, teamRole?: WorkspaceRole): void {
    if (!teamRole) return;

    const existing = this.db
      .prepare('SELECT id FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
      .get(this.defaultWorkspaceId, userId);
    if (existing) return;

    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO workspace_members (id, workspace_id, user_id, role, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?)`
      )
      .run(`member-${randomUUID()}`, this.defaultWorkspaceId, userId, teamRole, now, now);
  }

  async listForUser(userId: string, teamRole?: WorkspaceRole): Promise<WorkspaceSummary[]> {
    this.ensureMember(userId, teamRole);
    const rows = this.db
      .prepare(
        `SELECT w.*, m.role AS member_role
         FROM workspaces w
         INNER JOIN workspace_members m ON m.workspace_id = w.id
         WHERE m.user_id = ? AND m.status = 'active' AND w.status = 'active'
         ORDER BY w.created_at ASC`
      )
      .all(userId) as any[];

    return rows
      .map(row => {
        const role = knownRole(row.member_role);
        return role ? this.summary(row, role) : null;
      })
      .filter((summary): summary is WorkspaceSummary => summary !== null);
  }

  async resolve(
    userId: string,
    requestedWorkspaceId?: string,
    teamRole?: WorkspaceRole
  ): Promise<WorkspaceContext | null> {
    const available = await this.listForUser(userId, teamRole);
    const workspace = requestedWorkspaceId
      ? available.find(candidate => candidate.id === requestedWorkspaceId)
      : available[0];
    if (!workspace) return null;

    return {
      userId,
      workspaceId: workspace.id,
      role: workspace.role,
      teamRole,
      workspace,
      access: this.access(workspace.id, userId)
    };
  }

  private access(workspaceId: string, userId: string): WorkspaceAccess {
    this.ensureLegacySquadProjectAssignments();

    const assigned = this.db
      .prepare(
        `SELECT project_id FROM workspace_project_assignments
         WHERE workspace_id = ? AND user_id = ? AND status = 'active'`
      )
      .all(workspaceId, userId) as Array<{ project_id: string }>;

    const owners = this.db
      .prepare(
        `SELECT squad_id, user_id FROM workspace_squad_owners
         WHERE workspace_id = ? AND status = 'active'`
      )
      .all(workspaceId) as Array<{ squad_id: string; user_id: string }>;

    const squadProjects = this.db
      .prepare(
        `SELECT squad_id, project_id FROM workspace_squad_projects
         WHERE workspace_id = ? AND status = 'active'`
      )
      .all(workspaceId) as Array<{ squad_id: string; project_id: string }>;

    return {
      assignedProjectIds: new Set(assigned.map(row => row.project_id)),
      squadOwners: new Map(owners.map(row => [row.squad_id, row.user_id])),
      squadProjects: squadProjects.map(row => ({ squadId: row.squad_id, projectId: row.project_id }))
    };
  }

  async createWorkspace(userId: string, input: { name: string; slug?: string }): Promise<WorkspaceSummary> {
    const name = input.name.trim();
    if (!name) throw new WorkspaceRequestError('Workspace name is required.', 400);

    const now = new Date().toISOString();
    const id = `workspace-${randomUUID()}`;
    const slugBase = slugify(input.slug || name);
    let slug = slugBase;
    let suffix = 2;
    while (this.db.prepare('SELECT 1 FROM workspaces WHERE slug = ?').get(slug)) {
      slug = `${slugBase}-${suffix++}`;
    }

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO workspaces (id, name, slug, status, created_by, created_at, updated_at)
           VALUES (?, ?, ?, 'active', ?, ?, ?)`
        )
        .run(id, name, slug, userId, now, now);

      this.db
        .prepare(
          `INSERT INTO workspace_members (id, workspace_id, user_id, role, status, created_at, updated_at)
           VALUES (?, ?, ?, 'admin', 'active', ?, ?)`
        )
        .run(`member-${randomUUID()}`, id, userId, now, now);
    })();

    const row = this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as any;
    return this.summary(row, 'admin');
  }

  async updateWorkspace(
    workspaceId: string,
    input: { name?: string; slug?: string },
    callerRole: WorkspaceRole
  ): Promise<WorkspaceSummary | null> {
    const current = this.db
      .prepare("SELECT * FROM workspaces WHERE id = ? AND status = 'active'")
      .get(workspaceId) as any;
    if (!current) return null;

    const name = input.name === undefined ? current.name : input.name.trim();
    const slug = input.slug === undefined ? current.slug : slugify(input.slug);
    if (!name) throw new WorkspaceRequestError('Workspace name is required.', 400);
    if (this.db.prepare('SELECT id FROM workspaces WHERE slug = ? AND id <> ?').get(slug, workspaceId)) {
      throw new WorkspaceRequestError('That workspace slug is already in use.', 409);
    }

    this.db
      .prepare('UPDATE workspaces SET name = ?, slug = ?, updated_at = ? WHERE id = ?')
      .run(name, slug, new Date().toISOString(), workspaceId);
    const row = this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId) as any;
    return this.summary(row, callerRole);
  }

  async addMember(workspaceId: string, userId: string, role: WorkspaceRole): Promise<WorkspaceMember> {
    const login = userId.trim();
    if (!login) throw new WorkspaceRequestError('Who to add is required.', 400);

    const now = new Date().toISOString();
    const existing = this.db
      .prepare('SELECT * FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
      .get(workspaceId, login) as any;

    if (existing) {
      this.db
        .prepare("UPDATE workspace_members SET role = ?, status = 'active', updated_at = ? WHERE id = ?")
        .run(role, now, existing.id);
    } else {
      this.db
        .prepare(
          `INSERT INTO workspace_members (id, workspace_id, user_id, role, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'active', ?, ?)`
        )
        .run(`member-${randomUUID()}`, workspaceId, login, role, now, now);
    }

    const row = this.db
      .prepare('SELECT * FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
      .get(workspaceId, login) as any;
    return {
      id: row.id,
      userId: row.user_id,
      role: knownRole(row.role) ?? role,
      status: row.status as WorkspaceMemberStatus,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at)
    };
  }

  async listMembers(workspaceId: string): Promise<WorkspaceMember[]> {
    const rows = this.db
      .prepare('SELECT * FROM workspace_members WHERE workspace_id = ? ORDER BY created_at ASC')
      .all(workspaceId) as any[];
    return rows
      .map(row => {
        const role = knownRole(row.role);
        return role
          ? {
              id: row.id,
              userId: row.user_id,
              role,
              status: row.status as WorkspaceMemberStatus,
              createdAt: iso(row.created_at),
              updatedAt: iso(row.updated_at)
            }
          : null;
      })
      .filter((member): member is WorkspaceMember => member !== null);
  }

  async updateMember(
    workspaceId: string,
    memberId: string,
    input: { role?: WorkspaceRole; status?: WorkspaceMemberStatus }
  ): Promise<WorkspaceMember | null> {
    const current = this.db
      .prepare('SELECT * FROM workspace_members WHERE id = ? AND workspace_id = ?')
      .get(memberId, workspaceId) as any;
    if (!current) return null;

    this.db
      .prepare('UPDATE workspace_members SET role = ?, status = ?, updated_at = ? WHERE id = ? AND workspace_id = ?')
      .run(
        input.role ?? current.role,
        input.status ?? current.status,
        new Date().toISOString(),
        memberId,
        workspaceId
      );
    return (await this.listMembers(workspaceId)).find(member => member.id === memberId) ?? null;
  }

  async listProjectAssignments(workspaceId: string, projectId?: string): Promise<WorkspaceProjectAssignment[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM workspace_project_assignments
         WHERE workspace_id = ? ${projectId ? 'AND project_id = ?' : ''}
         ORDER BY created_at ASC`
      )
      .all(...(projectId ? [workspaceId, projectId] : [workspaceId])) as any[];
    return rows.map(row => ({
      id: row.id,
      workspaceId: row.workspace_id,
      projectId: row.project_id,
      userId: row.user_id,
      status: row.status,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at)
    }));
  }

  async assignProject(workspaceId: string, projectId: string, userId: string): Promise<WorkspaceProjectAssignment> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO workspace_project_assignments (id, workspace_id, project_id, user_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?)
         ON CONFLICT(workspace_id, project_id, user_id)
         DO UPDATE SET status = 'active', updated_at = excluded.updated_at`
      )
      .run(`project-assignment-${randomUUID()}`, workspaceId, projectId, userId, now, now);
    return (await this.listProjectAssignments(workspaceId, projectId)).find(row => row.userId === userId)!;
  }

  async removeProjectAssignment(workspaceId: string, projectId: string, userId: string): Promise<boolean> {
    const result = this.db
      .prepare(
        `UPDATE workspace_project_assignments SET status = 'removed', updated_at = ?
         WHERE workspace_id = ? AND project_id = ? AND user_id = ? AND status = 'active'`
      )
      .run(new Date().toISOString(), workspaceId, projectId, userId);
    return result.changes > 0;
  }

  async bindSquadOwner(workspaceId: string, squadId: string, userId: string): Promise<void> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO workspace_squad_owners (id, workspace_id, squad_id, user_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?)
         ON CONFLICT(workspace_id, squad_id)
         DO UPDATE SET user_id = excluded.user_id, status = 'active', updated_at = excluded.updated_at`
      )
      .run(`squad-owner-${randomUUID()}`, workspaceId, squadId, userId, now, now);
  }

  async releaseSquadOwner(squadId: string): Promise<void> {
    this.db
      .prepare("UPDATE workspace_squad_owners SET status = 'removed', updated_at = ? WHERE squad_id = ?")
      .run(new Date().toISOString(), squadId);
  }

  async assignSquadProject(
    workspaceId: string,
    squadId: string,
    projectId: string,
    relationship: 'owned' | 'assigned'
  ): Promise<WorkspaceSquadProjectAssignment> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO workspace_squad_projects
           (id, workspace_id, squad_id, project_id, relationship, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
         ON CONFLICT(workspace_id, squad_id, project_id)
         DO UPDATE SET relationship = excluded.relationship, status = 'active', updated_at = excluded.updated_at`
      )
      .run(`squad-project-${randomUUID()}`, workspaceId, squadId, projectId, relationship, now, now);
    return (await this.listSquadProjectAssignments(workspaceId, projectId)).find(
      assignment => assignment.squadId === squadId
    )!;
  }

  async removeSquadProject(workspaceId: string, squadId: string, projectId: string): Promise<boolean> {
    const result = this.db
      .prepare(
        `UPDATE workspace_squad_projects SET status = 'removed', updated_at = ?
         WHERE workspace_id = ? AND squad_id = ? AND project_id = ? AND status = 'active'`
      )
      .run(new Date().toISOString(), workspaceId, squadId, projectId);
    return result.changes > 0;
  }

  /** Already true: `migrate()` inserts the row when the directory opens. */
  async ensureDefaultWorkspace(): Promise<void> {}

  async listSquadProjectAssignments(
    workspaceId: string,
    projectId?: string
  ): Promise<WorkspaceSquadProjectAssignment[]> {
    this.ensureLegacySquadProjectAssignments();
    const rows = this.db
      .prepare(
        `SELECT * FROM workspace_squad_projects
         WHERE workspace_id = ? ${projectId ? 'AND project_id = ?' : ''}
         ORDER BY created_at ASC`
      )
      .all(...(projectId ? [workspaceId, projectId] : [workspaceId])) as any[];
    return rows.map(row => ({
      id: row.id,
      workspaceId: row.workspace_id,
      squadId: row.squad_id,
      projectId: row.project_id,
      relationship: row.relationship === 'owned' ? 'owned' : 'assigned',
      status: row.status,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at)
    }));
  }

  /**
   * Keep squad assignments made before the normalized table existed.
   *
   * Issues used to carry `assigned_squad_id` directly. Read-triggered and
   * idempotent, so an existing installation needs no destructive migration
   * before the Live Build Room becomes useful. Desktop only: a cloud database
   * has no rows that predate the table.
   */
  private ensureLegacySquadProjectAssignments(): void {
    try {
      const rows = this.db
        .prepare(
          `SELECT DISTINCT project_id, assigned_squad_id
           FROM issues
           WHERE project_id IS NOT NULL AND assigned_squad_id IS NOT NULL AND assigned_squad_id <> ''`
        )
        .all() as Array<{ project_id: string; assigned_squad_id: string }>;
      if (!rows.length) return;

      const now = new Date().toISOString();
      const insert = this.db.prepare(
        `INSERT INTO workspace_squad_projects
           (id, workspace_id, squad_id, project_id, relationship, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'assigned', 'active', ?, ?)
         ON CONFLICT(workspace_id, squad_id, project_id)
         DO UPDATE SET status = 'active', updated_at = excluded.updated_at`
      );
      this.db.transaction(() => {
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
      })();
    } catch {
      // A fresh database may not have the issues table yet. The next read
      // retries, after the regular SQLite migrations have run.
    }
  }
}
