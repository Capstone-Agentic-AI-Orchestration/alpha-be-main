import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';

import { createTestDatabase } from '../store/testDatabase.js';

let db: PGlite;

beforeAll(async () => {
  db = await createTestDatabase();
  await db.exec(`
    insert into workspaces (id, name, slug) values
      ('ws1', 'Alpha', 'alpha'),
      ('ws2', 'Beta', 'beta');
  `);
});

afterAll(async () => { await db?.close(); });

describe('durable workspace board change log', () => {
  it('records inserts, updates, and deletes for every board table', async () => {
    await db.exec(`
      insert into projects (id,workspace_id,name,key,created_by)
        values ('evt-project','ws1','Before','EVT','PM1');
      insert into agents (id,workspace_id,name,role,model_provider,model_name,autonomy_level)
        values ('evt-agent','ws1','Agent','builder','openai','gpt','supervised');
      insert into squads (id,workspace_id,name,topology,mission)
        values ('evt-squad','ws1','Squad','sequential','Ship work');
      insert into issues (id,workspace_id,identifier,title,status,priority,project_id)
        values ('evt-issue','ws1','EVT-1','Before','todo','high','evt-project');
      insert into issue_comments (id,issue_id,author_type,author_name,content)
        values ('evt-comment','evt-issue','user','Lloyd','Before');
      insert into workspace_squad_owners (id,workspace_id,squad_id,user_id)
        values ('evt-owner','ws1','evt-squad','Lloyd');
      insert into workspace_squad_projects (id,workspace_id,squad_id,project_id)
        values ('evt-squad-project','ws1','evt-squad','evt-project');
      insert into workspace_project_assignments (id,workspace_id,project_id,user_id)
        values ('evt-assignment','ws1','evt-project','Lloyd');

      update projects set name = 'After' where id = 'evt-project';
      update agents set name = 'After' where id = 'evt-agent';
      update squads set mission = 'After' where id = 'evt-squad';
      update issues set title = 'After' where id = 'evt-issue';
      update issue_comments set content = 'After' where id = 'evt-comment';
      update workspace_squad_owners set status = 'inactive' where id = 'evt-owner';
      update workspace_squad_projects set status = 'inactive' where id = 'evt-squad-project';
      update workspace_project_assignments set status = 'inactive' where id = 'evt-assignment';

      delete from issue_comments where id = 'evt-comment';
      delete from issues where id = 'evt-issue';
      delete from workspace_project_assignments where id = 'evt-assignment';
      delete from workspace_squad_projects where id = 'evt-squad-project';
      delete from workspace_squad_owners where id = 'evt-owner';
      delete from squads where id = 'evt-squad';
      delete from agents where id = 'evt-agent';
      delete from projects where id = 'evt-project';
    `);

    const result = await db.query<{ table_name: string; operation: string; row_key: Record<string, string> }>(`
      select table_name, operation, row_key
      from public.workspace_board_changes
      where workspace_id = 'ws1'
        and row_key->>'id' like 'evt-%'
      order by cursor
    `);
    const observed = new Set(result.rows.map(row => `${row.table_name}:${row.operation}`));
    const tables = [
      'projects', 'issues', 'issue_comments', 'agents', 'squads',
      'workspace_squad_owners', 'workspace_squad_projects', 'workspace_project_assignments'
    ];
    for (const table of tables) {
      for (const operation of ['insert', 'update', 'delete']) {
        expect(observed.has(`${table}:${operation}`), `${table} ${operation}`).toBe(true);
      }
    }
    expect(result.rows.find(row => row.table_name === 'projects')?.row_key).toEqual({ id: 'evt-project' });
  });

  it('serializes concurrent writes into an ordered workspace cursor', async () => {
    const before = await db.query<{ last_cursor: string }>(
      `select last_cursor::text as last_cursor from public.workspace_board_cursors where workspace_id = 'ws1'`
    );
    const start = BigInt(before.rows[0].last_cursor);

    await Promise.all(Array.from({ length: 6 }, (_, index) => db.query(
      `insert into projects (id,workspace_id,name,key,created_by) values ($1,'ws1',$2,$3,'PM1')`,
      [`parallel-${index}`, `Parallel ${index}`, `PAR${index}`]
    )));

    const result = await db.query<{ cursor: string }>(`
      select cursor::text as cursor
      from public.workspace_board_changes
      where workspace_id = 'ws1' and row_key->>'id' like 'parallel-%'
      order by cursor
    `);
    expect(result.rows.map(row => BigInt(row.cursor))).toEqual(
      Array.from({ length: 6 }, (_, index) => start + BigInt(index + 1))
    );
  });

  it('rolls back both the cursor increment and its change record', async () => {
    const before = await db.query<{ last_cursor: string; changes: string }>(`
      select c.last_cursor::text as last_cursor,
             (select count(*)::text from public.workspace_board_changes where workspace_id = 'ws1') as changes
      from public.workspace_board_cursors c where c.workspace_id = 'ws1'
    `);

    await db.exec('begin');
    await db.query(`
      insert into projects (id,workspace_id,name,key,created_by)
      values ('rolled-back-project','ws1','Temporary','RBK','PM1')
    `);
    await db.exec('rollback');

    const after = await db.query<{ last_cursor: string; changes: string }>(`
      select c.last_cursor::text as last_cursor,
             (select count(*)::text from public.workspace_board_changes where workspace_id = 'ws1') as changes
      from public.workspace_board_cursors c where c.workspace_id = 'ws1'
    `);
    expect(after.rows[0]).toEqual(before.rows[0]);
    expect(await db.query(`select 1 from public.workspace_board_changes where row_key->>'id'='rolled-back-project'`))
      .toMatchObject({ rows: [] });
  });

  it('records a workspace move as a removal and an addition', async () => {
    await db.exec(`
      insert into projects (id,workspace_id,name,key,created_by)
      values ('moving-project','ws1','Moving','MOV','PM1')
    `);
    const prior = await db.query<{ workspace_id: string; cursor: string }>(`
      select w.id as workspace_id, coalesce(c.last_cursor, 0)::text as cursor
      from (values ('ws1'::text), ('ws2'::text)) as w(id)
      left join public.workspace_board_cursors c on c.workspace_id = w.id
      order by w.id
    `);
    await db.exec(`update projects set workspace_id='ws2' where id='moving-project'`);

    const result = await db.query<{ workspace_id: string; operation: string }>(`
      select workspace_id, operation from public.workspace_board_changes
      where table_name='projects' and row_key->>'id'='moving-project'
        and ((workspace_id='ws1' and cursor > $1) or (workspace_id='ws2' and cursor > $2))
      order by workspace_id, cursor
    `, prior.rows.map(row => row.cursor));
    expect(result.rows).toEqual([
      { workspace_id: 'ws1', operation: 'delete' },
      { workspace_id: 'ws2', operation: 'insert' }
    ]);
  });

  it('replays existing issue comments when their parent issue moves workspaces', async () => {
    await db.exec(`
      insert into projects (id,workspace_id,name,key,created_by)
        values ('moving-comment-project','ws1','Comment project','MCP','PM1');
      insert into issues (id,workspace_id,identifier,title,status,priority,project_id)
        values ('moving-comment-issue','ws1','MCP-1','Moving issue','todo','normal','moving-comment-project');
      insert into issue_comments (id,issue_id,author_type,author_name,content)
        values ('moving-comment','moving-comment-issue','user','Lloyd','Keep this comment');
    `);
    const prior = await db.query<{ workspace_id: string; cursor: string }>(`
      select w.id as workspace_id, coalesce(c.last_cursor, 0)::text as cursor
      from (values ('ws1'::text), ('ws2'::text)) as w(id)
      left join public.workspace_board_cursors c on c.workspace_id = w.id
      order by w.id
    `);

    await db.exec(`update issues set workspace_id='ws2' where id='moving-comment-issue'`);

    const result = await db.query<{ workspace_id: string; operation: string }>(`
      select workspace_id, operation from public.workspace_board_changes
      where table_name='issue_comments' and row_key->>'id'='moving-comment'
        and ((workspace_id='ws1' and cursor > $1) or (workspace_id='ws2' and cursor > $2))
      order by workspace_id, cursor
    `, prior.rows.map(row => row.cursor));
    expect(result.rows).toEqual([
      { workspace_id: 'ws1', operation: 'delete' },
      { workspace_id: 'ws2', operation: 'insert' }
    ]);
  });

  it('resolves an issue comment workspace through its parent issue', async () => {
    await db.exec(`
      insert into projects (id,workspace_id,name,key,created_by)
        values ('comment-project','ws1','Comment project','CMT','PM1');
      insert into issues (id,workspace_id,identifier,title,status,priority,project_id)
        values ('comment-issue','ws1','CMT-1','Comment issue','todo','normal','comment-project');
      insert into issue_comments (id,issue_id,author_type,author_name,content)
        values ('workspace-resolved-comment','comment-issue','user','Lloyd','Hello');
    `);
    const result = await db.query<{ workspace_id: string; operation: string }>(`
      select workspace_id, operation from public.workspace_board_changes
      where table_name='issue_comments' and row_key->>'id'='workspace-resolved-comment'
    `);
    expect(result.rows).toEqual([{ workspace_id: 'ws1', operation: 'insert' }]);
  });

  it('sends only the cursor marker through the private Realtime channel', async () => {
    await db.exec(`
      insert into projects (id,workspace_id,name,key,created_by)
      values ('marker-project','ws1','Marker','MRK','PM1')
    `);
    const result = await db.query<{ event: string; payload: Record<string, unknown>; private: boolean }>(`
      select event, payload, private from realtime.messages
      where topic='workspace:ws1:board' and event='board_changed'
      order by ctid desc limit 1
    `);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].private).toBe(true);
    expect(Object.keys(result.rows[0].payload)).toEqual(['cursor']);
    expect(result.rows[0].payload.cursor).toEqual(expect.any(String));
  });

  it('grants authenticated users read access only and defaults retention to 30 days', async () => {
    const grants = await db.query<{
      can_select: boolean;
      can_insert: boolean;
      can_update: boolean;
      can_delete: boolean;
    }>(`
      select has_table_privilege('authenticated', 'public.workspace_board_changes', 'SELECT') as can_select,
             has_table_privilege('authenticated', 'public.workspace_board_changes', 'INSERT') as can_insert,
             has_table_privilege('authenticated', 'public.workspace_board_changes', 'UPDATE') as can_update,
             has_table_privilege('authenticated', 'public.workspace_board_changes', 'DELETE') as can_delete
    `);
    expect(grants.rows[0]).toEqual({
      can_select: true,
      can_insert: false,
      can_update: false,
      can_delete: false
    });

    const retention = await db.query<{ retention_days: number }>(`
      select retention_days from public.workspace_board_cursors where workspace_id='ws1'
    `);
    expect(retention.rows[0].retention_days).toBe(30);
  });

  it('prunes old rows at most once per day using the workspace retention setting', async () => {
    await db.exec(`insert into workspaces (id,name,slug) values ('ws-retention','Retention','retention')`);
    await db.exec(`
      insert into projects (id,workspace_id,name,key,created_by)
      values ('retention-first','ws-retention','First','RT1','PM1');
      update public.workspace_board_cursors
         set retention_days=1, last_pruned_at=pg_catalog.now() - interval '2 days'
       where workspace_id='ws-retention';
      update public.workspace_board_changes
         set created_at=pg_catalog.now() - interval '2 days'
       where workspace_id='ws-retention';
      insert into projects (id,workspace_id,name,key,created_by)
      values ('retention-second','ws-retention','Second','RT2','PM1');
    `);
    const afterDailyPrune = await db.query<{ ids: string[] }>(`
      select array_agg(row_key->>'id' order by cursor) as ids
      from public.workspace_board_changes where workspace_id='ws-retention'
    `);
    expect(afterDailyPrune.rows[0].ids).toEqual(['retention-second']);

    await db.exec(`
      update public.workspace_board_changes
         set created_at=pg_catalog.now() - interval '2 days'
       where workspace_id='ws-retention';
      insert into projects (id,workspace_id,name,key,created_by)
      values ('retention-third','ws-retention','Third','RT3','PM1');
    `);
    const beforeNextDailyPrune = await db.query<{ ids: string[] }>(`
      select array_agg(row_key->>'id' order by cursor) as ids
      from public.workspace_board_changes where workspace_id='ws-retention'
    `);
    expect(beforeNextDailyPrune.rows[0].ids).toEqual(['retention-second', 'retention-third']);
  });
});
