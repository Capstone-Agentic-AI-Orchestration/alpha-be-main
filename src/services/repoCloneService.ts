import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { githubService } from './githubService.js';
import { assertSafeBranchName } from '../utils/gitUtils.js';
import { logInfo } from '../utils/logger.js';
import {
  clonePathFor,
  ensureWorkspacesRoot,
  isEmptyOrMissing,
  isExistingCheckout
} from './workspaceService.js';

const execFileAsync = promisify(execFile);

export interface CloneResult {
  repo: string;
  localPath: string;
  branch: string;
  /**
   * 'cloned' on first fetch, 'refreshed' when a workspace checkout was reset to
   * the remote, 'existing' when a project-folder copy was left untouched.
   */
  action: 'cloned' | 'refreshed' | 'existing';
}

/**
 * Clone a repository into the managed workspace.
 *
 * The destination is derived from the repository name, never taken from the
 * caller: an agent choosing its own path is how a checkout ends up somewhere
 * Alpha cannot see — agy proposed its own scratch directory when it had no
 * sanctioned route — or somewhere it should not be writing at all.
 *
 * Asking twice refreshes rather than failing. A working copy an agent already
 * has is the common case, and erroring there would push it back to raw shell,
 * which is the behaviour this replaces.
 */
export async function cloneToWorkspace(ownerRepo: string, ref?: string): Promise<CloneResult> {
  /**
   * The ref reaches git's argv. `execFile` removes the shell, so this is not
   * command injection — but a value like `-f` or `--orphan` is still read by
   * git as an option rather than a branch, and the caller here is a model.
   *
   * Validated at the boundary rather than at each call site, so a ref that got
   * this far is known good everywhere below.
   */
  if (ref !== undefined) assertSafeBranchName(ref);

  // Reachability first: `gh repo clone` on a private or missing repo fails with
  // git's transport error, which is far less useful than "it does not exist, or
  // you cannot see it". This also validates the owner/name shape.
  const info = await githubService.getRepository(ownerRepo);

  if (info.isEmpty) {
    throw new Error(
      `${ownerRepo} has no commits yet, so there is nothing to clone. Create the first commit and try again.`
    );
  }

  ensureWorkspacesRoot();
  const { dir } = clonePathFor(ownerRepo);
  const branch = ref ?? info.defaultBranch;

  if (isExistingCheckout(dir)) {
    await refreshCheckout(dir, branch);
    logInfo(`Refreshed ${ownerRepo} at ${dir} (${branch})`);
    return { repo: info.nameWithOwner, localPath: dir, branch, action: 'refreshed' };
  }

  if (!isEmptyOrMissing(dir)) {
    // Something is there that Alpha did not clone. Refusing is the only safe
    // option — the alternative is deleting a directory of unknown provenance.
    throw new Error(
      `${dir} already exists and is not a git checkout. Move or remove it, then try again.`
    );
  }

  fs.mkdirSync(path.dirname(dir), { recursive: true });
  await githubService.cloneRepository(ownerRepo, path.dirname(dir));

  if (branch !== info.defaultBranch) {
    await execFileAsync('git', ['checkout', branch], { cwd: dir });
  }

  logInfo(`Cloned ${ownerRepo} into ${dir} (${branch})`);
  return { repo: info.nameWithOwner, localPath: dir, branch, action: 'cloned' };
}

/**
 * Bring an existing checkout up to date.
 *
 * `reset --hard` rather than `pull`: this is a managed working copy, not
 * somebody's desk. A merge conflict here would leave an agent stuck in a state
 * it cannot resolve, and anything uncommitted was written by an agent that
 * already had its turn.
 */
async function refreshCheckout(dir: string, branch: string): Promise<void> {
  // Re-checked rather than assumed: the caller validates, but this is a
  // separate entry point and the value lands in argv either way.
  assertSafeBranchName(branch);

  await execFileAsync('git', ['fetch', 'origin', '--prune'], { cwd: dir });
  await execFileAsync('git', ['checkout', branch], { cwd: dir });
  await execFileAsync('git', ['reset', '--hard', `origin/${branch}`], { cwd: dir });
}

/**
 * Clone one of a project's repositories into the project's folder on this
 * computer: <folder>\<repository name>, where the developer and the next chat
 * turn both look for it.
 *
 * A copy already there is left exactly as it is. That folder is the
 * developer's: it may hold work they have not committed, so it is never
 * reset the way Alpha's own workspace copies are.
 */
export async function cloneIntoProjectFolder(ownerRepo: string, folder: string, ref?: string): Promise<CloneResult> {
  if (ref !== undefined) assertSafeBranchName(ref);
  const info = await githubService.getRepository(ownerRepo);
  if (info.isEmpty) {
    throw new Error(`${ownerRepo} has no commits yet, so there is nothing to clone. Create the first commit and try again.`);
  }

  const dir = path.join(path.resolve(folder), clonePathFor(ownerRepo).repo);
  const branch = ref ?? info.defaultBranch;
  if (isExistingCheckout(dir)) {
    logInfo(`${ownerRepo} is already at ${dir}; left as it is`);
    return { repo: info.nameWithOwner, localPath: dir, branch, action: 'existing' };
  }
  if (!isEmptyOrMissing(dir)) {
    throw new Error(`${dir} already exists and is not a git checkout. Move or remove it, then try again.`);
  }

  fs.mkdirSync(path.dirname(dir), { recursive: true });
  await githubService.cloneRepository(ownerRepo, path.dirname(dir));
  if (branch !== info.defaultBranch) {
    await execFileAsync('git', ['checkout', branch], { cwd: dir });
  }
  logInfo(`Cloned ${ownerRepo} into the project folder ${dir} (${branch})`);
  return { repo: info.nameWithOwner, localPath: dir, branch, action: 'cloned' };
}
