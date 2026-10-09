import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDatabase, sqlFor } from './testDatabase.js';
import type { TransactionalSql } from './database.js';
import { PostgresTicketTriageStore } from './ticketTriagePostgresStore.js';
import { PostgresTicketPublicIntakeStore } from './ticketPublicIntakePostgresStore.js';
import { PostgresTicketQueueStore } from './ticketQueuePostgresStore.js';
import { PostgresTicketReadStore } from './ticketReadPostgresStore.js';
import { createTicketPublicIntakeService } from '../services/ticketPublicIntakeService.js';
import { createTicketCommandService } from '../services/ticketCommandService.js';
import { createTicketMessageService } from '../services/ticketMessageService.js';
import { createTicketReadService } from '../services/ticketReadService.js';
import { createTicketQueueService } from '../services/ticketQueueService.js';
import type { TicketSubject } from './ticketCommandStore.js';

let pg: PGlite;
let db: TransactionalSql;
const target = { workspaceId: 'triage-workspace', ticketId: 'triage-ticket' };
const pm: TicketSubject = { kind: 'internal', userId: 'triage-pm', authentication: { kind: 'verified_github_bearer', verificationId: 'test-verification' } };
const inquiry = { schemaVersion: 1, operationId: '2e695cb4-b9bf-4dd1-8a81-3d166719c553', fullName: 'Synthetic Contact',
  email: 'synthetic@example.invalid', company: null, title: 'Synthetic inquiry', description: 'Test the durable Phase 2 workflow.', requestedDeadline: null };
const request = { origin: 'https://tickets.example.invalid', remoteAddress: '127.0.0.1' };

function intake() {
  return createTicketPublicIntakeService(new PostgresTicketPublicIntakeStore(db), {
    async resolveVerifiedRequest(token, entry) {
      const instant = new Date();
      return { verificationId: token, entryId: entry.id, rateSubjectKey: 'a'.repeat(64),
        issuedAt: instant.toISOString(), expiresAt: new Date(instant.getTime() + 60000).toISOString() };
    },
  }, { fingerprintKeys: [{ id: 'test', secret: new Uint8Array(32).fill(7) }], maxProofAgeMs: 60000 }, undefined, () => target.ticketId);
}
const command = (operationId: string, expectedVersion: number, decision: object) => ({ schemaVersion: 1, operationId, expectedVersion, command: decision });
const commands = () => createTicketCommandService(new PostgresTicketTriageStore(db));
const messages = () => createTicketMessageService(new PostgresTicketTriageStore(db));

beforeAll(async () => {
  pg = await createTestDatabase();
  const sql = sqlFor(pg);
  db = { ...sql, transaction: work => pg.transaction(async tx => work(sqlFor(tx as unknown as PGlite))) };
  await db.query(`insert into public.workspaces(id,name,slug,settings_json) values
    ('triage-workspace','Synthetic','triage-workspace','{"ticketing_write_mode":"enabled"}'),
    ('foreign-triage','Foreign','foreign-triage','{"ticketing_write_mode":"enabled"}')`);
  await db.query(`insert into public.workspace_members(id,workspace_id,user_id,role) values
    ('triage-pm-member','triage-workspace','triage-pm','pm'),
    ('triage-dev-member','triage-workspace','triage-dev','dev'),
    ('foreign-pm-member','foreign-triage','triage-pm','pm')`);
  await db.query(`insert into alpha_private.ticket_intake_entries
    (id,workspace_id,slug,company_label,published,write_mode,policy_version,per_source_max,per_entry_max,window_seconds)
    values ('triage-entry','triage-workspace','triage-entry','Synthetic',true,'enabled','v1',100,100,60)`);
}, 60000);
afterAll(async () => { await pg?.close(); });

describe('Phase 2 durable inquiry and PM triage', () => {
  it('persists inquiry once across new service instances and retries; rejects changed payload', async () => {
    expect(await intake().submit('triage-entry', 'proof', inquiry, request)).toEqual({ received: true });
    expect(await intake().submit('triage-entry', 'fresh-proof', inquiry, request)).toEqual({ received: true });
    expect((await db.query<{ count: number }>('select count(*)::int as count from alpha_private.tickets')).rows[0].count).toBe(1);
    await expect(intake().submit('triage-entry', 'fresh-proof', { ...inquiry, title: 'Changed' }, request)).rejects.toMatchObject({ code: 'operation_conflict' });
    const queue = await createTicketQueueService(new PostgresTicketQueueStore(db)).list(target.workspaceId, pm);
    expect(queue.items[0].id).toBe(target.ticketId);
    expect(queue.items[0].status).toBe('received');
  });
  it('denies developers, foreign workspace and absent client authority', async () => {
    const input = command('forbidden', 0, { type: 'review' });
    await expect(commands().execute(target, { ...pm, userId: 'triage-dev' }, input)).rejects.toMatchObject({ status: 404 });
    await expect(commands().execute({ ...target, workspaceId: 'foreign-triage' }, pm, input)).rejects.toMatchObject({ status: 404 });
    await expect(commands().execute(target, { kind: 'client', userId: 'fake', sessionId: 'fake' }, input)).rejects.toMatchObject({ status: 404 });
  });
  it('saves review atomically and returns original receipt on retry/recovery', async () => {
    const input = command('review-once', 0, { type: 'review' });
    const result = await commands().execute(target, pm, input);
    expect(result).toMatchObject({ version: 1, status: 'under_review' });
    expect(await commands().execute(target, pm, input)).toEqual(result);
    expect(await commands().lookup(target, pm, 'review-once')).toEqual(result);
    await expect(commands().execute(target, pm, command('review-once', 1, { type: 'decline', reason: 'Changed operation' }))).rejects.toMatchObject({ code: 'ticket_operation_conflict' });
  });
  it('keeps notes private and durable without workflow/public clock or outbox changes', async () => {
    const before = (await db.query('select client_updated_at,version from alpha_private.tickets')).rows[0];
    const input = { schemaVersion: 1, operationId: 'private-note', expectedVersion: 1, body: 'Synthetic private triage note.' };
    const receipt = await messages().note(target, pm, input);
    expect(await messages().note(target, pm, input)).toEqual(receipt);
    const reads = createTicketReadService(new PostgresTicketReadStore(db));
    expect((await reads.notes(target, pm)).items).toHaveLength(1);
    expect((await reads.conversation(target, pm)).items).toEqual([]);
    expect((await db.query('select client_updated_at,version from alpha_private.tickets')).rows[0]).toEqual(before);
    expect((await db.query<{ count: number }>('select count(*)::int as count from alpha_private.ticket_outbox_events')).rows[0].count).toBe(2);
  });
  it('rejects stale versions, missing decline reasons and future commands without mutation', async () => {
    await expect(commands().execute(target, pm, command('stale', 0, { type: 'decline', reason: 'Reason' }))).rejects.toMatchObject({ code: 'ticket_version_conflict' });
    await expect(commands().execute(target, pm, command('empty', 1, { type: 'decline', reason: ' ' }))).rejects.toMatchObject({ code: 'invalid_ticket_command' });
    await expect(commands().execute(target, pm, command('future', 1, { type: 'hold', reason: 'Not this phase' }))).rejects.toMatchObject({ status: 503 });
    expect((await db.query('select status from alpha_private.tickets')).rows[0].status).toBe('under_review');
  });
  it('rolls back all writes if receipt persistence fails', async () => {
    const broken: TransactionalSql = { ...db, transaction: work => db.transaction(sql => work({
      query: (text, params) => { if (/insert into alpha_private.ticket_operation_receipts/.test(text)) throw new Error('Synthetic failure'); return sql.query(text, params); },
    })) };
    await expect(createTicketMessageService(new PostgresTicketTriageStore(broken)).note(target, pm,
      { schemaVersion: 1, operationId: 'rollback-note', expectedVersion: 1, body: 'Must roll back.' })).rejects.toThrow('Synthetic failure');
    expect((await createTicketReadService(new PostgresTicketReadStore(db)).notes(target, pm)).items).toHaveLength(1);
  });
  it('declines with an immutable internal reason and preserves history; terminal replay is safe', async () => {
    const input = command('decline-once', 1, { type: 'decline', reason: 'Synthetic scope is outside service.' });
    const result = await commands().execute(target, pm, input);
    expect(result).toMatchObject({ status: 'declined', version: 2 });
    expect(await commands().execute(target, pm, input)).toEqual(result);
    const reads = createTicketReadService(new PostgresTicketReadStore(db));
    expect((await reads.notes(target, pm)).items.map(note => note.body)).toContain('Declined: Synthetic scope is outside service.');
    expect((await reads.conversation(target, pm)).items).toEqual([]);
    await expect(messages().note(target, pm, { schemaVersion: 1, operationId: 'late', expectedVersion: 2, body: 'Late note' })).rejects.toMatchObject({ code: 'ticket_is_read_only' });
  });
  it('denies receipt recovery after PM access is removed', async () => {
    await db.query("update public.workspace_members set status='inactive' where id='triage-pm-member'");
    await expect(commands().lookup(target, pm, 'decline-once')).rejects.toMatchObject({ status: 404 });
  });
});
