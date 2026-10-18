import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import type { TransactionalSql } from '../store/database.js';
import type { TicketLifecycleRuntime } from '../services/ticketLifecycleRuntime.js';
import { loadTicketWorkContext } from '../store/ticketExecutionPostgresStore.js';
import { projectDeveloperTicketContext } from '../ticketing/developerContext.js';
import { route } from './asyncRoute.js';
import { assignedWorkTicketSubject, opaqueTicketRequestValue, relayPmTicketRequest } from './ticketRequestAuth.js';
import { requireWorkspaceCapability } from './workspaceContext.js';

function workflowUnavailable(res: import('express').Response) {
  res.status(503).json({ error: 'Project-linked ticket execution is not enabled in this environment.' });
}
/** Internal developer lifecycle boundary. Desktop callers relay to the cloud;
 * ticket authority always comes from the cloud transaction. */
export function createTicketExecutionRouter(db: TransactionalSql, runtime: TicketLifecycleRuntime | null): Router {
  const router = Router({ caseSensitive: true, strict: true });
  router.get('/workflow-capabilities', route(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (await relayPmTicketRequest(req, res)) return;
    if (!requireWorkspaceCapability(req, res, 'issue.read')) return;
    return res.json({ phaseWorkflowEnabled: runtime?.enabled === true });
  }));

  router.get('/issues/:issueId/work-context', route(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (await relayPmTicketRequest(req, res)) return;
    if (!runtime?.enabled) return workflowUnavailable(res);
    const subject = assignedWorkTicketSubject(req, res);
    if (!subject) return;
    const workspaceId = req.workspace?.workspaceId ?? '';
    const issueId = req.params.issueId ?? '';
    if (!opaqueTicketRequestValue(workspaceId) || !opaqueTicketRequestValue(issueId)) return res.status(404).json({ error: 'Issue work not found.' });
    const snapshot = await db.transaction(sql => loadTicketWorkContext(sql, { workspaceId, issueId }, subject));
    if (!snapshot) return res.status(404).json({ error: 'Issue work not found.' });
    return res.json({ workContext: projectDeveloperTicketContext(workspaceId, issueId, subject.userId, snapshot) });
  }));

  router.post('/issues/:issueId/reservations', route(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (await relayPmTicketRequest(req, res)) return;
    if (!runtime?.enabled) return workflowUnavailable(res);
    const subject = assignedWorkTicketSubject(req, res);
    if (!subject) return;
    const workspaceId = req.workspace?.workspaceId ?? '';
    const issueId = req.params.issueId ?? '';
    if (!opaqueTicketRequestValue(workspaceId) || !opaqueTicketRequestValue(issueId)) return res.status(404).json({ error: 'Issue work not found.' });
    const runId = `ticket-run-${randomUUID()}`;
    const result = await runtime.reserve({ workspaceId, issueId }, subject, {
      operationId: typeof req.body?.operationId === 'string' ? req.body.operationId : `reserve-${randomUUID()}`,
      executor: req.body?.executor,
      runId,
    });
    if (result.kind === 'unlinked') return res.json(result);
    if (!opaqueTicketRequestValue(result.receipt.claimId) || result.runId !== runId
      || !opaqueTicketRequestValue(result.verificationId) || result.context.issueId !== issueId) {
      throw new Error('Invalid ticket execution reservation.');
    }
    return res.json({ kind: result.kind, claimId: result.receipt.claimId, issueRevisionId: result.receipt.issueRevisionId,
      runId: result.runId, workContext: result.context });
  }));

  router.post('/issues/:issueId/admissions', route(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (await relayPmTicketRequest(req, res)) return;
    if (!runtime?.enabled) return workflowUnavailable(res);
    const subject = assignedWorkTicketSubject(req, res);
    if (!subject) return;
    const workspaceId = req.workspace?.workspaceId ?? '';
    const issueId = req.params.issueId ?? '';
    if (!opaqueTicketRequestValue(workspaceId) || !opaqueTicketRequestValue(issueId)) return res.status(404).json({ error: 'Issue work not found.' });
    const result = await runtime.admit({ workspaceId, issueId }, subject, req.body);
    if (!result.context || result.context.issueId !== issueId || typeof result.launch !== 'boolean') throw new Error('Invalid ticket execution admission.');
    return res.json({ launch: result.launch, workContext: result.context });
  }));

  router.post('/issues/:issueId/claims/:claimId/stop', route(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (await relayPmTicketRequest(req, res)) return;
    if (!runtime?.enabled) return workflowUnavailable(res);
    const subject = assignedWorkTicketSubject(req, res);
    if (!subject) return;
    const workspaceId = req.workspace?.workspaceId ?? '';
    const issueId = req.params.issueId ?? '';
    const claimId = req.params.claimId ?? '';
    if (!opaqueTicketRequestValue(workspaceId) || !opaqueTicketRequestValue(issueId) || !opaqueTicketRequestValue(claimId)) {
      return res.status(404).json({ error: 'Issue work not found.' });
    }
    await runtime.stop({ workspaceId, issueId }, subject, claimId);
    return res.json({ stopped: true });
  }));

  router.post('/issues/:issueId/review', route(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (await relayPmTicketRequest(req, res)) return;
    if (!runtime?.enabled) return workflowUnavailable(res);
    const subject = assignedWorkTicketSubject(req, res);
    if (!subject) return;
    if (!requireWorkspaceCapability(req, res, 'issue.manage')) return;
    const workspaceId = req.workspace?.workspaceId ?? '';
    const issueId = req.params.issueId ?? '';
    if (!opaqueTicketRequestValue(workspaceId) || !opaqueTicketRequestValue(issueId)) return res.status(404).json({ error: 'Issue work not found.' });
    const runId = req.body?.runId;
    if (runId !== undefined && !opaqueTicketRequestValue(runId)) return res.status(400).json({ error: 'Invalid review evidence.' });
    const decision = req.body?.decision ?? 'passed';
    if (decision !== 'passed' && decision !== 'changes_requested') {
      return res.status(400).json({ error: 'Invalid review decision.' });
    }
    if (decision === 'changes_requested') {
      if (!runId) return res.status(400).json({ error: 'A run ID is required when requesting changes.' });
      return res.json(await runtime.stopReviewedRun({ workspaceId, issueId }, subject, runId));
    }
    return res.json(await runtime.completeReviewedIssue({ workspaceId, issueId }, subject, runId));
  }));

  return router;
}
