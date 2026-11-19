import { Router } from 'express';

import { route } from './asyncRoute.js';
import { opaqueTicketRequestValue, pmTicketSubject, relayPmTicketRequest } from './ticketRequestAuth.js';
import type { TicketSubject, TicketTarget } from '../store/ticketCommandStore.js';
import type { TicketScopeProposalReceipt } from '../store/ticketScopeStore.js';
import { TicketReadInvariantError } from '../ticketing/readModels.js';

export interface PmTicketScopeApplication {
  propose(target: TicketTarget, subject: TicketSubject, input: unknown): Promise<TicketScopeProposalReceipt>;
}

function safeReceipt(value: TicketScopeProposalReceipt, ticketId: string): TicketScopeProposalReceipt {
  if (!value || value.ticketId !== ticketId || !opaqueTicketRequestValue(value.operationId)
    || !opaqueTicketRequestValue(value.scopeVersionId) || !Number.isSafeInteger(value.version)
    || value.version < 1 || (value.status !== 'awaiting_client' && value.status !== 'under_review')) {
    throw new TicketReadInvariantError();
  }
  return {
    ticketId: value.ticketId,
    operationId: value.operationId,
    version: value.version,
    status: value.status,
    scopeVersionId: value.scopeVersionId,
  };
}

/** PM-only scope proposal. Mount behind the internal session/workspace middleware. */
export function createTicketScopeRouter(application: PmTicketScopeApplication): Router {
  const router = Router();

  router.post('/:ticketId/scopes', route(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (await relayPmTicketRequest(req, res)) return;
    const subject = pmTicketSubject(req, res);
    if (!subject) return;
    const ticketId = req.params.ticketId ?? '';
    if (!opaqueTicketRequestValue(ticketId) || !req.workspace) {
      return res.status(404).json({ error: 'Ticket not found.' });
    }
    const target: TicketTarget = { workspaceId: req.workspace.workspaceId, ticketId };
    const receipt = await application.propose(target, subject, req.body);
    return res.json(safeReceipt(receipt, ticketId));
  }));

  return router;
}
