import type { GitHubApi } from './githubApi.js';

/**
 * What an agent may do about CI on its own: read why a run failed, retry a
 * failure once, open an issue for one it cannot fix, and keep that issue
 * current -- comment on it, and edit, close or reopen it.
 *
 * The limits here are the ethics of it, not tuning. A failing check is a
 * finding, so an agent reads the log and fixes the cause; a run retried until
 * it goes green hides exactly the failures CI exists to show. One retry covers
 * the honest case -- a runner or network hiccup -- and after that the run
 * stays red until the code changes.
 */

/** The first attempt plus one retry. */
export const MAX_RUN_ATTEMPTS = 2;

/** Enough of a failed job's log to show its error, without flooding a turn. */
const LOG_TAIL_CHARS = 12_000;
const MAX_FAILED_JOBS = 5;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const FAILED = new Set(['failure', 'timed_out']);

interface Run {
  id: number;
  name?: string;
  status: string;
  conclusion: string | null;
  run_attempt?: number;
  head_branch?: string;
  html_url: string;
}

interface Job {
  id: number;
  name: string;
  conclusion: string | null;
  html_url?: string;
  steps?: Array<{ name: string; conclusion: string | null }>;
}

export function assertRepo(repo: unknown): string {
  const value = typeof repo === 'string' ? repo.trim() : '';
  if (!REPO.test(value)) throw new Error('Pass the repository as owner/name.');
  return value;
}

export function assertRunId(runId: unknown): string {
  const value = String(runId ?? '').trim();
  if (!/^\d+$/.test(value)) throw new Error(`Invalid workflow run id "${String(runId)}".`);
  return value;
}

/** GitHub prefixes every log line with a timestamp; the error reads better without it. */
function tail(log: string): string {
  const text = log.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/gm, '').trimEnd();
  return text.length <= LOG_TAIL_CHARS ? text : `...(earlier lines omitted)\n${text.slice(-LOG_TAIL_CHARS)}`;
}

/**
 * The failed jobs of a run, each with its failed steps and the end of its log,
 * where the error is. GitHub has already masked secrets in these logs.
 */
export async function failedRunLogs(api: GitHubApi, repo: string, runId: string | number): Promise<string> {
  const ownerRepo = assertRepo(repo);
  const id = assertRunId(runId);
  const { jobs } = await api.get<{ jobs: Job[] }>(`/repos/${ownerRepo}/actions/runs/${id}/jobs?filter=latest&per_page=100`);
  const failed = jobs.filter(job => FAILED.has(job.conclusion ?? ''));
  if (!failed.length) return 'No failed jobs in this run.';

  const sections: string[] = [];
  for (const job of failed.slice(0, MAX_FAILED_JOBS)) {
    const steps = (job.steps ?? []).filter(step => FAILED.has(step.conclusion ?? '')).map(step => step.name);
    let log: string;
    try {
      log = api.getText ? tail(await api.getText(`/repos/${ownerRepo}/actions/jobs/${job.id}/logs`)) : '(log text is not available here)';
    } catch (err) {
      log = `(could not read the log: ${err instanceof Error ? err.message : String(err)})`;
    }
    sections.push(
      [`Job "${job.name}" ${job.conclusion}.`, steps.length ? `Failed steps: ${steps.join(', ')}` : '', job.html_url ?? '', '', log]
        .filter((line, index) => line !== '' || index === 3)
        .join('\n')
    );
  }
  if (failed.length > MAX_FAILED_JOBS) sections.push(`${failed.length - MAX_FAILED_JOBS} more failed job(s) not shown.`);
  return sections.join('\n\n');
}

/** Retry a finished, failed run's failed jobs, once. */
export async function rerunFailedJobs(api: GitHubApi, repo: string, runId: string | number) {
  const ownerRepo = assertRepo(repo);
  const id = assertRunId(runId);
  const run = await api.get<Run>(`/repos/${ownerRepo}/actions/runs/${id}`);
  if (run.status !== 'completed') throw new Error('This run is still in progress. Wait for it to finish before retrying.');
  if (run.conclusion === 'success') throw new Error('Nothing failed in this run, so there is nothing to retry.');
  const attempt = run.run_attempt ?? 1;
  if (attempt >= MAX_RUN_ATTEMPTS) {
    throw new Error(
      `This run has already been retried (attempt ${attempt}). Read its failed logs and fix the cause; ` +
        'retrying again until it passes would hide a real failure.'
    );
  }
  await api.post(`/repos/${ownerRepo}/actions/runs/${id}/rerun-failed-jobs`, {});
  return { runId: Number(id), attempt: attempt + 1, url: run.html_url, branch: run.head_branch ?? null };
}

export interface IssueInput {
  title: unknown;
  body?: unknown;
  labels?: unknown;
}

/** Open an issue, saying in its body that an agent opened it and for which run. */
export async function createIssue(api: GitHubApi, repo: string, input: IssueInput, attribution: string) {
  const ownerRepo = assertRepo(repo);
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title || title.length > 256) throw new Error('An issue needs a title of 1 to 256 characters.');
  const body = typeof input.body === 'string' ? input.body.trim() : '';
  if (body.length > 60_000) throw new Error('The issue body is too long.');
  const labels = input.labels === undefined ? [] : input.labels;
  if (!Array.isArray(labels) || labels.length > 10 || labels.some(label => typeof label !== 'string' || !label.trim())) {
    throw new Error('Labels must be up to 10 non-empty strings.');
  }
  const issue = await api.post<{ number: number; html_url: string }>(`/repos/${ownerRepo}/issues`, {
    title,
    body: [body, '---', `_${attribution}_`].filter(Boolean).join('\n\n'),
    ...(labels.length ? { labels: labels.map(label => (label as string).trim()) } : {})
  });
  return { number: issue.number, url: issue.html_url };
}

/**
 * The line `createIssue` ends an agent's issue with. Agents act through the
 * developer's own GitHub account, so the author cannot tell an agent's issue
 * from the developer's; this line can.
 */
const AGENT_OPENED = /^_Opened by an Alpha agent[^\n]*\._[ \t]*$/m;

interface GitHubIssue {
  number: number;
  title: string;
  body?: string | null;
  state: 'open' | 'closed';
  locked?: boolean;
  html_url: string;
  pull_request?: unknown;
}

export function assertIssueNumber(value: unknown): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`Invalid issue number "${String(value)}".`);
  return number;
}

/** An issue, refusing pull requests: an agent reviews those with github_review_pull_request. */
async function readIssue(api: GitHubApi, ownerRepo: string, number: number): Promise<GitHubIssue> {
  const issue = await api.get<GitHubIssue>(`/repos/${ownerRepo}/issues/${number}`);
  if (issue.pull_request) throw new Error(`#${number} is a pull request, not an issue. Use github_review_pull_request to comment on it.`);
  return issue;
}

function commentBody(text: unknown, attribution: string): string {
  const body = typeof text === 'string' ? text.trim() : '';
  if (!body) throw new Error('A comment needs text.');
  if (body.length > 60_000) throw new Error('The comment is too long.');
  return [body, '---', `_${attribution}_`].join('\n\n');
}

/**
 * Comment on an issue in one of the project's repositories: progress, new
 * evidence, the pull request that fixes it. Any issue there, since a comment
 * adds to the record without changing what a person wrote.
 */
export async function commentOnIssue(api: GitHubApi, repo: string, issueNumber: unknown, text: unknown, attribution: string) {
  const ownerRepo = assertRepo(repo);
  const number = assertIssueNumber(issueNumber);
  const body = commentBody(text, attribution);
  const issue = await readIssue(api, ownerRepo, number);
  if (issue.locked) throw new Error(`#${number} is locked, so it takes no comments.`);
  const comment = await api.post<{ id: number; html_url: string }>(`/repos/${ownerRepo}/issues/${number}/comments`, { body });
  return { issue: number, url: comment.html_url };
}

export interface IssueUpdateInput {
  title?: unknown;
  body?: unknown;
  labels?: unknown;
  state?: unknown;
  /** Required to close: says why, as a comment, before the issue closes. */
  comment?: unknown;
  /** When closing: 'completed' (default) or 'not_planned'. */
  reason?: unknown;
}

/**
 * Edit, close or reopen an issue an Alpha agent opened. A person's issue is
 * refused: an agent comments on it instead, and the person decides. The
 * agent's attribution stays at the end of a rewritten body, so the issue
 * still says an agent opened it and stays editable by one.
 */
export async function updateIssue(api: GitHubApi, repo: string, issueNumber: unknown, input: IssueUpdateInput, attribution: string) {
  const ownerRepo = assertRepo(repo);
  const number = assertIssueNumber(issueNumber);

  const patch: Record<string, unknown> = {};
  if (input.title !== undefined) {
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    if (!title || title.length > 256) throw new Error('An issue needs a title of 1 to 256 characters.');
    patch.title = title;
  }
  if (input.labels !== undefined) {
    const labels = input.labels;
    if (!Array.isArray(labels) || labels.length > 10 || labels.some(label => typeof label !== 'string' || !label.trim())) {
      throw new Error('Labels must be up to 10 non-empty strings.');
    }
    patch.labels = labels.map(label => (label as string).trim());
  }
  if (input.state !== undefined && input.state !== 'open' && input.state !== 'closed') throw new Error('state must be open or closed.');
  if (input.reason !== undefined && input.reason !== 'completed' && input.reason !== 'not_planned') {
    throw new Error('reason must be completed or not_planned.');
  }
  const closing = input.state === 'closed';
  if (closing && (typeof input.comment !== 'string' || !input.comment.trim())) {
    throw new Error('Closing an issue needs a comment saying why, for example the pull request that fixed it.');
  }
  const newBody = input.body === undefined ? undefined : typeof input.body === 'string' ? input.body.trim() : '';
  if (newBody !== undefined && newBody.length > 60_000) throw new Error('The issue body is too long.');
  if (!Object.keys(patch).length && newBody === undefined && input.state === undefined) {
    throw new Error('Say what to change: title, body, labels or state.');
  }

  const issue = await readIssue(api, ownerRepo, number);
  const opened = (issue.body ?? '').match(AGENT_OPENED)?.[0];
  if (!opened) {
    throw new Error(`#${number} was not opened by an Alpha agent, so an agent does not edit, close or reopen it. Comment on it with github_comment_issue instead.`);
  }
  if (newBody !== undefined) patch.body = [newBody, '---', opened.trim()].filter(Boolean).join('\n\n');
  if (input.state !== undefined && input.state !== issue.state) {
    patch.state = input.state;
    if (closing) patch.state_reason = input.reason ?? 'completed';
  }

  // The why goes on the record first, so a closed issue never lacks it. A
  // comment with any other change is posted too; closing an issue that is
  // already closed changes nothing and says nothing.
  const alreadyClosed = closing && issue.state === 'closed';
  if (typeof input.comment === 'string' && input.comment.trim() && !alreadyClosed) {
    await api.post(`/repos/${ownerRepo}/issues/${number}/comments`, { body: commentBody(input.comment, attribution) });
  }
  if (!Object.keys(patch).length) return { number, url: issue.html_url, state: issue.state, changed: [] as string[] };
  const updated = await api.patch<GitHubIssue>(`/repos/${ownerRepo}/issues/${number}`, patch);
  return { number, url: updated.html_url, state: updated.state, changed: Object.keys(patch).filter(key => key !== 'state_reason') };
}
