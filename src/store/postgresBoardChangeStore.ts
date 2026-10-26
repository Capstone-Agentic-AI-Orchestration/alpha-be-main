import type { Agent, Issue, IssueComment, Project } from '../models/index.js';
import type { Sql } from './database.js';
import { toComment, toIssue, type CommentRow, type IssueRow } from './postgresIssueStore.js';
import { toProject, type ProjectRow } from './postgresProjectStore.js';
import { toAgent, toSquad, type AgentRow, type SquadRow } from './postgresAgentStore.js';
import {
  boardChangeKey,
  type BoardChangeAccess,
  type BoardChangeLogPage,
  type BoardChangeLogRow,
  type BoardChangeSource,
  type BoardTable,
  type BoardState
} from '../services/boardChangeSync.js';

interface StoredChangeRow {
  cursor: string;
  table_name: BoardTable;
  row_key: Record<string, string>;
  operation: BoardChangeLogRow['operation'];
  created_at: Date | string;
}

interface StoredBoardIssue extends IssueRow {
  workspace_id: string;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function projectFilter(access: BoardChangeAccess): string[] | null {
  return access.allowedProjectIds === undefined ? null : [...access.allowedProjectIds];
}

function issueWithoutComments(row: IssueRow): Record<string, unknown> {
  const { comments: _comments, ...issue } = toIssue(row, []);
  return issue;
}

/**
 * Workspace-scoped cursor log reads and current-row lookups for hosted mode.
 * The pool connects as the database owner, so every row query repeats the
 * workspace and visible-project filters that a user's Data API token applies
 * automatically on desktop.
 */
export class PostgresBoardChangeStore implements BoardChangeSource {
  constructor(private readonly sql: Sql) {}

  async watermark(workspaceId: string): Promise<string> {
    const { rows } = await this.sql.query<{ cursor: string }>(`
      select coalesce((
        select last_cursor::text from public.workspace_board_cursors where workspace_id = $1
      ), '0') as cursor
    `, [workspaceId]);
    return rows[0].cursor;
  }

  async readAfter(workspaceId: string, after: string, limit: number): Promise<BoardChangeLogPage> {
    const pageSize = Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.floor(limit))) : 100;
    const currentCursor = await this.watermark(workspaceId);
    const [{ rows: oldestRows }, { rows: found }] = await Promise.all([
      this.sql.query<{ cursor: string | null }>(`
        select min(cursor)::text as cursor
        from public.workspace_board_changes
        where workspace_id = $1
      `, [workspaceId]),
      this.sql.query<StoredChangeRow>(`
        select cursor::text as cursor, table_name, row_key, operation, created_at
        from public.workspace_board_changes
        where workspace_id = $1 and cursor > $2::bigint and cursor <= $3::bigint
        order by cursor asc
        limit $4
      `, [workspaceId, after, currentCursor, pageSize + 1])
    ]);
    const hasMore = found.length > pageSize;
    const rows = found.slice(0, pageSize).map(row => ({
      cursor: row.cursor,
      table: row.table_name,
      rowKey: row.row_key,
      operation: row.operation,
      createdAt: iso(row.created_at)
    }));

    return {
      rows,
      hasMore,
      oldestCursor: oldestRows[0]?.cursor ?? null,
      currentCursor
    };
  }

  async snapshot(workspaceId: string, access: BoardChangeAccess): Promise<BoardState> {
    const allowedProjectIds = projectFilter(access);
    const projectQuery = await this.sql.query<ProjectRow>(`
      select p.*,
        (select a.squad_id from public.workspace_squad_projects a
          where a.workspace_id = p.workspace_id and a.project_id = p.id
            and a.relationship = 'owned' and a.status = 'active'
          order by a.created_at limit 1) as lead_squad_id
      from public.projects p
      where p.workspace_id = $1
        and ($2::text[] is null or p.id = any($2::text[]))
      order by p.created_at desc
    `, [workspaceId, allowedProjectIds]);
    const projects: Project[] = projectQuery.rows.map(toProject);

    let agents: Agent[] = [];
    if (access.canReadAgents) {
      const result = await this.sql.query<AgentRow>(
        'select * from public.agents where workspace_id = $1 order by created_at asc',
        [workspaceId]
      );
      agents = result.rows.map(toAgent);
    }

    const issues = access.canReadIssues
      ? await this.listIssues(workspaceId, allowedProjectIds)
      : [];
    return { projects, agents, issues };
  }

  async readRows(
    workspaceId: string,
    changes: BoardChangeLogRow[],
    access: BoardChangeAccess
  ): Promise<Map<string, Record<string, unknown>>> {
    const grouped = new Map<BoardTable, BoardChangeLogRow[]>();
    for (const change of changes) {
      const rows = grouped.get(change.table) ?? [];
      rows.push(change);
      grouped.set(change.table, rows);
    }

    const result = new Map<string, Record<string, unknown>>();
    for (const [table, tableChanges] of grouped) {
      const ids = [...new Set(tableChanges.map(change => change.rowKey.id).filter(Boolean))];
      if (!ids.length) continue;
      const values = await this.readTableRows(workspaceId, table, ids, access);
      for (const change of tableChanges) {
        const row = values.get(change.rowKey.id);
        if (row) result.set(boardChangeKey(table, change.rowKey), row);
      }
    }
    return result;
  }

  private async listIssues(workspaceId: string, allowedProjectIds: string[] | null): Promise<Issue[]> {
    if (allowedProjectIds?.length === 0) return [];
    const { rows } = await this.sql.query<StoredBoardIssue>(`
      select i.* from public.issues i
      where i.workspace_id = $1
        and ($2::text[] is null or i.project_id = any($2::text[]))
      order by i.created_at desc
    `, [workspaceId, allowedProjectIds]);
    if (!rows.length) return [];

    const { rows: comments } = await this.sql.query<CommentRow>(`
      select c.* from public.issue_comments c
      join public.issues i on i.id = c.issue_id
      where i.workspace_id = $1
        and ($2::text[] is null or i.project_id = any($2::text[]))
      order by c.created_at asc
    `, [workspaceId, allowedProjectIds]);
    const byIssue = new Map<string, IssueComment[]>();
    for (const comment of comments) {
      const issueComments = byIssue.get(comment.issue_id) ?? [];
      issueComments.push(toComment(comment));
      byIssue.set(comment.issue_id, issueComments);
    }
    return rows.map(row => toIssue(row, byIssue.get(row.id) ?? []));
  }

  private async readTableRows(
    workspaceId: string,
    table: BoardTable,
    ids: string[],
    access: BoardChangeAccess
  ): Promise<Map<string, Record<string, unknown>>> {
    const allowedProjectIds = projectFilter(access);
    let rows: Array<Record<string, unknown>> = [];

    switch (table) {
      case 'projects': {
        const response = await this.sql.query<ProjectRow>(`
          select p.*,
            (select a.squad_id from public.workspace_squad_projects a
              where a.workspace_id = p.workspace_id and a.project_id = p.id
                and a.relationship = 'owned' and a.status = 'active'
              order by a.created_at limit 1) as lead_squad_id
          from public.projects p
          where p.workspace_id = $1 and p.id = any($2::text[])
            and ($3::text[] is null or p.id = any($3::text[]))
        `, [workspaceId, ids, allowedProjectIds]);
        rows = response.rows.map(row => toProject(row) as unknown as Record<string, unknown>);
        break;
      }
      case 'issues': {
        if (!access.canReadIssues || allowedProjectIds?.length === 0) return new Map();
        const response = await this.sql.query<IssueRow>(`
          select * from public.issues
          where workspace_id = $1 and id = any($2::text[])
            and ($3::text[] is null or project_id = any($3::text[]))
        `, [workspaceId, ids, allowedProjectIds]);
        rows = response.rows.map(issueWithoutComments);
        break;
      }
      case 'issue_comments': {
        if (!access.canReadIssues || allowedProjectIds?.length === 0) return new Map();
        const response = await this.sql.query<CommentRow>(`
          select c.* from public.issue_comments c
          join public.issues i on i.id = c.issue_id
          where i.workspace_id = $1 and c.id = any($2::text[])
            and ($3::text[] is null or i.project_id = any($3::text[]))
        `, [workspaceId, ids, allowedProjectIds]);
        rows = response.rows.map(row => toComment(row) as unknown as Record<string, unknown>);
        break;
      }
      case 'agents': {
        if (!access.canReadAgents) return new Map();
        const response = await this.sql.query<AgentRow>(
          'select * from public.agents where workspace_id = $1 and id = any($2::text[])',
          [workspaceId, ids]
        );
        rows = response.rows.map(row => toAgent(row) as unknown as Record<string, unknown>);
        break;
      }
      case 'squads': {
        if (!access.canReadSquads) return new Map();
        const response = await this.sql.query<SquadRow>(
          'select * from public.squads where workspace_id = $1 and id = any($2::text[])',
          [workspaceId, ids]
        );
        rows = response.rows.map(row => toSquad(row) as unknown as Record<string, unknown>);
        break;
      }
      case 'workspace_squad_owners':
      case 'workspace_squad_projects': {
        if (!access.canReadSquads) return new Map();
        const response = await this.sql.query<Record<string, unknown>>(
          `select * from public.${table} where workspace_id = $1 and id = any($2::text[])`,
          [workspaceId, ids]
        );
        rows = response.rows;
        break;
      }
      case 'workspace_project_assignments': {
        const response = await this.sql.query<Record<string, unknown>>(`
          select * from public.workspace_project_assignments
          where workspace_id = $1 and id = any($2::text[])
            and ($3::text[] is null or project_id = any($3::text[]))
        `, [workspaceId, ids, allowedProjectIds]);
        rows = response.rows;
        break;
      }
    }

    return new Map(rows.map(row => [String(row.id), row]));
  }
}
