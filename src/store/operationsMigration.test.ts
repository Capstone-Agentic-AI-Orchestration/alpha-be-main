import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDatabase } from './testDatabase.js';
import { incidentTransition } from '../services/operationsLogic.js';

let db: PGlite;

beforeAll(async () => {
  db = await createTestDatabase();
  await db.exec(`insert into public.workspaces(id,name,slug) values ('ws-ops-a','Ops A','ops-a'),('ws-ops-b','Ops B','ops-b');
    insert into public.projects(id,workspace_id,name,key,status) values
      ('project-ops-a','ws-ops-a','Alpha API','OPS-A','in_progress'),
      ('project-ops-b','ws-ops-b','Other API','OPS-B','in_progress');`);
}, 60_000);

afterAll(async () => { await db?.close(); });

describe('Operations Center cloud schema', () => {
  it('revokes direct reads and writes and keeps cross-workspace project costs isolated', async () => {
    const privileges = await db.query<{ select: boolean; insert: boolean }>(`select
      has_table_privilege('anon','alpha_private.ops_incidents','select') as select,
      has_table_privilege('authenticated','alpha_private.ops_project_expenses','insert') as insert`);
    expect(privileges.rows[0]).toEqual({ select: false, insert: false });

    await expect(db.query(`insert into alpha_private.ops_project_budgets(workspace_id,project_id,amount_usd,updated_by)
      values('ws-ops-a','project-ops-b',100,'admin-a')`)).rejects.toMatchObject({ code: '23503' });
    await db.exec(`insert into alpha_private.ops_project_budgets(workspace_id,project_id,amount_usd,updated_by)
      values('ws-ops-a','project-ops-a',100,'admin-a')`);
    const scoped = await db.query(`select project_id from alpha_private.ops_project_budgets where workspace_id='ws-ops-b'`);
    expect(scoped.rows).toEqual([]);
  });

  it('deduplicates incidents and resolves only after two successful probes', async () => {
    await db.exec(`insert into alpha_private.ops_monitored_targets
      (id,workspace_id,project_id,repository,environment,kind,provider,url,check_path,availability_target)
      values('target-ops-a','ws-ops-a','project-ops-a','alpha/api','production','service','render','https://api.example.com','/health',99.9);
      insert into alpha_private.ops_probe_samples(workspace_id,target_id,checked_at,ok,latency_ms,error) values
        ('ws-ops-a','target-ops-a','2026-10-26T00:00:00Z',false,1000,'HTTP 503'),
        ('ws-ops-a','target-ops-a','2026-10-26T00:01:00Z',false,1000,'HTTP 503');`);
    await expect(db.query(`insert into alpha_private.ops_probe_samples(workspace_id,target_id,checked_at,ok,latency_ms)
      values('ws-ops-b','target-ops-a','2026-10-26T00:01:30Z',false,1000)`)).rejects.toMatchObject({ code: '23503' });
    await expect(db.query(`insert into alpha_private.ops_incidents(id,workspace_id,target_id,started_at)
      values('incident-cross-workspace','ws-ops-b','target-ops-a',now())`)).rejects.toMatchObject({ code: '23503' });
    let samples = await db.query<{ ok: boolean }>(`select ok from alpha_private.ops_probe_samples where workspace_id='ws-ops-a' and target_id='target-ops-a' order by checked_at desc limit 2`);
    expect(incidentTransition(samples.rows, false)).toBe('open');
    const open = await db.query(`insert into alpha_private.ops_incidents(id,workspace_id,target_id,started_at,last_error)
      select 'incident-ops-a','ws-ops-a','target-ops-a',now(),'HTTP 503'
      where not exists(select 1 from alpha_private.ops_incidents where workspace_id='ws-ops-a' and target_id='target-ops-a' and resolved_at is null)
      returning id`);
    expect(open.rows).toHaveLength(1);
    const duplicate = await db.query(`insert into alpha_private.ops_incidents(id,workspace_id,target_id,started_at,last_error)
      select 'incident-ops-duplicate','ws-ops-a','target-ops-a',now(),'HTTP 503'
      where not exists(select 1 from alpha_private.ops_incidents where workspace_id='ws-ops-a' and target_id='target-ops-a' and resolved_at is null)
      returning id`);
    expect(duplicate.rows).toHaveLength(0);

    await db.exec(`insert into alpha_private.ops_probe_samples(workspace_id,target_id,checked_at,ok,latency_ms) values
      ('ws-ops-a','target-ops-a','2026-10-26T00:02:00Z',true,120),
      ('ws-ops-a','target-ops-a','2026-10-26T00:03:00Z',true,110);`);
    samples = await db.query(`select ok from alpha_private.ops_probe_samples where workspace_id='ws-ops-a' and target_id='target-ops-a' order by checked_at desc limit 2`);
    expect(incidentTransition(samples.rows, true)).toBe('resolve');
    const resolution = await db.query(`update alpha_private.ops_incidents set resolved_at='2026-10-26T00:03:00Z'
      where workspace_id='ws-ops-a' and target_id='target-ops-a' and resolved_at is null returning id`);
    expect(resolution.rows).toHaveLength(1);
    const count = await db.query<{ count: string }>(`select count(*) from alpha_private.ops_incidents where workspace_id='ws-ops-a' and target_id='target-ops-a'`);
    expect(Number(count.rows[0].count)).toBe(1);
  });

  it('updates provider deployment history idempotently by provider ID', async () => {
    const write = `insert into alpha_private.ops_deployments
      (id,workspace_id,project_id,repository,provider,provider_deployment_id,environment,status,started_at)
      values($1,'ws-ops-a','project-ops-a','alpha/api','render','render-deploy-1','production',$2,'2026-10-26T00:00:00Z')
      on conflict(workspace_id,provider,provider_deployment_id) do update set status=excluded.status`;
    await db.query(write, ['deploy-ops-a', 'building']);
    await db.query(write, ['deploy-ops-a', 'live']);
    const rows = await db.query<{ status: string; count: string | number }>(`select status,count(*) over() as count from alpha_private.ops_deployments
      where workspace_id='ws-ops-a' and provider_deployment_id='render-deploy-1'`);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ status: 'live' });
    expect(Number(rows.rows[0].count)).toBe(1);
  });

  it('records ticket state transitions for around-the-clock SLA clocks', async () => {
    await db.query(`insert into alpha_private.tickets(id,workspace_id,reference,title,description,client_safe_company_label,source,status,workflow_state)
      values('ticket-ops-a','ws-ops-a','OPS-T1','SLA test','Description','Alpha','authenticated_client','received',
        '{"id":"ticket-ops-a","workspaceId":"ws-ops-a","status":"received","version":"0","actionOwner":"pm"}'::jsonb)`);
    await db.query(`update alpha_private.tickets set status='awaiting_client',version=1,
      workflow_state='{"id":"ticket-ops-a","workspaceId":"ws-ops-a","status":"awaiting_client","version":"1","actionOwner":"client"}'::jsonb
      where workspace_id='ws-ops-a' and id='ticket-ops-a'`);
    const events = await db.query<{ status: string; action_owner: string }>(`select status,action_owner from alpha_private.ops_ticket_sla_events
      where workspace_id='ws-ops-a' and ticket_id='ticket-ops-a' order by id`);
    expect(events.rows).toEqual([
      { status: 'received', action_owner: 'pm' },
      { status: 'awaiting_client', action_owner: 'client' }
    ]);
  });
});
