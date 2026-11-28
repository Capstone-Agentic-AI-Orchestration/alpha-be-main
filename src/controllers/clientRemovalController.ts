import { Router, type Request, type Response } from 'express';

import { route } from './asyncRoute.js';
import { opaqueTicketRequestValue, pmTicketSubject, relayPmTicketRequest } from './ticketRequestAuth.js';
import type { ClientRemoval } from '../services/clientRemoval.js';
import { TicketReadInvariantError } from '../ticketing/readModels.js';
import { TicketWorkflowError } from '../ticketing/workflow.js';

/**
 * PM routes for removing a client: what removal would do, then doing it.
 * Cloud only, like the rest of the Clients page; a desktop relays.
 *
 *   GET  /clients/:clientGroupKey/removal  -> ClientRemovalPreview
 *   POST /clients/:clientGroupKey/remove   { confirm: <clientGroupKey> } -> ClientRemovalResult
 */
export function createPmClientRemovalRouter(
  app: Pick<ClientRemoval, 'preview' | 'remove'>,
  relayRequest: typeof relayPmTicketRequest = relayPmTicketRequest,
): Router {
  const router = Router({ caseSensitive: true, strict: true });

  const target = (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Pragma', 'no-cache');
    const subject = pmTicketSubject(req, res);
    if (!subject) return null;
    const workspace = req.workspace;
    if (!workspace) throw new TicketReadInvariantError();
    const key = req.params.clientGroupKey;
    if (!opaqueTicketRequestValue(key) || !key.startsWith('client:') || Object.keys(req.query as object).length > 0) {
      throw new TicketWorkflowError(400, 'invalid_ticket_client', 'This client is invalid.');
    }
    return { subject, workspaceId: workspace.workspaceId, key };
  };

  router.get('/clients/:clientGroupKey/removal', route(async (req, res) => {
    if (await relayRequest(req, res)) return;
    const found = target(req, res);
    if (!found) return;
    return res.json(await app.preview(found.workspaceId, found.subject, found.key));
  }));

  router.post('/clients/:clientGroupKey/remove', route(async (req, res) => {
    // Archiving repositories and retiring a sign-in take a while; give the relay time.
    if (await relayRequest(req, res, { timeoutMs: 180_000 })) return;
    const found = target(req, res);
    if (!found) return;
    return res.json(await app.remove(found.workspaceId, found.subject, found.key, req.body));
  }));

  return router;
}
