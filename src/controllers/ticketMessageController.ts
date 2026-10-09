import { Router, type Request, type Response } from 'express';

import { route } from './asyncRoute.js';
import { opaqueTicketRequestValue, pmTicketSubject, relayPmTicketRequest } from './ticketRequestAuth.js';
import type { TicketMessageReceipt, TicketSubject, TicketTarget } from '../store/ticketCommandStore.js';
import { TicketReadInvariantError } from '../ticketing/readModels.js';
import type { TicketStatus } from '../ticketing/workflow.js';

export interface PmTicketMessageApplication {
  reply(target: TicketTarget, subject: TicketSubject, input: unknown): Promise<TicketMessageReceipt>;
  note(target: TicketTarget, subject: TicketSubject, input: unknown): Promise<TicketMessageReceipt>;
}

const statuses = new Set<TicketStatus>([
  'received', 'under_review', 'awaiting_client', 'in_progress', 'ready_for_review',
  'on_hold', 'closed', 'declined', 'cancelled',
]);

function safeReceipt(value: TicketMessageReceipt, ticketId: string): TicketMessageReceipt {
  if (!value || value.ticketId !== ticketId || !opaqueTicketRequestValue(value.operationId)
    || !opaqueTicketRequestValue(value.messageId) || !Number.isSafeInteger(value.version)
    || value.version < 0 || !statuses.has(value.status)) throw new TicketReadInvariantError();
  return {
    ticketId: value.ticketId, operationId: value.operationId,
    messageId: value.messageId, version: value.version, status: value.status,
  };
}

/** PM public replies and private notes; mount behind internal session/workspace middleware. */
export function createTicketMessageRouter(
  application: PmTicketMessageApplication,
  relayRequest: typeof relayPmTicketRequest = relayPmTicketRequest,
): Router {
  const router = Router();

  async function write(req: Request, res: Response, kind: 'reply' | 'note'): Promise<unknown> {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (await relayRequest(req, res)) return;
    const subject = pmTicketSubject(req, res);
    if (!subject) return;
    const ticketId = req.params.ticketId ?? '';
    const workspaceId = req.workspace?.workspaceId;
    if (!workspaceId || !opaqueTicketRequestValue(ticketId)) {
      return res.status(404).json({ error: 'Ticket not found.' });
    }
    const target = { workspaceId, ticketId };
    const receipt = kind === 'reply'
      ? await application.reply(target, subject, req.body)
      : await application.note(target, subject, req.body);
    return res.json(safeReceipt(receipt, ticketId));
  }

  router.post('/:ticketId/messages', route((req, res) => write(req, res, 'reply')));
  router.post('/:ticketId/notes', route((req, res) => write(req, res, 'note')));
  return router;
}
