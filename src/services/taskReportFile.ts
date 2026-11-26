import fs from 'node:fs';
import path from 'node:path';
import { RUNS_DIR } from '../config/env.js';

/**
 * Where a specialist's handed-in task report is saved for its run.
 *
 * The specialist hands in its report by calling project_submit_work on Alpha's task tools, which
 * checks it and writes it here. The run folder outlives the agent process (cleanupRunMcpConfig
 * removes only the turn's credential and instruction files), so the build reads it after exit.
 */
export function submittedReportPath(runId: string): string {
  return path.join(RUNS_DIR, runId, 'task-report.json');
}

/** The report this run handed in, or undefined when it handed in none. */
export function readSubmittedReport(runId: string): string | undefined {
  try {
    return fs.readFileSync(submittedReportPath(runId), 'utf8');
  } catch {
    return undefined;
  }
}
