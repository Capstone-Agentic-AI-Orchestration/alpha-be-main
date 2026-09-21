import { createHmac, timingSafeEqual } from 'node:crypto';

import { SUPABASE_JWT_SECRET, SUPABASE_TOKEN_TTL_MS } from '../config/env.js';
import type { AlphaRole } from './identityService.js';

/**
 * The token the row-level security policies read.
 *
 * Alpha's browser session is an opaque cookie by design — the GitHub token
 * behind it never leaves the server. But the desktop app talks to Postgres
 * directly, and the web app subscribes to Supabase Realtime directly, and
 * neither can present a cookie to Supabase. They need a signed token carrying
 * the three claims the policies in `0002_row_level_security.sql` ask for.
 *
 * So this is deliberately *not* the session. It is a short-lived credential
 * minted from one, and the distinction matters:
 *
 *   - the session is revocable, long-lived, and never leaves the browser's
 *     cookie jar or the daemon's memory;
 *   - this token is un-revocable once issued (nothing checks a blocklist on
 *     every row read), so it lives minutes, not days.
 *
 * ## Why sign it here rather than use Supabase Auth
 *
 * Supabase Auth would mint these, but it decides identity itself — and Alpha's
 * identity is a GitHub login plus an organisation team membership, which
 * Supabase has no way to know. Alpha resolves that at sign-in and says so in a
 * token Supabase is configured to trust.
 */

export interface SupabaseTokenClaims {
  /** GitHub login. `alpha.login()` in the policies. */
  sub: string;
  /** Active workspace. `alpha.workspace()`. */
  workspace_id: string;
  /** Alpha's own role. `alpha.alpha_role()`. */
  alpha_role: AlphaRole;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * HS256 over the Supabase project's JWT secret.
 *
 * Symmetric because both sides are ours and the secret never leaves the
 * server: Render signs, Supabase verifies. An asymmetric key pair would add a
 * JWKS endpoint to host and rotate for no gain at this size.
 */
function sign(payload: Record<string, unknown>): string {
  if (!SUPABASE_JWT_SECRET) {
    throw new Error(
      'SUPABASE_JWT_SECRET is not configured, so no token can be minted for ' +
        'the database. Copy it from the Supabase dashboard under Settings → API.'
    );
  }

  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(payload));
  const signature = createHmac('sha256', SUPABASE_JWT_SECRET)
    .update(`${header}.${body}`)
    .digest('base64url');

  return `${header}.${body}.${signature}`;
}

/**
 * Mint a token for one signed-in person, in one workspace.
 *
 * `role: 'authenticated'` is not Alpha's role and must not be confused with
 * it. PostgREST reads that claim to decide which Postgres role to run the
 * request as, and anything other than `authenticated` or `anon` is rejected.
 * Alpha's own role travels separately as `alpha_role`, which is exactly why
 * the policies read that name — a single `role` claim would have had to mean
 * both things at once.
 */
export function mintSupabaseToken(claims: SupabaseTokenClaims): {
  token: string;
  expiresAt: string;
} {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + Math.floor(SUPABASE_TOKEN_TTL_MS / 1000);

  const token = sign({
    ...claims,
    role: 'authenticated',
    aud: 'authenticated',
    iss: 'alpha',
    iat: now,
    exp
  });

  return { token, expiresAt: new Date(exp * 1000).toISOString() };
}

/**
 * Verify a token this server issued.
 *
 * Not needed by Supabase, which verifies for itself. This exists so the
 * minting can be tested for what it actually claims rather than that it
 * produced a string, and so a future desktop-to-daemon call can check one.
 */
export function verifySupabaseToken(token: string): SupabaseTokenClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [header, body, signature] = parts;
  const expected = createHmac('sha256', SUPABASE_JWT_SECRET)
    .update(`${header}.${body}`)
    .digest('base64url');

  // Constant time, so a wrong signature cannot be narrowed down by timing.
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof payload.exp === 'number' && payload.exp * 1000 <= Date.now()) return null;
    return {
      sub: payload.sub,
      workspace_id: payload.workspace_id,
      alpha_role: payload.alpha_role
    };
  } catch {
    return null;
  }
}
