import { Request, Router } from 'express';

import { route } from './asyncRoute.js';
import { PublicTicketIntakeError } from '../ticketing/publicIntake.js';
import type {
  PublicTicketInquiryAcknowledgement,
  PublicTicketIntakeRequestContext,
} from '../ticketing/publicIntake.js';

export interface TicketPublicIntakeApplication {
  submit(
    slug: string,
    proofToken: string,
    input: unknown,
    request: PublicTicketIntakeRequestContext,
  ): Promise<PublicTicketInquiryAcknowledgement>;
}

/**
 * Resolve the caller address only from the socket or explicitly trusted proxy
 * configuration. Never pass an arbitrary X-Forwarded-For value to the intake
 * guard; it would let a caller rotate the rate-limit identity at will.
 */
export type TicketIntakeAddressResolver = (req: Request) => string | null;

/**
 * The anonymous client-intake transport boundary. Its caller receives only a
 * generic acknowledgement; the application service owns proof validation,
 * rate budgets, idempotency and the atomic inquiry write.
 *
 * This router must be mounted only after a durable store and real proof guard
 * have been configured. index.ts mounts it only through the triage rollout gate.
 */
export function createTicketPublicIntakeRouter(
  application: TicketPublicIntakeApplication,
  resolveRemoteAddress: TicketIntakeAddressResolver,
): Router {
  const router = Router();

  router.post('/:slug', route(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');

    const body = req.body !== null && typeof req.body === 'object' && !Array.isArray(req.body)
      ? req.body as Record<string, unknown>
      : {};
    const proofToken = typeof body.proofToken === 'string' ? body.proofToken : '';
    let remoteAddress: string | null = null;
    try {
      remoteAddress = resolveRemoteAddress(req);
    } catch {
      // Fail closed through the application's fixed, non-identifying response.
    }

    let acknowledgement: PublicTicketInquiryAcknowledgement;
    try {
      acknowledgement = await application.submit(
        req.params.slug ?? '',
        proofToken,
        body.inquiry,
        { origin: req.get('Origin') ?? null, remoteAddress: remoteAddress ?? '' },
      );
    } catch (error) {
      // The service already maps expected failures to fixed public errors.
      // Do not let an adapter/driver exception leak through the generic handler.
      if (error instanceof PublicTicketIntakeError) throw error;
      throw new PublicTicketIntakeError('unavailable');
    }

    // Rebuild the response from the one public-safe bit. Even an accidentally
    // widened service result cannot disclose an ID, reference or ticket status.
    if (acknowledgement?.received !== true) {
      throw new PublicTicketIntakeError('unavailable');
    }
    res.status(202).json({ received: true });
  }));

  return router;
}
