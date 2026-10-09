import { Router } from 'express';

import { route } from './asyncRoute.js';
import {
  opaqueTicketRequestValue, pmTicketSubject, relayPmTicketRequest,
} from './ticketRequestAuth.js';
import type {
  TicketCommandReceipt, TicketOperationReceipt, TicketSubject, TicketTarget,
} from '../store/ticketCommandStore.js';
import { TicketReadInvariantError } from '../ticketing/readModels.js';
import type { TicketStatus } from '../ticketing/workflow.js';

export interface PmTicketCommandApplication {
  execute(target: TicketTarget, subject: TicketSubject, input: unknown): Promise<TicketCommandReceipt>;
  lookup(target: TicketTarget, subject: TicketSubject, operationId: string): Promise<TicketOperationReceipt | null>;
}

const statuses = new Set<TicketStatus>([
  'received', 'under_review', 'awaiting_client', 'in_progress', 'ready_for_review',
  'on_hold', 'closed', 'declined', 'cancelled',
]);

function safeReceipt(value: TicketOperationReceipt | null, ticketId?: string): object | null {
  if (value === null) return null;
  if (!value || !opaqueTicketRequestValue(value.ticketId) || (ticketId && value.ticketId !== ticketId)
    || !opaqueTicketRequestValue(value.operationId) || !Number.isSafeInteger(value.version)
    || value.version < 0 || !statuses.has(value.status)) throw new TicketReadInvariantError();
  const receipt = { ticketId: value.ticketId, operationId: value.operationId, version: value.version, status: value.status };
  if ('messageId' in value) {
    if (!opaqueTicketRequestValue(value.messageId)) throw new TicketReadInvariantError();
    return { ...receipt, messageId: value.messageId };
  }
  if ('reference' in value) {
    if (!opaqueTicketRequestValue(value.reference)) throw new TicketReadInvariantError();
    return { ...receipt, reference: value.reference };
  }
  return receipt;
}

/** PM command/read-recovery transport. Mount only after a durable ticket store exists. */
export function createTicketCommandRouter(
  application: PmTicketCommandApplication,
  relayRequest: typeof relayPmTicketRequest = relayPmTicketRequest,
): Router {
  const router = Router();

  router.get('/operations/:operationId', route(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private');
    if (await relayRequest(req, res)) return;
    const subject = pmTicketSubject(req, res);
    if (!subject) return;
    const ticketId = typeof req.query.ticketId === 'string' ? req.query.ticketId : '';
    if (!opaqueTicketRequestValue(ticketId) || !req.workspace) {
      return res.status(404).json({ error: 'Ticket operation not found.' });
    }
    const target: TicketTarget = { workspaceId: req.workspace.workspaceId, ticketId };
    const result = await application.lookup(target, subject, req.params.operationId ?? '');
    const receipt = safeReceipt(result, ticketId);
    if (!receipt) return res.status(404).json({ error: 'Ticket operation not found.' });
    return res.json(receipt);
  }));

  router.post('/:ticketId/commands', route(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (await relayRequest(req, res)) return;
    const subject = pmTicketSubject(req, res);
    if (!subject) return;
    const ticketId = req.params.ticketId ?? '';
    if (!opaqueTicketRequestValue(ticketId) || !req.workspace) {
      return res.status(404).json({ error: 'Ticket not found.' });
    }
    const target: TicketTarget = { workspaceId: req.workspace.workspaceId, ticketId };
    const result = await application.execute(target, subject, req.body);
    const receipt = safeReceipt(result, ticketId);
    if (!receipt) throw new TicketReadInvariantError();
    return res.json(receipt);
  }));

  return router;
}
