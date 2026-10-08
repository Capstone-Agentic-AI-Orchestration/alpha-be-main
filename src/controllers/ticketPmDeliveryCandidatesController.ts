import { Router } from 'express';
import { z } from 'zod';

import type { TicketSubject, TicketTarget } from '../store/ticketCommandStore.js';
import type { TicketDeliveryCandidateList } from '../services/ticketDeliveryAssessmentService.js';
import { TicketReadInvariantError } from '../ticketing/readModels.js';
import { route } from './asyncRoute.js';
import { createTicketPmDeliveryRouter, type TicketPmDeliveryApplication } from './ticketPmDeliveryController.js';
import { opaqueTicketRequestValue, pmTicketSubject, relayPmTicketRequest } from './ticketRequestAuth.js';

export interface TicketPmDeliveryCandidatesApplication extends TicketPmDeliveryApplication {
  list(target: TicketTarget, subject: TicketSubject, input: unknown): Promise<TicketDeliveryCandidateList>;
}
const id = z.string().min(1).max(200).refine(value => value.trim() === value);
const listSchema = z.object({ items: z.array(z.object({ id, scopeVersionId: id,
  summary: z.string().min(1).max(4000), fileCount: z.number().int().min(1).max(100),
})).max(20), nextCursor: id.nullable() });

/** PM-only read contract for registered but not yet assessed deliveries. */
export function createTicketPmDeliveryCandidatesRouter(application: TicketPmDeliveryCandidatesApplication): Router {
  const router = Router();
  router.get('/:ticketId/delivery-candidates', route(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (await relayPmTicketRequest(req, res)) return;
    const subject = pmTicketSubject(req, res);
    if (!subject) return;
    const ticketId = req.params.ticketId ?? '';
    if (!req.workspace || !opaqueTicketRequestValue(ticketId)) return res.status(404).json({ error: 'Ticket not found.' });
    const input = { limit: req.query.limit === undefined ? 10 : Number(req.query.limit), after: req.query.after ?? null };
    if (Object.keys(req.query).some(key => !['limit', 'after'].includes(key))
      || (req.query.limit !== undefined && typeof req.query.limit !== 'string')
      || (req.query.after !== undefined && typeof req.query.after !== 'string')) return res.status(400).json({ error: 'Invalid result page.' });
    const result = listSchema.safeParse(await application.list({ workspaceId: req.workspace.workspaceId, ticketId }, subject, input));
    if (!result.success || new Set(result.data.items.map(item => item.id)).size !== result.data.items.length
      || (result.data.nextCursor !== null && result.data.nextCursor !== result.data.items.at(-1)?.id)) throw new TicketReadInvariantError();
    return res.json(result.data);
  }));
  router.use(createTicketPmDeliveryRouter(application, 'delivery-candidates'));
  return router;
}
