import fs from 'node:fs';
import path from 'node:path';

import { IS_CLOUD, WORKSPACES_DIR } from '../config/env.js';
import { sqliteService } from './sqliteService.js';
import { Project } from '../models/index.js';
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
 * The directory an agent should work in for this project.
 *
 * Lifted out of `runnerService` so a chat turn can answer the same question a
 * run does. They had different answers: a run resolved the project's working
 * copy, while a chat was pinned to the workspaces root — so an agent asked to
 * review the code it had just edited in a run could not see it, and said so.
 *
 * A managed checkout wins over a hand-attached folder. If Alpha cloned or
 * scaffolded the repository, that copy is the one it knows how to refresh.
 *
 * Returns null rather than guessing. This used to fall back to
 * `path.resolve('..')` — the directory above the daemon, which is Alpha's own
 * source tree — so a project attached only to a GitHub URL ran its agent
 * inside Alpha itself. A project with nothing checked out has no workspace,
 * and inventing one is how an agent reads or edits the wrong repository.
 */
export interface ProjectWorkspace {
  dir: string;
  /** True when Alpha cloned it; false when the user attached it by hand. */
  managed: boolean;
}

export function resolveProjectWorkspace(
  project: Pick<Project, 'id' | 'name' | 'resources'>
): ProjectWorkspace | null {
  /**
   * What this machine was told, first.
   *
   * A binding is the developer's own answer for this project -- a folder they
   * chose, or a clone Alpha made here -- and the project row cannot carry it:
   * the row is the team's, and the cloud drops local paths on write. Before
   * bindings, a shared project had nowhere to say where its code was on any
   * particular laptop.
   */
  if (!IS_CLOUD && project.id) {
    const binding = sqliteService.getProjectBinding(project.id);
    if (binding) return { dir: path.resolve(binding.localDir), managed: binding.isManaged };
  }

  const resources = project.resources ?? [];
  const managed = resources.find(r => r.type === 'github_repo' && r.localPath);
  const attached = resources.find(r => r.type === 'local_path' || r.type === 'local_dir');

  const dir = managed?.localPath
    ? path.resolve(managed.localPath)
    : attached
      ? path.resolve(attached.pathOrUrl)
      : null;

  if (!dir) return null;
  return { dir, managed: Boolean(managed?.localPath) };
}

/**
 * Record consent for a hand-attached folder.
 *
 * Managed checkouts need nothing: the workspace root is allowlisted once and
 * `isPathAllowed` matches on prefix. A folder the user chose in the UI is
 * registered because choosing it is the explicit act of consent — but only a
 * path that came from the project, never one this code computed.
 */
export function allowAttachedWorkspace(workspace: ProjectWorkspace, projectName: string): void {
  if (workspace.managed) return;
  if (sqliteService.isPathAllowed(workspace.dir)) return;
  sqliteService.addAllowedPath(workspace.dir, projectName);
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
