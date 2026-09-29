import fs from 'node:fs/promises';
import path from 'node:path';

import { ALPHA_CLOUD_API, IS_CLOUD, IS_DESKTOP } from '../config/env.js';
import { ensureWorkspacesRoot, projectRepoPath } from './workspaceService.js';
import { logInfo, logError } from '../utils/logger.js';
import { githubService } from './githubService.js';
import { githubApi } from './githubApi.js';
import { provisionRepository } from './githubRepoProvisioning.js';
import { buildCiWorkflows, type CiWorkflowPlan, type DeployTarget } from './ciWorkflows.js';
import { buildProjectScaffold, normalizeProjectStack, type CanonicalStack, type ScaffoldFile } from './scaffoldBuilder.js';
import { cloudRequest } from './cloudWorkspaces.js';
import { platformForStack, roleForStack, setUpHosting, unavailableHostingStatus, type HostingStatus } from './hosting/hostingService.js';

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
  workspaceId?: string
): Promise<HostingStatus> {
  if (IS_CLOUD) {
    return setUpHosting({ repo: nameWithOwner, stackHint: stack, ...(partner ? { partnerHint: partner } : {}) });
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
    body: { stack, ...(partner ? { partner } : {}) },
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
 * GitHub repository names allow letters, digits, '.', '_' and '-'. Rejecting
 * rather than silently rewriting: a repo whose name is not the one that was
 * typed is worse than an error explaining why.
 */
function assertValidRepoName(name: string): void {
  const valid =
    /^[A-Za-z0-9._-]{1,100}$/.test(name) &&
    !name.startsWith('.') &&
    !name.startsWith('-') &&
    name !== '.' &&
    name !== '..';

  if (!valid) {
    throw new Error(
      `Invalid repository name "${name}". Use letters, numbers, dots, hyphens and underscores.`
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
export async function createScaffoldedRepository(
  input: CreateScaffoldedRepoInput
): Promise<CreateScaffoldedRepoResult> {
  const {
    projectKey,
    repoName,
    org,
    visibility = 'private',
    stack,
    repoShape = 'standalone',
    includeDocker = false,
    description
  } = input;

  if (!org?.trim()) {
    throw new Error('An organization is required. Alpha does not create personal repositories.');
  }

  assertValidRepoName(repoName);
  assertSafePathSegment(projectKey, 'project key');
  assertSafePathSegment(org.trim(), 'organization');

  const serviceName = input.serviceName?.trim() || repoName;
  // Same resolver the clone path uses, so both land under one allowlisted root.
  // Only a desktop keeps a working copy.
  const workspaceDir = IS_DESKTOP ? (ensureWorkspacesRoot(), projectRepoPath(projectKey, repoName)) : undefined;

  if (workspaceDir && !(await isEmptyOrMissing(workspaceDir))) {
    throw new Error(
      `A workspace already exists at ${workspaceDir}. Move or delete it before creating this repository.`
    );
  }

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

  let repo;
  try {
    repo = await provisionRepository({
      org: org.trim(),
      name: repoName,
      visibility,
      files,
      message: `chore: scaffold ${serviceName}`,
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

  let hosting: HostingStatus | undefined;
  if (hostingRequested) {
    try {
      hosting = await runHostingSetup(repo.nameWithOwner, canonicalStack, input.partnerNameWithOwner, input.workspaceId);
    } catch (err: any) {
      // Hosting is best-effort at scaffold time: the repository above is
      // real and already pushed. A hosting failure is reported, not thrown --
      // throwing here would read as "the scaffold failed" for a repository
      // that in fact exists and can have hosting retried on its project page.
      logError(`Hosting setup failed for ${repo.nameWithOwner}:`, err?.message ?? err);
      hosting = unavailableHostingStatus(
        repo.nameWithOwner,
        roleForStack(canonicalStack),
        platformForStack(canonicalStack),
        err?.message ?? String(err),
        input.partnerNameWithOwner ?? null
      );
    }
  }

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
  const base = input.repoName;
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
