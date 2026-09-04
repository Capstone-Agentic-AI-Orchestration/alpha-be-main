/**
 * MCP catalog payload validation.
 *
 * Kept out of `mcpController` for the same reason `agentValidation` is kept out
 * of `dataController`: the controller pulls in `sqliteService`, which opens the
 * database at import time and needs the native `better-sqlite3` binding. A pure
 * check should not need either to be tested.
 *
 * ## Why this is stricter than the other validators
 *
 * A catalog entry is not data. It is `{ command, args, env }`, and Alpha spawns
 * it as a child process on every turn of every agent granted it. Writing one
 * over HTTP is therefore writing a command the machine will execute later — so
 * the shape is checked properly rather than trusted.
 *
 * That is not a new capability: `POST /runs/start` already spawns shell, and the
 * daemon binds 127.0.0.1 behind a CORS allowlist. What is new is persistence —
 * a run's command dies with the run, a catalog entry runs again every turn.
 */

/**
 * Server names become part of a CLI tool pattern (`mcp__<name>__<tool>`) and a
 * JSON object key, so they are restricted to something that cannot be mistaken
 * for either syntax.
 */
export const MCP_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Ceiling on a single catalog entry, to keep a paste accident out of the file. */
export const MCP_SPEC_MAX_BYTES = 8 * 1024;

export interface McpStdioInput {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpHttpInput {
  type: 'http' | 'sse';
  url: string;
  headers?: Record<string, string>;
}

export type McpServerInput = McpStdioInput | McpHttpInput;

/** A payload declaring one of the URL transports, however malformed otherwise. */
function declaresHttp(body: any): boolean {
  return body?.type === 'http' || body?.type === 'sse';
}

/** Shared shape check for env and headers: a flat object of string values. */
function stringMapError(value: unknown, label: string): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return `${label} must be an object of string values`;
  }
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== 'string') return `${label}.${k} must be a string`;
    // An empty key would serialise to something the far side cannot read, so it
    // is a typo rather than a value worth storing.
    if (!k.trim()) return `${label} keys cannot be empty`;
  }
  return null;
}

/** The reason this server name is unusable, or null when it is fine. */
export function mcpNameError(name: unknown): string | null {
  if (typeof name !== 'string' || !name.trim()) return 'name is required';
  if (!MCP_NAME_PATTERN.test(name)) {
    return 'name must be lowercase letters, digits, hyphen or underscore, starting with a letter or digit, max 64 characters';
  }
  /**
   * No double underscore, because the tool pattern is a *prefix*.
   *
   * `mcpToolPatterns` emits `mcp__<name>`, and Claude Code matches that as a
   * prefix over `mcp__<server>__<tool>`. A server called `a` would therefore
   * also allowlist every tool of a server called `a__b` — granting one server
   * would silently grant another. Rejecting the separator in a name is what
   * keeps one grant to one server.
   */
  if (name.includes('__')) {
    return 'name cannot contain a double underscore: it is the separator in the mcp__<server>__<tool> pattern';
  }
  return null;
}

/** The reason this server payload is invalid, or null when it is fine. */
export function mcpServerError(body: any): string | null {
  if (!body || typeof body !== 'object') return 'a server object is required';

  if (body.type !== undefined && !['stdio', 'http', 'sse'].includes(body.type)) {
    return 'type must be "stdio", "http" or "sse"';
  }

  if (declaresHttp(body)) {
    /**
     * Checked for scheme, not just parseability. `file:` and `data:` parse
     * perfectly well and are not endpoints, and a bare host with no scheme
     * throws — both deserve a reason here rather than an opaque CLI failure
     * on some later turn.
     */
    if (typeof body.url !== 'string' || !body.url.trim()) return 'url is required';

    let parsed: URL;
    try {
      parsed = new URL(body.url);
    } catch {
      return 'url must be a valid absolute URL';
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return 'url must be http or https';
    }

    if (body.headers !== undefined) {
      const headerError = stringMapError(body.headers, 'headers');
      if (headerError) return headerError;
    }

    // Mixing the two shapes is a mistake worth naming: the ignored half would
    // otherwise vanish silently in toServerSpec.
    if (body.command !== undefined || body.args !== undefined || body.env !== undefined) {
      return 'an http server takes url and headers, not command, args or env';
    }
  } else {
    const command = body.command;
    if (typeof command !== 'string' || !command.trim()) {
      return 'command is required';
    }

    if (body.args !== undefined) {
      if (!Array.isArray(body.args) || body.args.some((a: unknown) => typeof a !== 'string')) {
        return 'args must be an array of strings';
      }
    }

    if (body.env !== undefined) {
      const envError = stringMapError(body.env, 'env');
      if (envError) return envError;
    }

    if (body.url !== undefined || body.headers !== undefined) {
      return 'a stdio server takes command, args and env, not url or headers';
    }
  }

  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > MCP_SPEC_MAX_BYTES) {
    return `server definition exceeds ${MCP_SPEC_MAX_BYTES} bytes`;
  }

  return null;
}

/**
 * Narrow a validated body to just the fields the transport uses.
 *
 * The client may send more than that — a `builtin` flag, a `grantedTo` list it
 * read back from a GET — and none of it belongs on disk. Whitelisting here is
 * what keeps the catalog file to the shape the CLIs actually accept.
 */
export function toServerSpec(body: McpServerInput): McpServerInput {
  if (declaresHttp(body)) {
    const http = body as McpHttpInput;
    const spec: McpHttpInput = { type: http.type, url: http.url.trim() };
    if (http.headers && Object.keys(http.headers).length) spec.headers = http.headers;
    return spec;
  }

  const stdio = body as McpStdioInput;
  const spec: McpStdioInput = { command: stdio.command.trim() };
  if (stdio.args?.length) spec.args = stdio.args;
  if (stdio.env && Object.keys(stdio.env).length) spec.env = stdio.env;
  return spec;
}
