import { Router } from 'express';
import { route } from './asyncRoute.js';
import { opaqueTicketRequestValue, pmTicketSubject, relayPmTicketRequest } from './ticketRequestAuth.js';
import type { TicketSubject, TicketTarget } from '../store/ticketCommandStore.js';
import type { TicketProjectLinkReceipt } from '../store/ticketProjectManagementStore.js';
import type { TicketStatus } from '../ticketing/workflow.js';
import { TicketReadInvariantError } from '../ticketing/readModels.js';

export interface TicketProjectManagementApplication {
  linkProject(target: TicketTarget, subject: TicketSubject, input: unknown): Promise<TicketProjectLinkReceipt>;
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
  const preview = value?.projectPreview;
  let validPreview = preview === null;
  if (preview && typeof preview === 'object') {
    try {
      const url = new URL(preview.url);
      validPreview = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(preview.repository)
        && (preview.branch === 'main' || preview.branch === 'uat') && url.protocol === 'https:'
        && !url.username && !url.password && !url.port && url.hostname.endsWith('.vercel.app')
        && url.hostname !== 'vercel.app' && preview.url.length <= 2048;
    } catch { validPreview = false; }
  }
  if (!value || value.ticketId !== ticketId || !opaqueTicketRequestValue(value.operationId)
    || !Number.isSafeInteger(value.version) || value.version < 0 || !statuses.has(value.status)
    || (value.projectId !== null && !opaqueTicketRequestValue(value.projectId))
    || (value.projectName !== null && (typeof value.projectName !== 'string' || !value.projectName.trim()
      || value.projectName.trim() !== value.projectName || value.projectName.length > 200))
    || typeof value.clientVisible !== 'boolean'
    || !validPreview || (preview !== null && !value.clientVisible)
    || ((value.projectId === null) !== (value.projectName === null))
    || (value.projectId === null && value.clientVisible)) throw new TicketReadInvariantError();
  return {
    ticketId, operationId: value.operationId, version: value.version,
    status: value.status, projectId: value.projectId, projectName: value.projectName,
    clientVisible: value.clientVisible, projectPreview: value.projectPreview,
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
  return router;
}
