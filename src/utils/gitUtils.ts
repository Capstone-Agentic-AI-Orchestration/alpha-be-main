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
 */
function assertSafeBranchName(branchName: string): void {
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

  try {
    const committed = await shortstat(['HEAD~1']);
    if (committed.trim()) return parseDiffShortStat(committed);
    return parseDiffShortStat(await shortstat([]));
  } catch {
    // HEAD~1 does not exist on a repo with a single commit — fall back to the
    // working tree rather than reporting no changes at all.
    try {
      return parseDiffShortStat(await shortstat([]));
    } catch {
      return { changedFiles: 0, insertions: 0, deletions: 0 };
    }
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
