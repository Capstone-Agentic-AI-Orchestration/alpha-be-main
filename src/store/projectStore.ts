import type { Project, ProjectBuildStep } from '../models/index.js';

export class ProjectLinkedToTicketError extends Error {
  constructor() { super('This project is still linked to one or more client tickets.'); this.name = 'ProjectLinkedToTicketError'; }
}

/** The database has not been given the archive columns yet. */
export class ProjectArchiveUnavailableError extends Error {
  constructor() { super('Archiving projects needs a database update that has not been applied yet.'); this.name = 'ProjectArchiveUnavailableError'; }
}

/**
 * Projects, as the board sees them.
 *
 * The cloud keeps them in Postgres, so they survive a deploy; the desktop
 * keeps them in SQLite, where the rest of its board is. The routes above are
 * written against this and cannot tell which they have.
 *
 * The workspace is a parameter rather than ambient state. `sqliteService`
 * reads it from an async-local value set by middleware, which works when one
 * process serves one person and is a footgun when it serves everyone: a
 * missing `runWithWorkspace` silently means "the default workspace" rather
 * than an error. Here it is impossible not to say which workspace you mean.
 */
export interface ProjectStore {
  list(workspaceId: string): Promise<Project[]>;
  get(workspaceId: string, id: string): Promise<Project | null>;
  create(workspaceId: string, input: Partial<Project>): Promise<Project>;
  update(workspaceId: string, id: string, updates: Partial<Project>): Promise<Project | null>;
  remove(workspaceId: string, id: string): Promise<boolean>;
  /**
   * Archive (a timestamp) or restore (null) a project. Separate from `update`,
   * which never touches the archive columns, so an ordinary edit keeps working
   * on a database the archive migration has not reached yet.
   */
  setArchived(workspaceId: string, id: string, archive: { at: string; by: string } | null): Promise<Project | null>;
  /**
   * Whether client tickets point at the project, which stops it being deleted.
   * Only the cloud keeps tickets; a desktop answers false.
   */
  linkedToTickets(workspaceId: string, id: string): Promise<boolean>;

  /** A project's build steps in order, or null if the project is not in this workspace. */
  getBuildSteps(workspaceId: string, projectId: string): Promise<ProjectBuildStep[] | null>;
  /**
   * Replace a project's build steps with `steps`, in that order. Null if the
   * project is not in this workspace; `BuildStepError` if the list is invalid.
   */
  saveBuildSteps(workspaceId: string, projectId: string, steps: unknown): Promise<ProjectBuildStep[] | null>;
}

/**
 * A project with everything the caller did not send filled in.
 *
 * One definition for both stores. The browser mints an id before posting, so
 * the missing-field paths only ever ran for other callers -- which is exactly
 * where they were found to throw.
 */
export function withProjectDefaults(input: Partial<Project>, now = new Date().toISOString()): Project {
  return {
    ...input,
    id: input.id || `proj-${Date.now()}`,
    name: input.name || 'Untitled Project',
    key: input.key || `P${Date.now().toString().slice(-4)}`,
    description: input.description ?? '',
    color: input.color || '#6366f1',
    icon: input.icon || '📁',
    status: input.status || 'in_progress',
    priority: input.priority || 'medium',
    startDate: input.startDate || now,
    targetDate: input.targetDate || '',
    leadType: input.leadType || 'agent',
    leadName: input.leadName || '',
    resources: input.resources || [],
    createdBy: input.createdBy,
    createdAt: input.createdAt || now
  } as Project;
}
