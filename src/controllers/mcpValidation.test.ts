import { describe, it, expect } from 'vitest';
import { mcpNameError, mcpServerError, toServerSpec, MCP_SPEC_MAX_BYTES } from './mcpValidation.js';

describe('mcpNameError', () => {
  it('accepts a plain name', () => {
    expect(mcpNameError('my-postgres')).toBeNull();
    expect(mcpNameError('internal_docs')).toBeNull();
    expect(mcpNameError('s3')).toBeNull();
  });

  it('requires a name', () => {
    expect(mcpNameError('')).toMatch(/required/);
    expect(mcpNameError('   ')).toMatch(/required/);
    expect(mcpNameError(undefined)).toMatch(/required/);
  });

  /**
   * The name becomes a CLI tool pattern (`mcp__<name>__<tool>`) and a JSON
   * object key. Anything that reads as either syntax is rejected rather than
   * escaped, because there is no reason to allow it in the first place.
   */
  it('rejects characters that would be read as syntax', () => {
    for (const bad of ['My-Server', 'a b', 'a/b', 'a.b', '../etc', 'a__b__c', '-leading']) {
      expect(mcpNameError(bad), bad).not.toBeNull();
    }
  });

  it('rejects a name longer than 64 characters', () => {
    expect(mcpNameError('a'.repeat(64))).toBeNull();
    expect(mcpNameError('a'.repeat(65))).not.toBeNull();
  });
});

describe('mcpServerError', () => {
  it('accepts a minimal server', () => {
    expect(mcpServerError({ command: 'npx' })).toBeNull();
  });

  it('accepts args and env', () => {
    expect(
      mcpServerError({ command: 'npx', args: ['-y', 'pkg'], env: { TOKEN: 'x' } })
    ).toBeNull();
  });

  it('requires a command', () => {
    expect(mcpServerError({})).toMatch(/command is required/);
    expect(mcpServerError({ command: '  ' })).toMatch(/command is required/);
    expect(mcpServerError(null)).toMatch(/server object is required/);
  });

  it('requires args to be strings', () => {
    expect(mcpServerError({ command: 'npx', args: 'not-an-array' })).toMatch(/args must be/);
    expect(mcpServerError({ command: 'npx', args: [1, 2] })).toMatch(/args must be/);
  });

  it('requires env to be a flat object of strings', () => {
    expect(mcpServerError({ command: 'npx', env: [] })).toMatch(/env must be/);
    expect(mcpServerError({ command: 'npx', env: { A: 1 } })).toMatch(/env\.A must be a string/);
    expect(mcpServerError({ command: 'npx', env: { '': 'x' } })).toMatch(/env keys cannot be empty/);
  });

  it('caps the size of one entry', () => {
    const huge = { command: 'npx', args: ['x'.repeat(MCP_SPEC_MAX_BYTES)] };
    expect(mcpServerError(huge)).toMatch(/exceeds/);
  });
});

describe('toServerSpec', () => {
  /**
   * The client round-trips what a GET gave it, which carries fields the catalog
   * has no business storing. Whitelisting is what keeps the file to the shape
   * the CLIs accept.
   */
  it('keeps only what the CLIs are spawned with', () => {
    const spec = toServerSpec({
      command: '  npx  ',
      args: ['-y', 'pkg'],
      env: { TOKEN: 'x' },
      // @ts-expect-error — fields a GET response carries but the file must not
      builtin: true,
      grantedTo: ['agent-ada'],
      envKeys: ['TOKEN']
    });

    expect(spec).toEqual({ command: 'npx', args: ['-y', 'pkg'], env: { TOKEN: 'x' } });
  });

  it('omits empty args and env rather than storing them', () => {
    expect(toServerSpec({ command: 'npx', args: [], env: {} })).toEqual({ command: 'npx' });
  });
});

/**
 * The hosted servers use a URL rather than a command. Verified against the CLI
 * before this was added: `{"type":"http","url":"https://mcp.context7.com/mcp"}`
 * reports `{"name":"context7","status":"connected"}` and exposes its tools.
 */
describe('http transport', () => {
  it('accepts a url server', () => {
    expect(mcpServerError({ type: 'http', url: 'https://mcp.context7.com/mcp' })).toBeNull();
    expect(mcpServerError({ type: 'sse', url: 'https://example.com/sse' })).toBeNull();
  });

  it('accepts headers', () => {
    expect(
      mcpServerError({ type: 'http', url: 'https://x.dev/mcp', headers: { Authorization: 'Bearer x' } })
    ).toBeNull();
  });

  it('requires a url', () => {
    expect(mcpServerError({ type: 'http' })).toMatch(/url is required/);
    expect(mcpServerError({ type: 'http', url: '  ' })).toMatch(/url is required/);
  });

  /**
   * Scheme, not just parseability: `file:` and `data:` parse perfectly well and
   * are not endpoints, and a bare host throws.
   */
  it('rejects a url that is not http or https', () => {
    expect(mcpServerError({ type: 'http', url: 'mcp.context7.com' })).toMatch(/valid absolute URL/);
    expect(mcpServerError({ type: 'http', url: 'file:///etc/passwd' })).toMatch(/must be http or https/);
    expect(mcpServerError({ type: 'http', url: 'data:text/plain,x' })).toMatch(/must be http or https/);
  });

  it('rejects an unknown transport', () => {
    expect(mcpServerError({ type: 'carrier-pigeon', url: 'https://x.dev' })).toMatch(/type must be/);
  });

  /**
   * Mixing the shapes is named rather than ignored: the unused half would
   * otherwise be dropped by toServerSpec without the user being told.
   */
  it('refuses a payload that mixes the two transports', () => {
    expect(mcpServerError({ type: 'http', url: 'https://x.dev/mcp', command: 'npx' }))
      .toMatch(/not command, args or env/);
    expect(mcpServerError({ command: 'npx', url: 'https://x.dev/mcp' }))
      .toMatch(/not url or headers/);
  });

  it('keeps only the url fields', () => {
    const spec = toServerSpec({
      type: 'http',
      url: '  https://x.dev/mcp  ',
      headers: { Authorization: 'Bearer x' },
      // @ts-expect-error — fields a GET response carries but the file must not
      builtin: false,
      grantedTo: []
    });
    expect(spec).toEqual({ type: 'http', url: 'https://x.dev/mcp', headers: { Authorization: 'Bearer x' } });
  });

  it('omits empty headers', () => {
    expect(toServerSpec({ type: 'http', url: 'https://x.dev/mcp', headers: {} }))
      .toEqual({ type: 'http', url: 'https://x.dev/mcp' });
  });

  /** A stdio entry written before transports existed has no `type` and must still work. */
  it('treats a missing type as stdio', () => {
    expect(mcpServerError({ command: 'npx' })).toBeNull();
    expect(toServerSpec({ command: 'npx' })).toEqual({ command: 'npx' });
  });
});
