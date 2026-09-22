import path from 'node:path';

import type { LocalProjectBinding, Project } from '../models/index.js';
import { checkWorkspace } from '../controllers/workspaceValidation.js';
import { githubService } from './githubService.js';
import { repoForProject } from './githubIssueMapping.js';
import { sqliteService } from './sqliteService.js';
import { logInfo } from '../utils/logger.js';
import { clonePathFor, isEmptyOrMissing, isExistingCheckout } from './workspaceService.js';
import { checkoutStatus, type CheckoutStatus } from './localCheckout.js';

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

export function projectBinding(projectId: string): LocalProjectBinding | null {
  return sqliteService.getProjectBinding(projectId);
}

/**
 * Point this machine at a folder for a project.
 *
 * `managed` says Alpha put the code there itself (a clone it made), which is
 * what tells `resolveProjectWorkspace` it may refresh it.
 */
export async function bindProject(
  project: Project,
  localDir: unknown,
  { managed = false }: { managed?: boolean } = {}
): Promise<BoundProject> {
  const check = checkWorkspace(localDir);
  if (!check.ok) throw new BindingError(check.detail ?? 'That folder cannot be used.', 'invalid_folder');

  const dir = path.resolve(String(localDir).trim());
  const inspection = await githubService.inspectLocalRepo(dir);
  const wanted = repoForProject(project);

  /**
   * The same repository, or none to compare against.
   *
   * A project with no repository attached is bound on the person's word --
   * there is nothing to check it against. One that has a repository is
   * checked, because an agent editing the wrong checkout looks exactly like
   * an agent editing the right one until someone reads the diff.
   */
  if (wanted && inspection.ownerRepo && inspection.ownerRepo.toLowerCase() !== wanted.toLowerCase()) {
    throw new BindingError(
      `${dir} is a checkout of ${inspection.ownerRepo}, not ${wanted}.`,
      'wrong_repository'
    );
  }

  const saved = sqliteService.saveProjectBinding({
    projectId: project.id,
    localDir: dir,
    isManaged: managed,
    activeBranch: inspection.branch
  });

  /**
   * Choosing the folder is the act of consent, so it goes on the allowlist.
   *
   * A managed clone needs nothing: the workspaces root is allowlisted once and
   * the check matches on prefix.
   */
  if (!managed && !sqliteService.isPathAllowed(dir)) {
    sqliteService.addAllowedPath(dir, project.name);
  }

  logInfo(`Bound ${project.key || project.name} to ${dir}${inspection.branch ? ` (${inspection.branch})` : ''}`);
  return { ...saved, ownerRepo: inspection.ownerRepo };
}

export function unbindProject(projectId: string): boolean {
  return sqliteService.deleteProjectBinding(projectId);
}

/**
 * Get the project's code onto this machine and bind it, in one act.
 *
 * The alternative is what a new collaborator does today: find the repository,
 * clone it by hand somewhere, then come back and type the path. Alpha knows
 * the repository and where it puts clones, so it can do both.
 *
 * Asking twice is not an error. A checkout already at the managed path is
 * bound rather than refused -- which is what makes this safe to press again
 * after a failure, and what makes "set up this project" idempotent. A folder
 * that is not empty and is not a checkout is left strictly alone: Alpha did
 * not put it there.
 */
export async function cloneAndBindProject(project: Project): Promise<BoundProject> {
  const ownerRepo = repoForProject(project);
  if (!ownerRepo) {
    throw new BindingError(`${project.name} has no GitHub repository to clone.`, 'invalid_folder');
  }

  const { dir } = clonePathFor(ownerRepo);
  if (!isExistingCheckout(dir)) {
    if (!isEmptyOrMissing(dir)) {
      throw new BindingError(`${dir} already holds something that is not a checkout.`, 'invalid_folder');
    }
    await githubService.cloneRepository(ownerRepo, path.dirname(dir));
    logInfo(`Cloned ${ownerRepo} for ${project.key || project.name}`);
  }

  return bindProject(project, dir, { managed: true });
}

/** What state the bound checkout is in: branch, uncommitted work, unpushed commits. */
export async function boundCheckoutStatus(projectId: string): Promise<CheckoutStatus | null> {
  const binding = sqliteService.getProjectBinding(projectId);
  return binding ? checkoutStatus(binding.localDir) : null;
}
