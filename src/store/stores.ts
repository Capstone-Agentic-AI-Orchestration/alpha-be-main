import { IS_CLOUD } from '../config/env.js';
import { database } from './database.js';
import { PostgresProjectStore } from './postgresProjectStore.js';
import { SqliteProjectStore } from './sqliteProjectStore.js';
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
