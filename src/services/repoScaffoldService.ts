import fs from 'node:fs/promises';
import path from 'node:path';

import { ALPHA_CLOUD_API, IS_CLOUD, IS_DESKTOP } from '../config/env.js';
import { ensureWorkspacesRoot, projectRepoPath } from './workspaceService.js';
import { logInfo, logError } from '../utils/logger.js';
import { githubService } from './githubService.js';
import { githubApi } from './githubApi.js';
import { provisionRepository } from './githubRepoProvisioning.js';
import { buildCiWorkflows, buildMonorepoCiWorkflows, type CiWorkflowPlan, type DeployTarget } from './ciWorkflows.js';
import {
  buildMonorepoScaffold,
  buildProjectScaffold,
  normalizeProjectStack,
  type CanonicalStack,
  type ScaffoldFile
} from './scaffoldBuilder.js';
import { cloudRequest } from './cloudWorkspaces.js';
import { platformForStack, roleForStack, setUpHosting, unavailableHostingStatus, type HostingStatus } from './hosting/hostingService.js';
import { MONOREPO_APP_IDS, MONOREPO_APPS, type MonorepoAppId } from './monorepoApps.js';

export interface CreateScaffoldedRepoInput {
  /** Project key, used as the workspace folder name. */
  projectKey: string;
  repoName: string;
  /**
   * Owning GitHub organization. Required, not optional: Alpha does not create
   * repositories on personal accounts, and an optional field here would make
   * that policy hold only for callers who happen to send it.
   */
  org: string;
  visibility?: 'private' | 'public';
  stack: string;
  repoShape?: string;
  includeDocker?: boolean;
  description?: string;
  /** Defaults to repoName. Seeds the README title and package name. */
  serviceName?: string;
  /**
   * Set up Render/Vercel hosting for this repository once it exists. Default
   * true. There is no deploy job to gate any more -- the platforms deploy
   * through their own GitHub Apps -- so this now controls one thing only:
   * whether `hostingService` runs at all. `false` leaves the repository
   * unhosted; the scaffold result's `hosting` field is then absent rather
   * than `unavailable`, since unavailable means "hosting was wanted but this
   * server cannot do it," not "hosting was not asked for."
   */
  deploy?: boolean;
  /**
   * `owner/name` of this repository's pair, when one already exists.
   * `createPairedProject` sets this on the frontend's call once its backend
   * has been created, so the frontend's hosting setup knows the backend's
   * URLs immediately instead of leaving them for a later retry. Not part of
   * the public scaffold API -- a standalone repository has no pair to name.
   */
  partnerNameWithOwner?: string;
  /**
   * The workspace this scaffold was asked for in. A desktop's hosting forward
   * carries it, so the cloud checks the caller's role in *that* workspace
   * rather than whichever one it would resolve first.
   */
  workspaceId?: string;
}

export interface CreateScaffoldedRepoResult {
  url: string;
  nameWithOwner: string;
  /** The desktop's working copy. Absent in the cloud, which keeps none. */
  localPath?: string;
  files: string[];
  /** The one commit every pipeline branch starts at. */
  commitSha: string;
  branches: string[];
  protectedBranches: string[];
  /** Why GitHub would not protect uat/main (e.g. a private repo on the free plan). */
  protectionUnavailable?: string;
  /** Set when the repository was created but the desktop could not clone it. */
  cloneError?: string;
  /** Which platform this stack hosts on. Always set -- see `ciWorkflows.CiWorkflowPlan`. */
  deployTarget: DeployTarget;
  /** Always empty: hosting deploys through the platform's own GitHub App, never a repository secret. */
  requiredSecrets: string[];
  /** Always null, for the same reason. */
  deployVariable: string | null;
  /** Where the CI template came from. */
  ciSource: string;
  /** Absent when `deploy: false`. `state: 'unavailable'` when this server has no credentials for the platform. */
  hosting?: HostingStatus;
}

/** A README section saying what the generated CI does, and where hosting is set up. */
function ciReadmeSection(plan: CiWorkflowPlan, hostingRequested: boolean): string {
  const code = (text: string) => '`' + text + '`';
  const platformName = plan.deployTarget === 'render' ? 'Render' : 'Vercel';
  return [
    '',
    '## CI/CD',
    '',
    `${code('.github/workflows/ci.yml')} runs unit tests with coverage, lint and a security scan on every ` +
      `push and pull request to ${code('dev')}, ${code('uat')} and ${code('main')} (from ${code(plan.source)}).`,
    '',
    `Work lands on ${code('dev')}, is promoted to ${code('uat')}, then to ${code('main')}, by pull request only.`,
    '',
    hostingRequested
      ? `Hosting on **${platformName}** is set up automatically by Alpha. See its status, URLs and deploys from ` +
        'this repository’s project in Alpha.'
      : `Hosting on **${platformName}** was not set up for this repository. Alpha can set it up from this ` +
        'repository’s project page.',
    ''
  ].join('\n');
}

/** Append the CI section to the scaffold's README, and add the workflow files. */
function withCi(files: ScaffoldFile[], plan: CiWorkflowPlan, hostingRequested: boolean): ScaffoldFile[] {
  return [
    ...files.map(file =>
      file.path === 'README.md' ? { ...file, content: file.content + ciReadmeSection(plan, hostingRequested) } : file
    ),
    ...plan.files
  ];
}

/**
 * Hosting setup for a freshly scaffolded repository.
 *
 * Cloud mode calls `hostingService` directly -- only the cloud ever holds
 * Render/Vercel credentials. A desktop has none and must never be given any
 * (a token that can create billed infrastructure does not belong on a
 * teammate's laptop), so it forwards the same request to the cloud with its
 * own GitHub token instead, exactly like every other cloud-only capability
 * (`cloudWorkspaces.cloudRequest`). `partner` is passed explicitly rather
 * than discovered: at scaffold time Alpha already knows the pairing, because
 * it just created both repositories itself.
 */
async function runHostingSetup(
  nameWithOwner: string,
  stack: CanonicalStack,
  partner?: string,
  workspaceId?: string,
  app?: MonorepoAppId
): Promise<HostingStatus> {
  if (IS_CLOUD) {
    return setUpHosting({ repo: nameWithOwner, stackHint: stack, ...(partner ? { partnerHint: partner } : {}), ...(app ? { app } : {}) });
  }

  if (!ALPHA_CLOUD_API) {
    return unavailableHostingStatus(
      nameWithOwner,
      roleForStack(stack),
      platformForStack(stack),
      'This desktop has no cloud configured, and hosting only runs in the cloud.',
      partner ?? null
    );
  }

  const [owner, name] = nameWithOwner.split('/');
  const answer = await cloudRequest<HostingStatus>(`/hosting/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, {
    method: 'POST',
    body: { stack, ...(partner ? { partner } : {}), ...(app ? { app } : {}) },
    ...(workspaceId ? { workspaceId } : {}),
    // Creating services waits on both platforms; the default timeout is for quick reads.
    timeoutMs: 180_000
  });
  if (answer.status >= 200 && answer.status < 300) return answer.body;

  return unavailableHostingStatus(
    nameWithOwner,
    roleForStack(stack),
    platformForStack(stack),
    (answer.body as { error?: string } | null)?.error ?? `The cloud answered ${answer.status} setting up hosting.`,
    partner ?? null
  );
}

/**
 * Repository names are lowercase.
 *
 * GitHub accepts any case, but the frontend's Vercel project takes the same
 * name and Vercel refuses uppercase ("Project names ... must be lowercase"),
 * so a repository called TestProject-fe was created on GitHub and then left
 * unhosted. Case is the one thing rewritten here: GitHub names are
 * case-insensitive, so testproject-fe is the same repository to anyone typing
 * either, and the create form already shows the lowercase name as it is typed.
 * Everything else that is wrong is refused with an explanation.
 */
export function normalizeRepoName(name: unknown): string {
  return typeof name === 'string' ? name.trim().toLowerCase() : '';
}

/**
 * Lowercase letters, digits, '.', '_' and '-': what both GitHub and Vercel
 * accept. Vercel also refuses '---' anywhere in a project name.
 */
function assertValidRepoName(name: string): void {
  const valid =
    /^[a-z0-9._-]{1,100}$/.test(name) &&
    !name.startsWith('.') &&
    !name.startsWith('-') &&
    !name.includes('---') &&
    name !== '.' &&
    name !== '..';

  if (!valid) {
    throw new Error(
      `Invalid repository name "${name}". Use lowercase letters, numbers, dots, hyphens and underscores, without "---".`
    );
  }
}

/**
 * Guard a value used as a single path segment.
 *
 * `projectKey` reaches here from a request body, and it is joined into a
 * filesystem path — so '..' or a separator would place the scaffold outside
 * the workspaces root entirely.
 */
function assertSafePathSegment(segment: string, label: string): void {
  const valid =
    segment.length > 0 &&
    segment.length <= 100 &&
    !segment.includes('/') &&
    !segment.includes('\\') &&
    !segment.includes('\0') &&
    segment !== '.' &&
    segment !== '..';

  if (!valid) {
    throw new Error(`Invalid ${label} "${segment}".`);
  }
}

async function isEmptyOrMissing(dir: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(dir);
    return entries.length === 0;
  } catch (err: any) {
    if (err?.code === 'ENOENT') return true;
    throw err;
  }
}

/**
 * Create an organization repository that starts life with a project structure.
 *
 * The scaffold goes to GitHub directly, as one commit on dev, uat and main
 * (`provisionRepository`), the same way from the cloud as from a desktop. It
 * used to be written into the workspace and pushed with `gh repo create
 * --push`: that only ever worked on a desktop -- the cloud created an empty
 * repository and dropped the files -- and left `main` as the only branch.
 *
 * A desktop then clones it into the managed workspace, so an agent has a
 * working copy. A failed clone does not undo the repository; the result says
 * so and the project can be cloned again later.
 *
 * Everything that can fail cheaply (names, stack, shape, an occupied
 * workspace) is checked before GitHub is touched.
 */
/** The checks every scaffold makes before GitHub is touched, and where a desktop will clone it. */
async function prepareRepository(input: {
  projectKey: string;
  org: string;
  repoName: string;
  serviceName?: string;
}): Promise<{ repoName: string; org: string; serviceName: string; workspaceDir?: string }> {
  const { projectKey, org } = input;
  const repoName = normalizeRepoName(input.repoName);

  if (!org?.trim()) {
    throw new Error('An organization is required. Alpha does not create personal repositories.');
  }

  assertValidRepoName(repoName);
  assertSafePathSegment(projectKey, 'project key');
  assertSafePathSegment(org.trim(), 'organization');

  const serviceName = normalizeRepoName(input.serviceName) || repoName;
  // Same resolver the clone path uses, so both land under one allowlisted root.
  // Only a desktop keeps a working copy.
  const workspaceDir = IS_DESKTOP ? (ensureWorkspacesRoot(), projectRepoPath(projectKey, repoName)) : undefined;

  if (workspaceDir && !(await isEmptyOrMissing(workspaceDir))) {
    throw new Error(
      `A workspace already exists at ${workspaceDir}. Move or delete it before creating this repository.`
    );
  }
  return { repoName, org: org.trim(), serviceName, ...(workspaceDir ? { workspaceDir } : {}) };
}

/** Push the scaffold as one commit on dev, uat and main, then clone it on a desktop. */
async function provisionAndClone(input: {
  org: string;
  repoName: string;
  serviceName: string;
  visibility: 'private' | 'public';
  description?: string;
  files: ScaffoldFile[];
  requiredChecks: string[];
  workspaceDir?: string;
}) {
  const { org, repoName, serviceName, visibility, description, files, requiredChecks, workspaceDir } = input;
  let repo;
  try {
    repo = await provisionRepository({
      org,
      name: repoName,
      visibility,
      files,
      message: `chore: scaffold ${serviceName}`,
      requiredChecks,
      ...(description ? { description } : {})
    });
  } catch (err: any) {
    logError(`Scaffold failed for ${org}/${repoName}: ${err?.message ?? err}`);
    throw err;
  }

  let localPath: string | undefined;
  let cloneError: string | undefined;
  if (workspaceDir) {
    try {
      localPath = await githubService.cloneRepository(repo.nameWithOwner, path.dirname(workspaceDir));
    } catch (err: any) {
      cloneError = err?.message ?? String(err);
      logError(`Created ${repo.nameWithOwner} but could not clone it into ${workspaceDir}: ${cloneError}`);
    }
  }

  logInfo(`Scaffolded ${repo.nameWithOwner} (${files.length} files)${localPath ? ` at ${localPath}` : ''}`);
  return { repo, ...(localPath ? { localPath } : {}), ...(cloneError ? { cloneError } : {}) };
}

/**
 * Hosting at scaffold time is best-effort: the repository is real and already
 * pushed, so a failure is reported, not thrown -- throwing would read as "the
 * scaffold failed" for a repository that exists and can have hosting retried
 * on its project page.
 */
async function hostingOrUnavailable(
  nameWithOwner: string,
  stack: CanonicalStack,
  partner: string | undefined,
  workspaceId: string | undefined,
  app?: MonorepoAppId
): Promise<HostingStatus> {
  try {
    return await runHostingSetup(nameWithOwner, stack, partner, workspaceId, app);
  } catch (err: any) {
    logError(`Hosting setup failed for ${nameWithOwner}${app ? ` (${app})` : ''}:`, err?.message ?? err);
    return unavailableHostingStatus(nameWithOwner, roleForStack(stack), platformForStack(stack), err?.message ?? String(err), partner ?? null);
  }
}

export async function createScaffoldedRepository(
  input: CreateScaffoldedRepoInput
): Promise<CreateScaffoldedRepoResult> {
  const { visibility = 'private', stack, repoShape = 'standalone', includeDocker = false, description } = input;
  const { repoName, org, serviceName, workspaceDir } = await prepareRepository(input);

  // Build before touching GitHub, so an unsupported stack or shape fails
  // without creating anything.
  const canonicalStack = normalizeProjectStack(stack);
  const scaffold = buildProjectScaffold({
    serviceName,
    stack: canonicalStack,
    repoShape,
    includeDocker,
    ...(description ? { description } : {})
  });
  // Also before GitHub: a repository that cannot get its CI is not created.
  const ci = await buildCiWorkflows({ stack: canonicalStack });
  const hostingRequested = input.deploy !== false;
  const files = withCi(scaffold, ci, hostingRequested);

  const { repo, localPath, cloneError } = await provisionAndClone({
    org,
    repoName,
    serviceName,
    visibility,
    ...(description ? { description } : {}),
    files,
    requiredChecks: ci.requiredChecks,
    ...(workspaceDir ? { workspaceDir } : {})
  });

  const hosting = hostingRequested
    ? await hostingOrUnavailable(repo.nameWithOwner, canonicalStack, input.partnerNameWithOwner, input.workspaceId)
    : undefined;

  return {
    url: repo.url,
    nameWithOwner: repo.nameWithOwner,
    ...(localPath ? { localPath } : {}),
    files: files.map(f => f.path),
    commitSha: repo.commitSha,
    branches: repo.branches,
    protectedBranches: repo.protectedBranches,
    ...(repo.protectionUnavailable ? { protectionUnavailable: repo.protectionUnavailable } : {}),
    ...(cloneError ? { cloneError } : {}),
    deployTarget: ci.deployTarget,
    requiredSecrets: ci.requiredSecrets,
    deployVariable: ci.deployVariable,
    ciSource: ci.source,
    ...(hosting ? { hosting } : {})
  };
}

export interface CreatePairedProjectInput
  extends Omit<CreateScaffoldedRepoInput, 'stack' | 'repoShape' | 'partnerNameWithOwner'> {
  /** react or nextjs, for `<repoName>-fe`. */
  frontendStack: string;
  /** nodejs or nestjs, for `<repoName>-be`. */
  backendStack: string;
}

/**
 * A paired project: `<name>-be` and `<name>-fe`, each a standalone repository
 * with its own CI and deploy target.
 *
 * The backend is created first. If the frontend then fails, the backend is
 * deleted again, so a paired project is created whole or not at all.
 */
export async function createPairedProject(input: CreatePairedProjectInput): Promise<CreateScaffoldedRepoResult[]> {
  const frontend = normalizeProjectStack(input.frontendStack);
  const backend = normalizeProjectStack(input.backendStack);
  if (frontend !== 'react' && frontend !== 'nextjs') {
    throw new Error(`Invalid frontend stack "${input.frontendStack}". Use react or nextjs.`);
  }
  if (backend !== 'nodejs' && backend !== 'nestjs') {
    throw new Error(`Invalid backend stack "${input.backendStack}". Use nodejs or nestjs.`);
  }

  const { frontendStack: _fe, backendStack: _be, ...common } = input;
  const base = normalizeRepoName(input.repoName);
  const be = await createScaffoldedRepository({
    ...common,
    repoName: `${base}-be`,
    serviceName: `${base}-be`,
    stack: backend,
    repoShape: 'standalone'
  });
  try {
    const fe = await createScaffoldedRepository({
      ...common,
      repoName: `${base}-fe`,
      serviceName: `${base}-fe`,
      stack: frontend,
      repoShape: 'standalone',
      // The backend now exists, so the frontend's own hosting setup can wire
      // its API URL straight to it and, in turn, put the frontend's URL onto
      // the backend's CORS_ORIGINS -- the "PUT CORS on Render" step of the
      // paired order happens inside this one call.
      partnerNameWithOwner: be.nameWithOwner
    });
    return [be, fe];
  } catch (err) {
    try {
      await githubApi().delete(`/repos/${be.nameWithOwner}`);
      if (be.localPath) await fs.rm(be.localPath, { recursive: true, force: true });
    } catch (cleanup) {
      logError(`Could not remove ${be.nameWithOwner} after its frontend failed; remove it by hand:`, (cleanup as Error).message);
    }
    throw err;
  }
}

// ─── Monorepo ───────────────────────────────────────────────────────────────

export interface CreateMonorepoInput
  extends Omit<CreateScaffoldedRepoInput, 'stack' | 'repoShape' | 'partnerNameWithOwner' | 'serviceName'> {
  /** One of MONOREPO_FRONTEND_STACKS (react), for `apps/web`. */
  frontendStack: string;
  /** One of MONOREPO_BACKEND_STACKS (nodejs), for `apps/api`. */
  backendStack: string;
}

/** One app of a created monorepo: where it is, what it is, and its hosting. */
export interface CreateMonorepoAppResult {
  id: MonorepoAppId;
  role: 'frontend' | 'backend';
  stack: CanonicalStack;
  path: string;
  deployTarget: DeployTarget;
  /** Absent when `deploy: false`. */
  hosting?: HostingStatus;
}

export interface CreateMonorepoResult extends Omit<CreateScaffoldedRepoResult, 'deployTarget' | 'hosting'> {
  shape: 'monorepo';
  /** null: each app deploys to its own platform -- see `apps`. */
  deployTarget: null;
  /** Backend first, the order hosting was set up in. */
  apps: CreateMonorepoAppResult[];
}

/** The monorepo README's CI section: two workflows, two platforms, one branch flow. */
function monorepoCiReadmeSection(sources: { web: string; api: string }, hostingRequested: boolean): string {
  const code = (text: string) => '`' + text + '`';
  return [
    '',
    '## CI/CD',
    '',
    `${code('.github/workflows/ci-api.yml')} (API CI, from ${code(sources.api)}) and ${code('.github/workflows/ci-web.yml')} ` +
      `(Web CI, from ${code(sources.web)}) run each app's unit tests with coverage, lint and security scan, in its own ` +
      `folder, on every push and pull request to ${code('dev')}, ${code('uat')} and ${code('main')}. Both run on every ` +
      'change, so a pull request is always checked against both apps.',
    '',
    `Work lands on ${code('dev')}, is promoted to ${code('uat')}, then to ${code('main')}, by pull request only.`,
    '',
    hostingRequested
      ? `Hosting is set up automatically by Alpha: the API on **Render** from ${code(MONOREPO_APPS.api.path)}, the frontend ` +
        `on **Vercel** from ${code(MONOREPO_APPS.web.path)}, each pointed at the other. See status, URLs and deploys from ` +
        'this repository’s project in Alpha.'
      : 'Hosting was not set up for this repository. Alpha can set it up from this repository’s project page.',
    ''
  ].join('\n');
}

/**
 * One repository holding a frontend in `apps/web` and a backend in `apps/api`.
 *
 * The same steps as a single repository -- everything that can fail cheaply
 * first, then one commit on dev/uat/main, a desktop clone, and hosting -- with
 * two apps where a single repository has one. Hosting runs backend first, so
 * the frontend's setup can read the API's URLs, and each app's setup points
 * the other at itself: the API URL into the frontend, the frontend's origins
 * into the API's CORS.
 */
export async function createMonorepoRepository(input: CreateMonorepoInput): Promise<CreateMonorepoResult> {
  const { visibility = 'private', includeDocker = false, description } = input;
  const { repoName, org, serviceName, workspaceDir } = await prepareRepository(input);

  // Validates both stacks, so a wrong pair fails before GitHub is touched.
  const scaffold = buildMonorepoScaffold({
    serviceName,
    frontendStack: input.frontendStack,
    backendStack: input.backendStack,
    includeDocker,
    ...(description ? { description } : {})
  });
  const stacks: Record<MonorepoAppId, CanonicalStack> = {
    web: input.frontendStack as CanonicalStack,
    api: input.backendStack as CanonicalStack
  };
  const ci = await buildMonorepoCiWorkflows({ frontendStack: stacks.web, backendStack: stacks.api });
  const hostingRequested = input.deploy !== false;
  const files = [
    ...scaffold.map(file =>
      file.path === 'README.md' ? { ...file, content: file.content + monorepoCiReadmeSection(ci.sources, hostingRequested) } : file
    ),
    ...ci.files
  ];

  const { repo, localPath, cloneError } = await provisionAndClone({
    org,
    repoName,
    serviceName,
    visibility,
    ...(description ? { description } : {}),
    files,
    requiredChecks: ci.requiredChecks,
    ...(workspaceDir ? { workspaceDir } : {})
  });

  const apps: CreateMonorepoAppResult[] = [];
  for (const id of MONOREPO_APP_IDS) {
    const stack = stacks[id];
    const hosting = hostingRequested
      ? await hostingOrUnavailable(repo.nameWithOwner, stack, undefined, input.workspaceId, id)
      : undefined;
    apps.push({
      id,
      role: MONOREPO_APPS[id].role,
      stack,
      path: MONOREPO_APPS[id].path,
      deployTarget: platformForStack(stack),
      ...(hosting ? { hosting } : {})
    });
  }

  return {
    shape: 'monorepo',
    url: repo.url,
    nameWithOwner: repo.nameWithOwner,
    ...(localPath ? { localPath } : {}),
    files: files.map(f => f.path),
    commitSha: repo.commitSha,
    branches: repo.branches,
    protectedBranches: repo.protectedBranches,
    ...(repo.protectionUnavailable ? { protectionUnavailable: repo.protectionUnavailable } : {}),
    ...(cloneError ? { cloneError } : {}),
    deployTarget: null,
    requiredSecrets: [],
    deployVariable: null,
    ciSource: ci.sources.web,
    apps
  };
}
