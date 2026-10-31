import type { PrototypeRun, RemoteAction, SquadRun } from '../models/index.js';
import { sqliteService } from '../services/sqliteService.js';
import { runWithWorkspace } from '../services/workspaceContext.js';
import { summarizeRun, type RemoteActionInput, type RunStore } from './runStore.js';

/**
 * Runs on the machine that produced them.
 *
 * An adapter over `sqliteService`, which keeps the SQL: the runner writes
 * these rows synchronously while a run is in flight, several times a second.
 */
export class SqliteRunStore implements RunStore {
  async list(workspaceId: string): Promise<PrototypeRun[]> {
    return runWithWorkspace(workspaceId, () => sqliteService.getPrototypeRuns());
  }

  /** Local, so nothing crosses the network; stripped for one list shape everywhere. */
  async listSummaries(workspaceId: string, projectId?: string): Promise<PrototypeRun[]> {
    return (await this.list(workspaceId))
      .filter(run => !projectId || run.projectId === projectId)
      .map(summarizeRun);
  }

  /** Keep the project build payload shape consistent with the cloud store. */
  async listProjectBuildDetails(workspaceId: string, runIds: string[]): Promise<PrototypeRun[]> {
    const wantedIds = new Set(runIds);
    return (await this.list(workspaceId))
      .filter(run => wantedIds.has(run.id))
      .map(run => ({
        ...run,
        stages: (run.stages ?? []).map(stage => ({ ...stage, logs: (stage.logs ?? []).slice(-8) })),
        activities: (run.activities ?? []).slice(-40)
      }));
  }

  async get(workspaceId: string, id: string): Promise<PrototypeRun | null> {
    return runWithWorkspace(workspaceId, () => sqliteService.getPrototypeRuns().find(run => run.id === id) ?? null);
  }

  async save(workspaceId: string, run: PrototypeRun, _ownerId: string): Promise<PrototypeRun> {
    return runWithWorkspace(workspaceId, () => sqliteService.savePrototypeRun(run));
  }

  async listSquadRuns(workspaceId: string): Promise<SquadRun[]> {
    return runWithWorkspace(workspaceId, () => sqliteService.getSquadRuns());
  }

  async getSquadRun(workspaceId: string, id: string): Promise<SquadRun | null> {
    return runWithWorkspace(workspaceId, () => sqliteService.getSquadRun(id) ?? null);
  }

  async saveSquadRun(workspaceId: string, run: SquadRun, _ownerId: string): Promise<SquadRun> {
    return runWithWorkspace(workspaceId, () => sqliteService.saveSquadRun(run));
  }

  async runsForSquadRun(workspaceId: string, squadRunId: string): Promise<PrototypeRun[]> {
    return runWithWorkspace(workspaceId, () => sqliteService.getRunsForSquadRun(squadRunId));
  }

  async recordRemoteAction(workspaceId: string, action: RemoteActionInput): Promise<RemoteAction> {
    return runWithWorkspace(workspaceId, () => {
      sqliteService.recordRemoteAction(action);
      return action as RemoteAction;
    });
  }

  async listRemoteActions(workspaceId: string, runId?: string): Promise<RemoteAction[]> {
    return runWithWorkspace(workspaceId, () => sqliteService.getRemoteActions(runId));
  }
}
