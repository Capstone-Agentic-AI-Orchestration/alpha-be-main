import { Router, type Response } from 'express';

/**
 * Explicit fail-closed boundary for anonymous inquiries until the real
 * origin/rate guard, published intake entry, and durable runtime composition are ready.
 * Mount before Alpha's internal token, session, and workspace middleware.
 */
export function createTicketPublicIntakeUnavailableRouter(): Router {
  const router = Router({ caseSensitive: true, strict: true });
  router.use((_req, res: Response) => {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    return res.status(503).json({ error: 'Public ticket intake is not enabled in this Alpha environment.' });
  });
  return router;
}
