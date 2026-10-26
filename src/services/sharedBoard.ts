import type { SupabaseClient } from '@supabase/supabase-js';

import type { Agent, Issue, IssueComment, Project, ProjectResource, Squad } from '../models/index.js';
import { toComment, toIssue, type CommentRow, type IssueRow } from '../store/postgresIssueStore.js';
import { toProject, type ProjectRow } from '../store/postgresProjectStore.js';
import { toAgent, toSquad, type AgentRow, type SquadRow } from '../store/postgresAgentStore.js';
import { readAgentFile } from './agentFileService.js';
import { workspaceRegistry } from './workspaceRegistry.js';
import { repoForProject } from './githubIssueMapping.js';
import { sqliteService } from './sqliteService.js';
import { runWithWorkspace } from './workspaceContext.js';
import { logInfo } from '../utils/logger.js';
import type { SyncReport } from './githubBoardSync.js';
import {
  boardChangeKey,
  type BoardChange,
  type BoardChangePage,
  type BoardChangeAccess,
  type BoardChangeLogPage,
  type BoardChangeLogRow,
  type BoardChangeSource,
  type BoardTable,
  type BoardState
} from './boardChangeSync.js';

/**
 * The team's board, onto this desktop.
 *
 * A desktop kept a board of its own, synced from GitHub on its own schedule
 * and under ids it made up, so a developer's run named an issue the cloud had
 * never heard of. The run tables have foreign keys to issues and projects, so
 * every run upload was refused -- which is why a project manager never saw a
 * developer's work.
 *
 * In team mode the board is the cloud's. This reads projects, issues and their
 * comments from Postgres, as the signed-in developer and within what the
 * row-level policies let them see, and writes them into this machine's SQLite
 * under the cloud's ids. The cloud is the one writer that syncs from GitHub;
 * the desktop mirrors it and writes its own changes back (`supabaseService`).
 *
 * ## What the cloud does not decide
 *
 * A project's folders on this machine -- `local_path` and `local_dir`
 * resources -- are this machine's, and the cloud never stores them. They are
 * kept across every pull. So is the state of a card an agent is running on
 * here: the runner owns it until the run ends, and a pull arriving mid-run
 * must not put the card back in Todo.
 *
 * ## What is not merged
 *
 * A card this machine made before it joined the team, for a repository or an
 * issue the team also has, sits under a different id. Re-keying it would mean
 * rewriting every run, comment and assignment that points at it, so the pull
 * does not guess: it reports the clash, keeps the local card, and leaves the
 * team's out until the local one is removed. Nothing is ever deleted here.
 */

/** Who owns a squad, and which projects it serves. */
export interface SquadOwnerRow {
  squad_id: string;
  user_id: string;
  status: string;
}

export interface SquadProjectRow {
  squad_id: string;
  project_id: string;
  relationship: string;
  status: string;
}

/** Which person is on which project. */
export interface ProjectAssignmentRow {
  project_id: string;
  user_id: string;
  status: string;
}

/** Where the team's board is read from. */
export interface SharedBoardSource {
  projects(workspaceId: string): Promise<Project[]>;
  /** Issues without their comments, which `comments` returns. */
  issues(workspaceId: string): Promise<Issue[]>;
  /** Every comment on an issue this caller may see. */
  comments(): Promise<IssueComment[]>;
  /** The agents this caller may address; a private one of someone else's is not among them. */
  agents(workspaceId: string): Promise<Agent[]>;
  squads(workspaceId: string): Promise<Squad[]>;
  squadOwners(workspaceId: string): Promise<SquadOwnerRow[]>;
  squadProjects(workspaceId: string): Promise<SquadProjectRow[]>;
  /** Who is on which project: what a developer's issues, runs and chats are scoped by. */
  projectAssignments(workspaceId: string): Promise<ProjectAssignmentRow[]>;
}

export interface PullReport {
  projectsAdded: number;
  projectsUpdated: number;
  issuesAdded: number;
  issuesUpdated: number;
  unchanged: number;
  comments: number;
  agentsAdded: number;
  agentsUpdated: number;
  squadsAdded: number;
  squadsUpdated: number;
  /** This machine's own projects and cards moved onto the team's ids; see `rekeyProject`. */
  projectsAdopted: number;
  issuesAdopted: number;
  /** Projects the team no longer lists, taken off this machine; see `removeDroppedProjects`. */
  projectsRemoved: number;
  /**
   * This machine's own agents and squads that the team does not have, for the
   * caller to publish. Read here, sent from `dataController`, which is where
   * the uplink lives.
   */
  unpublished: { agents: Agent[]; squads: Squad[] };
  /** Cards this machine already has under another id; see the module comment. */
  conflicts: Array<{ project: string; detail: string }>;
  /** The authorized snapshot, after local merge rules have been applied. */
  snapshot?: BoardState;
}

/**
 * A pull, in the shape the app already reads from a GitHub sync.
 *
 * Clashes go in `errors`, which the app shows one by one: each is a card the
 * person has to act on, and a count would hide which.
 */
export function asSyncReport(pull: PullReport): SyncReport {
  return {
    projectsImported: pull.projectsAdded,
    // Adopted and removed projects count as changed, so the app re-reads its project list.
    projects: pull.projectsAdded + pull.projectsUpdated + pull.projectsAdopted + pull.projectsRemoved,
    // Cards, which is what the app reports as new and updated. Agents and
    // squads move too, and are in the log rather than in a count of issues.
    created: pull.issuesAdded,
    updated: pull.issuesUpdated + pull.projectsUpdated + pull.issuesAdopted + pull.projectsAdopted,
    unchanged: pull.unchanged,
    commentsPulled: pull.comments,
    commentsPushed: 0,
    skipped: [],
    errors: pull.conflicts
  };
}

/** PostgREST answers at most a thousand rows a request by default. */
const PAGE = 1000;

async function everyRow<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) return rows;
  }
}

/** The team's board through Supabase's Data API, under the developer's own token. */
export function supabaseBoardSource(client: SupabaseClient): SharedBoardSource {
  return {
    async projects(workspaceId) {
      const rows = await everyRow<ProjectRow>((from, to) =>
        client.from('projects').select('*').eq('workspace_id', workspaceId).order('id').range(from, to)
      );
      return rows.map(toProject);
    },
    async issues(workspaceId) {
      const rows = await everyRow<IssueRow>((from, to) =>
        client.from('issues').select('*').eq('workspace_id', workspaceId).order('id').range(from, to)
      );
      return rows.map(row => toIssue(row, []));
    },
    async comments() {
      const rows = await everyRow<CommentRow>((from, to) =>
        client.from('issue_comments').select('*').order('id').range(from, to)
      );
      return rows.map(toComment);
    },
    async agents(workspaceId) {
      const rows = await everyRow<AgentRow>((from, to) =>
        client.from('agents').select('*').eq('workspace_id', workspaceId).order('id').range(from, to)
      );
      return rows.map(toAgent);
    },
    async squads(workspaceId) {
      const rows = await everyRow<SquadRow>((from, to) =>
        client.from('squads').select('*').eq('workspace_id', workspaceId).order('id').range(from, to)
      );
      return rows.map(toSquad);
    },
    async squadOwners(workspaceId) {
      return everyRow<SquadOwnerRow>((from, to) =>
        client.from('workspace_squad_owners').select('*').eq('workspace_id', workspaceId).order('squad_id').range(from, to)
      );
    },
    async squadProjects(workspaceId) {
      return everyRow<SquadProjectRow>((from, to) =>
        client.from('workspace_squad_projects').select('*').eq('workspace_id', workspaceId).order('squad_id').range(from, to)
      );
    },
    async projectAssignments(workspaceId) {
      return everyRow<ProjectAssignmentRow>((from, to) =>
        client
          .from('workspace_project_assignments')
          .select('project_id,user_id,status')
          .eq('workspace_id', workspaceId)
          .order('project_id')
          .range(from, to)
      );
    }
  };
}

async function dataApiRows<T>(query: PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data ?? [];
}

function issueChangeRow(row: IssueRow): Record<string, unknown> {
  const { comments: _comments, ...issue } = toIssue(row, []);
  return issue;
}

/**
 * Incremental reads through the same signed-in Supabase client used by the
 * desktop's existing board source. RLS remains the row-level gate; explicit
 * workspace filters keep each request narrow and make the scope obvious.
 */
export function supabaseBoardChangeSource(client: SupabaseClient): BoardChangeSource {
  async function commentsForIssues(workspaceId: string, issueIds: string[]): Promise<IssueComment[]> {
    if (!issueIds.length) return [];
    const comments = await dataApiRows<CommentRow>(
      client.from('issue_comments').select('*').in('issue_id', issueIds).order('created_at')
    );
    return comments.map(toComment);
  }

  async function currentIssueIds(
    workspaceId: string,
    issueIds: string[],
    allowedProjectIds?: ReadonlySet<string>
  ): Promise<string[]> {
    if (!issueIds.length) return [];
    const rows = await dataApiRows<Pick<IssueRow, 'id' | 'project_id'>>(
      client.from('issues').select('id,project_id').eq('workspace_id', workspaceId).in('id', issueIds)
    );
    return rows
      .filter(row => !allowedProjectIds || allowedProjectIds.has(row.project_id))
      .map(row => row.id);
  }

  return {
    async watermark(workspaceId) {
      const { data, error } = await client
        .from('workspace_board_cursors')
        .select('last_cursor')
        .eq('workspace_id', workspaceId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return String(data?.last_cursor ?? '0');
    },

    async readAfter(workspaceId, after, limit) {
      const pageSize = Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.floor(limit))) : 100;
      const currentCursor = await this.watermark(workspaceId);
      const [oldestRows, found] = await Promise.all([
        dataApiRows<{ cursor: string | number }>(
          client.from('workspace_board_changes')
            .select('cursor')
            .eq('workspace_id', workspaceId)
            .order('cursor', { ascending: true })
            .limit(1)
        ),
        dataApiRows<{
          cursor: string | number;
          table_name: BoardTable;
          row_key: Record<string, string>;
          operation: BoardChangeLogRow['operation'];
          created_at: string;
        }>(
          client.from('workspace_board_changes')
            .select('cursor,table_name,row_key,operation,created_at')
            .eq('workspace_id', workspaceId)
            .gt('cursor', after)
            .lte('cursor', currentCursor)
            .order('cursor', { ascending: true })
            .limit(pageSize + 1)
        )
      ]);
      const hasMore = found.length > pageSize;
      return {
        rows: found.slice(0, pageSize).map(row => ({
          cursor: String(row.cursor),
          table: row.table_name,
          rowKey: row.row_key,
          operation: row.operation,
          createdAt: row.created_at
        })),
        hasMore,
        oldestCursor: oldestRows[0] ? String(oldestRows[0].cursor) : null,
        currentCursor
      } satisfies BoardChangeLogPage;
    },

    async snapshot(workspaceId, access): Promise<BoardState> {
      const [projectRows, agentRows] = await Promise.all([
        everyRow<ProjectRow>((from, to) =>
          client.from('projects').select('*').eq('workspace_id', workspaceId).order('id').range(from, to)
        ),
        access.canReadAgents
          ? everyRow<AgentRow>((from, to) =>
              client.from('agents').select('*').eq('workspace_id', workspaceId).order('id').range(from, to)
            )
          : Promise.resolve([] as AgentRow[])
      ]);
      let issues: Issue[] = [];
      if (access.canReadIssues) {
        let issueQuery = client.from('issues').select('*').eq('workspace_id', workspaceId);
        if (access.allowedProjectIds) {
          const projectIds = [...access.allowedProjectIds];
          if (!projectIds.length) issueQuery = null as any;
          else issueQuery = issueQuery.in('project_id', projectIds);
        }
        const issueRows = issueQuery
          ? await everyRow<IssueRow>((from, to) => issueQuery.order('id').range(from, to))
          : [];
        const comments = await commentsForIssues(workspaceId, issueRows.map(row => row.id));
        const byIssue = new Map<string, IssueComment[]>();
        for (const comment of comments) {
          const group = byIssue.get(comment.issueId) ?? [];
          group.push(comment);
          byIssue.set(comment.issueId, group);
        }
        issues = issueRows.map(row => toIssue(row, byIssue.get(row.id) ?? []));
      }
      return {
        projects: projectRows.map(toProject),
        agents: agentRows.map(toAgent),
        issues
      };
    },

    async readRows(workspaceId, changes, access) {
      const grouped = new Map<BoardTable, BoardChangeLogRow[]>();
      for (const change of changes) {
        const group = grouped.get(change.table) ?? [];
        group.push(change);
        grouped.set(change.table, group);
      }

      const result = new Map<string, Record<string, unknown>>();
      for (const [table, tableChanges] of grouped) {
        const ids = [...new Set(tableChanges.map(change => change.rowKey.id).filter(Boolean))];
        if (!ids.length) continue;
        let rows: Array<Record<string, unknown>> = [];

        switch (table) {
          case 'projects': {
            let query = client.from('projects').select('*').eq('workspace_id', workspaceId).in('id', ids);
            if (access.allowedProjectIds) {
              const allowed = ids.filter(id => access.allowedProjectIds?.has(id));
              if (!allowed.length) continue;
              query = query.in('id', allowed);
            }
            rows = (await dataApiRows<ProjectRow>(query)).map(row => toProject(row) as unknown as Record<string, unknown>);
            break;
          }
          case 'issues': {
            if (!access.canReadIssues) continue;
            let query = client.from('issues').select('*').eq('workspace_id', workspaceId).in('id', ids);
            if (access.allowedProjectIds) {
              const allowed = [...access.allowedProjectIds];
              if (!allowed.length) continue;
              query = query.in('project_id', allowed);
            }
            rows = (await dataApiRows<IssueRow>(query)).map(issueChangeRow);
            break;
          }
          case 'issue_comments': {
            if (!access.canReadIssues) continue;
            const candidates = await dataApiRows<CommentRow>(
              client.from('issue_comments').select('*').in('id', ids)
            );
            const allowedParentIds = await currentIssueIds(
              workspaceId,
              [...new Set(candidates.map(row => row.issue_id))],
              access.allowedProjectIds
            );
            rows = candidates
              .filter(row => allowedParentIds.includes(row.issue_id))
              .map(row => toComment(row) as unknown as Record<string, unknown>);
            break;
          }
          case 'agents': {
            if (!access.canReadAgents) continue;
            rows = (await dataApiRows<AgentRow>(
              client.from('agents').select('*').eq('workspace_id', workspaceId).in('id', ids)
            )).map(row => toAgent(row) as unknown as Record<string, unknown>);
            break;
          }
          case 'squads': {
            if (!access.canReadSquads) continue;
            rows = (await dataApiRows<SquadRow>(
              client.from('squads').select('*').eq('workspace_id', workspaceId).in('id', ids)
            )).map(row => toSquad(row) as unknown as Record<string, unknown>);
            break;
          }
          case 'workspace_squad_owners':
          case 'workspace_squad_projects': {
            if (!access.canReadSquads) continue;
            rows = await dataApiRows<Record<string, unknown>>(
              client.from(table).select('*').eq('workspace_id', workspaceId).in('id', ids)
            );
            break;
          }
          case 'workspace_project_assignments': {
            let query = client.from('workspace_project_assignments').select('*').eq('workspace_id', workspaceId).in('id', ids);
            if (access.allowedProjectIds) {
              const allowed = [...access.allowedProjectIds];
              if (!allowed.length) continue;
              query = query.in('project_id', allowed);
            }
            rows = await dataApiRows<Record<string, unknown>>(query);
            break;
          }
        }

        const byId = new Map(rows.map(row => [String(row.id), row]));
        for (const change of tableChanges) {
          const row = byId.get(change.rowKey.id);
          if (row) result.set(boardChangeKey(table, change.rowKey), row);
        }
      }
      return result;
    }
  };
}

const MACHINE_LOCAL = new Set<ProjectResource['type']>(['local_path', 'local_dir']);

/** Statuses during which the runner, not the team's board, owns a card. */
const RUNNING = new Set(['queued', 'running', 'awaiting_approval', 'validating']);

/** The fields of a project the team's board decides. */
function sharedProjectFields(cloud: Project, mine?: Project): Partial<Project> {
  const machineLocal = (mine?.resources ?? []).filter(resource => MACHINE_LOCAL.has(resource.type));
  return {
    name: cloud.name,
    key: cloud.key,
    description: cloud.description,
    color: cloud.color,
    icon: cloud.icon,
    status: cloud.status,
    priority: cloud.priority,
    startDate: cloud.startDate,
    targetDate: cloud.targetDate,
    leadType: cloud.leadType,
    leadName: cloud.leadName,
    leadAgentId: cloud.leadAgentId,
    githubOrg: cloud.githubOrg,
    createdBy: cloud.createdBy,
    resources: [...(cloud.resources ?? []), ...machineLocal]
  };
}

/** The fields of an issue the team's board decides; the runner's while it runs. */
function sharedIssueFields(cloud: Issue, running: boolean): Partial<Issue> {
  const fields: Partial<Issue> = {
    title: cloud.title,
    description: cloud.description,
    priority: cloud.priority,
    projectId: cloud.projectId,
    assignedSquadId: cloud.assignedSquadId,
    assignedHuman: cloud.assignedHuman,
    createdBy: cloud.createdBy,
    labels: cloud.labels,
    subtasks: cloud.subtasks,
    githubRepo: cloud.githubRepo,
    githubNumber: cloud.githubNumber,
    githubUrl: cloud.githubUrl
  };
  if (!running) {
    fields.status = cloud.status;
    fields.assignedAgentId = cloud.assignedAgentId;
    fields.branchName = cloud.branchName;
    fields.prUrl = cloud.prUrl;
  }
  return fields;
}

/**
 * Whether writing `next` would change anything.
 *
 * An empty value is the same as a missing one: Postgres hands back `''` for an
 * unset date where SQLite hands back null, and treating those as different
 * rewrote every project on every pull.
 */
function differs<T extends object>(mine: T, next: Partial<T>): boolean {
  const same = (value: unknown) => JSON.stringify(value === '' || value === undefined ? null : value);
  return (Object.keys(next) as Array<keyof T>).some(key => same(mine[key]) !== same(next[key]));
}

/**
 * Write the team's board into this machine's store.
 *
 * `syncingLogin` is who is pulling. Given it, a project the team no longer
 * lists is taken off this machine as well; see `removeDroppedProjects`.
 */
export async function pullSharedBoard(
  workspaceId: string,
  source: SharedBoardSource,
  syncingLogin?: string
): Promise<PullReport> {
  // Read everything before writing anything, so a failure part-way through
  // the network leaves the local board as it was.
  const [projects, issues, comments, agents, squads, owners, links, assignments] = await Promise.all([
    source.projects(workspaceId),
    source.issues(workspaceId),
    source.comments(),
    source.agents(workspaceId),
    source.squads(workspaceId),
    source.squadOwners(workspaceId),
    source.squadProjects(workspaceId),
    source.projectAssignments(workspaceId)
  ]);

  const report = emptyPullReport();

  runWithWorkspace(workspaceId, () => {
    // The roster first: an issue names an agent, and a squad names its members.
    applyRoster(agents, squads, report);
    applyProjects(projects, report);
    // Before the issues, so a dropped project's cards are not written back
    // under it -- `applyIssues` skips a card whose project is not here.
    if (syncingLogin) removeDroppedProjects(projects, syncingLogin, report);
    applyIssues(issues, report);
    applyComments(comments, report);
  });

  await applySquadBindings(workspaceId, owners, links);
  await applyProjectAssignments(workspaceId, assignments);

  const visibleProjectIds = new Set(projects.map(project => project.id));
  const visibleIssueIds = new Set(issues.map(issue => issue.id));
  const commentsByIssue = new Map<string, IssueComment[]>();
  for (const comment of comments) {
    if (!visibleIssueIds.has(comment.issueId)) continue;
    const list = commentsByIssue.get(comment.issueId) ?? [];
    list.push(comment);
    commentsByIssue.set(comment.issueId, list);
  }
  report.snapshot = {
    // The local copy contains this machine's folders and any runner-owned state.
    projects: runWithWorkspace(workspaceId, () => sqliteService.getProjects()).filter(project => visibleProjectIds.has(project.id)),
    agents,
    issues: runWithWorkspace(workspaceId, () => sqliteService.getIssues())
      .filter(issue => visibleIssueIds.has(issue.id))
      .map(issue => ({ ...issue, comments: commentsByIssue.get(issue.id) ?? [] }))
  };

  logInfo(
    `Team board: ${report.agentsAdded} agent(s) added, ${report.squadsAdded} squad(s) added; ` +
      `${report.projectsAdded} project(s) added, ${report.projectsUpdated} updated, ${report.projectsAdopted} adopted; ` +
      `${report.issuesAdopted} card(s) adopted; ` +
      `${report.issuesAdded} issue(s) added, ${report.issuesUpdated} updated; ${report.comments} comment(s)` +
      (report.conflicts.length ? `; ${report.conflicts.length} clash(es) with cards made on this machine` : '')
  );
  return report;
}

function emptyPullReport(): PullReport {
  return {
    projectsAdded: 0,
    projectsUpdated: 0,
    issuesAdded: 0,
    issuesUpdated: 0,
    unchanged: 0,
    comments: 0,
    agentsAdded: 0,
    agentsUpdated: 0,
    squadsAdded: 0,
    squadsUpdated: 0,
    projectsAdopted: 0,
    issuesAdopted: 0,
    projectsRemoved: 0,
    unpublished: { agents: [], squads: [] },
    conflicts: []
  };
}

/** Apply one bounded page to this desktop's SQLite mirror before advancing its cursor. */
export async function applySharedBoardChanges(workspaceId: string, page: BoardChangePage): Promise<void> {
  if (page.workspaceId !== workspaceId || page.nextCursor.workspaceId !== workspaceId) {
    throw new Error('The board change page does not match the active workspace.');
  }
  if (!/^(0|[1-9]\d*)$/.test(page.nextCursor.value)) {
    throw new Error('The next board cursor must be a non-negative decimal number.');
  }
  if (page.resetRequired) return;

  const report = emptyPullReport();
  const deletes = page.changes.filter(change => change.operation === 'delete');
  const writes = page.changes.filter(change => change.operation !== 'delete');
  const deleteOrder: BoardTable[] = ['projects', 'squads', 'agents', 'issues', 'issue_comments', 'workspace_squad_owners', 'workspace_squad_projects', 'workspace_project_assignments'];
  const writeOrder: BoardTable[] = ['agents', 'squads', 'projects', 'issues', 'issue_comments', 'workspace_squad_owners', 'workspace_squad_projects', 'workspace_project_assignments'];
  const sortBy = (order: BoardTable[]) => (left: BoardChange, right: BoardChange) => {
    const tableOrder = order.indexOf(left.table) - order.indexOf(right.table);
    return tableOrder || (BigInt(left.cursor) < BigInt(right.cursor) ? -1 : BigInt(left.cursor) > BigInt(right.cursor) ? 1 : 0);
  };

  await runWithWorkspace(workspaceId, async () => {
    for (const change of deletes.sort(sortBy(deleteOrder))) {
      await removeSharedBoardRow(workspaceId, change);
    }

    for (const change of writes.sort(sortBy(writeOrder))) {
      if (!change.row) continue;
      const conflictCount = report.conflicts.length;
      await applySharedBoardRow(workspaceId, change, report);
      if (report.conflicts.length > conflictCount) {
        throw new Error(report.conflicts[conflictCount].detail);
      }
    }
  });

  // The cursor is the acknowledgement: a failed merge above leaves it at the
  // previous value so the same page can safely be retried after restart.
  sqliteService.setBoardSyncCursor(workspaceId, page.nextCursor.value);
}

async function applySharedBoardRow(workspaceId: string, change: BoardChange, report: PullReport): Promise<void> {
  const row = change.row!;
  switch (change.table) {
    case 'projects':
      applyProjects([row as unknown as Project], report, true);
      return;
    case 'issues':
      applyIssues([row as unknown as Issue], report);
      return;
    case 'issue_comments':
      applyComments([row as unknown as IssueComment], report);
      return;
    case 'agents':
      applyRoster([row as unknown as Agent], [], report);
      return;
    case 'squads':
      applyRoster([], [row as unknown as Squad], report);
      return;
    case 'workspace_squad_owners': {
      const owner = row as unknown as SquadOwnerRow;
      if (owner.status === 'active') await workspaceRegistry.bindSquadOwner(workspaceId, owner.squad_id, owner.user_id);
      else await workspaceRegistry.unbind('squads', owner.squad_id);
      return;
    }
    case 'workspace_squad_projects': {
      const link = row as unknown as SquadProjectRow;
      if (link.status === 'active') {
        await workspaceRegistry.assignSquadProject(
          workspaceId, link.squad_id, link.project_id, link.relationship === 'owned' ? 'owned' : 'assigned'
        );
      } else {
        await workspaceRegistry.removeSquadProject(workspaceId, link.squad_id, link.project_id);
      }
      return;
    }
    case 'workspace_project_assignments': {
      const assignment = row as unknown as ProjectAssignmentRow;
      if (assignment.status === 'active') {
        await workspaceRegistry.assignProject(workspaceId, assignment.project_id, assignment.user_id);
      } else {
        await workspaceRegistry.removeProjectAssignment(workspaceId, assignment.project_id, assignment.user_id);
      }
      return;
    }
  }
}

async function removeSharedBoardRow(workspaceId: string, change: BoardChange): Promise<void> {
  const id = change.rowKey.id;
  if (!id) throw new Error(`The ${change.table} delete marker has no row id.`);
  switch (change.table) {
    case 'projects': {
      sqliteService.deleteProject(id);
      for (const assignment of await workspaceRegistry.listProjectAssignments(workspaceId, id)) {
        await workspaceRegistry.removeProjectAssignment(workspaceId, id, assignment.userId);
      }
      for (const link of await workspaceRegistry.listSquadProjectAssignments(workspaceId, id)) {
        await workspaceRegistry.removeSquadProject(workspaceId, link.squadId, id);
      }
      return;
    }
    case 'issues':
      sqliteService.deleteIssue(id);
      return;
    case 'issue_comments':
      sqliteService.deleteIssueComment(id);
      return;
    case 'agents':
      sqliteService.deleteAgent(id);
      return;
    case 'squads': {
      sqliteService.deleteSquad(id);
      for (const link of await workspaceRegistry.listSquadProjectAssignments(workspaceId)) {
        if (link.squadId === id) await workspaceRegistry.removeSquadProject(workspaceId, id, link.projectId);
      }
      await workspaceRegistry.unbind('squads', id);
      return;
    }
    case 'workspace_squad_owners':
    case 'workspace_squad_projects':
    case 'workspace_project_assignments':
      // These rows are retired by changing status; parent deletes clean up
      // their local bindings. A physical child delete has no current row body.
      return;
  }
}

/**
 * The team's agents and squads, onto this machine.
 *
 * Local persona prose and machine-only settings stay local. Workspace MCP
 * grants are shared intentionally: an admin may grant a server on the web,
 * and the next desktop pull must update both SQLite and the persona frontmatter
 * before that agent can run it. What this machine has and the team does not is
 * collected to be published, so issue assignments remain valid in the cloud.
 */
function applyRoster(agents: Agent[], squads: Squad[], report: PullReport): void {
  const localAgents = sqliteService.getAgents();
  const byId = new Map(localAgents.map(agent => [agent.id, agent]));
  const byTemplate = new Map(localAgents.filter(agent => agent.templateKey).map(agent => [agent.templateKey, agent]));

  for (const cloud of agents) {
    let mine = byId.get(cloud.id);
    let adopted = false;
    const twin = cloud.templateKey ? byTemplate.get(cloud.templateKey) : undefined;
    if (!mine && twin) {
      // Each workspace seeds locally before its first team pull. The same
      // template then arrives under the cloud's ID, which is what shared
      // assignments and uploaded runs must reference.
      if (!sqliteService.rekeyAgent(twin.id, cloud.id)) {
        report.conflicts.push({ project: cloud.name, detail: 'Could not reconcile this official agent with the team ID.' });
        continue;
      }
      byId.delete(twin.id);
      twin.id = cloud.id;
      byId.set(cloud.id, twin);
      mine = twin;
      adopted = true;
    }
    if (!mine) {
      // Machine config is this machine's; the cloud has no column for it.
      sqliteService.createAgent({ ...cloud, customCliArgs: '', envVars: [] });
      report.agentsAdded += 1;
      continue;
    }

    let declared: string[] = [];
    try {
      declared = Object.keys(readAgentFile(cloud.id) ?? {});
    } catch {
      // An unreadable persona file is not a reason to skip the update.
    }
    const next = sharedAgentFields(cloud, declared);
    if (!adopted && !differs(mine, next)) {
      report.unchanged += 1;
      continue;
    }
    sqliteService.updateAgent(cloud.id, next);
    report.agentsUpdated += 1;
  }

  const shared = new Set(agents.map(agent => agent.id));
  report.unpublished.agents = sqliteService.getAgents().filter(agent => !shared.has(agent.id));

  const localSquads = sqliteService.getSquads();
  const squadsById = new Map(localSquads.map(squad => [squad.id, squad]));
  for (const cloud of squads) {
    const mine = squadsById.get(cloud.id);
    if (!mine) {
      sqliteService.createSquad(cloud);
      report.squadsAdded += 1;
      continue;
    }
    if (!differs(mine, cloud)) {
      report.unchanged += 1;
      continue;
    }
    sqliteService.updateSquad(cloud.id, cloud);
    report.squadsUpdated += 1;
  }

  const sharedSquads = new Set(squads.map(squad => squad.id));
  report.unpublished.squads = localSquads.filter(squad => !sharedSquads.has(squad.id));
}

/** Team-owned fields; local persona frontmatter may override them except shared MCP grants. */
function sharedAgentFields(cloud: Agent, declaredInFile: string[]): Partial<Agent> {
  const fields: Partial<Agent> = {
    name: cloud.name,
    role: cloud.role,
    avatar: cloud.avatar,
    color: cloud.color,
    description: cloud.description,
    modelProvider: cloud.modelProvider,
    modelName: cloud.modelName,
    reasoningEffort: cloud.reasoningEffort,
    systemPrompt: cloud.systemPrompt,
    autonomyLevel: cloud.autonomyLevel,
    temperature: cloud.temperature,
    skills: cloud.skills,
    mcpServers: cloud.mcpServers,
    concurrencyLimit: cloud.concurrencyLimit,
    isArchived: cloud.isArchived,
    allowedUsers: cloud.allowedUsers
  };
  // Workspace grants must reach a developer's run even when a local persona
  // file already has an mcpServers field. updateAgent writes this explicit
  // value through to that file while preserving its prompt body.
  for (const key of declaredInFile) {
    if (key !== 'mcpServers') delete fields[key as keyof Agent];
  }
  return fields;
}

/**
 * Who owns which squad, and which projects it serves.
 *
 * Without the assignments a developer's squad run is refused here for a
 * project a project manager assigned it to on the web -- the check reads this
 * machine's copy.
 */
async function applySquadBindings(
  workspaceId: string,
  owners: SquadOwnerRow[],
  links: SquadProjectRow[]
): Promise<void> {
  const squads = new Set(runWithWorkspace(workspaceId, () => sqliteService.getSquads()).map(squad => squad.id));
  const projects = new Set(runWithWorkspace(workspaceId, () => sqliteService.getProjects()).map(project => project.id));

  for (const owner of owners) {
    if (!squads.has(owner.squad_id)) continue;
    if (owner.status === 'active') await workspaceRegistry.bindSquadOwner(workspaceId, owner.squad_id, owner.user_id);
    else await workspaceRegistry.unbind('squads', owner.squad_id);
  }

  for (const link of links) {
    if (!squads.has(link.squad_id) || !projects.has(link.project_id)) continue;
    if (link.status === 'active') {
      await workspaceRegistry.assignSquadProject(
        workspaceId,
        link.squad_id,
        link.project_id,
        link.relationship === 'owned' ? 'owned' : 'assigned'
      );
    } else {
      await workspaceRegistry.removeSquadProject(workspaceId, link.squad_id, link.project_id);
    }
  }
}

/**
 * Who is on which project, as the team has it.
 *
 * A developer sees a project's issues, runs and chats only with an active
 * assignment, and this machine answers that from its own copy. Without this a
 * project manager could assign someone on the web and the project stayed
 * empty on their desktop: listed, since every developer may discover a
 * project, but with none of its tasks.
 *
 * Mirrored both ways, so an assignment the team removed is removed here too.
 */
async function applyProjectAssignments(workspaceId: string, rows: ProjectAssignmentRow[]): Promise<void> {
  const cloud = new Map(rows.map(row => [JSON.stringify([row.project_id, row.user_id]), row]));
  for (const row of rows) {
    if (row.status === 'active') await workspaceRegistry.assignProject(workspaceId, row.project_id, row.user_id);
  }
  for (const local of await workspaceRegistry.listProjectAssignments(workspaceId)) {
    if (local.status !== 'active') continue;
    const match = cloud.get(JSON.stringify([local.projectId, local.userId]));
    if (!match || match.status !== 'active') {
      await workspaceRegistry.removeProjectAssignment(workspaceId, local.projectId, local.userId);
    }
  }
}

function applyProjects(projects: Project[], report: PullReport, propagateWriteErrors = false): void {
  const local = sqliteService.getProjects();
  const byId = new Map(local.map(project => [project.id, project]));
  const byRepo = new Map<string, Project>();
  for (const project of local) {
    const repo = repoForProject(project)?.toLowerCase();
    if (repo) byRepo.set(repo, project);
  }
  const keys = new Map(local.map(project => [project.key.toUpperCase(), project]));

  for (const cloud of projects) {
    const mine = byId.get(cloud.id);
    if (mine) {
      const next = sharedProjectFields(cloud, mine);
      if (!differs(mine, next)) {
        report.unchanged += 1;
        continue;
      }
      try {
        sqliteService.updateProject(cloud.id, next);
        report.projectsUpdated += 1;
      } catch (err) {
        if (propagateWriteErrors) throw err;
        report.conflicts.push({ project: cloud.key, detail: `Could not update: ${(err as Error).message}` });
      }
      continue;
    }

    const repo = repoForProject(cloud)?.toLowerCase();
    const twin = repo ? byRepo.get(repo) : undefined;
    if (twin) {
      /*
       * The same repository, made here while this desktop was off the team
       * board -- which every installed copy was until 2.0.7. It becomes the
       * team's project, history and folder included; see `rekeyProject`.
       * Only a key held by a *different* project here stops that.
       */
      const holder = keys.get(cloud.key.toUpperCase());
      if ((!holder || holder.id === twin.id) && sqliteService.rekeyProject(twin.id, cloud.id, cloud.key)) {
        sqliteService.updateProject(cloud.id, sharedProjectFields(cloud, { ...twin, id: cloud.id }));
        byId.set(cloud.id, { ...twin, id: cloud.id, key: cloud.key });
        report.projectsAdopted += 1;
        continue;
      }
      report.conflicts.push({
        project: twin.key,
        detail:
          `This machine has its own project for ${repo} (${twin.key}), made before it joined the team, whose ` +
          `project is ${cloud.key}` +
          (holder && holder.id !== twin.id ? `, and the key ${cloud.key} is taken here by ${holder.name}` : '') +
          `. Rename or remove ${holder && holder.id !== twin.id ? holder.key : twin.key} to use the team's.`
      });
      continue;
    }
    const holder = keys.get(cloud.key.toUpperCase());
    if (holder) {
      report.conflicts.push({
        project: cloud.key,
        detail: `The key ${cloud.key} is taken on this machine by ${holder.name}. Rename or remove it to see the team's ${cloud.name}.`
      });
      continue;
    }

    sqliteService.createProject({ ...cloud, ...sharedProjectFields(cloud) });
    report.projectsAdded += 1;
  }
}

/**
 * Take off this machine the projects the team no longer lists.
 *
 * The rest of the pull never removes anything, so a project the cloud hid or
 * deleted -- a repository no PM started, say -- stayed on every desktop, with
 * whoever last owned it as its creator, and went on appearing in the
 * catalogue and the chat. The cloud decides the catalogue; this follows it.
 *
 * Only what can have come from the team: a project someone else created
 * reached this machine through a pull, so the team not listing it any more is
 * the answer. A project the syncing person made themselves may simply not have
 * reached the cloud yet (made offline, a failed share), and one with no
 * creator predates the team board; both stay.
 *
 * An empty listing removes nothing. That is what an unauthenticated read
 * returns -- the database token failed and the anon key saw no rows -- and
 * acting on it would clear the whole catalogue from the machine.
 *
 * Removing a project takes its cards and runs here with it (the tables
 * cascade). The cloud keeps its own copy of the cards.
 */
function removeDroppedProjects(cloudProjects: Project[], syncingLogin: string, report: PullReport): void {
  if (cloudProjects.length === 0) return;

  const listed = new Set(cloudProjects.map(project => project.id));
  const me = syncingLogin.trim().toLowerCase();

  for (const local of sqliteService.getProjects()) {
    if (listed.has(local.id)) continue;
    const creator = local.createdBy?.trim().toLowerCase();
    if (!creator || creator === me) continue;

    try {
      if (sqliteService.deleteProject(local.id)) report.projectsRemoved += 1;
    } catch (err) {
      report.conflicts.push({ project: local.key, detail: `Could not remove: ${(err as Error).message}` });
    }
  }
}

function applyIssues(issues: Issue[], report: PullReport): void {
  const projects = new Set(sqliteService.getProjects().map(project => project.id));
  const local = sqliteService.getIssues();
  const byId = new Map(local.map(issue => [issue.id, issue]));
  const byGitHub = new Map<string, Issue>();
  for (const issue of local) {
    if (issue.githubRepo && issue.githubNumber) byGitHub.set(`${issue.githubRepo.toLowerCase()}#${issue.githubNumber}`, issue);
  }
  const identifiers = new Map(local.map(issue => [issue.identifier, issue]));
  const running = new Set(
    sqliteService.getPrototypeRuns().filter(run => RUNNING.has(run.status)).map(run => run.issueId)
  );

  for (const cloud of issues) {
    // Its project clashed with one of this machine's, which was reported once.
    if (!projects.has(cloud.projectId)) continue;

    const mine = byId.get(cloud.id);
    if (mine) {
      const next = sharedIssueFields(cloud, running.has(mine.id));
      if (!differs(mine, next)) {
        report.unchanged += 1;
        continue;
      }
      sqliteService.updateIssue(cloud.id, next);
      report.issuesUpdated += 1;
      continue;
    }

    const twin = cloud.githubRepo && cloud.githubNumber
      ? byGitHub.get(`${cloud.githubRepo.toLowerCase()}#${cloud.githubNumber}`)
      : undefined;
    /*
     * The same GitHub issue, carded here under an id of this machine's. It
     * takes the team's id and identifier, comments and runs included, and is
     * then updated like any card the team already shared with this machine.
     */
    if (twin && sqliteService.rekeyIssue(twin.id, cloud.id, cloud.identifier)) {
      sqliteService.updateIssue(cloud.id, sharedIssueFields(cloud, running.has(twin.id)));
      identifiers.delete(twin.identifier);
      report.issuesAdopted += 1;
      continue;
    }
    const holder = twin ?? identifiers.get(cloud.identifier);
    if (holder) {
      report.conflicts.push({
        project: holder.identifier,
        detail:
          `This machine has its own card for ${cloud.identifier}${twin ? ` (${cloud.githubRepo}#${cloud.githubNumber})` : ''}, ` +
          `made before it joined the team. Runs on it stay on this machine.`
      });
      continue;
    }

    sqliteService.createIssue({ ...cloud, comments: [] });
    report.issuesAdded += 1;
  }
}

function applyComments(comments: IssueComment[], report: PullReport): void {
  const issues = sqliteService.getIssues();
  const known = new Map<string, IssueComment>();
  for (const issue of issues) for (const comment of issue.comments ?? []) known.set(comment.id, comment);
  const issueIds = new Set(issues.map(issue => issue.id));

  for (const cloud of comments) {
    if (!issueIds.has(cloud.issueId)) continue;
    const mine = known.get(cloud.id);
    // New, or published to GitHub since -- the id is how the next sync knows.
    if (mine && mine.githubId === cloud.githubId && mine.content === cloud.content) continue;
    sqliteService.addIssueComment(cloud);
    report.comments += 1;
  }
}
