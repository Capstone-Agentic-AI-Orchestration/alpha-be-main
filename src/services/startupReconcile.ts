import { sqliteService } from './sqliteService.js';
import { updateIssueAndPush } from './boardWriteThrough.js';
import { logInfo, logError } from '../utils/logger.js';
import { PrototypeRun, SquadRun } from '../models/index.js';

/**
 * Close out work the daemon was doing when it last stopped.
 *
 * Runs execute in child processes owned by this daemon, and squad runs are
 * advanced by an in-memory listener map. Neither survives a restart — the child
 * is killed with its parent, and `squadRunner.awaiting` starts empty, its
 * listeners not even attached until the next squad is launched.
 *
 * What did survive was the database. A run interrupted mid-flight stayed
 * `running` for ever, its squad stayed `running`, and its issue stayed
 * `agent_running`, so the card sat in that column with no process behind it and
 * no way to clear it from the UI. Nothing at startup looked at any of it.
 *
 * These rows are not recoverable, only closeable: the branch and any commits
 * made before the interruption are still on disk, but the agent's session is
 * gone and its remaining work never happened. So they are marked failed with
 * the reason, and their issues go back to `in_progress` where a person can pick
 * them up again.
 *
 * Deliberately not a resume. Restarting an agent mid-task would replay part of
 * its work against a branch that already has some of it, and Alpha cannot tell
 * how far it got.
 */

/** Run states that mean "a process should be attached to this". */
const UNFINISHED_RUN_STATES = new Set(['queued', 'running', 'validating']);

export interface ReconcileResult {
  runs: string[];
  squadRuns: string[];
  issues: string[];
  agentCalls: string[];
}

/**
 * Split out from the daemon boot so it can be tested against a real database
 * without starting a server.
 */
export function reconcileInterruptedWork(now = new Date().toISOString()): ReconcileResult {
  const result: ReconcileResult = { runs: [], squadRuns: [], issues: [], agentCalls: [] };
  // These supervised turns and proposal runs are owned by the old daemon's
  // process tree. A saved queued/running row cannot be treated as live after a
  // restart, so close it and release its repository admission lock.
  result.agentCalls = sqliteService.reconcileInterruptedAgentCalls(now);

  const orphanedRuns = sqliteService
    .getPrototypeRuns()
    // Versioned task runs have their own durable recovery state machine. Let
    // that reconciler inspect their last checkpoint instead of flattening the
    // child into a legacy "failed" run before its parent workflow can inspect it.
    .filter(r => UNFINISHED_RUN_STATES.has(r.status) && !r.orchestrationRunId);

  const orphanedSquads = sqliteService
    .getSquadRuns()
    .filter(sr => sr.status === 'running');

  if (!orphanedRuns.length && !orphanedSquads.length) return result;

  for (const run of orphanedRuns) {
    const failed: PrototypeRun = {
      ...run,
      status: 'failed',
      // The stage that was in flight is the one that got cut off. A stage left
      // 'running' would keep a spinner turning for a run that has ended.
      stages: run.stages.map(s =>
        s.status === 'running'
          ? { ...s, status: 'failed' as const, completedAt: now, logs: [...s.logs, 'Interrupted: the Alpha daemon stopped while this stage was running.'] }
          : s
      ),
      testSummary: 'Run did not finish: the Alpha daemon stopped while it was in progress.',
      updatedAt: now
    };
    sqliteService.savePrototypeRun(failed);
    result.runs.push(run.id);
  }

  for (const squadRun of orphanedSquads) {
    const position = squadRun.currentMemberIndex + 1;
    const stopped: SquadRun = {
      ...squadRun,
      status: 'failed',
      stoppedReason:
        `The Alpha daemon stopped while member ${position} of ${squadRun.memberAgentIds.length} was working. ` +
        `Commits made before then are on \`${squadRun.branchName}\`.`,
      updatedAt: now
    };
    sqliteService.saveSquadRun(stopped);
    result.squadRuns.push(squadRun.id);
  }

  /**
   * Move the cards back, and say why on each one.
   *
   * Derived from the rows just closed rather than from a scan for
   * `agent_running`: an issue can sit in that column legitimately in the moment
   * between a run being created and its first stage landing, and this must not
   * sweep up work that a *running* daemon owns.
   */
  const affectedIssueIds = new Set([
    ...orphanedRuns.map(r => r.issueId),
    ...orphanedSquads.map(sr => sr.issueId)
  ]);

  for (const issueId of affectedIssueIds) {
    const issue = sqliteService.getIssues().find(i => i.id === issueId);
    if (!issue || issue.status !== 'agent_running') continue;

    /*
     * Through the board, not the data layer. A crash leaves the card reading
     * agent-running for the whole team, and nothing else will ever move it —
     * the run that would have is the one that died.
     */
    updateIssueAndPush(issueId, { status: 'in_progress' });
    result.issues.push(issueId);
  }

  return result;
}

/** Boot-time wrapper: never let a reconciliation failure stop the daemon. */
export function reconcileOnStartup() {
  try {
    const { runs, squadRuns, issues, agentCalls } = reconcileInterruptedWork();
    if (runs.length || squadRuns.length || agentCalls.length) {
      logInfo(
        `Closed work interrupted by a previous shutdown: ` +
        `${runs.length} run(s), ${squadRuns.length} squad run(s), ${agentCalls.length} independent call(s), ` +
        `${issues.length} issue(s) moved back to In Progress.`
      );
    }
  } catch (err) {
    logError('Could not reconcile interrupted work:', err);
  }
}
