import { NextFunction, Request, Response } from 'express';

import { IS_CLOUD, SESSION_TTL_MS } from '../config/env.js';
import { sessionService } from '../services/sessionService.js';
import { withGitHubIdentity } from '../services/githubRequestContext.js';

/**
 * Who is making this request.
 *
 * Only in cloud mode. On the desktop the answer is `gh`, resolved once per
 * process, because one process serves one human — and a cookie would be
 * ceremony around a question already answered. On Render one process serves
 * everyone, and that same per-process answer is how every caller ended up
 * being the same person.
 */

export const SESSION_COOKIE = 'alpha_session';

/**
 * Parsed by hand rather than with `cookie-parser`.
 *
 * One cookie is read, in one place, and the parse is six lines. A dependency
 * in the daemon is a dependency in the shipped desktop binary too.
 */
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}

/**
 * Attributes chosen for what each one prevents:
 *
 *  - `HttpOnly` keeps the value out of `document.cookie`, so an XSS bug in the
 *    dashboard cannot read a session and post it elsewhere.
 *  - `Secure` refuses to travel over plain HTTP. Omitted on the desktop, whose
 *    origin is `http://127.0.0.1` and would otherwise never receive it.
 *  - `SameSite=Lax` means a cross-site POST carries no cookie, which is CSRF
 *    defence for every state-changing route at once. Lax rather than Strict
 *    because the OAuth callback returns as a top-level navigation and Strict
 *    would drop the cookie on precisely that hop.
 *  - `Path=/` so a sign-out clears the same cookie the API set.
 */
export function sessionCookie(value: string, maxAgeMs = SESSION_TTL_MS): string {
  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`
  ];
  if (IS_CLOUD) attrs.push('Secure');
  return attrs.join('; ');
}

export function clearedSessionCookie(): string {
  const attrs = [`${SESSION_COOKIE}=`, 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=0'];
  if (IS_CLOUD) attrs.push('Secure');
  return attrs.join('; ');
}

/**
 * Resolve the session and make its GitHub token visible to this request.
 *
 * The token is put on the async call chain with `withGitHubIdentity` rather
 * than on the service or the request object. `githubService` is a module
 * singleton: storing a token on it would mean the last person to sign in
 * becomes the identity for every concurrent request, which is the bug that
 * file's comment was written to prevent. AsyncLocalStorage keeps each
 * request's credential on its own chain, and no method signature has to change
 * to carry it.
 *
 * A missing or expired cookie is not refused here. Some routes are public, and
 * a blanket 401 in this middleware would make the sign-in page itself
 * unreachable. `workspaceContext` decides who may proceed.
 *
 * An unreachable session store is not "signed out", though. Answering nobody
 * would send a signed-in person to the sign-in page, where signing in writes
 * to the same store that just failed; it is passed on as the error it is.
 * Express 4 does not catch a rejected promise itself, hence the explicit
 * `next(err)`.
 */
export function sessionContext(req: Request, res: Response, next: NextFunction): void {
  if (!IS_CLOUD) return next();

  sessionService.resolve(readCookie(req, SESSION_COOKIE)).then(
    session => {
      if (!session) return next();
      req.session = session;
      withGitHubIdentity({ token: session.githubToken, login: session.login }, () => next());
    },
    err => next(err)
  );
}
