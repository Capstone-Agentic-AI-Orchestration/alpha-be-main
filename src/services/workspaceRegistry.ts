import Database from 'better-sqlite3';

import { DB_PATH, IS_CLOUD } from '../config/env.js';
import { database } from '../store/database.js';
import { agentStore, squadStore } from '../store/stores.js';
import { PostgresWorkspaceDirectory } from '../store/postgresWorkspaceDirectory.js';
import { SqliteWorkspaceDirectory } from '../store/sqliteWorkspaceDirectory.js';
import type {
  WorkspaceDirectory,
  WorkspaceMember,
  WorkspaceMemberStatus,
  WorkspaceProjectAssignment,
  WorkspaceSquadProjectAssignment,
  WorkspaceSummary
} from '../store/workspaceDirectory.js';
import { DEFAULT_WORKSPACE_ID } from './workspaceContext.js';
import { DesktopStoreInCloudError, openDesktopStore } from './sqliteService.js';

export type {
  WorkspaceContext,
  WorkspaceMember,
  WorkspaceMemberStatus,
  WorkspaceProjectAssignment,
  WorkspaceRole,
  WorkspaceSquadProjectAssignment,
  WorkspaceSummary
} from '../store/workspaceDirectory.js';
export { WorkspaceRequestError } from '../store/workspaceDirectory.js';

import type { WorkspaceContext, WorkspaceRole } from '../store/workspaceDirectory.js';

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
  | 'workspace.bind_local'
  | 'project.read'
  | 'project.create'
  | 'project.update'
  | 'project.manage'
  /** Provision a new remote repository; project managers own this action. */
  | 'project.provision_repository'
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
    /*
     * Who else is in this workspace. Knowing your colleagues is not
     * privileged -- the row-level policy on `workspace_members` says as much,
     * and has all along, while this list did not: a developer's team view
     * answered 403.
     */
    'workspace.read_members',
    'project.read',
    /*
     * Developers run projects day to day -- status, details, resources, the
     * build pipeline -- but a project is started by a project manager, and
     * who is assigned to it is a PM's call: `project.create` and
     * `project.manage` stay with them.
     */
    'project.update',
    'issue.read',
    'issue.manage',
    'agent.read',
    'agent.run',
    'squad.read',
    'squad.run',
    'squad.manage',
    'chat.read',
    'chat.write',
    'deployment.read',
    /*
     * Point this machine at a folder for a project. A developer's own act on
     * their own disk, which is why it is not `project.manage`: that is the
     * right to change the project for everyone, and asking for it here meant
     * only a project manager could attach their own checkout.
     */
    'workspace.bind_local'
  ],
  pm: [
    'workspace.read',
    'workspace.read_members',
    /*
     * A project manager staffs their own workspace: they put the developers
     * and the other managers in it. Granting `admin` is still an admin's to
     * do, which the route checks -- this capability says who may change a
     * membership, not which roles they may hand out.
     */
    'workspace.manage_members',
    'project.read',
    'project.create',
    'project.update',
    'project.manage',
    'issue.read',
    'issue.manage',
    'project.provision_repository',
    'agent.read',
    'squad.read',
    'chat.read',
    'chat.write',
    'deployment.read',
    'deployment.manage',
    'analytics.read',
    'workspace.manage_settings',
    'workspace.bind_local'
  ],
  admin: [
    'workspace.read',
    'workspace.read_members',
    'workspace.manage_members',
    'workspace.manage_settings',
    'project.read',
    // No `project.create`: a project is started by a project manager, and one
    // an admin made would have no PM behind it and sit outside the catalogue.
    'project.update',
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

/**
 * Who may do what, and which rows belong to which workspace.
 *
 * Two things live behind this one object, and they are at different stages of
 * moving off SQLite:
 *
 *  - **The directory** — workspaces, members, and what each member is
 *    assigned to. Postgres in the cloud, SQLite on the desktop, behind
 *    `WorkspaceDirectory`. Asynchronous, because Postgres is.
 *  - **Entity bindings** — which workspace a project, issue, run or thread
 *    belongs to. On a desktop, a side table in SQLite. In the cloud there is
 *    no side table: every Postgres row carries its own `workspace_id`, and
 *    `inWorkspace` answers from the rows (see `WorkspaceAccess.workspaceRows`).
 *
 * The permission checks stay synchronous. They run over every row of every
 * list, and a database round trip each is what made "await everywhere"
 * unaffordable rather than merely noisy. Instead, the facts one caller needs
 * are read once when their workspace is resolved -- `WorkspaceAccess`, on the
 * request's context -- and the checks below are pure functions of it.
 */
class WorkspaceRegistry {
  private db: Database.Database | null = null;
  private directoryInstance: WorkspaceDirectory | null = null;
  private readonly defaultWorkspaceId = DEFAULT_WORKSPACE_ID;

  /**
   * Opened on first use rather than at import.
   *
   * The cloud reaches for the directory, never for this, on every path that
   * has moved; a module-level `new Database()` opened a file on Render's
   * ephemeral disk before any of that could be decided.
   */
  private handle(): Database.Database {
    // The cloud's bindings are the rows' own workspace_id; see inWorkspace.
    if (IS_CLOUD) throw new DesktopStoreInCloudError();
    if (!this.db) {
      openDesktopStore();
      const db = new Database(DB_PATH);
      db.pragma('journal_mode = WAL');
      db.pragma('busy_timeout = 5000');
      /*
       * Bindings reference workspaces this file may not hold: in the cloud the
       * workspace rows live in Postgres. The reference is dropped rather than
       * mirrored, since the table itself goes when the board moves.
       */
      db.pragma('foreign_keys = OFF');
      db.exec(`
        CREATE TABLE IF NOT EXISTS workspace_entity_bindings (
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(entity_type, entity_id)
        );
        CREATE INDEX IF NOT EXISTS idx_workspace_bindings_workspace
          ON workspace_entity_bindings(workspace_id, entity_type);
      `);
      this.db = db;
    }
    return this.db;
  }

  /** Workspaces, members and assignments: Postgres in the cloud, SQLite on a desktop. */
  directory(): WorkspaceDirectory {
    this.directoryInstance ??= IS_CLOUD
      ? new PostgresWorkspaceDirectory(database(), this.defaultWorkspaceId)
      : new SqliteWorkspaceDirectory(this.handle(), this.defaultWorkspaceId);
    return this.directoryInstance;
  }

  /** For tests, which supply their own store rather than a mode's. */
  useDirectory(directory: WorkspaceDirectory | null): void {
    this.directoryInstance = directory;
  }

  close(): void {
    this.db?.close();
    this.db = null;
    this.directoryInstance = null;
  }

  getDefaultWorkspaceId(): string {
    return this.defaultWorkspaceId;
  }

  // ── The directory ────────────────────────────────────────────────────────

  resolve(userId: string, requestedWorkspaceId?: string, teamRole?: WorkspaceRole) {
    return this.directory().resolve(userId, requestedWorkspaceId, teamRole);
  }

  listForUser(userId: string, teamRole?: WorkspaceRole): Promise<WorkspaceSummary[]> {
    return this.directory().listForUser(userId, teamRole);
  }

  createWorkspace(
    userId: string,
    input: { name: string; slug?: string },
    creatorRole?: WorkspaceRole
  ): Promise<WorkspaceSummary> {
    return this.directory().createWorkspace(userId, input, creatorRole);
  }

  updateWorkspace(
    workspaceId: string,
    input: { name?: string; slug?: string },
    callerRole: WorkspaceRole
  ): Promise<WorkspaceSummary | null> {
    return this.directory().updateWorkspace(workspaceId, input, callerRole);
  }

  /** A desktop's copy of the cloud's memberships; see `SqliteWorkspaceDirectory.mirrorMemberships`. */
  mirrorMemberships(
    userId: string,
    workspaces: Array<{ id: string; name: string; slug: string; role: WorkspaceRole }>
  ): void {
    const directory = this.directory();
    if (directory instanceof SqliteWorkspaceDirectory) directory.mirrorMemberships(userId, workspaces);
  }

  listMembers(workspaceId: string): Promise<WorkspaceMember[]> {
    return this.directory().listMembers(workspaceId);
  }

  addMember(workspaceId: string, userId: string, role: WorkspaceRole): Promise<WorkspaceMember> {
    return this.directory().addMember(workspaceId, userId, role);
  }

  updateMember(
    workspaceId: string,
    memberId: string,
    input: { role?: WorkspaceRole; status?: WorkspaceMemberStatus }
  ): Promise<WorkspaceMember | null> {
    return this.directory().updateMember(workspaceId, memberId, input);
  }

  listProjectAssignments(workspaceId: string, projectId?: string): Promise<WorkspaceProjectAssignment[]> {
    return this.directory().listProjectAssignments(workspaceId, projectId);
  }

  assignProject(workspaceId: string, projectId: string, userId: string): Promise<WorkspaceProjectAssignment> {
    return this.directory().assignProject(workspaceId, projectId, userId);
  }

  removeProjectAssignment(workspaceId: string, projectId: string, userId: string): Promise<boolean> {
    return this.directory().removeProjectAssignment(workspaceId, projectId, userId);
  }

  bindSquadOwner(workspaceId: string, squadId: string, userId: string): Promise<void> {
    return this.directory().bindSquadOwner(workspaceId, squadId, userId);
  }

  assignSquadProject(
    workspaceId: string,
    squadId: string,
    projectId: string,
    relationship: 'owned' | 'assigned' = 'assigned'
  ): Promise<WorkspaceSquadProjectAssignment> {
    return this.directory().assignSquadProject(workspaceId, squadId, projectId, relationship);
  }

  removeSquadProject(workspaceId: string, squadId: string, projectId: string): Promise<boolean> {
    return this.directory().removeSquadProject(workspaceId, squadId, projectId);
  }

  listSquadProjectAssignments(
    workspaceId: string,
    projectId?: string
  ): Promise<WorkspaceSquadProjectAssignment[]> {
    return this.directory().listSquadProjectAssignments(workspaceId, projectId);
  }

  ensureDefaultWorkspace(): Promise<void> {
    return this.directory().ensureDefaultWorkspace();
  }

  // ── Checks, from the context loaded for this request ─────────────────────

  can(role: WorkspaceRole, capability: WorkspaceCapability): boolean {
    return CAPABILITIES[role].includes(capability);
  }

  /**
   * Whether this caller may know the project exists.
   *
   * Everyone inside the workspace may, clients aside: a developer has to be
   * able to find the project they are about to be put on, and to bind it to a
   * folder before anyone assigns them an issue in it. Discovery is not access
   * -- `canAccessProject` below still decides whose issues, runs and chats a
   * person may reach, and it stays assignment-scoped.
   */
  canDiscoverProject(context: WorkspaceContext, projectId: string): boolean {
    if (!this.inWorkspace(context, 'projects', projectId)) return false;
    if (context.role === 'client') return this.canAccessProject(context, projectId);
    return this.isPmOwnedProject(context, projectId);
  }

  /** The workspace's projects, as this caller may discover them. */
  discoverableProjects<T extends { id: string }>(rows: T[], context: WorkspaceContext): T[] {
    return rows.filter(row => this.canDiscoverProject(context, row.id));
  }

  /**
   * PMs and admins have workspace-wide project visibility. Clients and
   * developers are assignment-scoped, and an empty assignment set is
   * intentionally empty rather than a reason to fall back to all projects.
   */
  canAccessProject(context: WorkspaceContext, projectId: string): boolean {
    if (!this.inWorkspace(context, 'projects', projectId)) return false;
    if (context.role === 'pm' || context.role === 'admin') return this.isPmOwnedProject(context, projectId);
    return context.access.assignedProjectIds.has(projectId);
  }

  /**
   * Whether an active project manager of this workspace created the project.
   *
   * That is what puts a project in the workspace's catalogue (fe #32): the
   * organisation's repositories are not all projects, and one with no PM
   * behind it is nobody's to run. Answered from the snapshot loaded with the
   * request, so list filters stay synchronous.
   *
   * No PM list -- a team's desktop, see `WorkspaceAccess.projectManagerIds`
   * -- means the cloud already vetted every creator, so any creator counts.
   * No creator never counts. A context from an older caller with no creator
   * map at all keeps the previous behaviour rather than hiding everything.
   */
  private isPmOwnedProject(context: WorkspaceContext, projectId: string): boolean {
    const creators = context.access.projectCreators;
    if (!creators) return context.role !== 'client';
    const creator = creators.get(projectId);
    if (!creator) return false;
    const managers = context.access.projectManagerIds;
    return managers ? managers.has(creator) : true;
  }

  projectIdsFor(context: WorkspaceContext, projectIds: string[]): Set<string> {
    return new Set(projectIds.filter(projectId => this.canAccessProject(context, projectId)));
  }

  scopeProjects<T extends { id: string }>(rows: T[], context: WorkspaceContext): T[] {
    return rows.filter(row => this.canAccessProject(context, row.id));
  }

  canAccessSquad(context: WorkspaceContext, squadId: string): boolean {
    if (!this.inWorkspace(context, 'squads', squadId)) return false;
    if (context.role === 'pm' || context.role === 'admin') return true;
    return context.access.squadOwners.get(squadId) === context.userId;
  }

  scopeSquads<T extends { id: string }>(rows: T[], context: WorkspaceContext): T[] {
    return this.scope('squads', rows, context.workspaceId).filter(row => this.canAccessSquad(context, row.id));
  }

  squadOwnerId(context: WorkspaceContext, squadId: string): string | undefined {
    return context.access.squadOwners.get(squadId);
  }

  squadAssignedToProject(context: WorkspaceContext, squadId: string, projectId: string): boolean {
    return context.access.squadProjects.some(link => link.squadId === squadId && link.projectId === projectId);
  }

  listProjectSquadIds(context: WorkspaceContext, projectId: string): string[] {
    return context.access.squadProjects
      .filter(link => link.projectId === projectId)
      .map(link => link.squadId);
  }

  /**
   * Squads that are both assigned to a project and visible to this caller.
   * Project assignment is a separate relationship from squad ownership: a
   * reusable squad may serve several projects, while a developer still only
   * sees squads they own and projects they are assigned to.
   */
  projectSquadIdsFor(context: WorkspaceContext, projectId: string): string[] {
    if (!this.canAccessProject(context, projectId)) return [];
    return this.listProjectSquadIds(context, projectId).filter(squadId => this.canAccessSquad(context, squadId));
  }

  canAccessLiveBuildRoom(context: WorkspaceContext, projectId: string): boolean {
    if (context.role === 'client' || !this.canAccessProject(context, projectId)) return false;
    return this.listProjectSquadIds(context, projectId).some(squadId => this.canAccessSquad(context, squadId));
  }

  /**
   * Authorize one concrete agent call without trusting a client-supplied
   * roster. The agent must be a member of an active squad assignment for the
   * project, the caller must be allowed to use that squad, and the agent's own
   * visibility setting must allow the caller.
   */
  async canAccessProjectAgent(
    context: WorkspaceContext,
    projectId: string,
    squadId: string,
    agentId: string
  ): Promise<boolean> {
    if (!this.canAccessProject(context, projectId)) return false;
    if (!this.squadAssignedToProject(context, squadId, projectId)) return false;
    if (!this.canAccessSquad(context, squadId)) return false;

    /*
     * Read through the stores, not this file's SQLite handle. The roster is
     * Postgres in the cloud, and asking the local file there answered "no such
     * agent" for every agent that exists -- so a project manager saw an empty
     * roster while the agents sat in the shared database.
     */
    const squad = await squadStore().get(context.workspaceId, squadId);
    if (!squad?.memberAgentIds?.includes(agentId)) return false;

    const agent = await agentStore().get(context.workspaceId, agentId);
    if (!agent || agent.isArchived) return false;

    const visibility = agent.allowedUsers ?? 'team';
    if (visibility === 'admins') return context.role === 'admin';
    if (visibility === 'private') return agent.owner === context.userId;
    if (visibility === 'team') return context.role !== 'client';
    return visibility === 'everyone';
  }

  scopeProjectChildrenFromIds<T extends { id: string }>(
    entityType: EntityType,
    rows: T[],
    context: WorkspaceContext,
    allowedProjectIds: Set<string>,
    projectIdOf: (row: T) => string | undefined
  ): T[] {
    return this.scope(entityType, rows, context.workspaceId).filter(row => {
      const projectId = projectIdOf(row);
      return projectId ? allowedProjectIds.has(projectId) : false;
    });
  }

  // ── Entity bindings ──────────────────────────────────────────────────────

  /**
   * Whether an entity is in the caller's workspace at all.
   *
   * In the cloud each row says so itself. Projects and squads are checked
   * against the ids loaded with the request, because the permission checks
   * that ask about them run synchronously over whole lists. Every other kind
   * is read through a store that selects `where workspace_id = $1`, so a row
   * from another workspace is not found by the read that follows the check --
   * that read is the check, and this one does not repeat it.
   *
   * On a desktop, the row's own `workspace_id`, like the cloud; see
   * `entityWorkspace`.
   */
  inWorkspace(context: WorkspaceContext, entityType: EntityType, entityId: string): boolean {
    const rows = context.access.workspaceRows;
    if (!rows) return this.belongsTo(entityType, entityId, context.workspaceId);
    if (entityType === 'projects') return rows.projects.has(entityId);
    if (entityType === 'squads') return rows.squads.has(entityId);
    return true;
  }

  /**
   * Which workspace an entity is in: what its own row says.
   *
   * This used to be the bindings side table alone, which only the API's
   * create routes wrote to. Every other way a row arrives -- the team board
   * pull, adopting a project, seeding, a run the runner starts -- left it
   * unbound, and an unbound row counts as the default workspace's. So a
   * project a manager made in a second workspace reached a developer's
   * desktop, sat in its database under the right workspace, and was hidden
   * from that workspace anyway.
   *
   * Every one of these tables carries `workspace_id`, written with the row by
   * the store, and every store reads by it. It is the answer; there is no
   * second record to keep in step. The side table remains only for a row this
   * file does not hold.
   */
  entityWorkspace(entityType: EntityType, entityId: string): string | null {
    const own = this.handle()
      .prepare(`SELECT workspace_id FROM ${entityType} WHERE id = ?`)
      .get(entityId) as { workspace_id: string | null } | undefined;
    if (own?.workspace_id) return own.workspace_id;

    const bound = this.handle()
      .prepare('SELECT workspace_id FROM workspace_entity_bindings WHERE entity_type = ? AND entity_id = ?')
      .get(entityType, entityId) as { workspace_id: string } | undefined;
    return bound?.workspace_id ?? null;
  }

  bind(entityType: EntityType, entityId: string, workspaceId: string): void {
    // A Postgres row is born with its workspace_id; there is nothing to record.
    if (IS_CLOUD) return;
    this.handle()
      .prepare(
        `INSERT INTO workspace_entity_bindings (entity_type, entity_id, workspace_id, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(entity_type, entity_id) DO UPDATE SET workspace_id = excluded.workspace_id`
      )
      .run(entityType, entityId, workspaceId, new Date().toISOString());
  }

  /** Forget an entity. A deleted squad also gives up its owner. */
  async unbind(entityType: EntityType, entityId: string): Promise<void> {
    if (!IS_CLOUD) {
      this.handle()
        .prepare('DELETE FROM workspace_entity_bindings WHERE entity_type = ? AND entity_id = ?')
        .run(entityType, entityId);
    }
    if (entityType === 'squads') await this.directory().releaseSquadOwner(entityId);
  }

  belongsTo(entityType: EntityType, entityId: string, workspaceId: string): boolean {
    const bound = this.entityWorkspace(entityType, entityId);
    return bound ? bound === workspaceId : workspaceId === this.defaultWorkspaceId;
  }

  /**
   * The rows of this workspace.
   *
   * In the cloud, every one: they were read from a store that selected by
   * workspace_id, which is the only place cloud rows come from. On a desktop,
   * the ones whose own row says so.
   */
  scope<T extends { id: string }>(entityType: EntityType, rows: T[], workspaceId: string): T[] {
    if (IS_CLOUD) return rows;
    return rows.filter(row => this.belongsTo(entityType, row.id, workspaceId));
  }
}

export const workspaceRegistry = new WorkspaceRegistry();
