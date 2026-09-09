import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * One catalog entry, a different target per project.
 *
 * The MCP catalog is a single global file, so a hosted server appears in it
 * once — but what it points at is per project. A Supabase entry scoped with
 * `?project_ref=${SUPABASE_PROJECT_REF}` is the same server for every board and
 * must not be the same Supabase project.
 *
 * These exercise the layering through the real config writer, because the
 * ordering is the whole behaviour: daemon environment, then project, then
 * agent, each overriding the last.
 */
let tmp: string;
let opened: { close(): void }[] = [];

const SUPABASE = {
  type: 'http' as const,
  url: 'https://mcp.supabase.com/mcp?project_ref=${SUPABASE_PROJECT_REF}&read_only=true',
  headers: { Authorization: 'Bearer ${SUPABASE_ACCESS_TOKEN}' }
};

async function startDaemon() {
  process.env.ALPHA_HOME = tmp;
  vi.resetModules();
  const sql = await import('./sqliteService.js');
  const mcp = await import('./mcpConfigService.js');
  opened.push(sql.sqliteService);
  mcp.upsertCatalogServer('supabase', SUPABASE);
  return mcp;
}

/** The supabase entry as written for a run, or null when it was skipped. */
function writtenSpec(mcp: any, runId: string, overrides: Record<string, string>) {
  const res = mcp.writeRunMcpConfig(runId, ['supabase'], overrides);
  if (!res.configPath) return null;
  const cfg = JSON.parse(fs.readFileSync(res.configPath, 'utf8'));
  mcp.cleanupRunMcpConfig(runId);
  return cfg.mcpServers.supabase ?? null;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-mcpenv-'));
  opened = [];
  delete process.env.SUPABASE_PROJECT_REF;
  delete process.env.SUPABASE_ACCESS_TOKEN;
});

afterEach(() => {
  for (const svc of opened) { try { svc.close(); } catch { /* already closed */ } }
  delete process.env.ALPHA_HOME;
  delete process.env.SUPABASE_PROJECT_REF;
  delete process.env.SUPABASE_ACCESS_TOKEN;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('per-project MCP environment', () => {
  it('resolves entirely from overrides', async () => {
    const mcp = await startDaemon();

    const spec = writtenSpec(mcp, 'run-a', {
      SUPABASE_PROJECT_REF: 'alfproject',
      SUPABASE_ACCESS_TOKEN: 'sbp_token'
    });

    expect(spec.url).toBe('https://mcp.supabase.com/mcp?project_ref=alfproject&read_only=true');
    expect(spec.headers.Authorization).toBe('Bearer sbp_token');
  });

  it('sends two projects to two different Supabase projects', async () => {
    // The reason this feature exists. One token, one catalog entry, two refs.
    const mcp = await startDaemon();
    process.env.SUPABASE_ACCESS_TOKEN = 'sbp_shared_token';

    const alf = writtenSpec(mcp, 'run-alf', { SUPABASE_PROJECT_REF: 'alfref' });
    const afe = writtenSpec(mcp, 'run-afe', { SUPABASE_PROJECT_REF: 'aferef' });

    expect(alf.url).toContain('project_ref=alfref');
    expect(afe.url).toContain('project_ref=aferef');
    expect(alf.headers.Authorization).toBe('Bearer sbp_shared_token');
    expect(afe.headers.Authorization).toBe('Bearer sbp_shared_token');
  });

  it('takes the daemon environment when a project overrides nothing', async () => {
    // A machine-level token is the ordinary case: one secret, every project.
    const mcp = await startDaemon();
    process.env.SUPABASE_PROJECT_REF = 'machineref';
    process.env.SUPABASE_ACCESS_TOKEN = 'sbp_machine';

    const spec = writtenSpec(mcp, 'run-b', {});

    expect(spec.url).toContain('project_ref=machineref');
    expect(spec.headers.Authorization).toBe('Bearer sbp_machine');
  });

  it('lets an override beat the daemon environment', async () => {
    const mcp = await startDaemon();
    process.env.SUPABASE_PROJECT_REF = 'machineref';
    process.env.SUPABASE_ACCESS_TOKEN = 'sbp_machine';

    const spec = writtenSpec(mcp, 'run-c', { SUPABASE_PROJECT_REF: 'projectref' });

    expect(spec.url).toContain('project_ref=projectref');
    // Untouched keys still come from the machine.
    expect(spec.headers.Authorization).toBe('Bearer sbp_machine');
  });

  /**
   * An empty override is not an answer.
   *
   * `expandEnvRefs` treats a blank value as unset, so a project whose field was
   * cleared falls back to the daemon's value rather than sending an empty
   * credential. Clearing a field must not silently produce `Bearer `.
   */
  it('falls back when an override is blank', async () => {
    const mcp = await startDaemon();
    process.env.SUPABASE_PROJECT_REF = 'machineref';
    process.env.SUPABASE_ACCESS_TOKEN = 'sbp_machine';

    const spec = writtenSpec(mcp, 'run-d', { SUPABASE_PROJECT_REF: '' });

    expect(spec.url).toContain('project_ref=machineref');
  });

  it('skips the server when nothing supplies the values', async () => {
    const mcp = await startDaemon();

    const res = mcp.writeRunMcpConfig('run-e', ['supabase'], {});

    // No servers written at all, so no --mcp-config is passed for the turn.
    expect(res.serverNames).toEqual([]);
    expect(res.configPath).toBeNull();
  });

  it('keeps the catalog file free of the resolved values', async () => {
    // The point of a reference: the portable file must stay shareable.
    const mcp = await startDaemon();
    writtenSpec(mcp, 'run-f', { SUPABASE_PROJECT_REF: 'alfref', SUPABASE_ACCESS_TOKEN: 'sbp_secret' });

    const catalog = fs.readFileSync(path.join(tmp, 'mcp.json'), 'utf8');
    expect(catalog).toContain('${SUPABASE_ACCESS_TOKEN}');
    expect(catalog).not.toContain('sbp_secret');
    expect(catalog).not.toContain('alfref');
  });
});
