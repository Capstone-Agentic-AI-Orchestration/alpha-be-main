import { Router, type Request, type Response } from 'express';

import { IS_CLOUD } from '../config/env.js';
import type { TicketClientSessionCheck, TicketClientSessionIssue } from '../services/ticketClientSessionService.js';
import type { TicketSubject } from '../store/ticketCommandStore.js';

export interface TicketClientSessionApplication {
  authenticate(sessionCookie: unknown, csrfCookie?: unknown, csrfHeader?: unknown, requireCsrf?: boolean): Promise<TicketClientSessionCheck>;
  revoke(subject: Extract<TicketSubject, { kind: 'client' }>): Promise<void>;
  emailFor?(subject: Extract<TicketSubject, { kind: 'client' }>): Promise<string | null>;
  nameFor?(subject: Extract<TicketSubject, { kind: 'client' }>): Promise<string | null>;
}

export interface TicketClientSessionCookiePolicy {
  /** True only on the approved HTTPS web origin. False is loopback-development-only. */
  secure: boolean;
  allowedOrigins: readonly string[];
}
export interface TicketClientSessionAdmission {
  /** Must use the socket address or explicitly trusted proxy chain, never raw X-Forwarded-For. */
  check(req: Request): Promise<{ allowed: boolean; retryAfterSeconds: number | null }>;
}

const sessionCookiePath = '/api/client';
// The client entry is served from the SPA root (/#/client), so its readable
// CSRF cookie must be visible there. It is not an authentication credential.
const csrfCookiePath = '/';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function validOrigin(value: unknown, secure: boolean): value is string {
  if (typeof value !== 'string' || value.length > 300) return false;
  try {
    const url = new URL(value);
    if (url.origin !== value || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return false;
    if (secure) return url.protocol === 'https:';
    return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  } catch { return false; }
}

export function ticketClientOriginPolicyValid(secure: boolean, origins: readonly string[]): boolean {
  return typeof secure === 'boolean' && Array.isArray(origins) && origins.length > 0
    && origins.length <= 20 && origins.every(origin => validOrigin(origin, secure));
}

function requestCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  let value: string | undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue;
    if (value !== undefined) return undefined; // Ambiguous duplicate cookie: fail closed.
    value = part.slice(eq + 1).trim();
  }
  return value;
}

export function readTicketClientCookie(req: Request, name: string): string | undefined {
  return requestCookie(req, name);
}

export function ticketClientCookieNames(secure: boolean): { session: string; csrf: string } {
  return {
    session: secure ? '__Secure-alpha_client_session' : 'alpha_client_session_dev',
    csrf: secure ? 'alpha_client_csrf' : 'alpha_client_csrf_dev',
  };
}

export function ticketClientOriginAllowed(req: Request, origins: ReadonlySet<string>): boolean {
  const origin = req.get('Origin');
  return Boolean(origin && origins.has(origin));
}

function cookieHeader(name: string, value: string, maxAge: number, path: string, secure: boolean, httpOnly: boolean, sameSite: 'Lax' | 'Strict'): string {
  const attrs = [
    `${name}=${encodeURIComponent(value)}`,
    ...(httpOnly ? ['HttpOnly'] : []),
    `SameSite=${sameSite}`,
    `Path=${path}`,
    `Max-Age=${maxAge}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

function clearCookie(name: string, path: string, secure: boolean, httpOnly: boolean, sameSite: 'Lax' | 'Strict'): string {
  const attrs = [
    `${name}=`,
    ...(httpOnly ? ['HttpOnly'] : []),
    `SameSite=${sameSite}`,
    `Path=${path}`,
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

function emptyJsonBody(body: unknown): boolean {
  return body === undefined || (body !== null && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0);
}
function validSecret(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.byteLength === 32 && bytes.toString('base64url') === value;
}

/** Separate client auth endpoints. Mount only in the cloud before internal
 * GitHub session/workspace middleware. No route trusts provider claims from a body. */
export function createTicketClientSessionRouter(
  application: TicketClientSessionApplication,
  policy: TicketClientSessionCookiePolicy,
): Router {
  const router = Router();
  const policyValid = ticketClientOriginPolicyValid(policy?.secure, policy?.allowedOrigins);
  const secure = policy?.secure === true;
  const cookieNames = ticketClientCookieNames(secure);
  const sessionCookieName = cookieNames.session;
  const csrfCookieName = cookieNames.csrf;
  const origins = new Set(policyValid ? policy.allowedOrigins : []);

  function protectResponse(res: Response): void {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
  }

  function available(res: Response): boolean {
    protectResponse(res);
    if (!IS_CLOUD) {
      res.status(503).json({ error: 'Client sign-in is available only through the Alpha web service.' });
      return false;
    }
    if (!policyValid) {
      res.status(503).json({ error: 'Client sign-in is not configured.' });
      return false;
    }
    return true;
  }

  function requireAllowedOrigin(req: Request, res: Response): boolean {
    if (!ticketClientOriginAllowed(req, origins)) {
      res.status(403).json({ error: 'This request origin is not allowed.' });
      return false;
    }
    return true;
  }

  function clearCookies(res: Response): void {
    res.setHeader('Set-Cookie', [
      clearCookie(sessionCookieName, sessionCookiePath, secure, true, 'Lax'),
      clearCookie(csrfCookieName, csrfCookiePath, secure, false, 'Strict'),
    ]);
  }

  router.get('/session', async (req, res, next) => {
    if (!available(res)) return;
    try {
      const result = await application.authenticate(readTicketClientCookie(req, sessionCookieName));
      if (result.kind !== 'authenticated') return res.json({ authenticated: false });
      let email: string | null = null;
      let fullName: string | null = null;
      try { email = await application.emailFor?.(result.subject) ?? null; }
      catch { /* Email is display-only and must not change session authentication. */ }
      try { fullName = await application.nameFor?.(result.subject) ?? null; }
      catch { /* Name is display-only and must not change session authentication. */ }
      return res.json({ authenticated: true, expiresAt: result.expiresAt,
        ...(typeof email === 'string' && email.length <= 254 ? { email } : {}),
        ...(typeof fullName === 'string' && fullName.trim().length > 0 && fullName.trim().length <= 200 ? { fullName: fullName.trim() } : {}) });
    } catch (error) { return next(error); }
  });

  router.post('/session/logout', async (req, res, next) => {
    if (!available(res) || !requireAllowedOrigin(req, res)) return;
    if (!emptyJsonBody(req.body)) return res.status(400).json({ error: 'This sign-out request is invalid.' });
    const sessionCookie = readTicketClientCookie(req, sessionCookieName);
    const result = await application.authenticate(
      sessionCookie,
      readTicketClientCookie(req, csrfCookieName),
      req.get('X-CSRF-Token'),
      true,
    ).catch(next);
    if (!result) return;
    if (result.kind === 'csrf_invalid') return res.status(403).json({ error: 'This request could not be verified.' });
    if (result.kind === 'authenticated') {
      try { await application.revoke(result.subject); }
      catch (error) { return next(error); }
    }
    clearCookies(res);
    return res.status(204).end();
  });

  return router;
}

export function setTicketClientSessionCookies(res: Response, issue: TicketClientSessionIssue, secure: boolean): boolean {
  const expiresAt = Date.parse(issue.expiresAt);
  const maxAge = Math.floor((expiresAt - Date.now()) / 1000);
  if (!validSecret(issue.sessionCookieValue) || !validSecret(issue.csrfCookieValue)
    || !Number.isFinite(expiresAt) || maxAge <= 0 || maxAge > 24 * 60 * 60) return false;
  const names = ticketClientCookieNames(secure);
  res.setHeader('Set-Cookie', [
    cookieHeader(names.session, issue.sessionCookieValue, maxAge, sessionCookiePath, secure, true, 'Lax'),
    cookieHeader(names.csrf, issue.csrfCookieValue, maxAge, csrfCookiePath, secure, false, 'Strict'),
  ]);
  return true;
}
