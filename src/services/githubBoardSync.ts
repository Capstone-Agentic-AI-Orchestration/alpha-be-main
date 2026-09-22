import { issueStore, projectStore } from '../store/stores.js';
import { githubApi } from './githubApi.js';
import { logInfo, logError } from './../utils/logger.js';
import { Issue, IssueComment, Project } from '../models/index.js';
import {
  GitHubIssue,
  isPullRequest,
  mapIssue,
  parseRepoRef,
  MappedIssue
} from './githubIssueMapping.js';

/**
 * Pull the shared board down from GitHub.
 *
 * Alpha's issues live in `~/.alpha/alpha.db`, one file per person per machine.
 * A second collaborator installing Alpha gets an empty board, and nothing syncs
 * — so the kanban that the whole collaboration story rests on is single-player.
 *
 * GitHub already holds shared issues, with the membership and per-repository
 * permissions this organisation's six people are already inside. This reads
 * them onto the board.
 *
 * ## One direction, for now
 *
 * Reading is safe and idempotent; writing back is where two people editing the
 * same card at once has to be resolved, and that deserves its own change. So
 * this pulls, and Alpha-side edits stay local until the write path lands.
 *
 * ## What is preserved
 *
 * A card carries things GitHub has never heard of — which agent is assigned,
 * its runs, its branch, its squad. Those are matched by `(repo, number)` and
 * kept across every sync. Only the fields GitHub owns are overwritten.
 */

export interface SyncReport {
  /** Projects that had a GitHub repository to read. */
  projects: number;
  created: number;
  updated: number;
  unchanged: number;
  /** Comments read from GitHub onto cards. */
  commentsPulled: number;
  /** Local comments published to GitHub — run summaries, mostly. */
  commentsPushed: number;
  /** Projects skipped, with why — a project with no repo is not an error. */
  skipped: Array<{ project: string; reason: string }>;
  errors: Array<{ project: string; detail: string }>;
}

/** The repository a project's issues live in, if it has one. */
export function repoForProject(project: Project): string | null {
  for (const resource of project.resources ?? []) {
    if (resource.type !== 'github_repo') continue;
    const ref = parseRepoRef(resource.pathOrUrl);
    if (ref) return `${ref.owner}/${ref.repo}`;
  }
  return null;
}

/**
 * Every issue in a repository, pull requests excluded.
 *
 * Every page, because a real board outgrows one, and a board that silently
 * stopped at a hundred cards would look like issues had been deleted.
 */
async function fetchIssues(ownerRepo: string): Promise<GitHubIssue[]> {
  const issues = await githubApi().getAll<GitHubIssue>(`/repos/${ownerRepo}/issues?state=all&per_page=100`);
  return issues.filter(i => !isPullRequest(i));
}

/** An identifier for a card that came from GitHub, in the project's own scheme. */
function identifierFor(project: Project, mapped: MappedIssue): string {
  return `${(project.key || 'ISS').toUpperCase()}-${mapped.githubNumber}`;
}

/**
 * Fields GitHub owns. Everything else on the card is Alpha's and survives.
 *
 * Compared before writing so an unchanged issue does not bump `updated_at` on
 * every sync — which would make every card look freshly touched and destroy any
 * sense of what has actually moved.
 */
function differs(existing: Issue, mapped: MappedIssue): boolean {
  return (
    existing.title !== mapped.title ||
    existing.description !== mapped.description ||
    existing.status !== mapped.status ||
    existing.priority !== mapped.priority ||
    (existing.createdBy ?? undefined) !== mapped.createdBy ||
    (existing.assignedHuman ?? undefined) !== mapped.assignedHuman ||
    JSON.stringify(existing.labels ?? []) !== JSON.stringify(mapped.labels)
  );
}

/**
 * Comments, in both directions.
 *
 * The board synced and the conversation on it did not. Every run posts its
 * summary as an issue comment — what it changed, why it stopped, that a review
 * was approved — and all of it stayed on the machine that ran it. A teammate
 * saw a card sitting in Review with no account of how it got there.
 *
 * ## No queue
 *
 * Comments are written from ten places, only some of which are an HTTP request,
 * so "push when a person acts" does not reach them. Instead the absence of a
 * `githubId` *is* the queue: anything without one has not been published, and
 * anything pulled from GitHub arrives with one, so it is never sent back.
 *
 * ## Attribution
 *
 * GitHub records the token's owner as the author, so a comment from the
 * Architect would appear as written by whoever is signed in. The real author is prefixed
 * into the body rather than lost — a teammate reading the issue needs to know a
 * machine said it, not a person.
 */
interface GitHubComment {
  id: number;
  body: string;
  user?: { login: string } | null;
  created_at: string;
}

/** Marks a comment Alpha published, so a pull can recognise its own writing. */
const ALPHA_COMMENT_MARK = '<!-- alpha -->';

function bodyForGitHub(comment: IssueComment): string {
  const who =
    comment.authorType === 'agent' ? `**${comment.authorName}** (agent)`
    : comment.authorType === 'system' ? `**${comment.authorName}**`
    : `**${comment.authorName}**`;
  return `${ALPHA_COMMENT_MARK}\n${who}\n\n${comment.content}`;
}

/** Undo the prefix when reading one of Alpha's own comments back. */
function bodyFromGitHub(body: string): { content: string; authorName?: string } {
  if (!body.startsWith(ALPHA_COMMENT_MARK)) return { content: body };
  const rest = body.slice(ALPHA_COMMENT_MARK.length).trimStart();
  const match = /^\*\*(.+?)\*\*(?:\s*\(agent\))?\s*\n\n([\s\S]*)$/.exec(rest);
  return match ? { authorName: match[1], content: match[2] } : { content: rest };
}

/** Pull an issue's comments onto the card. */
async function syncCommentsFor(issue: Issue, report: SyncReport, workspaceId: string): Promise<void> {
  if (!issue.githubRepo || !issue.githubNumber) return;

  let remote: GitHubComment[];
  try {
    remote = await githubApi().getAll<GitHubComment>(
      `/repos/${issue.githubRepo}/issues/${issue.githubNumber}/comments?per_page=100`
    );
  } catch {
    // A comment fetch failing must not fail the issue's own sync.
    return;
  }

  const known = new Set((issue.comments ?? []).map(c => c.githubId).filter(Boolean));

  for (const gh of remote) {
    if (known.has(gh.id)) continue;
    const { content, authorName } = bodyFromGitHub(gh.body ?? '');
    await issueStore().addComment(workspaceId, {
      id: `gh-${issue.githubRepo}-${gh.id}`,
      issueId: issue.id,
      // Alpha's own comments come back as system or agent text; a teammate's
      // is a person. The prefix is what distinguishes them.
      authorType: authorName ? 'system' : 'user',
      authorName: authorName ?? gh.user?.login ?? 'GitHub',
      content,
      githubId: gh.id,
      createdAt: gh.created_at
    });
    report.commentsPulled += 1;
  }
}

/** Publish any comment on this card that has not reached GitHub. */
async function pushCommentsFor(issue: Issue, report: SyncReport, workspaceId: string): Promise<void> {
  if (!issue.githubRepo || !issue.githubNumber) return;

  for (const comment of issue.comments ?? []) {
    if (comment.githubId) continue;
    // A thinking placeholder is a spinner, not a statement. Publishing it would
    // put "…" on the issue for everyone to read.
    if (comment.isThinking) continue;

    try {
      const created = await githubApi().post<{ id: number }>(
        `/repos/${issue.githubRepo}/issues/${issue.githubNumber}/comments`,
        { body: bodyForGitHub(comment) }
      );
      await issueStore().addComment(workspaceId, { ...comment, githubId: created.id });
      report.commentsPushed += 1;
    } catch (err: any) {
      logError(`Could not publish a comment on ${issue.identifier}:`, String(err?.message ?? err));
      // Left without an id, so the next sync tries again.
    }
  }
}

/** Read one project's repository onto the board. */
async function syncProject(project: Project, report: SyncReport, workspaceId: string): Promise<void> {
  const ownerRepo = repoForProject(project);
  if (!ownerRepo) {
    report.skipped.push({ project: project.key, reason: 'no GitHub repository attached' });
    return;
  }

  let issues: GitHubIssue[];
  try {
    issues = await fetchIssues(ownerRepo);
  } catch (err: any) {
    const detail = String(err?.stderr || err?.message || err).trim();
    report.errors.push({ project: project.key, detail });
    logError(`Board sync failed for ${project.key} (${ownerRepo}):`, detail);
    return;
  }

  report.projects += 1;
  const existing = (await issueStore().list(workspaceId)).filter(i => i.projectId === project.id);
  const byNumber = new Map(
    existing.filter(i => i.githubRepo === ownerRepo && i.githubNumber).map(i => [i.githubNumber!, i])
  );

  for (const raw of issues) {
    const mapped = mapIssue(raw, ownerRepo);
    const match = byNumber.get(mapped.githubNumber);

    if (!match) {
      await issueStore().create(workspaceId, {
        projectId: project.id,
        identifier: identifierFor(project, mapped),
        title: mapped.title,
        description: mapped.description,
        status: mapped.status,
        priority: mapped.priority,
        createdBy: mapped.createdBy,
        assignedHuman: mapped.assignedHuman,
        labels: mapped.labels,
        githubRepo: mapped.githubRepo,
        githubNumber: mapped.githubNumber,
        githubUrl: mapped.githubUrl,
        createdAt: mapped.createdAt,
        updatedAt: mapped.updatedAt
      });
      report.created += 1;
      continue;
    }

    if (!differs(match, mapped)) {
      report.unchanged += 1;
      continue;
    }

    /**
     * Only the fields GitHub owns.
     *
     * `assignedAgentId`, `assignedSquadId`, `branchName` and `prUrl` are Alpha's
     * — spreading the whole mapped object would erase which agent is mid-run on
     * this card every time someone edited its title on github.com.
     */
    await issueStore().update(workspaceId, match.id, {
      title: mapped.title,
      description: mapped.description,
      status: mapped.status,
      priority: mapped.priority,
      createdBy: mapped.createdBy,
      assignedHuman: mapped.assignedHuman,
      labels: mapped.labels,
      githubUrl: mapped.githubUrl
    });
    report.updated += 1;
  }
}

/**
 * Read every project's repository onto the board.
 *
 * Sequential rather than parallel: GitHub rate-limits per person, and a
 * workspace with a dozen repositories would otherwise spend a dozen requests
 * at once of the budget the person's own browsing also draws on.
 */
export async function syncBoardFromGitHub(workspaceId: string): Promise<SyncReport> {
  const report: SyncReport = {
    projects: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    commentsPulled: 0,
    commentsPushed: 0,
    skipped: [],
    errors: []
  };

  for (const project of await projectStore().list(workspaceId)) {
    await syncProject(project, report, workspaceId);
  }

  /**
   * Comments, after every issue exists.
   *
   * Done as a second pass rather than inside syncProject: a comment needs its
   * card to have been created and to know its issue number, and on a first sync
   * that only becomes true once the issue pass has finished.
   *
   * Re-read rather than reusing the earlier list — the issues written a moment
   * ago are not in it.
   */
  for (const issue of await issueStore().list(workspaceId)) {
    if (!issue.githubRepo || !issue.githubNumber) continue;
    await syncCommentsFor(issue, report, workspaceId);
    // Re-read once more: a pull may have just added comments this push would
    // otherwise consider missing and send straight back.
    const fresh = await issueStore().get(workspaceId, issue.id);
    if (fresh) await pushCommentsFor(fresh, report, workspaceId);
  }

  logInfo(
    `Board sync: ${report.created} created, ${report.updated} updated, ` +
      `${report.unchanged} unchanged across ${report.projects} project(s); ` +
      `comments ${report.commentsPulled} in / ${report.commentsPushed} out` +
      (report.errors.length ? `, ${report.errors.length} failed` : '')
  );

  return report;
}
