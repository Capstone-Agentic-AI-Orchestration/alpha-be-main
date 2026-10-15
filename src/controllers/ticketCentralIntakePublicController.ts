import { Router, type Request } from 'express';
import type { PublicTicketIntakeRequestContext } from '../ticketing/publicIntake.js';
import { PublicTicketIntakeError } from '../ticketing/publicIntake.js';
import { route } from './asyncRoute.js';

export interface TicketCentralIntakePublicApplication {
  submit(input: unknown, request: PublicTicketIntakeRequestContext): Promise<{ received: true }>;
}

export function createTicketCentralIntakePublicRouter(
  application: TicketCentralIntakePublicApplication,
  resolveRemoteAddress: (req: Request) => string | null,
  enabled: boolean,
): Router {
  const router = Router({ caseSensitive: true, strict: true });
  router.get('/config', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.json({ enabled });
  });
  router.post('/', route(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (!enabled || !req.is('application/json')) throw new PublicTicketIntakeError('writes_disabled');
    let remoteAddress = '';
    try { remoteAddress = resolveRemoteAddress(req) ?? ''; } catch { /* fail closed */ }
    const body = req.body !== null && typeof req.body === 'object' && !Array.isArray(req.body)
      ? req.body as Record<string, unknown> : {};
    let result: { received: true };
    try {
      result = await application.submit(body.inquiry, {
        origin: req.get('Origin') ?? null, remoteAddress,
      });
    } catch (error) {
      if (error instanceof PublicTicketIntakeError) throw error;
      throw new PublicTicketIntakeError('unavailable');
    }
    if (result?.received !== true || Object.keys(result).length !== 1) throw new PublicTicketIntakeError('unavailable');
    return res.status(202).json({ received: true });
  }));
  return router;
}
