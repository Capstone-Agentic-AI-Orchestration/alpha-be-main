import { Router, type Request, type Response } from 'express';
import type { ClientProjectConversation } from '../services/clientProjectConversation.js';
import type { ProjectTarget } from '../services/clientProjectPortal.js';
import { route } from './asyncRoute.js';
import { pmTicketSubject, relayPmTicketRequest } from './ticketRequestAuth.js';

/**
 * PM side of the one-conversation-per-project view, plus request ↔ task links.
 * Mounted before ticket detail routes. The workspace comes only from the
 * authenticated PM middleware, never from a query or body field.
 */
export function createPmClientConversationRouter(app: ClientProjectConversation, relay = relayPmTicketRequest) {
  const router = Router();
  const handle = (work: (req: Request, res: Response, subject: NonNullable<ReturnType<typeof pmTicketSubject>>, workspaceId: string) => Promise<unknown>) =>
    route(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store, private');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (await relay(req, res)) return;
      const subject = pmTicketSubject(req, res);
      if (!subject) return;
      return res.json(await work(req, res, subject, req.workspace!.workspaceId));
    });
  const project = (req: Request, workspaceId: string): ProjectTarget => ({ workspaceId, projectId: req.params.projectId });

  router.get('/clients/:clientId/project-conversations', handle((req, _res, subject, workspaceId) =>
    app.clientProjects(workspaceId, subject, req.params.clientId)));
  router.get('/projects/:projectId/conversation', handle((req, _res, subject, workspaceId) =>
    app.timeline(project(req, workspaceId), subject, req.query.clientId)));
  router.get('/projects/:projectId/conversation/requests', handle((req, _res, subject, workspaceId) =>
    app.requests(project(req, workspaceId), subject, req.query.clientId)));
  router.post('/projects/:projectId/conversation/requests/:ticketId/check', handle((req, _res, subject, workspaceId) =>
    app.setDone(project(req, workspaceId), req.params.ticketId, subject, req.body, req.query.clientId)));
  router.get('/projects/:projectId/open-requests', handle((req, _res, subject, workspaceId) =>
    app.openRequests(workspaceId, req.params.projectId, subject)));
  router.get('/projects/:projectId/request-links', handle((req, _res, subject, workspaceId) =>
    app.taskRequestLinks(workspaceId, req.params.projectId, subject)));
  router.post('/requests/:ticketId/task-links', handle((req, _res, subject, workspaceId) =>
    app.linkTask(workspaceId, req.params.ticketId, subject, req.body)));
  router.delete('/requests/:ticketId/task-links/:issueId', handle((req, _res, subject, workspaceId) =>
    app.unlinkTask(workspaceId, req.params.ticketId, req.params.issueId, subject)));
  return router;
}
