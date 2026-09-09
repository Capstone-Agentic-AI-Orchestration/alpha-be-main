import { describe, it, expect } from 'vitest';
import { expandEnvRefs } from './mcpConfigService.js';

/**
 * Secrets live in the environment; the catalog holds only a reference.
 *
 * `~/.alpha/mcp.json` is a plain file the user is invited to hand-edit and
 * share. A Supabase personal access token can administer every project in an
 * organisation, so the catalog carries `${SUPABASE_ACCESS_TOKEN}` and this
 * resolves it at spawn time.
 */
describe('expandEnvRefs', () => {
  it('fills a header reference from the environment', () => {
    const { spec, missing } = expandEnvRefs(
      { type: 'http', url: 'https://mcp.supabase.com/mcp', headers: { Authorization: 'Bearer ${TOK}' } },
      { TOK: 'sbp_real_token' }
    );

    expect(missing).toEqual([]);
    expect(spec).toEqual({
      type: 'http',
      url: 'https://mcp.supabase.com/mcp',
      headers: { Authorization: 'Bearer sbp_real_token' }
    });
  });

  it('fills references in a url', () => {
    // The CI form scopes the server to one project through a query parameter.
    const { spec } = expandEnvRefs(
      { type: 'http', url: 'https://mcp.supabase.com/mcp?project_ref=${REF}' },
      { REF: 'abcdefgh' }
    );

    expect((spec as { url: string }).url).toBe('https://mcp.supabase.com/mcp?project_ref=abcdefgh');
  });

  it('fills references in stdio command, args and env', () => {
    const { spec, missing } = expandEnvRefs(
      { command: 'npx', args: ['-y', 'pkg@${VER}'], env: { TOKEN: '${TOK}' } },
      { VER: 'latest', TOK: 'secret' }
    );

    expect(missing).toEqual([]);
    expect(spec).toEqual({ command: 'npx', args: ['-y', 'pkg@latest'], env: { TOKEN: 'secret' } });
  });

  /**
   * The case this exists to prevent.
   *
   * Passing the placeholder through would authenticate as nobody: the server
   * connects, every tool answers 401, and the agent spends its turn finding
   * that out. The caller skips the server when anything is missing.
   */
  it('reports an unset variable instead of substituting nothing', () => {
    const { spec, missing } = expandEnvRefs(
      { type: 'http', url: 'https://x', headers: { Authorization: 'Bearer ${NOPE}' } },
      {}
    );

    expect(missing).toEqual(['NOPE']);
    // Left as written, so a caller that ignores `missing` sends something
    // obviously broken rather than a plausible-looking empty credential.
    expect((spec as any).headers.Authorization).toBe('Bearer ${NOPE}');
  });

  it('treats an empty variable as unset', () => {
    // `SUPABASE_ACCESS_TOKEN=` in a shell profile is a mistake, not a value.
    const { missing } = expandEnvRefs(
      { type: 'http', url: 'https://x', headers: { Authorization: 'Bearer ${TOK}' } },
      { TOK: '' }
    );

    expect(missing).toEqual(['TOK']);
  });

  it('reports every missing name once', () => {
    const { missing } = expandEnvRefs(
      { type: 'http', url: 'https://x/${A}', headers: { H1: '${B}', H2: '${A}' } },
      {}
    );

    expect(missing.sort()).toEqual(['A', 'B']);
  });

  it('leaves a spec with no references untouched', () => {
    const plain = { command: 'npx', args: ['-y', 'thing'] };
    const { spec, missing } = expandEnvRefs(plain, {});

    expect(spec).toEqual(plain);
    expect(missing).toEqual([]);
  });

  it('does not touch a bare $VAR or a lone dollar', () => {
    // Only the braced form is a reference. A password or query string
    // containing a dollar sign must survive unchanged.
    const { spec, missing } = expandEnvRefs(
      { type: 'http', url: 'https://x/$HOME/a$b' },
      { HOME: '/root' }
    );

    expect((spec as { url: string }).url).toBe('https://x/$HOME/a$b');
    expect(missing).toEqual([]);
  });

  it('does not read the real environment when one is supplied', () => {
    // Guards the default-parameter form from making tests depend on the host.
    const { missing } = expandEnvRefs({ command: '${PATH}' }, {});
    expect(missing).toEqual(['PATH']);
  });
});
