import { githubApi, GitHubApiError, type GitHubApi } from './githubApi.js';
import { PIPELINE_BRANCHES } from './githubRepoProvisioning.js';

/**
 * A repository as Alpha works with it: its branches, files, differences,
 * pull requests and CI runs, read from GitHub as the signed-in person.
 *
 * Through the REST API rather than a checkout, so the web app and agents can
 * look at any branch of a project's repository without cloning it -- the same
 * way from the cloud as from a desktop.
 */

/** Promotions Alpha opens, in pipeline order: work moves dev -> uat -> main. */
const PROMOTIONS: Record<string, string> = { dev: 'uat', uat: 'main' };

/** The prefix every branch an agent creates must carry. */
export const AGENT_BRANCH_PREFIX = 'agent/';

/** A file larger than this is not returned inline. */
const MAX_FILE_BYTES = 1024 * 1024;

const REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export class RepoWorkspaceError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'RepoWorkspaceError';
  }
}

function assertRepo(repo: string): void {
  if (!REPO.test(repo)) throw new RepoWorkspaceError(`Repository must be "owner/name", got "${repo}".`, 400);
}

/** Git's own ref rules, narrowed to what Alpha ever needs to name. */
export function isSafeBranchName(name: string): boolean {
  return (
    /^[A-Za-z0-9._/-]{1,200}$/.test(name) &&
    !name.startsWith('/') &&
    !name.endsWith('/') &&
    !name.endsWith('.lock') &&
    !name.includes('..') &&
    !name.includes('//') &&
    !name.startsWith('-')
  );
}

function assertBranch(name: string, label = 'Branch'): void {
  if (!isSafeBranchName(name)) throw new RepoWorkspaceError(`${label} "${name}" is not a valid branch name.`, 400);
}

const ref = (name: string) => encodeURIComponent(name);

/** Lowercase letters, digits and dashes: what goes between the slashes of an agent branch. */
export function branchSlug(value: string, max = 40): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return slug || 'task';
}

/** `agent/<agent>/<task>`: who is working, and on what. */
export function agentBranchName(agent: string, task: string): string {
  return `${AGENT_BRANCH_PREFIX}${branchSlug(agent)}/${branchSlug(task, 60)}`;
}

export interface BranchSummary {
  name: string;
  sha: string;
  protected: boolean;
  /** dev, uat or main: moved only by pull request. */
  pipeline: boolean;
  agent: boolean;
}

export async function listBranches(repo: string, api: GitHubApi = githubApi()): Promise<BranchSummary[]> {
  assertRepo(repo);
  const branches = await api.getAll<{ name: string; commit: { sha: string }; protected?: boolean }>(
    `/repos/${repo}/branches?per_page=100`
  );
  return branches.map(branch => ({
    name: branch.name,
    sha: branch.commit.sha,
    protected: Boolean(branch.protected),
    pipeline: (PIPELINE_BRANCHES as readonly string[]).includes(branch.name),
    agent: branch.name.startsWith(AGENT_BRANCH_PREFIX)
  }));
}

export interface TreeEntry {
  path: string;
  type: 'file' | 'dir';
  size?: number;
}

export async function getTree(
  repo: string,
  branchOrSha: string,
  api: GitHubApi = githubApi()
): Promise<{ ref: string; entries: TreeEntry[]; truncated: boolean }> {
  assertRepo(repo);
  const tree = await api.get<{
    tree: Array<{ path: string; type: 'blob' | 'tree' | 'commit'; size?: number }>;
    truncated: boolean;
  }>(`/repos/${repo}/git/trees/${ref(branchOrSha)}?recursive=1`);
  return {
    ref: branchOrSha,
    truncated: tree.truncated,
    entries: tree.tree
      .filter(entry => entry.type !== 'commit') // submodules
      .map(entry => ({
        path: entry.path,
        type: entry.type === 'tree' ? 'dir' : 'file',
        ...(entry.size === undefined ? {} : { size: entry.size })
      }))
  };
}

export async function getFile(
  repo: string,
  path: string,
  branchOrSha: string | undefined,
  api: GitHubApi = githubApi()
): Promise<{ path: string; ref?: string; size: number; content: string | null; truncated: boolean }> {
  assertRepo(repo);
  if (!path || path.startsWith('/') || path.split('/').includes('..')) {
    throw new RepoWorkspaceError(`Invalid file path "${path}".`, 400);
  }
  const query = branchOrSha ? `?ref=${ref(branchOrSha)}` : '';
  const file = await api.get<{ type: string; size: number; content?: string; encoding?: string } | unknown[]>(
    `/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}${query}`
  );
  if (Array.isArray(file) || file.type !== 'file') {
    throw new RepoWorkspaceError(`"${path}" is a directory, not a file.`, 400);
  }
  if (file.size > MAX_FILE_BYTES || !file.content) {
    return { path, ...(branchOrSha ? { ref: branchOrSha } : {}), size: file.size, content: null, truncated: true };
  }
  const content = Buffer.from(file.content, (file.encoding as BufferEncoding) || 'base64').toString('utf8');
  return { path, ...(branchOrSha ? { ref: branchOrSha } : {}), size: file.size, content, truncated: false };
}

export interface BranchComparison {
  base: string;
  head: string;
  status: string;
  aheadBy: number;
  behindBy: number;
  commits: Array<{ sha: string; message: string; author?: string; date?: string }>;
  files: Array<{ path: string; status: string; additions: number; deletions: number; patch?: string }>;
}

export async function compareBranches(
  repo: string,
  base: string,
  head: string,
  options: { patches?: boolean } = {},
  api: GitHubApi = githubApi()
): Promise<BranchComparison> {
  assertRepo(repo);
  assertBranch(base, 'Base');
  assertBranch(head, 'Head');
  const diff = await api.get<{
    status: string;
    ahead_by: number;
    behind_by: number;
    commits: Array<{ sha: string; commit: { message: string; author?: { name?: string; date?: string } } }>;
    files?: Array<{ filename: string; status: string; additions: number; deletions: number; patch?: string }>;
  }>(`/repos/${repo}/compare/${ref(base)}...${ref(head)}`);
  return {
    base,
    head,
    status: diff.status,
    aheadBy: diff.ahead_by,
    behindBy: diff.behind_by,
    commits: diff.commits.map(commit => ({
      sha: commit.sha,
      message: commit.commit.message.split('\n')[0],
      ...(commit.commit.author?.name ? { author: commit.commit.author.name } : {}),
      ...(commit.commit.author?.date ? { date: commit.commit.author.date } : {})
    })),
    files: (diff.files ?? []).map(file => ({
      path: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      ...(options.patches && file.patch ? { patch: file.patch } : {})
    }))
  };
}

export interface PullRequestSummary {
  number: number;
  title: string;
  url: string;
  head: string;
  base: string;
  draft: boolean;
  author?: string;
  createdAt: string;
  /** A dev->uat or uat->main pull request. */
  promotion: boolean;
}

export async function listPullRequests(
  repo: string,
  state: 'open' | 'closed' | 'all' = 'open',
  api: GitHubApi = githubApi()
): Promise<PullRequestSummary[]> {
  assertRepo(repo);
  const pulls = await api.get<
    Array<{
      number: number;
      title: string;
      html_url: string;
      head: { ref: string };
      base: { ref: string };
      draft?: boolean;
      user?: { login: string } | null;
      created_at: string;
    }>
  >(`/repos/${repo}/pulls?state=${state}&per_page=50`);
  return pulls.map(pull => ({
    number: pull.number,
    title: pull.title,
    url: pull.html_url,
    head: pull.head.ref,
    base: pull.base.ref,
    draft: Boolean(pull.draft),
    ...(pull.user?.login ? { author: pull.user.login } : {}),
    createdAt: pull.created_at,
    promotion: PROMOTIONS[pull.head.ref] === pull.base.ref
  }));
}

export interface WorkflowRunSummary {
  id: number;
  name: string;
  branch: string;
  event: string;
  status: string;
  conclusion: string | null;
  url: string;
  createdAt: string;
}

export async function listWorkflowRuns(
  repo: string,
  branch: string | undefined,
  api: GitHubApi = githubApi()
): Promise<WorkflowRunSummary[]> {
  assertRepo(repo);
  if (branch) assertBranch(branch);
  const query = branch ? `&branch=${ref(branch)}` : '';
  const runs = await api.get<{
    workflow_runs: Array<{
      id: number;
      name: string;
      head_branch: string;
      event: string;
      status: string;
      conclusion: string | null;
      html_url: string;
      created_at: string;
    }>;
  }>(`/repos/${repo}/actions/runs?per_page=20${query}`);
  return runs.workflow_runs.map(run => ({
    id: run.id,
    name: run.name,
    branch: run.head_branch,
    event: run.event,
    status: run.status,
    conclusion: run.conclusion,
    url: run.html_url,
    createdAt: run.created_at
  }));
}

async function branchSha(api: GitHubApi, repo: string, branch: string): Promise<string> {
  const found = await api.get<{ object: { sha: string } }>(`/repos/${repo}/git/ref/heads/${ref(branch)}`);
  return found.object.sha;
}

/**
 * Create `agent/...` from another branch (dev by default).
 *
 * Only agent branches: dev, uat and main move by pull request, and an agent
 * that could create or reset them could bypass that entirely.
 */
export async function createAgentBranch(
  repo: string,
  name: string,
  from = 'dev',
  api: GitHubApi = githubApi()
): Promise<{ name: string; sha: string; from: string }> {
  assertRepo(repo);
  assertBranch(name);
  assertBranch(from, 'Source branch');
  if (!name.startsWith(AGENT_BRANCH_PREFIX)) {
    throw new RepoWorkspaceError(`Agents may only create "${AGENT_BRANCH_PREFIX}..." branches, not "${name}".`, 400);
  }
  const sha = await branchSha(api, repo, from);
  try {
    await api.post(`/repos/${repo}/git/refs`, { ref: `refs/heads/${name}`, sha });
  } catch (err) {
    if (err instanceof GitHubApiError && err.status === 422) {
      throw new RepoWorkspaceError(`Branch "${name}" already exists.`, 409);
    }
    throw err;
  }
  return { name, sha, from };
}

/** Remove an `agent/...` branch once its work is merged or abandoned. Never a pipeline branch. */
export async function deleteAgentBranch(repo: string, name: string, api: GitHubApi = githubApi()): Promise<void> {
  assertRepo(repo);
  assertBranch(name);
  if (!name.startsWith(AGENT_BRANCH_PREFIX)) {
    throw new RepoWorkspaceError(`Only "${AGENT_BRANCH_PREFIX}..." branches can be deleted here, not "${name}".`, 400);
  }
  await api.delete(`/repos/${repo}/git/refs/heads/${ref(name)}`);
}

export type PromotionResult =
  | { status: 'opened'; url: string; number: number; commits: number }
  | { status: 'existing'; url: string; number: number }
  | { status: 'nothing_to_promote' };

/**
 * Open the next promotion pull request: dev -> uat, or uat -> main.
 *
 * Alpha opens these itself, as the person promoting, instead of a workflow
 * holding a personal access token. An open promotion PR for the same pair is
 * returned rather than duplicated, and a source with nothing new opens none.
 */
export async function promote(
  repo: string,
  from: string,
  to: string,
  api: GitHubApi = githubApi()
): Promise<PromotionResult> {
  assertRepo(repo);
  if (PROMOTIONS[from] !== to) {
    throw new RepoWorkspaceError(`Promotion goes dev -> uat -> main; "${from} -> ${to}" is not a step.`, 400);
  }

  const [owner] = repo.split('/');
  const open = await api.get<Array<{ number: number; html_url: string }>>(
    `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${from}`)}&base=${ref(to)}`
  );
  if (open.length > 0) return { status: 'existing', url: open[0].html_url, number: open[0].number };

  const diff = await compareBranches(repo, to, from, {}, api);
  if (diff.aheadBy === 0) return { status: 'nothing_to_promote' };

  const listed = diff.commits.slice(-20).map(commit => `- ${commit.message} (${commit.sha.slice(0, 7)})`);
  const more = diff.commits.length > 20 ? [`- ...and ${diff.commits.length - 20} more`] : [];
  const pull = await api.post<{ number: number; html_url: string }>(`/repos/${repo}/pulls`, {
    title: `Promote ${from} → ${to}`,
    head: from,
    base: to,
    body: [
      `Promotes ${diff.aheadBy} commit(s) from \`${from}\` to \`${to}\`.`,
      '',
      ...listed,
      ...more,
      '',
      '_Opened by Alpha._'
    ].join('\n')
  });
  return { status: 'opened', url: pull.html_url, number: pull.number, commits: diff.aheadBy };
}
