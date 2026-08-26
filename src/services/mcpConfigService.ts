import fs from 'node:fs';
import path from 'node:path';

import { ALPHA_DIR, RUNS_DIR } from '../config/env.js';
import { logError } from '../utils/logger.js';

/**
 * One MCP server as the CLIs expect it: a command to spawn plus its argv.
 * Matches the shape used by `claude --mcp-config` and by
 * `claude_desktop_config.json`, so a server definition can be copied between
 * them unchanged.
 */
export interface McpServerSpec {
  command: string;
  args?: string[];
  env?: Record<string, string>;
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
    return { command: process.execPath, args: [compiled] };
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
export function writeRunMcpConfig(runId: string, requested: string[] | undefined): RunMcpConfig {
  const names = (requested ?? []).map(n => n.trim()).filter(Boolean);
  if (!names.length) return { configPath: null, serverNames: [] };

  const available = availableServers();
  const mcpServers: Record<string, McpServerSpec> = {};

  for (const name of names) {
    const spec = available[name];
    if (spec) mcpServers[name] = spec;
    else logError(`Agent requested unknown MCP server "${name}" — skipping.`);
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
