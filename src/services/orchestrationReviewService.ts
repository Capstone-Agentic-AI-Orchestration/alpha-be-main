import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { getCurrentBranch, getGitChangedPaths, getHeadCommit, isGitRepo, isGitWorkingTreeClean } from '../utils/gitUtils.js';
import { sqliteService, type SQLiteService } from './sqliteService.js';
import { runWithWorkspace } from './workspaceContext.js';
import type { OrchestrationSnapshot } from './orchestrationStateMachine.js';
import { repositoryWorkspaceForRun } from './orchestrationWorkspace.js';

const execFileAsync = promisify(execFile);
const MAX_DIFF_PREVIEW_CHARS = 96_000;
const MAX_DIFF_BUFFER_BYTES = 1_000_000;

export interface OrchestrationDiffPreview {
  reviewType: 'validated' | 'saved_checkpoint';
  repository?: string;
  baseCommit: string;
  resultCommit: string;
  branchName: string;
  changedPaths: string[];
  pathsTruncated: boolean;
  diff: string;
  truncated: boolean;
  repositories?: Array<{
    reviewType: 'validated' | 'saved_checkpoint';
    repository: string;
    baseCommit: string;
    resultCommit: string;
    branchName: string;
    changedPaths: string[];
    pathsTruncated: boolean;
    diff: string;
    truncated: boolean;
  }>;
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
  repositories?: Array<{
    repository: string;
    baseCommit: string;
    resultCommit: string;
    branchName: string;
    checks: {
      status: string;
      missingScripts: string[];
      observed: Array<{ exitCode: number | null; signal: string | null }>;
    };
  }>;
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
  if (Array.isArray(record.repositories) && record.repositories.some(item => {
    if (!item || typeof item !== 'object') return true;
    const repository = item as Record<string, unknown>;
    const repoChecks = repository.checks && typeof repository.checks === 'object' ? repository.checks as Record<string, unknown> : undefined;
    return typeof repository.repository !== 'string' || typeof repository.baseCommit !== 'string' || !/^[a-f0-9]{40,64}$/i.test(repository.baseCommit) ||
      typeof repository.resultCommit !== 'string' || !/^[a-f0-9]{40,64}$/i.test(repository.resultCommit) ||
      typeof repository.branchName !== 'string' || !repoChecks || repoChecks.status !== 'passed' ||
      !Array.isArray(repoChecks.missingScripts) || repoChecks.missingScripts.length > 0 ||
      !Array.isArray(repoChecks.observed) || repoChecks.observed.length === 0 ||
      repoChecks.observed.some(command => !command || typeof command !== 'object' ||
        (command as Record<string, unknown>).exitCode !== 0 || (command as Record<string, unknown>).signal !== null);
  })) {
    throw new Error('At least one selected codebase has incomplete final-check evidence. Run the final checks again before approval.');
  }
  const workspaces = snapshot.run.repositoryWorkspaces ?? [];
  const repositoryEvidence = Array.isArray(record.repositories)
    ? record.repositories as Array<Record<string, unknown>> : undefined;
  if (workspaces.length > 1 && (!repositoryEvidence || repositoryEvidence.length !== workspaces.length ||
      workspaces.some(workspace => !repositoryEvidence.some(item => item.repository === workspace.repository)))) {
    throw new Error('Final checks are missing for one or more selected codebases. Run checks for every codebase before approval.');
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
  const workspaces = snapshot.run.repositoryWorkspaces?.length
    ? snapshot.run.repositoryWorkspaces
    : [repositoryWorkspaceForRun(snapshot.run, snapshot.run.repository)].filter((item): item is NonNullable<typeof item> => Boolean(item));
  for (const workspace of workspaces) {
    const repoEvidence = Array.isArray(evidence.repositories)
      ? evidence.repositories.find(item => item && typeof item === 'object' && (item as Record<string, unknown>).repository === workspace.repository) as Record<string, unknown> | undefined
      : undefined;
    const expectedCommit = typeof repoEvidence?.resultCommit === 'string' ? repoEvidence.resultCommit : evidence.resultCommit;
    const expectedBranch = typeof repoEvidence?.branchName === 'string' ? repoEvidence.branchName : evidence.branchName;
    const worktree = path.resolve(workspace.worktreePath);
    if (!worktree || !store.isPathAllowed(worktree) || workspace.branchName !== expectedBranch || !(await isGitRepo(worktree))) {
      throw new Error(`The reviewed workspace for ${workspace.repository} is unavailable or no longer authorized. Reconcile the build before approval.`);
    }
    const [branchName, headCommit, clean] = await Promise.all([getCurrentBranch(worktree), getHeadCommit(worktree), isGitWorkingTreeClean(worktree)]);
    if (branchName !== expectedBranch || headCommit !== expectedCommit || !clean) {
      throw new Error(`${workspace.repository} changed after final checks. Refresh and run the final checks again before approval.`);
    }
  }
}

export async function getOrchestrationDiffPreview(
  snapshot: OrchestrationSnapshot,
  store: SQLiteService = sqliteService
): Promise<OrchestrationDiffPreview> {
  const validated = ['awaiting_approval', 'publishing', 'completed'].includes(snapshot.run.status);
  const savedCheckpoint = ['blocked', 'failed', 'recovery_required', 'paused', 'cancelled'].includes(snapshot.run.status);
  if (!validated && !savedCheckpoint) throw new Error('Code review becomes available after Alpha saves a task checkpoint.');
  const evidence = validated ? getOrchestrationFinalValidationEvidence(snapshot, store) : undefined;
  if (snapshot.run.status === 'awaiting_approval') await assertOrchestrationApprovalCheckpointCurrent(snapshot, store);
  const workspaces = snapshot.run.repositoryWorkspaces?.length
    ? snapshot.run.repositoryWorkspaces
    : [repositoryWorkspaceForRun(snapshot.run, snapshot.run.repository)].filter((item): item is NonNullable<typeof item> => Boolean(item));
  const previews = [];
  for (const workspace of workspaces) {
    const repoEvidence = Array.isArray(evidence?.repositories)
      ? evidence.repositories.find(item => item && typeof item === 'object' && (item as Record<string, unknown>).repository === workspace.repository) as Record<string, unknown> | undefined
      : undefined;
    const latestCheckpoint = savedCheckpoint ? [...snapshot.attempts].reverse().find(attempt => {
      const task = snapshot.tasks.find(candidate => candidate.id === attempt.taskId);
      return Boolean(attempt.resultCommit && /^[a-f0-9]{40,64}$/i.test(attempt.resultCommit) && task &&
        (task.repository ?? snapshot.run.repository).toLowerCase() === workspace.repository.toLowerCase());
    }) : undefined;
    const baseCommit = validated
      ? typeof repoEvidence?.baseCommit === 'string' ? repoEvidence.baseCommit : workspace.baseCommit
      : workspace.baseCommit;
    const resultCommit = validated
      ? typeof repoEvidence?.resultCommit === 'string' ? repoEvidence.resultCommit : evidence!.resultCommit
      : latestCheckpoint?.resultCommit ?? workspace.baseCommit;
    const branchName = validated
      ? typeof repoEvidence?.branchName === 'string' ? repoEvidence.branchName : evidence!.branchName
      : workspace.branchName;
    const worktree = path.resolve(workspace.worktreePath);
    if (!baseCommit || !/^[a-f0-9]{40,64}$/i.test(baseCommit) || !resultCommit || !/^[a-f0-9]{40,64}$/i.test(resultCommit) ||
        !branchName || workspace.branchName !== branchName ||
        !store.isPathAllowed(worktree) || !(await isGitRepo(worktree))) {
      throw new Error(`The saved build branch for ${workspace.repository} is unavailable for review.`);
    }
    if (savedCheckpoint) {
      const [currentBranch, headCommit] = await Promise.all([getCurrentBranch(worktree), getHeadCommit(worktree)]);
      if (currentBranch !== branchName) throw new Error(`The saved checkpoint branch for ${workspace.repository} changed. Preserve it and reconcile the build before review.`);
      try {
        await execFileAsync('git', ['cat-file', '-e', `${baseCommit}^{commit}`], { cwd: worktree, windowsHide: true });
        await execFileAsync('git', ['cat-file', '-e', `${resultCommit}^{commit}`], { cwd: worktree, windowsHide: true });
        await execFileAsync('git', ['merge-base', '--is-ancestor', baseCommit, resultCommit], { cwd: worktree, windowsHide: true });
        await execFileAsync('git', ['merge-base', '--is-ancestor', resultCommit, headCommit], { cwd: worktree, windowsHide: true });
      } catch {
        throw new Error(`Alpha could not verify the saved checkpoint for ${workspace.repository} on its build branch. Review the repository state before retrying.`);
      }
    }
    const changedPaths = await getGitChangedPaths(worktree, baseCommit, resultCommit);
    let rawDiff = '';
    let truncated = false;
    try {
      const result = await execFileAsync('git', ['diff', '--no-ext-diff', '--no-color', '--no-renames', '--unified=3', baseCommit, resultCommit, '--'],
        { cwd: worktree, encoding: 'utf8', maxBuffer: MAX_DIFF_BUFFER_BYTES, windowsHide: true });
      rawDiff = String(result.stdout ?? '');
    } catch (error) {
      const partial = (error as NodeJS.ErrnoException & { stdout?: string | Buffer }).stdout;
      if (partial === undefined || String(partial).length === 0) throw new Error(`The ${validated ? 'validated change' : 'saved checkpoint'} preview for ${workspace.repository} could not be read: ${error instanceof Error ? error.message : String(error)}`);
      rawDiff = String(partial);
      truncated = true;
    }
    if (rawDiff.length > MAX_DIFF_PREVIEW_CHARS) { rawDiff = rawDiff.slice(0, MAX_DIFF_PREVIEW_CHARS); truncated = true; }
    previews.push({ reviewType: validated ? 'validated' as const : 'saved_checkpoint' as const, repository: workspace.repository, baseCommit, resultCommit, branchName,
      changedPaths: changedPaths.slice(0, 200), pathsTruncated: changedPaths.length > 200, diff: rawDiff, truncated });
  }
  const primary = previews[0];
  if (!primary) throw new Error('No codebase is available to review.');
  if (savedCheckpoint && previews.every(preview => preview.resultCommit === preview.baseCommit && !preview.diff)) {
    throw new Error('No committed task checkpoint is available to review yet. Alpha will preserve the branch and show its failure details in the project chat.');
  }
  return { ...primary, reviewType: validated ? 'validated' : 'saved_checkpoint', repositories: previews };
}
