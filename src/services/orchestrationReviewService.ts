import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { getCurrentBranch, getGitChangedPaths, getHeadCommit, isGitRepo, isGitWorkingTreeClean } from '../utils/gitUtils.js';
import { sqliteService, type SQLiteService } from './sqliteService.js';
import { runWithWorkspace } from './workspaceContext.js';
import type { OrchestrationSnapshot } from './orchestrationStateMachine.js';

const execFileAsync = promisify(execFile);
const MAX_DIFF_PREVIEW_CHARS = 96_000;
const MAX_DIFF_BUFFER_BYTES = 1_000_000;

export interface OrchestrationDiffPreview {
  baseCommit: string;
  resultCommit: string;
  branchName: string;
  changedPaths: string[];
  pathsTruncated: boolean;
  diff: string;
  truncated: boolean;
}

export interface FinalValidationEvidence extends Record<string, unknown> {
  validationVersion: 1;
  resultCommit: string;
  branchName: string;
  noOpenBlockingFindings: boolean;
  checks: {
    status: string;
    missingScripts: string[];
    observed: Array<{ exitCode: number | null; signal: string | null }>;
  };
}

export function getOrchestrationFinalValidationEvidence(
  snapshot: OrchestrationSnapshot,
  store: SQLiteService = sqliteService
): FinalValidationEvidence {
  const event = runWithWorkspace(snapshot.run.workspaceId, () =>
    store.listOrchestrationEvents(snapshot.run.id, 0, 500)
  ).reverse().find(candidate => {
    const evidence = candidate.payload.evidence;
    return candidate.type === 'run_awaiting_approval' && Boolean(evidence && typeof evidence === 'object' &&
      (evidence as Record<string, unknown>).validationVersion === 1);
  });
  const evidence = event?.payload.evidence;
  if (!evidence || typeof evidence !== 'object') {
    throw new Error('Final validation evidence is missing. Re-run the final checks before reviewing this build.');
  }
  const record = evidence as Record<string, unknown>;
  const checks = record.checks && typeof record.checks === 'object'
    ? record.checks as Record<string, unknown>
    : undefined;
  if (record.validationVersion !== 1 || typeof record.resultCommit !== 'string' ||
      !/^[a-f0-9]{40,64}$/i.test(record.resultCommit) || typeof record.branchName !== 'string' ||
      !checks || checks.status !== 'passed' || !Array.isArray(checks.missingScripts) || checks.missingScripts.length ||
      !Array.isArray(checks.observed) || checks.observed.length === 0 ||
      checks.observed.some(command => !command || typeof command !== 'object' ||
        (command as Record<string, unknown>).exitCode !== 0 || (command as Record<string, unknown>).signal !== null) ||
      record.noOpenBlockingFindings !== true) {
    throw new Error('Final validation evidence is incomplete or did not pass. Re-run the final checks before approval.');
  }
  return { ...record, checks } as FinalValidationEvidence;
}

export async function assertOrchestrationApprovalCheckpointCurrent(
  snapshot: OrchestrationSnapshot,
  store: SQLiteService = sqliteService
): Promise<void> {
  if (snapshot.run.status !== 'awaiting_approval') {
    throw new Error('This task build is no longer waiting for approval. Refresh its current state.');
  }
  const evidence = getOrchestrationFinalValidationEvidence(snapshot, store);
  const worktree = snapshot.run.worktreePath ? path.resolve(snapshot.run.worktreePath) : '';
  if (!worktree || !store.isPathAllowed(worktree) || !snapshot.run.branchName || evidence.branchName !== snapshot.run.branchName ||
      !(await isGitRepo(worktree))) {
    throw new Error('The reviewed task build workspace is unavailable or no longer authorized. Reconcile the build before approval.');
  }
  const [branchName, headCommit, clean] = await Promise.all([
    getCurrentBranch(worktree),
    getHeadCommit(worktree),
    isGitWorkingTreeClean(worktree)
  ]);
  if (branchName !== evidence.branchName || headCommit !== evidence.resultCommit || !clean) {
    throw new Error('The repository changed after final validation. Refresh and re-run the final checks before approval.');
  }
}

export async function getOrchestrationDiffPreview(
  snapshot: OrchestrationSnapshot,
  store: SQLiteService = sqliteService
): Promise<OrchestrationDiffPreview> {
  if (!['awaiting_approval', 'publishing', 'completed'].includes(snapshot.run.status)) {
    throw new Error('A code review is available after final validation.');
  }
  const evidence = getOrchestrationFinalValidationEvidence(snapshot, store);
  const baseCommit = snapshot.run.baseCommit;
  const resultCommit = evidence.resultCommit;
  const branchName = snapshot.run.branchName;
  const worktree = snapshot.run.worktreePath ? path.resolve(snapshot.run.worktreePath) : '';
  if (!baseCommit || !/^[a-f0-9]{40,64}$/i.test(baseCommit) || !branchName || evidence.branchName !== branchName ||
      !worktree || !store.isPathAllowed(worktree) || !(await isGitRepo(worktree))) {
    throw new Error('The validated build branch is unavailable for review.');
  }

  if (snapshot.run.status === 'awaiting_approval') {
    await assertOrchestrationApprovalCheckpointCurrent(snapshot, store);
  }

  const changedPaths = await getGitChangedPaths(worktree, baseCommit, resultCommit);
  let rawDiff = '';
  let truncated = false;
  try {
    const result = await execFileAsync('git', [
      'diff', '--no-ext-diff', '--no-color', '--no-renames', '--unified=3', baseCommit, resultCommit, '--'
    ], { cwd: worktree, encoding: 'utf8', maxBuffer: MAX_DIFF_BUFFER_BYTES, windowsHide: true });
    rawDiff = String(result.stdout ?? '');
  } catch (error) {
    const partial = (error as NodeJS.ErrnoException & { stdout?: string | Buffer }).stdout;
    if (partial === undefined || String(partial).length === 0) {
      throw new Error(`The validated change preview could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
    rawDiff = String(partial);
    truncated = true;
  }
  if (rawDiff.length > MAX_DIFF_PREVIEW_CHARS) {
    rawDiff = rawDiff.slice(0, MAX_DIFF_PREVIEW_CHARS);
    truncated = true;
  }

  return {
    baseCommit,
    resultCommit,
    branchName,
    changedPaths: changedPaths.slice(0, 200),
    pathsTruncated: changedPaths.length > 200,
    diff: rawDiff,
    truncated
  };
}
