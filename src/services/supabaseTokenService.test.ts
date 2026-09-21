import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * The claims contract between this server and the RLS policies.
 *
 * `0002_row_level_security.sql` reads three claims and decides every row
 * access from them. If this service and that file disagree about a name, the
 * policies do not fail — they evaluate `null` and quietly deny everything, or
 * worse, match a row they should not. So the names are asserted here rather
 * than assumed, and `rlsPolicies.test.ts` asserts the other end of the same
 * contract.
 */
async function withSecret(secret: string, mode: 'cloud' | 'desktop' = 'cloud') {
  process.env.SUPABASE_JWT_SECRET = secret;
  process.env.ALPHA_MODE = mode;
  vi.resetModules();
  return import('./supabaseTokenService.js');
}

const decode = (token: string) =>
  JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));

beforeEach(() => vi.resetModules());
afterEach(() => {
  delete process.env.SUPABASE_JWT_SECRET;
  delete process.env.SUPABASE_TOKEN_TTL_MS;
  delete process.env.ALPHA_MODE;
  vi.resetModules();
});

describe('database tokens', () => {
  /**
   * The desktop used to sign its own tokens with this secret, choosing its
   * own role. A desktop with the secret still in an old `.env` must refuse
   * rather than quietly carry on.
   */
  it('refuses to mint outside cloud mode, even with the secret set', async () => {
    const { mintSupabaseToken } = await withSecret('test-secret', 'desktop');
    expect(() =>
      mintSupabaseToken({ sub: 'LloydLim1', workspace_id: 'ws1', alpha_role: 'admin' })
    ).toThrow(/only by the cloud/);
  });

  it('carries exactly the claims the policies read', async () => {
    const { mintSupabaseToken } = await withSecret('test-secret');
    const { token } = mintSupabaseToken({
      sub: 'Lloyd1020',
      workspace_id: 'ws1',
      alpha_role: 'dev'
    });

    const claims = decode(token);
    expect(claims.sub).toBe('Lloyd1020');
    expect(claims.workspace_id).toBe('ws1');
    expect(claims.alpha_role).toBe('dev');
  });

  /**
   * `role` and `alpha_role` are different things and must stay that way.
   *
   * PostgREST reads `role` to decide which Postgres role to run as, and
   * rejects anything but `authenticated` or `anon`. Alpha's own role could
   * never have shared that claim — a single `role` would have had to mean both
   * "which database role" and "pm or dev" at once. This is why the policies
   * read `alpha_role`.
   */
  it('sets the postgres role to authenticated, separately from the alpha role', async () => {
    const { mintSupabaseToken } = await withSecret('test-secret');
    const { token } = mintSupabaseToken({
      sub: 'LloydLim1',
      workspace_id: 'ws1',
      alpha_role: 'pm'
    });

    const claims = decode(token);
    expect(claims.role).toBe('authenticated');
    expect(claims.aud).toBe('authenticated');
    expect(claims.alpha_role).toBe('pm');
  });

  it('expires in minutes, not days', async () => {
    const { mintSupabaseToken } = await withSecret('test-secret');
    const { token } = mintSupabaseToken({
      sub: 'x', workspace_id: 'ws1', alpha_role: 'dev'
    });

    const { iat, exp } = decode(token);
    const minutes = (exp - iat) / 60;
    expect(minutes).toBeGreaterThan(0);
    expect(minutes).toBeLessThanOrEqual(60);
  });

  it('round-trips a token it signed', async () => {
    const { mintSupabaseToken, verifySupabaseToken } = await withSecret('test-secret');
    const { token } = mintSupabaseToken({
      sub: 'Lloyd1020', workspace_id: 'ws1', alpha_role: 'admin'
    });

    expect(verifySupabaseToken(token)?.sub).toBe('Lloyd1020');
    expect(verifySupabaseToken(token)?.alpha_role).toBe('admin');
  });

  /** The claims are signed, so editing them invalidates the token. */
  it('rejects a token whose claims were edited', async () => {
    const { mintSupabaseToken, verifySupabaseToken } = await withSecret('test-secret');
    const { token } = mintSupabaseToken({
      sub: 'Lloyd1020', workspace_id: 'ws1', alpha_role: 'dev'
    });

    const [header, body, sig] = token.split('.');
    const tampered = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    tampered.alpha_role = 'admin';
    const forged = `${header}.${Buffer.from(JSON.stringify(tampered)).toString('base64url')}.${sig}`;

    expect(verifySupabaseToken(forged)).toBeNull();
  });

  it('rejects a token signed with a different secret', async () => {
    const one = await withSecret('secret-one');
    const { token } = one.mintSupabaseToken({
      sub: 'x', workspace_id: 'ws1', alpha_role: 'dev'
    });

    const two = await withSecret('secret-two');
    expect(two.verifySupabaseToken(token)).toBeNull();
  });

  it('rejects an expired token', async () => {
    process.env.SUPABASE_TOKEN_TTL_MS = '-1000';
    const { mintSupabaseToken, verifySupabaseToken } = await withSecret('test-secret');
    const { token } = mintSupabaseToken({
      sub: 'x', workspace_id: 'ws1', alpha_role: 'dev'
    });

    expect(verifySupabaseToken(token)).toBeNull();
  });

  /** Unconfigured is a deployment gap, and should say so rather than sign junk. */
  it('refuses to mint without a signing secret', async () => {
    const { mintSupabaseToken } = await withSecret('');
    expect(() =>
      mintSupabaseToken({ sub: 'x', workspace_id: 'ws1', alpha_role: 'dev' })
    ).toThrow(/SUPABASE_JWT_SECRET/);
  });
});
