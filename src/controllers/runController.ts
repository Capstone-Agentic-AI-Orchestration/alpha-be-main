import { Request, Response, Router } from 'express';
import { runnerService } from '../services/runnerService.js';
import { squadRunner, SquadRunError } from '../services/squadRunner.js';
import { sqliteService } from '../services/sqliteService.js';
import { githubService } from '../services/githubService.js';
import { resolveProjectWorkspace } from '../services/workspaceService.js';
import { logError, logInfo } from '../utils/logger.js';

export const runRouter = Router();

runRouter.get('/runs', (req: Request, res: Response) => {
  res.json(sqliteService.getPrototypeRuns());
});

runRouter.post('/runs/start', async (req: Request, res: Response) => {
  try {
    const { issueId, agentId, plan, scenario } = req.body;
    if (!issueId || !agentId) {
      return res.status(400).json({ error: 'issueId and agentId are required' });
    }
    const run = await runnerService.startRun({
      issueId,
      agentId,
      plan: plan || [],
      scenario
    });
    res.status(201).json(run);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to start run' });
  }
});

runRouter.post('/runs/:id/cancel', async (req: Request, res: Response) => {
  try {
    await runnerService.cancelRun(req.params.id);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to cancel run' });
  }
});

/**
 * Approve or reject a run that is waiting at the review gate.
 *
 * The Inbox has had Approve and Request-changes buttons since it was written,
 * and neither reached the daemon: the run status moved to `validating` in React
 * state and the issue comment was appended to a local array. Both were gone on
 * reload, so a run stayed `awaiting_approval` in SQLite forever and the same
 * notification came back.
 *
 * The one part that was real is the PR merge, which the client dispatches
 * separately through the GitHub route.
 */
/**
 * Approve or reject a run at the review gate.
 *
 * Approving merges the pull request. It used to write a comment reading
 * "Merging <url>" and then not merge — the board said done while the pull
 * request stayed open on GitHub, which is the one thing a review gate must not
 * get wrong.
 *
 * A merge that fails leaves the run at the gate rather than reporting success.
 * Required checks still running, a conflict, a protected branch — all of those
 * are answerable by a person and then approvable again, so the honest state is
 * "still awaiting approval, and here is why".
 */
runRouter.post('/runs/:id/approve', async (req: Request, res: Response) => {
  const { approved } = req.body ?? {};
  if (typeof approved !== 'boolean') {
    return res.status(400).json({ error: 'approved must be a boolean' });
  }

  const run = sqliteService.getPrototypeRuns().find(r => r.id === req.params.id);
  if (!run) return res.status(404).json({ error: 'Run not found' });

  if (run.status !== 'awaiting_approval') {
    return res.status(409).json({
      error: `Run is ${run.status}, not awaiting approval.`
    });
  }

  const now = new Date().toISOString();

  if (!approved) {
    const rejected = { ...run, status: 'changes_requested' as any, updatedAt: now };
    sqliteService.savePrototypeRun(rejected);
    sqliteService.addIssueComment({
      id: `comm-${run.id}-rejected`,
      issueId: run.issueId,
      authorType: 'system',
      authorName: 'Alpha Execution Engine',
      content: 'Changes requested. The run stopped at the review gate.',
      createdAt: now
    });
    sqliteService.updateIssue(run.issueId, { status: 'todo' });
    return res.json(rejected);
  }

  /**
   * Merge, if there is something to merge.
   *
   * A run with no pull request is still approvable — a project with no remote
   * commits locally and never opens one, and that work is no less done.
   */
  let mergeNote = 'No pull request was opened, so there was nothing to merge.';

  if (run.prUrl) {
    const project = sqliteService.getProjects().find(p => p.id === run.projectId);
    const workspace = project ? resolveProjectWorkspace(project) : null;

    if (!workspace) {
      return res.status(409).json({
        error:
          `This run's project has no working copy on this machine, so ${run.prUrl} cannot be merged from here. ` +
          `Attach the repository to the project, or merge it on GitHub.`
      });
    }

    try {
      const result = await githubService.mergePullRequest(workspace.dir, run.prUrl);
      logInfo(`Merged ${run.prUrl} for run ${run.id}`);
      mergeNote = `Merged ${run.prUrl}.${result ? ` ${result}` : ''}`;
      // A person did this, not an agent — the trail should say so.
      sqliteService.recordRemoteAction({
        runId: run.id,
        agentId: run.agentId,
        issueId: run.issueId,
        actor: 'user',
        action: 'merge_pull_request',
        target: run.prUrl,
        detail: 'Approved at the review gate.',
        succeeded: true
      });
    } catch (err: any) {
      /**
       * The run stays at the gate.
       *
       * Marking it completed here would put the card in Done with the pull
       * request still open — the exact desynchronisation this endpoint exists
       * to prevent. gh's own message names the cause (checks pending, conflict,
       * protected branch) far better than anything this layer could infer.
       */
      const detail = String(err?.stderr || err?.message || err).trim();
      logError(`Merge failed for run ${run.id}:`, detail);
      sqliteService.recordRemoteAction({
        runId: run.id,
        agentId: run.agentId,
        issueId: run.issueId,
        actor: 'user',
        action: 'merge_pull_request',
        target: run.prUrl,
        detail,
        succeeded: false
      });

      sqliteService.addIssueComment({
        id: `comm-${run.id}-merge-failed-${Date.parse(now)}`,
        issueId: run.issueId,
        authorType: 'system',
        authorName: 'Alpha Execution Engine',
        content: `Approved, but ${run.prUrl} could not be merged:

${detail}

The run is still at the review gate.`,
        createdAt: now
      });

      return res.status(409).json({
        error: `Approved, but the pull request could not be merged: ${detail}`
      });
    }
  }

  const updated = { ...run, status: 'completed' as const, updatedAt: now };
  sqliteService.savePrototypeRun(updated);

  // Written to the comments table, not appended to an array in the browser.
  sqliteService.addIssueComment({
    id: `comm-${run.id}-approved`,
    issueId: run.issueId,
    authorType: 'system',
    authorName: 'Alpha Execution Engine',
    content: `Review approved. ${mergeNote}`,
    createdAt: now
  });

  sqliteService.updateIssue(run.issueId, { status: 'done' });
  res.json(updated);
});

/**
 * Everything that touched a remote during this run.
 *
 * Read from its own table rather than derived from stage logs: a log line is
 * overwritten by the next stage and says nothing about who acted. Alpha's own
 * pushes and the agent's arrive here side by side, distinguished by `actor`.
 */
runRouter.get('/runs/:id/remote-actions', (req: Request, res: Response) => {
  res.json(sqliteService.getRemoteActions(req.params.id));
});

runRouter.post('/runs/:id/retry', async (req: Request, res: Response) => {
  try {
    const existing = sqliteService.getPrototypeRuns().find(r => r.id === req.params.id);
    if (!existing) return res.status(404).json({ error: 'Run not found' });

    const newRun = await runnerService.startRun({
      issueId: existing.issueId,
      agentId: existing.agentId,
      plan: existing.plan,
      scenario: 'success'
    });
    res.status(201).json(newRun);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to retry run' });
  }
});

/**
 * Squad execution.
 *
 * The frontend's "run squad" button never called anything — it incremented a
 * counter and set a 4.5 second timer. This is what it calls now.
 */
runRouter.get('/squad-runs', (req: Request, res: Response) => {
  res.json(sqliteService.getSquadRuns());
});

runRouter.get('/squad-runs/:id', (req: Request, res: Response) => {
  const squadRun = sqliteService.getSquadRun(req.params.id);
  if (!squadRun) return res.status(404).json({ error: 'Squad run not found' });
  res.json({ ...squadRun, runs: sqliteService.getRunsForSquadRun(squadRun.id) });
});

runRouter.post('/squads/:id/run', async (req: Request, res: Response) => {
  try {
    const { issueId, plan, mission } = req.body;
    if (!issueId) return res.status(400).json({ error: 'issueId is required' });

    const squadRun = await squadRunner.startSquadRun({
      squadId: req.params.id,
      issueId,
      plan: plan || [],
      mission
    });
    res.status(201).json(squadRun);
  } catch (err: any) {
    // A squad that cannot run — unimplemented topology, no members, a missing
    // issue — is the caller's problem to fix and says so, rather than being
    // reported as an internal failure.
    const status = err instanceof SquadRunError ? 400 : 500;
    res.status(status).json({ error: err.message || 'Failed to start squad run' });
  }
});
