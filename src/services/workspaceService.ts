import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { IS_CLOUD, WORKSPACES_DIR } from '../config/env.js';
import { sqliteService } from './sqliteService.js';
import { Project } from '../models/index.js';
import { logInfo } from '../utils/logger.js';
import { parseRepoRef, repoForProject, reposForProject } from './githubIssueMapping.js';

/** `owner/name` of a repository resource, or null. */
function parseRepoName(pathOrUrl: string): string | null {
  const ref = parseRepoRef(pathOrUrl);
  return ref ? `${ref.owner}/${ref.repo}` : null;
}

/**
 * `owner/name` of the repository any github.com URL points into -- a pull
 * request, an issue, a file -- or null. What a run's or a call's work is
 * about, for `resolveProjectWorkspace`.
 */
export function repoOfGitHubUrl(url: string | null | undefined): string | null {
  const match = /^https?:\/\/github\.com\/([^/]+)\/([^/#?]+)/i.exec(url ?? '');
  return match ? `${match[1]}/${match[2].replace(/\.git$/i, '')}` : null;
}

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

/**
 * A deterministic, private workspace for one project build.
 *
 * The directory is derived from opaque IDs rather than project or repository
 * names, so concurrent builds never share a checkout and untrusted text never
 * becomes a path segment.
 */
export function projectRunWorkspacePath(projectId: string, runId: string): string {
  if (!projectId || !runId) throw new Error('A project and run id are required for an isolated build workspace.');
  const projectKey = crypto.createHash('sha256').update(projectId).digest('hex').slice(0, 20);
  const runKey = crypto.createHash('sha256').update(runId).digest('hex').slice(0, 24);
  return path.join(ensureWorkspacesRoot(), '_runs', projectKey, runKey);
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
  /** The repository the folder is a checkout of, when that is known. */
  repo?: string;
}

const sameRepo = (a: string | null | undefined, b: string | null | undefined) =>
  Boolean(a && b) && a!.toLowerCase() === b!.toLowerCase();

/**
 * `repo`: the one repository the work is about -- the issue's, the pull
 * request's. Then the answer is that repository's checkout or nothing: a run
 * on the frontend's issue must never land in the backend's folder because
 * that is the one this machine happens to have.
 *
 * Without it, the first of the project's repositories this machine has.
 */
export function resolveProjectWorkspace(
  project: Pick<Project, 'id' | 'name' | 'resources'>,
  repo?: string | null
): ProjectWorkspace | null {
  const repos = reposForProject(project as Project);
  const first = repoForProject(project as Project);
  // Strict only about a repository the project has. Any other -- a project
  // worked from one hand-attached folder, a pull request from elsewhere --
  // has no checkout of its own to insist on, so the default answers.
  if (repo && !repos.some(candidate => sameRepo(candidate, repo))) repo = null;

  /**
   * What this machine was told, first.
   *
   * A binding is the developer's own answer -- a folder they chose, or a
   * clone Alpha made here -- and the project row cannot carry it: the row is
   * the team's, and the cloud drops local paths on write. One per
   * repository; a project binding from before those is its first
   * repository's, which is the one it was checked against.
   */
  if (!IS_CLOUD && project.id) {
    const bindings = sqliteService.listRepoBindings(project.id);
    const legacy = sqliteService.getProjectBinding(project.id);
    const bound = (wanted: string): ProjectWorkspace | null => {
      const row = bindings.find(b => sameRepo(b.repo, wanted));
      if (row) return { dir: path.resolve(row.localDir), managed: row.isManaged, repo: wanted };
      if (legacy && sameRepo(first, wanted)) return { dir: path.resolve(legacy.localDir), managed: legacy.isManaged, repo: wanted };
      return null;
    };

    if (repo) {
      const found = bound(repo);
      if (found) return found;
    } else {
      for (const candidate of repos) {
        const found = bound(candidate);
        if (found) return found;
      }
      if (legacy) return { dir: path.resolve(legacy.localDir), managed: legacy.isManaged };
    }
  }

  const resources = project.resources ?? [];
  if (repo) {
    // A checkout Alpha made when it created the repository here.
    const made = resources.find(
      r => r.type === 'github_repo' && r.localPath && sameRepo(parseRepoName(r.pathOrUrl), repo)
    );
    return made?.localPath ? { dir: path.resolve(made.localPath), managed: true, repo } : null;
  }

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
