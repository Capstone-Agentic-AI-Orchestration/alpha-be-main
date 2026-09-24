import { randomUUID } from 'node:crypto';

import type { Sql } from './database.js';
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
 * The directory in the cloud.
 *
 * The same rules as the desktop's, in Postgres, where they survive a deploy.
 * Both are exercised by one contract test, so "the same" is checked rather
 * than asserted.
 *
 * The statements are written for the round trips they cost. A request
 * resolves its workspace and then asks what the caller may reach, so that is
 * two queries -- not two per permission check, which is what it would be if
 * the desktop's per-lookup shape were carried over a network.
 */
export class PostgresWorkspaceDirectory implements WorkspaceDirectory {
  private seeded: Promise<void> | null = null;

  constructor(
    private readonly sql: Sql,
    private readonly defaultWorkspaceId: string
  ) {}

  /**
   * The default workspace exists before anything references it.
   *
   * Every first-time caller is enrolled here, and the board's rows point at
   * it. Once per process, not once per request.
   */
  ensureDefaultWorkspace(): Promise<void> {
    this.seeded ??= this.sql
      .query(
        `insert into workspaces (id, name, slug, status, created_by)
         values ($1, 'Alpha Workspace', 'alpha-workspace', 'active', 'system')
         on conflict (id) do nothing`,
        [this.defaultWorkspaceId]
      )
      .then(() => undefined);
    return this.seeded;
  }

  private summary(row: any, role: WorkspaceRole): WorkspaceSummary {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      status: row.status,
      role,
      memberCount: Number(row.member_count ?? 0),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at)
    };
  }

  private async workspaceRow(workspaceId: string): Promise<any | null> {
    const { rows } = await this.sql.query(
      `select w.*, (select count(*) from workspace_members m
                    where m.workspace_id = w.id and m.status = 'active') as member_count
       from workspaces w where w.id = $1`,
      [workspaceId]
    );
    return rows[0] ?? null;
  }

  /**
   * Enrol a first-time caller in the default workspace, at the role GitHub
   * gave them. No role, no membership -- admin comes from the `admins` team,
   * never from arriving.
   */
  private async ensureMember(userId: string, teamRole?: WorkspaceRole): Promise<boolean> {
    if (!teamRole) return false;
    const { rows } = await this.sql.query(
      `insert into workspace_members (id, workspace_id, user_id, role, status)
       values ($1, $2, $3, $4, 'active')
       on conflict (workspace_id, user_id) do nothing
       returning id`,
      [`member-${randomUUID()}`, this.defaultWorkspaceId, userId, teamRole]
    );
    return rows.length > 0;
  }

  async listForUser(userId: string, teamRole?: WorkspaceRole): Promise<WorkspaceSummary[]> {
    await this.ensureDefaultWorkspace();

    const list = async () =>
      (
        await this.sql.query<any>(
          `select w.*, m.role as member_role,
                  (select count(*) from workspace_members c
                   where c.workspace_id = w.id and c.status = 'active') as member_count
           from workspaces w
           join workspace_members m on m.workspace_id = w.id
           where m.user_id = $1 and m.status = 'active' and w.status = 'active'
           order by w.created_at asc`,
          [userId]
        )
      ).rows;

    let rows = await list();
    /*
     * Enrolment is a write, so it is attempted only when the read shows this
     * caller has no membership of the default workspace to speak of -- which
     * is once, on their first request ever, rather than on every request.
     */
    if (teamRole && !rows.some(row => row.id === this.defaultWorkspaceId)) {
      if (await this.ensureMember(userId, teamRole)) rows = await list();
    }

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
      access: await this.access(workspace.id, userId)
    };
  }

  /** One round trip for everything the request's permission checks will ask. */
  private async access(workspaceId: string, userId: string): Promise<WorkspaceAccess> {
    const { rows } = await this.sql.query<{
      assigned: string[] | null;
      owners: Array<{ squadId: string; userId: string }> | null;
      squad_projects: Array<{ squadId: string; projectId: string }> | null;
      project_rows: Array<{ id: string; createdBy: string | null }> | null;
      project_managers: string[] | null;
      squads: string[] | null;
    }>(
      `select
         (select array_agg(project_id) from workspace_project_assignments
          where workspace_id = $1 and user_id = $2 and status = 'active') as assigned,
         (select json_agg(json_build_object('squadId', squad_id, 'userId', user_id))
          from workspace_squad_owners where workspace_id = $1 and status = 'active') as owners,
         (select json_agg(json_build_object('squadId', squad_id, 'projectId', project_id))
          from workspace_squad_projects where workspace_id = $1 and status = 'active') as squad_projects,
         (select coalesce(json_agg(json_build_object('id', id, 'createdBy', created_by)), '[]'::json)
            from projects where workspace_id = $1) as project_rows,
         (select array_agg(user_id) from workspace_members
            where workspace_id = $1 and status = 'active' and role = 'pm') as project_managers,
         (select array_agg(id) from squads where workspace_id = $1) as squads`,
      [workspaceId, userId]
    );

    const row = rows[0];
    const projectRows = row?.project_rows ?? [];
    return {
      assignedProjectIds: new Set(row?.assigned ?? []),
      projectCreators: new Map(projectRows.map(project => [project.id, project.createdBy ?? null])),
      projectManagerIds: new Set(row?.project_managers ?? []),
      squadOwners: new Map((row?.owners ?? []).map(owner => [owner.squadId, owner.userId])),
      squadProjects: row?.squad_projects ?? [],
      workspaceRows: {
        projects: new Set(projectRows.map(project => project.id)),
        squads: new Set(row?.squads ?? [])
      }
    };
  }

  async createWorkspace(
    userId: string,
    input: { name: string; slug?: string },
    creatorRole: WorkspaceRole = 'admin'
  ): Promise<WorkspaceSummary> {
    await this.ensureDefaultWorkspace();
    const name = input.name.trim();
    if (!name) throw new WorkspaceRequestError('Workspace name is required.', 400);

    const slugBase = slugify(input.slug || name);
    let slug = slugBase;
    let suffix = 2;
    while ((await this.sql.query('select 1 from workspaces where slug = $1', [slug])).rows.length) {
      slug = `${slugBase}-${suffix++}`;
    }

    const id = `workspace-${randomUUID()}`;
    await this.sql.query(
      `insert into workspaces (id, name, slug, status, created_by)
       values ($1, $2, $3, 'active', $4)`,
      [id, name, slug, userId]
    );
    /*
     * Not one transaction, deliberately: `Sql` is a single statement at a
     * time. A workspace with no members is recoverable -- its creator may
     * create another -- and the alternative is a transaction abstraction
     * that only this call would use.
     */
    await this.sql.query(
      `insert into workspace_members (id, workspace_id, user_id, role, status)
       values ($1, $2, $3, $4, 'active')`,
      [`member-${randomUUID()}`, id, userId, creatorRole]
    );

    return this.summary(await this.workspaceRow(id), creatorRole);
  }

  async updateWorkspace(
    workspaceId: string,
    input: { name?: string; slug?: string },
    callerRole: WorkspaceRole
  ): Promise<WorkspaceSummary | null> {
    const current = await this.workspaceRow(workspaceId);
    if (!current || current.status !== 'active') return null;

    const name = input.name === undefined ? current.name : input.name.trim();
    const slug = input.slug === undefined ? current.slug : slugify(input.slug);
    if (!name) throw new WorkspaceRequestError('Workspace name is required.', 400);

    const collision = await this.sql.query('select id from workspaces where slug = $1 and id <> $2', [
      slug,
      workspaceId
    ]);
    if (collision.rows.length) {
      throw new WorkspaceRequestError('That workspace slug is already in use.', 409);
    }

    await this.sql.query('update workspaces set name = $1, slug = $2, updated_at = now() where id = $3', [
      name,
      slug,
      workspaceId
    ]);
    return this.summary(await this.workspaceRow(workspaceId), callerRole);
  }

  async addMember(workspaceId: string, userId: string, role: WorkspaceRole): Promise<WorkspaceMember> {
    const login = userId.trim();
    if (!login) throw new WorkspaceRequestError('Who to add is required.', 400);

    const { rows } = await this.sql.query<any>(
      `insert into workspace_members (id, workspace_id, user_id, role, status)
       values ($1, $2, $3, $4, 'active')
       on conflict (workspace_id, user_id) do update
         set role = excluded.role, status = 'active', updated_at = now()
       returning *`,
      [`member-${randomUUID()}`, workspaceId, login, role]
    );
    const row = rows[0];
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
    const { rows } = await this.sql.query<any>(
      'select * from workspace_members where workspace_id = $1 order by created_at asc',
      [workspaceId]
    );
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
    const { rows } = await this.sql.query<any>(
      `update workspace_members
       set role = coalesce($3, role), status = coalesce($4, status), updated_at = now()
       where id = $1 and workspace_id = $2
       returning *`,
      [memberId, workspaceId, input.role ?? null, input.status ?? null]
    );
    const row = rows[0];
    const role = row ? knownRole(row.role) : null;
    if (!row || !role) return null;
    return {
      id: row.id,
      userId: row.user_id,
      role,
      status: row.status as WorkspaceMemberStatus,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at)
    };
  }

  async listProjectAssignments(workspaceId: string, projectId?: string): Promise<WorkspaceProjectAssignment[]> {
    const { rows } = await this.sql.query<any>(
      `select * from workspace_project_assignments
       where workspace_id = $1 and ($2::text is null or project_id = $2)
       order by created_at asc`,
      [workspaceId, projectId ?? null]
    );
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
    const { rows } = await this.sql.query<any>(
      `insert into workspace_project_assignments (id, workspace_id, project_id, user_id, status)
       values ($1, $2, $3, $4, 'active')
       on conflict (workspace_id, project_id, user_id)
       do update set status = 'active', updated_at = now()
       returning *`,
      [`project-assignment-${randomUUID()}`, workspaceId, projectId, userId]
    );
    const row = rows[0];
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      projectId: row.project_id,
      userId: row.user_id,
      status: row.status,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at)
    };
  }

  async removeProjectAssignment(workspaceId: string, projectId: string, userId: string): Promise<boolean> {
    const { rows } = await this.sql.query(
      `update workspace_project_assignments set status = 'removed', updated_at = now()
       where workspace_id = $1 and project_id = $2 and user_id = $3 and status = 'active'
       returning id`,
      [workspaceId, projectId, userId]
    );
    return rows.length > 0;
  }

  async bindSquadOwner(workspaceId: string, squadId: string, userId: string): Promise<void> {
    await this.sql.query(
      `insert into workspace_squad_owners (id, workspace_id, squad_id, user_id, status)
       values ($1, $2, $3, $4, 'active')
       on conflict (workspace_id, squad_id)
       do update set user_id = excluded.user_id, status = 'active', updated_at = now()`,
      [`squad-owner-${randomUUID()}`, workspaceId, squadId, userId]
    );
  }

  async releaseSquadOwner(squadId: string): Promise<void> {
    await this.sql.query(
      "update workspace_squad_owners set status = 'removed', updated_at = now() where squad_id = $1",
      [squadId]
    );
  }

  async assignSquadProject(
    workspaceId: string,
    squadId: string,
    projectId: string,
    relationship: 'owned' | 'assigned'
  ): Promise<WorkspaceSquadProjectAssignment> {
    const { rows } = await this.sql.query<any>(
      `insert into workspace_squad_projects (id, workspace_id, squad_id, project_id, relationship, status)
       values ($1, $2, $3, $4, $5, 'active')
       on conflict (workspace_id, squad_id, project_id)
       do update set relationship = excluded.relationship, status = 'active', updated_at = now()
       returning *`,
      [`squad-project-${randomUUID()}`, workspaceId, squadId, projectId, relationship]
    );
    return this.squadProject(rows[0]);
  }

  async removeSquadProject(workspaceId: string, squadId: string, projectId: string): Promise<boolean> {
    const { rows } = await this.sql.query(
      `update workspace_squad_projects set status = 'removed', updated_at = now()
       where workspace_id = $1 and squad_id = $2 and project_id = $3 and status = 'active'
       returning id`,
      [workspaceId, squadId, projectId]
    );
    return rows.length > 0;
  }

  async listSquadProjectAssignments(
    workspaceId: string,
    projectId?: string
  ): Promise<WorkspaceSquadProjectAssignment[]> {
    const { rows } = await this.sql.query<any>(
      `select * from workspace_squad_projects
       where workspace_id = $1 and ($2::text is null or project_id = $2)
       order by created_at asc`,
      [workspaceId, projectId ?? null]
    );
    return rows.map(row => this.squadProject(row));
  }

  private squadProject(row: any): WorkspaceSquadProjectAssignment {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      squadId: row.squad_id,
      projectId: row.project_id,
      relationship: row.relationship === 'owned' ? 'owned' : 'assigned',
      status: row.status,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at)
    };
  }
}
