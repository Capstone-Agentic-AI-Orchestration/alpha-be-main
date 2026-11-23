import { Router, type Request, type Response } from 'express';
import type { ClientProjectStages } from '../services/clientProjectStages.js';
import type { ProjectTarget } from '../services/clientProjectPortal.js';
import { route } from './asyncRoute.js';
import { pmTicketSubject, relayPmTicketRequest } from './ticketRequestAuth.js';

/**
 * PM side of a project's stages (POC → Contract → Development → Completed).
 * The client is picked with `?clientId=`, as in the project conversation; the
 * workspace comes only from the authenticated PM middleware.
 */
export function createPmProjectStageRouter(app: ClientProjectStages, relay = relayPmTicketRequest) {
  const router = Router();
  type Subject = NonNullable<ReturnType<typeof pmTicketSubject>>;
  const handle = (work: (req: Request, subject: Subject, target: ProjectTarget, clientId: unknown) => Promise<unknown>) =>
    route(async (req: Request, res: Response) => {
      res.setHeader('Cache-Control', 'no-store, private');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (await relay(req, res)) return;
      const subject = pmTicketSubject(req, res);
      if (!subject) return;
      return res.json(await work(req, subject, { workspaceId: req.workspace!.workspaceId, projectId: req.params.projectId }, req.query.clientId));
    });
  const base = '/projects/:projectId/stage';

  router.get(base, handle((_req, subject, target, clientId) => app.summary(target, subject, clientId)));
  router.get(base + '/operations/:operationId', handle((req, subject, target, clientId) =>
    app.operation(target, subject, req.params.operationId, clientId)));
  router.post(base + '/starting-stage', handle((req, subject, target, clientId) => app.setStartingStage(target, subject, req.body, clientId)));
  router.put(base + '/poc/draft', handle((req, subject, target, clientId) => app.savePocDraft(target, subject, req.body, clientId)));
  router.post(base + '/poc/:pocId/publish', handle((req, subject, target, clientId) =>
    app.publishPoc(target, subject, req.params.pocId, req.body, clientId)));
  router.put(base + '/contract/draft', handle((req, subject, target, clientId) => app.saveContractDraft(target, subject, req.body, clientId)));
  router.post(base + '/contract/:contractId/issue', handle((req, subject, target, clientId) =>
    app.issueContract(target, subject, req.params.contractId, req.body, clientId)));
  router.post(base + '/contract/:contractId/void', handle((req, subject, target, clientId) =>
    app.voidContract(target, subject, req.params.contractId, req.body, clientId)));
  router.post(base + '/contract/:contractId/countersign', handle((req, subject, target, clientId) =>
    app.countersignContract(target, subject, req.params.contractId, req.body, clientId)));
  return router;
}
