import type { Project, ProjectBuildStep } from '../models/index.js';
import { sqliteService } from '../services/sqliteService.js';
import { runWithWorkspace } from '../services/workspaceContext.js';
import type { ProjectStore } from './projectStore.js';

/**
 * Projects on a developer's machine.
 *
 * A thin adapter over `sqliteService`, which still owns the SQL: the desktop's
 * board is one file, and splitting projects out of it would mean two writers
 * for rows the runner reads synchronously mid-run.
 *
 * Each call states its workspace, which this sets as the async-local value
 * `sqliteService` reads. That indirection is temporary and points the right
 * way: the store's callers now name the workspace, so the ambient value has
 * one place left to be set rather than being assumed everywhere.
 */
/** `sqliteService` says a project is missing by throwing; the interface says it with null. */
function orNullWhenMissing<T>(read: () => T): T | null {
  try {
    return read();
  } catch (err) {
    if ((err as Error)?.message === 'Project not found') return null;
    throw err;
  }
}

export class SqliteProjectStore implements ProjectStore {
  async list(workspaceId: string): Promise<Project[]> {
    return runWithWorkspace(workspaceId, () => sqliteService.getProjects());
  }

  async get(workspaceId: string, id: string): Promise<Project | null> {
    return runWithWorkspace(workspaceId, () => sqliteService.getProjects().find(p => p.id === id) ?? null);
  }

  async create(workspaceId: string, input: Partial<Project>): Promise<Project> {
    return runWithWorkspace(workspaceId, () => sqliteService.createProject(input));
  }

  async update(workspaceId: string, id: string, updates: Partial<Project>): Promise<Project | null> {
    return runWithWorkspace(workspaceId, () => sqliteService.updateProject(id, updates));
  }

  async remove(workspaceId: string, id: string): Promise<boolean> {
    return runWithWorkspace(workspaceId, () => sqliteService.deleteProject(id));
  }

  async setArchived(workspaceId: string, id: string, archive: { at: string; by: string } | null): Promise<Project | null> {
    return runWithWorkspace(workspaceId, () => sqliteService.setProjectArchived(id, archive));
  }

  async linkedToTickets(): Promise<boolean> {
    return false;
  }

  async getBuildSteps(workspaceId: string, projectId: string): Promise<ProjectBuildStep[] | null> {
    return runWithWorkspace(workspaceId, () => orNullWhenMissing(() => sqliteService.getProjectBuildSteps(projectId)));
  }

  async saveBuildSteps(workspaceId: string, projectId: string, steps: unknown): Promise<ProjectBuildStep[] | null> {
    return runWithWorkspace(workspaceId, () =>
      orNullWhenMissing(() => sqliteService.saveProjectBuildSteps(projectId, steps as Array<Partial<ProjectBuildStep>>))
    );
  }
}
