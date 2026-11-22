import { execFile } from 'node:child_process';
import { sameRepository } from '../utils/repositoryName.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { OrchestrationSnapshot } from './orchestrationStateMachine.js';
import { assertSafeBranchName, isGitRepo, keepRepositoryLineEndings, REPOSITORY_LINE_ENDINGS } from '../utils/gitUtils.js';

const execFileAsync = promisify(execFile);

/**
 * A build's working copies are git worktrees of the project's own checkout, and its
 * branch and commits live only in that checkout until the build is published. Deleting
 * and re-cloning the project folder therefore used to destroy every accepted task and
 * leave the working copies pointing at nothing ("not a git repository"), with a
 * "retry" button that could never succeed.
 *
 * Two things now protect a build:
 * - every accepted checkpoint is backed up to a hidden ref on GitHub
 *   (`refs/alpha-checkpoints/<branch>`): not a branch, so it is not listed with the
 *   project's branches and does not trigger push workflows;
 * - before a task starts, a milestone is planned or a build resumes, each working copy
 *   is checked, and a disconnected one is repaired or rebuilt at its last checkpoint.
 * When neither the checkout nor GitHub has that checkpoint, the build stops with a
 * reason that says so, instead of offering a retry.
 */

/** A stop reason that no retry can fix: the working copy and its checkpoint are gone. */
export const BUILD_WORKSPACE_LOST_PREFIX = 'Build working copy lost:';

export class BuildWorkspaceLostError extends Error {
  constructor(detail: string) {
    super(`${BUILD_WORKSPACE_LOST_PREFIX} ${detail}`);
    this.name = 'BuildWorkspaceLostError';
  }
}

export function isBuildWorkspaceLost(reason: string | undefined): boolean {
  return Boolean(reason?.trim().startsWith(BUILD_WORKSPACE_LOST_PREFIX));
}

/** Where a build branch's checkpoints are backed up on GitHub. */
export function checkpointRef(branchName: string): string {
  assertSafeBranchName(branchName);
  return `refs/alpha-checkpoints/${branchName}`;
}

export { sameRepository };

/** The commit a repository's working copy must be at: its latest accepted task, or the build's base. */
export function latestCheckpointCommit(snapshot: OrchestrationSnapshot, repository: string, baseCommit?: string): string | undefined {
  const accepted = [...snapshot.attempts].reverse().find(attempt => {
    const task = snapshot.tasks.find(item => item.id === attempt.taskId);
    return attempt.status === 'accepted' && attempt.resultCommit && task &&
      sameRepository(task.repository ?? snapshot.run.repository, repository);
  });
  return accepted?.resultCommit ?? baseCommit;
}

/**
 * Why a checkpoint must not be backed up, or null when it may be.
 *
 * Accepted work is unreviewed until the build is published, and a hidden ref is still
 * readable by anyone who can read the repository. So a backup only goes to a private
 * repository, and only when the project checkout still points at that repository.
 */
export function checkpointBackupRefusal(input: { repository: string; checkoutRepository?: string; isPrivate: boolean }): string | null {
  if (!input.checkoutRepository || !sameRepository(input.checkoutRepository, input.repository)) {
    return `The project checkout no longer points at ${input.repository}.`;
  }
  if (!input.isPrivate) {
    return `${input.repository} is public, and unreviewed build work is never published before review.`;
  }
  return null;
}

/**
 * Back up and restore checkpoints on the project's GitHub repository. `cwd` is the project's
 * own checkout. It only supplies commits: the real remote runs the token-bearing commands
 * isolated from its config, which agents can write through their working copies.
 */
export interface CheckpointRemote {
  push(cwd: string, repository: string, commit: string, ref: string): Promise<void>;
  fetch(cwd: string, repository: string, ref: string): Promise<void>;
}

export interface EnsureBuildWorktreeInput {
  /** The project's own checkout, which owns the worktree registrations. */
  checkoutDir: string;
  worktreePath: string;
  branchName: string;
  repository: string;
  /** Latest accepted checkpoint, or the build's base commit when nothing was accepted yet. */
  expectedCommit?: string;
  runId: string;
  remote?: CheckpointRemote;
  /** Defaults to ~/.alpha (or ALPHA_HOME). */
  alphaDir?: string;
  now?: Date;
}

export type EnsureBuildWorktreeResult =
  | { status: 'connected' }
  | { status: 'repaired' }
  | { status: 'rebuilt'; commit: string; preservedFolder?: string };

const git = async (cwd: string, args: string[]) =>
  (await execFileAsync('git', args, { cwd, encoding: 'utf8', timeout: 120_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 })).stdout;

/**
 * True while git still recognises the working copy. Which checkout owns it is not
 * checked: a healthy working copy is never touched, only one git has lost.
 */
async function isConnected(worktreePath: string): Promise<boolean> {
  return fs.existsSync(worktreePath) && await isGitRepo(worktreePath);
}

async function hasCommit(cwd: string, commit: string): Promise<boolean> {
  try {
    await git(cwd, ['cat-file', '-e', `${commit}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** Why a validated build cannot be approved once its working copy, and the reviewed commit with it, is gone. */
export function lostReviewedWorkingCopyDetail(repository: string, reviewedCommit?: string): string {
  const commit = reviewedCommit && /^[a-f0-9]{7,64}$/i.test(reviewedCommit) ? ` (${reviewedCommit.slice(0, 7)})` : '';
  return `The ${repository} working copy is no longer connected to its project checkout, most likely because the project folder was deleted or cloned again. ` +
    `The reviewed changes${commit} went with it and were never published, so this build cannot be approved. Stop it and plan a new build.`;
}

/**
 * Why a validated working copy is gone for good, or undefined while it is connected or
 * can still be repaired, because the project checkout still has the reviewed commit.
 * Read-only: it never repairs anything, so the board can ask on every refresh.
 */
export async function lostReviewedWorkingCopy(input: { repository: string; worktreePath: string; checkoutDir?: string; reviewedCommit?: string }): Promise<string | undefined> {
  if (await isConnected(path.resolve(input.worktreePath))) return undefined;
  const checkout = input.checkoutDir ? path.resolve(input.checkoutDir) : undefined;
  const commit = input.reviewedCommit && /^[a-f0-9]{40,64}$/i.test(input.reviewedCommit) ? input.reviewedCommit : undefined;
  if (checkout && commit && fs.existsSync(checkout) && await isGitRepo(checkout) && await hasCommit(checkout, commit)) return undefined;
  return `${BUILD_WORKSPACE_LOST_PREFIX} ${lostReviewedWorkingCopyDetail(input.repository, commit)}`;
}

/** Move the disconnected folder aside rather than deleting anything a person may want back. */
async function moveAside(worktreePath: string, alphaDir: string, runId: string, now: Date): Promise<string> {
  const safe = (value: string) => value.replace(/[^a-z0-9._-]+/gi, '-').slice(0, 80) || 'build';
  const folder = path.join(alphaDir, 'preserved', safe(runId), `${now.toISOString().replace(/[:.]/g, '-')}-disconnected-${safe(path.basename(worktreePath))}`);
  await fs.promises.mkdir(path.dirname(folder), { recursive: true });
  try {
    await fs.promises.rename(worktreePath, folder);
  } catch {
    // A different drive: copy, then remove the original.
    await fs.promises.cp(worktreePath, folder, { recursive: true, verbatimSymlinks: true });
    await fs.promises.rm(worktreePath, { recursive: true, force: true });
  }
  return folder;
}

/**
 * Make sure a build's working copy is a connected git worktree of the project checkout.
 * Repairs a moved registration, otherwise rebuilds the working copy at its last
 * checkpoint (fetching the GitHub backup when the checkout no longer has it).
 * Throws BuildWorkspaceLostError when the checkpoint cannot be found anywhere.
 */
export async function ensureBuildWorktree(input: EnsureBuildWorktreeInput): Promise<EnsureBuildWorktreeResult> {
  const checkoutDir = path.resolve(input.checkoutDir);
  const worktreePath = path.resolve(input.worktreePath);
  assertSafeBranchName(input.branchName);
  if (await isConnected(worktreePath)) return { status: 'connected' };

  if (fs.existsSync(worktreePath)) {
    try {
      await git(checkoutDir, ['worktree', 'repair', worktreePath]);
    } catch {
      // Nothing to repair from this checkout; rebuild below.
    }
    if (await isConnected(worktreePath)) return { status: 'repaired' };
  }

  const commit = input.expectedCommit;
  if (!commit || !/^[a-f0-9]{40,64}$/i.test(commit)) {
    throw new BuildWorkspaceLostError(`The ${input.repository} working copy is no longer connected to ${checkoutDir}, and this build has no recorded checkpoint to rebuild it from. Stop this build and start a new one.`);
  }
  if (!(await hasCommit(checkoutDir, commit)) && input.remote) {
    try {
      await input.remote.fetch(checkoutDir, input.repository, checkpointRef(input.branchName));
    } catch {
      // Older builds have no backup yet; the check below reports it.
    }
  }
  if (!(await hasCommit(checkoutDir, commit))) {
    throw new BuildWorkspaceLostError(
      `The ${input.repository} working copy is no longer connected to ${checkoutDir}. ` +
      'That folder was most likely deleted and cloned again, which removed this build\'s unpublished branch. ' +
      `Its last checkpoint (${commit.slice(0, 7)}) is not in the new clone or backed up on GitHub, so the build cannot continue safely. ` +
      `The files are still at ${worktreePath}. Stop this build and start a new one.`
    );
  }

  const preservedFolder = fs.existsSync(worktreePath)
    ? await moveAside(worktreePath, input.alphaDir ?? (process.env.ALPHA_HOME || path.join(os.homedir(), '.alpha')), input.runId, input.now ?? new Date())
    : undefined;
  // Drop the dead registration for this path, then recreate the branch at the checkpoint.
  await git(checkoutDir, ['worktree', 'prune']);
  await fs.promises.mkdir(path.dirname(worktreePath), { recursive: true });
  await git(checkoutDir, [...REPOSITORY_LINE_ENDINGS, 'worktree', 'add', '-B', input.branchName, worktreePath, commit]);
  await keepRepositoryLineEndings(checkoutDir, worktreePath);
  return { status: 'rebuilt', commit, ...(preservedFolder ? { preservedFolder } : {}) };
}
