import { Router, type Response } from 'express';

export interface TicketClientRouters {
  account?: Router;
  session: Router;
  activation: Router;
  api: Router;
}

/**
 * Combine the isolated client handlers and terminate unknown client paths.
 * Mount at `/api/client` immediately after CORS/body parsing and BEFORE the
 * local-token, workspace, GitHub-session and internal API middleware. The
 * entry point mounts this only when the configured client composition is available.
 */
export function createTicketClientRouter(routers: TicketClientRouters): Router {
  const router = Router({ caseSensitive: true, strict: true });
  if (routers.account) router.use(routers.account);
  router.use(routers.session);
  router.use(routers.activation);
  router.use(routers.api);
  router.use((_req, res: Response) => {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.status(404).json({ error: 'Client endpoint not found.' });
  });
  return router;
}
