import { Router, type Request, type Response } from 'express';
import { IS_CLOUD } from '../config/env.js';
import { TicketWorkflowError } from '../ticketing/workflow.js';
import type { createTicketClientAccountService } from '../services/ticketClientAccountService.js';
import { readTicketClientCookie, setTicketClientSessionCookies, ticketClientOriginAllowed,
  ticketClientOriginPolicyValid, type TicketClientSessionAdmission, type TicketClientSessionCookiePolicy } from './ticketClientSessionController.js';

type Application = ReturnType<typeof createTicketClientAccountService>;

export function createTicketClientAccountRouter(app: Application, policy: TicketClientSessionCookiePolicy,
  admission: TicketClientSessionAdmission): Router {
  const router = Router();
  const secure = policy.secure;
  const valid = ticketClientOriginPolicyValid(secure, policy.allowedOrigins);
  const origins = new Set(policy.allowedOrigins);
  const setupName = secure ? '__Secure-alpha_client_setup' : 'alpha_client_setup_dev';
  const csrfName = secure ? 'alpha_client_setup_csrf' : 'alpha_client_setup_csrf_dev';
  function setupCookies(token: string, csrf: string, clear = false) {
    const attrs = `SameSite=Strict; Max-Age=${clear ? 0 : 900}${secure ? '; Secure' : ''}`;
    return [`${setupName}=${token}; HttpOnly; Path=/api/client/auth; ${attrs}`,
      `${csrfName}=${csrf}; Path=/; ${attrs}`];
  }
  function endpoint(method: 'get' | 'post', path: string, work: (req: Request, res: Response) => Promise<unknown>) {
    router[method](path, async (req, res) => {
      res.setHeader('Cache-Control', 'no-store, private');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      try {
        if (!IS_CLOUD || !valid) return res.status(503).json({ error: 'Client sign-in is unavailable right now.' });
        if (method === 'post') {
          if (!ticketClientOriginAllowed(req, origins)) return res.status(403).json({ error: 'This request is not allowed.' });
          if (!req.is('application/json')) return res.status(400).json({ error: 'Check the information and try again.' });
          const rate = await admission.check(req);
          if (!rate?.allowed) {
            res.setHeader('Retry-After', String(rate?.retryAfterSeconds ?? 60));
            return res.status(429).json({ error: 'Too many attempts. Try again later.' });
          }
        }
        return await work(req, res);
      } catch (error) {
        if (error instanceof TicketWorkflowError) return res.status(error.status).json({ error: error.message, code: error.code });
        return res.status(503).json({ error: 'Client sign-in is temporarily unavailable. Try again later.' });
      }
    });
  }
  endpoint('post', '/auth/sign-in', async (req, res) => {
    const session = await app.signIn(req.body);
    if (!setTicketClientSessionCookies(res, session, secure)) throw new Error();
    res.append('Set-Cookie', setupCookies('', '', true));
    return res.json({ authenticated: true, expiresAt: session.expiresAt });
  });
  endpoint('post', '/auth/recovery', async (req, res) => res.status(202).json(await app.recover(req.body)));
  endpoint('post', '/auth/setup/link', async (req, res) => {
    const { token, csrf, ...view } = await app.begin(req.body);
    res.setHeader('Set-Cookie', setupCookies(token, csrf));
    return res.json(view);
  });
  endpoint('get', '/auth/setup', async (req, res) => res.json(await app.inspect(readTicketClientCookie(req, setupName))));
  endpoint('post', '/auth/setup/complete', async (req, res) => {
    const csrf = req.get('X-CSRF-Token');
    if (!csrf || csrf !== readTicketClientCookie(req, csrfName)) return res.status(403).json({ error: 'Refresh the setup page and try again.' });
    const session = await app.finish(readTicketClientCookie(req, setupName), csrf, req.body);
    if (!setTicketClientSessionCookies(res, session, secure)) throw new Error();
    res.append('Set-Cookie', setupCookies('', '', true));
    return res.json({ authenticated: true, expiresAt: session.expiresAt });
  });
  return router;
}
