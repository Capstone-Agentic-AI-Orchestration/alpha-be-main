import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The board tool server is written into a turn's config only with a board pass
 * for a developer, and only Alpha's own server can be "alpha-board".
 */
let tmp: string;
let opened: { close(): void }[] = [];

async function startDaemon() {
  process.env.ALPHA_HOME = tmp;
  vi.resetModules();
  vi.doMock('./daemonAddress.js', () => ({ daemonApiUrl: () => 'http://127.0.0.1:4321/api' }));
  vi.doMock('./workspaceRegistry.js', async importOriginal => {
    const actual = await importOriginal<any>();
    return { ...actual, workspaceRegistry: Object.assign(Object.create(Object.getPrototypeOf(actual.workspaceRegistry)), actual.workspaceRegistry, {
      canAccessProjectBuilds: () => true
    }) };
  });
  const sql = await import('./sqliteService.js');
  const mcp = await import('./mcpConfigService.js');
  const grants = await import('./boardGrant.js');
  opened.push(sql.sqliteService);
  return { mcp, grants };
}

const scope = (role: string) => ({
  agentId: 'agent-manager', agentName: 'Manager Agent', actorLogin: 'lloyd', projectId: 'project-1', access: 'write' as const,
  context: { userId: 'u', workspaceId: 'ws-default', role } as any
});

function boardEnv(mcp: any, runId: string, board?: unknown) {
  const res = mcp.writeRunMcpConfig(runId, ['alpha-board'], {}, path.join(tmp, 'workspace'), 'read', undefined, undefined, undefined, undefined, undefined, false, board);
  if (!res.configPath) return null;
  return JSON.parse(fs.readFileSync(res.configPath, 'utf8')).mcpServers['alpha-board']?.env ?? null;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-board-mcp-'));
  opened = [];
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  for (const s of opened) { try { s.close(); } catch { /* already closed */ } }
  delete process.env.ALPHA_HOME;
  vi.doUnmock('./daemonAddress.js');
  vi.doUnmock('./workspaceRegistry.js');
  vi.restoreAllMocks();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* the OS will reclaim it */ }
});

describe('alpha-board in a turn\'s tool config', () => {
  it('gets a pass for a developer, which ends with the turn', async () => {
    const { mcp, grants } = await startDaemon();
    const env = boardEnv(mcp, 'turn-dev', scope('dev'));
    expect(env).toMatchObject({ ALPHA_DAEMON_URL: 'http://127.0.0.1:4321/api', ALPHA_BOARD_ACCESS: 'write' });
    expect(grants.boardGrantForToken(env.ALPHA_RUN_TOKEN)).toMatchObject({ actorLogin: 'lloyd', projectId: 'project-1' });
    mcp.cleanupRunMcpConfig('turn-dev');
    expect(grants.boardGrantForToken(env.ALPHA_RUN_TOKEN)).toBeNull();
  });

  it('is left out for anyone but a developer, and without a board scope', async () => {
    const { mcp } = await startDaemon();
    expect(boardEnv(mcp, 'turn-pm', scope('pm'))).toBeNull();
    expect(boardEnv(mcp, 'turn-none')).toBeNull();
  });
});

