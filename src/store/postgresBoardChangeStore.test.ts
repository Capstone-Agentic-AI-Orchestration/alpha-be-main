import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';

import { createTestDatabase, sqlFor } from './testDatabase.js';
import { PostgresBoardChangeStore } from './postgresBoardChangeStore.js';
import { boardChangeKey } from '../services/boardChangeSync.js';

let db: PGlite;
let store: PostgresBoardChangeStore;

async function addProject(id: string, workspaceId: string, key: string): Promise<void> {
  await db.query(
    `insert into projects (id,workspace_id,name,key,created_by) values ($1,$2,$3,$4,'PM1')`,
    [id, workspaceId, id, key]
  );
}

beforeAll(async () => {
  db = await createTestDatabase();
  store = new PostgresBoardChangeStore(sqlFor(db));
  await db.exec(`
    insert into workspaces (id,name,slug) values
      ('ws1','Alpha','alpha'), ('ws2','Beta','beta');
  `);
  await addProject('one', 'ws1', 'ONE');
  await addProject('two', 'ws1', 'TWO');
  await addProject('foreign', 'ws2', 'FOR');
});

afterAll(async () => { await db?.close(); });

describe('PostgresBoardChangeStore', () => {
  it('returns an ordered workspace-only page and advances at the last scanned cursor', async () => {
    expect(await store.watermark('ws1')).toBe('2');
    const first = await store.readAfter('ws1', '0', 1);
    expect(first.rows.map(row => row.cursor)).toEqual(['1']);
    expect(first.hasMore).toBe(true);
    expect(first.oldestCursor).toBe('1');
    expect(first.currentCursor).toBe('2');

    const second = await store.readAfter('ws1', first.rows[0].cursor, 10);
    expect(second.rows.map(row => row.cursor)).toEqual(['2']);
    expect(second.hasMore).toBe(false);
    expect(second.rows.every(row => row.table === 'projects')).toBe(true);
  });

  it('never returns more than 100 rows, even when asked for a larger page', async () => {
    for (let index = 0; index < 105; index += 1) {
      await addProject(`cap-${index}`, 'ws1', `C${index}`);
    }

    const page = await store.readAfter('ws1', '0', 500);
    expect(page.rows).toHaveLength(100);
    expect(page.hasMore).toBe(true);
    expect(page.rows.every(row => row.table === 'projects')).toBe(true);
  });

  it('fetches only named current rows and never crosses the requested workspace', async () => {
    await addProject('another-foreign', 'ws2', 'FOR2');
    const change = {
      cursor: '2',
      table: 'projects' as const,
      rowKey: { id: 'foreign' },
      operation: 'update' as const,
      createdAt: new Date().toISOString()
    };
    const access = { canReadIssues: true, canReadAgents: true, canReadSquads: true };

    expect(await store.readRows('ws1', [change], access)).toEqual(new Map());
    const rows = await store.readRows('ws2', [change], access);
    expect(rows.size).toBe(1);
    expect(rows.get(boardChangeKey('projects', { id: 'foreign' }))).toMatchObject({
      id: 'foreign',
      name: 'foreign'
    });
  });
});
