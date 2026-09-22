import { IssueStatus, IssuePriority, Project } from '../models/index.js';

/**
 * Translating between an Alpha issue and a GitHub issue.
 *
 * Alpha's board lives in one person's `~/.alpha/alpha.db`, so a second
 * collaborator installing Alpha gets an empty board and no mechanism by which
 * they could ever see the first one's. GitHub already holds shared issues with
 * authentication, membership and per-repository permissions for the six people
 * in this organisation — so the board moves there and Alpha renders it.
 *
 * ## Six states onto two
 *
 * A GitHub issue is open or closed. Alpha's board has six columns, and the
 * difference between Todo and In Review is the entire point of a board. The
 * extra state rides on a label, which is plain REST, visible on github.com, and
 * editable by a teammate who never opens Alpha.
 *
 * Closed always means done regardless of any label, because closing is the
 * gesture people actually make and a board that argued with it would be wrong
 * in the way that matters.
 *
 * ## What does not come back
 *
 * Runs, squads, stage logs and agent assignments have no GitHub equivalent and
 * stay in SQLite, keyed by repository and issue number. Local-first execution
 * is untouched; only the board is shared.
 */

/** `alpha:` prefixed so a human scanning labels can see which are Alpha's. */
export const STATUS_LABEL_PREFIX = 'alpha:';

const STATUS_LABELS: Record<IssueStatus, string> = {
  backlog: 'alpha:backlog',
  todo: 'alpha:todo',
  in_progress: 'alpha:in-progress',
  agent_running: 'alpha:agent-running',
  review: 'alpha:review',
  done: 'alpha:done'
};

const LABEL_STATUS = new Map<string, IssueStatus>(
  Object.entries(STATUS_LABELS).map(([status, label]) => [label, status as IssueStatus])
);

/** Priority rides on a label too, so it survives a round trip through GitHub. */
const PRIORITY_LABELS: Record<IssuePriority, string> = {
  urgent: 'alpha:p-urgent',
  high: 'alpha:p-high',
  medium: 'alpha:p-medium',
  low: 'alpha:p-low',
  none: 'alpha:p-none'
};

const LABEL_PRIORITY = new Map<string, IssuePriority>(
  Object.entries(PRIORITY_LABELS).map(([p, label]) => [label, p as IssuePriority])
);

export const statusLabel = (status: IssueStatus): string => STATUS_LABELS[status];
export const priorityLabel = (priority: IssuePriority): string => PRIORITY_LABELS[priority];

/** Every label Alpha owns, so a sync can replace its own without touching others. */
export function isAlphaLabel(name: string): boolean {
  return name.toLowerCase().startsWith(STATUS_LABEL_PREFIX);
}

export interface RepoRef {
  owner: string;
  repo: string;
}

/**
 * `owner/repo` out of whatever form the project recorded.
 *
 * Projects store a resource URL — `https://github.com/org/name` — sometimes
 * with `.git`, sometimes as an SSH remote, sometimes already in short form.
 * Returns null rather than guessing at anything that is not a GitHub
 * repository, because a run against the wrong repository is worse than one
 * that does not start.
 */
export function parseRepoRef(input: string | undefined | null): RepoRef | null {
  if (!input) return null;
  const value = input.trim().replace(/\.git$/i, '').replace(/\/+$/, '');

  const patterns = [
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)$/i,
    /^git@github\.com:([^/]+)\/([^/]+)$/i,
    /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+)$/i,
    /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(value);
    if (match) return { owner: match[1], repo: match[2] };
  }
  return null;
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

/** A GitHub issue, in the shape the REST API returns. */
export interface GitHubIssue {
  /** GitHub's own id for the issue: global, and stable for the issue's life. */
  id?: number;
  number: number;
  title: string;
  body?: string | null;
  state: 'open' | 'closed';
  labels?: Array<{ name: string } | string>;
  user?: { login: string } | null;
  assignees?: Array<{ login: string }> | null;
  html_url?: string;
  created_at: string;
  updated_at: string;
  /** Present only on pull requests, which the issues endpoint also returns. */
  pull_request?: unknown;
}

const labelNames = (issue: GitHubIssue): string[] =>
  (issue.labels ?? []).map(l => (typeof l === 'string' ? l : l.name)).filter(Boolean);

/**
 * A pull request is not an issue.
 *
 * GitHub's issues endpoint returns both, distinguished only by the presence of
 * a `pull_request` key. Every PR the agents have opened would otherwise appear
 * on the board as a card.
 */
export const isPullRequest = (issue: GitHubIssue): boolean => issue.pull_request != null;

/** Which column this issue belongs in. */
export function statusFromIssue(issue: GitHubIssue): IssueStatus {
  // Closing is the gesture people make; no label overrides it.
  if (issue.state === 'closed') return 'done';

  for (const name of labelNames(issue)) {
    const status = LABEL_STATUS.get(name.toLowerCase());
    // An issue closed and reopened can still carry alpha:done, which would
    // put an open issue in the Done column and hide it from everyone.
    if (status && status !== 'done') return status;
  }

  // No label means nobody has triaged it — including an issue filed on
  // github.com by someone who has never opened Alpha, which is the normal way
  // a teammate contributes.
  return 'todo';
}

export function priorityFromIssue(issue: GitHubIssue): IssuePriority {
  for (const name of labelNames(issue)) {
    const priority = LABEL_PRIORITY.get(name.toLowerCase());
    if (priority) return priority;
  }
  return 'medium';
}

/** Labels that are not Alpha's, preserved through a round trip. */
export const foreignLabels = (issue: GitHubIssue): string[] =>
  labelNames(issue).filter(name => !isAlphaLabel(name));

export interface MappedIssue {
  githubNumber: number;
  githubRepo: string;
  githubUrl?: string;
  title: string;
  description: string;
  status: IssueStatus;
  priority: IssuePriority;
  createdBy?: string;
  assignedHuman?: string;
  labels: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * A GitHub issue as Alpha's board needs it.
 *
 * Deliberately not an `Issue`: the identifier, the project and the Alpha id are
 * decided by the caller, which knows which project this repository belongs to.
 * Keeping those out means this stays a pure translation and can be tested
 * without a database.
 */
export function mapIssue(issue: GitHubIssue, ownerRepo: string): MappedIssue {
  return {
    githubNumber: issue.number,
    githubRepo: ownerRepo,
    githubUrl: issue.html_url,
    title: issue.title,
    description: issue.body ?? '',
    status: statusFromIssue(issue),
    priority: priorityFromIssue(issue),
    createdBy: issue.user?.login,
    // One assignee: Alpha's board has a single human slot, and picking the
    // first is more useful than dropping all of them.
    assignedHuman: issue.assignees?.[0]?.login,
    labels: foreignLabels(issue),
    createdAt: issue.created_at,
    updatedAt: issue.updated_at
  };
}

/**
 * The labels an issue should carry after Alpha writes to it.
 *
 * Alpha's own labels are replaced and everyone else's are kept — a teammate's
 * `bug` or `good first issue` must survive a status change made from the board.
 */
export function labelsForWrite(
  status: IssueStatus,
  priority: IssuePriority,
  existing: string[]
): string[] {
  const kept = existing.filter(name => !isAlphaLabel(name));
  // `done` is expressed by closing the issue, so it needs no label of its own —
  // and adding one would leave it behind if the issue were reopened.
  const status_ = status === 'done' ? [] : [statusLabel(status)];
  return [...kept, ...status_, priorityLabel(priority)];
}

/** Whether Alpha should close or reopen the issue to match this status. */
export const stateForStatus = (status: IssueStatus): 'open' | 'closed' =>
  status === 'done' ? 'closed' : 'open';
