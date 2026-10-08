import { Router, type Response } from 'express';

export interface TicketPmRouters {
  queue: Router;
  read: Router;
  commands: Router;
  messages: Router;
  invitations: Router;
  scopes: Router;
  deliveries: Router;
  deliveryCandidates: Router;
}

/**
 * Compose PM ticket endpoints under one namespace. Mount only after the
 * existing internal session/workspace middleware and durable stores are ready.
 * Unknown PM ticket paths terminate here rather than falling through to other
 * application routers.
 */
export function createTicketPmRouter(routers: TicketPmRouters): Router {
  const router = Router({ caseSensitive: true, strict: true });
  router.use(routers.queue);
  router.use(routers.read);
  router.use(routers.commands);
  router.use(routers.messages);
  router.use(routers.invitations);
  router.use(routers.scopes);
  router.use(routers.deliveries);
  router.use(routers.deliveryCandidates);
  router.use((_req, res: Response) => {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.status(404).json({ error: 'Ticket endpoint not found.' });
  });
  return router;
}
