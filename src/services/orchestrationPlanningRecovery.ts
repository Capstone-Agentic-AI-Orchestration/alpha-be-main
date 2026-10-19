import fs from 'node:fs';
import path from 'node:path';
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
  const expectedPath = projectRunWorkspacePath(input.projectId, recovery.runId);
  if (worktree !== path.resolve(expectedPath) || !store.isPathAllowed(worktree) ||
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
}): Promise<PlanningWorktreeInspection> {
  const expectedPath = projectRunWorkspacePath(input.projectId, input.reservation.runId);
  if (path.resolve(expectedPath) !== path.resolve(input.reservation.worktreePath)) {
    return { state: 'unsafe_path', safeToRetire: false, canPreview: false, changed: false };
  }
  if (!fs.existsSync(expectedPath)) {
    return { state: 'missing', safeToRetire: true, canPreview: false, changed: false };
  }
  try {
    if (!(await isGitRepo(expectedPath))) {
      return { state: 'unavailable', safeToRetire: false, canPreview: false, changed: true };
    }
    const [branchName, headCommit, clean] = await Promise.all([
      getCurrentBranch(expectedPath), getHeadCommit(expectedPath), isGitWorkingTreeClean(expectedPath)
    ]);
    const identityMatches = branchName === input.reservation.branchName && headCommit === input.reservation.baseCommit;
    const safeToRetire = identityMatches && clean;
    return {
      state: safeToRetire ? 'clean' : 'changed',
      safeToRetire,
      canPreview: true,
      branchName,
      headCommit,
      changed: !clean || !identityMatches
    };
  } catch {
    return { state: 'unavailable', safeToRetire: false, canPreview: false, changed: true };
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
  const inspection = await inspectOrchestrationPlanningWorktree(input);
  if (inspection.state === 'missing') return true;
  if (!inspection.safeToRetire) return false;
  try {
    await removeDetachedWorktree(input.repositoryDir, input.reservation.worktreePath);
    return !fs.existsSync(input.reservation.worktreePath);
  } catch {
    return false;
  }
}
