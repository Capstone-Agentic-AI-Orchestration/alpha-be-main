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
  /**
   * This machine's own agents and squads that the team does not have, for the
   * caller to publish. Read here, sent from `dataController`, which is where
   * the uplink lives.
   */
  unpublished: { agents: Agent[]; squads: Squad[] };
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
    // Cards, which is what the app reports as new and updated. Agents and
    // squads move too, and are in the log rather than in a count of issues.
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

  const report: PullReport = {
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
    unpublished: { agents: [], squads: [] },
    conflicts: []
  };

  runWithWorkspace(workspaceId, () => {
    // The roster first: an issue names an agent, and a squad names its members.
    applyRoster(agents, squads, report);
    applyProjects(projects, report);
    applyIssues(issues, report);
    applyComments(comments, report);
  });

  await applySquadBindings(workspaceId, owners, links);
  await applyProjectAssignments(workspaceId, assignments);

  logInfo(
    `Team board: ${report.agentsAdded} agent(s) added, ${report.squadsAdded} squad(s) added; ` +
      `${report.projectsAdded} project(s) added, ${report.projectsUpdated} updated; ` +
      `${report.issuesAdded} issue(s) added, ${report.issuesUpdated} updated; ${report.comments} comment(s)` +
      (report.conflicts.length ? `; ${report.conflicts.length} clash(es) with cards made on this machine` : '')
  );
  return report;
}

/**
 * The team's agents and squads, onto this machine.
 *
 * What the local persona file declares is left alone: the file is this
 * machine's authority on how an agent behaves, and `updateAgent` rewrites the
 * file's frontmatter from whatever it is given. What this machine has and the
 * team does not is collected to be published, so that an issue assigned to it
 * is a reference the cloud can keep -- `0011` enforces that again.
 */
function applyRoster(agents: Agent[], squads: Squad[], report: PullReport): void {
  const localAgents = sqliteService.getAgents();
  const byId = new Map(localAgents.map(agent => [agent.id, agent]));

  for (const cloud of agents) {
    const mine = byId.get(cloud.id);
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
    if (!differs(mine, next)) {
      report.unchanged += 1;
      continue;
    }
    sqliteService.updateAgent(cloud.id, next);
    report.agentsUpdated += 1;
  }

  const shared = new Set(agents.map(agent => agent.id));
  report.unpublished.agents = localAgents.filter(agent => !shared.has(agent.id));

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

/** The fields of an agent the team decides, minus whatever its persona file declares here. */
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
  for (const key of declaredInFile) delete fields[key as keyof Agent];
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
