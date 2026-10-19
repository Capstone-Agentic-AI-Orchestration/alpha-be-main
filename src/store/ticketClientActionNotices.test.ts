import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';

import { createTicketClientActivationService } from '../services/ticketClientActivationService.js';
import { createTicketCommandService } from '../services/ticketCommandService.js';
import { createTicketInvitationService } from '../services/ticketInvitationService.js';
import { createTicketPublicIntakeService } from '../services/ticketPublicIntakeService.js';
import { createClientTicketInvitationSecretProtector } from '../ticketing/clientTicketSecrets.js';
import { PostgresTicketClientActivationStore } from './ticketClientActivationPostgresStore.js';
import { PostgresTicketCommunicationNotificationStore } from './ticketCommunicationNotificationStore.js';
import type { TicketClientAction, TicketCommunicationNotificationClaim } from './ticketCommunicationNotificationStore.js';
import { PostgresTicketInvitationStore } from './ticketInvitationPostgresStore.js';
import { PostgresTicketPublicIntakeStore } from './ticketPublicIntakePostgresStore.js';
import { PostgresTicketTriageStore } from './ticketTriagePostgresStore.js';
import { createTestDatabase, sqlFor } from './testDatabase.js';
import type { TransactionalSql } from './database.js';
import type { TicketSubject, TicketTarget } from './ticketCommandStore.js';

const DAY = 24 * 60 * 60 * 1000;
const workspaceId = 'client-action-notices-workspace';
const pm: TicketSubject = { kind: 'internal', userId: 'client-action-notices-pm',
  authentication: { kind: 'verified_github_bearer', verificationId: 'client-action-notices-verification' } };
const sessionSecret = 'client-action-notices-session-secret-with-sufficient-entropy';
const policy = (now: Date) => ({ now: now.toISOString(), freshWithinMs: DAY, reminderAfterMs: 3 * DAY, reminderWithinMs: 14 * DAY });

let pg: PGlite;
let db: TransactionalSql;
let store: PostgresTicketCommunicationNotificationStore;
let counter = 0;

/** An activated client with a ticket in review, using the real intake, invitation and activation services. */
async function activatedTicket(): Promise<{ target: TicketTarget; email: string }> {
  const n = ++counter;
  const now = new Date(Date.now() - 10_000);
  const target = { workspaceId, ticketId: 'client-action-notices-ticket-' + n };
  const email = 'client-action-notices-' + n + '@example.test';
  await createTicketPublicIntakeService(new PostgresTicketPublicIntakeStore(db), {
    async admitRequest(entry) {
      return { entryId: entry.id, rateSubjectKey: 'e'.repeat(64), issuedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 60_000).toISOString() };
    },
  }, { fingerprintKeys: [{ id: 'client-action-notices-key', secret: new Uint8Array(32).fill(34) }], maxRequestAgeMs: 60_000 },
  () => now, () => target.ticketId).submit('client-action-notices-entry', {
    schemaVersion: 1, operationId: randomUUID(), fullName: 'Synthetic Client', email, company: null,
    title: 'Synthetic inquiry ' + n, description: 'Synthetic scenario. No production data or email is used.', requestedDeadline: null,
  }, { origin: 'https://tickets.example.test', remoteAddress: '192.0.2.36' });
  await createTicketCommandService(new PostgresTicketTriageStore(db)).execute(target, pm, {
    schemaVersion: 1, operationId: 'review-' + n, expectedVersion: 0, command: { type: 'review' },
  });
  const secrets = createClientTicketInvitationSecretProtector(sessionSecret);
  const issued = await createTicketInvitationService(new PostgresTicketInvitationStore(db),
    { lifetimeMs: 7 * DAY }, secrets.invitation, () => now).issue(target, pm);
  const { rows } = await db.query<{ payload: { protectedToken: string } }>(
    "select payload from alpha_private.ticket_outbox_events where workspace_id=$1 and ticket_id=$2 and payload->>'activationVersion'='1'",
    [workspaceId, target.ticketId],
  );
  const invitationToken = secrets.invitation.unprotect(rows[0].payload.protectedToken, {
    workspaceId, ticketId: target.ticketId, invitationId: issued.invitationId, expiresAt: issued.expiresAt,
  });
  const identity = { userId: 'client-action-notices-client-' + n, email, emailVerified: true };
  await createTicketClientActivationService(new PostgresTicketClientActivationStore(db),
    { async verifyCredential(value: string) { return value === 'credential-' + n ? identity : null; } }, () => now)
    .activate({ invitationToken, providerCredential: 'credential-' + n });
  return { target, email };
}

/** Put the ticket into "waiting on the client", as if the PM had just done it, at a chosen time. */
async function waitOnClient(target: TicketTarget, action: TicketClientAction, changedAt: Date, extra: Record<string, unknown> = {}) {
  const { rows } = await db.query<{ version: number; workflow_state: Record<string, unknown> }>(
    'select version::int as version, workflow_state from alpha_private.tickets where workspace_id=$1 and id=$2',
    [target.workspaceId, target.ticketId],
  );
  const version = rows[0].version + 1;
  const status = action === 'review_result' ? 'ready_for_review' : 'awaiting_client';
  const state = { ...rows[0].workflow_state, version, status, actionOwner: 'client', nextAction: action, ...extra };
  await db.query(
    'update alpha_private.tickets set workflow_state=$3::jsonb, status=$4, version=$5, client_updated_at=$6::timestamptz where workspace_id=$1 and id=$2',
    [target.workspaceId, target.ticketId, JSON.stringify(state), status, version, changedAt.toISOString()],
  );
}

async function claimAll(): Promise<TicketCommunicationNotificationClaim[]> {
  const claims: TicketCommunicationNotificationClaim[] = [];
  for (let i = 0; i < 30; i++) {
    const now = new Date();
    const claim = await store.claimNext({ now: now.toISOString(), leaseUntil: new Date(now.getTime() + 60_000).toISOString() });
    if (!claim) break;
    claims.push(claim);
    await store.markDelivered(claim, new Date().toISOString());
  }
  return claims;
}

beforeAll(async () => {
  pg = await createTestDatabase();
  const sql = sqlFor(pg);
  db = { ...sql, transaction: work => pg.transaction(async tx => work(sqlFor(tx as unknown as PGlite))) };
  store = new PostgresTicketCommunicationNotificationStore(db);
  await db.query("insert into public.workspaces(id,name,slug,status,settings_json) values ($1,'Synthetic action notices','client-action-notices','active','{\"ticketing_write_mode\":\"enabled\"}')", [workspaceId]);
  await db.query("insert into public.workspace_members(id,workspace_id,user_id,role) values ('client-action-notices-member',$1,$2,'pm')", [workspaceId, pm.userId]);
  await db.query("insert into alpha_private.ticket_intake_entries (id,workspace_id,slug,company_label,published,write_mode,policy_version,per_source_max,per_entry_max,window_seconds) values ('client-action-notices-entry',$1,'client-action-notices-entry',$2,true,'enabled','v1',100,100,60)", [workspaceId, 'Synthetic']);
}, 60_000);

afterAll(async () => { await pg?.close(); });

describe('Client action-needed notices and reminders', () => {
  it('tells the client once when a proposed scope or a result is waiting, naming the request', async () => {
    const scope = await activatedTicket();
    const result = await activatedTicket();
    await waitOnClient(scope.target, 'agree_scope', new Date(), { scopeVersionId: 'scope-v1' });
    await waitOnClient(result.target, 'review_result', new Date(), { delivery: { id: 'delivery-1', shared: true } });

    await expect(store.enqueueDueActionNotices(policy(new Date()))).resolves.toBe(2);
    await expect(store.enqueueDueActionNotices(policy(new Date()))).resolves.toBe(0);

    const claims = await claimAll();
    const forScope = claims.find(claim => claim.recipient === scope.email);
    const forResult = claims.find(claim => claim.recipient === result.email);
    expect(forScope).toMatchObject({ kind: 'action', action: 'agree_scope' });
    expect(forResult).toMatchObject({ kind: 'action', action: 'review_result' });
    await expect(store.enqueueDueActionNotices(policy(new Date()))).resolves.toBe(0);
  });

  it('sends a new notice when a changed scope is proposed, not for the same one again', async () => {
    const ticket = await activatedTicket();
    await waitOnClient(ticket.target, 'agree_scope', new Date(), { scopeVersionId: 'scope-first' });
    await store.enqueueDueActionNotices(policy(new Date()));
    expect((await claimAll()).filter(claim => claim.recipient === ticket.email)).toHaveLength(1);

    await waitOnClient(ticket.target, 'agree_scope', new Date(), { scopeVersionId: 'scope-second' });
    await expect(store.enqueueDueActionNotices(policy(new Date()))).resolves.toBe(1);
    expect((await claimAll()).filter(claim => claim.recipient === ticket.email)).toHaveLength(1);
  });

  it('drops a notice if the client has already acted or the ticket was put on hold', async () => {
    const agreed = await activatedTicket();
    const held = await activatedTicket();
    await waitOnClient(agreed.target, 'agree_scope', new Date(), { scopeVersionId: 'scope-v1' });
    await waitOnClient(held.target, 'review_result', new Date(), { delivery: { id: 'delivery-held', shared: true } });
    await store.enqueueDueActionNotices(policy(new Date()));

    // The client agreed in the meantime; the other ticket was paused.
    await db.query(
      "update alpha_private.tickets set workflow_state=jsonb_set(jsonb_set(workflow_state,'{actionOwner}','\"pm\"'),'{nextAction}','\"authorize_work\"') where workspace_id=$1 and id=$2",
      [agreed.target.workspaceId, agreed.target.ticketId]);
    await db.query(
      "update alpha_private.tickets set status='on_hold', workflow_state=jsonb_set(workflow_state,'{status}','\"on_hold\"') where workspace_id=$1 and id=$2",
      [held.target.workspaceId, held.target.ticketId]);

    const recipients = (await claimAll()).map(claim => claim.recipient);
    expect(recipients).not.toContain(agreed.email);
    expect(recipients).not.toContain(held.email);
  });

  it('sends one reminder after three days of silence, not sooner, not for stale requests, and never twice', async () => {
    const fresh = await activatedTicket();
    const dueScope = await activatedTicket();
    const dueReply = await activatedTicket();
    const stale = await activatedTicket();
    const now = new Date();
    await waitOnClient(fresh.target, 'agree_scope', new Date(now.getTime() - 2 * DAY), { scopeVersionId: 'scope-fresh' });
    await waitOnClient(dueScope.target, 'agree_scope', new Date(now.getTime() - 4 * DAY), { scopeVersionId: 'scope-due' });
    await waitOnClient(dueReply.target, 'reply', new Date(now.getTime() - 5 * DAY));
    await waitOnClient(stale.target, 'review_result', new Date(now.getTime() - 20 * DAY), { delivery: { id: 'delivery-stale', shared: true } });

    await expect(store.enqueueDueActionNotices(policy(now))).resolves.toBe(2);
    const claims = await claimAll();
    expect(claims.find(claim => claim.recipient === dueScope.email)).toMatchObject({ kind: 'reminder', action: 'agree_scope' });
    expect(claims.find(claim => claim.recipient === dueReply.email)).toMatchObject({ kind: 'reminder', action: 'reply' });
    expect(claims.map(claim => claim.recipient)).not.toContain(fresh.email);
    expect(claims.map(claim => claim.recipient)).not.toContain(stale.email);

    // A later sweep, even much later, does not nag the same request again.
    await expect(store.enqueueDueActionNotices(policy(new Date(now.getTime() + 60_000)))).resolves.toBe(0);
  });

  it('refuses nonsensical sweep policies', () => {
    expect(() => store.enqueueDueActionNotices({ ...policy(new Date()), reminderWithinMs: 1 })).toThrow();
    expect(() => store.enqueueDueActionNotices({ ...policy(new Date()), freshWithinMs: -1 })).toThrow();
  });
});
