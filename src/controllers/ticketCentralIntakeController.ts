import { Router, type Request, type Response } from 'express';
import type { TicketSubject } from '../store/ticketCommandStore.js';
import { TicketReadInvariantError } from '../ticketing/readModels.js';
import { TicketWorkflowError } from '../ticketing/workflow.js';
import { route } from './asyncRoute.js';
import { pmTicketSubject, relayPmTicketRequest } from './ticketRequestAuth.js';

export interface TicketCentralIntakeApplication {
  listPending(workspaceId: string, subject: TicketSubject, input: { after?: unknown; limit?: unknown }): Promise<unknown>;
  accept(intakeId: string, workspaceId: string, subject: TicketSubject, input: unknown): Promise<unknown>;
  decline(intakeId: string, workspaceId: string, subject: TicketSubject, input: unknown): Promise<unknown>;
}

function safePage(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TicketReadInvariantError();
  const page = value as Record<string, unknown>;
  if (!Array.isArray(page.items) || page.items.length > 100
    || (page.nextCursor !== null && (typeof page.nextCursor !== 'string' || !page.nextCursor.trim()))) {
    throw new TicketReadInvariantError();
  }
  const items = page.items.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TicketReadInvariantError();
    const row = item as Record<string, unknown>;
    if (typeof row.id !== 'string' || !row.id.trim() || row.id.length > 200
      || typeof row.publicReference !== 'string' || !/^INQ-[A-F0-9]{32}$/.test(row.publicReference)
      || typeof row.fullName !== 'string' || !row.fullName.trim() || row.fullName.length > 160
      || typeof row.email !== 'string' || !row.email.trim() || row.email.length > 254
      || (row.company !== null && (typeof row.company !== 'string' || row.company.length > 160))
      || typeof row.title !== 'string' || !row.title.trim() || row.title.length > 160
      || typeof row.description !== 'string' || !row.description.trim() || row.description.length > 6000
      || (row.requestedDeadline !== null && (typeof row.requestedDeadline !== 'string'
        || !/^\d{4}-\d{2}-\d{2}$/.test(row.requestedDeadline)))
      || typeof row.submittedAt !== 'string' || !Number.isFinite(Date.parse(row.submittedAt))) {
      throw new TicketReadInvariantError();
    }
    // Explicit client-data allowlist for the PM-only intake response.
    return { id: row.id, publicReference: row.publicReference, fullName: row.fullName, email: row.email, company: row.company,
      title: row.title, description: row.description, requestedDeadline: row.requestedDeadline,
      submittedAt: row.submittedAt };
  });
  return { items, nextCursor: page.nextCursor };
}

function safeAcceptance(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TicketReadInvariantError();
  const row = value as Record<string, unknown>;
  if (typeof row.ticketId !== 'string' || !row.ticketId.trim() || row.ticketId.length > 200
    || typeof row.workspaceId !== 'string' || !row.workspaceId.trim() || row.workspaceId.length > 200
    || typeof row.reference !== 'string' || !/^TKT-[A-F0-9]{32}$/.test(row.reference)
    || typeof row.operationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(row.operationId)) {
    throw new TicketReadInvariantError();
  }
  return { ticketId: row.ticketId, workspaceId: row.workspaceId, reference: row.reference, operationId: row.operationId };
}

function safeDecline(value: unknown, intakeId: string, operationId: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TicketReadInvariantError();
  const row = value as Record<string, unknown>;
  if (row.intakeId !== intakeId || row.operationId !== operationId || row.status !== 'declined') {
    throw new TicketReadInvariantError();
  }
  return { intakeId, operationId, status: 'declined' as const };
}

function pageInput(req: Request): { after?: unknown; limit?: unknown } {
  const query = req.query as Record<string, unknown>;
  const keys = Object.keys(query);
  if (keys.some(key => key !== 'after' && key !== 'limit')) {
    throw new TicketWorkflowError(400, 'central_intake_page_invalid', 'The inquiry page is invalid.');
  }
  return { after: query.after, limit: query.limit };
}

/** PM-only view of pre-ticket inquiries. Workspace selection comes from the
 * authenticated Alpha context and is never accepted from the request body. */
export function createTicketCentralIntakeRouter(
  application: TicketCentralIntakeApplication,
  relayRequest: typeof relayPmTicketRequest = relayPmTicketRequest,
): Router {
  const router = Router();
  router.get('/intakes', route(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Pragma', 'no-cache');
    if (await relayRequest(req, res)) return;
    const subject = pmTicketSubject(req, res);
    if (!subject) return;
    const workspaceId = req.workspace?.workspaceId;
    if (!workspaceId) throw new TicketReadInvariantError();
    const result = await application.listPending(workspaceId, subject, pageInput(req));
    return res.json(safePage(result));
  }));

  router.post('/intakes/:intakeId/accept', route(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Pragma', 'no-cache');
    if (await relayRequest(req, res)) return;
    const subject = pmTicketSubject(req, res);
    if (!subject) return;
    const workspaceId = req.workspace?.workspaceId;
    if (!workspaceId) throw new TicketReadInvariantError();
    const accepted = safeAcceptance(await application.accept(req.params.intakeId ?? '', workspaceId, subject, req.body));
    if (accepted.workspaceId !== workspaceId) throw new TicketReadInvariantError();
    return res.status(201).json(accepted);
  }));
  router.post('/intakes/:intakeId/decline', route(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Pragma', 'no-cache');
    if (await relayRequest(req, res)) return;
    const subject = pmTicketSubject(req, res);
    if (!subject) return;
    const workspaceId = req.workspace?.workspaceId;
    if (!workspaceId) throw new TicketReadInvariantError();
    const body = req.body !== null && typeof req.body === 'object' && !Array.isArray(req.body)
      ? req.body as Record<string, unknown> : {};
    if (typeof body.operationId !== 'string') throw new TicketWorkflowError(400, 'central_intake_decline_invalid', 'The inquiry could not be declined.');
    return res.json(safeDecline(
      await application.decline(req.params.intakeId ?? '', workspaceId, subject, req.body),
      req.params.intakeId ?? '', body.operationId,
    ));
  }));
  return router;
}
