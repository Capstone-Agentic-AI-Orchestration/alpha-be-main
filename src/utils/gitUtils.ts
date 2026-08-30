import { execFile } from 'node:child_process';
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

export async function createBranch(cwd: string, branchName: string): Promise<void> {
  assertSafeBranchName(branchName);
  await execFileAsync('git', ['checkout', '-B', branchName], { cwd });
}

/**
 * Turn a directory of files into a git repository with one commit on `main`.
 *
 * `gh repo create --source` refuses a directory that is not already a repo with
 * at least one commit, so this runs before the repository exists on GitHub.
 *
 * The branch is set explicitly rather than relying on `init.defaultBranch`,
 * which varies by machine — a repo that landed on `master` here would disagree
 * with every base branch Alpha assumes elsewhere.
 *
 * Identity is passed per-command instead of being written to the config. The
 * daemon runs on someone else's machine and a scaffold commit is not a reason
 * to edit their global git identity; `-c` applies only to this invocation, and
 * only when they have no identity of their own set.
 */
export async function initRepoWithCommit(
  cwd: string,
  commitMessage: string,
  defaultBranch = 'main'
): Promise<void> {
  assertSafeBranchName(defaultBranch);

  await execFileAsync('git', ['init', '--initial-branch', defaultBranch], { cwd });
  await execFileAsync('git', ['add', '--all'], { cwd });

  const identity = (await hasGitIdentity(cwd))
    ? []
    : ['-c', 'user.name=Alpha', '-c', 'user.email=alpha@localhost'];

  // `--` stops a message beginning with '-' being read as an option.
  await execFileAsync('git', [...identity, 'commit', '-m', commitMessage, '--'], { cwd });
}

async function hasGitIdentity(cwd: string): Promise<boolean> {
  try {
    const name = await execFileAsync('git', ['config', '--get', 'user.name'], { cwd });
    const email = await execFileAsync('git', ['config', '--get', 'user.email'], { cwd });
    return name.stdout.trim().length > 0 && email.stdout.trim().length > 0;
  } catch {
    // `--get` exits non-zero when the key is unset, which is the answer.
    return false;
  }
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
