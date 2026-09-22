import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * What state a developer's checkout is in, right now.
 *
 * The app could say where a project's code was and nothing about it, so the
 * first sign that a run would start from the wrong branch, or on top of
 * uncommitted work, was the run itself. Every field here is read from git
 * rather than remembered, because the developer edits this folder outside
 * Alpha all day.
 */
export interface CheckoutStatus {
  /** False once the folder has been moved or deleted, which happens. */
  exists: boolean;
  branch?: string;
  /** No uncommitted changes. */
  clean: boolean;
  /** Commits here that the remote does not have, and vice versa. */
  ahead: number;
  behind: number;
  /** Absent when the branch has no upstream yet -- a branch nobody has pushed. */
  tracking?: string;
}

const MISSING: CheckoutStatus = { exists: false, clean: false, ahead: 0, behind: 0 };

export async function checkoutStatus(dir: string): Promise<CheckoutStatus> {
  if (!dir || !fs.existsSync(path.join(dir, '.git'))) return MISSING;

  const git = async (args: string[]): Promise<string | undefined> => {
    try {
      const { stdout } = await execFileAsync('git', args, { cwd: dir, timeout: 10_000, windowsHide: true });
      return stdout.trim();
    } catch {
      // Every one of these has a reason to fail that is not an error: no
      // upstream, no commits yet, a repository mid-rebase.
      return undefined;
    }
  };

  const [branch, changes, tracking] = await Promise.all([
    git(['rev-parse', '--abbrev-ref', 'HEAD']),
    git(['status', '--porcelain']),
    git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  ]);

  let ahead = 0;
  let behind = 0;
  if (tracking) {
    // "behind<TAB>ahead", counted against the upstream this branch tracks.
    const counts = await git(['rev-list', '--left-right', '--count', `${tracking}...HEAD`]);
    const [left, right] = (counts ?? '').split(/\s+/);
    behind = Number(left) || 0;
    ahead = Number(right) || 0;
  }

  return {
    exists: true,
    branch,
    clean: changes === '',
    ahead,
    behind,
    tracking
  };
}
