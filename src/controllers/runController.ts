import { Request, Response, Router } from 'express';
import { runnerService } from '../services/runnerService.js';
import { squadRunner, SquadRunError } from '../services/squadRunner.js';
import { route } from './asyncRoute.js';
import { agentStore, issueStore, projectStore, runStore } from '../store/stores.js';
import { analyticsFrom } from '../services/runAnalytics.js';
import { githubService } from '../services/githubService.js';
import { resolveProjectWorkspace } from '../services/workspaceService.js';
import { logError, logInfo } from '../utils/logger.js';
import {
  requireEntityWorkspace,
  requireProjectWorkspace,
  requireSquadWorkspace,
  requireWorkspaceCapability
} from './workspaceContext.js';
import { workspaceRegistry } from '../services/workspaceRegistry.js';
import { IS_CLOUD } from '../config/env.js';
import { mergePullRequestOverApi } from '../services/githubPullRequests.js';
import { desktopOnly } from './desktopOnly.js';

export const runRouter = Router();

async function scopedRun(req: Request, res: Response, runId: string) {
  if (!requireEntityWorkspace(req, res, 'prototype_runs', runId)) return null;
  const run = await runStore().get(req.workspace!.workspaceId, runId);
  if (!run) {
    res.status(404).json({ error: 'Run not found' });
    return null;
  }
  if (!requireProjectWorkspace(req, res, run.projectId)) return null;
  return run;
}

async function scopedSquadRun(req: Request, res: Response, runId: string) {
  if (!requireEntityWorkspace(req, res, 'squad_runs', runId)) return null;
  const squadRun = await runStore().getSquadRun(req.workspace!.workspaceId, runId);
  if (!squadRun) {
    res.status(404).json({ error: 'Squad run not found' });
    return null;
  }
  if (!requireProjectWorkspace(req, res, squadRun.projectId)) return null;
  if (!workspaceRegistry.canAccessSquad(req.workspace!, squadRun.squadId)) {
    res.status(404).json({ error: 'Squad run not found' });
    return null;
  }
  if (!workspaceRegistry.squadAssignedToProject(req.workspace!, squadRun.squadId, squadRun.projectId)) {
    res.status(404).json({ error: 'Squad run not found' });
    return null;
  }
  return squadRun;
}

runRouter.get('/runs', route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'deployment.read')) return;
  const runs = (await runStore().list(req.workspace!.workspaceId))
    .filter(run => workspaceRegistry.canAccessProject(req.workspace!, run.projectId));
  res.json(runs);
}));

runRouter.get('/analytics', route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'analytics.read')) return;
  // Financial and token telemetry are intentionally not part of the product
  // contract. Persisted runner data may still contain it for migration, but
  // this endpoint exposes only workspace-scoped operational signals.
  const allRuns = await runStore().list(req.workspace!.workspaceId);
  const scopedRuns = allRuns.filter(run => workspaceRegistry.canAccessProject(req.workspace!, run.projectId));
  const all = analyticsFrom(allRuns, await agentStore().list(req.workspace!.workspaceId)) as any;
  const judged = scopedRuns.filter(run => ['completed', 'failed', 'cancelled', 'changes_requested'].includes(run.status));
  const completed = judged.filter(run => run.status === 'completed').length;
  const durations = scopedRuns
    .map(run => Date.parse(run.updatedAt) - Date.parse(run.createdAt))
    .filter(duration => Number.isFinite(duration) && duration >= 0);
  const bucketMs = 3 * 60 * 60 * 1000;
  const cutoffMs = Date.now() - 24 * 60 * 60 * 1000;
  const baseMs = Math.floor(cutoffMs / bucketMs) * bucketMs;
  const buckets = Array.from({ length: 8 }, (_, index) => ({
    hour: `${String(new Date(baseMs + index * bucketMs).getHours()).padStart(2, '0')}:00`,
    runs: 0,
    completed: 0,
    failed: 0
  }));
  for (const run of scopedRuns) {
    const index = Math.floor((Date.parse(run.createdAt) - baseMs) / bucketMs);
    if (index < 0 || index >= buckets.length) continue;
    buckets[index].runs += 1;
    if (run.status === 'completed') buckets[index].completed += 1;
    if (run.status === 'failed') buckets[index].failed += 1;
  }
  const fullWorkspace = scopedRuns.length === allRuns.length;
  res.json({
    totalRuns24h: scopedRuns.length,
    avgLatencyMs: durations.length ? Math.round(durations.reduce((sum, duration) => sum + duration, 0) / durations.length) : 0,
    totalAgentRuns: scopedRuns.length,
    successRate: judged.length ? Math.round((completed / judged.length) * 1000) / 10 : 0,
    runTimeline: buckets,
    agentBreakdown: fullWorkspace
      ? (all.agentBreakdown || []).map((item: any) => ({ agentId: item.agentId, agentName: item.agentName, runs: item.runs, efficiency: item.efficiency }))
      : [],
    modelBreakdown: fullWorkspace
      ? (all.modelBreakdown || []).map((item: any) => ({ modelName: item.modelName, percentage: item.percentage, totalCalls: item.totalCalls }))
      : []
  });
}));

runRouter.post('/runs/start', desktopOnly, async (req: Request, res: Response) => {
  try {
    if (!requireWorkspaceCapability(req, res, 'agent.run')) return;
    const { issueId, agentId, plan, scenario } = req.body;
    if (!issueId || !agentId) {
      return res.status(400).json({ error: 'issueId and agentId are required' });
    }
    if (!requireEntityWorkspace(req, res, 'issues', issueId)) return;
    if (!requireEntityWorkspace(req, res, 'agents', agentId)) return;
    const issue = await issueStore().get(req.workspace!.workspaceId, issueId);
    if (!issue) return res.status(404).json({ error: 'Issue not found' });
    if (!requireProjectWorkspace(req, res, issue.projectId)) return;
    const run = await runnerService.startRun({
      issueId,
      agentId,
      plan: plan || [],
      scenario
    });
    workspaceRegistry.bind('prototype_runs', run.id, req.workspace!.workspaceId);
    res.status(201).json(run);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to start run' });
  }
});

runRouter.post('/runs/:id/cancel', desktopOnly, async (req: Request, res: Response) => {
  try {
    if (!requireWorkspaceCapability(req, res, 'agent.run')) return;
    const run = await scopedRun(req, res, req.params.id);
    if (!run) return;
    await runnerService.cancelRun(req.params.id);
    res.json({ success: true });
  } catch (err: any) {
    const message = err.message || 'Failed to cancel run';
    const status = message.startsWith('Run not found') ? 404 : message.includes('not cancellable') ? 409 : 500;
    res.status(status).json({ error: message });
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
runRouter.post('/runs/:id/approve', route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'deployment.manage')) return;
  const run = await scopedRun(req, res, req.params.id);
  if (!run) return;
  const { approved } = req.body ?? {};
  if (typeof approved !== 'boolean') {
    return res.status(400).json({ error: 'approved must be a boolean' });
  }

  if (run.status !== 'awaiting_approval') {
    return res.status(409).json({
      error: `Run is ${run.status}, not awaiting approval.`
    });
  }

  const now = new Date().toISOString();

  if (!approved) {
    const rejected = { ...run, status: 'changes_requested' as any, updatedAt: now };
    await runStore().save(req.workspace!.workspaceId, rejected, req.workspace!.userId);
    await issueStore().addComment(req.workspace!.workspaceId, {
      id: `comm-${run.id}-rejected`,
      issueId: run.issueId,
      authorType: 'system',
      authorName: 'Alpha Execution Engine',
      content: 'Changes requested. The run stopped at the review gate.',
      createdAt: now
    });
    await issueStore().update(req.workspace!.workspaceId, run.issueId, { status: 'todo' });
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
    const project = await projectStore().get(req.workspace!.workspaceId, run.projectId);
    /**
     * In the cloud, through GitHub's API as the person approving. There is no
     * working copy on Render for `gh` to run in -- and approving is the one
     * thing a project manager on the web must be able to finish.
     */
    const workspace = IS_CLOUD ? null : project ? resolveProjectWorkspace(project) : null;

    if (!workspace && !IS_CLOUD) {
      return res.status(409).json({
        error:
          `This run's project has no working copy on this machine, so ${run.prUrl} cannot be merged from here. ` +
          `Attach the repository to the project, or merge it on GitHub.`
      });
    }

    try {
      const result = workspace
        ? await githubService.mergePullRequest(workspace.dir, run.prUrl)
        : await mergePullRequestOverApi(run.prUrl);
      logInfo(`Merged ${run.prUrl} for run ${run.id}`);
      mergeNote = `Merged ${run.prUrl}.${result ? ` ${result}` : ''}`;
      // A person did this, not an agent — the trail should say so.
      await runStore().recordRemoteAction(req.workspace!.workspaceId, {
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
      await runStore().recordRemoteAction(req.workspace!.workspaceId, {
        runId: run.id,
        agentId: run.agentId,
        issueId: run.issueId,
        actor: 'user',
        action: 'merge_pull_request',
        target: run.prUrl,
        detail,
        succeeded: false
      });

      await issueStore().addComment(req.workspace!.workspaceId, {
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
  await runStore().save(req.workspace!.workspaceId, updated, req.workspace!.userId);

  // Written to the comments table, not appended to an array in the browser.
  await issueStore().addComment(req.workspace!.workspaceId, {
    id: `comm-${run.id}-approved`,
    issueId: run.issueId,
    authorType: 'system',
    authorName: 'Alpha Execution Engine',
    content: `Review approved. ${mergeNote}`,
    createdAt: now
  });

  await issueStore().update(req.workspace!.workspaceId, run.issueId, { status: 'done' });
  res.json(updated);
}));

/**
 * Everything that touched a remote during this run.
 *
 * Read from its own table rather than derived from stage logs: a log line is
 * overwritten by the next stage and says nothing about who acted. Alpha's own
 * pushes and the agent's arrive here side by side, distinguished by `actor`.
 */
runRouter.get('/runs/:id/remote-actions', route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'deployment.read')) return;
  if (!(await scopedRun(req, res, req.params.id))) return;
  res.json(await runStore().listRemoteActions(req.workspace!.workspaceId, req.params.id));
}));

runRouter.post('/runs/:id/retry', desktopOnly, async (req: Request, res: Response) => {
  try {
    if (!requireWorkspaceCapability(req, res, 'agent.run')) return;
    const existing = await scopedRun(req, res, req.params.id);
    if (!existing) return;

    const newRun = await runnerService.startRun({
      issueId: existing.issueId,
      agentId: existing.agentId,
      plan: existing.plan,
      scenario: 'success'
    });
    workspaceRegistry.bind('prototype_runs', newRun.id, req.workspace!.workspaceId);
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
runRouter.get('/squad-runs', route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'squad.read')) return;
  const runs = (await runStore().listSquadRuns(req.workspace!.workspaceId))
    .filter(run => workspaceRegistry.canAccessProject(req.workspace!, run.projectId))
    .filter(run => workspaceRegistry.canAccessSquad(req.workspace!, run.squadId))
    .filter(run => workspaceRegistry.squadAssignedToProject(req.workspace!, run.squadId, run.projectId));
  res.json(runs);
}));

runRouter.get('/squad-runs/:id', route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'squad.read')) return;
  const squadRun = await scopedSquadRun(req, res, req.params.id);
  if (!squadRun) return;
  res.json({ ...squadRun, runs: await runStore().runsForSquadRun(req.workspace!.workspaceId, squadRun.id) });
}));

runRouter.post('/squads/:id/run', desktopOnly, async (req: Request, res: Response) => {
  try {
    if (!requireWorkspaceCapability(req, res, 'squad.run')) return;
    if (!requireSquadWorkspace(req, res, req.params.id)) return;
    const { issueId, plan, mission } = req.body;
    if (!issueId) return res.status(400).json({ error: 'issueId is required' });
    if (!requireEntityWorkspace(req, res, 'issues', issueId)) return;
    const issue = await issueStore().get(req.workspace!.workspaceId, issueId);
    if (!issue) return res.status(404).json({ error: 'Issue not found' });
    if (!requireProjectWorkspace(req, res, issue.projectId)) return;
    if (!workspaceRegistry.squadAssignedToProject(req.workspace!, req.params.id, issue.projectId)) {
      return res.status(409).json({ error: 'Assign this squad to the project before starting a squad run.' });
    }

    const squadRun = await squadRunner.startSquadRun({
      squadId: req.params.id,
      issueId,
      plan: plan || [],
      mission
    });
    workspaceRegistry.bind('squad_runs', squadRun.id, req.workspace!.workspaceId);
    for (const run of await runStore().runsForSquadRun(req.workspace!.workspaceId, squadRun.id)) {
      workspaceRegistry.bind('prototype_runs', run.id, req.workspace!.workspaceId);
    }
    res.status(201).json(squadRun);
  } catch (err: any) {
    // A squad that cannot run — unimplemented topology, no members, a missing
    // issue — is the caller's problem to fix and says so, rather than being
    // reported as an internal failure.
    const status = err instanceof SquadRunError ? 400 : 500;
    res.status(status).json({ error: err.message || 'Failed to start squad run' });
  }
});
