import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';

import { createTicketCommandService } from '../services/ticketCommandService.js';
import { createTicketClientActivationService } from '../services/ticketClientActivationService.js';
import { createTicketClientInvitationDeliveryService } from '../services/ticketClientInvitationDeliveryService.js';
import { createTicketClientSessionService } from '../services/ticketClientSessionService.js';
import { createTicketClientSignInService } from '../services/ticketClientSignInService.js';
import { createTicketClientWorkspaceService } from '../services/ticketClientWorkspaceService.js';
import { createTicketInvitationService } from '../services/ticketInvitationService.js';
import { createTicketPublicIntakeService } from '../services/ticketPublicIntakeService.js';
import { createTicketQueueService } from '../services/ticketQueueService.js';
import { createTicketReadService } from '../services/ticketReadService.js';
import type { TicketClientIdentityProvider } from '../services/ticketClientIdentityProvider.js';
import type { TicketInvitationContentEmailProvider } from '../services/ticketInvitationEmailProvider.js';
import { PostgresTicketClientActivationStore } from './ticketClientActivationPostgresStore.js';
import { PostgresTicketClientInvitationDeliveryStore } from './ticketClientInvitationDeliveryStore.js';
import { PostgresTicketClientSessionStore } from './ticketClientSessionPostgresStore.js';
import { PostgresTicketClientSignInStore } from './ticketClientSignInPostgresStore.js';
import { PostgresTicketClientWorkspaceStore } from './ticketClientWorkspacePostgresStore.js';
import { PostgresTicketInvitationStore } from './ticketInvitationPostgresStore.js';
import { PostgresTicketInvitationEmailStore } from './ticketInvitationEmailPostgresStore.js';
import { PostgresTicketPublicIntakeStore } from './ticketPublicIntakePostgresStore.js';
import { PostgresTicketQueueStore } from './ticketQueuePostgresStore.js';
import { PostgresTicketReadStore } from './ticketReadPostgresStore.js';
import { PostgresTicketTriageStore } from './ticketTriagePostgresStore.js';
import { createClientTicketInvitationSecretProtector } from '../ticketing/clientTicketSecrets.js';
import { createTestDatabase, sqlFor } from './testDatabase.js';
import type { TransactionalSql } from './database.js';
import type { TicketSubject, TicketTarget } from './ticketCommandStore.js';

const workspaceId = 'phase-four-workspace';
const pmId = 'phase-four-pm';
const clientId = '00000000-0000-4000-8000-000000000004';
const providerCredential = 'synthetic-verified-provider-credential';
const clientEmail = 'phase-four-client@example.test';
const webOrigin = 'https://tickets.example.test';
const now = new Date();
const firstTarget: TicketTarget = { workspaceId, ticketId: 'phase-four-ticket-1' };
const secondTarget: TicketTarget = { workspaceId, ticketId: 'phase-four-ticket-2' };
const pm: TicketSubject = {
  kind: 'internal', userId: pmId,
  authentication: { kind: 'verified_github_bearer', verificationId: 'phase-four-test-session' },
};
const verifiedIdentity = { userId: clientId, email: clientEmail, emailVerified: true };
const providerTokenHash = 'provider-token-hash-for-phase-four';
const sessionSecret = 'phase-four-test-session-secret-with-sufficient-entropy';

let pg: PGlite;
let db: TransactionalSql;

function intake(ticketId: string) {
  const store = new PostgresTicketPublicIntakeStore(db);
  return createTicketPublicIntakeService(store, {
    async admitRequest(entry) {
      const issuedAt = now;
      return {
        entryId: entry.id,
        rateSubjectKey: 'b'.repeat(64),
        issuedAt: issuedAt.toISOString(),
        expiresAt: new Date(issuedAt.getTime() + 60_000).toISOString(),
      };
    },
  }, { fingerprintKeys: [{ id: 'phase-four-key', secret: new Uint8Array(32).fill(17) }], maxRequestAgeMs: 60_000 },
  () => now, () => ticketId);
}

async function submitInquiry(target: TicketTarget, email: string, operationId: string) {
  await intake(target.ticketId).submit('phase-four-entry', {
    schemaVersion: 1, operationId, fullName: 'Synthetic Client', email,
    company: null, title: `Synthetic inquiry ${target.ticketId}`,
    description: `Private test description for ${target.ticketId}.`, requestedDeadline: null,
  }, { origin: webOrigin, remoteAddress: '192.0.2.10' });
}

async function reviewInquiry(target: TicketTarget) {
  await createTicketCommandService(new PostgresTicketTriageStore(db)).execute(target, pm, {
    schemaVersion: 1, operationId: `review-${target.ticketId}`, expectedVersion: 0,
    command: { type: 'review' },
  });
}

beforeEach(async () => {
  pg = await createTestDatabase();
  const sql = sqlFor(pg);
  db = { ...sql, transaction: work => pg.transaction(async tx => work(sqlFor(tx as unknown as PGlite))) };
  await db.query(`insert into public.workspaces(id,name,slug,status,settings_json) values
    ($1,'Synthetic phase four','phase-four-workspace','active','{"ticketing_write_mode":"enabled"}')`, [workspaceId]);
  await db.query(`insert into public.workspace_members(id,workspace_id,user_id,role) values
    ('phase-four-pm-member',$1,$2,'pm')`, [workspaceId, pmId]);
  await db.query(`insert into alpha_private.ticket_intake_entries
    (id,workspace_id,slug,company_label,published,write_mode,policy_version,per_source_max,per_entry_max,window_seconds)
    values ('phase-four-entry',$1,'phase-four-entry','Synthetic',true,'enabled','v1',20,20,60)`, [workspaceId]);
}, 60_000);

afterEach(async () => { await pg?.close(); });

describe('Phase 4 invitation-to-client-ticket flow on PostgreSQL', () => {
  it('issues, emails, activates, signs in, and exposes only the explicitly granted ticket', async () => {
    await submitInquiry(firstTarget, clientEmail, 'd15921fb-f001-4b9b-94c3-8f2b8f431001');
    await submitInquiry(secondTarget, 'another-contact@example.test', 'd15921fb-f001-4b9b-94c3-8f2b8f431002');
    await reviewInquiry(firstTarget);

    const secrets = createClientTicketInvitationSecretProtector(sessionSecret);
    const invitations = createTicketInvitationService(
      new PostgresTicketInvitationStore(db), { lifetimeMs: 60 * 60 * 1000 }, secrets.invitation,
      () => now, () => 'phase-four-invitation-1',
    );
    const invitation = await invitations.issue(firstTarget, pm);
    expect(invitation).toMatchObject({ ticketId: firstTarget.ticketId, alreadyPending: false });
    // The older Phase 3 notice worker must leave activation events for this worker.
    await expect(new PostgresTicketInvitationEmailStore(db).claimNext('a'.repeat(64))).resolves.toBeNull();

    const sent: Array<{ recipient: string; subject: string; body: string; idempotencyKey: string }> = [];
    const emailProvider: TicketInvitationContentEmailProvider = {
      identity: 'phase-four-test-provider',
      async send() {},
      async sendContent(recipient, subject, body, idempotencyKey) {
        sent.push({ recipient, subject, body, idempotencyKey });
      },
    };
    const identityProvider = {
      async generateEmailLink(email: string, type: 'invite' | 'magiclink') {
        expect(email).toBe(clientEmail);
        return { userId: clientId, tokenHash: providerTokenHash, type };
      },
    } as unknown as TicketClientIdentityProvider;
    const delivery = createTicketClientInvitationDeliveryService(
      new PostgresTicketClientInvitationDeliveryStore(db), identityProvider, emailProvider,
      secrets.invitation, secrets.providerLink,
      { webOrigin, leaseDurationMs: 60_000, retryBaseDelayMs: 1_000, retryMaxDelayMs: 60_000, maxAttempts: 3 },
      () => now,
    );

    await expect(delivery.deliverNext()).resolves.toBe('delivered');
    expect(sent).toHaveLength(1);
    expect(sent[0].recipient).toBe(clientEmail);
    expect(sent[0].subject).toContain('Activate your Alpha client access');
    expect(sent[0].body).toContain(`${webOrigin}/#/client/activate?`);
    expect(sent[0].body).not.toContain(firstTarget.ticketId);
    expect(sent[0].body).not.toContain(clientEmail);
    const deliveredEvent = await db.query<{ status: string; payload: Record<string, unknown> }>(
      `select status,payload from alpha_private.ticket_outbox_events
        where workspace_id=$1 and ticket_id=$2 and payload->>'activationVersion'='1'`,
      [workspaceId, firstTarget.ticketId],
    );
    expect(deliveredEvent.rows[0]?.status).toBe('delivered');
    expect(deliveredEvent.rows[0]?.payload).not.toHaveProperty('protectedToken');

    const activationUrl = new URL(sent[0].body.split('\n\n')[2]);
    const activationRoute = activationUrl.hash.slice(1);
    const activationQuery = activationRoute.slice(activationRoute.indexOf('?') + 1);
    const activationParams = new URLSearchParams(activationQuery);
    const invitationToken = activationParams.get('token');
    expect(activationRoute.startsWith('/client/activate?')).toBe(true);
    expect(activationParams.get('providerTokenHash')).toBe(providerTokenHash);
    expect(activationParams.get('providerTokenType')).toBe('invite');
    expect(invitationToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const verifier = {
      verifyCredential: vi.fn(async (credential: string) => credential === providerCredential ? verifiedIdentity : null),
    };
    const activation = createTicketClientActivationService(
      new PostgresTicketClientActivationStore(db), verifier, () => now,
    );
    await expect(activation.activate({ invitationToken, providerCredential })).resolves.toEqual({ activated: true });

    const sessions = createTicketClientSessionService(
      new PostgresTicketClientSessionStore(db), verifier, { lifetimeMs: 60 * 60 * 1000 }, () => now,
    );
    const issued = await sessions.exchange(providerCredential);
    expect(issued).not.toBeNull();
    const authenticated = await sessions.authenticate(
      issued!.sessionCookieValue, issued!.csrfCookieValue, issued!.csrfCookieValue, true,
    );
    expect(authenticated.kind).toBe('authenticated');
    if (authenticated.kind !== 'authenticated') throw new Error('Expected the newly activated client session.');

    const workspaces = await createTicketClientWorkspaceService(new PostgresTicketClientWorkspaceStore(db))
      .list(authenticated.subject);
    expect(workspaces).toEqual([{ workspaceId, displayName: 'Synthetic' }]);

    const queue = await createTicketQueueService(new PostgresTicketQueueStore(db), () => now)
      .list(workspaceId, authenticated.subject);
    expect(queue.items.map(item => item.id)).toEqual([firstTarget.ticketId]);
    expect(queue.items[0].title).toBe(`Synthetic inquiry ${firstTarget.ticketId}`);

    const detail = await createTicketReadService(new PostgresTicketReadStore(db))
      .detail(firstTarget, authenticated.subject);
    expect(detail.id).toBe(firstTarget.ticketId);
    expect(detail.description).toBe(`Private test description for ${firstTarget.ticketId}.`);
    await expect(createTicketReadService(new PostgresTicketReadStore(db))
      .detail(secondTarget, authenticated.subject)).rejects.toMatchObject({ status: 404 });

    await sessions.revoke(authenticated.subject);
    await expect(sessions.authenticate(issued!.sessionCookieValue)).resolves.toEqual({ kind: 'unauthenticated' });

    const invitationRow = await db.query<{ status: string }>(
      `select status from alpha_private.ticket_invitations where workspace_id=$1 and ticket_id=$2`,
      [workspaceId, firstTarget.ticketId],
    );
    expect(invitationRow.rows[0]?.status).toBe('consumed');
    const grantCounts = await db.query<{ ticket_grants: number; service_grants: number }>(
      `select
         (select count(*)::int from alpha_private.ticket_client_grants where client_user_id=$1) as ticket_grants,
         (select count(*)::int from alpha_private.ticket_service_grants where client_user_id=$1) as service_grants`,
      [clientId],
    );
    expect(grantCounts.rows[0]).toEqual({ ticket_grants: 1, service_grants: 1 });
  }, 60_000);

  it('sends returning sign-in links only to an already activated client without revealing account status', async () => {
    await submitInquiry(firstTarget, clientEmail, 'd15921fb-f001-4b9b-94c3-8f2b8f431003');
    await reviewInquiry(firstTarget);

    const secrets = createClientTicketInvitationSecretProtector(sessionSecret);
    const invitations = createTicketInvitationService(
      new PostgresTicketInvitationStore(db), { lifetimeMs: 60 * 60 * 1000 }, secrets.invitation,
      () => now, () => 'phase-four-invitation-2',
    );
    const invitation = await invitations.issue(firstTarget, pm);
    const activation = createTicketClientActivationService(new PostgresTicketClientActivationStore(db), {
      verifyCredential: vi.fn(async () => verifiedIdentity),
    }, () => now);

    // This test covers the returning-sign-in eligibility lookup, so create the
    // provider-owned auth.users row as Supabase Auth would after link creation.
    await db.query(`create table if not exists auth.users (
      id text primary key, email text not null, email_confirmed_at timestamptz
    )`);
    await db.query(`insert into auth.users(id,email,email_confirmed_at) values ($1,$2,$3)`,
      [clientId, clientEmail, now.toISOString()]);

    const token = Buffer.alloc(32, 41).toString('base64url');
    // The invitation secret hash must match the token supplied to activation;
    // obtain the token from the protected outbox payload as a worker would.
    const pending = await db.query<{ payload: Record<string, unknown> }>(
      `select payload from alpha_private.ticket_outbox_events
        where workspace_id=$1 and ticket_id=$2 and event_type='ticket_invitation_requested'
          and payload->>'activationVersion'='1'`, [workspaceId, firstTarget.ticketId],
    );
    const protectedToken = pending.rows[0]?.payload.protectedToken;
    expect(typeof protectedToken).toBe('string');
    const invitationToken = secrets.invitation.unprotect(protectedToken as string, {
      workspaceId, ticketId: firstTarget.ticketId,
      invitationId: invitation.invitationId, expiresAt: invitation.expiresAt,
    });
    await activation.activate({ invitationToken, providerCredential });

    const generatedLinks: Array<{ email: string; type: string }> = [];
    const identityProvider = {
      async generateEmailLink(email: string, type: 'invite' | 'magiclink') {
        generatedLinks.push({ email, type });
        return { userId: clientId, tokenHash: providerTokenHash, type };
      },
    } as unknown as TicketClientIdentityProvider;
    const sent: string[] = [];
    const emailProvider: TicketInvitationContentEmailProvider = {
      identity: 'phase-four-test-provider', async send() {},
      async sendContent(recipient) { sent.push(recipient); },
    };
    const signIn = createTicketClientSignInService(
      new PostgresTicketClientSignInStore(db), identityProvider, emailProvider, webOrigin,
    );

    await expect(signIn.request(clientEmail)).resolves.toEqual({ accepted: true });
    await expect(signIn.request('unknown@example.test')).resolves.toEqual({ accepted: true });
    expect(generatedLinks).toEqual([{ email: clientEmail, type: 'magiclink' }]);
    expect(sent).toEqual([clientEmail]);
  }, 60_000);
});
