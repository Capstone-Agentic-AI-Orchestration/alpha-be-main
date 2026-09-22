import { IS_CLOUD } from '../config/env.js';
import { database } from './database.js';
import { PostgresAgentStore, PostgresSquadStore } from './postgresAgentStore.js';
import { PostgresRunStore } from './postgresRunStore.js';
import { SqliteRunStore } from './sqliteRunStore.js';
import type { RunStore } from './runStore.js';
import { SqliteAgentStore, SqliteSquadStore } from './sqliteAgentStore.js';
import type { AgentStore, SquadStore } from './agentStore.js';
import { PostgresIssueStore } from './postgresIssueStore.js';
import { PostgresProjectStore } from './postgresProjectStore.js';
import { SqliteIssueStore } from './sqliteIssueStore.js';
import { SqliteProjectStore } from './sqliteProjectStore.js';
import { PostgresChatStore } from './postgresChatStore.js';
import { SqliteChatStore } from './sqliteChatStore.js';
import type { ChatStore } from './chatStore.js';
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

let chats: ChatStore | null = null;

export function chatStore(): ChatStore {
  chats ??= IS_CLOUD ? new PostgresChatStore(database()) : new SqliteChatStore();
  return chats;
}

/** For tests, which supply their own store rather than a mode's. */
export function useChatStore(store: ChatStore | null): void {
  chats = store;
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

let runs: RunStore | null = null;

export function runStore(): RunStore {
  runs ??= IS_CLOUD ? new PostgresRunStore(database()) : new SqliteRunStore();
  return runs;
}

/** For tests, which supply their own store rather than a mode's. */
export function useRunStore(store: RunStore | null): void {
  runs = store;
}
