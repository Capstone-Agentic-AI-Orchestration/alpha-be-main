import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTestDatabase, sqlFor } from './testDatabase.js';
import { PostgresProjectStore } from './postgresProjectStore.js';
import type { ProjectStore } from './projectStore.js';

/**
 * One contract, two stores.
 *
 * Projects are the board's root: an issue, a run and a chat thread are all
 * scoped through one. The cloud keeps them in Postgres and a desktop in
 * SQLite, and the routes above cannot tell which they have — so what they
 * promise is stated once and run against both.
 *
 * The SQLite store is exercised through `sqliteService`, the real one, in a
 * temporary database. Postgres is PGlite with the real migrations.
 */

const WS = 'ws-default';
const OTHER_WS = 'ws-other';

let pg: PGlite;
let tmp: string;
let sqliteModules: { store: ProjectStore; close(): void } | null = null;

beforeAll(async () => {
  pg = await createTestDatabase();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-projects-'));
}, 60_000);

afterAll(async () => {
  sqliteModules?.close();
  await pg?.close();
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* windows handle */
  }
});

async function openSqlite(): Promise<ProjectStore> {
  // A fresh database per test, through the service that owns the desktop's SQL.
  sqliteModules?.close();
  process.env.ALPHA_HOME = fs.mkdtempSync(path.join(tmp, 'home-'));
  vi.resetModules();
  const sql = await import('../services/sqliteService.js');
  const { SqliteProjectStore } = await import('./sqliteProjectStore.js');
  sqliteModules = { store: new SqliteProjectStore(), close: () => sql.sqliteService.close() };
  return sqliteModules.store;
}

async function openPostgres(): Promise<ProjectStore> {
  await pg.exec('truncate projects, workspaces cascade');
  await pg.exec(`insert into workspaces (id, name, slug) values
    ('${WS}', 'Alpha', 'alpha'), ('${OTHER_WS}', 'Other', 'other')`);
  return new PostgresProjectStore(sqlFor(pg));
}

const backends = [
  { name: 'sqlite', open: openSqlite },
  { name: 'postgres', open: openPostgres }
];

describe.each(backends)('the project store ($name)', backend => {
  it('fills in what the caller did not send', async () => {
    const store = await backend.open();

    const project = await store.create(WS, { name: 'Checkout' });
    expect(project.id).toBeTruthy();
    expect(project.key).toBeTruthy();
    expect(project).toMatchObject({ name: 'Checkout', status: 'in_progress', priority: 'medium' });
    expect(project.createdAt).toBeTruthy();
  });

  it('reads back what it wrote', async () => {
    const store = await backend.open();
    const created = await store.create(WS, {
      id: 'p1',
      name: 'Checkout',
      key: 'CHK',
      description: 'Basket and payment',
      resources: [{ id: 'r1', type: 'github_repo', name: 'repo', pathOrUrl: 'https://github.com/acme/checkout' }],
      githubOrg: 'acme'
    });

    const read = await store.get(WS, 'p1');
    expect(read).toMatchObject({
      id: 'p1',
      name: 'Checkout',
      key: 'CHK',
      description: 'Basket and payment',
      githubOrg: 'acme'
    });
    expect(read!.resources[0].pathOrUrl).toBe('https://github.com/acme/checkout');
    expect(created.id).toBe('p1');
  });

  /** A project belongs to exactly one workspace, and is invisible from another. */
  it('never reaches across workspaces', async () => {
    const store = await backend.open();
    await store.create(WS, { id: 'p1', name: 'Ours', key: 'OUR' });
    await store.create(OTHER_WS, { id: 'p2', name: 'Theirs', key: 'THR' });

    expect((await store.list(WS)).map(p => p.id)).toEqual(['p1']);
    expect(await store.get(WS, 'p2')).toBeNull();
    expect(await store.update(WS, 'p2', { name: 'Hijacked' })).toBeNull();
    expect(await store.remove(WS, 'p2')).toBe(false);
    // Still there, under its own workspace.
    expect((await store.get(OTHER_WS, 'p2'))?.name).toBe('Theirs');
  });

  it('merges an update, leaving absent fields alone', async () => {
    const store = await backend.open();
    await store.create(WS, { id: 'p1', name: 'Checkout', key: 'CHK', description: 'Basket' });

    const updated = await store.update(WS, 'p1', { status: 'completed' });
    expect(updated).toMatchObject({ name: 'Checkout', description: 'Basket', status: 'completed' });
    expect(await store.update(WS, 'no-such-project', { name: 'x' })).toBeNull();
  });

  it('deletes once', async () => {
    const store = await backend.open();
    await store.create(WS, { id: 'p1', name: 'Checkout', key: 'CHK' });

    expect(await store.remove(WS, 'p1')).toBe(true);
    expect(await store.remove(WS, 'p1')).toBe(false);
    expect(await store.list(WS)).toEqual([]);
  });

  /** The key is what an issue's identifier is built from, so it is unique. */
  it('refuses a duplicate project key', async () => {
    const store = await backend.open();
    await store.create(WS, { id: 'p1', name: 'Checkout', key: 'CHK' });

    await expect(store.create(WS, { id: 'p2', name: 'Copy', key: 'CHK' })).rejects.toThrow();
  });
});

/**
 * What the shared table will not carry.
 *
 * Both are the same rule as `0003`, which dropped the agents' CLI arguments
 * and environment: a cloud row that turns into a command, or a path, on
 * someone else's machine.
 */
describe('the cloud store leaves machine-local details behind', () => {
  it('drops local paths from a project\u2019s resources', async () => {
    const store = await openPostgres();
    await store.create(WS, {
      id: 'p1',
      name: 'Checkout',
      key: 'CHK',
      resources: [
        { id: 'r1', type: 'github_repo', name: 'repo', pathOrUrl: 'https://github.com/acme/checkout' },
        { id: 'r2', type: 'local_path', name: 'my copy', pathOrUrl: 'C:/Users/someone/checkout' },
        { id: 'r3', type: 'local_dir', name: 'scratch', pathOrUrl: '/home/someone/scratch' }
      ]
    });

    const stored = await store.get(WS, 'p1');
    expect(stored!.resources.map(r => r.type)).toEqual(['github_repo']);
  });

  it('does not store a project\u2019s environment values', async () => {
    const store = await openPostgres();
    await store.create(WS, {
      id: 'p1',
      name: 'Checkout',
      key: 'CHK',
      envVars: [{ key: 'DATABASE_URL', value: 'postgres://user:password@host/db', isSecret: true }]
    });

    const stored = await store.get(WS, 'p1');
    expect(stored!.envVars).toEqual([]);
    const { rows } = await pg.query<{ row: string }>('select projects::text as row from projects');
    expect(rows[0].row).not.toContain('password');
  });
});
