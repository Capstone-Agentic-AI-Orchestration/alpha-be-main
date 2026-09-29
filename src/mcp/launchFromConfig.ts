/**
 * Start one MCP server from a run's `mcp.json`, for a CLI that cannot read one.
 *
 * Entry point only -- nothing imports this. Claude Code reads the per-run
 * config Alpha writes (`--mcp-config`); Codex cannot, and the only way to
 * hand it a server is on its command line (`-c mcp_servers.<name>...`). A
 * server's environment carries credentials -- the GitHub token, the run's
 * bridge token -- and a command line is readable by anything that lists
 * processes, and is written to Alpha's own spawn log. So Codex is given only
 * this launcher and the config's path, and the launcher starts the real
 * server with the environment from the file: nothing secret ever sits in
 * argv, and the file is the same one Claude Code is handed.
 *
 * Usage: launchFromConfig <path to mcp.json> <server name>
 */
import fs from 'node:fs';
import crossSpawn from 'cross-spawn';

const [configPath, serverName] = process.argv.slice(2);

function fail(message: string): never {
  process.stderr.write(`alpha MCP launcher: ${message}\n`);
  process.exit(1);
}

if (!configPath || !serverName) fail('usage: launchFromConfig <mcp.json> <server>');

let spec: { command?: string; args?: string[]; env?: Record<string, string> } | undefined;
try {
  spec = JSON.parse(fs.readFileSync(configPath, 'utf8'))?.mcpServers?.[serverName];
} catch (err) {
  fail(`cannot read ${configPath}: ${(err as Error).message}`);
}
if (!spec?.command) fail(`no stdio server named "${serverName}" in ${configPath}`);

// The launcher's own switch (ELECTRON_RUN_AS_NODE) is the server's to set, not to inherit.
const { ELECTRON_RUN_AS_NODE: _launcherOnly, ...inherited } = process.env;
const child = crossSpawn(spec.command, spec.args ?? [], {
  stdio: 'inherit',
  env: { ...inherited, ...(spec.env ?? {}) },
  windowsHide: true
});

child.on('error', err => fail(`could not start "${serverName}": ${err.message}`));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
