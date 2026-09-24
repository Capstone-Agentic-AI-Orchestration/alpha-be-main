import { createHash } from 'node:crypto';

import { AlphaRole, fetchTeamsWithToken, roleForLogin } from './identityService.js';
import { mintSupabaseToken } from './supabaseTokenService.js';
import { logError, logInfo } from '../utils/logger.js';

/**
 * A database token for the desktop, in exchange for proof of who it is.
 *
 * The browser gets its token from a session (`GET /database/token`). The
 * desktop has no session -- its identity is the machine's `gh` login -- and it
 * used to mint its own token with the Supabase JWT secret instead. That made
 * the desktop both the claimant and the judge: whatever role it wrote into the
 * token, Supabase believed, so every policy was only as strong as the least
 * careful developer's `.env`.
 *
 * Now the desktop presents its GitHub token and this decides everything that
 * goes into the token from what GitHub says: the login from `/user`, the role
 * from team membership through the same `roleForLogin` the web sign-in uses.
 * Nothing the caller asserts about itself is taken on trust, except which
 * workspace it wants -- and that is checked against membership.
 *
 * The GitHub token is used for those two reads and nothing else. It is never
 * stored or logged; the cache below is keyed by its hash.
 */

export type ExchangeResult =
  | { ok: true; token: string; expiresAt: string; login: string; role: AlphaRole }
  | { ok: false; status: 401 | 403 | 502 | 503; error: string };

/**
 * The part of `workspaceRegistry.resolve` this needs, injected for testing.
 * Awaited, because in the cloud it reads Postgres.
 */
export type ResolveWorkspace = (
  login: string,
  requestedWorkspaceId: string | undefined,
  role: AlphaRole
) =>
  | { userId: string; workspaceId: string; role: AlphaRole }
  | null
  | Promise<{ userId: string; workspaceId: string; role: AlphaRole } | null>;

/**
 * How long a verified identity is reused.
 *
 * The desktop re-exchanges every ten minutes, and each exchange would
 * otherwise cost two GitHub calls. Five minutes keeps that to one lookup per
 * refresh at most, and bounds how long a removal from a team goes unnoticed
 * here -- though a token already issued lives out its own ten minutes anyway.
 */
const IDENTITY_TTL_MS = 5 * 60 * 1000;

/**
 * Only identities that were granted a role are cached.
 *
 * Caching a refusal would make someone who was just added to a team wait out
 * the TTL for the fix to take effect, which is exactly when they are retrying.
 */
const identities = new Map<string, { login: string; role: AlphaRole; until: number }>();

/** For tests: forget every cached identity. */
export function clearExchangeCache(): void {
  identities.clear();
}

function keyFor(githubToken: string): string {
  return createHash('sha256').update(githubToken).digest('hex');
}

async function githubLogin(githubToken: string): Promise<{ login?: string; status: number }> {
  const res = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'alpha-orchestrator'
    }
  });
  if (!res.ok) return { status: res.status };
  const user = (await res.json()) as { login?: string };
  return { login: user.login, status: res.status };
}

export type VerifiedGitHubToken =
  | { ok: true; login: string; role: AlphaRole }
  | { ok: false; status: 401 | 403 | 502; error: string };

/**
 * Who a GitHub token belongs to, and the role their teams grant.
 *
 * Shared by the database-token exchange and by the cloud API's bearer sign-in
 * (`sessionContext`), so the desktop is one identity to both: the same login,
 * the same role, from the same two GitHub reads, cached the same way.
 */
export async function verifyGitHubToken(githubToken: string): Promise<VerifiedGitHubToken> {
  const key = keyFor(githubToken);
  let identity = identities.get(key);
  if (!identity || identity.until <= Date.now()) {
    identities.delete(key);

    let login: string | undefined;
    try {
      const user = await githubLogin(githubToken);
      if (user.status === 401) {
        return { ok: false, status: 401, error: 'GitHub did not accept that token. Run `gh auth login` again.' };
      }
      if (!user.login) {
        return { ok: false, status: 502, error: `GitHub answered ${user.status} when asked who this token belongs to.` };
      }
      login = user.login;
    } catch (err: any) {
      logError('Database token exchange: GitHub /user failed:', err?.message || err);
      return { ok: false, status: 502, error: 'Could not reach GitHub to verify the token.' };
    }

    const role = roleForLogin(login, await fetchTeamsWithToken(githubToken));
    if (!role) {
      logInfo(`Database token refused for ${login}: no team maps to a role.`);
      return {
        ok: false,
        status: 403,
        error:
          `${login} is in no team that grants an Alpha role. If you are, the gh token may lack ` +
          'read:org -- run `gh auth refresh -s read:org`.'
      };
    }

    identity = { login, role, until: Date.now() + IDENTITY_TTL_MS };
    identities.set(key, identity);
  }

  return { ok: true, login: identity.login, role: identity.role };
}

export async function exchangeGitHubToken(
  githubToken: string | undefined,
  requestedWorkspaceId: string | undefined,
  resolveWorkspace: ResolveWorkspace
): Promise<ExchangeResult> {
  if (!githubToken) {
    return { ok: false, status: 401, error: 'Send the GitHub token as "Authorization: Bearer <token>".' };
  }

  const identity = await verifyGitHubToken(githubToken);
  if (!identity.ok) return identity;

  const context = await resolveWorkspace(identity.login, requestedWorkspaceId, identity.role);
  if (!context) {
    return { ok: false, status: 403, error: 'You do not have access to the requested workspace.' };
  }

  try {
    const { token, expiresAt } = mintSupabaseToken({
      sub: context.userId,
      workspace_id: context.workspaceId,
      alpha_role: context.role
    });
    return { ok: true, token, expiresAt, login: identity.login, role: context.role };
  } catch (err: any) {
    // Unconfigured is a deployment gap, not a caller error.
    return { ok: false, status: 503, error: err?.message ?? 'Database tokens are not configured.' };
  }
}
