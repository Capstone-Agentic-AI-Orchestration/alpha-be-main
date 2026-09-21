import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Which browser origins may call this API with credentials.
 *
 * The allowlist exists because the desktop daemon spawns shell commands: with
 * a permissive origin, any page the user had open could start a run on their
 * machine. In the cloud the stake is the session cookie instead, which is why
 * `credentials: true` makes the precision of these patterns load-bearing.
 *
 * The subtlety this file is really about: a wildcard's *shape* and a
 * wildcard's *trust* are different questions. `https://*.vercel.app` matches
 * exactly one label and is anchored at both ends — shape is fine. It is still
 * unsafe, because anyone can register a name that satisfies it.
 */
async function withOrigins(value: string) {
  process.env.CORS_ORIGIN = value;
  vi.resetModules();
  return import('./env.js');
}

beforeEach(() => vi.resetModules());
afterEach(() => {
  delete process.env.CORS_ORIGIN;
  vi.resetModules();
});

describe('CORS origin allowlist', () => {
  it('accepts an exactly listed origin and nothing adjacent to it', async () => {
    const { isAllowedOrigin } = await withOrigins('https://alpha.example.com');
    expect(isAllowedOrigin('https://alpha.example.com')).toBe(true);
    expect(isAllowedOrigin('https://alpha.example.com.attacker.net')).toBe(false);
    expect(isAllowedOrigin('http://alpha.example.com')).toBe(false);
  });

  describe('a wildcard over an apex the operator controls', () => {
    it('matches one label, anchored', async () => {
      const { isAllowedOrigin } = await withOrigins('https://*.alpha.example.com');
      expect(isAllowedOrigin('https://preview.alpha.example.com')).toBe(true);
      // One label only: a deeper subdomain is a different owner's to issue.
      expect(isAllowedOrigin('https://a.b.alpha.example.com')).toBe(false);
      // Anchored: a suffix match must not admit a lookalike.
      expect(isAllowedOrigin('https://x.alpha.example.com.evil.net')).toBe(false);
    });
  });

  describe('a wildcard over a shared hosting apex', () => {
    /**
     * The finding this file was written for.
     *
     * `alpha-fe-git-main-lloyd.vercel.app` and `attacker-exfil.vercel.app` come
     * from the same registrar, free, to anyone. A wildcard across that apex is
     * not an allowlist; with credentials enabled it lets any tenant of the
     * platform replay a signed-in user's cookie against this API.
     */
    it('is refused outright rather than admitting every tenant', async () => {
      const { isAllowedOrigin, unsafeOriginPatterns } = await withOrigins('https://*.vercel.app');
      expect(isAllowedOrigin('https://alpha-fe-git-main.vercel.app')).toBe(false);
      expect(isAllowedOrigin('https://attacker-exfil.vercel.app')).toBe(false);
      expect(unsafeOriginPatterns()).toHaveLength(1);
    });

    it('is refused for other multi-tenant platforms too', async () => {
      for (const apex of ['netlify.app', 'pages.dev', 'onrender.com', 'github.io']) {
        const { isAllowedOrigin } = await withOrigins(`https://*.${apex}`);
        expect(isAllowedOrigin(`https://anything.${apex}`)).toBe(false);
      }
    });

    it('is refused when the literal part is a token gesture', async () => {
      const { isAllowedOrigin } = await withOrigins('https://*-app.vercel.app');
      expect(isAllowedOrigin('https://evil-app.vercel.app')).toBe(false);
    });

    /**
     * The escape hatch, and the shape to document for operators.
     *
     * Vercel preview URLs end `-<team-slug>.vercel.app`. Pinning that slug puts
     * the match back behind something the operator controls: an attacker would
     * have to publish under their team.
     */
    it('is allowed when the pattern pins a label the operator controls', async () => {
      const { isAllowedOrigin } = await withOrigins('https://alpha-fe-main-*-lloyds-projects.vercel.app');
      expect(isAllowedOrigin('https://alpha-fe-main-a1b2c3-lloyds-projects.vercel.app')).toBe(true);
      expect(isAllowedOrigin('https://attacker-exfil.vercel.app')).toBe(false);
      expect(isAllowedOrigin('https://alpha-fe-main-a1b2c3-someone-else.vercel.app')).toBe(false);
    });
  });

  it('refuses a bare "*", which cannot be combined with credentials anyway', async () => {
    const { isAllowedOrigin, unsafeOriginPatterns } = await withOrigins('*');
    expect(isAllowedOrigin('https://anything.at.all')).toBe(false);
    expect(unsafeOriginPatterns()).toHaveLength(1);
  });

  it('keeps the safe entries when one entry in the list is refused', async () => {
    const { isAllowedOrigin } = await withOrigins('https://alpha.example.com,https://*.vercel.app');
    expect(isAllowedOrigin('https://alpha.example.com')).toBe(true);
    expect(isAllowedOrigin('https://attacker-exfil.vercel.app')).toBe(false);
  });
});
