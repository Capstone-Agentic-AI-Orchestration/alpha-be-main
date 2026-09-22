import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTestDatabase, sqlFor } from './testDatabase.js';
import { PostgresAgentStore, PostgresSquadStore } from './postgresAgentStore.js';
import { OFFICIAL_AGENT_TEMPLATES } from '../services/officialAgentTemplates.js';
import type { AgentStore, SquadStore } from './agentStore.js';
import type { Agent } from '../models/index.js';

/**
 * One contract, two stores — for the roster.
 *
 * Agents used to be seeded into the container's SQLite at boot, so every
 * deploy minted a fresh set: an issue assigned to an agent pointed at an id
 * that no longer existed. Shared and stable is the point, and "seeding twice
 * changes nothing" is the property that makes it so.
 */

const WS = 'ws-default';
const OTHER_WS = 'ws-other';

let pg: PGlite;
let tmp: string;
let sqliteOpen: { close(): void } | null = null;

beforeAll(async () => {
  pg = await createTestDatabase();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-roster-'));
}, 60_000);

afterAll(async () => {
  sqliteOpen?.close();
  await pg?.close();
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* windows handle */
  }
});

interface Stores {
  agents: AgentStore;
  squads: SquadStore;
}

async function openSqlite(): Promise<Stores> {
  sqliteOpen?.close();
  process.env.ALPHA_HOME = fs.mkdtempSync(path.join(tmp, 'home-'));
  vi.resetModules();
  const sql = await import('../services/sqliteService.js');
  const { SqliteAgentStore, SqliteSquadStore } = await import('./sqliteAgentStore.js');
  sqliteOpen = { close: () => sql.sqliteService.close() };
  return { agents: new SqliteAgentStore(), squads: new SqliteSquadStore() };
}

async function openPostgres(): Promise<Stores> {
  await pg.exec('truncate agents, squads, workspaces cascade');
  await pg.exec(`insert into workspaces (id, name, slug) values
    ('${WS}', 'Alpha', 'alpha'), ('${OTHER_WS}', 'Other', 'other')`);
  return { agents: new PostgresAgentStore(sqlFor(pg)), squads: new PostgresSquadStore(sqlFor(pg)) };
}

const backends = [
  { name: 'sqlite', open: openSqlite },
  { name: 'postgres', open: openPostgres }
];

const anAgent = (over: Partial<Agent> = {}): Agent =>
  ({
    id: 'agent-custom',
    name: 'Reviewer',
    role: 'Review Agent',
    avatar: '◆',
    color: '#111111',
    description: 'Reviews changes',
    owner: 'Lloyd1020',
    isMine: true,
    modelProvider: 'OpenAI',
    modelName: 'gpt-5',
    systemPrompt: 'Review carefully.',
    autonomyLevel: 'Supervised',
    skills: ['sk-fs'],
    mcpServers: [],
    createdAt: new Date().toISOString(),
    ...over
  }) as Agent;

describe.each(backends)('the agent store ($name)', backend => {
  it('reads back what it wrote', async () => {
    const { agents } = await backend.open();
    await agents.create(WS, anAgent({ allowedUsers: 'admins' }));

    const read = await agents.get(WS, 'agent-custom');
    expect(read).toMatchObject({
      id: 'agent-custom',
      name: 'Reviewer',
      role: 'Review Agent',
      autonomyLevel: 'Supervised',
      allowedUsers: 'admins'
    });
    expect(read!.skills).toEqual(['sk-fs']);
  });

  /** Absent means the form's own default, not "no restriction". */
  it('reads an agent with no visibility set as team-visible', async () => {
    const { agents } = await backend.open();
    await agents.create(WS, anAgent({ allowedUsers: undefined }));

    expect((await agents.get(WS, 'agent-custom'))!.allowedUsers).toBe('team');
  });

  /**
   * Containment rather than equality: the desktop's store seeds its own
   * official roster when it opens, so "these are the only rows" is not a
   * property either store has. What matters is that the other workspace's
   * agent is not among them, and cannot be touched from here.
   */
  it('never reaches across workspaces', async () => {
    const { agents } = await backend.open();
    await agents.create(WS, anAgent({ id: 'ours' }));
    await agents.create(OTHER_WS, anAgent({ id: 'theirs' }));

    const ids = (await agents.list(WS)).map(a => a.id);
    expect(ids).toContain('ours');
    expect(ids).not.toContain('theirs');
    expect(await agents.get(WS, 'theirs')).toBeNull();
    expect(await agents.update(WS, 'theirs', { name: 'Hijacked' })).toBeNull();
    expect(await agents.remove(WS, 'theirs')).toBe(false);
  });

  it('merges an update and deletes once', async () => {
    const { agents } = await backend.open();
    await agents.create(WS, anAgent());

    const updated = await agents.update(WS, 'agent-custom', { name: 'Senior Reviewer' });
    expect(updated).toMatchObject({ name: 'Senior Reviewer', role: 'Review Agent' });

    expect(await agents.remove(WS, 'agent-custom')).toBe(true);
    expect(await agents.remove(WS, 'agent-custom')).toBe(false);
  });

  /** Run twice on every boot and every workspace create; it must settle. */
  it('seeds the official roster idempotently', async () => {
    const { agents } = await backend.open();

    await agents.ensureOfficial(WS);
    const first = await agents.list(WS);
    await agents.ensureOfficial(WS);
    const second = await agents.list(WS);

    expect(first).toHaveLength(OFFICIAL_AGENT_TEMPLATES.length);
    expect(second.map(a => a.id).sort()).toEqual(first.map(a => a.id).sort());
    expect(first.every(a => a.isSeeded)).toBe(true);
    expect(first.map(a => a.templateKey).sort()).toEqual(
      OFFICIAL_AGENT_TEMPLATES.map(t => t.key).sort()
    );
  });

  it('keeps an edit to a seeded agent when the roster is ensured again', async () => {
    const { agents } = await backend.open();
    await agents.ensureOfficial(WS);
    const [first] = await agents.list(WS);

    await agents.update(WS, first.id, { name: 'Renamed by its owner' });
    await agents.ensureOfficial(WS);

    expect((await agents.get(WS, first.id))!.name).toBe('Renamed by its owner');
  });
});

describe.each(backends)('the squad store ($name)', backend => {
  const aSquad = (over = {}) =>
    ({
      id: 'squad-1',
      name: 'Core Squad',
      description: 'The main squad',
      avatar: '◈',
      color: '#6366f1',
      topology: 'Sequential',
      leaderAgentId: 'agent-custom',
      memberAgentIds: ['agent-custom'],
      mission: 'Ship it',
      activeRunsCount: 0,
      completedRunsCount: 0,
      ...over
    }) as any;

  it('reads back what it wrote', async () => {
    const { squads } = await backend.open();
    await squads.create(WS, aSquad());

    expect(await squads.get(WS, 'squad-1')).toMatchObject({
      name: 'Core Squad',
      topology: 'Sequential',
      mission: 'Ship it'
    });
    expect((await squads.get(WS, 'squad-1'))!.memberAgentIds).toEqual(['agent-custom']);
  });

  it('never reaches across workspaces', async () => {
    const { squads } = await backend.open();
    await squads.create(WS, aSquad({ id: 'ours' }));
    await squads.create(OTHER_WS, aSquad({ id: 'theirs' }));

    const ids = (await squads.list(WS)).map(s => s.id);
    expect(ids).toContain('ours');
    expect(ids).not.toContain('theirs');
    expect(await squads.get(WS, 'theirs')).toBeNull();
    expect(await squads.remove(WS, 'theirs')).toBe(false);
  });

  it('merges an update and deletes once', async () => {
    const { squads } = await backend.open();
    await squads.create(WS, aSquad());

    const updated = await squads.update(WS, 'squad-1', { memberAgentIds: ['a', 'b'] });
    expect(updated!.memberAgentIds).toEqual(['a', 'b']);
    expect(updated!.name).toBe('Core Squad');

    expect(await squads.remove(WS, 'squad-1')).toBe(true);
    expect(await squads.remove(WS, 'squad-1')).toBe(false);
  });
});

/**
 * The shared row carries no machine configuration.
 *
 * `0003` dropped both columns: an argument list is a command, and the
 * environment holds credentials, on whichever machine ends up running them.
 */
describe('the cloud store leaves an agent’s execution config behind', () => {
  it('stores neither CLI arguments nor environment values', async () => {
    const { agents } = await openPostgres();
    await agents.create(
      WS,
      anAgent({
        customCliArgs: '--dangerously-skip-permissions',
        envVars: [{ key: 'OPENAI_API_KEY', value: 'sk-secret', isSecret: true }]
      })
    );

    const stored = await agents.get(WS, 'agent-custom');
    expect(stored!.customCliArgs).toBe('');
    expect(stored!.envVars).toEqual([]);

    const { rows } = await pg.query<{ row: string }>('select agents::text as row from agents');
    expect(rows[0].row).not.toContain('sk-secret');
    expect(rows[0].row).not.toContain('dangerously-skip-permissions');
  });
});
