import fs from 'node:fs';
import path from 'node:path';

import { WORKSPACES_DIR } from '../config/env.js';
import { sqliteService } from './sqliteService.js';
import { logInfo } from '../utils/logger.js';

/**
 * Managed working copies.
 *
 * Every repository Alpha clones or scaffolds lands under one root. That is
 * what lets a single allowlist entry cover all of them — `isPathAllowed`
 * matches on prefix, so granting the root grants everything beneath it and
 * nothing outside.
 *
 * The destination is always computed here, never supplied by a caller. An
 * agent naming its own path is how a clone ends up somewhere Alpha cannot see,
 * or somewhere it should not be writing at all.
 */

/**
 * Guard a value used as one path segment.
 *
 * These arrive from tool calls made by a model, so '..' or a separator would
 * place a clone outside the managed root entirely.
 */
function assertSegment(segment: string, label: string): string {
  const valid =
    segment.length > 0 &&
    segment.length <= 100 &&
    !segment.includes('/') &&
    !segment.includes('\\') &&
    !segment.includes('\0') &&
    segment !== '.' &&
    segment !== '..';

  if (!valid) throw new Error(`Invalid ${label} "${segment}".`);
  return segment;
}

/** Create the workspaces root and put it on the allowlist, once. */
export function ensureWorkspacesRoot(): string {
  fs.mkdirSync(WORKSPACES_DIR, { recursive: true });

  if (!sqliteService.isPathAllowed(WORKSPACES_DIR)) {
    sqliteService.addAllowedPath(WORKSPACES_DIR, 'Alpha managed workspaces');
    logInfo(`Allowlisted managed workspace root: ${WORKSPACES_DIR}`);
  }

  return WORKSPACES_DIR;
}

/**
 * Where a cloned remote repository lives: `<root>/<owner>/<repo>`.
 *
 * Keyed by owner and name rather than by project, because a clone can be asked
 * for from a chat that belongs to no project. Deterministic, so asking twice
 * addresses the same directory instead of accumulating copies.
 */
export function clonePathFor(ownerRepo: string): { dir: string; owner: string; repo: string } {
  const [owner, repo] = ownerRepo.split('/');
  assertSegment(owner ?? '', 'repository owner');
  assertSegment(repo ?? '', 'repository name');

  return { dir: path.join(WORKSPACES_DIR, owner, repo), owner, repo };
}

/** Where a repository created for a project lives: `<root>/<projectKey>/<repo>`. */
export function projectRepoPath(projectKey: string, repoName: string): string {
  assertSegment(projectKey, 'project key');
  assertSegment(repoName, 'repository name');
  return path.join(WORKSPACES_DIR, projectKey, repoName);
}

/** True when the directory exists and holds a git repository. */
export function isExistingCheckout(dir: string): boolean {
  return fs.existsSync(path.join(dir, '.git'));
}

/**
 * A directory is safe to clone into when it is absent or empty.
 *
 * An existing checkout is reported separately by the caller so it can refresh
 * rather than fail — but a non-empty directory that is not a checkout is left
 * strictly alone, because Alpha did not put it there.
 */
export function isEmptyOrMissing(dir: string): boolean {
  try {
    return fs.readdirSync(dir).length === 0;
  } catch (err: any) {
    if (err?.code === 'ENOENT') return true;
    throw err;
  }
}
