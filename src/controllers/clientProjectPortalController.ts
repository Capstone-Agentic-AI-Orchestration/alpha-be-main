import { Router } from 'express';
import type { PostgresClientProjectPortal, ProjectTarget } from '../services/clientProjectPortal.js';
import { route } from './asyncRoute.js';
import { pmTicketSubject, relayPmTicketRequest } from './ticketRequestAuth.js';

/** Mounted before ticket detail/fallback routes. Selected workspace comes only
 * from authenticated PM middleware, never a query or body field. */
export function createPmClientProjectRouter(app: PostgresClientProjectPortal, relay = relayPmTicketRequest) {
  const router = Router();
  const path = '/projects/:projectId/client-preview';
  for (const [method, suffix] of [['get', ''], ['put', ''], ['get', '/clients'], ['get', '/messages'], ['post', '/messages'], ['get', '/messages/operations/:operationId']] as const) {
    router[method](path + suffix, route(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store, private');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (await relay(req, res)) return;
      const subject = pmTicketSubject(req, res);
      if (!subject) return;
      const target: ProjectTarget = { workspaceId: req.workspace!.workspaceId, projectId: req.params.projectId };
      if (method === 'put') return res.json(await app.setPreview(target, subject, req.body));
      if (suffix === '') return res.json(await app.getPreview(target, subject));
      if (suffix === '/clients') return res.json(await app.clients(target, subject));
      const { clientId, ...page } = req.query;
      if (req.params.operationId) return res.json(await app.operation(target, subject, req.params.operationId, clientId));
      return res.json(method === 'get' ? await app.messages(target, subject, page, clientId)
        : await app.reply(target, subject, req.body, clientId));
    }));
  }
  return router;
}
