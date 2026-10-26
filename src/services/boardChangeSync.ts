import type { Agent, Issue, Project } from '../models/index.js';

export type BoardTable =
  | 'projects' | 'issues' | 'issue_comments' | 'agents' | 'squads'
  | 'workspace_squad_owners' | 'workspace_squad_projects' | 'workspace_project_assignments';

export interface BoardCursor {
  workspaceId: string;
  value: string;
}

export interface BoardChange {
  cursor: string;
  table: BoardTable;
  rowKey: Record<string, string>;
  operation: 'insert' | 'update' | 'delete';
  row: Record<string, unknown> | null;
}

export interface BoardChangeLogRow {
  cursor: string;
  table: BoardTable;
  rowKey: Record<string, string>;
  operation: 'insert' | 'update' | 'delete';
  createdAt: string;
}

export interface BoardChangeLogPage {
  rows: BoardChangeLogRow[];
  hasMore: boolean;
  oldestCursor: string | null;
  currentCursor: string;
}

export interface BoardState {
  projects: Project[];
  agents: Agent[];
  issues: Issue[];
}

export interface BoardSyncResult {
  state: BoardState;
  cursor: BoardCursor;
}

export interface BoardChangePage {
  workspaceId: string;
  nextCursor: BoardCursor;
  hasMore: boolean;
  resetRequired: boolean;
  changes: BoardChange[];
}

export interface BoardBootstrap extends BoardState {
  workspaceId: string;
  cursor: BoardCursor;
}

export interface BoardChangeAccess {
  /** Projects visible to the hosted API caller. Supabase Data API callers use their own RLS instead. */
  allowedProjectIds?: ReadonlySet<string>;
  canReadIssues: boolean;
  canReadAgents: boolean;
  canReadSquads: boolean;
}

export interface BoardChangeSource {
  watermark(workspaceId: string): Promise<string>;
  readAfter(workspaceId: string, after: string, limit: number): Promise<BoardChangeLogPage>;
  snapshot(workspaceId: string, access: BoardChangeAccess): Promise<BoardState>;
  readRows(
    workspaceId: string,
    changes: BoardChangeLogRow[],
    access: BoardChangeAccess
  ): Promise<Map<string, Record<string, unknown>>>;
}

export class BoardCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BoardCursorError';
  }
}

export function boardChangeKey(table: BoardTable, rowKey: Record<string, string>): string {
  const sorted = Object.fromEntries(Object.entries(rowKey).sort(([left], [right]) => left.localeCompare(right)));
  return `${table}:${JSON.stringify(sorted)}`;
}

function canReadChange(table: BoardTable, access: BoardChangeAccess): boolean {
  if (table === 'issues' || table === 'issue_comments') return access.canReadIssues;
  if (table === 'agents') return access.canReadAgents;
  if (table === 'squads' || table === 'workspace_squad_owners' || table === 'workspace_squad_projects') {
    return access.canReadSquads;
  }
  return true;
}

/**
 * Coordinates the one-time snapshot and the smaller pages after its cursor.
 * Log entries can mention rows this caller cannot see, so page cursors advance
 * over every scanned entry while values still pass through the source's normal
 * workspace and row-visibility checks.
 */
export class BoardChangeSync {
  constructor(
    private readonly source: BoardChangeSource,
    private readonly access: BoardChangeAccess
  ) {}

  async bootstrap(workspaceId: string): Promise<BoardBootstrap> {
    // The watermark comes first. Changes made while the snapshot is being read
    // are then replayed from this point by the next page request.
    const value = await this.source.watermark(workspaceId);
    const state = await this.source.snapshot(workspaceId, this.access);
    return { workspaceId, cursor: { workspaceId, value }, ...state };
  }

  async changes(workspaceId: string, cursor: BoardCursor, limit = 100): Promise<BoardChangePage> {
    if (cursor.workspaceId !== workspaceId) {
      throw new BoardCursorError('The cursor workspace does not match the active workspace.');
    }
    if (!/^(0|[1-9]\d*)$/.test(cursor.value)) {
      throw new BoardCursorError('The cursor value must be a non-negative decimal number.');
    }

    const pageSize = Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.floor(limit))) : 100;
    const page = await this.source.readAfter(workspaceId, cursor.value, pageSize);
    const requested = BigInt(cursor.value);
    const current = BigInt(page.currentCursor);
    const oldest = page.oldestCursor === null ? null : BigInt(page.oldestCursor);
    const historyExpired = oldest === null ? requested < current : requested + 1n < oldest;
    if (requested > current || historyExpired) {
      return {
        workspaceId,
        nextCursor: { workspaceId, value: page.currentCursor },
        hasMore: false,
        resetRequired: true,
        changes: []
      };
    }

    const coalesced = new Map<string, BoardChangeLogRow>();
    for (const row of page.rows) {
      if (canReadChange(row.table, this.access)) coalesced.set(boardChangeKey(row.table, row.rowKey), row);
    }
    const latest = [...coalesced.entries()]
      .map(([key, row]) => ({ key, row }))
      .sort((left, right) => BigInt(left.row.cursor) < BigInt(right.row.cursor) ? -1 : 1);
    const rowsToFetch = latest.map(({ row }) => row).filter(row => row.operation !== 'delete');
    const currentRows = rowsToFetch.length
      ? await this.source.readRows(workspaceId, rowsToFetch, this.access)
      : new Map<string, Record<string, unknown>>();
    const changes: BoardChange[] = [];

    for (const { key, row } of latest) {
      if (row.operation === 'delete') {
        changes.push({
          cursor: row.cursor,
          table: row.table,
          rowKey: row.rowKey,
          operation: row.operation,
          row: null
        });
        continue;
      }
      const value = currentRows.get(key);
      // A row hidden by current RLS, project scope, or a later delete is not
      // returned; the cursor still advances past its log record.
      if (value) {
        changes.push({
          cursor: row.cursor,
          table: row.table,
          rowKey: row.rowKey,
          operation: row.operation,
          row: value
        });
      }
    }

    return {
      workspaceId,
      nextCursor: { workspaceId, value: page.rows.at(-1)?.cursor ?? cursor.value },
      hasMore: page.hasMore,
      resetRequired: false,
      changes
    };
  }
}
