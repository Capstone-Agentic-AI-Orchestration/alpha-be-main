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

describe('the project files server in the written config', () => {
  it('revokes tool access without deleting audit evidence needed by acceptance and report correction', async () => {
    const mcp = await startDaemon();
    const { runDependencyAudit } = await import('./dependencyAuditService.js');
    const { taskAuditEvidence } = await import('./orchestrationAuditEvidence.js');
    const { mintRunGrant, grantForToken } = await import('./runBridge.js');
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"fixture"}');
    const runId = 'audit-lifecycle';
    const runDir = path.join(tmp, 'runs', runId);
    const spec = { scanner: 'npm', purpose: 'baseline', level: 'high' } as const;
    const config = mcp.writeRunMcpConfig(runId, ['alpha-github'], {}, repo);
    fs.writeFileSync(path.join(runDir, 'persona.md'), 'Temporary turn instructions');
    const token = mintRunGrant({ runId, agentId: 'security', workspaceId: null, repos: {}, access: 'read' });
    const evidence = await runDependencyAudit({ directory: repo, evidenceDirectory: path.join(runDir, 'audits'), taskId: 'audit-one', repository: 'owner/repo', spec }, async (bin, args, cwd) => {
      if (bin === 'git') return { code: 0, stdout: 'a'.repeat(40), stderr: '' };
      if (args[0] === '--version') return { code: 0, stdout: '11.0.0', stderr: '' };
      if (args[0] === 'install') fs.writeFileSync(path.join(cwd, 'package-lock.json'), '{"lockfileVersion":3,"packages":{"":{}}}');
      return { code: 0, stdout: JSON.stringify({ vulnerabilities: {}, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } } }), stderr: '' };
    });
    const task = { id: 'audit-one', repository: 'owner/repo', dependencyAudit: spec };
    const original = { id: 'original', taskId: task.id, agentId: 'security', prototypeRunId: runId, createdAt: '2026-10-24T00:00:00Z' };
    const correction = { ...original, id: 'correction', prototypeRunId: 'report-correction', createdAt: '2026-10-24T00:01:00Z' };
    const snapshot = { run: { repository: task.repository }, attempts: [original, correction] } as any;
    mcp.cleanupRunMcpConfig(runId);
    mcp.cleanupRunMcpConfig(runId);
    expect(grantForToken(token)).toBeNull();
    for (const file of [config.configPath!, config.antigravitySettingsPath!, path.join(runDir, 'persona.md')]) expect(fs.existsSync(file)).toBe(false);
    expect(taskAuditEvidence(snapshot, task as any, correction as any, repo, [evidence.id])[0].id).toBe(evidence.id);
    expect(() => taskAuditEvidence(snapshot, { ...task, id: 'different-task' } as any, correction as any, repo, [evidence.id])).toThrow(/not produced/);
    fs.appendFileSync(path.join(repo, 'package.json'), '\n');
    expect(() => taskAuditEvidence(snapshot, task as any, correction as any, repo, [evidence.id])).toThrow(/stale/);
  });

  it('passes internal task scope and withholds the task server when authority is absent', async () => {
    const mcp = await startDaemon();
    const roots = [{ name: 'app', repo: 'test/app', dir: tmp }];
    const task = { taskId: 'task-1', repository: 'test/app', kind: 'backend' as const, includePaths: ['src/**'], excludePaths: ['src/generated/**'], requiredChecks: ['test' as const], reportOnly: false };
    const res = mcp.writeRunMcpConfig('task-files', ['alpha-task-files'], { ALPHA_TASK_SCOPE: '{"includePaths":["**"]}' }, tmp, 'read', undefined, roots, undefined, task);
    const cfg = JSON.parse(fs.readFileSync(res.configPath!, 'utf8'));
    expect(JSON.parse(cfg.mcpServers['alpha-task-files'].env.ALPHA_TASK_SCOPE)).toEqual(task);
    const agy = JSON.parse(fs.readFileSync(res.antigravitySettingsPath!, 'utf8'));
    expect(agy.mcpServers['alpha-task-files'].trust).toBe(true);
    mcp.cleanupRunMcpConfig('task-files');
    const missing = mcp.writeRunMcpConfig('no-task-authority', ['alpha-task-files'], {}, tmp, 'read', undefined, roots);
    expect(missing.serverNames).toEqual([]);
    mcp.cleanupRunMcpConfig('no-task-authority');
  });
  it("tells the GitHub server the selected project's folder and repositories, for its clone tool", async () => {
    const mcp = await startDaemon();
    const folder = { dir: path.join(tmp, 'AlphaProjects', 'Test-Project'), repos: ['acme/app-be', 'acme/app-fe'] };
    const res = mcp.writeRunMcpConfig('run-folder', ['alpha-github'], {}, path.join(tmp, 'workspace'), 'read', undefined, undefined, folder);
    const env = JSON.parse(fs.readFileSync(res.configPath!, 'utf8')).mcpServers['alpha-github'].env;
    mcp.cleanupRunMcpConfig('run-folder');
    expect(env.ALPHA_PROJECT_FOLDER).toBe(folder.dir);
    expect(JSON.parse(env.ALPHA_PROJECT_REPOS)).toEqual(folder.repos);
    expect(builtInEnv(mcp, 'run-no-folder')?.ALPHA_PROJECT_FOLDER).toBeUndefined();
  });

  it('carries the project folders, and is left out when there are none', async () => {
    const mcp = await startDaemon();
    const roots = [{ name: 'app-be', repo: 'acme/app-be', dir: path.join(tmp, 'app-be') }];
    const res = mcp.writeRunMcpConfig('run-files', ['alpha-github', 'alpha-project-files'], {}, undefined, 'read', undefined, roots);
    const cfg = JSON.parse(fs.readFileSync(res.configPath!, 'utf8'));
    const agy = JSON.parse(fs.readFileSync(res.antigravitySettingsPath!, 'utf8'));
    mcp.cleanupRunMcpConfig('run-files');
    expect(res.serverNames).toEqual(['alpha-github', 'alpha-project-files']);
    expect(JSON.parse(cfg.mcpServers['alpha-project-files'].env.ALPHA_PROJECT_ROOTS)).toEqual(roots);
    expect(agy.mcp.allowed).toEqual(['alpha-github', 'alpha-project-files']);
    expect(agy.mcpServers['alpha-github'].trust).toBe(true);
    expect(agy.mcpServers['alpha-project-files'].trust).toBe(true);

    const none = mcp.writeRunMcpConfig('run-none', ['alpha-github', 'alpha-project-files'], {}, undefined, 'read', undefined, []);
    const emptyAgy = JSON.parse(fs.readFileSync(none.antigravitySettingsPath!, 'utf8'));
    mcp.cleanupRunMcpConfig('run-none');
    expect(none.serverNames).toEqual(['alpha-github']);
    expect(emptyAgy.mcp.allowed).toEqual(['alpha-github']);
  });
});

