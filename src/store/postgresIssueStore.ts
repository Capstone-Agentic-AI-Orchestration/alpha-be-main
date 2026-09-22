import { randomUUID } from 'node:crypto';
import type { Issue, IssueComment, IssueSubtask } from '../models/index.js';
import type { Sql } from './database.js';
import { nextIssueIdentifier, oneOwner, type IssueStore } from './issueStore.js';

/**
 * The board in the cloud.
 *
 * Every statement is scoped by `workspace_id`, so another workspace's cards
 * are never read rather than filtered out afterwards. Comments have no
 * workspace of their own: they hang off an issue, and reaching one means
 * reaching its issue first.
 *
 * ## Assignments are stored as given
 *
 * The desktop's store checks `assignedAgentId` and `assignedSquadId` against
 * its own roster and drops what it does not recognise. The cloud has no
 * roster yet -- agents and squads are the next slice -- so a check here would
 * silently discard every assignment a PM makes. They are written as sent, and
 * `0009` removes the foreign key that would otherwise refuse them; it comes
 * back when agents do.
 */
export class PostgresIssueStore implements IssueStore {
  constructor(private readonly sql: Sql) {}

  async list(workspaceId: string): Promise<Issue[]> {
    const { rows } = await this.sql.query<IssueRow>(
      'select * from issues where workspace_id = $1 order by created_at desc',
      [workspaceId]
    );
    if (!rows.length) return [];

    /*
     * Every comment in the workspace, in one query rather than one per issue.
     * A board with two hundred cards would otherwise be two hundred round
     * trips to draw once.
     */
    const { rows: comments } = await this.sql.query<CommentRow>(
      `select c.* from issue_comments c
       join issues i on i.id = c.issue_id
       where i.workspace_id = $1
       order by c.created_at asc`,
      [workspaceId]
    );

    const byIssue = new Map<string, IssueComment[]>();
    for (const comment of comments) {
      const list = byIssue.get(comment.issue_id) ?? [];
      list.push(toComment(comment));
      byIssue.set(comment.issue_id, list);
    }

    return rows.map(row => toIssue(row, byIssue.get(row.id) ?? []));
  }

  async get(workspaceId: string, id: string): Promise<Issue | null> {
    const { rows } = await this.sql.query<IssueRow>(
      'select * from issues where workspace_id = $1 and id = $2',
      [workspaceId, id]
    );
    if (!rows[0]) return null;

    const { rows: comments } = await this.sql.query<CommentRow>(
      'select * from issue_comments where issue_id = $1 order by created_at asc',
      [id]
    );
    return toIssue(rows[0], comments.map(toComment));
  }

  async create(workspaceId: string, input: Partial<Issue>): Promise<Issue> {
    const projectId = await this.projectFor(workspaceId, input.projectId);
    const now = new Date().toISOString();
    const identifier = input.identifier || (await this.nextIdentifier(workspaceId, projectId));

    const issue: Issue = {
      ...input,
      // Random as well as timed; see sqliteService.createIssue.
      id: input.id || `issue-${Date.now()}-${randomUUID().slice(0, 8)}`,
      identifier,
      title: input.title || 'Untitled Issue',
      description: input.description ?? '',
      status: input.status || 'todo',
      priority: input.priority || 'medium',
      projectId,
      labels: input.labels || [],
      subtasks: input.subtasks || [],
      comments: input.comments || [],
      createdAt: input.createdAt || now,
      updatedAt: input.updatedAt || now
    } as Issue;
    oneOwner(issue, { assignedSquadId: issue.assignedSquadId !== undefined });

    await this.sql.query(
      `insert into issues
         (id, workspace_id, identifier, title, description, status, priority, project_id,
          assigned_agent_id, assigned_squad_id, assigned_human, created_by, labels, subtasks,
          branch_name, pr_url, github_repo, github_number, github_url, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
      [
        issue.id,
        workspaceId,
        issue.identifier,
        issue.title,
        issue.description,
        issue.status,
        issue.priority,
        issue.projectId,
        issue.assignedAgentId ?? null,
        issue.assignedSquadId ?? null,
        issue.assignedHuman ?? null,
        issue.createdBy ?? null,
        JSON.stringify(issue.labels),
        JSON.stringify(issue.subtasks),
        issue.branchName ?? null,
        issue.prUrl ?? null,
        issue.githubRepo ?? null,
        issue.githubNumber ?? null,
        issue.githubUrl ?? null,
        issue.createdAt,
        issue.updatedAt
      ]
    );

    /*
     * Comments arrive from a caller with no issue id to give them: a client
     * composing the opening comment of an issue it is in the middle of
     * creating cannot know one. Filled in here, the first moment it exists.
     */
    for (const comment of issue.comments) {
      await this.addComment(workspaceId, { ...comment, issueId: issue.id });
    }
    return issue;
  }

  async update(workspaceId: string, id: string, updates: Partial<Issue>): Promise<Issue | null> {
    const existing = await this.get(workspaceId, id);
    if (!existing) return null;

    const merged: Issue = { ...existing, ...updates, updatedAt: new Date().toISOString() };
    if (updates.projectId) {
      merged.projectId = await this.projectFor(workspaceId, updates.projectId, existing.projectId);
    }
    oneOwner(merged, {
      assignedAgentId: updates.assignedAgentId !== undefined,
      assignedSquadId: updates.assignedSquadId !== undefined
    });

    await this.sql.query(
      `update issues set
         title = $3, description = $4, status = $5, priority = $6, project_id = $7,
         assigned_agent_id = $8, assigned_squad_id = $9, assigned_human = $10,
         labels = $11, subtasks = $12, branch_name = $13, pr_url = $14,
         github_repo = $15, github_number = $16, github_url = $17, updated_at = $18
       where workspace_id = $1 and id = $2`,
      [
        workspaceId,
        id,
        merged.title,
        merged.description,
        merged.status,
        merged.priority,
        merged.projectId,
        merged.assignedAgentId ?? null,
        merged.assignedSquadId ?? null,
        merged.assignedHuman ?? null,
        JSON.stringify(merged.labels ?? []),
        JSON.stringify(merged.subtasks ?? []),
        merged.branchName ?? null,
        merged.prUrl ?? null,
        merged.githubRepo ?? null,
        merged.githubNumber ?? null,
        merged.githubUrl ?? null,
        merged.updatedAt
      ]
    );
    return merged;
  }

  async remove(workspaceId: string, id: string): Promise<boolean> {
    // Comments go with it, by the schema's `on delete cascade`.
    const { rows } = await this.sql.query(
      'delete from issues where workspace_id = $1 and id = $2 returning id',
      [workspaceId, id]
    );
    return rows.length > 0;
  }

  /**
   * A comment on an issue of this workspace, or nothing.
   *
   * Silently ignored for an unknown issue, as the desktop store does: the
   * writers are sync passes and run summaries, for which a missing card is a
   * race rather than a request to refuse.
   */
  async addComment(workspaceId: string, comment: IssueComment): Promise<IssueComment> {
    const { rows } = await this.sql.query(
      'select id from issues where workspace_id = $1 and id = $2',
      [workspaceId, comment.issueId]
    );
    if (!rows.length) return comment;

    await this.sql.query(
      `insert into issue_comments
         (id, issue_id, author_type, author_name, author_avatar, agent_id, content, is_thinking, github_id, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       on conflict (id) do update set
         content = excluded.content, is_thinking = excluded.is_thinking, github_id = excluded.github_id`,
      [
        comment.id,
        comment.issueId,
        comment.authorType,
        comment.authorName,
        comment.authorAvatar ?? null,
        comment.agentId ?? null,
        comment.content,
        comment.isThinking ?? false,
        comment.githubId ?? null,
        comment.createdAt || new Date().toISOString()
      ]
    );
    return comment;
  }

  /** The project an issue belongs to: the one asked for, or the workspace's first. */
  private async projectFor(workspaceId: string, wanted?: string, fallback?: string): Promise<string> {
    if (wanted) {
      const { rows } = await this.sql.query('select id from projects where workspace_id = $1 and id = $2', [
        workspaceId,
        wanted
      ]);
      if (rows.length) return wanted;
    }
    if (fallback) return fallback;

    const { rows } = await this.sql.query<{ id: string }>(
      'select id from projects where workspace_id = $1 order by created_at asc limit 1',
      [workspaceId]
    );
    return rows[0]?.id ?? '';
  }

  private async nextIdentifier(workspaceId: string, projectId: string): Promise<string> {
    const { rows } = await this.sql.query<{ key: string | null; identifier: string | null }>(
      `select p.key, i.identifier
       from projects p left join issues i on i.project_id = p.id
       where p.workspace_id = $1 and p.id = $2`,
      [workspaceId, projectId]
    );
    const key = rows[0]?.key ?? 'ISS';
    const used = rows.map(row => row.identifier).filter((value): value is string => Boolean(value));
    return nextIssueIdentifier(key, used);
  }
}

type Timestamp = Date | string;

export interface IssueRow {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  project_id: string;
  assigned_agent_id: string | null;
  assigned_squad_id: string | null;
  assigned_human: string | null;
  created_by: string | null;
  labels: string[] | null;
  subtasks: IssueSubtask[] | null;
  branch_name: string | null;
  pr_url: string | null;
  github_repo: string | null;
  github_number: number | null;
  github_url: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface CommentRow {
  id: string;
  issue_id: string;
  author_type: string;
  author_name: string;
  author_avatar: string | null;
  agent_id: string | null;
  content: string;
  github_id: string | number | null;
  is_thinking: boolean | null;
  created_at: Timestamp;
}

const iso = (value: Timestamp): string => new Date(value).toISOString();

/**
 * An issue as a row of `issues`, for writers that are not this store.
 *
 * The desktop shares its cards through the Data API rather than SQL, and has
 * to send the same columns this store writes. Kept beside `toIssue` so the two
 * directions are read together; `sharedBoard.test.ts` inserts one into the
 * real migration, which is the only check a column name typo would fail.
 */
export function issueRow(workspaceId: string, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    workspace_id: workspaceId,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? '',
    status: issue.status,
    priority: issue.priority,
    project_id: issue.projectId,
    assigned_agent_id: issue.assignedAgentId ?? null,
    assigned_squad_id: issue.assignedSquadId ?? null,
    assigned_human: issue.assignedHuman ?? null,
    created_by: issue.createdBy ?? null,
    labels: issue.labels ?? [],
    subtasks: issue.subtasks ?? [],
    branch_name: issue.branchName ?? null,
    pr_url: issue.prUrl ?? null,
    github_repo: issue.githubRepo ?? null,
    github_number: issue.githubNumber ?? null,
    github_url: issue.githubUrl ?? null,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt
  };
}

/** A comment as a row of `issue_comments`; see `issueRow`. */
export function commentRow(comment: IssueComment): Record<string, unknown> {
  return {
    id: comment.id,
    issue_id: comment.issueId,
    author_type: comment.authorType,
    author_name: comment.authorName,
    author_avatar: comment.authorAvatar ?? null,
    agent_id: comment.agentId ?? null,
    content: comment.content,
    is_thinking: comment.isThinking ?? false,
    github_id: comment.githubId ?? null,
    created_at: comment.createdAt || new Date().toISOString()
  };
}

export function toIssue(row: IssueRow, comments: IssueComment[]): Issue {
  return {
    id: row.id,
    identifier: row.identifier,
    title: row.title,
    description: row.description ?? '',
    status: row.status as Issue['status'],
    priority: row.priority as Issue['priority'],
    projectId: row.project_id,
    assignedAgentId: row.assigned_agent_id ?? undefined,
    assignedSquadId: row.assigned_squad_id ?? undefined,
    assignedHuman: row.assigned_human ?? undefined,
    createdBy: row.created_by ?? undefined,
    labels: row.labels ?? [],
    subtasks: row.subtasks ?? [],
    branchName: row.branch_name ?? undefined,
    prUrl: row.pr_url ?? undefined,
    githubRepo: row.github_repo ?? undefined,
    githubNumber: row.github_number ?? undefined,
    githubUrl: row.github_url ?? undefined,
    comments,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

export function toComment(row: CommentRow): IssueComment {
  return {
    id: row.id,
    issueId: row.issue_id,
    authorType: row.author_type as IssueComment['authorType'],
    authorName: row.author_name,
    authorAvatar: row.author_avatar ?? undefined,
    agentId: row.agent_id ?? undefined,
    content: row.content,
    isThinking: Boolean(row.is_thinking),
    // `bigint` comes back as a string from `pg`, and GitHub's ids are numbers.
    githubId: row.github_id === null ? undefined : Number(row.github_id),
    createdAt: iso(row.created_at)
  };
}
