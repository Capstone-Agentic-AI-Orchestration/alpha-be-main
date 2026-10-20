import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getCurrentBranch, getHeadCommit, isGitRepo, isGitWorkingTreeClean, removeDetachedWorktree } from '../utils/gitUtils.js';
import { projectRunWorkspacePath } from './workspaceService.js';
import { sqliteService, type SQLiteService } from './sqliteService.js';

const execFileAsync = promisify(execFile);
const MAX_PREVIEW_CHARS = 96_000;
const MAX_UNTRACKED_FILE_BYTES = 32_000;
const MAX_DIFF_BUFFER_BYTES = 1_000_000;

export interface OrchestrationPlanningWorkspace {
  runId: string;
  repository?: string;
  branchName: string;
  baseCommit: string;
  worktreePath: string;
}

export type PlanningWorktreeInspection = {
  state: 'missing' | 'clean' | 'changed' | 'unsafe_path' | 'unavailable';
  safeToRetire: boolean;
  canPreview: boolean;
  branchName?: string;
  headCommit?: string;
  changed: boolean;
  reason?: string;
};

export interface PlanningWorktreeDiffPreview {
  baseCommit: string;
  headCommit: string;
  branchName: string;
  changedPaths: string[];
  pathsTruncated: boolean;
  diff: string;
  truncated: boolean;
}

function safeRelativePath(value: string): string | undefined {
  const normalized = value.replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || /^[a-z]:\//i.test(normalized) ||
      normalized.split('/').some(segment => segment === '.' || segment === '..')) return undefined;
  return normalized;
}

/**
 * Each repository in a coordinated build has its own private folder. The first
 * repository uses the run id directly; later repositories include a stable
 * repository suffix before the folder hash is calculated.
 */
function expectedPlanningWorktreePaths(projectId: string, runId: string, repository?: string): string[] {
  const paths = [projectRunWorkspacePath(projectId, runId)];
  if (repository) {
    const repositorySuffix = crypto.createHash('sha256').update(repository.toLowerCase()).digest('hex').slice(0, 12);
    paths.push(projectRunWorkspacePath(projectId, `${runId}-${repositorySuffix}`));
  }
  return paths;
}

function matchesExpectedPlanningWorktree(input: {
  projectId: string;
  reservation: OrchestrationPlanningWorkspace;
  worktreePath: string;
}): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const actual = normalize(input.worktreePath);
  return expectedPlanningWorktreePaths(input.projectId, input.reservation.runId, input.reservation.repository)
    .some(candidate => normalize(candidate) === actual);
}

async function boundedGitOutput(cwd: string, args: string[]): Promise<{ text: string; truncated: boolean }> {
  try {
    const result = await execFileAsync('git', args, {
      cwd, encoding: 'utf8', maxBuffer: MAX_DIFF_BUFFER_BYTES, windowsHide: true
    });
    return { text: String(result.stdout ?? ''), truncated: false };
  } catch (error) {
    const partial = (error as NodeJS.ErrnoException & { stdout?: string | Buffer }).stdout;
    if (partial === undefined) throw error;
    return { text: String(partial), truncated: true };
  }
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  if (normalize(left) === normalize(right)) return true;
  try {
    const realpath = fs.realpathSync.native;
    return normalize(realpath(left)) === normalize(realpath(right));
  } catch {
    return false;
  }
}

async function sameGitRepository(left: string, right: string): Promise<boolean> {
  const commonDir = async (cwd: string) => {
    const result = await execFileAsync('git', ['rev-parse', '--git-common-dir'], {
      cwd, encoding: 'utf8', windowsHide: true
    });
    return path.resolve(cwd, String(result.stdout ?? '').trim());
  };
  try {
    const [leftCommonDir, rightCommonDir] = await Promise.all([commonDir(left), commonDir(right)]);
    return samePath(leftCommonDir, rightCommonDir);
  } catch {
    return false;
  }
}

/** Fix Git's saved link after a managed worktree path has moved or changed form. */
async function repairWorktreeRegistration(repositoryDir: string | undefined, worktreePath: string): Promise<boolean> {
  if (!repositoryDir || !fs.existsSync(repositoryDir) || !(await sameGitRepository(repositoryDir, worktreePath))) return false;
  try {
    await execFileAsync('git', ['worktree', 'repair', path.resolve(worktreePath)], {
      cwd: repositoryDir, timeout: 120_000, windowsHide: true
    });
    return true;
  } catch {
    return false;
  }
}

/** Read-only, bounded preview of committed, tracked and untracked planner changes. */
export async function getOrchestrationPlanningRecoveryPreview(input: {
  projectId: string;
  runId: string;
  store?: SQLiteService;
}): Promise<PlanningWorktreeDiffPreview> {
  const store = input.store ?? sqliteService;
  const recovery = store.getOrchestrationPlanningRecovery(input.projectId, input.runId);
  if (!recovery || !['needs_review', 'retained'].includes(recovery.state)) {
    throw new Error('The saved planning workspace is not available for review.');
  }
  const worktree = path.resolve(recovery.worktreePath);
  if (!matchesExpectedPlanningWorktree({ projectId: input.projectId, reservation: recovery, worktreePath: worktree }) || !store.isPathAllowed(worktree) ||
      !(await isGitRepo(worktree)) || !/^[a-f0-9]{40,64}$/i.test(recovery.baseCommit)) {
    throw new Error('Alpha cannot verify the saved planning workspace for review.');
  }

  const [branchName, headCommit, trackedPathsOutput, untrackedPathsOutput, trackedDiff] = await Promise.all([
    getCurrentBranch(worktree),
    getHeadCommit(worktree),
    boundedGitOutput(worktree, ['diff', '--name-only', '--no-renames', '-z', recovery.baseCommit, '--']),
    boundedGitOutput(worktree, ['ls-files', '--others', '--exclude-standard', '-z']),
    boundedGitOutput(worktree, ['diff', '--no-ext-diff', '--no-color', '--no-renames', '--unified=3', recovery.baseCommit, '--'])
  ]);
  const changedPaths = [...new Set([
    ...trackedPathsOutput.text.split('\0'),
    ...untrackedPathsOutput.text.split('\0')
  ].filter(Boolean).map(safeRelativePath).filter((item): item is string => Boolean(item)))].sort((a, b) => a.localeCompare(b));

  let diff = trackedDiff.text;
  let truncated = trackedDiff.truncated || trackedPathsOutput.truncated || untrackedPathsOutput.truncated;
  for (const relativePath of changedPaths) {
    if (!untrackedPathsOutput.text.split('\0').includes(relativePath)) continue;
    const absolutePath = path.resolve(worktree, relativePath);
    if (!absolutePath.startsWith(`${worktree}${path.sep}`)) continue;
    try {
      const stat = fs.lstatSync(absolutePath);
      if (!stat.isFile() || stat.size > MAX_UNTRACKED_FILE_BYTES) {
        diff += `\nUntracked file omitted from inline preview: ${relativePath} (${stat.isFile() ? 'file exceeds preview size limit' : 'not a regular file'}).\n`;
        continue;
      }
      const content = fs.readFileSync(absolutePath);
      if (content.includes(0)) {
        diff += `\nUntracked file omitted from inline preview: ${relativePath} (binary content).\n`;
        continue;
      }
      const text = content.toString('utf8').replace(/\r\n/g, '\n');
      const lines = text.split('\n');
      const body = lines.map(line => `+${line}`).join('\n');
      diff += `\ndiff --git a/${relativePath} b/${relativePath}\nnew file mode 100644\n--- /dev/null\n+++ b/${relativePath}\n@@ -0,0 +1,${lines.length} @@\n${body}\n`;
    } catch {
      diff += `\nUntracked file omitted from inline preview: ${relativePath} (could not read safely).\n`;
    }
    if (diff.length > MAX_PREVIEW_CHARS) {
      diff = diff.slice(0, MAX_PREVIEW_CHARS);
      truncated = true;
      break;
    }
  }
  if (diff.length > MAX_PREVIEW_CHARS) {
    diff = diff.slice(0, MAX_PREVIEW_CHARS);
    truncated = true;
  }

  return {
    baseCommit: recovery.baseCommit,
    headCommit,
    branchName,
    changedPaths: changedPaths.slice(0, 200),
    pathsTruncated: changedPaths.length > 200,
    diff,
    truncated
  };
}

/** Inspect a reserved planner worktree without deleting or modifying it. */
export async function inspectOrchestrationPlanningWorktree(input: {
  projectId: string;
  reservation: OrchestrationPlanningWorkspace;
  repositoryDir?: string;
}): Promise<PlanningWorktreeInspection> {
  if (!matchesExpectedPlanningWorktree({
    projectId: input.projectId,
    reservation: input.reservation,
    worktreePath: input.reservation.worktreePath
  })) {
    return {
      state: 'unsafe_path', safeToRetire: false, canPreview: false, changed: false,
      reason: 'The saved folder does not match either private folder Alpha reserved for this build and repository.'
    };
  }
  const worktreePath = path.resolve(input.reservation.worktreePath);
  if (!fs.existsSync(worktreePath)) {
    return { state: 'missing', safeToRetire: true, canPreview: false, changed: false };
  }
  try {
    if (!(await isGitRepo(worktreePath))) {
      return {
        state: 'unavailable', safeToRetire: false, canPreview: false, changed: true,
        reason: 'Git cannot open the saved folder. Reconnect the same repository checkout and recheck the workspace.'
      };
    }
    const [branchName, headCommit] = await Promise.all([
      getCurrentBranch(worktreePath), getHeadCommit(worktreePath)
    ]);
    const identityMatches = branchName === input.reservation.branchName && headCommit === input.reservation.baseCommit;
    if (!identityMatches) {
      return {
        state: 'changed', safeToRetire: false, canPreview: true, branchName, headCommit, changed: true,
        reason: 'The saved folder is connected, but its branch or starting commit no longer matches this build.'
      };
    }
    let clean: boolean;
    try {
      clean = await isGitWorkingTreeClean(worktreePath);
    } catch {
      const repaired = await repairWorktreeRegistration(input.repositoryDir, worktreePath);
      if (!repaired) {
        return {
          state: 'unavailable', safeToRetire: false, canPreview: false, changed: true, branchName, headCommit,
          reason: 'Alpha confirmed the saved branch and starting commit, but Git could not check its files. The folder was kept untouched; reconnect the same repository and recheck.'
        };
      }
      clean = await isGitWorkingTreeClean(worktreePath);
    }
    const safeToRetire = identityMatches && clean;
    return {
      state: safeToRetire ? 'clean' : 'changed',
      safeToRetire,
      canPreview: true,
      branchName,
      headCommit,
      changed: !clean || !identityMatches,
      reason: !clean ? 'The saved folder contains changes and has been kept for review.' : undefined
    };
  } catch {
    return {
      state: 'unavailable', safeToRetire: false, canPreview: false, changed: true,
      reason: 'Git could not read the saved branch and starting commit. Reconnect the same repository checkout and recheck the workspace.'
    };
  }
}

/**
 * Retire only an interrupted planner's private worktree when its identity and
 * contents still match the original reservation. A dirty or unexpected path
 * stays on disk and keeps the repository reserved for deliberate recovery.
 */
export async function removeStaleOrchestrationPlanningWorktree(input: {
  repositoryDir: string;
  projectId: string;
  reservation: OrchestrationPlanningWorkspace;
}): Promise<boolean> {
  const inspection = await inspectOrchestrationPlanningWorktree({
    projectId: input.projectId,
    reservation: input.reservation,
    repositoryDir: input.repositoryDir
  });
  if (inspection.state === 'missing') return true;
  if (!inspection.safeToRetire) return false;
  try {
    await removeDetachedWorktree(input.repositoryDir, input.reservation.worktreePath);
    return !fs.existsSync(input.reservation.worktreePath);
  } catch {
    return false;
  }
}
