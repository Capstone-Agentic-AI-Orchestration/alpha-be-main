import fs from 'node:fs';
import path from 'node:path';

import { IS_CLOUD, IS_DESKTOP, WORKSPACES_DIR } from '../config/env.js';
import type { Project } from '../models/index.js';
import { projectStore } from '../store/stores.js';
import { logError, logInfo } from '../utils/logger.js';
import { cloudRequest, usesCloudDirectory } from './cloudWorkspaces.js';
import { githubApi, GitHubApiError } from './githubApi.js';
import { parseRepoRef } from './githubIssueMapping.js';
import { tearDownHosting, type HostingTeardown } from './hosting/hostingService.js';
import { clonePathFor, projectRepoPath } from './workspaceService.js';

/**
 * Deleting one of a project's repositories, and everything Alpha made for it.
 *
 * In an order that never strands anything: first everything is checked
 * (the caller is an admin of the repository on GitHub), then hosting is
 * removed, and only once hosting is fully gone is the repository deleted.
 * The other way round, a failure after the repository went would leave
 * Render services and a Vercel project that nothing could reach through
 * Alpha any more, since removing hosting is authorized against the
 * repository itself.
 */

export class RepoDeletionError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** What hosting removal got through, when it was the step that stopped. */
    readonly hosting?: HostingTeardown
  ) {
    super(message);
    this.name = 'RepoDeletionError';
  }
}

export interface RepoDeletionResult {
  repo: string;
  hosting: HostingTeardown;
  /** `already_gone` when GitHub had no such repository by the time it was deleted. */
  github: 'deleted' | 'already_gone';
  /** Alpha's own working copies on this machine; never a folder someone attached by hand. */
  localCopies: { removed: string[]; failed: string[] };
  project: Project | null;
}

const HOSTING_TIMEOUT_MS = 180_000;

/** Step 1: the caller's own GitHub rights, before anything is touched. */
async function assertRepoAdmin(repo: string): Promise<void> {
  try {
    const info = await githubApi().get<{ permissions?: { admin?: boolean } }>(`/repos/${repo}`);
    if (!info.permissions?.admin) {
      throw new RepoDeletionError(`Deleting ${repo} needs admin rights on it on GitHub. Nothing was deleted.`, 403);
    }
  } catch (err) {
    if (err instanceof GitHubApiError && (err.status === 404 || err.status === 403)) {
      throw new RepoDeletionError(`${repo} was not found on GitHub, or you cannot see it. Nothing was deleted.`, 404);
    }
    throw err;
  }
}

/** Step 2: hosting, in the cloud -- the only place that holds platform credentials. */
async function removeHosting(repo: string, workspaceId: string): Promise<HostingTeardown> {
  if (IS_CLOUD) return tearDownHosting(repo);
  // Hosting only ever runs in the cloud; a desktop with none configured has none.
  if (!usesCloudDirectory()) return { repo, removed: [], kept: [], failed: [] };

  const [owner, name] = repo.split('/');
  const answer = await cloudRequest<HostingTeardown & { error?: string }>(
    `/hosting/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
    { method: 'DELETE', workspaceId, timeoutMs: HOSTING_TIMEOUT_MS }
  );
  if (answer.status >= 200 && answer.status < 300) return answer.body;
  throw new RepoDeletionError(
    `Could not remove the hosting of ${repo}: ${answer.body?.error ?? `the cloud answered ${answer.status}`}. The repository was not deleted.`,
    answer.status === 403 ? 403 : 502
  );
}

/** Step 3: the repository itself. */
async function deleteOnGitHub(repo: string): Promise<'deleted' | 'already_gone'> {
  try {
    await githubApi().delete(`/repos/${repo}`);
    return 'deleted';
  } catch (err) {
    if (err instanceof GitHubApiError && err.status === 404) return 'already_gone';
    if (err instanceof GitHubApiError && err.status === 403) {
      throw new RepoDeletionError(
        `GitHub refused to delete ${repo}: ${err.message}. The organization may only let owners delete repositories. ` +
          'Its hosting has already been removed.',
        403
      );
    }
    throw err;
  }
}

/** A directory inside Alpha's managed workspaces root, and not the root itself. */
function isManagedDir(dir: string): boolean {
  const relative = path.relative(WORKSPACES_DIR, path.resolve(dir));
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** Step 5 (desktop): the working copies Alpha made, so the name can be used again. */
async function removeLocalCopies(project: Project, repo: string, recordedPaths: string[]): Promise<RepoDeletionResult['localCopies']> {
  const out = { removed: [] as string[], failed: [] as string[] };
  if (!IS_DESKTOP) return out;

  const name = repo.split('/')[1];
  const candidates = new Set<string>();
  for (const recorded of recordedPaths) candidates.add(path.resolve(recorded));
  try {
    candidates.add(path.resolve(projectRepoPath(project.key, name)));
    candidates.add(path.resolve(clonePathFor(repo).dir));
  } catch {
    /* a key or name that is not a valid path segment has no managed copy */
  }

  for (const dir of candidates) {
    if (!isManagedDir(dir) || !fs.existsSync(dir)) continue;
    try {
      await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 3 });
      out.removed.push(dir);
    } catch (err) {
      logError(`Could not remove the working copy ${dir}; remove it by hand:`, (err as Error).message);
      out.failed.push(dir);
    }
  }
  return out;
}

const isThisRepo = (repo: string) => (resource: { type: string; pathOrUrl: string }) => {
  if (resource.type !== 'github_repo') return false;
  const ref = parseRepoRef(resource.pathOrUrl);
  return Boolean(ref) && `${ref!.owner}/${ref!.repo}`.toLowerCase() === repo.toLowerCase();
};

export async function deleteProjectRepository(input: {
  workspaceId: string;
  project: Project;
  repo: string;
}): Promise<RepoDeletionResult> {
  const { workspaceId, project, repo } = input;

  await assertRepoAdmin(repo);

  const hosting = await removeHosting(repo, workspaceId);
  if (hosting.failed.length) {
    throw new RepoDeletionError(
      `Some of the hosting of ${repo} could not be removed (${hosting.failed.join('; ')}), so the repository was not deleted. ` +
        'Try again once the platform recovers.',
      502,
      hosting
    );
  }

  const github = await deleteOnGitHub(repo);

  const matches = isThisRepo(repo);
  const recordedPaths = (project.resources ?? []).filter(matches).flatMap(r => (r.localPath ? [r.localPath] : []));
  const updated = await projectStore().update(workspaceId, project.id, {
    resources: (project.resources ?? []).filter(resource => !matches(resource))
  });

  const localCopies = await removeLocalCopies(project, repo, recordedPaths);

  logInfo(`Deleted ${repo} (${github}) from project ${project.key}; hosting removed: ${hosting.removed.join(', ') || 'none'}`);
  return { repo, hosting, github, localCopies, project: updated };
}
