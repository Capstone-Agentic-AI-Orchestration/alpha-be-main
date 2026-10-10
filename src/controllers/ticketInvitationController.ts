import { Router } from 'express';

import { route } from './asyncRoute.js';
import { opaqueTicketRequestValue, pmTicketSubject, relayPmTicketRequest } from './ticketRequestAuth.js';
import type { TicketSubject, TicketTarget } from '../store/ticketCommandStore.js';
import type { TicketInvitationReceipt } from '../services/ticketInvitationService.js';
import { TicketReadInvariantError } from '../ticketing/readModels.js';

export interface TicketInvitationApplication {
  issue(target: TicketTarget, subject: TicketSubject): Promise<TicketInvitationReceipt>;
}

/**
 * PM-only invitation transport. Mount behind the existing cloud GitHub-session
 * and workspace middleware, inside the gated Phase 4 composition. It deliberately
 * accepts no recipient, role, workspace, or workflow fields from the request body.
 */
export function createTicketInvitationRouter(application: TicketInvitationApplication): Router {
  const router = Router();

  router.post('/:ticketId/invitations', route(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (await relayPmTicketRequest(req, res)) return;

    const workspace = req.workspace;
    const subject = pmTicketSubject(req, res);
    if (!subject) return;
    if (!workspace) throw new TicketReadInvariantError();
    const ticketId = req.params.ticketId ?? '';
    if (!opaqueTicketRequestValue(ticketId)) return res.status(404).json({ error: 'Ticket not found.', code: 'ticket_not_found' });
    const target: TicketTarget = { workspaceId: workspace.workspaceId, ticketId };
    const receipt = await application.issue(target, subject);

    // Project the response explicitly; no recipient, contact or provider data.
    if (!receipt || receipt.ticketId !== ticketId || !opaqueTicketRequestValue(receipt.invitationId)
      || typeof receipt.alreadyPending !== 'boolean'
      || !Number.isFinite(Date.parse(receipt.expiresAt))) {
      throw new TicketReadInvariantError();
    }
    return res.status(receipt.alreadyPending ? 200 : 201).json({
      invitationId: receipt.invitationId,
      ticketId,
      status: 'pending',
      expiresAt: receipt.expiresAt,
      alreadyPending: receipt.alreadyPending,
    });
  }));

  return router;
}
