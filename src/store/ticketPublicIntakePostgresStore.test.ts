import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';

import { createTicketPublicIntakeService } from '../services/ticketPublicIntakeService.js';
import { PublicTicketIntakeError } from '../ticketing/publicIntake.js';
import { createSupabaseTestDatabase } from './testDatabase.js';
import { fromPool, type Sql, type TransactionalSql } from './database.js';
import { PostgresTicketPublicIntakeStore } from './ticketPublicIntakePostgresStore.js';

const staging = resolve(__dirname, '../../supabase-staging');
const baseline = readFileSync(resolve(staging, 'supabase/migrations/20261007154549_live_control_plane_baseline.sql'), 'utf8');
const ticketSchema = readFileSync(resolve(staging, 'supabase/migrations/20261008061941_client_ticketing_private_store.sql'), 'utf8');
const ticketIndexes = readFileSync(resolve(staging, 'supabase/migrations/20261008063017_client_ticketing_fk_indexes.sql'), 'utf8');
const now = new Date('2026-10-08T08:00:00.000Z');
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
  const pool = {
    query,
    connect: async () => ({ query, release: () => undefined }),
  };
  return fromPool(pool as unknown as Parameters<typeof fromPool>[0]);
}

async function seedEntry(options: {
  workspaceId: string; slug: string; perSourceMax?: number; perEntryMax?: number; entryMode?: string; workspaceMode?: string;
}) {
  const { workspaceId, slug } = options;
  await db.query(
    `insert into public.workspaces (id, name, slug, settings_json)
     values ($1, 'Synthetic test workspace', $2, $3::jsonb)`,
    [workspaceId, workspaceId, JSON.stringify({ ticketing_write_mode: options.workspaceMode ?? 'enabled' })],
  );
  await db.query(
    `insert into alpha_private.ticket_intake_entries
       (id, workspace_id, slug, company_label, published, write_mode, policy_version, per_source_max, per_entry_max, window_seconds)
     values ($1, $2, $3, 'Synthetic service', true, $4, 'policy-v1', $5, $6, 60)`,
    [`entry-${workspaceId}`, workspaceId, slug, options.entryMode ?? 'enabled', options.perSourceMax ?? 20, options.perEntryMax ?? 20],
  );
}

function intakeService(store: PostgresTicketPublicIntakeStore, entryId: string, ticketIds: string[] = ['ticket-public-1']) {
  let next = 0;
  return createTicketPublicIntakeService(store, {
    async resolveVerifiedRequest(proofToken, entry) {
      if (proofToken !== 'provider-proof' || entry.id !== entryId) return null;
      return {
        verificationId: proofToken,
        entryId,
        rateSubjectKey: 'a'.repeat(64),
        issuedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 30_000).toISOString(),
      };
    },
  }, {
    fingerprintKeys: [{ id: 'test-key-v1', secret: new Uint8Array(32).fill(7) }],
    maxProofAgeMs: 60_000,
  }, () => new Date(now), () => ticketIds[next++] ?? `ticket-public-${next}`);
}

function inquiry(operationId: string, title = 'Private intake test') {
  return {
    schemaVersion: 1,
    operationId,
    fullName: 'Private Test Contact',
    email: 'private-test@example.invalid',
    company: 'Private Test Company',
    title,
    description: 'A synthetic inquiry body for a database-only test.',
    requestedDeadline: null,
  };
}

async function counts(workspaceId: string) {
  const { rows } = await db.query<Record<string, number>>(
    `select
       (select count(*)::int from alpha_private.tickets where workspace_id = $1) as tickets,
       (select count(*)::int from alpha_private.ticket_contacts where workspace_id = $1) as contacts,
       (select count(*)::int from alpha_private.ticket_requests where workspace_id = $1) as requests,
       (select count(*)::int from alpha_private.ticket_audit_events where workspace_id = $1) as audits,
       (select count(*)::int from alpha_private.ticket_outbox_events where workspace_id = $1) as outbox,
       (select count(*)::int from alpha_private.ticket_intake_operations where workspace_id = $1) as operations,
       (select count(*)::int from alpha_private.ticket_client_grants where workspace_id = $1) as client_grants,
       (select count(*)::int from public.projects where workspace_id = $1) as projects,
       (select count(*)::int from public.issues where workspace_id = $1) as issues`,
    [workspaceId],
  );
  return rows[0];
}

beforeAll(async () => {
  local = await createSupabaseTestDatabase();
  await local.exec('create role service_role nologin');
  await local.exec('begin');
  try {
    await local.exec(baseline);
    await local.exec(ticketSchema);
    await local.exec(ticketIndexes);
    await local.exec('commit');
  } catch (error) {
    await local.exec('rollback');
    throw error;
  }
  db = transactionalSql(local);
});
afterAll(async () => { await local?.close(); });

describe('PostgresTicketPublicIntakeStore against the reviewed local schema', () => {
  it('creates one generic-acknowledged Received inquiry with private unverified contact and no account/project/Issue', async () => {
    const workspaceId = 'intake-create-ws';
    await seedEntry({ workspaceId, slug: 'synthetic-create' });
    const store = new PostgresTicketPublicIntakeStore(db);
    const service = intakeService(store, `entry-${workspaceId}`);
    const request = { origin: 'https://tickets.example.invalid', remoteAddress: '127.0.0.1' };
    const input = inquiry('00000000-0000-4000-8000-000000000001');

    const receipt = await service.submit('synthetic-create', 'provider-proof', input, request);
    expect(receipt).toEqual({ received: true });
    expect(Object.keys(receipt)).toEqual(['received']);
    expect(await service.submit('synthetic-create', 'provider-proof', input, request)).toEqual({ received: true });
    await expect(service.submit('synthetic-create', 'provider-proof', { ...input, title: 'Different content' }, request))
      .rejects.toMatchObject({ code: 'operation_conflict' });

    expect(await counts(workspaceId)).toEqual({
      tickets: 1, contacts: 1, requests: 1, audits: 1, outbox: 1, operations: 1,
      client_grants: 0, projects: 0, issues: 0,
    });
    const { rows: ticketRows } = await db.query<{
      status: string; client_user_id: string | null; project_id: string | null;
      workflow_state: { status: string; clientId: string | null; projectId: string | null };
    }>(`select status, client_user_id, project_id, workflow_state
        from alpha_private.tickets where workspace_id = $1`, [workspaceId]);
    expect(ticketRows[0]).toMatchObject({
      status: 'received', client_user_id: null, project_id: null,
      workflow_state: { status: 'received', clientId: null, projectId: null },
    });
    const { rows: contactRows } = await db.query<{ email: string; email_verified: boolean }>(
      'select email, email_verified from alpha_private.ticket_contacts where workspace_id = $1', [workspaceId],
    );
    expect(contactRows).toEqual([{ email: 'private-test@example.invalid', email_verified: false }]);
    const { rows: signalRows } = await db.query<{ payload: Record<string, unknown> }>(
      'select payload from alpha_private.ticket_outbox_events where workspace_id = $1', [workspaceId],
    );
    expect(signalRows[0].payload).toEqual({
      source: 'public_inquiry', entryId: `entry-${workspaceId}`, operationId: input.operationId,
    });
    expect(JSON.stringify(signalRows[0].payload)).not.toMatch(/email|company|description|body/i);
  });

  it('charges source and entry budgets atomically, including after a source denial', async () => {
    const workspaceId = 'intake-rate-ws';
    await seedEntry({ workspaceId, slug: 'synthetic-rate', perSourceMax: 2, perEntryMax: 4 });
    const store = new PostgresTicketPublicIntakeStore(db);
    const entry = await store.loadPublishedEntry('synthetic-rate');
    expect(entry).toMatchObject({ id: `entry-${workspaceId}`, mode: 'enabled' });
    const proof = {
      verificationId: 'provider-proof', entryId: `entry-${workspaceId}`,
      rateSubjectKey: 'b'.repeat(64), issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 30_000).toISOString(),
    };

    expect(await store.consumeIntakeAttempt(entry!, proof, now.toISOString())).toEqual({ allowed: true });
    expect(await store.consumeIntakeAttempt(entry!, proof, now.toISOString())).toEqual({ allowed: true });
    const sourceDenied = await store.consumeIntakeAttempt(entry!, proof, now.toISOString());
    expect(sourceDenied.allowed).toBe(false);
    if (!sourceDenied.allowed) expect(sourceDenied.retryAfterSeconds).toBeGreaterThan(0);

    const otherSources = ['c', 'd'].map(letter => ({ ...proof, rateSubjectKey: letter.repeat(64) }));
    expect(await store.consumeIntakeAttempt(entry!, otherSources[0], now.toISOString())).toEqual({ allowed: true });
    expect(await store.consumeIntakeAttempt(entry!, otherSources[1], now.toISOString())).toEqual({ allowed: true });
    const entryDenied = await store.consumeIntakeAttempt(entry!, { ...proof, rateSubjectKey: 'e'.repeat(64) }, now.toISOString());
    expect(entryDenied.allowed).toBe(false);

    const { rows } = await db.query<{ bucket_kind: string; subject_hash: string; attempts: number }>(
      `select bucket_kind, subject_hash, attempts from alpha_private.ticket_intake_rate_buckets
       where workspace_id = $1 and entry_id = $2 order by bucket_kind, subject_hash`,
      [workspaceId, `entry-${workspaceId}`],
    );
    const entryBucket = rows.find(row => row.bucket_kind === 'entry');
    const sourceB = rows.find(row => row.bucket_kind === 'source' && row.subject_hash === proof.rateSubjectKey);
    const sourceE = rows.find(row => row.bucket_kind === 'source' && row.subject_hash === 'e'.repeat(64));
    expect(entryBucket?.attempts).toBe(4);
    expect(sourceB?.attempts).toBe(2);
    expect(sourceE).toBeUndefined();
  });

  it('rolls back ticket, contact, audit, outbox and dedupe together when a write fails after the independent budget commit', async () => {
    const workspaceId = 'intake-rollback-ws';
    await seedEntry({ workspaceId, slug: 'synthetic-rollback' });
    const failingDb: TransactionalSql = {
      query: db.query.bind(db),
      transaction<T>(work: (tx: Sql) => Promise<T>) {
        return db.transaction(tx => work({
          query<R>(text: string, params?: readonly unknown[]) {
            if (text.includes('insert into alpha_private.ticket_outbox_events')) throw new Error('injected test failure');
            return tx.query<R>(text, params);
          },
        }));
      },
    };
    const store = new PostgresTicketPublicIntakeStore(failingDb);
    const service = intakeService(store, `entry-${workspaceId}`);
    await expect(service.submit('synthetic-rollback', 'provider-proof',
      inquiry('00000000-0000-4000-8000-000000000002'),
      { origin: 'https://tickets.example.invalid', remoteAddress: '127.0.0.1' },
    )).rejects.toMatchObject({ code: 'unavailable' });

    expect(await counts(workspaceId)).toEqual({
      tickets: 0, contacts: 0, requests: 0, audits: 0, outbox: 0, operations: 0,
      client_grants: 0, projects: 0, issues: 0,
    });
    const { rows: buckets } = await db.query<{ attempts: number }>(
      'select attempts from alpha_private.ticket_intake_rate_buckets where workspace_id = $1', [workspaceId],
    );
    expect(buckets.reduce((sum, row) => sum + row.attempts, 0)).toBe(2);
  });

  it('fails closed when the workspace write switch is off or changes after the first entry read', async () => {
    const workspaceId = 'intake-disabled-ws';
    await seedEntry({ workspaceId, slug: 'synthetic-disabled' });
    const store = new PostgresTicketPublicIntakeStore(db);
    const entry = await store.loadPublishedEntry('synthetic-disabled');
    expect(entry?.mode).toBe('enabled');
    await db.query(`update public.workspaces set settings_json = '{"ticketing_write_mode":"disabled"}'::jsonb where id = $1`, [workspaceId]);
    await expect(store.consumeIntakeAttempt(entry!, {
      verificationId: 'provider-proof', entryId: `entry-${workspaceId}`,
      rateSubjectKey: 'f'.repeat(64), issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 30_000).toISOString(),
    }, now.toISOString())).rejects.toThrow();
    const service = intakeService(store, `entry-${workspaceId}`);
    await expect(service.submit('synthetic-disabled', 'provider-proof',
      inquiry('00000000-0000-4000-8000-000000000003'),
      { origin: 'https://tickets.example.invalid', remoteAddress: '127.0.0.1' },
    )).rejects.toMatchObject({ code: 'writes_disabled' });
    expect((await counts(workspaceId)).tickets).toBe(0);
    expect((await db.query('select * from alpha_private.ticket_intake_rate_buckets where workspace_id = $1', [workspaceId])).rows).toEqual([]);
    expect((await store.loadPublishedEntry('synthetic-disabled'))?.mode).toBe('disabled');
  });
});
