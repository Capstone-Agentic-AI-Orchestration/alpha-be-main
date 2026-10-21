import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

/**
 * execFile, not exec: no shell is involved, so arguments reach git verbatim and
 * shell metacharacters in them are inert. Every helper here uses it, including
 * the ones with fixed command strings — leaving a shell in place invites the
 * next edit to interpolate into it.
 */
const execFileAsync = promisify(execFile);

export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd });
    return true;
  } catch {
    return false;
  }
}

/**
 * Add a clean, detached worktree at the repository's current commit.
 *
 * The run creates its own branch after the workspace is prepared. Starting
 * detached keeps the user's checkout and any uncommitted files untouched,
 * while still sharing the repository's object store and remote configuration.
 */
export async function addDetachedWorktree(repositoryDir: string, worktreeDir: string): Promise<void> {
  const destination = path.resolve(worktreeDir);
  if (fs.existsSync(destination)) {
    throw new Error(`The isolated build folder already exists: ${destination}`);
  }
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  await execFileAsync('git', ['worktree', 'add', '--detach', destination, 'HEAD'], {
    cwd: repositoryDir,
    timeout: 120_000
  });
}

/** Create one shared orchestration branch in an isolated, run-scoped worktree. */
export async function addBranchWorktree(
  repositoryDir: string,
  worktreeDir: string,
  branchName: string,
  baseRef = 'HEAD'
): Promise<void> {
  assertSafeBranchName(branchName);
  if (!baseRef || baseRef.startsWith('-')) throw new Error('Invalid orchestration worktree base revision.');
  const destination = path.resolve(worktreeDir);
  if (fs.existsSync(destination)) throw new Error(`The isolated build folder already exists: ${destination}`);
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  await execFileAsync('git', ['worktree', 'add', '-b', branchName, destination, baseRef], {
    cwd: repositoryDir,
    timeout: 120_000
  });
}

/** Return the immutable commit currently checked out in a task worktree. */
export async function getHeadCommit(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd });
  const commit = stdout.trim();
  if (!/^[a-f0-9]{40,64}$/i.test(commit)) throw new Error('Git returned an invalid HEAD commit.');
  return commit;
}

/** Names added, changed, renamed, or deleted between two immutable commits. */
export async function getGitChangedPaths(cwd: string, baseCommit: string, resultCommit: string): Promise<string[]> {
  if (!/^[a-f0-9]{40,64}$/i.test(baseCommit) || !/^[a-f0-9]{40,64}$/i.test(resultCommit)) {
    throw new Error('A diff requires two valid commit IDs.');
  }
  const { stdout } = await execFileAsync('git', [
    'diff', '--name-only', '--no-renames', '-z', baseCommit, resultCommit, '--'
  ], { cwd, maxBuffer: 4 * 1024 * 1024 });
  return [...new Set(stdout.split('\0').filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

/** List tracked paths for safe, scoped review-context packaging without invoking a reviewer shell. */
export async function getGitTrackedPaths(cwd: string): Promise<string[]> {
  const { stdout } = await execFileAsync('git', ['ls-files', '-z'], {
    cwd,
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true
  });
  return [...new Set(stdout.split('\0').filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

/** Read an exact, color-free patch between two immutable task commits. */
export async function getGitDiffPatch(cwd: string, baseCommit: string, resultCommit: string): Promise<string> {
  if (!/^[a-f0-9]{40,64}$/i.test(baseCommit) || !/^[a-f0-9]{40,64}$/i.test(resultCommit)) {
    throw new Error('A review patch requires two valid commit IDs.');
  }
  try {
    const { stdout } = await execFileAsync('git', [
      'diff', '--no-ext-diff', '--no-color', '--unified=3', baseCommit, resultCommit, '--'
    ], { cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: 512 * 1024, windowsHide: true });
    return stdout;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      throw new Error('The accepted task diff exceeds Alpha’s safe review-patch limit. Split the work into smaller tasks or request human review.');
    }
    throw new Error(`The accepted task diff could not be read for review: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Remove only a worktree path previously allocated under the managed run root. */
export async function removeDetachedWorktree(repositoryDir: string, worktreeDir: string): Promise<void> {
  const destination = path.resolve(worktreeDir);
  if (!fs.existsSync(destination)) return;
  await execFileAsync('git', ['worktree', 'remove', '--force', destination], {
    cwd: repositoryDir,
    timeout: 120_000
  });
}

/** Detect user work that a run's git add/commit could otherwise absorb. */
export async function isGitWorkingTreeClean(cwd: string): Promise<boolean> {
  const { stdout } = await execFileAsync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd });
  return stdout.trim().length === 0;
}

export async function getCurrentBranch(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
    return stdout.trim();
  } catch {
    return 'main';
  }
}

export async function checkDirtyWorktree(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Reject anything that is not a plain git branch name.
 *
 * This is the second line of defence, not the first — execFile already removes
 * the shell. It stays because a branch name here is derived from
 * `issue.identifier`, which arrives in a POST /issues body, and git itself
 * treats some of these characters as syntax: a leading `-` would be read as an
 * option, and `..`, `~`, `^`, `:` are revision operators.
 *
 * Exported because the same check guards refs arriving from agent tool calls —
 * see repoCloneService. Note that `--` is *not* an alternative here: for
 * `git checkout` it means "the rest are pathspecs", so `checkout -- main`
 * looks for a file called main instead of switching branch. For a ref, the
 * only correct defence is rejecting the value.
 */
export function assertSafeBranchName(branchName: string): void {
  const valid =
    /^[A-Za-z0-9._/-]{1,200}$/.test(branchName) &&
    !branchName.startsWith('-') &&
    !branchName.startsWith('/') &&
    !branchName.endsWith('/') &&
    !branchName.endsWith('.') &&
    !branchName.endsWith('.lock') &&
    !branchName.includes('..') &&
    !branchName.includes('//');

  if (!valid) {
    throw new Error(
      `Invalid branch name "${branchName}". Use letters, numbers, dots, slashes, hyphens and underscores.`
    );
  }
}

/**
 * Move onto a branch that already exists, without touching where it points.
 *
 * `createBranch` uses `checkout -B`, which force-resets the branch to HEAD.
 * That is right for starting fresh work and catastrophic for a squad: member
 * two calling it would discard every commit member one just made. Squad members
 * after the first come through here instead.
 */
export async function checkoutBranch(cwd: string, branchName: string): Promise<void> {
  assertSafeBranchName(branchName);
  await execFileAsync('git', ['checkout', branchName], { cwd });
}

export async function createBranch(cwd: string, branchName: string): Promise<void> {
  assertSafeBranchName(branchName);
  await execFileAsync('git', ['checkout', '-B', branchName], { cwd });
}

/**
 * Whether the checkout's remote has a `dev` branch -- a repository Alpha
 * provisioned with the dev -> uat -> main pipeline.
 *
 * Asked of the remote, not the local refs, because a clone made before the
 * branch existed would not know about it. Any failure (no remote, offline)
 * answers false, which keeps the older behaviour: work from HEAD, PR to main.
 */
export async function remoteHasDevBranch(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['ls-remote', '--heads', 'origin', 'dev'], { cwd, timeout: 20_000 });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/** Fetch a known remote branch and return its local tracking ref for a worktree. */
export async function fetchRemoteBranch(cwd: string, branchName: string): Promise<string> {
  assertSafeBranchName(branchName);
  await execFileAsync('git', ['fetch', 'origin', branchName], { cwd, timeout: 120_000 });
  return `origin/${branchName}`;
}

/**
 * Create (or reset) `branchName` at the remote's `base`, fetched fresh.
 *
 * An agent's work should start from what the team has integrated, not from
 * whatever branch the checkout happened to be left on.
 */
export async function createBranchFrom(cwd: string, branchName: string, base: string): Promise<void> {
  assertSafeBranchName(branchName);
  assertSafeBranchName(base);
  await fetchRemoteBranch(cwd, base);
  await execFileAsync('git', ['checkout', '-B', branchName, `origin/${base}`], { cwd });
}

export async function getGitDiffStats(
  cwd: string
): Promise<{ changedFiles: number; insertions: number; deletions: number }> {
  const shortstat = async (args: string[]) =>
    (await execFileAsync('git', ['diff', '--shortstat', ...args], { cwd })).stdout;

  /**
   * Make new files visible to `git diff`.
   *
   * `git diff` reports tracked files only, so a run that *added* files
   * measured as zero. A QA agent writing `math.test.js` produced "0 files
   * changed" while the commit it triggered moments later recorded
   * "1 file changed, 45 insertions" — measured.
   *
   * `--intent-to-add` registers the paths in the index without staging their
   * contents, which is exactly enough for diff to see them. It is safe here
   * because the caller commits with `git add -A` immediately afterwards, so
   * the index was going to be written anyway.
   *
   * That this went unnoticed is instructive: the caller used to fall back to
   * `insertions || 45` when the count came back zero, and 45 is about what a
   * real run produces — so the invented number stood in for the broken
   * measurement and made it look right.
   */
  try {
    await execFileAsync('git', ['add', '--intent-to-add', '--', '.'], { cwd });
  } catch {
    // Nothing to register, or not a repository. The diff below still runs.
  }

  try {
    const working = await shortstat([]);
    if (working.trim()) return parseDiffShortStat(working);

    // Nothing uncommitted: the work may already have been committed on this
    // branch, so compare against its parent.
    return parseDiffShortStat(await shortstat(['HEAD~1']));
  } catch {
    // HEAD~1 does not exist on a repository with a single commit.
    return { changedFiles: 0, insertions: 0, deletions: 0 };
  }
}

function parseDiffShortStat(shortstat: string): {
  changedFiles: number;
  insertions: number;
  deletions: number;
} {
  const read = (re: RegExp) => {
    const m = re.exec(shortstat);
    return m ? Number.parseInt(m[1], 10) : 0;
  };

  return {
    changedFiles: read(/(\d+)\s+files? changed/),
    insertions: read(/(\d+)\s+insertions?\(\+\)/),
    deletions: read(/(\d+)\s+deletions?\(-\)/)
  };
}
