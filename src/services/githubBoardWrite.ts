import { projectStore } from '../store/stores.js';
import { githubApi } from './githubApi.js';
import { logInfo, logError } from './../utils/logger.js';
import { Issue, IssueStatus, IssuePriority } from '../models/index.js';
import { repoForProject } from './githubBoardSync.js';
import { labelsForWrite, stateForStatus, statusLabel, priorityLabel } from './githubIssueMapping.js';


/**
 * Push a board change up to GitHub.
 *
 * The read path made a teammate's issues visible here; this is the other
 * direction, and without it the board is still single-player — you can watch
 * what other people do and they cannot see anything you do.
 *
 * ## Why this lives above the data layer
 *
 * `sqliteService.updateIssue` stays pure. The sync writes through it constantly
 * while pulling, and if the data layer pushed, every pull would immediately
 * push what it had just pulled — a loop between two machines that would never
 * settle. So the push belongs to the HTTP layer, which is only ever reached by
 * a person doing something.
 */

/** Alpha's labels, with colours matching the board's columns. */
const MANAGED_LABELS: Array<{ name: string; color: string; description: string }> = [
  { name: statusLabel('backlog'), color: '6B7280', description: 'Alpha board: Backlog' },
  { name: statusLabel('todo'), color: '94A3B8', description: 'Alpha board: Todo' },
  { name: statusLabel('in_progress'), color: 'F59E0B', description: 'Alpha board: In Progress' },
  { name: statusLabel('agent_running'), color: 'D97706', description: 'Alpha board: an agent is working' },
  { name: statusLabel('review'), color: '8B5CF6', description: 'Alpha board: In Review' },
  { name: priorityLabel('urgent'), color: 'DC2626', description: 'Alpha board: urgent' },
  { name: priorityLabel('high'), color: 'F97316', description: 'Alpha board: high priority' },
  { name: priorityLabel('medium'), color: '64748B', description: 'Alpha board: medium priority' },
  { name: priorityLabel('low'), color: '475569', description: 'Alpha board: low priority' },
  { name: priorityLabel('none'), color: '334155', description: 'Alpha board: no priority' }
  // `alpha:done` is deliberately absent — done is expressed by closing the
  // issue, so the label would only ever be left behind on a reopen.
];

/**
 * Repositories whose labels have been checked this process.
 *
 * Cached because every write would otherwise list a repository's labels first,
 * and the answer changes about as often as someone edits their label set.
 */
const labelled = new Set<string>();

/**
 * Create Alpha's labels in a repository, once.
 *
 * Without this the first write to any fresh repository fails: adding a label
 * that does not exist is an error, not an implicit create. Found the hard way —
 * the first sync test could not set `alpha:in-progress` until the label was
 * made by hand.
 */
export async function ensureLabels(ownerRepo: string): Promise<void> {
  if (labelled.has(ownerRepo)) return;

  let existing = new Set<string>();
  try {
    const labels = await githubApi().getAll<{ name: string }>(`/repos/${ownerRepo}/labels?per_page=100`);
    existing = new Set(labels.map(label => label.name.toLowerCase()));
  } catch (err: any) {
    // A repository we cannot read labels on is one we cannot write to either;
    // let the write itself produce the error the caller reports.
    logError(`Could not list labels on ${ownerRepo}:`, String(err?.message ?? err));
    return;
  }

  for (const label of MANAGED_LABELS) {
    if (existing.has(label.name.toLowerCase())) continue;
    try {
      await githubApi().post(`/repos/${ownerRepo}/labels`, {
        name: label.name,
        color: label.color,
        description: label.description
      });
      logInfo(`Created label ${label.name} on ${ownerRepo}`);
    } catch (err: any) {
      // Someone else's concurrent sync may have just created it. Not fatal.
      logError(`Could not create ${label.name} on ${ownerRepo}:`, String(err?.message ?? err));
    }
  }

  labelled.add(ownerRepo);
}

/** The repository an issue's project points at, or null for a local-only card. */
async function repoForIssue(issue: Issue, workspaceId: string): Promise<string | null> {
  const project = await projectStore().get(workspaceId, issue.projectId);
  return project ? repoForProject(project) : null;
}

/** The GitHub issue a card became. */
export interface PublishedIssue {
  githubRepo: string;
  githubNumber: number;
  githubUrl: string;
  /** GitHub's own id for the issue, which the card's id is made from. */
  githubIssueId: number;
}

/**
 * Create the GitHub issue for a card that does not have one.
 *
 * Returns which issue it became, so the card can store it. A project with no
 * repository is not an error — a local-only board is a valid way to use
 * Alpha, and it simply has nothing to push to.
 */
export async function pushNewIssue(issue: Issue, workspaceId: string): Promise<PublishedIssue | null> {
  const ownerRepo = await repoForIssue(issue, workspaceId);
  if (!ownerRepo) return null;

  await ensureLabels(ownerRepo);

  const labels = labelsForWrite(issue.status, issue.priority, issue.labels ?? []);
  const created = await githubApi().post<{ id: number; number: number; html_url: string }>(`/repos/${ownerRepo}/issues`, {
    title: issue.title,
    body: issue.description ?? '',
    labels
  });

  logInfo(`Pushed ${issue.identifier ?? issue.title} to ${ownerRepo}#${created.number}`);
  return {
    githubRepo: ownerRepo,
    githubNumber: created.number,
    githubUrl: created.html_url,
    githubIssueId: created.id
  };
}

/** The fields a card stores about the GitHub issue it became. */
export const publishedFields = ({ githubRepo, githubNumber, githubUrl }: PublishedIssue): Partial<Issue> => ({
  githubRepo,
  githubNumber,
  githubUrl
});

/**
 * Publish a card that does not exist yet, so it can be born under GitHub's id.
 *
 * A card created here and then pushed kept the id it was created with, while
 * every other copy of the board -- the cloud's sync, a teammate's desktop --
 * met the same issue first on GitHub and named it after GitHub's id. Two ids
 * for one issue, and a run on either one unknown to the other. Publishing
 * first means there is only ever the one.
 *
 * Reports rather than throws, like `pushIssue`: a card whose publish failed is
 * still created, locally, and says why.
 */
export async function publishNewIssue(
  draft: Issue,
  workspaceId: string
): Promise<{ published: PublishedIssue | null; error?: string }> {
  try {
    return { published: await pushNewIssue(draft, workspaceId) };
  } catch (err: any) {
    const detail = String(err?.stderr || err?.message || err).trim();
    logError(`Could not publish ${draft.title} to GitHub:`, detail);
    return { published: null, error: detail };
  }
}

/**
 * Push a change to an issue that already exists on GitHub.
 *
 * Only the fields GitHub owns are sent. Labels are rebuilt rather than
 * replaced wholesale so a teammate's `bug` or `good first issue` survives
 * someone dragging a card — work they did on github.com must not be undone
 * from a kanban column.
 */
export async function pushIssueUpdate(issue: Issue): Promise<void> {
  if (!issue.githubRepo || !issue.githubNumber) return;

  await ensureLabels(issue.githubRepo);

  /**
   * Read the current labels before writing.
   *
   * The card's own `labels` holds only the foreign ones the last sync saw; a
   * label added on github.com since then would be dropped by writing from a
   * stale copy.
   */
  let current: string[] = [];
  try {
    const remote = await githubApi().get<{ labels: Array<{ name: string } | string> }>(
      `/repos/${issue.githubRepo}/issues/${issue.githubNumber}`
    );
    current = (remote.labels ?? []).map(l => (typeof l === 'string' ? l : l.name));
  } catch {
    // Fall back to what the card knows; a stale label set is better than
    // refusing to record the status change at all.
    current = issue.labels ?? [];
  }

  const labels = labelsForWrite(issue.status, issue.priority, current);
  const state = stateForStatus(issue.status);

  await githubApi().patch(`/repos/${issue.githubRepo}/issues/${issue.githubNumber}`, {
    title: issue.title,
    body: issue.description ?? '',
    state,
    labels
  });
  logInfo(`Pushed ${issue.identifier} → ${issue.githubRepo}#${issue.githubNumber} (${issue.status})`);
}

/**
 * Push whichever operation this card needs, and report rather than throw.
 *
 * The caller has already written to SQLite and answered the browser; a GitHub
 * failure here must not undo that, but it must be visible — a board showing a
 * state GitHub never accepted is the failure this whole path exists to avoid.
 */
export async function pushIssue(
  issue: Issue,
  workspaceId: string
): Promise<{ pushed: boolean; error?: string; patch?: Partial<Issue> }> {
  try {
    if (!issue.githubNumber) {
      const published = await pushNewIssue(issue, workspaceId);
      return published ? { pushed: true, patch: publishedFields(published) } : { pushed: false };
    }
    await pushIssueUpdate(issue);
    return { pushed: true };
  } catch (err: any) {
    const detail = String(err?.stderr || err?.message || err).trim();
    logError(`Could not push ${issue.identifier} to GitHub:`, detail);
    return { pushed: false, error: detail };
  }
}

/** Which fields, when changed, are worth a call to GitHub. */
export function needsPush(before: Issue, after: Issue): boolean {
  const fields: Array<keyof Issue> = ['title', 'description', 'status', 'priority'];
  return fields.some(f => before[f] !== after[f]);
}

/** Test seam: forget which repositories have been label-checked. */
export function resetLabelCache(): void {
  labelled.clear();
}

export type { IssueStatus, IssuePriority };
