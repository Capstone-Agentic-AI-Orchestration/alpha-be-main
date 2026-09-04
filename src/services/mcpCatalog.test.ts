import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * These tests write a real catalog file, so ALPHA_HOME is pointed at a temp
 * directory and the module is re-imported per test — `MCP_CATALOG_PATH` is
 * resolved at import time from `ALPHA_DIR`.
 */
let tmp: string;
let svc: typeof import('./mcpConfigService.js');

const catalogPath = () => path.join(tmp, 'mcp.json');
const readRaw = () => JSON.parse(fs.readFileSync(catalogPath(), 'utf8'));

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-mcpcat-'));
  process.env.ALPHA_HOME = tmp;
  vi.resetModules();
  svc = await import('./mcpConfigService.js');
});

afterEach(() => {
  delete process.env.ALPHA_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('catalog writes', () => {
  it('adds a server and reads it back', () => {
    svc.upsertCatalogServer('my-postgres', { command: 'npx', args: ['-y', 'pg-mcp'] });
    expect(svc.readCatalog()['my-postgres']).toEqual({ command: 'npx', args: ['-y', 'pg-mcp'] });
  });

  it('makes the server grantable', () => {
    svc.upsertCatalogServer('my-postgres', { command: 'npx' });
    expect(Object.keys(svc.availableServers())).toContain('my-postgres');
  });

  /**
   * Replace, not merge: an edit that drops an argument has to actually drop it.
   * A deep merge would keep whatever the previous version declared, so removing
   * a flag would be impossible through the UI.
   */
  it('replaces an entry rather than merging into it', () => {
    svc.upsertCatalogServer('s', { command: 'a', args: ['--one'], env: { T: 'x' } });
    svc.upsertCatalogServer('s', { command: 'b' });
    expect(svc.readCatalog()['s']).toEqual({ command: 'b' });
  });

  it('preserves the seed comment the file carries', () => {
    svc.ensureCatalogSeed();
    svc.upsertCatalogServer('s', { command: 'a' });
    expect(readRaw()._comment).toMatch(/MCP servers available to Alpha agents/);
  });

  it('removes a server and reports whether it did', () => {
    svc.upsertCatalogServer('s', { command: 'a' });
    expect(svc.removeCatalogServer('s')).toBe(true);
    expect(svc.readCatalog()['s']).toBeUndefined();
    expect(svc.removeCatalogServer('s')).toBe(false);
  });

  /**
   * `alpha-github` lives in code, not the catalog, so a delete has nothing to
   * remove — the controller turns the false into a 404 explaining that rather
   * than reporting a success that changed nothing.
   */
  it('cannot remove a built-in that was never shadowed', () => {
    expect(svc.removeCatalogServer('alpha-github')).toBe(false);
    expect(Object.keys(svc.availableServers())).toContain('alpha-github');
  });

  it('lets a catalog entry shadow a built-in, and un-shadow on delete', () => {
    const original = svc.availableServers()['alpha-github'];
    svc.upsertCatalogServer('alpha-github', { command: 'my-own-build' });
    expect(svc.availableServers()['alpha-github']).toEqual({ command: 'my-own-build' });

    expect(svc.removeCatalogServer('alpha-github')).toBe(true);
    expect(svc.availableServers()['alpha-github']).toEqual(original);
  });

  it('replaces a malformed catalog rather than merging into it', () => {
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(catalogPath(), '{ not json', 'utf8');
    svc.upsertCatalogServer('s', { command: 'a' });
    expect(svc.readCatalog()['s']).toEqual({ command: 'a' });
  });

  it('writes the file even when no catalog existed', () => {
    expect(fs.existsSync(catalogPath())).toBe(false);
    svc.upsertCatalogServer('s', { command: 'a' });
    expect(fs.existsSync(catalogPath())).toBe(true);
  });

  it('names the built-ins', () => {
    expect(svc.builtinServerNames()).toEqual(['alpha-github']);
  });
});

describe('http transport', () => {
  it('stores and returns a url server unchanged', () => {
    svc.upsertCatalogServer('context7', { type: 'http', url: 'https://mcp.context7.com/mcp' });
    expect(svc.readCatalog()['context7']).toEqual({
      type: 'http',
      url: 'https://mcp.context7.com/mcp'
    });
  });

  it('writes a url server into a run config as-is', () => {
    svc.upsertCatalogServer('context7', { type: 'http', url: 'https://mcp.context7.com/mcp' });
    const r = svc.writeRunMcpConfig('run-http', ['context7']);
    const written = JSON.parse(fs.readFileSync(r.configPath!, 'utf8'));
    expect(written.mcpServers['context7']).toEqual({
      type: 'http',
      url: 'https://mcp.context7.com/mcp'
    });
    svc.cleanupRunMcpConfig('run-http');
  });
});

/**
 * The catalog records intent; the run config records what this machine spawns.
 * Keeping them separate is what lets `~/.alpha/mcp.json` stay portable.
 */
describe('platform resolution', () => {
  const onWindows = process.platform === 'win32';

  it('leaves the catalog holding exactly what was typed', () => {
    svc.upsertCatalogServer('memory', {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory']
    });
    expect(svc.readCatalog()['memory']).toEqual({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory']
    });
  });

  it.runIf(onWindows)('resolves an npm shim to its .cmd form when spawning', () => {
    svc.upsertCatalogServer('memory', { command: 'npx', args: ['-y', 'pkg'] });
    const r = svc.writeRunMcpConfig('run-shim', ['memory']);
    const written = JSON.parse(fs.readFileSync(r.configPath!, 'utf8'));
    // Measured: bare `npx` reports "failed", `npx.cmd` reports "connected".
    expect(written.mcpServers['memory'].command).toBe('npx.cmd');
    svc.cleanupRunMcpConfig('run-shim');
  });

  it('leaves a command that is not a known shim alone', () => {
    svc.upsertCatalogServer('custom', { command: 'C:\\tools\\my-server.exe' });
    const r = svc.writeRunMcpConfig('run-plain', ['custom']);
    const written = JSON.parse(fs.readFileSync(r.configPath!, 'utf8'));
    expect(written.mcpServers['custom'].command).toBe('C:\\tools\\my-server.exe');
    svc.cleanupRunMcpConfig('run-plain');
  });
});
