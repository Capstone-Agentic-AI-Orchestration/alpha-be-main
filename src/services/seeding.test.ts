import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OFFICIAL_AGENT_TEMPLATES } from './officialAgentTemplates.js';

/**
 * Seeding must happen exactly once, and must not be inferred.
 *
 * The guard used to be `SELECT count(*) FROM projects` — "is there a project?"
 * standing in for "have we seeded?". Deleting your last project therefore made
 * the next startup believe the database was new, re-run the seed, and throw
 * `UNIQUE constraint failed: skills.id` from the SQLiteService constructor.
 * The daemon could not boot, and the only recovery was deleting alpha.db, which
 * takes every conversation, issue and run with it.
 *
 * These open the service repeatedly against one directory, which is the only
 * way to exercise a second startup.
 */
let tmp: string;

/**
 * Every service opened in a test, so teardown can close them.
 *
 * Each start is a separate module instance holding its own connection, and
 * Windows refuses to unlink a database file while one is open.
 */
let opened: { close(): void }[] = [];

const dbPath = () => path.join(tmp, 'alpha.db');

/** Start the daemon's data layer against `tmp`, as a fresh process would. */
async function startDaemon() {
  process.env.ALPHA_HOME = tmp;
  vi.resetModules();
  const mod = await import('./sqliteService.js');
  opened.push(mod.sqliteService);
  return mod.sqliteService;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-seed-'));
  opened = [];
});

afterEach(() => {
  for (const svc of opened) {
    try { svc.close(); } catch { /* already closed */ }
  }
  delete process.env.ALPHA_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('seeding runs once', () => {
  it('plants the defaults on a fresh database', async () => {
    const svc = await startDaemon();
    expect(svc.getSkills()).toHaveLength(5);
    const agents = svc.getAgents();
    expect(agents).toHaveLength(OFFICIAL_AGENT_TEMPLATES.length);
    expect(agents.map(agent => agent.templateKey).sort()).toEqual(
      OFFICIAL_AGENT_TEMPLATES.map(template => template.key).sort()
    );
    expect(agents.every(agent => agent.isSeeded)).toBe(true);
  });

  /**
   * Templates, not someone else's work.
   *
   * Agents and skills are scaffolding anyone would want. A project and
   * its issues are the work itself — the seed used to ship Alpha's own backlog,
   * so a new collaborator opened the board and found three issues about
   * implementing a stream parser they had never heard of.
   */
  it('seeds no project and no issues', async () => {
    const svc = await startDaemon();
    expect(svc.getProjects()).toHaveLength(0);
    expect(svc.getIssues()).toHaveLength(0);
    // Squads were removed; nothing seeds one.
    expect(svc.getSquads()).toEqual([]);
  });

  it('records that it seeded, rather than leaving it to be inferred', async () => {
    await startDaemon();
    const db = new Database(dbPath(), { readonly: true });
    const row = db.prepare("SELECT value FROM meta WHERE key = 'seeded_at'").get();
    db.close();
    expect(row).toBeTruthy();
  });

  /** The exact sequence that used to stop the daemon booting. */
  it('survives a restart after every project is deleted', async () => {
    const first = await startDaemon();
    for (const p of first.getProjects()) first.deleteProject(p.id);
    expect(first.getProjects()).toHaveLength(0);

    // Would previously throw UNIQUE constraint failed: skills.id from the
    // constructor, before anything could catch it.
    const second = await startDaemon();
    expect(second.getProjects()).toHaveLength(0);
    expect(second.getSkills()).toHaveLength(5);
    expect(second.getAgents()).toHaveLength(OFFICIAL_AGENT_TEMPLATES.length);
  });

  it('does not duplicate anything on an ordinary restart', async () => {
    await startDaemon();
    const svc = await startDaemon();
    expect(svc.getSkills()).toHaveLength(5);
    expect(svc.getAgents()).toHaveLength(OFFICIAL_AGENT_TEMPLATES.length);
    expect(svc.getSquads()).toHaveLength(0);
  });

  /**
   * A database created before the marker existed. Its defaults are already
   * there; it simply never recorded them, and must not be seeded a second time.
   */
  it('back-fills the marker on a database that predates it', async () => {
    await startDaemon();

    const db = new Database(dbPath());
    db.prepare("DELETE FROM meta WHERE key = 'seeded_at'").run();
    db.close();

    const svc = await startDaemon();
    expect(svc.getSkills()).toHaveLength(5);

    const check = new Database(dbPath(), { readonly: true });
    const marker = check.prepare("SELECT value FROM meta WHERE key = 'seeded_at'").get();
    check.close();
    expect(marker).toBeTruthy();
  });

  it('links legacy roles without overwriting their persona or configuration', async () => {
    const first = await startDaemon();
    first.close();

    const db = new Database(dbPath());
    db.prepare(`
      UPDATE agents
      SET name = 'My Architecture Lead',
          system_prompt = 'Keep this local persona.',
          template_key = NULL,
          template_version = NULL,
          phase = NULL,
          is_seeded = 0
      WHERE id = 'agent-architect'
    `).run();
    db.close();

    const second = await startDaemon();
    const architect = second.getAgents().find(agent => agent.id === 'agent-architect');
    expect(architect).toMatchObject({
      name: 'My Architecture Lead',
      systemPrompt: 'Keep this local persona.',
      templateKey: 'architecture',
      templateVersion: 1,
      phase: 'Planning',
      isSeeded: true
    });
    expect(second.getAgents()).toHaveLength(OFFICIAL_AGENT_TEMPLATES.length);
  });

  it('keeps a custom agent when its id collides with a newly seeded role', async () => {
    const first = await startDaemon();
    first.close();

    const db = new Database(dbPath());
    db.prepare(`
      UPDATE agents
      SET name = 'My existing Research Helper',
          template_key = NULL,
          template_version = NULL,
          phase = NULL,
          is_seeded = 0
      WHERE id = 'agent-research'
    `).run();
    db.close();

    const second = await startDaemon();
    expect(second.getAgents().find(agent => agent.id === 'agent-research')).toMatchObject({
      name: 'My existing Research Helper',
      templateKey: undefined,
      isSeeded: false
    });
    const officialResearch = second.getAgents().find(agent => agent.templateKey === 'research');
    expect(officialResearch?.id).toBe('agent-research-official');
    expect(second.getAgents()).toHaveLength(OFFICIAL_AGENT_TEMPLATES.length + 1);
  });
});
