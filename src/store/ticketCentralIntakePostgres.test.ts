import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createTicketCentralIntakeService } from '../services/ticketCentralIntakeService.js';
import { TicketWorkflowError } from '../ticketing/workflow.js';
import type { TicketSubject } from './ticketCommandStore.js';
import { sqlFor, createTestDatabase } from './testDatabase.js';
import type { TransactionalSql } from './database.js';
import { PostgresTicketCentralIntakeStore } from './ticketCentralIntakePostgresStore.js';

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
  it('stores a pre-ticket inquiry centrally and creates a workspace ticket only after PM acceptance', async () => {
    const request = { origin: 'https://alpha.example.test', remoteAddress: '192.0.2.10' };
    await expect(app.submit(inquiry, request)).resolves.toEqual({ received: true });
    await expect(app.submit(inquiry, request)).resolves.toEqual({ received: true });
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
});
