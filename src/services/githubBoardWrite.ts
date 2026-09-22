import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { projectStore } from '../store/stores.js';
import { logInfo, logError } from './../utils/logger.js';
import { Issue, IssueStatus, IssuePriority } from '../models/index.js';
import { repoForProject } from './githubBoardSync.js';
import { labelsForWrite, stateForStatus, statusLabel, priorityLabel } from './githubIssueMapping.js';

const execFileAsync = promisify(execFile);

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
    const { stdout } = await execFileAsync(
      'gh',
      ['api', `repos/${ownerRepo}/labels?per_page=100`, '--paginate', '--jq', '.[].name'],
      { timeout: 30_000 }
    );
    existing = new Set(stdout.trim().split('\n').filter(Boolean).map(n => n.toLowerCase()));
  } catch (err: any) {
    // A repository we cannot read labels on is one we cannot write to either;
    // let the write itself produce the error the caller reports.
    logError(`Could not list labels on ${ownerRepo}:`, String(err?.message ?? err));
    return;
  }

  for (const label of MANAGED_LABELS) {
    if (existing.has(label.name.toLowerCase())) continue;
    try {
      await execFileAsync(
        'gh',
        ['api', `repos/${ownerRepo}/labels`, '-f', `name=${label.name}`,
         '-f', `color=${label.color}`, '-f', `description=${label.description}`],
        { timeout: 30_000 }
      );
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

async function ghJson<T>(args: string[]): Promise<T> {
  const { stdout } = await execFileAsync('gh', args, { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
  return JSON.parse(stdout) as T;
}

/**
 * Create the GitHub issue for a card that does not have one.
 *
 * Returns the fields to store back, so the card knows which issue it is. A
 * project with no repository is not an error — a local-only board is a valid
 * way to use Alpha, and it simply has nothing to push to.
 */
export async function pushNewIssue(issue: Issue, workspaceId: string): Promise<Partial<Issue> | null> {
  const ownerRepo = await repoForIssue(issue, workspaceId);
  if (!ownerRepo) return null;

  await ensureLabels(ownerRepo);

  const labels = labelsForWrite(issue.status, issue.priority, issue.labels ?? []);
  const created = await ghJson<{ number: number; html_url: string }>([
    'api', `repos/${ownerRepo}/issues`,
    '-f', `title=${issue.title}`,
    '-f', `body=${issue.description ?? ''}`,
    ...labels.flatMap(l => ['-f', `labels[]=${l}`])
  ]);

  logInfo(`Pushed ${issue.identifier} to ${ownerRepo}#${created.number}`);
  return {
    githubRepo: ownerRepo,
    githubNumber: created.number,
    githubUrl: created.html_url
  };
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
    const remote = await ghJson<{ labels: Array<{ name: string } | string> }>([
      'api', `repos/${issue.githubRepo}/issues/${issue.githubNumber}`
    ]);
    current = (remote.labels ?? []).map(l => (typeof l === 'string' ? l : l.name));
  } catch {
    // Fall back to what the card knows; a stale label set is better than
    // refusing to record the status change at all.
    current = issue.labels ?? [];
  }

  const labels = labelsForWrite(issue.status, issue.priority, current);
  const state = stateForStatus(issue.status);

  const args = [
    'api', '--method', 'PATCH', `repos/${issue.githubRepo}/issues/${issue.githubNumber}`,
    '-f', `title=${issue.title}`,
    '-f', `body=${issue.description ?? ''}`,
    '-f', `state=${state}`,
    ...labels.flatMap(l => ['-f', `labels[]=${l}`])
  ];

  await execFileAsync('gh', args, { timeout: 60_000 });
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
      const patch = await pushNewIssue(issue, workspaceId);
      return patch ? { pushed: true, patch } : { pushed: false };
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
