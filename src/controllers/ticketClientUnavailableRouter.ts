import { Router, type Response } from 'express';

/**
 * Keep the browser-only client surface explicitly unavailable until its
 * durable application stores and delivery configuration are ready. This
 * boundary must not relay through the PM desktop/cloud path or enter Alpha's
 * internal GitHub-session and workspace authorization middleware.
 */
export function createTicketClientUnavailableRouter(): Router {
  const router = Router({ caseSensitive: true, strict: true });
  router.use((_req, res: Response) => {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    return res.status(503).json({ error: 'Secure client access is not enabled in this Alpha environment.' });
  });
  return router;
}
