import { Router } from 'express';
import type { TicketLifecycleRuntime } from '../services/ticketLifecycleRuntime.js';
import type { TicketTarget } from '../store/ticketCommandStore.js';
import { TicketReadInvariantError } from '../ticketing/readModels.js';
import { route } from './asyncRoute.js';
import { opaqueTicketRequestValue, pmTicketSubject, relayPmTicketRequest } from './ticketRequestAuth.js';

/** PM submits an explicit client-safe summary; private work artifacts are not
 * collected or transformed into a public result by this endpoint. */
export function createTicketPmResultRouter(runtime: TicketLifecycleRuntime): Router {
  const router = Router({ caseSensitive: true, strict: true });
  router.post('/:ticketId/results', route(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (await relayPmTicketRequest(req, res)) return;
    const subject = pmTicketSubject(req, res);
    if (!subject) return;
    const ticketId = req.params.ticketId ?? '';
    if (!req.workspace || !opaqueTicketRequestValue(ticketId)) return res.status(404).json({ error: 'Ticket not found.' });
    const target: TicketTarget = { workspaceId: req.workspace.workspaceId, ticketId };
    const result = await runtime.prepareResult(target, subject, req.body);
    if (!opaqueTicketRequestValue(result.deliveryId)) throw new TicketReadInvariantError();
    return res.status(201).json({ deliveryId: result.deliveryId });
  }));
  return router;
}
