import type { SupabaseClient } from '@supabase/supabase-js';

import type { Issue, IssueComment, Project, ProjectResource } from '../models/index.js';
import { toComment, toIssue, type CommentRow, type IssueRow } from '../store/postgresIssueStore.js';
import { toProject, type ProjectRow } from '../store/postgresProjectStore.js';
import { repoForProject } from './githubIssueMapping.js';
import { sqliteService } from './sqliteService.js';
import { runWithWorkspace } from './workspaceContext.js';
import { logInfo } from '../utils/logger.js';
import type { SyncReport } from './githubBoardSync.js';

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

/** Where the team's board is read from. */
export interface SharedBoardSource {
  projects(workspaceId: string): Promise<Project[]>;
  /** Issues without their comments, which `comments` returns. */
  issues(workspaceId: string): Promise<Issue[]>;
  /** Every comment on an issue this caller may see. */
  comments(): Promise<IssueComment[]>;
}

export interface PullReport {
  projectsAdded: number;
  projectsUpdated: number;
  issuesAdded: number;
  issuesUpdated: number;
  unchanged: number;
  comments: number;
  /** Cards this machine already has under another id; see the module comment. */
  conflicts: Array<{ project: string; detail: string }>;
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
    projects: pull.projectsAdded + pull.projectsUpdated,
    created: pull.issuesAdded,
    updated: pull.issuesUpdated + pull.projectsUpdated,
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

/** Write the team's board into this machine's store. */
export async function pullSharedBoard(workspaceId: string, source: SharedBoardSource): Promise<PullReport> {
  // Read everything before writing anything, so a failure part-way through
  // the network leaves the local board as it was.
  const [projects, issues, comments] = await Promise.all([
    source.projects(workspaceId),
    source.issues(workspaceId),
    source.comments()
  ]);

  const report: PullReport = {
    projectsAdded: 0,
    projectsUpdated: 0,
    issuesAdded: 0,
    issuesUpdated: 0,
    unchanged: 0,
    comments: 0,
    conflicts: []
  };

  runWithWorkspace(workspaceId, () => {
    applyProjects(projects, report);
    applyIssues(issues, report);
    applyComments(comments, report);
  });

  logInfo(
    `Team board: ${report.projectsAdded} project(s) added, ${report.projectsUpdated} updated; ` +
      `${report.issuesAdded} issue(s) added, ${report.issuesUpdated} updated; ${report.comments} comment(s)` +
      (report.conflicts.length ? `; ${report.conflicts.length} clash(es) with cards made on this machine` : '')
  );
  return report;
}

function applyProjects(projects: Project[], report: PullReport): void {
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
        report.conflicts.push({ project: cloud.key, detail: `Could not update: ${(err as Error).message}` });
      }
      continue;
    }

    const repo = repoForProject(cloud)?.toLowerCase();
    const twin = repo ? byRepo.get(repo) : undefined;
    if (twin) {
      report.conflicts.push({
        project: twin.key,
        detail:
          `This machine has its own project for ${repo} (${twin.key}), made before it joined the team, whose ` +
          `project is ${cloud.key}. Runs on ${twin.key} stay on this machine. Remove ${twin.key} to use the team's.`
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
