import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTestDatabase, sqlFor } from './testDatabase.js';
import { PostgresRunStore } from './postgresRunStore.js';
import type { RunStore } from './runStore.js';
import type { PrototypeRun, SquadRun } from '../models/index.js';

/**
 * One contract, two stores — for runs.
 *
 * A run is written where the agent ran and read where oversight happens, so
 * these are the rows that cross the machine boundary. What they promise has
 * to be the same on both sides: the stages and activity a run accumulated,
 * the telemetry it reported (and the absence of telemetry it did not), and
 * the remote actions it took.
 */

const WS = 'ws-default';
const OTHER_WS = 'ws-other';
const OWNER = 'Lloyd1020';

let pg: PGlite;
let tmp: string;
let sqliteOpen: { close(): void } | null = null;

beforeAll(async () => {
  pg = await createTestDatabase();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-runs-'));
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

async function openSqlite(): Promise<RunStore> {
  sqliteOpen?.close();
  process.env.ALPHA_HOME = fs.mkdtempSync(path.join(tmp, 'home-'));
  vi.resetModules();
  const sql = await import('../services/sqliteService.js');
  const { SqliteRunStore } = await import('./sqliteRunStore.js');
  const { SqliteProjectStore } = await import('./sqliteProjectStore.js');
  const { SqliteIssueStore } = await import('./sqliteIssueStore.js');
  sqliteOpen = { close: () => sql.sqliteService.close() };

  // A run hangs off an issue, which hangs off a project.
  for (const workspaceId of [WS, OTHER_WS]) {
    await new SqliteProjectStore().create(workspaceId, { id: `p-${workspaceId}`, name: 'Checkout', key: `K${workspaceId.length}` });
    await new SqliteIssueStore().create(workspaceId, { id: `i-${workspaceId}`, title: 'Fix cart', projectId: `p-${workspaceId}` });
  }
  return new SqliteRunStore();
}

async function openPostgres(): Promise<RunStore> {
  await pg.exec('truncate prototype_runs, squad_runs, remote_actions, issues, projects, workspaces cascade');
  await pg.exec(`insert into workspaces (id, name, slug) values
    ('${WS}', 'Alpha', 'alpha'), ('${OTHER_WS}', 'Other', 'other')`);
  for (const workspaceId of [WS, OTHER_WS]) {
    await pg.exec(`insert into projects (id, workspace_id, name, key)
      values ('p-${workspaceId}', '${workspaceId}', 'Checkout', 'K${workspaceId.length}')`);
    // `identifier` is unique across the table, so each workspace gets its own.
    await pg.exec(`insert into issues (id, workspace_id, identifier, title, status, priority, project_id)
      values ('i-${workspaceId}', '${workspaceId}', 'K${workspaceId.length}-1', 'Fix cart', 'todo', 'high', 'p-${workspaceId}')`);
  }
  return new PostgresRunStore(sqlFor(pg));
}

const backends = [
  { name: 'sqlite', open: openSqlite },
  { name: 'postgres', open: openPostgres }
];

const aRun = (workspaceId = WS, over: Partial<PrototypeRun> = {}): PrototypeRun =>
  ({
    id: 'run-1',
    issueId: `i-${workspaceId}`,
    projectId: `p-${workspaceId}`,
    agentId: 'agent-architect',
    status: 'running',
    scenario: 'success',
    plan: ['Look at the cart'],
    currentStageIndex: 1,
    stages: [{ id: 'workspace', label: 'Workspace', description: '', status: 'success', logs: ['ok'] }],
    activities: [{ id: 'a1', sequence: 1, kind: 'status', message: 'started', createdAt: new Date().toISOString() }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over
  }) as PrototypeRun;

const aSquadRun = (workspaceId = WS, over: Partial<SquadRun> = {}): SquadRun =>
  ({
    id: 'squad-run-1',
    squadId: 'squad-1',
    issueId: `i-${workspaceId}`,
    projectId: `p-${workspaceId}`,
    branchName: 'alpha/fix-cart',
    memberAgentIds: ['agent-architect', 'agent-developer'],
    currentMemberIndex: 0,
    status: 'running',
    mission: 'Fix the cart',
    plan: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over
  }) as SquadRun;

describe.each(backends)('the run store ($name)', backend => {
  it('reads back a run with its stages and activity', async () => {
    const runs = await backend.open();
    await runs.save(WS, aRun(), OWNER);

    const read = await runs.get(WS, 'run-1');
    expect(read).toMatchObject({ id: 'run-1', status: 'running', currentStageIndex: 1 });
    expect(read!.plan).toEqual(['Look at the cart']);
    expect(read!.stages[0]).toMatchObject({ id: 'workspace', status: 'success' });
    expect(read!.activities?.[0]).toMatchObject({ message: 'started' });
  });

  it('updates a run in place rather than adding another', async () => {
    const runs = await backend.open();
    await runs.save(WS, aRun(), OWNER);
    await runs.save(WS, aRun(WS, { status: 'completed', prUrl: 'https://github.com/acme/checkout/pull/3' }), OWNER);

    expect(await runs.list(WS)).toHaveLength(1);
    expect(await runs.get(WS, 'run-1')).toMatchObject({
      status: 'completed',
      prUrl: 'https://github.com/acme/checkout/pull/3'
    });
  });

  /** A run the CLI told us nothing about is not a run of zero tokens. */
  it('keeps missing telemetry missing, and reports what was measured', async () => {
    const runs = await backend.open();
    await runs.save(WS, aRun(), OWNER);
    expect((await runs.get(WS, 'run-1'))!.usage).toBeUndefined();

    await runs.save(WS, aRun(WS, { usage: { inputTokens: 120, outputTokens: 40, costUsd: 0.02 } }), OWNER);
    expect((await runs.get(WS, 'run-1'))!.usage).toMatchObject({
      inputTokens: 120,
      outputTokens: 40,
      costUsd: 0.02
    });
  });

  it('never reaches across workspaces', async () => {
    const runs = await backend.open();
    await runs.save(WS, aRun(WS, { id: 'ours' }), OWNER);
    await runs.save(OTHER_WS, aRun(OTHER_WS, { id: 'theirs' }), 'Someone-else');

    expect((await runs.list(WS)).map(run => run.id)).toEqual(['ours']);
    expect(await runs.get(WS, 'theirs')).toBeNull();
  });

  it('groups a squad run with its members, in the order they work', async () => {
    const runs = await backend.open();
    await runs.saveSquadRun(WS, aSquadRun(), OWNER);
    await runs.save(WS, aRun(WS, { id: 'run-second', squadRunId: 'squad-run-1', squadOrder: 2 }), OWNER);
    await runs.save(WS, aRun(WS, { id: 'run-first', squadRunId: 'squad-run-1', squadOrder: 1 }), OWNER);

    expect(await runs.getSquadRun(WS, 'squad-run-1')).toMatchObject({
      branchName: 'alpha/fix-cart',
      mission: 'Fix the cart'
    });
    expect((await runs.runsForSquadRun(WS, 'squad-run-1')).map(run => run.id)).toEqual(['run-first', 'run-second']);
  });

  it('advances a squad run in place', async () => {
    const runs = await backend.open();
    await runs.saveSquadRun(WS, aSquadRun(), OWNER);
    await runs.saveSquadRun(WS, aSquadRun(WS, { currentMemberIndex: 1, status: 'awaiting_approval' }), OWNER);

    expect(await runs.listSquadRuns(WS)).toHaveLength(1);
    expect(await runs.getSquadRun(WS, 'squad-run-1')).toMatchObject({
      currentMemberIndex: 1,
      status: 'awaiting_approval'
    });
  });

  /** The record of what a run did outside the machine: pushes, PRs, merges. */
  it('keeps a run’s remote history in order', async () => {
    const runs = await backend.open();
    await runs.save(WS, aRun(), OWNER);

    await runs.recordRemoteAction(WS, {
      runId: 'run-1',
      actor: 'agent',
      action: 'push',
      target: 'alpha/fix-cart',
      succeeded: true,
      createdAt: '2026-09-01T10:00:00.000Z'
    });
    await runs.recordRemoteAction(WS, {
      runId: 'run-1',
      actor: 'user',
      action: 'merge_pull_request',
      target: 'https://github.com/acme/checkout/pull/3',
      detail: 'Merged by LloydLim1',
      succeeded: false,
      createdAt: '2026-09-01T11:00:00.000Z'
    });

    const history = await runs.listRemoteActions(WS, 'run-1');
    expect(history.map(action => action.action)).toEqual(['push', 'merge_pull_request']);
    expect(history[1]).toMatchObject({ succeeded: false, detail: 'Merged by LloydLim1' });
  });
});

/**
 * Who a run belongs to, in the shared table.
 *
 * `owner_id` decides who may read it under the policies in `0002`: its owner,
 * and their workspace's overseers. A project manager approving a run must not
 * become its owner.
 */
describe('run ownership in the cloud', () => {
  it('records the owner on the first write and leaves it alone after', async () => {
    const runs = await openPostgres();
    await runs.save(WS, aRun(), OWNER);
    await runs.save(WS, aRun(WS, { status: 'completed' }), 'LloydLim1-the-pm');

    const { rows } = await pg.query<{ owner_id: string; status: string }>(
      'select owner_id, status from prototype_runs'
    );
    expect(rows[0]).toMatchObject({ owner_id: OWNER, status: 'completed' });
  });
});
