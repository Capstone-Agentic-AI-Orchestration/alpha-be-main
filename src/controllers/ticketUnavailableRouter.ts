import { Router, type Response } from 'express';

import { route } from './asyncRoute.js';
import { relayPmTicketRequest } from './ticketRequestAuth.js';

/**
 * Fail-closed boundary while the PM read API is disabled. On desktop, preserve
 * Alpha's existing cloud-relay behavior; never fall back to a local ticket
 * store. On cloud, report feature availability without touching the database.
 */
export function createTicketUnavailableRouter(): Router {
  const router = Router({ caseSensitive: true, strict: true });
  router.use(route(async (req, res: Response) => {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (await relayPmTicketRequest(req, res)) return;
    return res.status(503).json({ error: 'Ticket reads are not enabled for this Alpha environment.' });
  }));
  return router;
}
