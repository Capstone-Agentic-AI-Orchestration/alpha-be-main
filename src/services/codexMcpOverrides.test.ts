import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { codexMcpOverrides } from './mcpConfigService.js';

/**
 * How a Codex turn gets the run's MCP servers: `-c` overrides that start each
 * server through a launcher reading the run's mcp.json -- so a server's
 * credentials never appear on Codex's command line.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function config(mcpServers: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-codex-mcp-'));
  dirs.push(dir);
  const file = path.join(dir, 'mcp.json');
  fs.writeFileSync(file, JSON.stringify({ mcpServers }));
  return file;
}

describe('MCP servers for a Codex turn', () => {
  it('starts each stdio server through the launcher, naming only the config and the server', () => {
    const file = config({
      'alpha-hosting': { command: 'node', args: ['hostingMcpServer.js'], env: { ALPHA_RUN_TOKEN: 'f'.repeat(64) } },
      'alpha-github': { command: 'node', args: ['githubMcpServer.js'], env: { GH_TOKEN: 'ghp_secretvalue' } }
    });

    const args = codexMcpOverrides({ configPath: file, serverNames: ['alpha-hosting', 'alpha-github'] });
    const joined = args.join(' ');

    expect(args.filter(a => a === '-c').length).toBeGreaterThanOrEqual(4);
    expect(joined).toContain('mcp_servers.alpha-hosting.command=');
    expect(joined).toContain('mcp_servers.alpha-github.args=');
    expect(joined).toContain('mcp_servers.alpha-github.default_tools_approval_mode="writes"');
    expect(joined).toContain(JSON.stringify(file).slice(1, -1));
    expect(joined).toMatch(/launchFromConfig/);
    // The point of the launcher: no credential ever reaches argv.
    expect(joined).not.toContain('f'.repeat(64));
    expect(joined).not.toContain('ghp_secretvalue');
  });

  it('leaves out an HTTP server, whose token could only travel in argv or the environment', () => {
    const file = config({ remote: { type: 'http', url: 'https://mcp.example.com', headers: { Authorization: 'Bearer abc' } } });

    expect(codexMcpOverrides({ configPath: file, serverNames: ['remote'] })).toEqual([]);
  });

  it('gives a turn with no servers nothing', () => {
    expect(codexMcpOverrides({ configPath: null, serverNames: [] })).toEqual([]);
  });
});
