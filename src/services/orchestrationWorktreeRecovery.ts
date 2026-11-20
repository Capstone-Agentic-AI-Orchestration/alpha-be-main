import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { isGitWorkingTreeClean } from '../utils/gitUtils.js';

const execFileAsync = promisify(execFile);

export interface PreservedWorktreeChanges {
  /** Where the leftovers were saved, under ~/.alpha/preserved. */
  folder: string;
  /** Edits to tracked files, as a binary-safe patch, when there were any. */
  patchFile?: string;
  /** Untracked files and folders moved out of the worktree, relative to it. */
  movedPaths: string[];
}

const safeName = (value: string) => value.replace(/[^a-z0-9._-]+/gi, '-').slice(0, 80) || 'attempt';

/** Fence the exact unverified edits a same-task retry is allowed to continue.
 * Symlinks are hashed as links, never followed outside the workspace.
 */
export async function worktreeChangesHash(worktree: string): Promise<string> {
  const git = async (args: string[]) => (await execFileAsync('git', args, {
    cwd: worktree, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true
  })).stdout;
  const hash = createHash('sha256').update(await git(['rev-parse', 'HEAD'])).update(await git(['diff', 'HEAD', '--binary']));
  const paths = (await git(['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean).sort();
  for (const relative of paths) {
    const file = path.resolve(worktree, relative);
    if (!file.startsWith(path.resolve(worktree) + path.sep)) throw new Error('A retry file is outside the task workspace.');
    const stat = fs.lstatSync(file);
    const contents = stat.isSymbolicLink() ? Buffer.from(fs.readlinkSync(file)) : fs.readFileSync(file);
    hash.update(JSON.stringify([relative, stat.isSymbolicLink() ? 'link' : 'file', contents.length]));
    hash.update(contents);
  }
  return hash.digest('hex');
}

/**
 * Refuse a folder that is not the top of its own Git working copy.
 *
 * Git looks upward for a repository, so a folder whose own repository is missing or
 * unfinished resolves to whatever repository encloses it. Restoring such a folder reset
 * that outer repository instead: a test whose temporary build folder sat inside a
 * developer's checkout hard-reset the developer's uncommitted work. Nothing is saved or
 * reset unless the folder is exactly the working copy it claims to be.
 */
async function assertOwnWorkingCopy(worktree: string): Promise<void> {
  let top = '';
  try {
    top = String((await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd: worktree, encoding: 'utf8', windowsHide: true })).stdout ?? '').trim();
  } catch {
    throw new Error(`Refusing to restore ${worktree}: it is not a Git working copy.`);
  }
  const same = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  if (!top || !same(path.resolve(top), worktree)) {
    throw new Error(`Refusing to restore ${worktree}: its Git working copy is ${top || 'unknown'}, so restoring it would reset a different repository.`);
  }
}

/**
 * Clear what a failed or interrupted attempt left in a build worktree, without losing it.
 *
 * A specialist that dies mid-task leaves edits, scratch folders or a half-written file
 * behind. Refusing every later attempt until someone cleans the private worktree by hand
 * stranded builds with no way forward from the app. Instead the leftovers are saved
 * (tracked edits as a patch, untracked files moved as they are) under
 * ~/.alpha/preserved/<run>/, and the worktree returns to its saved checkpoint. Callers must
 * only use this when no specialist is active in the worktree.
 */
export async function preserveAndRestoreWorktree(input: {
  worktree: string;
  runId: string;
  label: string;
  now?: Date;
  /** Only for a retry of the same failed task; keep its candidate edits for verification. */
  keepChanges?: boolean;
}): Promise<PreservedWorktreeChanges | undefined> {
  const worktree = path.resolve(input.worktree);
  await assertOwnWorkingCopy(worktree);
  if (await isGitWorkingTreeClean(worktree)) return undefined;
  const savedAt = (input.now ?? new Date()).toISOString();
  // Read at call time so a test or a relocated profile never writes into the real ~/.alpha.
  const alphaDir = process.env.ALPHA_HOME || path.join(os.homedir(), '.alpha');
  const folder = path.join(alphaDir, 'preserved', safeName(input.runId), savedAt.replace(/[:.]/g, '-') + '-' + safeName(input.label));
  fs.mkdirSync(folder, { recursive: true });
  const git = async (args: string[]) => String((await execFileAsync('git', args, {
    cwd: worktree, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true
  })).stdout ?? '');

  const patch = await git(['diff', 'HEAD', '--binary']);
  let patchFile: string | undefined;
  if (patch.trim()) {
    patchFile = path.join(folder, 'tracked-changes.patch');
    fs.writeFileSync(patchFile, patch);
  }

  // --directory reports an untracked folder once, so a scratch cache moves as one rename.
  const untracked = (await git(['ls-files', '--others', '--exclude-standard', '--directory', '-z'])).split('\0').filter(Boolean);
  const movedPaths: string[] = [];
  for (const entry of untracked) {
    const relative = entry.replace(/[\\/]+$/, '');
    const source = path.resolve(worktree, relative);
    if (!source.startsWith(worktree + path.sep)) continue;
    const target = path.join(folder, 'untracked', relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      if (input.keepChanges) fs.cpSync(source, target, { recursive: true });
      else fs.renameSync(source, target);
    } catch {
      fs.cpSync(source, target, { recursive: true });
      if (!input.keepChanges) fs.rmSync(source, { recursive: true, force: true });
    }
    movedPaths.push(relative);
  }
  // The patch is on disk before tracked files are restored.
  if (patchFile && !input.keepChanges) await git(['reset', '--hard', 'HEAD']);

  fs.writeFileSync(path.join(folder, 'README.json'), JSON.stringify({
    runId: input.runId,
    worktree,
    savedAt,
    reason: input.keepChanges
      ? 'Unverified changes from the same failed task; backed up and retained for a bounded retry. Required checks and review still apply.'
      : 'Left behind by a failed or interrupted specialist attempt; moved aside so the next attempt starts from the saved checkpoint.',
    changesRetained: Boolean(input.keepChanges),
    trackedChangesPatch: patchFile ? path.basename(patchFile) : null,
    movedPaths,
    restore: 'Run "git apply tracked-changes.patch" in the worktree and copy the untracked folder back to restore this state.'
  }, null, 2));

  if (!input.keepChanges && !(await isGitWorkingTreeClean(worktree))) {
    throw new Error(`Alpha saved the leftover changes to ${folder} but could not return the worktree to its checkpoint. Review the worktree before retrying.`);
  }
  return { folder, patchFile, movedPaths };
}
