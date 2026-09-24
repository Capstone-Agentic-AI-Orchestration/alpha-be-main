import { randomBytes } from 'node:crypto';

/**
 * Workspaces, who belongs to them, and what each member is assigned to.
 *
 * The control plane's own records -- not the board. Two implementations keep
 * them: SQLite on the desktop, where one process serves one person, and
 * Postgres in the cloud, where Render replaces the disk on every deploy and
 * everything written there used to vanish with it.
 *
 * Asynchronous because Postgres is. The desktop's SQLite answers
 * synchronously, but a caller written against this interface works against
 * either without knowing which it has.
 */

export type WorkspaceRole = 'client' | 'dev' | 'pm' | 'admin';
export type WorkspaceMemberStatus = 'invited' | 'active' | 'suspended' | 'removed';

export interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  status: 'active' | 'archived';
  role: WorkspaceRole;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceMember {
  id: string;
  userId: string;
  role: WorkspaceRole;
  status: WorkspaceMemberStatus;
  createdAt: string;
  updatedAt: string;
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

/**
 * What one caller may reach in one workspace, loaded once per request.
 *
 * The permission checks run many times a request -- a filter over every run,
 * every squad, every agent -- and they used to be one SQLite lookup each. On
 * the same machine that cost nothing. Across a network it would be a round
 * trip per row, so the facts they read are fetched together, once, when the
 * request's workspace is resolved, and the checks read them from here.
 */
export interface WorkspaceAccess {
  /** Projects this caller is assigned to. Unused for PMs and admins, who see all. */
  assignedProjectIds: ReadonlySet<string>;
  /** Each squad's owner. */
  squadOwners: ReadonlyMap<string, string>;
  /** Which squads serve which projects. */
  squadProjects: ReadonlyArray<{ squadId: string; projectId: string }>;
  /** Each project in this workspace, and the login of the PM who created it. */
  projectCreators?: ReadonlyMap<string, string | null>;
  /**
   * This workspace's active project managers, for `isPmOwnedProject`.
   *
   * Absent on a team's desktop: it holds only its own person's membership,
   * so it cannot tell who the other PMs are -- and does not need to. Every
   * project there came from the team board, which the cloud's policy only
   * lets through when its creator is an active PM.
   */
  projectManagerIds?: ReadonlySet<string>;
  /**
   * The projects and squads that are in this workspace at all.
   *
   * Postgres only. There every row carries its `workspace_id`, and this is how
   * a check answers "is that project in this workspace" without the desktop's
   * side table of bindings -- which on Render was a file emptied by every
   * deploy, after which no project outside the default workspace was reachable
   * by anyone. Absent on a desktop, where the bindings are still the answer.
   */
  workspaceRows?: {
    projects: ReadonlySet<string>;
    squads: ReadonlySet<string>;
  };
}

export interface WorkspaceContext {
  userId: string;
  workspaceId: string;
  /** The caller's role in this workspace. */
  role: WorkspaceRole;
  /**
   * The role GitHub teams give the caller, wherever they are. What a new
   * membership starts at -- joining by invite, or first arrival -- as distinct
   * from `role`, which an admin may since have changed for this workspace.
   */
  teamRole?: WorkspaceRole;
  workspace: WorkspaceSummary;
  access: WorkspaceAccess;
}

/** Refused for a reason the caller can act on; the routes answer these as 4xx. */
export class WorkspaceRequestError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409) {
    super(message);
    this.name = 'WorkspaceRequestError';
  }
}

export interface WorkspaceDirectory {
  /**
   * The caller's workspaces, enrolling them in the default one at `teamRole`
   * if they have never been a member of it. No role, no enrolment.
   */
  listForUser(userId: string, teamRole?: WorkspaceRole): Promise<WorkspaceSummary[]>;
  /** The requested workspace, or their first, with what they may reach in it. */
  resolve(userId: string, requestedWorkspaceId?: string, teamRole?: WorkspaceRole): Promise<WorkspaceContext | null>;

  /** A new workspace, with its creator as its first member at `creatorRole`. */
  createWorkspace(
    userId: string,
    input: { name: string; slug?: string },
    creatorRole?: WorkspaceRole
  ): Promise<WorkspaceSummary>;
  updateWorkspace(workspaceId: string, input: { name?: string; slug?: string }, callerRole: WorkspaceRole): Promise<WorkspaceSummary | null>;

  listMembers(workspaceId: string): Promise<WorkspaceMember[]>;
  /**
   * Put someone in this workspace, at this role, now.
   *
   * Not an invitation: whoever runs this has already decided, and the person
   * finds the workspace waiting for them at their next sign-in. A membership
   * that was suspended or removed is restored, because this is a present
   * decision by someone entitled to make it, made against a name rather
   * than against a code anyone could have been handed.
   */
  addMember(workspaceId: string, userId: string, role: WorkspaceRole): Promise<WorkspaceMember>;
  updateMember(
    workspaceId: string,
    memberId: string,
    input: { role?: WorkspaceRole; status?: WorkspaceMemberStatus }
  ): Promise<WorkspaceMember | null>;

  listProjectAssignments(workspaceId: string, projectId?: string): Promise<WorkspaceProjectAssignment[]>;
  assignProject(workspaceId: string, projectId: string, userId: string): Promise<WorkspaceProjectAssignment>;
  removeProjectAssignment(workspaceId: string, projectId: string, userId: string): Promise<boolean>;

  bindSquadOwner(workspaceId: string, squadId: string, userId: string): Promise<void>;
  /** A deleted squad has no owner. */
  releaseSquadOwner(squadId: string): Promise<void>;
  assignSquadProject(
    workspaceId: string,
    squadId: string,
    projectId: string,
    relationship: 'owned' | 'assigned'
  ): Promise<WorkspaceSquadProjectAssignment>;
  removeSquadProject(workspaceId: string, squadId: string, projectId: string): Promise<boolean>;
  listSquadProjectAssignments(workspaceId: string, projectId?: string): Promise<WorkspaceSquadProjectAssignment[]>;

  /**
   * Make sure the default workspace's row exists.
   *
   * Everything a workspace owns -- its agents, squads, projects -- has a
   * foreign key to that row, so anything seeded into the default workspace has
   * to wait for it. It used to be created only by the first sign-in, which is
   * after boot: the roster seeded at boot failed its key and the shared
   * workspace started with no agents at all.
   */
  ensureDefaultWorkspace(): Promise<void>;
}

// ── Rules both implementations share ──────────────────────────────────────

const ROLES: readonly WorkspaceRole[] = ['client', 'dev', 'pm', 'admin'];

/**
 * A stored role this code recognises, or null.
 *
 * Unrecognised used to read as `admin`. The Postgres column is constrained,
 * but SQLite's is not, and a membership row with a garbled role is not a
 * reason to hand out the highest one. Such a row now grants nothing.
 */
export function knownRole(value: unknown): WorkspaceRole | null {
  return ROLES.includes(value as WorkspaceRole) ? (value as WorkspaceRole) : null;
}

export function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || `workspace-${Date.now()}`;
}

export const iso = (value: Date | string): string => new Date(value).toISOString();
