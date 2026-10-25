import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createTicketCentralIntakeService } from '../services/ticketCentralIntakeService.js';
import { TicketWorkflowError } from '../ticketing/workflow.js';
import type { TicketSubject } from './ticketCommandStore.js';
import { sqlFor, createTestDatabase } from './testDatabase.js';
import type { TransactionalSql } from './database.js';
import { PostgresTicketCentralIntakeStore } from './ticketCentralIntakePostgresStore.js';
import { PostgresTicketAcknowledgmentStore } from './ticketAcknowledgmentPostgresStore.js';
import { createTicketAcknowledgmentDeliveryService } from '../services/ticketAcknowledgmentDeliveryService.js';

const organizationKey = 'central-intake-test-org';
const workspaceA = 'central-intake-workspace-a';
const workspaceB = 'central-intake-workspace-b';
const submittedAt = new Date('2026-10-16T08:00:00.000Z');
const operationId = '00000000-0000-4000-8000-000000000001';
const pmA: TicketSubject = { kind: 'internal', userId: 'central-pm-a',
  authentication: { kind: 'verified_github_bearer', verificationId: 'central-test-a' } };
const pmB: TicketSubject = { kind: 'internal', userId: 'central-pm-b',
  authentication: { kind: 'verified_github_bearer', verificationId: 'central-test-b' } };
const developer: TicketSubject = { kind: 'internal', userId: 'central-dev',
  authentication: { kind: 'verified_github_bearer', verificationId: 'central-test-dev' } };
const inquiry = {
  schemaVersion: 1, operationId, fullName: 'Central Intake Client', email: 'person@example.test', company: 'Example Co',
  title: 'Review the new workflow', description: 'Please review this request before it becomes a workspace ticket.',
  requestedDeadline: '2026-11-01',
};

let pg: PGlite;
let db: TransactionalSql;
let app: ReturnType<typeof createTicketCentralIntakeService>;
let ids: number;

async function seedWorkspace(id: string) {
  await db.query(`insert into public.workspaces(id,name,slug,status,settings_json)
    values ($1,$2,$1,'active','{"ticketing_write_mode":"enabled"}')`, [id, id === workspaceA ? 'Workspace A' : 'Workspace B']);
}

beforeEach(async () => {
  pg = await createTestDatabase();
  const sql = sqlFor(pg);
  db = { ...sql, transaction: work => pg.transaction(tx => work(sqlFor(tx as unknown as PGlite))) };
  ids = 0;
  await seedWorkspace(workspaceA);
  await seedWorkspace(workspaceB);
  await db.query(`insert into public.workspace_members(id,workspace_id,user_id,role,status) values
    ('central-member-a',$1,'central-pm-a','pm','active'),
    ('central-member-b',$2,'central-pm-b','pm','active'),
    ('central-member-dev',$1,'central-dev','dev','active')`, [workspaceA, workspaceB]);
  const store = new PostgresTicketCentralIntakeStore(db);
  app = createTicketCentralIntakeService({
    store,
    organizationKey,
    guard: { async admitRequest(entry, request) {
      if (entry.id !== organizationKey || request.origin !== 'https://alpha.example.test'
        || request.remoteAddress !== '192.0.2.10') return null;
      return { entryId: organizationKey, rateSubjectKey: 'a'.repeat(64),
        issuedAt: submittedAt.toISOString(), expiresAt: new Date(submittedAt.getTime() + 60_000).toISOString() };
    } },
    fingerprintKeys: [{ id: 'test-fingerprint-v1', secret: new Uint8Array(32).fill(9) }],
    maxRequestAgeMs: 300_000,
    now: () => submittedAt,
    nextId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
  });
});

afterEach(async () => { await pg?.close(); });

describe('central PM inquiry intake on PostgreSQL', () => {
  it('paginates accepted and declined history and keeps it PM-only and private', async () => {
    const request = { origin: 'https://alpha.example.test', remoteAddress: '192.0.2.10' };
    await app.submit(inquiry, request);
    await app.submit({ ...inquiry, operationId: '00000000-0000-4000-8000-000000000008', title: 'Another inquiry' }, request);
    const pending = await app.listPending(workspaceA, pmA, {});
    await app.accept(pending.items[0].id, workspaceA, pmA, { schemaVersion: 1, operationId: '00000000-0000-4000-8000-000000000009' });
    await app.decline(pending.items[1].id, workspaceA, pmA, { schemaVersion: 1, operationId: '00000000-0000-4000-8000-000000000010', reason: 'PRIVATE_INTERNAL_REASON' });
    const first = await app.listPending(workspaceA, pmA, { filter: 'handled', limit: 1 });
    expect(first.items).toHaveLength(1); expect(first.nextCursor).not.toBeNull();
    const second = await app.listPending(workspaceA, pmA, { filter: 'handled', limit: 1, after: first.nextCursor });
    expect(second.items).toHaveLength(1); expect(second.nextCursor).toBeNull();
    expect(first.items[0].id).not.toBe(second.items[0].id);
    expect(new Set([first.items[0].status, second.items[0].status])).toEqual(new Set(['accepted', 'declined']));
    expect(JSON.stringify([first, second])).not.toContain('PRIVATE_INTERNAL_REASON');
    await expect(app.listPending(workspaceA, developer, { filter: 'handled' })).rejects.toMatchObject({ status: 403 });
    const security = await db.query<{ relrowsecurity: boolean; anon_read: boolean }>(`select c.relrowsecurity,
      has_table_privilege('anon','alpha_private.ticket_central_intake_outcomes','select') as anon_read
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='alpha_private' and c.relname='ticket_central_intake_outcomes'`);
    expect(security.rows[0]).toEqual({ relrowsecurity: true, anon_read: false });
  });
  it('stores a pre-ticket inquiry centrally and creates a workspace ticket only after PM acceptance', async () => {
    const request = { origin: 'https://alpha.example.test', remoteAddress: '192.0.2.10' };
    await expect(app.submit(inquiry, request)).resolves.toMatchObject({ received: true, publicReference: expect.stringMatching(/^INQ-[A-F0-9]{32}$/) });
    const receipt = await app.submit(inquiry, request);
    expect(receipt).toMatchObject({ received: true, publicReference: expect.stringMatching(/^INQ-[A-F0-9]{32}$/) });
    await expect(app.submit({ ...inquiry, title: 'Changed body' }, request))
      .rejects.toMatchObject({ code: 'operation_conflict' });
    expect((await db.query('select id from alpha_private.tickets')).rows).toEqual([]);
    expect((await db.query("select id from alpha_private.ticket_central_intakes where status='pending'")).rows).toHaveLength(1);

    await expect(app.listPending(workspaceA, developer, {})).rejects.toMatchObject({ status: 403 });
    const page = await app.listPending(workspaceA, pmA, {});
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ fullName: inquiry.fullName, email: inquiry.email, title: inquiry.title });

    const acceptanceOperationId = '00000000-0000-4000-8000-000000000002';
    const accepted = await app.accept(page.items[0].id, workspaceA, pmA,
      { schemaVersion: 1, operationId: acceptanceOperationId });
    expect(accepted).toMatchObject({ workspaceId: workspaceA, operationId: acceptanceOperationId, reference: expect.stringMatching(/^TKT-[A-F0-9]{32}$/) });
    await expect(app.accept(page.items[0].id, workspaceA, pmA,
      { schemaVersion: 1, operationId: acceptanceOperationId })).resolves.toEqual(accepted);
    await expect(app.accept(page.items[0].id, workspaceB, pmB,
      { schemaVersion: 1, operationId: '00000000-0000-4000-8000-000000000003' }))
      .rejects.toMatchObject({ status: 409 });
    await expect(app.listPending(workspaceA, pmA, {})).resolves.toMatchObject({ items: [], nextCursor: null });

    const { rows: ticketRows } = await db.query<Record<string, unknown>>(
      `select workspace_id,source,status,client_user_id,contact_id,project_id
         from alpha_private.tickets where id=$1`, [accepted.ticketId]);
    expect(ticketRows).toHaveLength(1);
    expect(ticketRows[0]).toMatchObject({ workspace_id: workspaceA, source: 'public_inquiry', status: 'received',
      client_user_id: null, project_id: null });
    const { rows: contactRows } = await db.query<Record<string, unknown>>(
      `select email,email_verified from alpha_private.ticket_contacts where id=$1`, [ticketRows[0].contact_id]);
    expect(contactRows).toEqual([{ email: inquiry.email, email_verified: false }]);
    const { rows: requestRows } = await db.query<Record<string, unknown>>(
      `select requested_deadline,project_preference,preferred_project_id from alpha_private.ticket_requests where ticket_id=$1`, [accepted.ticketId]);
    expect(requestRows).toEqual([{ requested_deadline: inquiry.requestedDeadline, project_preference: 'not_sure', preferred_project_id: null }]);
    expect((await db.query('select * from alpha_private.ticket_client_grants where ticket_id=$1', [accepted.ticketId])).rows).toEqual([]);
    expect((await db.query('select * from public.projects where workspace_id=$1', [workspaceA])).rows).toEqual([]);
    expect((await db.query('select * from public.issues where workspace_id=$1', [workspaceA])).rows).toEqual([]);
    expect((await db.query('select event_type from alpha_private.ticket_central_intake_events where intake_id=$1 order by event_type', [page.items[0].id])).rows)
      .toEqual([{ event_type: 'inquiry_accepted' }, { event_type: 'inquiry_received' }]);
    expect((await db.query('select actor_kind,event_type from alpha_private.ticket_audit_events where ticket_id=$1 order by event_type', [accepted.ticketId])).rows)
      .toEqual([{ actor_kind: 'pm', event_type: 'inquiry_accepted' }, { actor_kind: 'anonymous', event_type: 'inquiry_received' }]);
  });

  it('does not let a PM without active membership in the selected workspace accept into it', async () => {
    await app.submit(inquiry, { origin: 'https://alpha.example.test', remoteAddress: '192.0.2.10' });
    const page = await app.listPending(workspaceA, pmA, {});
    await expect(app.accept(page.items[0].id, workspaceB, pmA,
      { schemaVersion: 1, operationId: '00000000-0000-4000-8000-000000000004' }))
      .rejects.toBeInstanceOf(TicketWorkflowError);
  });

  it('queues a receipt email with the stable central inquiry reference, without creating a ticket', async () => {
    const receipt = await app.submit(inquiry, { origin: 'https://alpha.example.test', remoteAddress: '192.0.2.10' });
    let sent: unknown[] = [];
    const acknowledgments = new PostgresTicketAcknowledgmentStore(db);
    const delivery = createTicketAcknowledgmentDeliveryService(acknowledgments, {
      identity: 'central-receipt-provider',
      async send(...args: [string, string, string?]) { sent = args; },
    });
    expect(await delivery.deliverNext()).toBe(true);
    expect(sent).toEqual([inquiry.email, inquiry.operationId, receipt.publicReference]);
    expect((await db.query<{ status: string }>(
      'select status from alpha_private.ticket_central_intake_acknowledgments')).rows).toEqual([{ status: 'delivered' }]);
    expect((await db.query('select id from alpha_private.tickets')).rows).toEqual([]);
  });

  it('retains a PM decline and optional note without making a ticket or granting access', async () => {
    await app.submit(inquiry, { origin: 'https://alpha.example.test', remoteAddress: '192.0.2.10' });
    const page = await app.listPending(workspaceA, pmA, {});
    const declineOperationId = '00000000-0000-4000-8000-000000000005';
    const declineInput = {
      schemaVersion: 1, operationId: declineOperationId, reason: 'Outside our current service scope.',
    };
    const declineReceipt = { intakeId: page.items[0].id, operationId: declineOperationId, status: 'declined' };
    await expect(app.decline(page.items[0].id, workspaceA, pmA, declineInput)).resolves.toEqual(declineReceipt);
    await expect(app.decline(page.items[0].id, workspaceA, pmA, declineInput)).resolves.toEqual(declineReceipt);
    await expect(app.decline(page.items[0].id, workspaceA, pmA, {
      ...declineInput, reason: 'A different internal note.',
    })).rejects.toMatchObject({ status: 409 });
    await expect(app.accept(page.items[0].id, workspaceA, pmA, {
      schemaVersion: 1, operationId: '00000000-0000-4000-8000-000000000006',
    })).rejects.toMatchObject({ status: 409 });
    expect((await app.listPending(workspaceA, pmA, {})).items).toEqual([]);
    const handled = await app.listPending(workspaceA, pmA, { filter: 'handled' });
    expect(handled.items[0]).toMatchObject({ id: page.items[0].id, status: 'declined', handledAt: submittedAt.toISOString(), outcomeEmailStatus: 'pending' });
    expect(JSON.stringify(handled)).not.toContain(declineInput.reason);
    await expect(app.listPending(workspaceA, developer, { filter: 'handled' })).rejects.toMatchObject({ status: 403 });
    await expect(app.listPending(workspaceA, pmA, { filter: 'invalid' })).rejects.toMatchObject({ status: 400 });
    expect((await db.query('select * from alpha_private.ticket_central_intake_outcomes')).rows).toHaveLength(1);
    const sends: unknown[][] = [];
    const delivery = createTicketAcknowledgmentDeliveryService(new PostgresTicketAcknowledgmentStore(db, true), {
      identity: 'test-outcome-provider', async send(...args) { sends.push(args); },
    });
    expect(await delivery.deliverNext()).toBe(true);
    expect(await delivery.deliverNext()).toBe(false);
    expect(sends).toEqual([[inquiry.email, expect.any(String), page.items[0].publicReference, 'declined']]);
    expect(JSON.stringify(sends)).not.toContain(declineInput.reason);
    expect((await app.listPending(workspaceA, pmA, { filter: 'handled' })).items[0].outcomeEmailStatus).toBe('delivered');
    expect((await db.query<{ status: string; decline_reason: string }>(
      'select status,decline_reason from alpha_private.ticket_central_intakes where id=$1', [page.items[0].id])).rows)
      .toEqual([{ status: 'declined', decline_reason: 'Outside our current service scope.' }]);
    expect((await db.query('select id from alpha_private.tickets')).rows).toEqual([]);
    expect((await db.query('select * from alpha_private.ticket_client_grants')).rows).toEqual([]);
  });
});
