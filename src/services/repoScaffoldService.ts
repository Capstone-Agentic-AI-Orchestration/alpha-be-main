import fs from 'node:fs/promises';
import path from 'node:path';

import { WORKSPACES_DIR } from '../config/env.js';
import { initRepoWithCommit } from '../utils/gitUtils.js';
import { logInfo, logError } from '../utils/logger.js';
import { githubService } from './githubService.js';
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
  localPath: string;
  files: string[];
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
 * The scaffold is written into the managed workspace and pushed from there, so
 * the directory left behind is both the thing that was pushed and a working
 * copy ready for an agent — no clone step for repositories Alpha created.
 *
 * Ordering matters: everything that can fail cheaply happens before the `gh`
 * call, so a failure leaves nothing on GitHub. There is no compensating delete
 * because there is nothing remote to compensate for.
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
  const workspaceDir = path.join(WORKSPACES_DIR, projectKey, repoName);

  if (!(await isEmptyOrMissing(workspaceDir))) {
    throw new Error(
      `A workspace already exists at ${workspaceDir}. Move or delete it before creating this repository.`
    );
  }

  // Build before touching the disk, so an unsupported stack or shape fails
  // without leaving a directory behind.
  const files = buildProjectScaffold({
    serviceName,
    stack: normalizeProjectStack(stack),
    repoShape,
    includeDocker,
    ...(description ? { description } : {})
  });

  await fs.mkdir(workspaceDir, { recursive: true });

  try {
    for (const file of files) {
      const target = path.join(workspaceDir, file.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, file.content, 'utf8');
    }

    await initRepoWithCommit(workspaceDir, `chore: scaffold ${serviceName}`);

    const repo = await githubService.createRepository({
      name: repoName,
      org: org.trim(),
      visibility,
      sourceDir: workspaceDir,
      ...(description ? { description } : {})
    });

    logInfo(`Scaffolded ${repo.nameWithOwner} (${files.length} files) at ${workspaceDir}`);

    return {
      url: repo.url,
      nameWithOwner: repo.nameWithOwner,
      localPath: workspaceDir,
      files: files.map(f => f.path)
    };
  } catch (err: any) {
    // Remove only what this function created. Leaving a half-written directory
    // would trip the emptiness guard above and block every retry, and nothing
    // else references it yet. GitHub is never touched here — if the repository
    // was in fact created, the next attempt reports the name collision, which
    // is the accurate thing to tell someone.
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
    logError(`Scaffold failed for ${org}/${repoName}: ${err?.message ?? err}`);
    throw err;
  }
}
