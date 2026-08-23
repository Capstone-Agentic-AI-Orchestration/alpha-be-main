import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await execAsync('git rev-parse --is-inside-work-tree', { cwd });
    return true;
  } catch {
    return false;
  }
}

export async function getCurrentBranch(cwd: string): Promise<string> {
  try {
    const { stdout } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd });
    return stdout.trim();
  } catch {
    return 'main';
  }
}

export async function checkDirtyWorktree(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await execAsync('git status --porcelain', { cwd });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

export async function createBranch(cwd: string, branchName: string): Promise<void> {
  await execAsync(`git checkout -B ${branchName}`, { cwd });
}

export async function getGitDiffStats(cwd: string): Promise<{ changedFiles: number; insertions: number; deletions: number }> {
  try {
    const { stdout } = await execAsync('git diff --shortstat HEAD~1', { cwd });
    if (!stdout.trim()) {
      const workingDiff = await execAsync('git diff --shortstat', { cwd });
      return parseDiffShortStat(workingDiff.stdout);
    }
    return parseDiffShortStat(stdout);
  } catch {
    try {
      const workingDiff = await execAsync('git diff --shortstat', { cwd });
      return parseDiffShortStat(workingDiff.stdout);
    } catch {
      return { changedFiles: 0, insertions: 0, deletions: 0 };
    }
  }
}

function parseDiffShortStat(shortstat: string): { changedFiles: number; insertions: number; deletions: number } {
  let changedFiles = 0;
  let insertions = 0;
  let deletions = 0;

  const fileMatch = shortstat.match(/(\d+)\s+files? changed/);
  const insMatch = shortstat.match(/(\d+)\s+insertions?\(\+\)/);
  const delMatch = shortstat.match(/(\d+)\s+deletions?\(-\)/);

  if (fileMatch) changedFiles = parseInt(fileMatch[1], 10);
  if (insMatch) insertions = parseInt(insMatch[1], 10);
  if (delMatch) deletions = parseInt(delMatch[1], 10);

  return { changedFiles, insertions, deletions };
}
