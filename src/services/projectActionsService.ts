import { githubApi, GitHubApiError, tokenForThisRequest, type GitHubApi } from './githubApi.js';
import { isSafeBranchName, RepoWorkspaceError } from './githubRepoWorkspace.js';

export interface ActionsOptions {
  page?: string; perPage?: string; branch?: string; workflow?: string;
  status?: string; event?: string; from?: string; to?: string; attempt?: string;
}
interface RawRun {
  id: number; name: string | null; display_title?: string; workflow_id: number; path?: string;
  run_number: number; run_attempt?: number; head_branch: string | null; head_sha: string;
  event: string; status: string; conclusion: string | null; html_url: string;
  created_at: string; updated_at: string; run_started_at?: string; actor?: { login: string };
}
interface RawJob {
  id: number; run_id: number; run_attempt?: number; name: string; status: string; conclusion: string | null;
  started_at?: string; completed_at?: string;
  steps?: Array<{ number: number; name: string; status: string; conclusion: string | null; started_at?: string; completed_at?: string }>;
}
interface RawArtifact {
  id: number; name: string; size_in_bytes: number; expired: boolean; expires_at: string;
  workflow_run?: { id: number };
}

export function actionsId(value: string, label = 'ID'): number {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new RepoWorkspaceError(`${label} must be a positive integer.`, 400);
  }
  return Number(value);
}
function pageOptions(options: ActionsOptions) {
  const page = options.page ? actionsId(options.page, 'Page') : 1;
  const perPage = options.perPage ? actionsId(options.perPage, 'Page size') : 30;
  if (perPage > 100 || page > 10000) throw new RepoWorkspaceError('Page size must be at most 100; page at most 10000.', 400);
  return { page, perPage };
}
function pagination(total: number, size: number, page: number, perPage: number, filtered = false) {
  const accessible = filtered ? Math.min(total, 1000) : total;
  return { page, perPage, totalCount: total, nextPage: size && page * perPage < accessible ? page + 1 : null,
    limited: filtered && total >= 1000 };
}
function root(repo: string) {
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) throw new RepoWorkspaceError('Invalid repository.', 400);
  return `/repos/${repo}/actions`;
}
function runSummary(repo: string, r: RawRun) {
  return { id: r.id, repository: repo, name: r.name || 'Workflow', title: r.display_title || r.name || 'Workflow',
    workflowId: r.workflow_id, path: r.path, number: r.run_number, attempt: r.run_attempt || 1,
    branch: r.head_branch || '', sha: r.head_sha, actor: r.actor?.login || '', event: r.event,
    status: r.status, conclusion: r.conclusion, url: r.html_url, createdAt: r.created_at,
    updatedAt: r.updated_at, startedAt: r.run_started_at };
}
export async function actionsRuns(repo: string, options: ActionsOptions = {}, api: GitHubApi = githubApi()) {
  const { page, perPage } = pageOptions(options);
  const params = new URLSearchParams({ page: String(page), per_page: String(perPage) });
  if (options.branch) {
    if (!isSafeBranchName(options.branch)) throw new RepoWorkspaceError('Invalid branch filter.', 400);
    params.set('branch', options.branch);
  }
  if (options.status) {
    if (!['completed', 'action_required', 'cancelled', 'failure', 'neutral', 'skipped', 'stale', 'success', 'timed_out',
      'in_progress', 'queued', 'requested', 'waiting', 'pending'].includes(options.status)) {
      throw new RepoWorkspaceError('Invalid run status.', 400);
    }
    params.set('status', options.status);
  }
  if (options.event) {
    if (!/^[a-z_]{1,80}$/.test(options.event)) throw new RepoWorkspaceError('Invalid event filter.', 400);
    params.set('event', options.event);
  }
  for (const date of [options.from, options.to]) {
    if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)) {
      throw new RepoWorkspaceError('Date filters must be valid YYYY-MM-DD dates.', 400);
    }
  }
  if (options.from && options.to && options.from > options.to) throw new RepoWorkspaceError('Start date must precede end date.', 400);
  if (options.from || options.to) params.set('created', options.from && options.to ? `${options.from}..${options.to}` : options.from ? `>=${options.from}` : `<=${options.to}`);
  const base = root(repo);
  const route = options.workflow ? `${base}/workflows/${actionsId(options.workflow, 'Workflow')}/runs` : `${base}/runs`;
  const result = await api.get<{ total_count: number; workflow_runs: RawRun[] }>(`${route}?${params}`);
  return { runs: result.workflow_runs.map(r => runSummary(repo, r)),
    ...pagination(result.total_count, result.workflow_runs.length, page, perPage,
      Boolean(options.branch || options.status || options.event || options.from || options.to)) };
}
export async function actionsWorkflows(repo: string, options: ActionsOptions = {}, api: GitHubApi = githubApi()) {
  const { page, perPage } = pageOptions(options);
  const result = await api.get<{ total_count: number; workflows: Array<{ id: number; name: string; path: string; state: string }> }>(
    `${root(repo)}/workflows?page=${page}&per_page=${perPage}`);
  return { workflows: result.workflows, ...pagination(result.total_count, result.workflows.length, page, perPage) };
}
export async function actionsRun(repo: string, runId: string, api: GitHubApi = githubApi()) {
  const raw = await api.get<RawRun>(`${root(repo)}/runs/${actionsId(runId, 'Run')}`);
  return { run: runSummary(repo, raw) };
}
export async function actionsJobs(repo: string, runId: string, options: ActionsOptions = {}, api: GitHubApi = githubApi()) {
  const { run } = await actionsRun(repo, runId, api);
  const attempt = options.attempt ? actionsId(options.attempt, 'Attempt') : run.attempt;
  if (attempt > run.attempt) throw new RepoWorkspaceError('This attempt does not exist.', 404);
  const { page, perPage } = pageOptions(options);
  const data = await api.get<{ total_count: number; jobs: RawJob[] }>(
    `${root(repo)}/runs/${run.id}/attempts/${attempt}/jobs?page=${page}&per_page=${perPage}`);
  return { jobs: data.jobs.map(j => ({ id: j.id, runId: j.run_id, attempt, name: j.name, status: j.status,
    conclusion: j.conclusion, startedAt: j.started_at, completedAt: j.completed_at,
    steps: (j.steps || []).map(s => ({ number: s.number, name: s.name, status: s.status, conclusion: s.conclusion,
      startedAt: s.started_at, completedAt: s.completed_at })) })), attempt,
    ...pagination(data.total_count, data.jobs.length, page, perPage) };
}
export async function actionsArtifacts(repo: string, runId: string, options: ActionsOptions = {}, api: GitHubApi = githubApi()) {
  const id = actionsId(runId, 'Run');
  const { page, perPage } = pageOptions(options);
  const data = await api.get<{ total_count: number; artifacts: RawArtifact[] }>(
    `${root(repo)}/runs/${id}/artifacts?page=${page}&per_page=${perPage}`);
  return { artifacts: data.artifacts.map(a => ({ id: a.id, name: a.name, size: a.size_in_bytes, expired: a.expired, expiresAt: a.expires_at })),
    ...pagination(data.total_count, data.artifacts.length, page, perPage) };
}

/** Download redirects originate at GitHub, never at a renderer-supplied URL. */
export function trustedActionsDownload(url: URL): boolean {
  return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') &&
    (url.hostname === 'api.github.com' || url.hostname.endsWith('.actions.githubusercontent.com') || url.hostname.endsWith('.blob.core.windows.net'));
}
export async function actionsDownload(path: string, maxBytes: number, truncate: boolean,
  token?: Promise<string>, fetcher: typeof fetch = fetch): Promise<{ bytes: Buffer; truncated: boolean }> {
  if (!/^\/repos\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/actions\/(jobs\/\d+\/logs|artifacts\/\d+\/zip)$/.test(path)) {
    throw new RepoWorkspaceError('Invalid Actions download.', 400);
  }
  let url = new URL(`https://api.github.com${path}`);
  const credential = token ?? tokenForThisRequest();
  const signal = AbortSignal.timeout(60000);
  for (let hop = 0; hop < 4; hop++) {
    let response: Response;
    try {
      response = await fetcher(url, { redirect: 'manual', signal,
        headers: hop === 0 ? { Authorization: `Bearer ${await credential}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Alpha' } : {} });
    } catch (error) {
      if (error instanceof GitHubApiError) throw error;
      throw new RepoWorkspaceError('GitHub download could not be reached or timed out. Refresh and try again.', 502);
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new RepoWorkspaceError('GitHub did not supply a download location.', 502);
      url = new URL(location, url);
      if (!trustedActionsDownload(url)) throw new RepoWorkspaceError('GitHub supplied an unsupported download host.', 502);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new GitHubApiError('GitHub could not provide this download.', response.status, Number(response.headers.get('retry-after')) || undefined);
    }
    const reader = response.body?.getReader();
    if (!reader) return { bytes: Buffer.alloc(0), truncated: false };
    const chunks: Buffer[] = []; let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) return { bytes: Buffer.concat(chunks), truncated: false };
        const chunk = Buffer.from(next.value);
        if (size + chunk.length > maxBytes) {
          if (!truncate) throw new RepoWorkspaceError('This artifact exceeds the 50 MB in-app download limit.', 413);
          chunks.push(chunk.subarray(0, maxBytes - size));
          return { bytes: Buffer.concat(chunks), truncated: true };
        }
        chunks.push(chunk); size += chunk.length;
      }
    } finally { await reader.cancel().catch(() => undefined); }
  }
  throw new RepoWorkspaceError('GitHub download redirected too many times.', 502);
}
export function cleanActionsLog(text: string): string {
  return text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}
export async function actionsJobLogs(repo: string, runId: string, jobId: string, api: GitHubApi = githubApi()) {
  const id = actionsId(runId, 'Run'); const job = actionsId(jobId, 'Job');
  const data = await api.get<RawJob>(`${root(repo)}/jobs/${job}`);
  if (data.run_id !== id) throw new RepoWorkspaceError('This job does not belong to the selected run.', 404);
  if (data.status !== 'completed') return { state: 'not_ready', text: '', truncated: false };
  if (data.conclusion === 'skipped') return { state: 'unavailable', text: 'This job was skipped.', truncated: false };
  try {
    const result = await actionsDownload(`${root(repo)}/jobs/${job}/logs`, 2 * 1024 * 1024, true);
    return { state: 'available', text: cleanActionsLog(result.bytes.toString('utf8')), truncated: result.truncated };
  } catch (err) {
    if (err instanceof GitHubApiError && [404, 410].includes(err.status)) return { state: 'unavailable', text: 'Logs are not available; they may have expired or been deleted.', truncated: false };
    throw err;
  }
}
export async function actionsArtifactDownload(repo: string, runId: string, artifactId: string, api: GitHubApi = githubApi()) {
  const id = actionsId(runId, 'Run'); const artifact = actionsId(artifactId, 'Artifact');
  const data = await api.get<RawArtifact>(`${root(repo)}/artifacts/${artifact}`);
  if (data.workflow_run?.id !== id) throw new RepoWorkspaceError('This artifact does not belong to the selected run.', 404);
  if (data.expired) throw new RepoWorkspaceError('This artifact has expired.', 410);
  if (data.size_in_bytes > 50 * 1024 * 1024) throw new RepoWorkspaceError('This artifact exceeds the 50 MB in-app download limit.', 413);
  const result = await actionsDownload(`${root(repo)}/artifacts/${artifact}/zip`, 50 * 1024 * 1024, false);
  return { ...result, name: `${data.name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'artifact'}.zip` };
}
