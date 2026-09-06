import fs from 'node:fs';
import path from 'node:path';

import { ALPHA_DIR, RUNS_DIR } from '../config/env.js';
import { mcpCredentialEnv } from './gitCredentialIsolation.js';
import { logError } from '../utils/logger.js';

/**
 * One MCP server as the CLIs expect it.
 *
 * Two transports, because the ecosystem uses both and neither covers the other:
 *
 *   - **stdio** — a command Alpha spawns as a child process. What every
 *     `npx`-launched server uses, and what the built-in GitHub server is.
 *   - **http / sse** — a URL the CLI connects to. What the hosted servers use
 *     (Context7, Supabase, Linear and the rest). Nothing is installed, nothing
 *     is spawned, and it cannot fail offline mid-run the way `npx -y` can.
 *
 * The shapes match `claude --mcp-config` exactly, so a definition can be copied
 * between Alpha and a hand-written config unchanged. Verified against the CLI:
 * `{"type":"http","url":"https://mcp.context7.com/mcp"}` reports
 * `{"name":"context7","status":"connected"}` and exposes its tools.
 */
export interface McpStdioServerSpec {
  /** Optional so a pre-existing stdio entry keeps working without one. */
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpHttpServerSpec {
  type: "http" | "sse";
  url: string;
  /** Sent on every request — an Authorization header, typically. */
  headers?: Record<string, string>;
}

export type McpServerSpec = McpStdioServerSpec | McpHttpServerSpec;

/** Narrow a spec to the transport it declares. */
export function isHttpSpec(spec: McpServerSpec): spec is McpHttpServerSpec {
  return spec.type === "http" || spec.type === "sse";
}

export interface McpCatalog {
  mcpServers: Record<string, McpServerSpec>;
}

/** User-editable catalog of MCP servers available to any agent. */
export const MCP_CATALOG_PATH = path.join(ALPHA_DIR, 'mcp.json');

/**
 * The GitHub server Alpha ships.
 *
 * Resolved from this file's own location rather than the process working
 * directory: the daemon's cwd is wherever it was launched, but the server
 * always sits beside this module — `dist/mcp/` at runtime, `src/mcp/` under
 * tsx. `__dirname` holds in both because the backend compiles to CommonJS.
 */
function builtinGithubServer(): McpServerSpec {
  const compiled = path.join(__dirname, '..', 'mcp', 'githubMcpServer.js');

  // `npm start` runs from dist, where the compiled server sits beside this
  // file. Spawn it with the same node binary the daemon is using rather than
  // whatever `node` resolves to on PATH.
  if (fs.existsSync(compiled)) {
    /**
     * Under Electron, `process.execPath` is Alpha.exe — not node.
     *
     * The desktop shell runs this daemon inside the Electron main process, so
     * spawning execPath plainly would launch a second copy of the whole
     * application (which would then try to bind port 3001, fail, and show an
     * error dialog) instead of running a stdio MCP server.
     *
     * ELECTRON_RUN_AS_NODE is Electron's own switch for exactly this: it makes
     * the same binary behave as node. It also keeps the asar-aware `fs`, which
     * matters because in a packaged build `compiled` is a path *inside*
     * app.asar and a plain node process cannot read from an archive.
     *
     * Safe to pass as the child's whole environment if the CLI replaces rather
     * than merges: githubMcpServer reads no environment variables.
     */
    return process.versions.electron
      ? { command: process.execPath, args: [compiled], env: { ELECTRON_RUN_AS_NODE: '1' } }
      : { command: process.execPath, args: [compiled] };
  }

  // `npm run dev` runs from src through tsx, so the server has to be run the
  // same way. Prefer the tsx already installed here — `npx -y` would consult
  // the registry on every spawn, adding seconds to each turn and failing
  // outright offline.
  const source = path.join(__dirname, '..', 'mcp', 'githubMcpServer.ts');
  const localTsx = path.join(
    __dirname,
    '..',
    '..',
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'tsx.cmd' : 'tsx'
  );

  return fs.existsSync(localTsx)
    ? { command: localTsx, args: [source] }
    : { command: 'npx', args: ['-y', 'tsx', source] };
}

export const BUILTIN_SERVERS: Record<string, McpServerSpec> = {
  get 'alpha-github'() {
    return builtinGithubServer();
  }
};

/**
 * Read the user catalog, if any.
 *
 * A malformed file is reported and treated as empty rather than thrown: a typo
 * in an optional config should cost the agent its extra tools, not the turn.
 */
export function readCatalog(): Record<string, McpServerSpec> {
  try {
    if (!fs.existsSync(MCP_CATALOG_PATH)) return {};
    const parsed = JSON.parse(fs.readFileSync(MCP_CATALOG_PATH, 'utf8')) as McpCatalog;
    return parsed?.mcpServers ?? {};
  } catch (err: any) {
    logError(`Ignoring malformed ${MCP_CATALOG_PATH}: ${err?.message ?? err}`);
    return {};
  }
}

/** Every server an agent could be granted, built-ins plus user catalog. */
export function availableServers(): Record<string, McpServerSpec> {
  // The catalog wins on a name collision, so a user can point `alpha-github`
  // at their own build without editing Alpha.
  return { ...BUILTIN_SERVERS, ...readCatalog() };
}

export interface RunMcpConfig {
  /** Path to pass to `--mcp-config`, or null when the agent has no servers. */
  configPath: string | null;
  /** Names actually resolved, for the allowlist and for logging. */
  serverNames: string[];
}

/**
 * Write the MCP config for a single run.
 *
 * Per-run rather than pointing every agent at the shared catalog: that is what
 * makes `agent.mcpServers` mean anything. Passed to a global config, every
 * agent would inherit every configured server no matter what it was granted.
 *
 * Names the agent lists that resolve to nothing are skipped with a log rather
 * than failing the run — an agent referencing a server the user has since
 * deleted should lose that tool, not stop working.
 */
export function writeRunMcpConfig(
  runId: string,
  requested: string[] | undefined,
  /**
   * Values layered over the daemon's own environment when resolving `${VAR}`.
   *
   * The catalog is global — one `supabase` entry — but what it points at is
   * not. A project supplies its own `SUPABASE_PROJECT_REF`, and an agent may
   * override that again, so the same catalog entry reaches a different Supabase
   * project depending on which board the card came from.
   *
   * Least specific first, so the caller composes them in reading order.
   */
  overrides: Record<string, string> = {},
  /**
   * The directory this turn is working in.
   *
   * Handed to the built-in server explicitly rather than left to process
   * inheritance. The server is a grandchild — Alpha spawns the agent CLI, the
   * CLI spawns the server — and nothing in that chain promises to carry a
   * working directory. A push tool that guesses wrong pushes the wrong
   * repository, so it is told.
   */
  workspace?: string
): RunMcpConfig {
  const names = (requested ?? []).map(n => n.trim()).filter(Boolean);
  if (!names.length) return { configPath: null, serverNames: [] };

  const available = availableServers();
  const mcpServers: Record<string, McpServerSpec> = {};

  /**
   * Blank overrides are dropped rather than layered.
   *
   * A spread would let `SUPABASE_PROJECT_REF: ''` overwrite a perfectly good
   * machine value with nothing, and the server would then be skipped for a
   * missing variable the user had actually set. An emptied field in a form
   * means "I have no value for this", not "use the empty string" — so it falls
   * through to the layer beneath.
   */
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== '') env[key] = value;
  }

  for (const name of names) {
    const spec = available[name];
    if (!spec) {
      logError(`Agent requested unknown MCP server "${name}" — skipping.`);
      continue;
    }

    /**
     * A server whose credentials are not on this machine is left out.
     *
     * The alternative is writing `Bearer ${SUPABASE_ACCESS_TOKEN}` through
     * verbatim, which authenticates as nobody: the server connects, every tool
     * answers 401, and the agent spends its turn discovering that. Skipping is
     * the same treatment an unknown name gets, and for the same reason.
     */
    const { spec: resolved, missing } = expandEnvRefs(resolveForPlatform(spec), env);
    if (missing.length) {
      logError(
        `MCP server "${name}" needs ${missing.join(', ')} in the environment — skipping. ` +
        `Set it where the Alpha daemon runs, then start the run again.`
      );
      continue;
    }

    /**
     * The built-in server is the only one that acts on the local checkout, and
     * the only one Alpha can tell where that is.
     */
    mcpServers[name] =
      name === 'alpha-github' && workspace && !isHttpSpec(resolved)
        ? {
            ...resolved,
            env: {
              ...resolved.env,
              ALPHA_WORKSPACE: workspace,
              ALPHA_RUN_ID: runId,
              /**
               * The credentials, given back to this process alone.
               *
               * It inherits the stripped values from the agent CLI that spawned
               * it. This is the one place a push is permitted, because it is
               * the one place Alpha can refuse a protected branch and record
               * what happened.
               */
              ...mcpCredentialEnv()
            }
          }
        : resolved;
  }

  if (!Object.keys(mcpServers).length) return { configPath: null, serverNames: [] };

  const dir = path.join(RUNS_DIR, runId);
  const configPath = path.join(dir, 'mcp.json');

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers }, null, 2), 'utf8');
  } catch (err: any) {
    logError(`Could not write MCP config for ${runId}: ${err?.message ?? err}`);
    return { configPath: null, serverNames: [] };
  }

  return { configPath, serverNames: Object.keys(mcpServers) };
}

/**
 * npm ships these as `.cmd` shims on Windows, and a spawn without a shell will
 * not find them by their bare name.
 *
 * Not a general PATHEXT search — that would need to hit the filesystem for every
 * server on every turn, and would change behaviour based on what happens to be
 * installed. A named list of the launchers people actually type is predictable
 * and covers the real cases.
 */
const WINDOWS_SHIMS = new Set(['npx', 'npm', 'pnpm', 'pnpx', 'yarn', 'bunx']);

/**
 * Resolve a catalog entry to the form this machine can actually spawn.
 *
 * Applied when writing the per-run config rather than when saving to the
 * catalog, so the catalog keeps what the user typed. That matters because
 * `~/.alpha/mcp.json` is a portable, hand-editable file: storing `npx.cmd`
 * would break it for the same person on a mac, and for anyone they share it
 * with. Resolution belongs where the process is spawned, not where the
 * intention is recorded.
 *
 * Measured on Windows: `{"command":"npx"}` reports `failed` with no usable
 * error, and the identical entry as `npx.cmd` reports `connected`. The built-in
 * GitHub server already carries the same platform branch for `tsx`.
 */
function resolveForPlatform(spec: McpServerSpec): McpServerSpec {
  if (isHttpSpec(spec)) return spec;
  if (process.platform !== 'win32') return spec;
  if (!WINDOWS_SHIMS.has(spec.command)) return spec;

  return { ...spec, command: `${spec.command}.cmd` };
}

/**
 * `${VAR}` in a catalog entry, resolved from the environment at spawn time.
 *
 * Hosted MCP servers authenticate with a bearer token, and the catalog is a
 * plain JSON file in the user's home directory. Writing a Supabase personal
 * access token — which can administer every project in an organisation —
 * literally into `~/.alpha/mcp.json` would make a hand-editable config file
 * into a credential store, and Alpha deliberately stores no provider
 * credentials anywhere else.
 *
 * So the catalog holds the *reference* and the environment holds the secret:
 *
 *   "headers": { "Authorization": "Bearer ${SUPABASE_ACCESS_TOKEN}" }
 *
 * Expanded here rather than left for the CLI to do, for the same reason the
 * Windows `.cmd` shim is applied here: it has to work identically for all three
 * CLIs. Claude Code expands `${VAR}` in an MCP config; codex and agy are not
 * required to, and a config that silently means different things to different
 * agents is worse than one that means nothing to any of them.
 *
 * Applied at write time, so the catalog file stays portable and shareable —
 * exactly what a reference rather than a secret is for.
 */
const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Substitute into every string in a spec, collecting the names that are unset. */
function expandStrings(value: unknown, env: NodeJS.ProcessEnv, missing: Set<string>): unknown {
  if (typeof value === 'string') {
    return value.replace(ENV_REF, (whole, name: string) => {
      const found = env[name];
      if (found === undefined || found === '') {
        missing.add(name);
        return whole;
      }
      return found;
    });
  }
  if (Array.isArray(value)) return value.map(v => expandStrings(v, env, missing));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, expandStrings(v, env, missing)])
    );
  }
  return value;
}

/**
 * A spec with its environment references filled in, plus any that could not be.
 *
 * `missing` is returned rather than thrown so the caller can decide. It always
 * decides to skip the server: sending a literal `Bearer ${SUPABASE_ACCESS_TOKEN}`
 * would authenticate as nobody, and the agent would spend its turn on a tool
 * that answers 401 to everything.
 */
export function expandEnvRefs(
  spec: McpServerSpec,
  env: NodeJS.ProcessEnv = process.env
): { spec: McpServerSpec; missing: string[] } {
  const missing = new Set<string>();
  const expanded = expandStrings(spec, env, missing) as McpServerSpec;
  return { spec: expanded, missing: [...missing] };
}

/** Best-effort cleanup of a run's config directory. */
export function cleanupRunMcpConfig(runId: string): void {
  try {
    fs.rmSync(path.join(RUNS_DIR, runId), { recursive: true, force: true });
  } catch {
    // A leftover config file is harmless; failing the turn over it is not.
  }
}

/**
 * Tool-name patterns that permit an MCP server's tools.
 *
 * Claude Code namespaces MCP tools as `mcp__<server>__<tool>`. The chat turn
 * runs with an explicit `--allowedTools` list, so without these the servers
 * would connect and every call would then be denied.
 */
export function mcpToolPatterns(serverNames: string[]): string[] {
  return serverNames.map(name => `mcp__${name}`);
}

/**
 * Seed a commented starter catalog on first run.
 *
 * Written only when absent, so it never overwrites a user's own file.
 */
export function ensureCatalogSeed(): void {
  try {
    if (fs.existsSync(MCP_CATALOG_PATH)) return;
    fs.mkdirSync(ALPHA_DIR, { recursive: true });
    fs.writeFileSync(
      MCP_CATALOG_PATH,
      JSON.stringify(
        {
          _comment:
            'MCP servers available to Alpha agents. Grant them per agent via its mcpServers list. "alpha-github" is built in and needs no entry here.',
          mcpServers: {}
        },
        null,
        2
      ) + '\n',
      'utf8'
    );
  } catch (err: any) {
    logError(`Could not seed ${MCP_CATALOG_PATH}: ${err?.message ?? err}`);
  }
}

/**
 * Write the user catalog back to disk.
 *
 * Read-modify-write on the whole file rather than patching in place, because
 * the file carries a `_comment` the seed puts there to explain itself. Parsing
 * and re-serialising keeps it; appending JSON would not.
 *
 * The comment is preserved deliberately: the file is meant to stay hand-editable,
 * and a user who opens it after the UI has written to it should still find the
 * explanation of what it is for.
 */
function writeCatalog(servers: Record<string, McpServerSpec>): void {
  let existing: Record<string, unknown> = {};
  try {
    if (fs.existsSync(MCP_CATALOG_PATH)) {
      existing = JSON.parse(fs.readFileSync(MCP_CATALOG_PATH, 'utf8')) ?? {};
    }
  } catch {
    // A malformed file is replaced rather than merged into: readCatalog already
    // treats it as empty, so preserving its bytes would keep a file the rest of
    // the system is ignoring.
  }

  fs.mkdirSync(ALPHA_DIR, { recursive: true });
  fs.writeFileSync(
    MCP_CATALOG_PATH,
    JSON.stringify({ ...existing, mcpServers: servers }, null, 2),
    'utf8'
  );
}

/**
 * Add or replace one user-catalog server.
 *
 * Replaces rather than merges: an edit that removes an argument or an env var
 * has to be able to actually remove it, and a deep merge would silently keep
 * whatever the previous version declared.
 */
export function upsertCatalogServer(name: string, spec: McpServerSpec): void {
  const servers = readCatalog();
  servers[name] = spec;
  writeCatalog(servers);
}

/**
 * Remove one user-catalog server.
 *
 * Returns false when the name was not in the catalog, which the controller
 * turns into a 404 rather than a silent success — deleting a built-in, or a
 * name that was never there, should not report that something was removed.
 *
 * Grants are left alone on purpose. An agent still listing a deleted server
 * loses that tool and keeps working (`writeRunMcpConfig` skips unknown names),
 * so re-adding the server restores it. Rewriting every agent here would make
 * a delete destructive and unrecoverable.
 */
export function removeCatalogServer(name: string): boolean {
  const servers = readCatalog();
  if (!(name in servers)) return false;
  delete servers[name];
  writeCatalog(servers);
  return true;
}

/** Names that ship with Alpha and cannot be deleted, only shadowed. */
export function builtinServerNames(): string[] {
  return Object.keys(BUILTIN_SERVERS);
}
