import { Router } from 'express';
import { route } from './asyncRoute.js';
import { opaqueTicketRequestValue, pmTicketSubject, relayPmTicketRequest } from './ticketRequestAuth.js';
import type { TicketSubject, TicketTarget } from '../store/ticketCommandStore.js';
import type { TicketProjectLinkReceipt } from '../store/ticketProjectManagementStore.js';
import type { TicketStatus } from '../ticketing/workflow.js';
import { TicketReadInvariantError } from '../ticketing/readModels.js';

export interface TicketProjectManagementApplication {
  linkProject(target: TicketTarget, subject: TicketSubject, input: unknown): Promise<TicketProjectLinkReceipt>;
  setClientRequestsEnabled(target: TicketTarget, subject: TicketSubject, input: unknown): Promise<{ ticketId: string; acceptsNewRequests: boolean }>;
}

const statuses = new Set<TicketStatus>([
  'received', 'under_review', 'awaiting_client', 'in_progress', 'ready_for_review',
  'on_hold', 'closed', 'declined', 'cancelled',
]);
function headers(res: import('express').Response): void {
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}
function safeLinkReceipt(value: TicketProjectLinkReceipt, ticketId: string): TicketProjectLinkReceipt {
  if (!value || value.ticketId !== ticketId || !opaqueTicketRequestValue(value.operationId)
    || !Number.isSafeInteger(value.version) || value.version < 0 || !statuses.has(value.status)
    || (value.projectId !== null && !opaqueTicketRequestValue(value.projectId))
    || (value.projectName !== null && (typeof value.projectName !== 'string' || !value.projectName.trim()
      || value.projectName.trim() !== value.projectName || value.projectName.length > 200))
    || typeof value.clientVisible !== 'boolean'
    || ((value.projectId === null) !== (value.projectName === null))
    || (value.projectId === null && value.clientVisible)) throw new TicketReadInvariantError();
  return {
    ticketId, operationId: value.operationId, version: value.version,
    status: value.status, projectId: value.projectId, projectName: value.projectName,
    clientVisible: value.clientVisible,
  };
}

/** PM-only controls. Project links change organization/approved preview only;
 * they do not grant project or Issue access to the client.
 */
export function createTicketProjectManagementRouter(
  application: TicketProjectManagementApplication,
  relayRequest: typeof relayPmTicketRequest = relayPmTicketRequest,
): Router {
  const router = Router();
  router.put('/:ticketId/project', route(async (req, res) => {
    headers(res);
    if (await relayRequest(req, res)) return;
    const subject = pmTicketSubject(req, res);
    if (!subject) return;
    const ticketId = req.params.ticketId ?? '';
    const workspaceId = req.workspace?.workspaceId;
    if (!opaqueTicketRequestValue(ticketId) || !opaqueTicketRequestValue(workspaceId)) {
      return res.status(404).json({ error: 'Ticket not found.' });
    }
    const target = { workspaceId, ticketId };
    return res.json(safeLinkReceipt(await application.linkProject(target, subject, req.body), ticketId));
  }));
  router.put('/:ticketId/client-requests', route(async (req, res) => {
    headers(res);
    if (await relayRequest(req, res)) return;
    const subject = pmTicketSubject(req, res);
    if (!subject) return;
    const ticketId = req.params.ticketId ?? '';
    const workspaceId = req.workspace?.workspaceId;
    if (!opaqueTicketRequestValue(ticketId) || !opaqueTicketRequestValue(workspaceId)) {
      return res.status(404).json({ error: 'Ticket not found.' });
    }
    const result = await application.setClientRequestsEnabled({ workspaceId, ticketId }, subject, req.body);
    if (result.ticketId !== ticketId || typeof result.acceptsNewRequests !== 'boolean') throw new TicketReadInvariantError();
    return res.json({ ticketId, acceptsNewRequests: result.acceptsNewRequests });
  }));
  return router;
}
