import { Router } from 'express';

import { route } from './asyncRoute.js';
import { opaqueTicketRequestValue, pmTicketSubject, relayPmTicketRequest } from './ticketRequestAuth.js';
import type { TicketSubject, TicketTarget } from '../store/ticketCommandStore.js';
import type { TicketInvitationEmailReceipt } from '../store/ticketInvitationEmailPostgresStore.js';
import { TicketReadInvariantError } from '../ticketing/readModels.js';

export interface TicketInvitationEmailApplication {
  request(target: TicketTarget, subject: TicketSubject): Promise<TicketInvitationEmailReceipt>;
}

/** PM-only, email-only notice. It never accepts an email, role or account ID from the browser. */
export function createTicketInvitationEmailRouter(
  application: TicketInvitationEmailApplication,
  deliveryConfigured: boolean,
): Router {
  const router = Router({ caseSensitive: true, strict: true });

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
    if (!opaqueTicketRequestValue(ticketId)) {
      return res.status(404).json({ error: 'Ticket not found.', code: 'ticket_not_found' });
    }
    if (!req.is('application/json') || !req.body || typeof req.body !== 'object'
      || Array.isArray(req.body) || Object.keys(req.body).length !== 0) {
      return res.status(400).json({ error: 'This invitation request is invalid.', code: 'invalid_invitation_request' });
    }
    if (!deliveryConfigured) {
      return res.status(503).json({ error: 'Invitation email is not configured yet.', code: 'ticket_invitation_email_unavailable' });
    }

    const receipt = await application.request({ workspaceId: workspace.workspaceId, ticketId }, subject);
    if (!receipt || receipt.ticketId !== ticketId || !opaqueTicketRequestValue(receipt.deliveryId)
      || !['queued', 'accepted', 'failed'].includes(receipt.status) || typeof receipt.alreadyRequested !== 'boolean') {
      throw new TicketReadInvariantError();
    }
    return res.status(receipt.alreadyRequested ? 200 : 202).json({
      ticketId, deliveryId: receipt.deliveryId, status: receipt.status, alreadyRequested: receipt.alreadyRequested,
    });
  }));

  return router;
}
