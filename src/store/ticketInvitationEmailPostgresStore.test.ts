import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';

import { createTicketPublicIntakeService } from '../services/ticketPublicIntakeService.js';
import { createTicketCommandService } from '../services/ticketCommandService.js';
import { createTicketInvitationEmailDeliveryService } from '../services/ticketInvitationEmailDeliveryService.js';
import { TicketInvitationEmailError } from '../services/ticketInvitationEmailProvider.js';
import { PostgresTicketPublicIntakeStore } from './ticketPublicIntakePostgresStore.js';
import { PostgresTicketTriageStore } from './ticketTriagePostgresStore.js';
import { PostgresTicketInvitationEmailStore } from './ticketInvitationEmailPostgresStore.js';
import { createTestDatabase, sqlFor } from './testDatabase.js';
import type { TransactionalSql } from './database.js';
import type { TicketSubject } from './ticketCommandStore.js';

let pg: PGlite;
let db: TransactionalSql;
const target = { workspaceId: 'invitation-workspace', ticketId: 'invitation-ticket' };
const pm: TicketSubject = { kind: 'internal', userId: 'invitation-pm',
  authentication: { kind: 'verified_github_bearer', verificationId: 'test-verification' } };
const provider = { identity: 'a'.repeat(64), send: vi.fn(async () => undefined) };

function intake() {
  const store = new PostgresTicketPublicIntakeStore(db);
  return createTicketPublicIntakeService(store, {
    async admitRequest(entry) {
      const issuedAt = new Date();
      return { entryId: entry.id, rateSubjectKey: 'b'.repeat(64), issuedAt: issuedAt.toISOString(),
        expiresAt: new Date(issuedAt.getTime() + 60_000).toISOString() };
    },
  }, { fingerprintKeys: [{ id: 'test-key', secret: new Uint8Array(32).fill(9) }], maxRequestAgeMs: 60_000 },
  () => new Date(), () => target.ticketId);
}

async function submitInquiry(email = 'approved@example.test') {
  await intake().submit('invitation-entry', {
    schemaVersion: 1, operationId: 'f3cbd5c0-ae8d-4c9e-aac5-6a3ee0b63471', fullName: 'Synthetic Contact', email,
    company: null, title: 'Synthetic inquiry', description: 'Test invitation email without account creation.',
    requestedDeadline: null,
  }, { origin: 'https://tickets.example.test', remoteAddress: '192.0.2.10' });
}

async function markUnderReview() {
  await createTicketCommandService(new PostgresTicketTriageStore(db)).execute(target, pm, {
    schemaVersion: 1, operationId: 'review-invitation-ticket', expectedVersion: 0, command: { type: 'review' },
  });
}

beforeEach(async () => {
  provider.send.mockClear();
  pg = await createTestDatabase();
  const sql = sqlFor(pg);
  db = { ...sql, transaction: work => pg.transaction(async tx => work(sqlFor(tx as unknown as PGlite))) };
  await db.query(`insert into public.workspaces(id,name,slug,settings_json) values
    ('invitation-workspace','Synthetic','invitation-workspace','{"ticketing_write_mode":"enabled"}')`);
  await db.query(`insert into public.workspace_members(id,workspace_id,user_id,role) values
    ('invitation-pm-member','invitation-workspace','invitation-pm','pm'),
    ('invitation-dev-member','invitation-workspace','invitation-dev','dev')`);
  await db.query(`insert into alpha_private.ticket_intake_entries
    (id,workspace_id,slug,company_label,published,write_mode,policy_version,per_source_max,per_entry_max,window_seconds)
    values ('invitation-entry','invitation-workspace','invitation-entry','Synthetic',true,'enabled','v1',20,20,60)`);
}, 60_000);
afterEach(async () => { await pg?.close(); });

describe('PM email-only ticket invitation', () => {
  it('queues one private outbox notice, sends it once, and creates no account or access grant', async () => {
    await submitInquiry();
    await markUnderReview();
    const store = new PostgresTicketInvitationEmailStore(db);

    const first = await store.request(target, pm);
    const second = await store.request(target, pm);
    expect(first).toMatchObject({ ticketId: target.ticketId, status: 'queued', alreadyRequested: false });
    expect(second).toEqual({ ...first, status: 'queued', alreadyRequested: true });
    expect((await db.query<{ count: number }>(
      `select count(*)::int as count from alpha_private.ticket_outbox_events
       where event_type='ticket_invitation_requested' and payload->>'noticeVersion'='1'`,
    )).rows[0].count).toBe(1);

    const event = (await db.query<{ payload: Record<string, unknown> }>(
      `select payload from alpha_private.ticket_outbox_events where id=$1`, [first.deliveryId],
    )).rows[0];
    expect(JSON.stringify(event.payload)).not.toContain('approved@example.test');
    expect(event.payload).toEqual({ noticeVersion: 1 });

    const delivery = createTicketInvitationEmailDeliveryService(store, provider);
    expect(await delivery.deliverNext()).toBe(true);
    expect(provider.send).toHaveBeenCalledOnce();
    expect(provider.send).toHaveBeenCalledWith('approved@example.test', `client-invitation/${first.deliveryId}`);
    expect((await db.query<{ status: string }>(
      `select status from alpha_private.ticket_outbox_events where id=$1`, [first.deliveryId],
    )).rows[0].status).toBe('delivered');

    const afterSend = await store.request(target, pm);
    expect(afterSend).toMatchObject({ status: 'accepted', alreadyRequested: true, deliveryId: first.deliveryId });
    expect((await db.query<{ count: number }>('select count(*)::int as count from alpha_private.ticket_client_grants')).rows[0].count).toBe(0);
    expect((await db.query<{ count: number }>('select count(*)::int as count from alpha_private.ticket_service_grants')).rows[0].count).toBe(0);
    expect((await db.query<{ status: string }>('select status from alpha_private.tickets where id=$1', [target.ticketId])).rows[0].status).toBe('under_review');
  });

  it('requires a reviewed public inquiry and an authorized workspace PM', async () => {
    await db.query(`insert into public.workspaces(id,name,slug,settings_json) values
      ('unrelated-workspace','Unrelated','unrelated-workspace','{"ticketing_write_mode":"enabled"}')`);
    await db.query(`insert into public.workspace_members(id,workspace_id,user_id,role) values
      ('unrelated-pm-member','unrelated-workspace','invitation-pm','pm')`);
    await submitInquiry();
    const store = new PostgresTicketInvitationEmailStore(db);
    await expect(store.request(target, pm)).rejects.toMatchObject({ code: 'ticket_not_eligible_for_invitation' });
    await markUnderReview();
    await expect(store.request(target, { ...pm, userId: 'invitation-dev' })).rejects.toMatchObject({ status: 404 });
    await expect(store.request({ ...target, workspaceId: 'unrelated-workspace' }, pm)).rejects.toMatchObject({ status: 404 });
  });

  it('does not create a new send after a terminal delivery failure', async () => {
    await submitInquiry();
    await markUnderReview();
    const store = new PostgresTicketInvitationEmailStore(db);
    const first = await store.request(target, pm);
    const failingProvider = { identity: 'c'.repeat(64),
      send: vi.fn(async () => { throw new TicketInvitationEmailError(false); }) };
    const delivery = createTicketInvitationEmailDeliveryService(store, failingProvider);
    expect(await delivery.deliverNext()).toBe(true);
    expect(await store.request(target, pm)).toMatchObject({
      deliveryId: first.deliveryId, status: 'failed', alreadyRequested: true,
    });
    expect((await db.query<{ count: number }>(
      `select count(*)::int as count from alpha_private.ticket_outbox_events
       where event_type='ticket_invitation_requested' and payload->>'noticeVersion'='1'`,
    )).rows[0].count).toBe(1);
  });

  it('does not send a queued notice if the PM declines the inquiry before delivery', async () => {
    await submitInquiry();
    await markUnderReview();
    const store = new PostgresTicketInvitationEmailStore(db);
    const receipt = await store.request(target, pm);
    await createTicketCommandService(new PostgresTicketTriageStore(db)).execute(target, pm, {
      schemaVersion: 1, operationId: 'decline-before-email', expectedVersion: 1,
      command: { type: 'decline', reason: 'Synthetic inquiry declined.' },
    });
    const delivery = createTicketInvitationEmailDeliveryService(store, provider);
    expect(await delivery.deliverNext()).toBe(false);
    expect(provider.send).not.toHaveBeenCalled();
    expect((await db.query<{ status: string }>(
      `select status from alpha_private.ticket_outbox_events where id=$1`, [receipt.deliveryId],
    )).rows[0].status).toBe('discarded');
  });
});
