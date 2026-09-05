import { Request, Response, Router } from 'express';
import { runnerService } from '../services/runnerService.js';
import { squadRunner, SquadRunError } from '../services/squadRunner.js';
import { sqliteService } from '../services/sqliteService.js';

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
runRouter.post('/runs/:id/approve', (req: Request, res: Response) => {
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
  const updated = { ...run, status: approved ? ('completed' as const) : ('changes_requested' as any), updatedAt: now };
  sqliteService.savePrototypeRun(updated);

  // Written to the comments table, not appended to an array in the browser.
  sqliteService.addIssueComment({
    id: `comm-${run.id}-${approved ? 'approved' : 'rejected'}`,
    issueId: run.issueId,
    authorType: 'system',
    authorName: 'Alpha Execution Engine',
    content: approved
      ? `Review approved. ${run.prUrl ? `Merging ${run.prUrl}.` : 'No pull request to merge.'}`
      : 'Changes requested. The run stopped at the review gate.',
    createdAt: now
  });

  sqliteService.updateIssue(run.issueId, { status: approved ? 'done' : 'todo' });
  res.json(updated);
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
