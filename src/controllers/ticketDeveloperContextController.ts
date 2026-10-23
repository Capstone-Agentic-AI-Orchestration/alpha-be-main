import { Router } from 'express';

import type { DeveloperTicketWorkContext } from '../ticketing/developerContext.js';
import { TicketReadInvariantError } from '../ticketing/readModels.js';
import type { TicketSubject } from '../store/ticketCommandStore.js';
import { route } from './asyncRoute.js';
import { assignedWorkTicketSubject, opaqueTicketRequestValue, relayPmTicketRequest } from './ticketRequestAuth.js';

export interface TicketDeveloperContextApplication {
  read(workspaceId: string, issueId: string, subject: TicketSubject): Promise<DeveloperTicketWorkContext>;
}

function safeWorkContext(value: DeveloperTicketWorkContext): DeveloperTicketWorkContext {
  if (!value || !opaqueTicketRequestValue(value.ticketReference)
    || !Number.isSafeInteger(value.ticketVersion) || value.ticketVersion < 0
    || !opaqueTicketRequestValue(value.issueId) || !opaqueTicketRequestValue(value.projectId)
    || !opaqueTicketRequestValue(value.issueRevisionId) || !opaqueTicketRequestValue(value.scopeVersionId)
    || typeof value.brief !== 'string' || value.brief.trim().length === 0 || value.brief.length > 12000) {
    throw new TicketReadInvariantError();
  }
  if (value.correction !== null && (!value.correction || typeof value.correction.instructions !== 'string'
    || !value.correction.instructions.trim().length || value.correction.instructions.length > 4000
    || typeof value.correction.authorizedAt !== 'string' || !Number.isFinite(Date.parse(value.correction.authorizedAt)))) {
    throw new TicketReadInvariantError();
  }
  // Explicit projection: never serialize store data, conversation, client
  // contact, PM notes, unrelated Issues, or unpublished delivery material.
  return {
    ticketReference: value.ticketReference,
    ticketVersion: value.ticketVersion,
    issueId: value.issueId,
    projectId: value.projectId,
    issueRevisionId: value.issueRevisionId,
    scopeVersionId: value.scopeVersionId,
    brief: value.brief,
    correction: value.correction ? { instructions: value.correction.instructions, authorizedAt: value.correction.authorizedAt } : null,
  };
}

/** Read-only assigned Issue context. This endpoint never starts or retries work. */
export function createTicketDeveloperContextRouter(application: TicketDeveloperContextApplication): Router {
  const router = Router();
  router.get('/issues/:issueId/work-context', route(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (await relayPmTicketRequest(req, res)) return;

    const subject = assignedWorkTicketSubject(req, res);
    if (!subject) return;
    const workspaceId = req.workspace?.workspaceId;
    const issueId = req.params.issueId ?? '';
    if (!opaqueTicketRequestValue(workspaceId) || !opaqueTicketRequestValue(issueId)) {
      return res.status(404).json({ error: 'Task not found.' });
    }

    const workContext = safeWorkContext(await application.read(workspaceId, issueId, subject));
    if (workContext.issueId !== issueId) throw new TicketReadInvariantError();
    return res.json({ workContext });
  }));
  return router;
}
