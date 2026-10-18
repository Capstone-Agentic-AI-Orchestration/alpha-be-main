import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';

import { createTestDatabase } from '../store/testDatabase.js';
import { runToCloudRow, squadRunToCloudRow } from './supabaseService.js';
import { projectRow } from '../store/postgresProjectStore.js';
import type { Project, PrototypeRun, SquadRun } from '../models/index.js';

/**
 * Whether what the desktop sends is what the cloud table accepts.
 *
 * This is the failure mode no type catches. `saveRunToCloud` built a
 * well-formed object, in valid TypeScript, that omitted `workspace_id` and
 * `owner_id` — both `NOT NULL`. It compiled, it read as complete, and every
 * insert would have been rejected.
 *
 * It had been invisible for months because the error was swallowed, and
 * because the table it was failing against did not exist either, so the
 * failure looked the same as the absence.
 *
 * A mapper that never meets its schema is a guess. This inserts the real
 * payload into the real migration.
 */

let db: PGlite;

const run: PrototypeRun = {
  id: 'run-1',
  issueId: 'i1',
  projectId: 'p1',
  agentId: 'a1',
  status: 'running',
  scenario: 'success',
  plan: [],
  currentStageIndex: 0,
  stages: [],
  activities: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
} as PrototypeRun;

const squadRun: SquadRun = {
  id: 'squad-run-1',
  squadId: 'squad-core',
  issueId: 'i1',
  projectId: 'p1',
  branchName: 'squad/core/EC-1-1234',
  memberAgentIds: ['agent-1', 'agent-2'],
  currentMemberIndex: 1,
  status: 'running',
  mission: 'Build the cart',
  plan: ['Implement', 'Verify'],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
};

beforeAll(async () => {
  // RLS is not the subject here -- `rlsPolicies.test.ts` covers that -- so this
  // runs as superuser and the policies do not apply.
  db = await createTestDatabase();

  await db.exec(`
    insert into workspaces (id,name,slug) values ('ws1','Alpha','alpha');
    insert into projects (id,workspace_id,name,key) values ('p1','ws1','Checkout','EC');
    insert into issues (id,workspace_id,identifier,title,status,priority,project_id)
      values ('i1','ws1','EC-1','Fix cart','todo','high','p1');
  `);
});

afterAll(async () => { await db?.close(); });

/** Insert the mapper's output the way PostgREST would. */
async function insertRow(row: Record<string, unknown>, table = 'prototype_runs') {
  const cols = Object.keys(row);
  const params = cols.map((_, i) => `$${i + 1}`);
  const values = cols.map(c => {
    const v = row[c];
    return v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
  });
  return db.query(
    `insert into ${table} (${cols.join(',')}) values (${params.join(',')})`,
    values
  );
}

describe('the run sync payload', () => {
  it('inserts into the real prototype_runs table', async () => {
    await expect(insertRow(runToCloudRow(run, 'ws1', 'Lloyd1020'))).resolves.toBeTruthy();

    const stored = await db.query(`select * from prototype_runs where id='run-1'`);
    expect(stored.rows).toHaveLength(1);
  });

  it('carries the workspace and owner the table requires', async () => {
    const stored = await db.query<{ workspace_id: string; owner_id: string }>(
      `select workspace_id, owner_id from prototype_runs where id='run-1'`
    );
    expect(stored.rows[0].workspace_id).toBe('ws1');
    expect(stored.rows[0].owner_id).toBe('Lloyd1020');
  });

  /**
   * The regression this file exists for.
   *
   * Dropping either column reproduces exactly what the service used to send,
   * and the database has to reject it — otherwise the test above would pass
   * against a schema that had quietly stopped requiring them.
   */
  it('is rejected without the owner, as the old payload would have been', async () => {
    const { owner_id, ...withoutOwner } = runToCloudRow(run, 'ws1', 'Lloyd1020');
    await expect(insertRow({ ...withoutOwner, id: 'run-2' })).rejects.toThrow(/owner_id/);
  });

  it('is rejected without the workspace', async () => {
    const { workspace_id, ...withoutWorkspace } = runToCloudRow(run, 'ws1', 'Lloyd1020');
    await expect(insertRow({ ...withoutWorkspace, id: 'run-3' })).rejects.toThrow(/workspace_id/);
  });

  /** Postgres has real foreign keys where SQLite's were advisory. */
  it('is rejected when it names a project that does not exist', async () => {
    const orphan = runToCloudRow({ ...run, projectId: 'nope' } as PrototypeRun, 'ws1', 'Lloyd1020');
    await expect(insertRow({ ...orphan, id: 'run-4' })).rejects.toThrow();
  });

  /** jsonb columns, not the TEXT-encoded JSON SQLite stores. */
  it('stores plan and stages as jsonb rather than a string', async () => {
    const withPlan = runToCloudRow(
      { ...run, plan: ['step one'], stages: [{ name: 'build' }] } as unknown as PrototypeRun,
      'ws1',
      'Lloyd1020'
    );
    await insertRow({ ...withPlan, id: 'run-5' });

    const stored = await db.query<{ plan: unknown; stages: unknown }>(
      `select plan, stages from prototype_runs where id='run-5'`
    );
    expect(stored.rows[0].plan).toEqual(['step one']);
    expect(stored.rows[0].stages).toEqual([{ name: 'build' }]);
  });
});

describe('the squad run sync payload', () => {
  it('inserts the sequencer state into the real squad_runs table', async () => {
    const payload = squadRunToCloudRow(squadRun, 'ws1', 'Lloyd1020');
    await expect(insertRow(payload, 'squad_runs')).resolves.toBeTruthy();

    const stored = await db.query<{
      workspace_id: string;
      owner_id: string;
      current_member_index: number;
      member_agent_ids: string[];
      plan: string[];
    }>(`select workspace_id, owner_id, current_member_index, member_agent_ids, plan from squad_runs where id='squad-run-1'`);
    expect(stored.rows[0]).toMatchObject({
      workspace_id: 'ws1',
      owner_id: 'Lloyd1020',
      current_member_index: 1,
      member_agent_ids: ['agent-1', 'agent-2'],
      plan: ['Implement', 'Verify']
    });
  });
});

/**
 * A project made on a desktop, as it goes to the team's board.
 *
 * Projects never left the machine they were made on, so every card filed
 * under one was refused by the cloud for naming a project it did not have.
 */
describe('the project sync payload', () => {
  const project = {
    id: 'p-desktop', name: 'Payments', key: 'PAY', description: '', color: '#6366f1', icon: '💳',
    status: 'in_progress', priority: 'medium', startDate: '', targetDate: '', leadType: 'agent', leadName: '',
    resources: [
      { id: 'r1', type: 'github_repo', name: 'payments', pathOrUrl: 'https://github.com/acme/payments' },
      { id: 'r2', type: 'local_path', name: 'checkout', pathOrUrl: 'C:/code/payments' }
    ],
    createdAt: ''
  } as unknown as Project;

  it('inserts into the real projects table, and an issue can then be filed under it', async () => {
    await expect(insertRow(projectRow('ws1', project), 'projects')).resolves.toBeTruthy();
    await expect(
      db.query(
        `insert into issues (id,workspace_id,identifier,title,status,priority,project_id)
         values ('i-pay','ws1','PAY-1','Refunds','todo','high','p-desktop')`
      )
    ).resolves.toBeTruthy();
  });

  it('leaves this machine’s folders behind', async () => {
    const stored = await db.query<{ resources: Array<{ type: string }> }>(
      `select resources from projects where id='p-desktop'`
    );
    expect(stored.rows[0].resources.map(r => r.type)).toEqual(['github_repo']);
  });
});
