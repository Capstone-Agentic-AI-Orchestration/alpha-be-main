import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The access band has to survive the trip to the server.
 *
 * `autonomyPolicy` decides read or write, but the process that enforces it is a
 * grandchild — Alpha spawns the agent CLI, the CLI spawns the MCP server — so
 * the decision only means anything if it is written into the config the CLI is
 * handed. A silently dropped variable would fail open, and the server would
 * hand a Supervised agent the push tool.
 */
let tmp: string;
let opened: { close(): void }[] = [];

async function startDaemon() {
  process.env.ALPHA_HOME = tmp;
  vi.resetModules();
  const sql = await import('./sqliteService.js');
  const mcp = await import('./mcpConfigService.js');
  opened.push(sql.sqliteService);
  return mcp;
}

/** The built-in server's env as written for one run. */
function builtInEnv(mcp: any, runId: string, access?: 'read' | 'write') {
  const res = mcp.writeRunMcpConfig(
    runId,
    ['alpha-github'],
    {},
    path.join(tmp, 'workspace'),
    ...(access ? [access] : [])
  );
  if (!res.configPath) return null;
  const cfg = JSON.parse(fs.readFileSync(res.configPath, 'utf8'));
  mcp.cleanupRunMcpConfig(runId);
  return cfg.mcpServers['alpha-github']?.env ?? null;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-access-'));
  opened = [];
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  for (const s of opened) { try { s.close(); } catch { /* already closed */ } }
  delete process.env.ALPHA_HOME;
  vi.restoreAllMocks();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* the OS will reclaim it */ }
});

describe('the access band in the written config', () => {
  it('carries write when the agent may propose work', async () => {
    const mcp = await startDaemon();
    expect(builtInEnv(mcp, 'run-w', 'write')?.ALPHA_MCP_ACCESS).toBe('write');
  });

  it('carries read for a supervised agent', async () => {
    const mcp = await startDaemon();
    expect(builtInEnv(mcp, 'run-r', 'read')?.ALPHA_MCP_ACCESS).toBe('read');
  });

  /**
   * The default matters more than either explicit case: a caller added later
   * that forgets the argument must get the safe answer, not the permissive one.
   */
  it('defaults to read when the caller says nothing', async () => {
    const mcp = await startDaemon();
    expect(builtInEnv(mcp, 'run-d')?.ALPHA_MCP_ACCESS).toBe('read');
  });

  it('still carries the workspace and run id alongside it', async () => {
    const mcp = await startDaemon();
    const env = builtInEnv(mcp, 'run-x', 'write');
    expect(env?.ALPHA_RUN_ID).toBe('run-x');
    expect(env?.ALPHA_WORKSPACE).toContain('workspace');
  });
});
