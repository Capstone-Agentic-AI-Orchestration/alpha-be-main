import { IS_CLOUD } from '../config/env.js';
import { database } from './database.js';
import { PostgresAgentStore, PostgresSquadStore } from './postgresAgentStore.js';
import { SqliteAgentStore, SqliteSquadStore } from './sqliteAgentStore.js';
import type { AgentStore, SquadStore } from './agentStore.js';
import { PostgresIssueStore } from './postgresIssueStore.js';
import { PostgresProjectStore } from './postgresProjectStore.js';
import { SqliteIssueStore } from './sqliteIssueStore.js';
import { SqliteProjectStore } from './sqliteProjectStore.js';
import type { IssueStore } from './issueStore.js';
import type { ProjectStore } from './projectStore.js';

/**
 * Which store each half of the platform gets.
 *
 * Chosen on first use, not at import: the cloud's connection opens when a
 * request needs it, and the desktop must not open one at all.
 */

let projects: ProjectStore | null = null;

export function projectStore(): ProjectStore {
  projects ??= IS_CLOUD ? new PostgresProjectStore(database()) : new SqliteProjectStore();
  return projects;
}

/** For tests, which supply their own store rather than a mode's. */
export function useProjectStore(store: ProjectStore | null): void {
  projects = store;
}

let issues: IssueStore | null = null;

export function issueStore(): IssueStore {
  issues ??= IS_CLOUD ? new PostgresIssueStore(database()) : new SqliteIssueStore();
  return issues;
}

/** For tests, which supply their own store rather than a mode's. */
export function useIssueStore(store: IssueStore | null): void {
  issues = store;
}

let agents: AgentStore | null = null;
let squads: SquadStore | null = null;

export function agentStore(): AgentStore {
  agents ??= IS_CLOUD ? new PostgresAgentStore(database()) : new SqliteAgentStore();
  return agents;
}

export function squadStore(): SquadStore {
  squads ??= IS_CLOUD ? new PostgresSquadStore(database()) : new SqliteSquadStore();
  return squads;
}

/** For tests, which supply their own stores rather than a mode's. */
export function useAgentStores(agent: AgentStore | null, squad: SquadStore | null): void {
  agents = agent;
  squads = squad;
}
