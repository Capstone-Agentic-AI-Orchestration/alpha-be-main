import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OFFICIAL_AGENT_TEMPLATES, PREVIOUS_TEMPLATE_PROMPTS } from './officialAgentTemplates.js';
import { OFFICIAL_AGENT_TEMPLATE_V4 } from './officialAgentTemplateV4.js';

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

describe('official agent instruction upgrades', () => {
  it('upgrades untouched v4 audit instructions while retaining custom personas and model settings', async () => {
    const first = await startDaemon(); first.close();
    const db = new Database(dbPath());
    for (const key of ['security', 'backend'] as const) {
      db.prepare('UPDATE agents SET template_version = 4, system_prompt = ?, model_name = ? WHERE template_key = ?').run(
        OFFICIAL_AGENT_TEMPLATE_V4[key] + (key === 'backend' ? '\nUse the project logger.' : ''), 'chosen-model', key);
      const { id } = db.prepare('SELECT id FROM agents WHERE template_key = ?').get(key) as { id: string };
      fs.rmSync(path.join(tmp, 'agents', id + '.md'), { force: true });
    }
    db.close();
    const upgraded = await startDaemon();
    expect(upgraded.getAgents().find(agent => agent.templateKey === 'security')).toMatchObject({ templateVersion: 5, modelName: 'chosen-model', systemPrompt: expect.stringContaining('lead independent') });
    expect(upgraded.getAgents().find(agent => agent.templateKey === 'backend')).toMatchObject({ templateVersion: 4, modelName: 'chosen-model', systemPrompt: expect.stringContaining('Use the project logger.') });
  });
  it('upgrades untouched v3 roles and default permission metadata while keeping Manager and custom grants', async () => {
    const first = await startDaemon(); first.close();
    const db = new Database(dbPath());
    for (const key of ['manager', 'github-finalization'] as const) {
      db.prepare('UPDATE agents SET template_version = 3, system_prompt = ? WHERE template_key = ?').run(PREVIOUS_TEMPLATE_PROMPTS[key].at(-1), key);
      const { id } = db.prepare('SELECT id FROM agents WHERE template_key = ?').get(key) as { id: string };
      fs.rmSync(path.join(tmp, 'agents', id + '.md'), { force: true });
    }
    db.prepare("UPDATE agents SET phase = 'Development', skills = ? WHERE template_key = 'manager'").run(JSON.stringify(['sk-browser']));
    db.prepare("UPDATE agents SET autonomy_level = ?, skills = ?, mcp_servers = ? WHERE template_key = 'github-finalization'")
      .run('Semi-Autonomous (Requires Approval)', JSON.stringify(['sk-fs', 'sk-bash', 'sk-git']), JSON.stringify(['alpha-github', 'alpha-hosting']));
    db.close();
    const svc = await startDaemon();
    // The latest previous Manager wording is v5, so this also proves an untouched v5 Manager reaches v6.
    expect(svc.getAgents().find(agent => agent.templateKey === 'manager')).toMatchObject({ templateVersion: 6, phase: 'Planning', skills: ['sk-browser'] });
    expect(svc.getAgents().find(agent => agent.templateKey === 'github-finalization')).toMatchObject({ templateVersion: 5, autonomyLevel: 'Supervised', skills: [], mcpServers: ['alpha-github'] });
    expect(svc.getAgents()).toHaveLength(11);
  });
  /** Put three official agents back on version 1, the way an older install left them. */
  async function installWithV1Agents(edit: (agentsDir: string) => void) {
    const first = await startDaemon();
    first.close();
    const db = new Database(dbPath());
    for (const key of ['frontend', 'backend', 'security'] as const) {
      db.prepare('UPDATE agents SET template_version = 1, system_prompt = ? WHERE template_key = ?')
        .run(PREVIOUS_TEMPLATE_PROMPTS[key][0], key);
    }
    const agentsDir = path.join(tmp, 'agents');
    for (const [id, key] of [['agent-frontend', 'frontend'], ['agent-backend', 'backend'], ['agent-reviewer', 'security']] as const) {
      const file = path.join(agentsDir, id + '.md');
      const raw = fs.readFileSync(file, 'utf8');
      const frontmatter = raw.slice(0, raw.indexOf('---', 3) + 3);
      const name = OFFICIAL_AGENT_TEMPLATES.find(template => template.key === key)!.name;
      fs.writeFileSync(file, frontmatter + '\n\n# ' + name + '\n\n<!-- starter comment -->\n\n' + PREVIOUS_TEMPLATE_PROMPTS[key][0] + '\n');
    }
    db.close();
    edit(agentsDir);
    return startDaemon();
  }

  it('moves untouched agents to the new instructions and leaves edited ones as their owner wrote them', async () => {
    const svc = await installWithV1Agents(agentsDir => {
      // Someone edited the backend persona file.
      const file = path.join(agentsDir, 'agent-backend.md');
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8') + '\nAlways use the repository logger.\n');
      // Someone edited the reviewer in the app, which changes the database column.
      const db = new Database(dbPath());
      db.prepare('UPDATE agents SET system_prompt = ? WHERE template_key = ?').run('Review only for SQL injection.', 'security');
      db.close();
    });
    const byKey = new Map(svc.getAgents().map(agent => [agent.templateKey, agent]));
    const current = (key: string) => OFFICIAL_AGENT_TEMPLATES.find(template => template.key === key)!;

    expect(byKey.get('frontend')).toMatchObject({ templateVersion: current('frontend').version, systemPrompt: current('frontend').systemPrompt });
    expect(fs.readFileSync(path.join(tmp, 'agents', 'agent-frontend.md'), 'utf8')).toContain('Mission: implement the assigned UI change');

    expect(byKey.get('backend')?.templateVersion).toBe(1);
    expect(fs.readFileSync(path.join(tmp, 'agents', 'agent-backend.md'), 'utf8')).toContain('Always use the repository logger.');
    expect(byKey.get('security')).toMatchObject({ templateVersion: 1, systemPrompt: 'Review only for SQL injection.' });
  });

  it('upgrades untouched agents in every workspace at startup, including older Alpha wording', async () => {
    const first = await startDaemon();
    const second = first.createWorkspace({ name: 'Second' });
    first.close();
    const db = new Database(dbPath());
    db.prepare('UPDATE agents SET template_version = 1, system_prompt = ? WHERE template_key = ?')
      .run(PREVIOUS_TEMPLATE_PROMPTS.frontend[0], 'frontend');
    // The Manager Agent shipped with two wordings before version 2; both count as untouched.
    db.prepare('UPDATE agents SET template_version = 1, system_prompt = ? WHERE template_key = ?')
      .run(PREVIOUS_TEMPLATE_PROMPTS.manager.at(-1), 'manager');
    const rows = db.prepare('SELECT id FROM agents WHERE template_key IN (?, ?)').all('frontend', 'manager') as Array<{ id: string }>;
    db.close();
    for (const { id } of rows) fs.rmSync(path.join(tmp, 'agents', id + '.md'), { force: true });

    await startDaemon();
    const check = new Database(dbPath(), { readonly: true });
    const versions = check.prepare('SELECT workspace_id, template_key, template_version FROM agents WHERE template_key IN (?, ?)')
      .all('frontend', 'manager') as Array<{ workspace_id: string; template_key: string; template_version: number }>;
    check.close();
    const workspaces = new Set(versions.map(row => row.workspace_id));
    expect(workspaces.size).toBe(2);
    expect(workspaces.has(second.id)).toBe(true);
    expect(versions.every(row => row.template_version === OFFICIAL_AGENT_TEMPLATES.find(template => template.key === row.template_key)!.version)).toBe(true);
  });

  it('moves an untouched version 2 agent to the current instructions', async () => {
    const first = await startDaemon();
    first.close();
    const db = new Database(dbPath());
    db.prepare('UPDATE agents SET template_version = 2, system_prompt = ? WHERE template_key = ?')
      .run(PREVIOUS_TEMPLATE_PROMPTS.validation.at(-1), 'validation');
    const { id } = db.prepare('SELECT id FROM agents WHERE template_key = ?').get('validation') as { id: string };
    db.close();
    fs.rmSync(path.join(tmp, 'agents', id + '.md'), { force: true });
    const svc = await startDaemon();
    const validation = svc.getAgents().find(agent => agent.templateKey === 'validation')!;
    expect(validation.systemPrompt).toContain('A check you could not run is not_run with the reason');
    expect(validation.templateVersion).toBe(OFFICIAL_AGENT_TEMPLATES[0].version);
  });

  it('gives every official role the shared instruction structure', () => {
    for (const template of OFFICIAL_AGENT_TEMPLATES) {
      for (const part of ['Mission:', 'What you receive:', 'How to work:', 'Never:', 'When blocked:', 'Done when:', 'Reporting:']) {
        expect(template.systemPrompt, template.key + ' ' + part).toContain(part);
      }
      expect(template.systemPrompt).not.toMatch(/approved architecture|next squad|hand your findings/i);
    }
  });
});

