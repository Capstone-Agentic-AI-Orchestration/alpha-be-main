import fs from 'node:fs';
import path from 'node:path';

import type { LocalProjectBinding, Project } from '../models/index.js';
import { checkWorkspace } from '../controllers/workspaceValidation.js';
import { githubService } from './githubService.js';
import { repoForProject, reposForProject } from './githubIssueMapping.js';
import { sqliteService } from './sqliteService.js';
import { logInfo } from '../utils/logger.js';
import { clonePathFor, isEmptyOrMissing, isExistingCheckout, resolveProjectWorkspace } from './workspaceService.js';
import { checkoutStatus, type CheckoutStatus } from './localCheckout.js';
import { ensureProjectFolder, originOf } from './projectFolders.js';

/**
 * Binding a project to a folder on this machine.
 *
 * The project is the team's; the folder is this developer's. They used to be
 * the same row -- a `local_path` resource on the project -- which worked while
 * every board was one person's and breaks the moment a board is shared: the
 * cloud drops local paths on write, and a path from one laptop means nothing
 * on another. So the binding lives on the machine it describes, keyed by the
 * project's shared id.
 *
 * ## What is checked before it is saved
 *
 * That the folder exists, is a git checkout, and is not a folder of
 * repositories (`checkWorkspace`, which was written after a run edited files
 * in a directory holding three repositories and could not branch). And that
 * its `origin` is the project's repository -- binding the wrong checkout is
 * how an agent confidently edits another project, and the mistake is
 * invisible afterwards.
 */

export class BindingError extends Error {
  constructor(message: string, readonly reason: 'invalid_folder' | 'wrong_repository') {
    super(message);
    this.name = 'BindingError';
  }
}

export interface BoundProject extends LocalProjectBinding {
  /** The repository the folder's `origin` points at, when it has one. */
  ownerRepo?: string;
}


/**
 * The project's first folder on this machine: its first repository's that is
 * here, or a project binding from before per-repository ones. What the older
 * one-folder view of a project reads; `repositoryCheckouts` has them all.
 */
export function projectBinding(project: Project): LocalProjectBinding | null {
  const bindings = sqliteService.listRepoBindings(project.id);
  for (const repo of reposForProject(project)) {
    const found = bindings.find(b => b.repo === repo.toLowerCase());
    if (found) return found;
  }
  return sqliteService.getProjectBinding(project.id);
}

/**
 * Move a project binding from before per-repository bindings onto the
 * repository it was checked against -- the project's first. Nothing is lost:
 * the same folder, now under its repository's name. A project with no
 * repository keeps its project binding, since there is no repository to key
 * it by.
 */
export function migrateLegacyBinding(project: Project): void {
  const legacy = sqliteService.getProjectBinding(project.id);
  const first = repoForProject(project);
  if (!legacy || !first) return;
  if (!sqliteService.getRepoBinding(project.id, first)) {
    sqliteService.saveRepoBinding({
      projectId: project.id,
      repo: first,
      localDir: legacy.localDir,
      isManaged: legacy.isManaged,
      ...(legacy.activeBranch ? { activeBranch: legacy.activeBranch } : {})
    });
  }
  sqliteService.deleteProjectBinding(project.id);
}

/**
 * Point this machine at a folder for one of the project's repositories.
 *
 * Which one is read from the folder itself -- its `origin` -- so a developer
 * pastes wherever they cloned it and does not also have to say which half of
 * a pair it is. `repo`, when given, must agree. A folder whose origin is
 * none of the project's repositories is refused: binding the wrong checkout
 * is how an agent confidently edits another project.
 *
 * `managed` says Alpha put the code there itself (a clone it made), which is
 * what tells `resolveProjectWorkspace` it may refresh it.
 */
export async function bindProject(
  project: Project,
  localDir: unknown,
  { managed = false, repo }: { managed?: boolean; repo?: string } = {}
): Promise<BoundProject> {
  const check = checkWorkspace(localDir);
  if (!check.ok) throw new BindingError(check.detail ?? 'That folder cannot be used.', 'invalid_folder');

  const dir = path.resolve(String(localDir).trim());
  const inspection = await githubService.inspectLocalRepo(dir);
  const repos = reposForProject(project);
  const origin = inspection.ownerRepo;

  /**
   * A project with no repository attached is bound on the person's word --
   * there is nothing to check it against -- and as a whole.
   */
  if (repos.length === 0) {
    const saved = sqliteService.saveProjectBinding({
      projectId: project.id,
      localDir: dir,
      isManaged: managed,
      ...(inspection.branch ? { activeBranch: inspection.branch } : {})
    });
    allowFolder(dir, managed, project.name);
    logInfo(`Bound ${project.key || project.name} to ${dir}`);
    return { ...saved, ...(origin ? { ownerRepo: origin } : {}) };
  }

  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (repo && !repos.some(candidate => same(candidate, repo))) {
    throw new BindingError(`${repo} is not one of ${project.name}'s repositories.`, 'wrong_repository');
  }
  // Named, or read from the origin, or -- a folder with no origin -- the
  // only repository there is, on the person's word as before.
  const target = repo
    ? repos.find(candidate => same(candidate, repo))!
    : origin
      ? repos.find(candidate => same(candidate, origin))
      : repos.length === 1
        ? repos[0]
        : undefined;
  if (origin && (!target || !same(origin, target))) {
    throw new BindingError(
      `${dir} is a checkout of ${origin}, not ${target ?? `one of this project's repositories (${repos.join(', ')})`}.`,
      'wrong_repository'
    );
  }
  if (!target) {
    throw new BindingError(
      `${dir} has no GitHub origin, so Alpha cannot tell which of ${repos.join(' and ')} it is. Choose the repository it belongs to.`,
      'wrong_repository'
    );
  }

  migrateLegacyBinding(project);
  const saved = sqliteService.saveRepoBinding({
    projectId: project.id,
    repo: target,
    localDir: dir,
    isManaged: managed,
    ...(inspection.branch ? { activeBranch: inspection.branch } : {})
  });
  allowFolder(dir, managed, project.name);
  logInfo(`Bound ${target} (${project.key || project.name}) to ${dir}${inspection.branch ? ` (${inspection.branch})` : ''}`);
  return { ...saved, ownerRepo: target };
}

/**
 * Choosing the folder is the act of consent, so it goes on the allowlist.
 *
 * A managed clone needs nothing: the workspaces root is allowlisted once and
 * the check matches on prefix.
 */
function allowFolder(dir: string, managed: boolean, projectName: string): void {
  if (!managed && !sqliteService.isPathAllowed(dir)) sqliteService.addAllowedPath(dir, projectName);
}

/** Forget where this machine keeps one repository, or -- with none named -- all of the project's. */
export function unbindProject(projectId: string, repo?: string): boolean {
  if (repo) return sqliteService.deleteRepoBinding(projectId, repo);
  const project = sqliteService.deleteProjectBinding(projectId);
  return sqliteService.deleteRepoBindings(projectId) > 0 || project;
}

/**
 * Get the project's code onto this machine and bind it, in one act: one
 * repository when named, otherwise every one this machine does not have yet.
 *
 * The alternative is what a new collaborator does today: find the repository,
 * clone it by hand somewhere, then come back and type the path. Alpha knows
 * the repositories and where it puts clones, so it can do both.
 *
 * Asking twice is not an error. A checkout already at the managed path is
 * bound rather than refused -- which is what makes this safe to press again
 * after a failure, and what makes "set up this project" idempotent. A folder
 * that is not empty and is not a checkout is left strictly alone: Alpha did
 * not put it there.
 */
export async function cloneAndBindProject(project: Project, repo?: string): Promise<BoundProject[]> {
  const repos = reposForProject(project);
  if (repos.length === 0) {
    throw new BindingError(`${project.name} has no GitHub repository to clone.`, 'invalid_folder');
  }
  const wanted = repo ? repos.filter(candidate => candidate.toLowerCase() === repo.toLowerCase()) : repos;
  if (repo && wanted.length === 0) {
    throw new BindingError(`${repo} is not one of ${project.name}'s repositories.`, 'wrong_repository');
  }

  migrateLegacyBinding(project);
  const bound: BoundProject[] = [];
  for (const ownerRepo of wanted) {
    // One already on this machine, wherever it is, is left where it is.
    const existing = resolveProjectWorkspace(project, ownerRepo);
    if (!repo && existing && isExistingCheckout(existing.dir)) continue;

    // Into the project's folder on this computer, where the developer and the
    // Orchestrator both look for it: <projects folder>\<project>\<repository>.
    const dir = path.join(ensureProjectFolder(project), clonePathFor(ownerRepo).repo);
    if (!isExistingCheckout(dir)) {
      if (!isEmptyOrMissing(dir)) {
        throw new BindingError(`${dir} already holds something that is not a checkout.`, 'invalid_folder');
      }
      await githubService.cloneRepository(ownerRepo, path.dirname(dir));
      logInfo(`Cloned ${ownerRepo} for ${project.key || project.name}`);
    } else {
      const origin = originOf(dir);
      if (origin && origin.toLowerCase() !== ownerRepo.toLowerCase()) {
        throw new BindingError(`${dir} is a copy of ${origin}, not ${ownerRepo}.`, 'wrong_repository');
      }
    }
    // Not managed: this is the developer's folder, so Alpha never resets or deletes it.
    bound.push(await bindProject(project, dir, { managed: false, repo: ownerRepo }));
  }
  return bound;
}

/** What happened to one repository when cloning a project into a folder the developer chose. */
export interface FolderCloneResult {
  repo: string;
  /** Where the checkout is, when there is one. */
  path: string | null;
  /** False when a checkout of this repository was already at that path and was reused. */
  cloned: boolean;
  /** True when it became this machine's working copy of the repository for Alpha. */
  bound: boolean;
  error?: string;
}

/**
 * Clone some of the project's repositories into a folder the developer picked,
 * one subfolder per repository, and optionally make each this machine's working
 * copy so Alpha's builds use it.
 *
 * Only the project's own repositories can be cloned. A checkout of the same
 * repository already in place is reused; anything else in the way is reported
 * for that repository while the others still clone.
 */
export async function cloneProjectInto(
  project: Project,
  intoDir: unknown,
  repos: unknown,
  bind: boolean
): Promise<FolderCloneResult[]> {
  if (typeof intoDir !== 'string' || !intoDir.trim() || !path.isAbsolute(intoDir.trim())) {
    throw new BindingError('Choose a folder on this computer to clone into.', 'invalid_folder');
  }
  const folder = path.resolve(intoDir.trim());
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
    throw new BindingError(folder + ' is not a folder on this computer.', 'invalid_folder');
  }
  const projectRepos = reposForProject(project);
  if (projectRepos.length === 0) {
    throw new BindingError(project.name + ' has no GitHub repository to clone.', 'invalid_folder');
  }
  const requested = Array.isArray(repos) ? repos.filter((item): item is string => typeof item === 'string') : [];
  if (requested.length === 0) throw new BindingError('Choose at least one repository to clone.', 'wrong_repository');
  const wanted: string[] = [];
  for (const candidate of requested) {
    const match = projectRepos.find(repo => repo.toLowerCase() === candidate.trim().toLowerCase());
    if (!match) throw new BindingError(candidate + ' is not one of ' + project.name + "'s repositories.", 'wrong_repository');
    if (!wanted.includes(match)) wanted.push(match);
  }

  const results: FolderCloneResult[] = [];
  for (const repo of wanted) {
    const target = path.join(folder, repo.split('/').pop()!);
    try {
      let cloned = false;
      if (!isExistingCheckout(target)) {
        if (!isEmptyOrMissing(target)) {
          throw new BindingError(target + ' already exists and is not a checkout of ' + repo + '.', 'invalid_folder');
        }
        await githubService.cloneRepository(repo, folder);
        cloned = true;
        logInfo('Cloned ' + repo + ' into ' + target + ' for ' + (project.key || project.name));
      }
      let bound = false;
      if (bind) {
        await bindProject(project, target, { repo });
        bound = true;
      }
      results.push({ repo, path: target, cloned, bound });
    } catch (err) {
      results.push({ repo, path: fs.existsSync(target) ? target : null, cloned: false, bound: false, error: String((err as Error)?.message ?? err) });
    }
  }
  return results;
}

/** One repository of the project, and where -- if anywhere -- this machine has it. */
export interface RepositoryCheckout {
  repo: string;
  /** Null when this machine has no checkout of it. */
  localDir: string | null;
  managed: boolean;
  status: CheckoutStatus | null;
}

/** Every repository of the project, each with this machine's checkout of it, in the project's order. */
export async function repositoryCheckouts(project: Project): Promise<RepositoryCheckout[]> {
  return Promise.all(
    reposForProject(project).map(async repo => {
      const workspace = resolveProjectWorkspace(project, repo);
      if (!workspace) return { repo, localDir: null, managed: false, status: null };
      return { repo, localDir: workspace.dir, managed: workspace.managed, status: await checkoutStatus(workspace.dir) };
    })
  );
}

/** What state the first bound checkout is in: branch, uncommitted work, unpushed commits. */
export async function boundCheckoutStatus(project: Project): Promise<CheckoutStatus | null> {
  const workspace = resolveProjectWorkspace(project);
  return workspace ? checkoutStatus(workspace.dir) : null;
}
