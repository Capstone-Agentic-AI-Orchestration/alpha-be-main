import { Router, type Response } from 'express';

import { IS_CLOUD } from '../config/env.js';
import { route } from './asyncRoute.js';
import {
  ticketClientOriginAllowed, ticketClientOriginPolicyValid,
  setTicketClientSessionCookies, type TicketClientSessionAdmission, type TicketClientSessionCookiePolicy,
} from './ticketClientSessionController.js';
import type { TicketClientSessionIssue } from '../services/ticketClientSessionService.js';

export interface TicketClientActivationApplication {
  activate(input: unknown): Promise<{ activated: true; session: TicketClientSessionIssue }>;
}

function protectResponse(res: Response): void {
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function requestRecord(body: unknown): Record<string, unknown> | null {
  return body !== null && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown> : null;
}

/**
 * Redeems one invitation capability after the browser presents a one-time
 * identity-provider proof. It deliberately returns no workspace, ticket,
 * contact or provider identity fields. Mount only inside the configured
 * client-portal composition.
 */
export function createTicketClientActivationRouter(
  application: TicketClientActivationApplication,
  policy: TicketClientSessionCookiePolicy,
  admission: TicketClientSessionAdmission,
): Router {
  const router = Router();
  const policyValid = ticketClientOriginPolicyValid(policy?.secure, policy?.allowedOrigins)
    && typeof admission?.check === 'function';
  const origins = new Set(policyValid ? policy.allowedOrigins : []);

  router.post('/auth/activate', route(async (req, res) => {
    protectResponse(res);
    if (!IS_CLOUD) return res.status(503).json({ error: 'Client activation is available only through the Alpha web service.' });
    if (!policyValid) return res.status(503).json({ error: 'Client activation is not configured.' });
    if (!ticketClientOriginAllowed(req, origins)) return res.status(403).json({ error: 'This request origin is not allowed.' });
    if (!req.is('application/json')) return res.status(400).json({ error: 'This invitation is unavailable.' });

    let admissionResult: { allowed: boolean; retryAfterSeconds: number | null };
    try { admissionResult = await admission.check(req); }
    catch { return res.status(503).json({ error: 'Client activation is unavailable right now.' }); }
    if (!admissionResult || typeof admissionResult.allowed !== 'boolean'
      || (admissionResult.retryAfterSeconds !== null
        && (!Number.isSafeInteger(admissionResult.retryAfterSeconds)
          || admissionResult.retryAfterSeconds < 1 || admissionResult.retryAfterSeconds > 3600))) {
      return res.status(503).json({ error: 'Client activation is unavailable right now.' });
    }
    if (!admissionResult.allowed) {
      if (admissionResult.retryAfterSeconds !== null) res.setHeader('Retry-After', String(admissionResult.retryAfterSeconds));
      return res.status(429).json({ error: 'Too many activation attempts. Try again later.' });
    }

    const body = requestRecord(req.body);
    if (!body || Object.keys(body).length !== 3 || typeof body.invitationToken !== 'string'
      || !/^[A-Za-z0-9_-]{43}$/.test(body.invitationToken)
      || typeof body.providerTokenHash !== 'string' || !/^[A-Za-z0-9_-]{20,256}$/.test(body.providerTokenHash)
      || (body.providerTokenType !== 'invite' && body.providerTokenType !== 'magiclink')) {
      return res.status(404).json({ error: 'This invitation is unavailable.' });
    }

    const result = await application.activate({
      invitationToken: body.invitationToken,
      providerTokenHash: body.providerTokenHash,
      providerTokenType: body.providerTokenType,
    });
    if (!result || result.activated !== true || !result.session
      || !setTicketClientSessionCookies(res, result.session, policy.secure)) {
      return res.status(404).json({ error: 'This invitation is unavailable.' });
    }
    return res.status(200).json({ activated: true, expiresAt: result.session.expiresAt });
  }));

  return router;
}

