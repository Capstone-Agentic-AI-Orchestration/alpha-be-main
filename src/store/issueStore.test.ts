import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTestDatabase, sqlFor } from './testDatabase.js';
import { PostgresIssueStore } from './postgresIssueStore.js';
import { PostgresProjectStore } from './postgresProjectStore.js';
import type { IssueStore } from './issueStore.js';
import type { ProjectStore } from './projectStore.js';

/**
 * One contract, two stores — for the cards themselves.
 *
 * What an issue promises is the same on a laptop and on Render: an identifier
 * in its project's scheme, comments that come back with it, and a workspace it
 * never reaches out of. Postgres is PGlite with the real migrations; SQLite is
 * the desktop's own service in a temporary database.
 */

const WS = 'ws-default';
const OTHER_WS = 'ws-other';

let pg: PGlite;
let tmp: string;
let sqliteOpen: { close(): void } | null = null;

beforeAll(async () => {
  pg = await createTestDatabase();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-issues-'));
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
  issues: IssueStore;
  projects: ProjectStore;
  /**
   * Put a squad where this store can see one.
   *
   * The desktop checks an assignment against its own roster and drops what it
   * does not recognise; the cloud has no roster yet, so it keeps what it is
   * given. Seeding through the backend lets the rule below be stated once
   * without pretending that difference away.
   */
  seedSquad(id: string): Promise<void>;
  /** An agent to assign to. Since `0011` the cloud refuses an assignee it has no row for. */
  seedAgent(id: string): Promise<void>;
}

async function openSqlite(): Promise<Stores> {
  sqliteOpen?.close();
  process.env.ALPHA_HOME = fs.mkdtempSync(path.join(tmp, 'home-'));
  vi.resetModules();
  const sql = await import('../services/sqliteService.js');
  const { SqliteIssueStore } = await import('./sqliteIssueStore.js');
  const { SqliteProjectStore } = await import('./sqliteProjectStore.js');
  sqliteOpen = { close: () => sql.sqliteService.close() };
  return {
    issues: new SqliteIssueStore(),
    projects: new SqliteProjectStore(),
    seedAgent: async id => {
      (sql.sqliteService as any).createAgent({
        id, name: 'Agent', role: 'Developer', avatar: '◆', color: '#6366f1', description: '',
        owner: 'octocat', isMine: true, modelProvider: 'anthropic', modelName: 'claude-sonnet-5',
        systemPrompt: '', autonomyLevel: 'supervised', temperature: 0.7, skills: [], mcpServers: [],
        customCliArgs: '', envVars: [], concurrencyLimit: 2, isArchived: false,
        createdAt: new Date().toISOString()
      });
    },
    seedSquad: async id => {
      (sql.sqliteService as any).createSquad({
        id,
        name: 'Squad',
        description: '',
        avatar: '◈',
        color: '#6366f1',
        topology: 'Sequential',
        leaderAgentId: undefined,
        memberAgentIds: [],
        mission: '',
        activeRunsCount: 0,
        completedRunsCount: 0
      });
    }
  };
}

async function openPostgres(): Promise<Stores> {
  await pg.exec('truncate issues, issue_comments, projects, workspaces cascade');
  await pg.exec(`insert into workspaces (id, name, slug) values
    ('${WS}', 'Alpha', 'alpha'), ('${OTHER_WS}', 'Other', 'other')`);
  return {
    issues: new PostgresIssueStore(sqlFor(pg)),
    projects: new PostgresProjectStore(sqlFor(pg)),
    seedAgent: async id => {
      await pg.exec(`insert into agents (id, workspace_id, name, role, model_provider, model_name, autonomy_level, owner)
        values ('${id}', '${WS}', 'Agent', 'Developer', 'anthropic', 'claude-sonnet-5', 'supervised', 'octocat')`);
    },
    // Squads are only referenced by id; the cloud has no constraint on them.
    seedSquad: async () => undefined
  };
}

const backends = [
  { name: 'sqlite', open: openSqlite },
  { name: 'postgres', open: openPostgres }
];

/** Every issue needs a project; this is the one they hang off. */
async function withProject(stores: Stores, workspaceId = WS) {
  await stores.projects.create(workspaceId, { id: `p-${workspaceId}`, name: 'Checkout', key: `CHK${workspaceId.length}` });
  return `p-${workspaceId}`;
}

describe.each(backends)('the issue store ($name)', backend => {
  it('numbers a new card in its project’s scheme', async () => {
    const stores = await backend.open();
    const projectId = await withProject(stores);

    const first = await stores.issues.create(WS, { title: 'Fix cart', projectId });
    const second = await stores.issues.create(WS, { title: 'Fix checkout', projectId });

    // The project's key, then the next free number -- stated as the rule
    // rather than as two literals, which a seeded card would shift.
    const [firstKey, firstNumber] = first.identifier.split('-');
    const [secondKey, secondNumber] = second.identifier.split('-');
    expect(firstKey).toMatch(/^CHK/);
    expect(secondKey).toBe(firstKey);
    expect(Number(secondNumber)).toBe(Number(firstNumber) + 1);
    expect(Number(firstNumber)).toBeGreaterThanOrEqual(101);
    expect(first.status).toBe('todo');
    expect(first.priority).toBe('medium');
  });

  it('keeps an identifier the caller supplied', async () => {
    const stores = await backend.open();
    const projectId = await withProject(stores);

    const issue = await stores.issues.create(WS, { title: 'Imported', projectId, identifier: 'CHK-7' });
    expect(issue.identifier).toBe('CHK-7');
  });

  it('returns comments with the issue that owns them', async () => {
    const stores = await backend.open();
    const projectId = await withProject(stores);
    const issue = await stores.issues.create(WS, { title: 'Fix cart', projectId });

    await stores.issues.addComment(WS, {
      id: 'c1',
      issueId: issue.id,
      authorType: 'system',
      authorName: 'Alpha',
      content: 'created',
      createdAt: new Date().toISOString()
    });

    const read = await stores.issues.get(WS, issue.id);
    expect(read!.comments.map(c => c.content)).toEqual(['created']);
    expect((await stores.issues.list(WS))[0].comments).toHaveLength(1);
  });

  /** The opening comment is composed before the issue has an id. */
  it('writes the comments an issue was created with', async () => {
    const stores = await backend.open();
    const projectId = await withProject(stores);

    const issue = await stores.issues.create(WS, {
      title: 'Fix cart',
      projectId,
      comments: [
        {
          id: 'c-open',
          issueId: '',
          authorType: 'system',
          authorName: 'Alpha',
          content: 'opened',
          createdAt: new Date().toISOString()
        }
      ]
    });

    const read = await stores.issues.get(WS, issue.id);
    expect(read!.comments[0]).toMatchObject({ content: 'opened', issueId: issue.id });
  });

  it('never reaches across workspaces', async () => {
    const stores = await backend.open();
    const ours = await withProject(stores, WS);
    const theirs = await withProject(stores, OTHER_WS);
    await stores.issues.create(WS, { id: 'i1', title: 'Ours', projectId: ours });
    await stores.issues.create(OTHER_WS, { id: 'i2', title: 'Theirs', projectId: theirs });

    expect((await stores.issues.list(WS)).map(i => i.id)).toEqual(['i1']);
    expect(await stores.issues.get(WS, 'i2')).toBeNull();
    expect(await stores.issues.update(WS, 'i2', { title: 'Hijacked' })).toBeNull();
    expect(await stores.issues.remove(WS, 'i2')).toBe(false);
    expect((await stores.issues.get(OTHER_WS, 'i2'))?.title).toBe('Theirs');
  });

  it('ignores a comment on an issue that is not in this workspace', async () => {
    const stores = await backend.open();
    const theirs = await withProject(stores, OTHER_WS);
    await stores.issues.create(OTHER_WS, { id: 'i2', title: 'Theirs', projectId: theirs });

    await stores.issues.addComment(WS, {
      id: 'c1',
      issueId: 'i2',
      authorType: 'user',
      authorName: 'Someone',
      content: 'from another workspace',
      createdAt: new Date().toISOString()
    });

    expect((await stores.issues.get(OTHER_WS, 'i2'))!.comments).toEqual([]);
  });

  it('merges an update and leaves the rest alone', async () => {
    const stores = await backend.open();
    const projectId = await withProject(stores);
    const issue = await stores.issues.create(WS, { title: 'Fix cart', description: 'basket', projectId });

    const updated = await stores.issues.update(WS, issue.id, { status: 'in_progress', labels: ['bug'] });
    expect(updated).toMatchObject({ title: 'Fix cart', description: 'basket', status: 'in_progress' });
    expect(updated!.labels).toEqual(['bug']);
    expect(Date.parse(updated!.updatedAt)).toBeGreaterThanOrEqual(Date.parse(issue.updatedAt));
  });

  /** An issue has one execution owner: a squad supersedes an agent. */
  it('will not hold both an agent and a squad', async () => {
    const stores = await backend.open();
    const projectId = await withProject(stores);
    await stores.seedSquad('squad-1');
    await stores.seedAgent('agent-1');
    const issue = await stores.issues.create(WS, { title: 'Fix cart', projectId, assignedAgentId: 'agent-1' });

    const updated = await stores.issues.update(WS, issue.id, { assignedSquadId: 'squad-1' });
    expect(updated!.assignedSquadId).toBe('squad-1');
    expect(updated!.assignedAgentId).toBeUndefined();
  });

  it('clears both assignment types after an explicit unassign', async () => {
    const stores = await backend.open();
    const projectId = await withProject(stores);
    await stores.seedSquad('squad-clear');
    const issue = await stores.issues.create(WS, { title: 'Clear ownership', projectId, assignedSquadId: 'squad-clear' });
    await stores.issues.update(WS, issue.id, { assignedAgentId: undefined, assignedSquadId: undefined });
    const read = await stores.issues.get(WS, issue.id);
    expect(read!.assignedAgentId).toBeFalsy();
    expect(read!.assignedSquadId).toBeFalsy();
  });

  it('deletes an issue and its comments, once', async () => {
    const stores = await backend.open();
    const projectId = await withProject(stores);
    const issue = await stores.issues.create(WS, { title: 'Fix cart', projectId });
    await stores.issues.addComment(WS, {
      id: 'c1',
      issueId: issue.id,
      authorType: 'user',
      authorName: 'Someone',
      content: 'a note',
      createdAt: new Date().toISOString()
    });

    expect(await stores.issues.remove(WS, issue.id)).toBe(true);
    expect(await stores.issues.remove(WS, issue.id)).toBe(false);
    expect(await stores.issues.list(WS)).toEqual([]);
  });

  /** What the GitHub sync writes back onto a card, and reads to avoid duplicates. */
  it('round-trips the GitHub fields a sync depends on', async () => {
    const stores = await backend.open();
    const projectId = await withProject(stores);
    const issue = await stores.issues.create(WS, { title: 'Fix cart', projectId });

    await stores.issues.update(WS, issue.id, {
      githubRepo: 'acme/checkout',
      githubNumber: 42,
      githubUrl: 'https://github.com/acme/checkout/issues/42'
    });
    await stores.issues.addComment(WS, {
      id: 'gh-1',
      issueId: issue.id,
      authorType: 'user',
      authorName: 'octocat',
      content: 'from github',
      githubId: 9876543210,
      createdAt: new Date().toISOString()
    });

    const read = await stores.issues.get(WS, issue.id);
    expect(read).toMatchObject({ githubRepo: 'acme/checkout', githubNumber: 42 });
    expect(read!.comments[0].githubId).toBe(9876543210);
  });
});

/**
 * An assignee is a real agent again.
 *
 * `0009` dropped the foreign key while the roster was per-machine and the
 * cloud could not have known the agent an issue named. Desktops publish their
 * agents now, so `0011` enforces it once more -- and a card outlives the agent
 * it was assigned to.
 */
describe('the cloud store on an issue’s assignee', () => {
  it('keeps an assignment to an agent it has', async () => {
    const stores = await openPostgres();
    const projectId = await withProject(stores);
    await stores.seedAgent('agent-architect');

    const issue = await stores.issues.create(WS, { title: 'Fix cart', projectId, assignedAgentId: 'agent-architect' });

    expect((await stores.issues.get(WS, issue.id))!.assignedAgentId).toBe('agent-architect');
  });

  it('refuses one it has never met', async () => {
    const stores = await openPostgres();
    const projectId = await withProject(stores);

    const write = stores.issues.create(WS, { title: 'Fix cart', projectId, assignedAgentId: 'agent-nobody' });

    await expect(write).rejects.toThrow();
  });

  /** Retiring an agent must not delete the work it was assigned. */
  it('empties the assignment when the agent is deleted', async () => {
    const stores = await openPostgres();
    const projectId = await withProject(stores);
    await stores.seedAgent('agent-architect');
    const issue = await stores.issues.create(WS, { title: 'Fix cart', projectId, assignedAgentId: 'agent-architect' });

    await pg.exec(`delete from agents where id = 'agent-architect'`);

    const read = await stores.issues.get(WS, issue.id);
    expect(read).toMatchObject({ title: 'Fix cart' });
    expect(read!.assignedAgentId).toBeUndefined();
  });
});
