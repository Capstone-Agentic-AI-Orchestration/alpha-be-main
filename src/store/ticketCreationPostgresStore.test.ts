import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';

import { createTicketCreationService } from '../services/ticketCreationService.js';
import { createTicketReadService } from '../services/ticketReadService.js';
import { createSupabaseTestDatabase } from './testDatabase.js';
import { fromPool, type Sql, type TransactionalSql } from './database.js';
import { PostgresTicketCreationStore, ticketClientProjectOptionId } from './ticketCreationPostgresStore.js';
import { PostgresTicketReadStore } from './ticketReadPostgresStore.js';
import type { TicketSubject } from './ticketCommandStore.js';

const staging = resolve(__dirname, '../../supabase-staging');
const baseline = readFileSync(resolve(staging, 'supabase/migrations/20261007154549_live_control_plane_baseline.sql'), 'utf8');
const ticketSchema = readFileSync(resolve(staging, 'supabase/migrations/20261008061941_client_ticketing_private_store.sql'), 'utf8');
const ticketIndexes = readFileSync(resolve(staging, 'supabase/migrations/20261008063017_client_ticketing_fk_indexes.sql'), 'utf8');
let local: PGlite;
let db: TransactionalSql;

function transactionalSql(database: PGlite): TransactionalSql {
  const query = async (text: string, params: unknown[] = []) => {
    const command = text.trim().toUpperCase();
    if (command === 'BEGIN' || command === 'COMMIT' || command === 'ROLLBACK') {
      await database.exec(command);
      return { rows: [], command };
    }
    const result = await database.query(text, params);
    return { rows: result.rows, command: command.split(/\s+/, 1)[0] };
  };
  const pool = { query, connect: async () => ({ query, release: () => undefined }) };
  return fromPool(pool as unknown as Parameters<typeof fromPool>[0]);
}

function makeClient(workspaceId: string) {
  const sessionId = createHash('sha256').update(`session:${workspaceId}`).digest('hex');
  const csrfHash = createHash('sha256').update(`csrf:${workspaceId}`).digest('hex');
  const client: Extract<TicketSubject, { kind: 'client' }> = { kind: 'client', userId: `client:${workspaceId}`, sessionId };
  return { client, sessionId, csrfHash, contextId: `grant:${workspaceId}` };
}

async function seedClient(workspaceId: string, options: {
  workspaceMode?: string; grantMode?: string; acceptsNewRequests?: boolean; project?: boolean;
} = {}) {
  const { client, sessionId, csrfHash, contextId } = makeClient(workspaceId);
  const created = new Date(Date.now() - 60_000).toISOString();
  const expires = new Date(Date.now() + 3_600_000).toISOString();
  await db.query(
    `insert into public.workspaces (id, name, slug, settings_json)
     values ($1, 'Synthetic ticket workspace', $1, $2::jsonb)`,
    [workspaceId, JSON.stringify({ ticketing_write_mode: options.workspaceMode ?? 'enabled' })],
  );
  await db.query(
    `insert into alpha_private.ticket_service_grants
       (id, workspace_id, client_user_id, status, display_name, accepts_new_requests, write_mode)
     values ($1, $2, $3, 'active', 'Synthetic Client', $4, $5)`,
    [contextId, workspaceId, client.userId, options.acceptsNewRequests ?? true, options.grantMode ?? 'enabled'],
  );
  await db.query(
    `insert into alpha_private.ticket_client_sessions
       (session_id_hash, client_user_id, csrf_hash, created_at, expires_at)
     values ($1, $2, $3, $4, $5)`,
    [sessionId, client.userId, csrfHash, created, expires],
  );
  if (options.project) {
    await db.query(
      `insert into public.projects (id, workspace_id, name, key)
       values ($1, $2, 'Internal project name', $3)`,
      [`internal-project:${workspaceId}`, workspaceId, `P-${workspaceId}`],
    );
    await db.query(
      `insert into alpha_private.ticket_client_project_access
         (workspace_id, client_user_id, project_id, display_name, active, client_visible)
       values ($1, $2, $3, 'Client-safe project name', true, true)`,
      [workspaceId, client.userId, `internal-project:${workspaceId}`],
    );
  }
  return { client, contextId, projectId: `internal-project:${workspaceId}` };
}

function createService(store: PostgresTicketCreationStore) {
  let id = 0;
  return createTicketCreationService(store, () => new Date(), () => `ticket-pg-${++id}`);
}

function createInput(operationId: string, override: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1, operationId, title: 'A client request', description: 'A synthetic request for adapter verification.',
    ...override,
  };
}

beforeAll(async () => {
  local = await createSupabaseTestDatabase();
  await local.exec('begin');
  try {
    await local.exec(baseline);
    await local.exec(ticketSchema);
    await local.exec(ticketIndexes);
    // This preserved test snapshot predates the client_user_id column
    // name; align its ephemeral PGlite schema with the deployed live migration.
    await local.exec(`ALTER TABLE alpha_private.ticket_client_sessions
      RENAME COLUMN provider_user_id TO client_user_id`);
    await local.exec('commit');
  } catch (error) {
    await local.exec('rollback');
    throw error;
  }
  db = transactionalSql(local);
});
afterAll(async () => { await local?.close(); });

describe('PostgresTicketCreationStore against the reviewed local schema', () => {
  it('creates one authorized Received ticket and keeps the project choice as a private preference', async () => {
    const workspaceId = 'create-pg-workspace';
    const { client, contextId, projectId } = await seedClient(workspaceId, { project: true });
    const store = new PostgresTicketCreationStore(db);
    const service = createService(store);
    const optionId = ticketClientProjectOptionId(workspaceId, client.userId, projectId);
    const request = createInput('create-pg-op', {
      projectPreference: { kind: 'shared_project', optionId }, requestedDeadline: '2027-02-28',
    });

    const receipt = await service.create(contextId, client, request);
    expect(receipt).toMatchObject({ ticketId: 'ticket-pg-1', operationId: 'create-pg-op', version: 0, status: 'received' });
    expect(receipt.reference).toMatch(/^TKT-[A-F0-9]{32}$/);
    expect(await service.create(contextId, client, request)).toEqual(receipt);
    expect(await service.lookup(contextId, client, 'create-pg-op')).toEqual(receipt);

    const { rows: ticketRows } = await db.query<{
      client_user_id: string; project_id: string | null; status: string; workflow_state: Record<string, unknown>;
    }>(`select client_user_id, project_id, status, workflow_state from alpha_private.tickets where workspace_id = $1`, [workspaceId]);
    expect(ticketRows).toEqual([{
      client_user_id: client.userId, project_id: null, status: 'received',
      workflow_state: expect.objectContaining({ clientId: client.userId, projectId: null, status: 'received' }),
    }]);

    const { rows: privateRequest } = await db.query<Record<string, unknown>>(
      `select source, intake_context_id, project_preference, preferred_project_id, requested_project_label, requested_deadline
       from alpha_private.ticket_requests where workspace_id = $1`, [workspaceId],
    );
    expect(privateRequest).toEqual([{
      source: 'authenticated_client', intake_context_id: contextId, project_preference: 'shared_project',
      preferred_project_id: projectId, requested_project_label: 'Client-safe project name', requested_deadline: '2027-02-28',
    }]);

    const { rows: counts } = await db.query<Record<string, number>>(
      `select
         (select count(*)::int from alpha_private.ticket_client_grants where workspace_id = $1) as grants,
         (select count(*)::int from alpha_private.ticket_creation_operations where workspace_id = $1) as create_operations,
         (select count(*)::int from alpha_private.ticket_operation_receipts where workspace_id = $1) as generic_operations,
         (select count(*)::int from alpha_private.ticket_audit_events where workspace_id = $1) as audits,
         (select count(*)::int from alpha_private.ticket_outbox_events where workspace_id = $1) as signals,
         (select count(*)::int from public.projects where workspace_id = $1) as projects,
         (select count(*)::int from public.issues where workspace_id = $1) as issues`, [workspaceId],
    );
    expect(counts[0]).toEqual({ grants: 1, create_operations: 1, generic_operations: 0, audits: 1, signals: 1, projects: 1, issues: 0 });

    const read = createTicketReadService(new PostgresTicketReadStore(db));
    const detail = await read.detail({ workspaceId, ticketId: receipt.ticketId }, client);
    expect(detail).toMatchObject({ status: 'received', request: {
      projectPreference: 'shared_project', projectLabel: 'Client-safe project name', requestedDeadline: '2027-02-28',
    } });
    expect(JSON.stringify(detail)).not.toContain(projectId);

    const { rows: effects } = await db.query<{ event_type: string; payload: Record<string, unknown> }>(
      `select event_type, payload from alpha_private.ticket_outbox_events where workspace_id = $1`, [workspaceId],
    );
    expect(effects[0]).toEqual({ event_type: 'ticket_created', payload: { source: 'authenticated_client', operationId: 'create-pg-op' } });
    expect(JSON.stringify(effects)).not.toMatch(/email|description|A client request|projectId/i);
  });

  it('refuses an inactive identity, revoked grant, or a disabled workspace without writing', async () => {
    const workspaceId = 'create-pg-auth-workspace';
    const { client, contextId } = await seedClient(workspaceId);
    const service = createService(new PostgresTicketCreationStore(db));
    const request = createInput('auth-op');
    await db.query(`update alpha_private.ticket_client_sessions set revoked_at = now() where session_id_hash = $1`, [client.sessionId]);
    await expect(service.create(contextId, client, request)).rejects.toMatchObject({ status: 404 });
    await db.query(`update alpha_private.ticket_client_sessions set revoked_at = null where session_id_hash = $1`, [client.sessionId]);
    await db.query(`update alpha_private.ticket_service_grants set status = 'revoked' where id = $1`, [contextId]);
    await expect(service.create(contextId, client, request)).rejects.toMatchObject({ status: 404 });

    const disabledId = 'create-pg-disabled-workspace';
    const disabled = await seedClient(disabledId, { workspaceMode: 'disabled' });
    await expect(service.create(disabled.contextId, disabled.client, createInput('disabled-op')))
      .rejects.toMatchObject({ code: 'ticket_writes_disabled' });
    const { rows } = await db.query<{ count: number }>(
      `select count(*)::int as count from alpha_private.tickets where workspace_id in ($1, $2)`, [workspaceId, disabledId],
    );
    expect(rows[0].count).toBe(0);
  });

  it('retains authorized recovery when writes are later disabled', async () => {
    const workspaceId = 'create-pg-recovery-workspace';
    const { client, contextId } = await seedClient(workspaceId);
    const service = createService(new PostgresTicketCreationStore(db));
    const request = createInput('recovery-op');
    const receipt = await service.create(contextId, client, request);
    await db.query(`update public.workspaces set settings_json = '{"ticketing_write_mode":"disabled"}'::jsonb where id = $1`, [workspaceId]);
    await expect(service.create(contextId, client, request)).rejects.toMatchObject({ code: 'ticket_writes_disabled' });
    expect(await service.lookup(contextId, client, 'recovery-op')).toEqual(receipt);
  });

  it('rolls back the ticket, grant, request, audit, signal and operation if the final write fails', async () => {
    const workspaceId = 'create-pg-rollback-workspace';
    const { client, contextId } = await seedClient(workspaceId);
    const failingDb: TransactionalSql = {
      query: db.query.bind(db),
      transaction<T>(work: (tx: Sql) => Promise<T>) {
        return db.transaction(tx => work({
          query<R>(text: string, params?: readonly unknown[]) {
            if (text.includes('insert into alpha_private.ticket_creation_operations')) throw new Error('injected create-operation failure');
            return tx.query<R>(text, params);
          },
        }));
      },
    };
    const service = createService(new PostgresTicketCreationStore(failingDb));
    await expect(service.create(contextId, client, createInput('rollback-op'))).rejects.toThrow('injected create-operation failure');
    const { rows } = await db.query<Record<string, number>>(
      `select
         (select count(*)::int from alpha_private.tickets where workspace_id = $1) as tickets,
         (select count(*)::int from alpha_private.ticket_requests where workspace_id = $1) as requests,
         (select count(*)::int from alpha_private.ticket_client_grants where workspace_id = $1) as grants,
         (select count(*)::int from alpha_private.ticket_creation_operations where workspace_id = $1) as operations,
         (select count(*)::int from alpha_private.ticket_audit_events where workspace_id = $1) as audits,
         (select count(*)::int from alpha_private.ticket_outbox_events where workspace_id = $1) as signals`, [workspaceId],
    );
    expect(rows[0]).toEqual({ tickets: 0, requests: 0, grants: 0, operations: 0, audits: 0, signals: 0 });
  });

  it('only resolves a project preference from an active client-visible same-workspace option', async () => {
    const workspaceId = 'create-pg-option-workspace';
    const { client, contextId, projectId } = await seedClient(workspaceId, { project: true });
    await db.query(
      `update alpha_private.ticket_client_project_access set client_visible = false
       where workspace_id = $1 and project_id = $2`, [workspaceId, projectId],
    );
    const service = createService(new PostgresTicketCreationStore(db));
    const optionId = ticketClientProjectOptionId(workspaceId, client.userId, projectId);
    await expect(service.create(contextId, client, createInput('hidden-option', {
      projectPreference: { kind: 'shared_project', optionId },
    }))).rejects.toMatchObject({ status: 404 });
    const { rows } = await db.query<{ count: number }>(
      `select count(*)::int as count from alpha_private.tickets where workspace_id = $1`, [workspaceId],
    );
    expect(rows[0].count).toBe(0);
  });
});
