import { exec, execFile } from 'node:child_process';
import crossSpawn from 'cross-spawn';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { logInfo, logError } from '../utils/logger.js';
import {
  GITHUB_CLIENT_ID,
  GITHUB_CLIENT_SECRET,
  GITHUB_CALLBACK_URL,
  GITHUB_SCOPE,
  GITHUB_APP_ID,
  GITHUB_APP_PRIVATE_KEY,
  GITHUB_APP_WEBHOOK_SECRET,
  GITHUB_APP_SLUG
} from '../config/env.js';
import { currentGitHubIdentity, withGitHubIdentity } from './githubRequestContext.js';

/** How long an issued OAuth state stays valid. Long enough to sign in, short
 *  enough that a leaked URL is not reusable later. */
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Reject anything that is not a plain git branch name. Shared by every helper
 * that passes a branch to git or gh — argv already defuses shell syntax, but
 * git reads a leading `-` as an option and treats `..`, `~`, `^`, `:` as
 * revision operators, so the name still has to be constrained.
 */
function assertSafeBranchName(branchName: string, label = 'Branch name'): void {
  const valid =
    /^[A-Za-z0-9._/-]{1,200}$/.test(branchName) &&
    !branchName.startsWith('-') &&
    !branchName.startsWith('/') &&
    !branchName.endsWith('/') &&
    !branchName.endsWith('.') &&
    !branchName.endsWith('.lock') &&
    !branchName.includes('..') &&
    !branchName.includes('//');

  if (!valid) throw new Error(`${label} "${branchName}" is not a valid git branch name.`);
}

/** A PR reference must be a number or a github.com pull URL — nothing else. */
function assertSafePrRef(ref: string): void {
  if (!/^(\d+|https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/\d+)$/.test(ref)) {
    throw new Error(`"${ref}" is not a pull request number or github.com pull request URL.`);
  }
}

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export interface GitHubAuthInfo {
  authenticated: boolean;
  username?: string;
  protocol?: string;
  scopes?: string[];
  tokenSource?: 'keyring' | 'env' | 'oauth' | 'github_app';
  envVarName?: string;
  cliMissing?: boolean;
  mode?: 'cli' | 'rest' | 'github_app';
  appInstalled?: boolean;
  installations?: Array<{ id: number; account: string; type: string }>;
}

export interface GitHubRepo {
  name: string;
  nameWithOwner: string;
  url: string;
  isPrivate: boolean;
  defaultBranchRef?: { name: string };
  defaultBranch?: string;
}

export interface WorkflowRun {
  databaseId: number;
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion?: 'success' | 'failure' | 'cancelled' | 'timed_out' | 'action_required';
  headBranch: string;
  headSha: string;
  url: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * A remote repository is addressed as `owner/name`, nothing else.
 *
 * The value reaches here from an agent's tool call, and it is interpolated
 * into a REST path — so a value containing '..' or a query character would
 * address a different endpoint than the one intended.
 */
function assertOwnerRepo(ownerRepo: string): void {
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(ownerRepo) || ownerRepo.includes('..')) {
    throw new Error(
      `Invalid repository "${ownerRepo}". Use owner/name, e.g. octocat/hello-world.`
    );
  }
}

/**
 * Validate and encode a path inside a repository.
 *
 * The value is interpolated into a REST path, and both `fetch` and `gh`
 * resolve `..` segments before the request leaves — so `contents/../../../user`
 * addresses `/user`, not a file. That escapes the repository surface these
 * tools are supposed to be limited to, using the operator's own token, and the
 * caller is an LLM that may be acting on untrusted repository content.
 *
 * `?` and `#` are rejected for the same reason: either would let the caller
 * append query parameters or a fragment to an endpoint chosen elsewhere.
 * Segments are encoded individually so a legitimate space or `#` in a filename
 * still resolves, while the separators stay separators.
 */
function assertRepoFilePath(filePath: string): string {
  const invalid =
    !filePath ||
    filePath.startsWith('/') ||
    filePath.includes('..') ||
    filePath.includes('\\') ||
    filePath.includes('\0') ||
    /[?#]/.test(filePath);

  if (invalid) {
    throw new Error(
      `Invalid file path "${filePath}". Use a path inside the repository, e.g. src/index.ts.`
    );
  }

  return filePath.split('/').map(encodeURIComponent).join('/');
}

/**
 * GitHub answers 404 both for "does not exist" and for "exists but your token
 * cannot see it". Saying so is more useful than repeating the raw status,
 * because the two have different fixes.
 */
function describeRepoLookupFailure(ownerRepo: string, err: any): string {
  const detail = err?.stderr || err?.message || String(err);
  if (/404|Not Found/i.test(detail)) {
    return `Cannot reach ${ownerRepo}. It does not exist, or the signed-in account cannot see it — a private repo needs the owner to grant access.`;
  }
  if (/401|403|Bad credentials|rate limit/i.test(detail)) {
    return `GitHub refused the request for ${ownerRepo}: ${String(detail).trim().slice(0, 200)}`;
  }
  return `Failed to read ${ownerRepo}: ${String(detail).trim().slice(0, 200)}`;
}

export interface RemoteRepoInfo {
  nameWithOwner: string;
  url: string;
  description: string | null;
  defaultBranch: string;
  isPrivate: boolean;
  /** True when the repository has no commits — a fresh `test.git` looks like this. */
  isEmpty: boolean;
}

export interface CreateRepoOptions {
  name: string;
  visibility?: 'private' | 'public' | 'internal';
  description?: string;
  org?: string;
  sourceDir?: string;
  initReadme?: boolean;
}

export interface RepoInspection {
  isRepo: boolean;
  remote?: string;
  branch?: string;
  workflows: string[];
  hasReadme: boolean;
  ownerRepo?: string;
}

export interface IGitHubService {
  checkAuth(): Promise<GitHubAuthInfo>;
  startDeviceLogin(): Promise<{ code: string; verificationUrl: string }>;
  listOrganizations(): Promise<Array<{ login: string; role: string }>>;
  logout(): Promise<void>;
  listRepositories(limit?: number): Promise<GitHubRepo[]>;
  /**
   * Read-only lookups against a REMOTE repository, addressed as `owner/name`.
   *
   * These need no working copy, which is what makes them usable from a chat
   * turn: an agent can answer "can you reach this repo" without Alpha having
   * cloned anything first.
   */
  getRepository(ownerRepo: string): Promise<RemoteRepoInfo>;
  listBranches(ownerRepo: string, limit?: number): Promise<Array<{ name: string; protected: boolean }>>;
  getFileContents(ownerRepo: string, filePath: string, ref?: string): Promise<string>;
  createRepository(opts: CreateRepoOptions): Promise<{ url: string; nameWithOwner: string }>;
  cloneRepository(repo: string, intoDir: string): Promise<string>;
  forkRepository(repo: string, cloneInto?: string): Promise<string>;
  inspectLocalRepo(cwd: string): Promise<RepoInspection>;
  getWorkflowRuns(cwdOrRepo?: string, limit?: number): Promise<WorkflowRun[]>;
  getFailedWorkflowLogs(cwdOrRepo: string, runId: string | number): Promise<string>;
  commitAndPush(cwd: string, branchName: string, commitMessage: string): Promise<void>;
  createPullRequest(cwd: string, title: string, body: string, base?: string, headBranch?: string): Promise<string>;
  mergePullRequest(cwd: string, prUrlOrNumber: string, method?: 'squash' | 'merge' | 'rebase'): Promise<string>;
  getOAuthLoginUrl(state?: string): { url: string; state: string };
  handleOAuthCallback(code: string, state?: string): Promise<{ success: boolean; username: string; token: string }>;
  getGitHubAppInstallUrl(): string;
  handleGitHubAppWebhook(event: string, payload: any, signature?: string, rawBody?: Buffer): Promise<any>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. GhCliGitHubService: Local Desktop CLI Implementation
// ─────────────────────────────────────────────────────────────────────────────
export class GhCliGitHubService implements IGitHubService {
  private pendingLogin: ReturnType<typeof crossSpawn> | null = null;

  async checkAuth(): Promise<GitHubAuthInfo> {
    let raw: string;
    try {
      raw = (await execAsync('gh auth status')).stdout;
    } catch (err: any) {
      raw = `${err?.stdout ?? ''}\n${err?.stderr ?? ''}`.trim();
      const notFound =
        err?.code === 'ENOENT' ||
        /not recognized as an internal|command not found|No such file or directory/i.test(
          `${raw} ${err?.message ?? ''}`
        );
      if (notFound) return { authenticated: false, cliMissing: true, mode: 'cli' };

      if (!raw) {
        logError('GitHub auth check failed:', err?.message || err);
        return { authenticated: false, mode: 'cli' };
      }
    }

    const envVarName = /\b(GH_TOKEN|GITHUB_TOKEN)\b/.exec(raw)?.[1];
    const chunks = raw
      .split('\n')
      .reduce<string[][]>((acc, line) => {
        if (line.includes('Logged in to') || line.includes('Failed to log in')) acc.push([]);
        if (acc.length) acc[acc.length - 1].push(line);
        return acc;
      }, [])
      .map(lines => lines.join('\n'));

    const active = chunks.find(c => c.includes('Active account: true')) ?? chunks[0];

    if (!active || active.includes('Failed to log in')) {
      return { authenticated: false, envVarName, tokenSource: envVarName ? 'env' : undefined, mode: 'cli' };
    }

    const field = (label: string) =>
      active.split('\n').find(l => l.includes(label))?.split(label)[1]?.trim();

    const scopes = (field('Token scopes:') ?? '')
      .split(',')
      .map(s => s.trim().replace(/'/g, ''))
      .filter(Boolean);

    const usingEnv = /Logged in to github\.com account \S+ \((GH_TOKEN|GITHUB_TOKEN)\)/.test(active);

    return {
      authenticated: true,
      username: /Logged in to github\.com account ([a-zA-Z0-9_-]+)/.exec(active)?.[1],
      protocol: field('Git operations protocol:'),
      scopes,
      tokenSource: usingEnv ? 'env' : 'keyring',
      envVarName: usingEnv ? envVarName : undefined,
      mode: 'cli'
    };
  }

  async startDeviceLogin(): Promise<{ code: string; verificationUrl: string }> {
    if (this.pendingLogin) {
      this.pendingLogin.kill();
      this.pendingLogin = null;
    }

    return new Promise((resolve, reject) => {
      const child = crossSpawn(
        'gh',
        ['auth', 'login', '--web', '--hostname', 'github.com', '--git-protocol', 'https'],
        { stdio: ['pipe', 'pipe', 'pipe'] }
      );

      this.pendingLogin = child;
      child.on('exit', () => {
        if (this.pendingLogin === child) this.pendingLogin = null;
      });

      let buffer = '';
      let settled = false;

      const inspect = (chunk: unknown) => {
        buffer += String(chunk);
        const code = /([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(buffer);
        if (code && !settled) {
          settled = true;
          clearTimeout(timer);
          resolve({ code: code[1], verificationUrl: 'https://github.com/login/device' });
        }
      };

      child.stdout?.on('data', inspect);
      child.stderr?.on('data', inspect);

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(new Error('GitHub CLI did not return a device code. Is gh installed?'));
      }, 20000);

      child.on('error', (err: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(
          new Error(
            err.code === 'ENOENT'
              ? 'GitHub CLI is not installed. Install with `winget install GitHub.cli`.'
              : `Could not start GitHub CLI: ${err.message}`
          )
        );
      });
    });
  }

  async listOrganizations(): Promise<Array<{ login: string; role: string }>> {
    try {
      const { stdout } = await execFileAsync('gh', [
        'api',
        'user/memberships/orgs',
        '--paginate',
        '--jq',
        '.[] | select(.state == "active") | {login: .organization.login, role: .role}'
      ]);

      return stdout
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as { login: string; role: string })
        .sort((a, b) => a.login.localeCompare(b.login));
    } catch (err: any) {
      logError('Could not list GitHub organizations via CLI:', err?.stderr || err?.message || err);
      return [];
    }
  }

  async logout(): Promise<void> {
    await execFileAsync('gh', ['auth', 'logout', '--hostname', 'github.com']);
    logInfo('Signed out of GitHub via CLI');
  }

  async listRepositories(limit = 30): Promise<GitHubRepo[]> {
    try {
      const { stdout } = await execFileAsync('gh', [
        'repo', 'list',
        '--limit', String(Math.max(1, Math.min(200, Math.trunc(Number(limit) || 30)))),
        '--json', 'name,nameWithOwner,url,isPrivate,defaultBranchRef'
      ]);
      const parsed = JSON.parse(stdout);
      return parsed.map((r: any) => ({
        ...r,
        defaultBranch: r.defaultBranchRef?.name || 'main'
      }));
    } catch (err: any) {
      logError('Failed to list GitHub repos via CLI:', err?.message || err);
      return [];
    }
  }

  async createRepository(opts: CreateRepoOptions): Promise<{ url: string; nameWithOwner: string }> {
    const { name, visibility = 'private', description, org, sourceDir, initReadme = true } = opts;
    const target = org ? `${org}/${name}` : name;
    const args = ['repo', 'create', target, `--${visibility}`];

    if (description) args.push('--description', description);
    if (sourceDir) {
      args.push('--source', '.', '--remote', 'origin', '--push');
    } else if (initReadme) {
      args.push('--add-readme');
    }

    try {
      await execFileAsync('gh', args, sourceDir ? { cwd: sourceDir } : {});
      const { stdout: viewOut } = await execFileAsync('gh', ['repo', 'view', target, '--json', 'url,nameWithOwner']);
      const info = JSON.parse(viewOut);
      logInfo(`Created GitHub repository ${info.nameWithOwner} via CLI`);
      return info;
    } catch (err: any) {
      const detail = err?.stderr || err?.message || String(err);
      logError('CLI createRepository failed:', detail);
      throw new Error(`Failed to create repository: ${detail}`);
    }
  }

  async getRepository(ownerRepo: string): Promise<RemoteRepoInfo> {
    assertOwnerRepo(ownerRepo);
    try {
      const { stdout } = await execFileAsync('gh', [
        'api',
        `repos/${ownerRepo}`,
        '--jq',
        '{nameWithOwner: .full_name, url: .html_url, description: .description, defaultBranch: .default_branch, isPrivate: .private, size: .size}'
      ]);
      const r = JSON.parse(stdout);
      return {
        nameWithOwner: r.nameWithOwner,
        url: r.url,
        description: r.description ?? null,
        defaultBranch: r.defaultBranch,
        isPrivate: Boolean(r.isPrivate),
        // GitHub reports size 0 for a repository with no commits. `gh` gives no
        // clearer signal, and the distinction matters: "reachable but empty" is
        // a different answer than "cannot reach". `size` itself is not part of
        // the contract, so it is consumed here rather than passed through.
        isEmpty: r.size === 0
      };
    } catch (err: any) {
      throw new Error(describeRepoLookupFailure(ownerRepo, err));
    }
  }

  async listBranches(ownerRepo: string, limit = 50): Promise<Array<{ name: string; protected: boolean }>> {
    assertOwnerRepo(ownerRepo);
    const capped = Math.max(1, Math.min(100, Math.trunc(limit)));
    try {
      const { stdout } = await execFileAsync('gh', [
        'api',
        `repos/${ownerRepo}/branches?per_page=${capped}`,
        '--jq',
        '[.[] | {name: .name, protected: .protected}]'
      ]);
      return JSON.parse(stdout);
    } catch (err: any) {
      throw new Error(describeRepoLookupFailure(ownerRepo, err));
    }
  }

  async getFileContents(ownerRepo: string, filePath: string, ref?: string): Promise<string> {
    assertOwnerRepo(ownerRepo);
    const safePath = assertRepoFilePath(filePath);
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    try {
      // Raw media type returns the file body directly, so nothing has to be
      // base64-decoded here and a large file is not doubled in memory.
      const { stdout } = await execFileAsync('gh', [
        'api',
        `repos/${ownerRepo}/contents/${safePath}${query}`,
        '-H',
        'Accept: application/vnd.github.raw'
      ], { maxBuffer: 10 * 1024 * 1024 });
      return stdout;
    } catch (err: any) {
      const detail = err?.stderr || err?.message || String(err);
      if (/404/.test(detail)) {
        throw new Error(`Not found: ${filePath} in ${ownerRepo}${ref ? ` at ${ref}` : ''}`);
      }
      throw new Error(describeRepoLookupFailure(ownerRepo, err));
    }
  }

  async cloneRepository(repo: string, intoDir: string): Promise<string> {
    const folder = repo.split('/').pop()!;
    const target = path.join(intoDir, folder);
    if (fs.existsSync(target)) throw new Error(`Destination already exists: ${target}`);

    await execFileAsync('gh', ['repo', 'clone', repo, target]);
    logInfo(`Cloned ${repo} into ${target}`);
    return target;
  }

  async forkRepository(repo: string, cloneInto?: string): Promise<string> {
    await execFileAsync('gh', ['repo', 'fork', repo, '--clone=false']);
    if (cloneInto) {
      const who = await execFileAsync('gh', ['api', 'user', '--jq', '.login']);
      const login = String(who.stdout).trim();
      const forkName = repo.split('/').pop();
      return this.cloneRepository(`${login}/${forkName}`, cloneInto);
    }
    logInfo(`Forked ${repo}`);
    return repo;
  }

  async inspectLocalRepo(cwd: string): Promise<RepoInspection> {
    try {
      await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd });
    } catch {
      return { isRepo: false, workflows: [], hasReadme: false };
    }

    const safe = async (args: string[]): Promise<string | undefined> => {
      try {
        const { stdout } = await execFileAsync('git', args, { cwd });
        return stdout.trim();
      } catch {
        return undefined;
      }
    };

    const workflowDir = path.join(cwd, '.github', 'workflows');
    const workflows = fs.existsSync(workflowDir)
      ? fs.readdirSync(workflowDir).filter(f => /\.ya?ml$/.test(f))
      : [];

    const remote = await safe(['remote', 'get-url', 'origin']);
    let ownerRepo: string | undefined;
    if (remote) {
      const match = remote.match(/github\.com[:/]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(\.git)?$/);
      if (match) ownerRepo = match[1];
    }

    return {
      isRepo: true,
      remote,
      branch: await safe(['rev-parse', '--abbrev-ref', 'HEAD']),
      workflows,
      hasReadme: fs.existsSync(path.join(cwd, 'README.md')),
      ownerRepo
    };
  }

  async getWorkflowRuns(cwd = path.resolve('..'), limit = 15): Promise<WorkflowRun[]> {
    try {
      const { stdout } = await execAsync(
        `gh run list --limit ${limit} --json databaseId,name,status,conclusion,headBranch,headSha,url,createdAt,updatedAt`,
        { cwd }
      );
      return JSON.parse(stdout);
    } catch (err: any) {
      logError('Failed to list GitHub workflow runs via CLI:', err?.message || err);
      return [];
    }
  }

  async getFailedWorkflowLogs(cwd: string, runId: string | number): Promise<string> {
    try {
      // runId arrives as the :id route parameter, so it is caller-controlled.
      if (!/^\d+$/.test(String(runId))) throw new Error(`Invalid workflow run id "${runId}".`);
      const { stdout } = await execFileAsync('gh', ['run', 'view', String(runId), '--log-failed'], { cwd });
      return stdout;
    } catch (err: any) {
      return err?.stdout || 'Failed to pull workflow error logs';
    }
  }

  /**
   * Commit everything in `cwd` and push the branch.
   *
   * Quote-escaping a commit message into a shell string does not work: the
   * previous `msg.replace(/"/g,'\\"')` left backticks and $(...) intact, and an
   * agent-authored message reaches here unmodified. execFile removes the shell,
   * so none of it is interpretable.
   */
  async commitAndPush(cwd: string, branchName: string, commitMessage: string): Promise<void> {
    assertSafeBranchName(branchName);
    await execFileAsync('git', ['add', '-A'], { cwd });
    await execFileAsync('git', ['commit', '-m', commitMessage], { cwd });
    await execFileAsync('git', ['push', '-u', 'origin', branchName], { cwd });
  }

  async createPullRequest(
    cwd: string,
    title: string,
    body: string,
    base = 'main',
    headBranch?: string
  ): Promise<string> {
    assertSafeBranchName(base, 'Base branch');
    if (headBranch) assertSafeBranchName(headBranch, 'Head branch');

    // Title and body are model-authored free text; they are safe as argv but
    // would not be safe interpolated into a command string.
    const args = ['pr', 'create', '--title', title, '--body', body, '--base', base];
    if (headBranch) args.push('--head', headBranch);

    const { stdout } = await execFileAsync('gh', args, { cwd });
    return stdout.trim();
  }

  async mergePullRequest(
    cwd: string,
    prUrlOrNumber: string,
    method: 'squash' | 'merge' | 'rebase' = 'squash'
  ): Promise<string> {
    assertSafePrRef(prUrlOrNumber);
    const { stdout } = await execFileAsync(
      'gh',
      ['pr', 'merge', prUrlOrNumber, `--${method}`, '--delete-branch'],
      { cwd }
    );
    return stdout.trim();
  }

  getOAuthLoginUrl(): { url: string; state: string } {
    return { url: '', state: '' };
  }

  async handleOAuthCallback(): Promise<{ success: boolean; username: string; token: string }> {
    throw new Error('OAuth Web Flow is only used in hosted REST mode.');
  }

  getGitHubAppInstallUrl(): string {
    return `https://github.com/apps/${GITHUB_APP_SLUG}/installations/new`;
  }

  async handleGitHubAppWebhook(): Promise<any> {
    return { status: 'handled-by-cli' };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. RestGitHubService: Hosted Cloud & GitHub App Implementation
// ─────────────────────────────────────────────────────────────────────────────
export class RestGitHubService implements IGitHubService {
  /**
   * Single-tenant fallback only — a token supplied by the deployment itself, not
   * by a user. `readonly` on purpose: this class is a shared singleton, so any
   * per-user token written here would leak to every other request. Per-user
   * tokens travel on the request via `withGitHubIdentity()`.
   */
  private readonly envToken: string | null =
    process.env.GH_TOKEN || process.env.GITHUB_TOKEN || null;

  private appInstallationToken: string | null = null;
  private tokenExpiresAt: number = 0;

  /** Issued OAuth `state` values awaiting their callback. */
  private readonly pendingStates = new Map<string, number>();

  constructor() {
    if (this.envToken) {
      logInfo('RestGitHubService initialized with a deployment-level token');
    }
  }

  /**
   * Generate GitHub App JWT for server-to-server authenticated calls
   */
  private generateAppJwt(): string {
    if (!GITHUB_APP_ID || !GITHUB_APP_PRIVATE_KEY) {
      throw new Error('GITHUB_APP_ID or GITHUB_APP_PRIVATE_KEY is missing');
    }

    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        iat: now - 60,
        exp: now + 600,
        iss: GITHUB_APP_ID
      })
    ).toString('base64url');

    const unsignedToken = `${header}.${payload}`;
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(unsignedToken);
    const signature = sign.sign(GITHUB_APP_PRIVATE_KEY, 'base64url');

    return `${unsignedToken}.${signature}`;
  }

  /**
   * Get an authenticated Bearer token (User OAuth or GitHub App Installation Token)
   */
  private async getAuthToken(): Promise<string> {
    // The requesting user's own token always wins, and is visible only to the
    // async chain of their request — see githubRequestContext.ts.
    const perRequest = currentGitHubIdentity()?.token;
    if (perRequest) return perRequest;

    if (this.envToken) return this.envToken;

    if (this.appInstallationToken && Date.now() < this.tokenExpiresAt - 60000) {
      return this.appInstallationToken;
    }

    if (GITHUB_APP_ID && GITHUB_APP_PRIVATE_KEY) {
      try {
        const jwt = this.generateAppJwt();
        const instRes = await fetch('https://api.github.com/app/installations', {
          headers: {
            Authorization: `Bearer ${jwt}`,
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'Alpha-Agentic-Orchestrator'
          }
        });
        if (!instRes.ok) throw new Error(`Failed to list app installations: ${instRes.statusText}`);
        const installations = (await instRes.json()) as any[];
        if (installations.length === 0) throw new Error('No GitHub App installations found.');

        const installId = installations[0].id;
        const tokenRes = await fetch(`https://api.github.com/app/installations/${installId}/access_tokens`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${jwt}`,
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'Alpha-Agentic-Orchestrator'
          }
        });
        if (!tokenRes.ok) throw new Error(`Failed to mint installation token: ${tokenRes.statusText}`);
        const tokenData: any = await tokenRes.json();
        this.appInstallationToken = tokenData.token;
        this.tokenExpiresAt = new Date(tokenData.expires_at).getTime();
        return this.appInstallationToken as string;
      } catch (err: any) {
        logError('Failed to generate GitHub App token:', err?.message || err);
      }
    }

    throw new Error('No GitHub credentials available. Please sign in via GitHub OAuth or install the GitHub App.');
  }

  private async request(path: string, options: RequestInit = {}): Promise<any> {
    const token = await this.getAuthToken();
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent': 'Alpha-Agentic-Orchestrator',
      ...(options.headers || {})
    };

    const res = await fetch(`https://api.github.com${path}`, { ...options, headers });
    if (!res.ok) {
      const errorText = await res.text().catch(() => res.statusText);
      throw new Error(`GitHub REST Error [${res.status}]: ${errorText}`);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  async checkAuth(): Promise<GitHubAuthInfo> {
    try {
      // Either the requesting user's own token, or a deployment-level one.
      if (currentGitHubIdentity()?.token || this.envToken) {
        const user = await this.request('/user');
        return {
          authenticated: true,
          username: user.login,
          tokenSource: 'oauth',
          mode: 'rest'
        };
      }

      if (GITHUB_APP_ID && GITHUB_APP_PRIVATE_KEY) {
        const jwt = this.generateAppJwt();
        const instRes = await fetch('https://api.github.com/app/installations', {
          headers: {
            Authorization: `Bearer ${jwt}`,
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'Alpha-Agentic-Orchestrator'
          }
        });
        if (instRes.ok) {
          const insts = (await instRes.json()) as any[];
          return {
            authenticated: insts.length > 0,
            tokenSource: 'github_app',
            mode: 'github_app',
            appInstalled: insts.length > 0,
            installations: insts.map(i => ({ id: i.id, account: i.account?.login || 'org', type: i.target_type }))
          };
        }
      }
    } catch {
      // Not authenticated
    }

    return { authenticated: false, mode: 'rest' };
  }

  getOAuthLoginUrl(state = crypto.randomBytes(32).toString('hex')): { url: string; state: string } {
    if (!GITHUB_CLIENT_ID) {
      throw new Error('GITHUB_CLIENT_ID is not configured in backend environment.');
    }

    // Remember the state so the callback can prove this flow started here.
    // Without this the `state` parameter is decoration and the callback accepts
    // any code, which is how OAuth CSRF works: an attacker begins a flow and
    // gets their GitHub account bound to the victim's session.
    this.sweepExpiredStates();
    this.pendingStates.set(state, Date.now() + OAUTH_STATE_TTL_MS);

    const params = new URLSearchParams({
      client_id: GITHUB_CLIENT_ID,
      redirect_uri: GITHUB_CALLBACK_URL,
      scope: GITHUB_SCOPE,
      state
    });
    return {
      url: `https://github.com/login/oauth/authorize?${params.toString()}`,
      state
    };
  }

  private sweepExpiredStates(): void {
    const now = Date.now();
    for (const [value, expiry] of this.pendingStates) {
      if (expiry <= now) this.pendingStates.delete(value);
    }
  }

  /**
   * Validate and consume a `state`. Single use: replaying a callback must fail.
   *
   * In-memory is correct for one Render instance. Scaling to several requires
   * moving this to Postgres/Redis, because a callback can land on any instance —
   * noted rather than pre-built, since the failure is a confusing login error
   * rather than a security hole.
   */
  private consumeState(state: string | undefined): void {
    if (!state) throw new Error('OAuth callback is missing the state parameter.');
    this.sweepExpiredStates();
    if (!this.pendingStates.delete(state)) {
      throw new Error('OAuth state is unrecognized or expired. Start the sign-in again.');
    }
  }

  async handleOAuthCallback(
    code: string,
    state?: string
  ): Promise<{ success: boolean; username: string; token: string }> {
    if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
      throw new Error('GITHUB_CLIENT_ID or GITHUB_CLIENT_SECRET is missing');
    }

    this.consumeState(state);

    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: GITHUB_CALLBACK_URL
      })
    });

    const data: any = await res.json();
    if (data.error || !data.access_token) {
      throw new Error(`GitHub OAuth failed: ${data.error_description || data.error}`);
    }

    // Deliberately NOT stored on this instance — see the note on `envToken`.
    // The caller persists it against the signed-in session and replays it per
    // request through withGitHubIdentity().
    const user = await withGitHubIdentity({ token: data.access_token }, () =>
      this.request('/user')
    );

    return {
      success: true,
      username: user.login,
      token: data.access_token
    };
  }

  getGitHubAppInstallUrl(): string {
    return `https://github.com/apps/${GITHUB_APP_SLUG}/installations/new`;
  }

  /**
   * Verify and accept a GitHub App webhook.
   *
   * This endpoint is public — anything on the internet can POST to it — so the
   * signature IS the authentication. Three rules make that hold, and the
   * previous implementation broke all three:
   *
   *  1. Fail CLOSED. An unsigned delivery is rejected, never waved through.
   *     Skipping verification "when there is no signature" means an attacker
   *     simply omits the header.
   *  2. Sign the RAW BODY. GitHub HMACs the exact bytes it sent. Hashing
   *     `JSON.stringify(parsedBody)` cannot reproduce them, so genuine
   *     deliveries would have failed even once a secret was configured.
   *  3. Compare in constant time, so the comparison cannot be used as an oracle
   *     to recover the expected digest byte by byte.
   */
  async handleGitHubAppWebhook(
    event: string,
    payload: any,
    signature?: string,
    rawBody?: Buffer
  ): Promise<any> {
    if (!GITHUB_APP_WEBHOOK_SECRET) {
      throw new Error(
        'Refusing webhook: GITHUB_APP_WEBHOOK_SECRET is not configured, so deliveries cannot be verified.'
      );
    }
    if (!signature) {
      throw new Error('Refusing webhook: missing X-Hub-Signature-256 header.');
    }
    if (!rawBody) {
      throw new Error(
        'Refusing webhook: raw request body unavailable. The JSON parser must capture it to verify the signature.'
      );
    }

    const expected =
      'sha256=' +
      crypto.createHmac('sha256', GITHUB_APP_WEBHOOK_SECRET).update(rawBody).digest('hex');

    const provided = Buffer.from(signature);
    const computed = Buffer.from(expected);
    if (provided.length !== computed.length || !crypto.timingSafeEqual(provided, computed)) {
      logError(`Rejected GitHub webhook "${event}": signature mismatch`);
      throw new Error('Invalid GitHub webhook signature');
    }

    logInfo(`Received verified GitHub webhook event: ${event}`);
    return { event, received: true };
  }

  async listOrganizations(): Promise<Array<{ login: string; role: string }>> {
    try {
      const orgs: any[] = await this.request('/user/memberships/orgs');
      return orgs.map(o => ({ login: o.organization.login, role: o.role }));
    } catch {
      return [];
    }
  }

  async logout(): Promise<void> {
    // Nothing per-user is held here to clear — a user's token lives on their
    // session, so signing out is the caller discarding that session. Only the
    // shared App installation token is cached, and dropping it is harmless.
    this.appInstallationToken = null;
    this.tokenExpiresAt = 0;
  }

  async listRepositories(limit = 30): Promise<GitHubRepo[]> {
    try {
      const repos: any[] = await this.request(`/user/repos?per_page=${limit}&sort=updated`);
      return repos.map(r => ({
        name: r.name,
        nameWithOwner: r.full_name,
        url: r.html_url,
        isPrivate: r.private,
        defaultBranch: r.default_branch
      }));
    } catch (err: any) {
      logError('Failed to list GitHub repos via REST:', err?.message || err);
      return [];
    }
  }

  async createRepository(opts: CreateRepoOptions): Promise<{ url: string; nameWithOwner: string }> {
    const { name, visibility = 'private', description, org, initReadme = true } = opts;
    const endpoint = org ? `/orgs/${org}/repos` : '/user/repos';
    const body = {
      name,
      private: visibility === 'private',
      description,
      auto_init: initReadme
    };

    const repo = await this.request(endpoint, { method: 'POST', body: JSON.stringify(body) });
    return { url: repo.html_url, nameWithOwner: repo.full_name };
  }

  async getRepository(ownerRepo: string): Promise<RemoteRepoInfo> {
    assertOwnerRepo(ownerRepo);
    try {
      const r = await this.request(`/repos/${ownerRepo}`);
      return {
        nameWithOwner: r.full_name,
        url: r.html_url,
        description: r.description ?? null,
        defaultBranch: r.default_branch,
        isPrivate: Boolean(r.private),
        isEmpty: r.size === 0
      };
    } catch (err: any) {
      throw new Error(describeRepoLookupFailure(ownerRepo, err));
    }
  }

  async listBranches(ownerRepo: string, limit = 50): Promise<Array<{ name: string; protected: boolean }>> {
    assertOwnerRepo(ownerRepo);
    const capped = Math.max(1, Math.min(100, Math.trunc(limit)));
    try {
      const rows = await this.request(`/repos/${ownerRepo}/branches?per_page=${capped}`);
      return (rows ?? []).map((b: any) => ({ name: b.name, protected: Boolean(b.protected) }));
    } catch (err: any) {
      throw new Error(describeRepoLookupFailure(ownerRepo, err));
    }
  }

  async getFileContents(ownerRepo: string, filePath: string, ref?: string): Promise<string> {
    assertOwnerRepo(ownerRepo);
    const safePath = assertRepoFilePath(filePath);
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    try {
      // The raw media type returns the body as text rather than a base64 blob.
      const res = await this.request(`/repos/${ownerRepo}/contents/${safePath}${query}`, {
        headers: { Accept: 'application/vnd.github.raw' }
      });
      return typeof res === 'string' ? res : JSON.stringify(res);
    } catch (err: any) {
      const detail = err?.message ?? String(err);
      if (/404/.test(detail)) {
        throw new Error(`Not found: ${filePath} in ${ownerRepo}${ref ? ` at ${ref}` : ''}`);
      }
      throw new Error(describeRepoLookupFailure(ownerRepo, err));
    }
  }

  async cloneRepository(repo: string, intoDir: string): Promise<string> {
    const folder = repo.split('/').pop()!;
    const target = path.join(intoDir, folder);
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
      throw new Error(`Repository must be given as "owner/name", got "${repo}".`);
    }

    const token = await this.getAuthToken();

    // The token goes in a header via `-c`, not embedded in the clone URL.
    // A URL-embedded credential is written into .git/config in the checkout and
    // survives there; both forms are visible in the process list, but only the
    // URL form persists to disk for anything that later reads the remote.
    await execFileAsync(
      'git',
      [
        '-c',
        `http.https://github.com/.extraheader=Authorization: Basic ${Buffer.from(
          `x-access-token:${token}`
        ).toString('base64')}`,
        'clone',
        `https://github.com/${repo}.git`,
        target
      ],
      { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }
    );
    return target;
  }

  async forkRepository(repo: string, cloneInto?: string): Promise<string> {
    const forked = await this.request(`/repos/${repo}/forks`, { method: 'POST' });
    if (cloneInto) {
      return this.cloneRepository(forked.full_name, cloneInto);
    }
    return forked.full_name;
  }

  async inspectLocalRepo(cwd: string): Promise<RepoInspection> {
    const cli = new GhCliGitHubService();
    return cli.inspectLocalRepo(cwd);
  }

  async getWorkflowRuns(cwdOrRepo?: string, limit = 15): Promise<WorkflowRun[]> {
    try {
      let ownerRepo = cwdOrRepo && cwdOrRepo.includes('/') ? cwdOrRepo : null;
      if (!ownerRepo && cwdOrRepo) {
        const inspection = await this.inspectLocalRepo(cwdOrRepo);
        ownerRepo = inspection.ownerRepo || null;
      }
      if (!ownerRepo) {
        const repos = await this.listRepositories(1);
        if (repos.length > 0) ownerRepo = repos[0].nameWithOwner;
      }
      if (!ownerRepo) return [];

      const data = await this.request(`/repos/${ownerRepo}/actions/runs?per_page=${limit}`);
      return (data.workflow_runs || []).map((r: any) => ({
        databaseId: r.id,
        name: r.name,
        status: r.status,
        conclusion: r.conclusion,
        headBranch: r.head_branch,
        headSha: r.head_sha?.substring(0, 7),
        url: r.html_url,
        createdAt: r.created_at,
        updatedAt: r.updated_at
      }));
    } catch (err: any) {
      logError('Failed to get workflow runs via REST:', err?.message || err);
      return [];
    }
  }

  async getFailedWorkflowLogs(cwdOrRepo: string, runId: string | number): Promise<string> {
    try {
      let ownerRepo = cwdOrRepo.includes('/') ? cwdOrRepo : null;
      if (!ownerRepo) {
        const inspection = await this.inspectLocalRepo(cwdOrRepo);
        ownerRepo = inspection.ownerRepo || null;
      }
      if (!ownerRepo) return 'Owner/Repo not resolved for workflow log inspection.';

      const jobsData = await this.request(`/repos/${ownerRepo}/actions/runs/${runId}/jobs`);
      const failedJob = (jobsData.jobs || []).find((j: any) => j.conclusion === 'failure');
      if (failedJob) {
        const stepsSummary = (failedJob.steps || [])
          .filter((s: any) => s.conclusion === 'failure')
          .map((s: any) => `Step Failed: ${s.name} (Conclusion: ${s.conclusion})`)
          .join('\n');
        return `Job ${failedJob.name} failed.\n${stepsSummary}\nHTML URL: ${failedJob.html_url}`;
      }
      return 'No failed job steps found in workflow run.';
    } catch (err: any) {
      return `Failed to fetch logs: ${err?.message || err}`;
    }
  }

  async commitAndPush(cwd: string, branchName: string, commitMessage: string): Promise<void> {
    const cli = new GhCliGitHubService();
    await cli.commitAndPush(cwd, branchName, commitMessage);
  }

  async createPullRequest(cwd: string, title: string, body: string, base = 'main', headBranch?: string): Promise<string> {
    const inspection = await this.inspectLocalRepo(cwd);
    if (!inspection.ownerRepo) {
      const cli = new GhCliGitHubService();
      return cli.createPullRequest(cwd, title, body, base, headBranch);
    }

    const head = headBranch || inspection.branch || 'feat/patch';
    const pr = await this.request(`/repos/${inspection.ownerRepo}/pulls`, {
      method: 'POST',
      body: JSON.stringify({ title, body, head, base })
    });
    return pr.html_url;
  }

  async mergePullRequest(cwd: string, prUrlOrNumber: string, method: 'squash' | 'merge' | 'rebase' = 'squash'): Promise<string> {
    const inspection = await this.inspectLocalRepo(cwd);
    const prNumberMatch = prUrlOrNumber.match(/\/pull\/(\d+)/) || prUrlOrNumber.match(/^(\d+)$/);
    if (inspection.ownerRepo && prNumberMatch) {
      const prNumber = prNumberMatch[1];
      const res = await this.request(`/repos/${inspection.ownerRepo}/pulls/${prNumber}/merge`, {
        method: 'PUT',
        body: JSON.stringify({ merge_method: method })
      });
      return res.message || 'Pull request merged successfully';
    }

    const cli = new GhCliGitHubService();
    return cli.mergePullRequest(cwd, prUrlOrNumber, method);
  }

  startDeviceLogin(): Promise<{ code: string; verificationUrl: string }> {
    const cli = new GhCliGitHubService();
    return cli.startDeviceLogin();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Composite GitHubService (Auto-Detects Mode: Local CLI vs Hosted REST/App)
// ─────────────────────────────────────────────────────────────────────────────
export class GitHubService implements IGitHubService {
  private cliService = new GhCliGitHubService();
  private restService = new RestGitHubService();

  constructor() {
    // A desktop build has no business carrying server credentials, and a
    // private key inside a shipped .exe cannot be un-distributed — the same
    // argument as the Supabase service role key. Warn loudly rather than
    // silently operating with them present.
    if (GITHUB_APP_PRIVATE_KEY || GITHUB_CLIENT_SECRET) {
      logInfo(
        'GitHub server credentials detected (GITHUB_CLIENT_SECRET / GITHUB_APP_PRIVATE_KEY). ' +
          'These belong ONLY in the hosted Render environment. If this is a packaged desktop ' +
          'build, remove them — anyone with the machine can read them.'
      );
    }
  }

  async checkAuth(): Promise<GitHubAuthInfo> {
    const cliAuth = await this.cliService.checkAuth();
    if (cliAuth.authenticated) return cliAuth;

    const restAuth = await this.restService.checkAuth();
    if (restAuth.authenticated) return restAuth;

    return cliAuth;
  }

  async startDeviceLogin(): Promise<{ code: string; verificationUrl: string }> {
    return this.cliService.startDeviceLogin();
  }

  async listOrganizations(): Promise<Array<{ login: string; role: string }>> {
    const auth = await this.checkAuth();
    if (auth.mode === 'rest' || auth.mode === 'github_app') {
      return this.restService.listOrganizations();
    }
    return this.cliService.listOrganizations();
  }

  async logout(): Promise<void> {
    await this.cliService.logout();
    await this.restService.logout();
  }

  async listRepositories(limit = 30): Promise<GitHubRepo[]> {
    const auth = await this.checkAuth();
    if (auth.mode === 'rest' || auth.mode === 'github_app') {
      return this.restService.listRepositories(limit);
    }
    return this.cliService.listRepositories(limit);
  }

  async createRepository(opts: CreateRepoOptions): Promise<{ url: string; nameWithOwner: string }> {
    const auth = await this.checkAuth();
    if (auth.mode === 'rest' || auth.mode === 'github_app') {
      return this.restService.createRepository(opts);
    }
    return this.cliService.createRepository(opts);
  }

  async getRepository(ownerRepo: string): Promise<RemoteRepoInfo> {
    const auth = await this.checkAuth();
    if (auth.mode === 'rest' || auth.mode === 'github_app') {
      return this.restService.getRepository(ownerRepo);
    }
    return this.cliService.getRepository(ownerRepo);
  }

  async listBranches(ownerRepo: string, limit?: number): Promise<Array<{ name: string; protected: boolean }>> {
    const auth = await this.checkAuth();
    if (auth.mode === 'rest' || auth.mode === 'github_app') {
      return this.restService.listBranches(ownerRepo, limit);
    }
    return this.cliService.listBranches(ownerRepo, limit);
  }

  async getFileContents(ownerRepo: string, filePath: string, ref?: string): Promise<string> {
    const auth = await this.checkAuth();
    if (auth.mode === 'rest' || auth.mode === 'github_app') {
      return this.restService.getFileContents(ownerRepo, filePath, ref);
    }
    return this.cliService.getFileContents(ownerRepo, filePath, ref);
  }

  async cloneRepository(repo: string, intoDir: string): Promise<string> {
    const auth = await this.checkAuth();
    if (auth.mode === 'rest' || auth.mode === 'github_app') {
      return this.restService.cloneRepository(repo, intoDir);
    }
    return this.cliService.cloneRepository(repo, intoDir);
  }

  async forkRepository(repo: string, cloneInto?: string): Promise<string> {
    const auth = await this.checkAuth();
    if (auth.mode === 'rest' || auth.mode === 'github_app') {
      return this.restService.forkRepository(repo, cloneInto);
    }
    return this.cliService.forkRepository(repo, cloneInto);
  }

  async inspectLocalRepo(cwd: string): Promise<RepoInspection> {
    return this.cliService.inspectLocalRepo(cwd);
  }

  async getWorkflowRuns(cwdOrRepo = path.resolve('..'), limit = 15): Promise<WorkflowRun[]> {
    const auth = await this.checkAuth();
    if (auth.mode === 'rest' || auth.mode === 'github_app') {
      return this.restService.getWorkflowRuns(cwdOrRepo, limit);
    }
    return this.cliService.getWorkflowRuns(cwdOrRepo, limit);
  }

  async getFailedWorkflowLogs(cwdOrRepo: string, runId: string | number): Promise<string> {
    const auth = await this.checkAuth();
    if (auth.mode === 'rest' || auth.mode === 'github_app') {
      return this.restService.getFailedWorkflowLogs(cwdOrRepo, runId);
    }
    return this.cliService.getFailedWorkflowLogs(cwdOrRepo, runId);
  }

  async commitAndPush(cwd: string, branchName: string, commitMessage: string): Promise<void> {
    return this.cliService.commitAndPush(cwd, branchName, commitMessage);
  }

  async createPullRequest(cwd: string, title: string, body: string, base = 'main', headBranch?: string): Promise<string> {
    const auth = await this.checkAuth();
    if (auth.mode === 'rest' || auth.mode === 'github_app') {
      return this.restService.createPullRequest(cwd, title, body, base, headBranch);
    }
    return this.cliService.createPullRequest(cwd, title, body, base, headBranch);
  }

  async mergePullRequest(cwd: string, prUrlOrNumber: string, method: 'squash' | 'merge' | 'rebase' = 'squash'): Promise<string> {
    const auth = await this.checkAuth();
    if (auth.mode === 'rest' || auth.mode === 'github_app') {
      return this.restService.mergePullRequest(cwd, prUrlOrNumber, method);
    }
    return this.cliService.mergePullRequest(cwd, prUrlOrNumber, method);
  }

  getOAuthLoginUrl(state?: string): { url: string; state: string } {
    return this.restService.getOAuthLoginUrl(state);
  }

  async handleOAuthCallback(
    code: string,
    state?: string
  ): Promise<{ success: boolean; username: string; token: string }> {
    return this.restService.handleOAuthCallback(code, state);
  }

  getGitHubAppInstallUrl(): string {
    return this.restService.getGitHubAppInstallUrl();
  }

  async handleGitHubAppWebhook(
    event: string,
    payload: any,
    signature?: string,
    rawBody?: Buffer
  ): Promise<any> {
    return this.restService.handleGitHubAppWebhook(event, payload, signature, rawBody);
  }
}

export const githubService = new GitHubService();
