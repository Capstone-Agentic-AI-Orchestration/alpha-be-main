import { githubRepoDescription } from './githubRepoDescription.js';
import { exec, execFile } from 'node:child_process';
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
  GITHUB_APP_SLUG,
  IS_PACKAGED_DESKTOP,
  ALPHA_CLOUD_API,
  IS_DESKTOP
} from '../config/env.js';
import { currentGitHubIdentity, withGitHubIdentity } from './githubRequestContext.js';
import { githubApi, githubApiWithToken, tokenForThisRequest } from './githubApi.js';
import { withIsolatedRepository, type IsolatedGit } from './isolatedGit.js';
import { failedRunLogs } from './agentCiActions.js';
import {
  DeviceFlowError,
  activeProfile,
  awaitAuthorization,
  beginSessionAuthentication,
  clearCredential,
  getSessionAuthenticationError,
  isSessionAuthenticated,
  requiresSessionAuthentication,
  setSessionAuthenticationError,
  userFor,
  requestDeviceCode,
  requestHostedOAuth,
  awaitHostedOAuth,
  ghEnvironment,
  sessionReady,
  storedCredential,
  tokensFromGitHub,
  touchActiveProfile,
  type HostedOAuthTokens
} from './alphaGitHubToken.js';

type ExecOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  windowsHide?: boolean;
  maxBuffer?: number;
};

const execGh = (args: string[], options: ExecOptions = {}) => {
  // Do not let a packaged build fall through to a developer's machine-level
  // `gh` credential while the profile picker is waiting for a fresh sign-in.
  // The version probe is safe and remains available for the status copy.
  if (requiresSessionAuthentication() && !isSessionAuthenticated() && !args.includes('--version')) {
    return Promise.reject(new Error('Alpha is not signed in to GitHub.'));
  }
  return execFileAsync('gh', args, { ...options, env: ghEnvironment(options.env) });
};

/**
 * Whether the CLI is here at all, asked once.
 *
 * The auth status is polled every couple of seconds while someone is signing
 * in, and spawning a process each time to learn something that cannot change
 * within a session is waste. A CLI installed while Alpha is running is picked
 * up on the next start, which is soon enough.
 */
let ghInstalledAnswer: Promise<boolean> | null = null;

function ghInstalled(): Promise<boolean> {
  ghInstalledAnswer ??= execGh(['--version'], { timeout: 10_000, windowsHide: true })
    .then(() => true)
    .catch(() => false);
  return ghInstalledAnswer;
}

/** How long an issued OAuth state stays valid. Long enough to sign in, short
 *  enough that a leaked URL is not reusable later. */
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function safeEqualSecret(expected: string, actual: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

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

/** Workflow files are repository-relative identifiers, never arbitrary URLs. */
function assertSafeWorkflowName(workflow: string): void {
  const valid =
    /^[A-Za-z0-9._/-]{1,200}$/.test(workflow) &&
    !workflow.startsWith('/') &&
    !workflow.includes('..') &&
    !workflow.includes('//');
  if (!valid) throw new Error(`Workflow "${workflow}" is not a valid workflow file name.`);
}

function workflowInputArgs(inputs?: Record<string, string>): string[] {
  if (!inputs) return [];
  return Object.entries(inputs).flatMap(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(key)) {
      throw new Error(`Workflow input "${key}" is not a valid input name.`);
    }
    if (typeof value !== 'string' || value.length > 1000) {
      throw new Error(`Workflow input "${key}" must be a string of 1000 characters or fewer.`);
    }
    return ['-f', `${key}=${value}`];
  });
}

function encodeWorkflowPath(workflow: string): string {
  return workflow.split('/').map(encodeURIComponent).join('/');
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
  profileId?: string;
  username?: string;
  name?: string;
  avatarUrl?: string;
  protocol?: string;
  scopes?: string[];
  tokenSource?: 'keyring' | 'env' | 'oauth' | 'github_app';
  envVarName?: string;
  cliMissing?: boolean;
  mode?: 'cli' | 'rest' | 'github_app';
  appInstalled?: boolean;
  installations?: Array<{ id: number; account: string; type: string }>;
  error?: string;
}

export interface GitHubLoginStart {
  /** Device-flow code; absent for the hosted browser flow. */
  code?: string;
  verificationUrl: string;
  flow: 'device' | 'oauth';
  targetLogin?: string;
}

export interface DesktopOAuthCredential {
  token: string;
  /** Renewal, when GitHub issues expiring tokens; see `tokensFromGitHub`. */
  refreshToken?: string;
  tokenExpiresAt?: string;
  refreshExpiresAt?: string;
  username: string;
  profileId?: string;
  name?: string;
  avatarUrl?: string;
}

export type DesktopOAuthPoll =
  | { status: 'pending' }
  | { status: 'complete'; credential: DesktopOAuthCredential }
  | { status: 'failed'; message: string }
  | { status: 'expired'; message: string };

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

export interface WorkflowDispatchOptions {
  cwd: string;
  workflow?: string;
  ref?: string;
  inputs?: Record<string, string>;
}

export interface WorkflowDispatchResult {
  workflow: string;
  ref: string;
  ownerRepo?: string;
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
 * Git config that authenticates to GitHub with a token, sent as a header rather than in the
 * URL, with TLS verification forced on. Only ever used inside withIsolatedRepository, where
 * no repository or user config can add a proxy, a CA, or a URL-scoped override.
 */
export function githubAuthConfig(token: string): Array<[string, string]> {
  const authorization = Buffer.from(`x-access-token:${token}`).toString('base64');
  return [
    ['http.https://github.com/.extraheader', `AUTHORIZATION: basic ${authorization}`],
    ['http.sslVerify', 'true'],
    ['http.https://github.com/.sslVerify', 'true']
  ];
}

/** Run token-bearing git against `sourceRepoDir`'s commits, isolated from its config. */
async function withGitHubRepository<T>(sourceRepoDir: string, use: (git: IsolatedGit, repositoryDir: string) => Promise<T>): Promise<T> {
  return withIsolatedRepository(sourceRepoDir, githubAuthConfig(await tokenForThisRequest()), use);
}

function assertCheckpointRef(ref: string): void {
  if (!/^refs\/alpha-checkpoints\/[A-Za-z0-9._/-]{1,200}$/.test(ref) || ref.includes('..') || ref.endsWith('/') || ref.endsWith('.lock')) {
    throw new Error('Invalid build checkpoint ref.');
  }
}

/**
 * Back up a build checkpoint to a hidden ref on GitHub. Not a branch: it is not listed
 * with the project's branches and does not trigger push workflows. Forced, because the
 * ref only ever names this build's latest accepted checkpoint.
 */
export async function pushCheckpointRef(cwd: string, expectedRepo: string, commit: string, ref: string): Promise<void> {
  assertOwnerRepo(expectedRepo);
  assertCheckpointRef(ref);
  if (!/^[a-f0-9]{40,64}$/i.test(commit)) throw new Error('A checkpoint backup needs a full commit ID.');
  await withGitHubRepository(cwd, git => git(['push', '--porcelain', '--no-verify', `https://github.com/${expectedRepo}.git`, `+${commit}:${ref}`]));
}

/** Bring a backed-up build checkpoint into a checkout that no longer has it. */
export async function fetchCheckpointRef(cwd: string, expectedRepo: string, ref: string): Promise<void> {
  assertOwnerRepo(expectedRepo);
  assertCheckpointRef(ref);
  await withGitHubRepository(cwd, async (git, repositoryDir) => {
    await git(['fetch', '--no-tags', `https://github.com/${expectedRepo}.git`, `+${ref}:${ref}`]);
    // Then hand the commits to the checkout locally, with no token in the environment.
    await execFileAsync('git', ['fetch', '--no-tags', repositoryDir, `+${ref}:${ref}`], { cwd, timeout: 180_000, windowsHide: true });
  });
}

async function pushAuthenticatedBranch(
  cwd: string,
  branchName: string,
  expectedRepo: string,
  inspectLocalRepo: () => Promise<RepoInspection>
): Promise<void> {
  assertSafeBranchName(branchName);
  assertOwnerRepo(expectedRepo);
  const inspection = await inspectLocalRepo();
  const localRepo = inspection.ownerRepo?.replace(/\.git$/i, '').toLowerCase();
  if (!localRepo || localRepo !== expectedRepo.toLowerCase()) {
    throw new Error('The local checkout remote no longer matches the project repository. Reconnect it before publishing.');
  }
  if (inspection.branch !== branchName) {
    throw new Error(`The validated build branch is not checked out. Expected "${branchName}"; found "${inspection.branch || 'unknown'}".`);
  }

  // Resolved without the token; the push itself runs isolated from this checkout's config.
  const { stdout } = await execFileAsync('git', ['rev-parse', '--verify', `refs/heads/${branchName}^{commit}`], { cwd, windowsHide: true });
  const commit = stdout.trim();
  await withGitHubRepository(cwd, git => git([
    'push', '--porcelain', '--no-verify', `https://github.com/${expectedRepo}.git`, `${commit}:refs/heads/${branchName}`
  ]));
}

/** Accept the repository forms project resources commonly store. */
function parseOwnerRepo(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(trimmed)) return trimmed;

  const match = trimmed.match(
    /^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+?)(?:\.git)?\/?$/i
  );
  return match?.[1];
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

/** An organization the signed-in person belongs to. */
export interface GitHubOrgMembership {
  login: string;
  role: string;
  /**
   * Whether the org lets plain members create repositories. Absent when unknown:
   * owners always can, and GitHub may not show the setting to a member.
   */
  membersCanCreateRepositories?: boolean;
}

/**
 * Adds the org's rule for members, read only for orgs where the person is not an owner.
 * Without it the panel warned every member that creation might be blocked, even in an
 * org that allows it, and that warning was read as the reason any creation failed.
 */
export async function withMemberRepoPolicy(org: GitHubOrgMembership): Promise<GitHubOrgMembership> {
  if (org.role === 'admin') return org;
  try {
    const settings = await githubApi().get<{ members_can_create_repositories?: unknown }>(`/orgs/${encodeURIComponent(org.login)}`);
    return typeof settings.members_can_create_repositories === 'boolean'
      ? { ...org, membersCanCreateRepositories: settings.members_can_create_repositories }
      : org;
  } catch {
    return org;
  }
}

export interface IGitHubService {
  checkAuth(): Promise<GitHubAuthInfo>;
  startDeviceLogin(profileLogin?: string): Promise<GitHubLoginStart>;
  listOrganizations(): Promise<GitHubOrgMembership[]>;
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
  dispatchWorkflow(options: WorkflowDispatchOptions): Promise<WorkflowDispatchResult>;
  getFailedWorkflowLogs(cwdOrRepo: string, runId: string | number): Promise<string>;
  commitAndPush(cwd: string, branchName: string, commitMessage: string, push?: boolean): Promise<boolean>;
  /** Push an already validated commit without staging or creating a new commit. */
  pushBranch(cwd: string, branchName: string, expectedRepo: string): Promise<void>;
  createPullRequest(cwd: string, title: string, body: string, base?: string, headBranch?: string): Promise<string>;
  mergePullRequest(cwd: string, prUrlOrNumber: string, method?: 'squash' | 'merge' | 'rebase'): Promise<string>;
  reviewPullRequest(cwd: string, prUrlOrNumber: string, body: string): Promise<string>;
  getOAuthLoginUrl(state?: string): { url: string; state: string };
  handleOAuthCallback(code: string, state?: string): Promise<{
    success: boolean;
    username: string;
    token: string;
    profileId?: string;
    name?: string;
    avatarUrl?: string;
  }>;
  startDesktopOAuth(handoffToken: string, profileLogin?: string): { url: string; state: string };
  isDesktopOAuthState(state?: string): boolean;
  takeDesktopOAuthResult(state: string, handoffToken: string): DesktopOAuthPoll;
  failDesktopOAuth(state: string, message: string): void;
  /** Renew a desktop's expiring GitHub token; the client secret stays in the cloud. */
  refreshDesktopToken(refreshToken: string): Promise<HostedOAuthTokens>;
  /** Null when GITHUB_APP_SLUG is unset -- there is no App to link to. */
  getGitHubAppInstallUrl(): string | null;
  handleGitHubAppWebhook(event: string, payload: any, signature?: string, rawBody?: Buffer): Promise<any>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. GhCliGitHubService: Local Desktop CLI Implementation
// ─────────────────────────────────────────────────────────────────────────────
export class GhCliGitHubService implements IGitHubService {
  /**
   * Who Alpha is signed in as.
   *
   * Asked of the credential Alpha holds and of GitHub itself, not of `gh auth
   * status`. Reading the CLI's status meant reporting the machine's account --
   * the coupling this replaced -- and it kept reporting it even once Alpha was
   * acting as somebody else.
   *
   * The name is fetched rather than taken from what was stored at sign-in: a
   * token can be revoked on github.com, and an app that goes on claiming a name
   * it no longer holds is worse than one that asks you to sign in again.
   */
  async checkAuth(): Promise<GitHubAuthInfo> {
    // A packaged desktop opens signed in only by resuming a remembered account
    // used within the idle limit, or by a GitHub authorization in this process.
    // Wait for the launch-time resume, so the window's first check sees it.
    if (IS_PACKAGED_DESKTOP) await sessionReady();
    if (requiresSessionAuthentication() && !isSessionAuthenticated()) {
      return {
        authenticated: false,
        mode: 'cli',
        tokenSource: 'oauth',
        cliMissing: !(await ghInstalled()),
        ...(getSessionAuthenticationError() ? { error: getSessionAuthenticationError() } : {})
      };
    }
    const credential = storedCredential();
    // `gh` is still what does the work, so a missing CLI is worth reporting
    // even when the sign-in itself is perfectly good.
    const cliMissing = !(await ghInstalled());

    if (!credential) return { authenticated: false, mode: 'cli', cliMissing };

    const user = await userFor(credential.token);
    if (!user?.login) return { authenticated: false, mode: 'cli', tokenSource: 'oauth', cliMissing };
    // Still in use, for the idle limit.
    touchActiveProfile();
    const remembered = activeProfile();

    return {
      authenticated: true,
      profileId: user.id ?? credential.userId ?? remembered?.id,
      username: user.login,
      name: user.name ?? credential.name,
      avatarUrl: user.avatarUrl ?? credential.avatarUrl,
      protocol: 'https',
      scopes: GITHUB_SCOPE.split(',').map(scope => scope.trim()).filter(Boolean),
      tokenSource: 'oauth',
      mode: 'cli',
      cliMissing
    };
  }

  /**
   * Begin a sign-in, as Alpha rather than as the machine.
   *
   * This used to drive `gh auth login --web` and scrape the code out of its
   * output, which signed *the machine* in -- changing an account the developer
   * owns, for every other tool that uses the CLI. Alpha now runs the device
   * flow itself and keeps the token it is given.
   *
   * Returns as soon as there is a code to show. The authorisation happens in a
   * browser, on the person's own time, so waiting for it runs in the background
   * while the UI polls `checkAuth` -- exactly as it did when `gh` drove this.
   */
  async startDeviceLogin(profileLogin?: string): Promise<GitHubLoginStart> {
    beginSessionAuthentication();

    /**
     * A packaged desktop can reach the hosted deployment without carrying its
     * OAuth secret. Use that deployment's browser flow when available: unlike
     * device activation, it accepts `login` and `prompt=select_account`, so a
     * remembered profile actually determines the account GitHub presents.
     */
    if (IS_DESKTOP && ALPHA_CLOUD_API) {
      const hosted = await requestHostedOAuth(profileLogin);
      void awaitHostedOAuth(hosted).catch(err => {
        const message = err instanceof Error ? err.message : 'Hosted GitHub sign-in did not complete.';
        setSessionAuthenticationError(message);
        logError('Hosted GitHub sign-in did not complete:', message);
      });
      return {
        verificationUrl: hosted.authorizationUrl,
        flow: 'oauth',
        ...(profileLogin ? { targetLogin: profileLogin } : {})
      };
    }

    // A device flow cannot carry a selected login. Never let a remembered
    // profile silently become whichever GitHub account the browser already
    // has open; that is exactly the ambiguity the picker is meant to remove.
    if (profileLogin) {
      throw new DeviceFlowError(
        'This desktop build cannot target a remembered GitHub profile because ALPHA_CLOUD_API is not configured. ' +
          'Use a build connected to the hosted Alpha API, or choose Add another account.'
      );
    }

    const code = await requestDeviceCode();

    void awaitAuthorization(code).catch(err => {
      // Nothing awaits this: the UI learns the sign-in worked by seeing
      // `authenticated` turn true, and learns it did not by the code it is
      // showing expiring. Logged so the reason is not lost either way.
      const message = err instanceof Error ? err.message : 'GitHub sign-in did not complete.';
      setSessionAuthenticationError(message);
      logError('GitHub sign-in did not complete:', message);
    });

    return {
      code: code.userCode,
      verificationUrl: code.verificationUrl,
      flow: 'device',
      ...(profileLogin ? { targetLogin: profileLogin } : {})
    };
  }

  async listOrganizations(): Promise<Array<{ login: string; role: string }>> {
    try {
      const { stdout } = await execGh([
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

  /**
   * Sign Alpha out, and nothing else.
   *
   * This used to run `gh auth logout`, which signed the machine out of GitHub
   * for every other tool that used the CLI -- pressing sign out in one app took
   * the terminal down with it. Alpha forgets its own token and leaves the
   * developer's `gh` login exactly as they set it.
   */
  async logout(): Promise<void> {
    clearCredential();
    logInfo("Signed out of GitHub. Alpha's credential is gone; the machine's own `gh` login is untouched.");
  }

  async listRepositories(limit = 30): Promise<GitHubRepo[]> {
    try {
      const { stdout } = await execGh([
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
    const { name, visibility = 'private', org, sourceDir, initReadme = true } = opts;
    const description = githubRepoDescription(opts.description);
    const target = org ? `${org}/${name}` : name;
    const args = ['repo', 'create', target, `--${visibility}`];

    if (description) args.push('--description', description);
    if (sourceDir) {
      args.push('--source', '.', '--remote', 'origin', '--push');
    } else if (initReadme) {
      args.push('--add-readme');
    }

    try {
      await execGh(args, sourceDir ? { cwd: sourceDir } : {});
      const { stdout: viewOut } = await execGh(['repo', 'view', target, '--json', 'url,nameWithOwner']);
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
      const { stdout } = await execGh([
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
      const { stdout } = await execGh([
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
      const { stdout } = await execGh([
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

    await execGh(['repo', 'clone', repo, target]);
    logInfo(`Cloned ${repo} into ${target}`);
    return target;
  }

  async forkRepository(repo: string, cloneInto?: string): Promise<string> {
    await execGh(['repo', 'fork', repo, '--clone=false']);
    if (cloneInto) {
      const who = await execGh(['api', 'user', '--jq', '.login']);
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
      const capped = Math.max(1, Math.min(100, Math.trunc(limit)));
      const ownerRepo = parseOwnerRepo(cwd);
      if (ownerRepo) assertOwnerRepo(ownerRepo);
      const args = [
        'run',
        'list',
        '--limit',
        String(capped),
        '--json',
        'databaseId,name,status,conclusion,headBranch,headSha,url,createdAt,updatedAt'
      ];
      if (ownerRepo) args.push('--repo', ownerRepo);
      const { stdout } = await execGh(args, ownerRepo ? {} : { cwd });
      return JSON.parse(stdout);
    } catch (err: any) {
      logError('Failed to list GitHub workflow runs via CLI:', err?.message || err);
      return [];
    }
  }

  async dispatchWorkflow(options: WorkflowDispatchOptions): Promise<WorkflowDispatchResult> {
    const cwd = options.cwd;
    const ownerRepo = parseOwnerRepo(cwd);
    if (ownerRepo) assertOwnerRepo(ownerRepo);
    const inspection = ownerRepo
      ? { isRepo: true, workflows: [], hasReadme: false, branch: undefined, ownerRepo }
      : await this.inspectLocalRepo(cwd);
    if (!inspection.isRepo) {
      throw new Error(`Cannot dispatch a workflow: "${cwd}" is not a Git repository.`);
    }

    let workflow: string | undefined = options.workflow?.trim() || inspection.workflows[0];
    if (!workflow && ownerRepo) {
      try {
        const { stdout } = await execGh([
          'workflow',
          'list',
          '--repo',
          ownerRepo,
          '--limit',
          '100',
          '--json',
          'path,state'
        ]);
        const available = JSON.parse(stdout);
        workflow = Array.isArray(available)
          ? available
              .filter((item: any) => item?.state === 'active' || !item?.state)
              .map((item: any) => item?.path)
              .find((value: unknown): value is string => typeof value === 'string')
          : undefined;
      } catch (err: any) {
        const detail = String(err?.stderr || err?.message || err).trim();
        throw new Error(`Could not list GitHub Actions workflows for ${ownerRepo}: ${detail}`);
      }
    }
    if (!workflow) {
      throw new Error(`No GitHub Actions workflow found in "${cwd}".`);
    }
    assertSafeWorkflowName(workflow);

    const requestedRef = options.ref?.trim();
    const ref = requestedRef || (inspection.branch && inspection.branch !== 'HEAD' ? inspection.branch : 'main');
    assertSafeBranchName(ref, 'Workflow ref');

    try {
      const args = [
        'workflow',
        'run',
        workflow,
        '--ref',
        ref,
        ...(ownerRepo ? ['--repo', ownerRepo] : []),
        ...workflowInputArgs(options.inputs)
      ];
      await execGh(args, ownerRepo ? {} : { cwd });
    } catch (err: any) {
      const detail = String(err?.stderr || err?.message || err).trim();
      throw new Error(`GitHub Actions workflow dispatch failed: ${detail}`);
    }

    return { workflow, ref, ownerRepo: inspection.ownerRepo };
  }

  async getFailedWorkflowLogs(cwd: string, runId: string | number): Promise<string> {
    try {
      // runId arrives as the :id route parameter, so it is caller-controlled.
      if (!/^\d+$/.test(String(runId))) throw new Error(`Invalid workflow run id "${runId}".`);
      const ownerRepo = parseOwnerRepo(cwd);
      if (ownerRepo) assertOwnerRepo(ownerRepo);
      const args = ['run', 'view', String(runId), '--log-failed'];
      if (ownerRepo) args.push('--repo', ownerRepo);
      const { stdout } = await execGh(args, ownerRepo ? {} : { cwd });
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
  /**
   * Stage everything, commit if there is anything to commit, and push.
   *
   * The commit is conditional because "nothing to commit" is not a failure of
   * this method — its job is to leave the branch pushed, and a branch whose work
   * is already committed is in exactly that state.
   *
   * It used to throw there, and the run pipeline calls this immediately before
   * opening the pull request inside the same try block. So once an agent could
   * commit its own work (github_push_branch), the pipeline's commit would fail
   * on the empty index, jump to the catch, and skip the pull request entirely —
   * a run that did everything right and opened nothing.
   *
   * @returns whether a new commit was created.
   */
  /**
   * `push` false commits locally and stops there.
   *
   * A run by a read-only agent still wants its work committed — that is how the
   * diff and the branch exist to look at — but nothing of it should reach the
   * remote. Splitting the two is the only way to say that: they were one
   * operation, so a Supervised reviewer's run pushed a branch and opened a
   * second pull request for a change that was already under review.
   */
  async commitAndPush(
    cwd: string,
    branchName: string,
    commitMessage: string,
    push = true
  ): Promise<boolean> {
    assertSafeBranchName(branchName);
    await execFileAsync('git', ['add', '-A'], { cwd });

    // `diff --cached --quiet` exits 1 when the index holds changes. Asking git
    // is the only reliable test; parsing `status` output is not.
    let hasStagedChanges = false;
    try {
      await execFileAsync('git', ['diff', '--cached', '--quiet'], { cwd });
    } catch {
      hasStagedChanges = true;
    }

    if (hasStagedChanges) {
      await execFileAsync('git', ['commit', '-m', commitMessage], { cwd });
    }

    if (push) {
      await execFileAsync('git', ['push', '-u', 'origin', branchName], { cwd });
    }
    return hasStagedChanges;
  }

  async pushBranch(cwd: string, branchName: string, expectedRepo: string): Promise<void> {
    await pushAuthenticatedBranch(cwd, branchName, expectedRepo, () => this.inspectLocalRepo(cwd));
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

    const { stdout } = await execGh(args, { cwd });
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

  /**
   * Post a review on a pull request, as a comment and never as an approval.
   *
   * `--comment` is not a weaker choice made for caution; it is the only one
   * available. Every agent reaches GitHub through the operator's own `gh`
   * credentials, so an agent reviewing a pull request an agent opened is one
   * account acting twice — and GitHub refuses both APPROVE and REQUEST_CHANGES
   * on your own pull request. Asking for either would fail at the API, so the
   * verdict travels in the body text and in Alpha's own record instead.
   *
   * Approving for real needs the agents to be distinct GitHub identities,
   * which means a GitHub App — a different piece of work, not a flag here.
   */
  async reviewPullRequest(cwd: string, prUrlOrNumber: string, body: string): Promise<string> {
    assertSafePrRef(prUrlOrNumber);
    // Body is model-authored free text: safe as argv, not as a command string.
    const { stdout } = await execFileAsync(
      'gh',
      ['pr', 'review', prUrlOrNumber, '--comment', '--body', body],
      { cwd }
    );
    return stdout.trim();
  }

  getOAuthLoginUrl(): { url: string; state: string } {
    return { url: '', state: '' };
  }

  async handleOAuthCallback(): Promise<{
    success: boolean;
    username: string;
    token: string;
    profileId?: string;
    name?: string;
    avatarUrl?: string;
  }> {
    throw new Error('OAuth Web Flow is only used in hosted REST mode.');
  }

  startDesktopOAuth(): { url: string; state: string } {
    throw new Error('Desktop OAuth handoff is only available through the hosted service.');
  }

  isDesktopOAuthState(): boolean {
    return false;
  }

  takeDesktopOAuthResult(): DesktopOAuthPoll {
    return { status: 'expired', message: 'Hosted GitHub authorization is unavailable.' };
  }

  failDesktopOAuth(): void {
    // There is no hosted handoff state in the local CLI implementation.
  }

  async refreshDesktopToken(): Promise<HostedOAuthTokens> {
    throw new Error('Renewing a desktop sign-in is only available through the hosted service.');
  }

  getGitHubAppInstallUrl(): string | null {
    return GITHUB_APP_SLUG ? `https://github.com/apps/${GITHUB_APP_SLUG}/installations/new` : null;
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
  private readonly pendingStates = new Map<string, {
    expiresAt: number;
    desktopHandoffToken?: string;
    expectedLogin?: string;
  }>();

  /** One-time desktop credentials waiting for the local daemon to collect them. */
  private readonly desktopResults = new Map<string, {
    expiresAt: number;
    handoffToken: string;
    result?: DesktopOAuthCredential;
    error?: string;
  }>();

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
    return this.issueOAuthUrl(state);
  }

  /** Start the hosted browser flow used by an installed desktop profile picker. */
  startDesktopOAuth(handoffToken: string, profileLogin?: string): { url: string; state: string } {
    if (!/^[a-f0-9]{64}$/i.test(handoffToken)) {
      throw new Error('The desktop OAuth handoff token is invalid.');
    }
    if (profileLogin !== undefined && !/^[A-Za-z0-9-]{1,39}$/.test(profileLogin)) {
      throw new Error('The requested GitHub login is invalid.');
    }

    const state = crypto.randomBytes(32).toString('hex');
    this.sweepExpiredStates();
    this.pendingStates.set(state, {
      expiresAt: Date.now() + OAUTH_STATE_TTL_MS,
      desktopHandoffToken: handoffToken,
      ...(profileLogin ? { expectedLogin: profileLogin } : {})
    });
    this.desktopResults.delete(state);

    return {
      ...this.buildOAuthUrl(state, profileLogin),
      state
    };
  }

  private issueOAuthUrl(state: string): { url: string; state: string } {
    if (!GITHUB_CLIENT_ID) {
      throw new Error('GITHUB_CLIENT_ID is not configured in backend environment.');
    }
    // Without it GitHub falls back to the App's registered callback, which may
    // be a different deployment -- one this session's cookie will never reach.
    if (!GITHUB_CALLBACK_URL) {
      throw new Error('GITHUB_CALLBACK_URL is not configured in backend environment.');
    }

    // Remember the state so the callback can prove this flow started here.
    // Without this the `state` parameter is decoration and the callback accepts
    // any code, which is how OAuth CSRF works: an attacker begins a flow and
    // gets their GitHub account bound to the victim's session.
    this.sweepExpiredStates();
    this.pendingStates.set(state, { expiresAt: Date.now() + OAUTH_STATE_TTL_MS });

    return {
      ...this.buildOAuthUrl(state),
      state
    };
  }

  private buildOAuthUrl(state: string, profileLogin?: string): { url: string } {
    if (!GITHUB_CLIENT_ID) {
      throw new Error('GITHUB_CLIENT_ID is not configured in backend environment.');
    }
    if (!GITHUB_CALLBACK_URL) {
      throw new Error('GITHUB_CALLBACK_URL is not configured in backend environment.');
    }
    const params = new URLSearchParams({
      client_id: GITHUB_CLIENT_ID,
      redirect_uri: GITHUB_CALLBACK_URL,
      scope: GITHUB_SCOPE,
      state,
      // GitHub's browser flow supports both a suggested login and an explicit
      // account chooser. This is what prevents a remembered Alpha card from
      // silently following whichever GitHub account the browser last used.
      prompt: 'select_account'
    });
    if (profileLogin) params.set('login', profileLogin);
    return {
      url: `https://github.com/login/oauth/authorize?${params.toString()}`
    };
  }

  private sweepExpiredStates(): void {
    const now = Date.now();
    for (const [value, entry] of this.pendingStates) {
      if (entry.expiresAt <= now) this.pendingStates.delete(value);
    }
    for (const [value, entry] of this.desktopResults) {
      if (entry.expiresAt <= now) this.desktopResults.delete(value);
    }
  }

  isDesktopOAuthState(state?: string): boolean {
    if (!state) return false;
    this.sweepExpiredStates();
    return Boolean(this.pendingStates.get(state)?.desktopHandoffToken);
  }

  /**
   * Validate and consume a `state`. Single use: replaying a callback must fail.
   *
   * In-memory is correct for one Render instance. Scaling to several requires
   * moving this to Postgres/Redis, because a callback can land on any instance —
   * noted rather than pre-built, since the failure is a confusing login error
   * rather than a security hole.
   */
  private consumeState(state: string | undefined): { desktopHandoffToken?: string; expectedLogin?: string } {
    if (!state) throw new Error('OAuth callback is missing the state parameter.');
    this.sweepExpiredStates();
    const entry = this.pendingStates.get(state);
    if (!entry) {
      throw new Error('OAuth state is unrecognized or expired. Start the sign-in again.');
    }
    this.pendingStates.delete(state);
    return { desktopHandoffToken: entry.desktopHandoffToken, expectedLogin: entry.expectedLogin };
  }

  async handleOAuthCallback(
    code: string,
    state?: string
  ): Promise<{
    success: boolean;
    username: string;
    token: string;
    profileId?: string;
    name?: string;
    avatarUrl?: string;
  }> {
    if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
      throw new Error('GITHUB_CLIENT_ID or GITHUB_CLIENT_SECRET is missing');
    }

    const pending = this.consumeState(state);

    try {
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
      const authenticatedLogin = typeof user?.login === 'string' ? user.login : '';
      if (!authenticatedLogin) throw new Error('GitHub did not return the authorized account name.');
      if (pending.expectedLogin && authenticatedLogin.toLowerCase() !== pending.expectedLogin.toLowerCase()) {
        throw new Error(
          `GitHub authorized @${authenticatedLogin}, but this sign-in was started for @${pending.expectedLogin}. ` +
          'Choose the selected account and try again.'
        );
      }

      const result = {
        success: true,
        username: authenticatedLogin,
        token: data.access_token,
        ...(user.id === undefined ? {} : { profileId: String(user.id) }),
        ...(user.name ? { name: user.name } : {}),
        ...(user.avatar_url ? { avatarUrl: user.avatar_url } : {})
      };

      if (pending.desktopHandoffToken && state) {
        this.desktopResults.set(state, {
          expiresAt: Date.now() + OAUTH_STATE_TTL_MS,
          handoffToken: pending.desktopHandoffToken,
          result: {
            // Renewal too, so the desktop can keep this account signed in
            // past the token's own expiry without coming back to GitHub.
            ...(tokensFromGitHub(data) ?? { token: result.token }),
            username: result.username,
            ...(result.profileId ? { profileId: result.profileId } : {}),
            ...(result.name ? { name: result.name } : {}),
            ...(result.avatarUrl ? { avatarUrl: result.avatarUrl } : {})
          }
        });
      }

      return result;
    } catch (err) {
      // `consumeState` removes the CSRF state before the exchange. Preserve a
      // desktop failure long enough for the local daemon to show the actual
      // GitHub error instead of waiting until the handoff simply expires.
      if (pending.desktopHandoffToken && state) {
        this.desktopResults.set(state, {
          expiresAt: Date.now() + OAUTH_STATE_TTL_MS,
          handoffToken: pending.desktopHandoffToken,
          error: err instanceof Error ? err.message : 'GitHub OAuth failed.'
        });
      }
      throw err;
    }
  }

  takeDesktopOAuthResult(state: string, handoffToken: string): DesktopOAuthPoll {
    this.sweepExpiredStates();
    const result = this.desktopResults.get(state);
    if (result) {
      if (!safeEqualSecret(result.handoffToken, handoffToken)) {
        return { status: 'failed', message: 'The desktop OAuth handoff token is invalid.' };
      }
      this.desktopResults.delete(state);
      if (result.error) return { status: 'failed', message: result.error };
      if (result.result) return { status: 'complete', credential: result.result };
    }

    if (this.pendingStates.has(state)) return { status: 'pending' };
    return { status: 'expired', message: 'The desktop GitHub authorization expired. Start sign-in again.' };
  }

  failDesktopOAuth(state: string, message: string): void {
    const pending = this.pendingStates.get(state);
    if (!pending?.desktopHandoffToken) return;
    this.pendingStates.delete(state);
    this.desktopResults.set(state, {
      expiresAt: Date.now() + OAUTH_STATE_TTL_MS,
      handoffToken: pending.desktopHandoffToken,
      error: message
    });
  }

  /**
   * Renew a desktop's expiring GitHub token.
   *
   * GitHub requires the client secret to refresh a GitHub App user token, and
   * an installer cannot carry one, so the desktop sends its refresh token here.
   * The refresh token is itself the proof: it was issued to that account, is
   * single-use (GitHub rotates it), and is never stored in the cloud.
   */
  async refreshDesktopToken(refreshToken: string): Promise<HostedOAuthTokens> {
    if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
      throw new Error('GITHUB_CLIENT_ID or GITHUB_CLIENT_SECRET is missing');
    }
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: refreshToken
      })
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const tokens = tokensFromGitHub(data);
    if (!tokens) {
      throw new Error(`GitHub would not renew the sign-in: ${data.error_description || data.error || res.status}`);
    }
    return tokens;
  }

  getGitHubAppInstallUrl(): string | null {
    return GITHUB_APP_SLUG ? `https://github.com/apps/${GITHUB_APP_SLUG}/installations/new` : null;
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
    const { name, visibility = 'private', org, initReadme = true } = opts;
    const endpoint = org ? `/orgs/${org}/repos` : '/user/repos';
    const description = githubRepoDescription(opts.description);
    const body = {
      name,
      private: visibility === 'private',
      ...(description ? { description } : {}),
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
      let ownerRepo = parseOwnerRepo(cwdOrRepo) || null;
      if (!ownerRepo && cwdOrRepo) {
        const inspection = await this.inspectLocalRepo(cwdOrRepo);
        ownerRepo = inspection.ownerRepo || null;
      }
      if (!ownerRepo) {
        const repos = await this.listRepositories(1);
        if (repos.length > 0) ownerRepo = repos[0].nameWithOwner;
      }
      if (!ownerRepo) return [];
      assertOwnerRepo(ownerRepo);

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

  async dispatchWorkflow(options: WorkflowDispatchOptions): Promise<WorkflowDispatchResult> {
    const ownerRepoTarget = parseOwnerRepo(options.cwd);
    const inspection = ownerRepoTarget
      ? { isRepo: true, workflows: [], hasReadme: false, branch: undefined, ownerRepo: ownerRepoTarget }
      : await this.inspectLocalRepo(options.cwd);
    const ownerRepo = inspection.ownerRepo;
    if (!ownerRepo) {
      throw new Error(`Cannot dispatch a workflow: no GitHub repository is configured for "${options.cwd}".`);
    }
    assertOwnerRepo(ownerRepo);

    let workflow = options.workflow?.trim();
    if (!workflow) {
      const data = await this.request(`/repos/${ownerRepo}/actions/workflows?per_page=100`);
      const available = (data?.workflows || [])
        .filter((item: any) => item?.state === 'active' || !item?.state)
        .map((item: any) => item?.path || item?.file_name || item?.name)
        .filter((value: unknown): value is string => typeof value === 'string');
      workflow = available[0];
    }
    if (!workflow) {
      throw new Error(`No active GitHub Actions workflow found in ${ownerRepo}.`);
    }
    assertSafeWorkflowName(workflow);

    const requestedRef = options.ref?.trim();
    const ref = requestedRef || (inspection.branch && inspection.branch !== 'HEAD' ? inspection.branch : 'main');
    assertSafeBranchName(ref, 'Workflow ref');
    // Reuse the same validation as the CLI implementation, without translating
    // the inputs into command-line flags.
    workflowInputArgs(options.inputs);

    await this.request(`/repos/${ownerRepo}/actions/workflows/${encodeWorkflowPath(workflow)}/dispatches`, {
      method: 'POST',
      body: JSON.stringify({ ref, inputs: options.inputs || {} })
    });

    return { workflow, ref, ownerRepo };
  }

  async getFailedWorkflowLogs(cwdOrRepo: string, runId: string | number): Promise<string> {
    try {
      let ownerRepo = parseOwnerRepo(cwdOrRepo) || null;
      if (!ownerRepo) {
        const inspection = await this.inspectLocalRepo(cwdOrRepo);
        ownerRepo = inspection.ownerRepo || null;
      }
      if (!ownerRepo) return 'Owner/Repo not resolved for workflow log inspection.';
      assertOwnerRepo(ownerRepo);

      // The log text itself, as the desktop's `gh run view --log-failed` gives:
      // step names and a link alone left a hosted agent unable to see the error.
      return await failedRunLogs(githubApiWithToken(await this.getAuthToken()), ownerRepo, runId);
    } catch (err: any) {
      return `Failed to fetch logs: ${err?.message || err}`;
    }
  }

  async commitAndPush(cwd: string, branchName: string, commitMessage: string, push = true): Promise<boolean> {
    const cli = new GhCliGitHubService();
    return cli.commitAndPush(cwd, branchName, commitMessage, push);
  }

  async pushBranch(cwd: string, branchName: string, expectedRepo: string): Promise<void> {
    await pushAuthenticatedBranch(cwd, branchName, expectedRepo, () => this.inspectLocalRepo(cwd));
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

  async reviewPullRequest(cwd: string, prUrlOrNumber: string, body: string): Promise<string> {
    const inspection = await this.inspectLocalRepo(cwd);
    const prNumberMatch = prUrlOrNumber.match(/\/pull\/(\d+)/) || prUrlOrNumber.match(/^(\d+)$/);
    if (inspection.ownerRepo && prNumberMatch) {
      const prNumber = prNumberMatch[1];
      await this.request(`/repos/${inspection.ownerRepo}/pulls/${prNumber}/reviews`, {
        method: 'POST',
        // COMMENT for the same reason as the CLI path: one identity cannot
        // approve its own pull request.
        body: JSON.stringify({ event: 'COMMENT', body })
      });
      return 'Review posted';
    }

    const cli = new GhCliGitHubService();
    return cli.reviewPullRequest(cwd, prUrlOrNumber, body);
  }

  startDeviceLogin(profileLogin?: string): Promise<GitHubLoginStart> {
    const cli = new GhCliGitHubService();
    return cli.startDeviceLogin(profileLogin);
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
    if (requiresSessionAuthentication()) return cliAuth;

    const restAuth = await this.restService.checkAuth();
    if (restAuth.authenticated) return restAuth;

    return cliAuth;
  }

  async startDeviceLogin(profileLogin?: string): Promise<GitHubLoginStart> {
    return this.cliService.startDeviceLogin(profileLogin);
  }

  async listOrganizations(): Promise<GitHubOrgMembership[]> {
    const auth = await this.checkAuth();
    const orgs = auth.mode === 'rest' || auth.mode === 'github_app'
      ? await this.restService.listOrganizations()
      : await this.cliService.listOrganizations();
    return Promise.all(orgs.map(withMemberRepoPolicy));
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

  async dispatchWorkflow(options: WorkflowDispatchOptions): Promise<WorkflowDispatchResult> {
    const auth = await this.checkAuth();
    if (auth.mode === 'rest' || auth.mode === 'github_app') {
      return this.restService.dispatchWorkflow(options);
    }
    return this.cliService.dispatchWorkflow(options);
  }

  async getFailedWorkflowLogs(cwdOrRepo: string, runId: string | number): Promise<string> {
    const auth = await this.checkAuth();
    if (auth.mode === 'rest' || auth.mode === 'github_app') {
      return this.restService.getFailedWorkflowLogs(cwdOrRepo, runId);
    }
    return this.cliService.getFailedWorkflowLogs(cwdOrRepo, runId);
  }

  async commitAndPush(cwd: string, branchName: string, commitMessage: string, push = true): Promise<boolean> {
    return this.cliService.commitAndPush(cwd, branchName, commitMessage, push);
  }

  async pushBranch(cwd: string, branchName: string, expectedRepo: string): Promise<void> {
    const auth = await this.checkAuth();
    if (!auth.authenticated) throw new Error('Alpha is not signed in to GitHub. Sign in from Connected Accounts before publishing.');
    await this.cliService.pushBranch(cwd, branchName, expectedRepo);
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

  async reviewPullRequest(cwd: string, prUrlOrNumber: string, body: string): Promise<string> {
    const auth = await this.checkAuth();
    if (auth.mode === 'rest' || auth.mode === 'github_app') {
      return this.restService.reviewPullRequest(cwd, prUrlOrNumber, body);
    }
    return this.cliService.reviewPullRequest(cwd, prUrlOrNumber, body);
  }

  getOAuthLoginUrl(state?: string): { url: string; state: string } {
    return this.restService.getOAuthLoginUrl(state);
  }

  async handleOAuthCallback(
    code: string,
    state?: string
  ): Promise<{
    success: boolean;
    username: string;
    token: string;
    profileId?: string;
    name?: string;
    avatarUrl?: string;
  }> {
    return this.restService.handleOAuthCallback(code, state);
  }

  startDesktopOAuth(handoffToken: string, profileLogin?: string): { url: string; state: string } {
    return this.restService.startDesktopOAuth(handoffToken, profileLogin);
  }

  isDesktopOAuthState(state?: string): boolean {
    return this.restService.isDesktopOAuthState(state);
  }

  takeDesktopOAuthResult(state: string, handoffToken: string): DesktopOAuthPoll {
    return this.restService.takeDesktopOAuthResult(state, handoffToken);
  }

  failDesktopOAuth(state: string, message: string): void {
    this.restService.failDesktopOAuth(state, message);
  }

  refreshDesktopToken(refreshToken: string): Promise<HostedOAuthTokens> {
    return this.restService.refreshDesktopToken(refreshToken);
  }

  getGitHubAppInstallUrl(): string | null {
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
