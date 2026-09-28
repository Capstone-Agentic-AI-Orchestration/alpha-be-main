import fs from 'node:fs/promises';
import path from 'node:path';

import { IS_DESKTOP } from '../config/env.js';
import { ensureWorkspacesRoot, projectRepoPath } from './workspaceService.js';
import { logInfo, logError } from '../utils/logger.js';
import { githubService } from './githubService.js';
import { provisionRepository } from './githubRepoProvisioning.js';
import { buildProjectScaffold, normalizeProjectStack } from './scaffoldBuilder.js';

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
  const files = buildProjectScaffold({
    serviceName,
    stack: normalizeProjectStack(stack),
    repoShape,
    includeDocker,
    ...(description ? { description } : {})
  });

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

  return {
    url: repo.url,
    nameWithOwner: repo.nameWithOwner,
    ...(localPath ? { localPath } : {}),
    files: files.map(f => f.path),
    commitSha: repo.commitSha,
    branches: repo.branches,
    protectedBranches: repo.protectedBranches,
    ...(repo.protectionUnavailable ? { protectionUnavailable: repo.protectionUnavailable } : {}),
    ...(cloneError ? { cloneError } : {})
  };
}
