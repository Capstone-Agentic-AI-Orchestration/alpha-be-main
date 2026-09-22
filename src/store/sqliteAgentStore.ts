import type { Agent, Squad } from '../models/index.js';
import { sqliteService } from '../services/sqliteService.js';
import { runWithWorkspace } from '../services/workspaceContext.js';
import type { AgentStore, SquadStore } from './agentStore.js';

/**
 * The roster on a developer's machine.
 *
 * Adapters over `sqliteService`, which keeps the SQL and the two side effects
 * a desktop agent has and a cloud row cannot: its persona file on disk and its
 * memory scaffold.
 */
export class SqliteAgentStore implements AgentStore {
  async list(workspaceId: string): Promise<Agent[]> {
    return runWithWorkspace(workspaceId, () => sqliteService.getAgents());
  }

  async get(workspaceId: string, id: string): Promise<Agent | null> {
    return runWithWorkspace(workspaceId, () => sqliteService.getAgents().find(agent => agent.id === id) ?? null);
  }

  async create(workspaceId: string, agent: Agent): Promise<Agent> {
    return runWithWorkspace(workspaceId, () => sqliteService.createAgent(agent));
  }

  async update(workspaceId: string, id: string, updates: Partial<Agent>): Promise<Agent | null> {
    return runWithWorkspace(workspaceId, () => sqliteService.updateAgent(id, updates));
  }

  async remove(workspaceId: string, id: string): Promise<boolean> {
    return runWithWorkspace(workspaceId, () => sqliteService.deleteAgent(id));
  }

  /** Seeded by `sqliteService` itself, at construction and on workspace create. */
  async ensureOfficial(workspaceId: string): Promise<void> {
    runWithWorkspace(workspaceId, () => sqliteService.ensureOfficialAgents(workspaceId));
  }
}

export class SqliteSquadStore implements SquadStore {
  async list(workspaceId: string): Promise<Squad[]> {
    return runWithWorkspace(workspaceId, () => sqliteService.getSquads());
  }

  async get(workspaceId: string, id: string): Promise<Squad | null> {
    return runWithWorkspace(workspaceId, () => sqliteService.getSquads().find(squad => squad.id === id) ?? null);
  }

  async create(workspaceId: string, squad: Squad): Promise<Squad> {
    return runWithWorkspace(workspaceId, () => sqliteService.createSquad(squad));
  }

  async update(workspaceId: string, id: string, updates: Partial<Squad>): Promise<Squad | null> {
    return runWithWorkspace(workspaceId, () => sqliteService.updateSquad(id, updates));
  }

  async remove(workspaceId: string, id: string): Promise<boolean> {
    return runWithWorkspace(workspaceId, () => sqliteService.deleteSquad(id));
  }
}
