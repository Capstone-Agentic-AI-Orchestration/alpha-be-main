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
import type { Router } from 'express';
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

const workspaceId = 'client-portal-workspace';
const pmId = 'client-portal-pm';
const clientId = '00000000-0000-4000-8000-000000000004';
const providerCredential = 'synthetic-verified-provider-credential';
const clientEmail = 'client-portal-client@example.test';
const webOrigin = 'https://tickets.example.test';
const now = new Date();
const firstTarget: TicketTarget = { workspaceId, ticketId: 'client-portal-ticket-1' };
const secondTarget: TicketTarget = { workspaceId, ticketId: 'client-portal-ticket-2' };
const pm: TicketSubject = {
  kind: 'internal', userId: pmId,
  authentication: { kind: 'verified_github_bearer', verificationId: 'client-portal-test-session' },
};
const verifiedIdentity = { userId: clientId, email: clientEmail, emailVerified: true };
const providerTokenHash = 'provider-token-hash-for-client-portal';
const sessionSecret = 'client-portal-test-session-secret-with-sufficient-entropy';

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
  }, { fingerprintKeys: [{ id: 'client-portal-key', secret: new Uint8Array(32).fill(17) }], maxRequestAgeMs: 60_000 },
  () => now, () => ticketId);
}

async function submitInquiry(target: TicketTarget, email: string, operationId: string) {
  await intake(target.ticketId).submit('client-portal-entry', {
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
    ($1,'Synthetic client portal','client-portal-workspace','active','{"ticketing_write_mode":"enabled"}')`, [workspaceId]);
  await db.query(`insert into public.workspace_members(id,workspace_id,user_id,role) values
    ('client-portal-pm-member',$1,$2,'pm')`, [workspaceId, pmId]);
  await db.query(`insert into alpha_private.ticket_intake_entries
    (id,workspace_id,slug,company_label,published,write_mode,policy_version,per_source_max,per_entry_max,window_seconds)
    values ('client-portal-entry',$1,'client-portal-entry','Synthetic',true,'enabled','v1',20,20,60)`, [workspaceId]);
}, 60_000);

afterEach(async () => { vi.restoreAllMocks(); vi.doUnmock('../config/env.js'); vi.resetModules(); await pg?.close(); });

/** Exercise the actual mounted handlers without starting a localhost server. */
function invokeClientRoute(router: Router, method: string, routePath: string, input: {
  body?: unknown; params?: Record<string, string>; cookie?: string; origin?: string; csrf?: string;
} = {}): Promise<{ status: number; headers: Record<string, string | string[]>; body: unknown }> {
  const find = (stack: any[]): any => {
    for (const layer of stack) {
      if (layer.route?.path === routePath && layer.route.methods[method.toLowerCase()]) return layer.route.stack[0].handle;
      if (layer.handle?.stack) { const nested = find(layer.handle.stack); if (nested) return nested; }
    }
  };
  const handler = find((router as any).stack);
  if (!handler) throw new Error(`Missing client route ${method} ${routePath}`);
  return new Promise((resolve, reject) => {
    let status = 200;
    const headers: Record<string, string | string[]> = {};
    const requestHeaders: Record<string, string | undefined> = {
      origin: input.origin ?? webOrigin, cookie: input.cookie, 'x-csrf-token': input.csrf,
    };
    const req = { method, params: input.params ?? {}, query: {}, body: input.body, headers: requestHeaders,
      socket: { remoteAddress: '192.0.2.31' }, get: (name: string) => requestHeaders[name.toLowerCase()],
      is: (type: string) => type === 'application/json' };
    const res = {
      setHeader(name: string, value: string | string[]) { headers[name.toLowerCase()] = value; return this; },
      status(value: number) { status = value; return this; },
      json(body: unknown) { resolve({ status, headers, body }); return this; },
      end() { resolve({ status, headers, body: undefined }); return this; },
    };
    Promise.resolve(handler(req, res, reject)).catch(reject);
  });
}

describe('Client invitation-to-ticket flow on PostgreSQL', () => {
  it('issues, emails, activates, signs in, and exposes only the explicitly granted ticket', async () => {
    await submitInquiry(firstTarget, clientEmail, 'd15921fb-f001-4b9b-94c3-8f2b8f431001');
    await submitInquiry(secondTarget, 'another-contact@example.test', 'd15921fb-f001-4b9b-94c3-8f2b8f431002');
    await reviewInquiry(firstTarget);

    const readContactVerification = async (target: TicketTarget) => {
      const detail = await createTicketReadService(new PostgresTicketReadStore(db)).detail(target, pm);
      if (!('internal' in detail)) throw new Error('Expected PM-only detail.');
      return detail.internal.request?.contact?.verification;
    };
    expect(await readContactVerification(firstTarget)).toBe('unverified_submission');

    const secrets = createClientTicketInvitationSecretProtector(sessionSecret);
    const invitations = createTicketInvitationService(
      new PostgresTicketInvitationStore(db), { lifetimeMs: 60 * 60 * 1000 }, secrets.invitation,
      () => now, () => 'client-portal-invitation-1',
    );
    const invitation = await invitations.issue(firstTarget, pm);
    expect(invitation).toMatchObject({ ticketId: firstTarget.ticketId, alreadyPending: false });
    // The older Phase 3 notice worker must leave activation events for this worker.
    await expect(new PostgresTicketInvitationEmailStore(db).claimNext('a'.repeat(64))).resolves.toBeNull();

    const sent: Array<{ recipient: string; subject: string; body: string; idempotencyKey: string }> = [];
    const emailProvider: TicketInvitationContentEmailProvider = {
      identity: 'client-portal-test-provider',
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
    // Successful email delivery is not evidence that the recipient owns it.
    expect(await readContactVerification(firstTarget)).toBe('unverified_submission');

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
    const wrongEmailActivation = createTicketClientActivationService(
      new PostgresTicketClientActivationStore(db), {
        verifyCredential: vi.fn(async () => ({ ...verifiedIdentity, email: 'wrong-owner@example.test' })),
      }, () => now,
    );
    await expect(wrongEmailActivation.activate({ invitationToken, providerCredential }))
      .rejects.toMatchObject({ status: 404 });
    expect(await readContactVerification(firstTarget)).toBe('unverified_submission');

    // Exercise transaction rollback after the contact and ticket were updated.
    const postgresActivationStore = new PostgresTicketClientActivationStore(db);
    const interruptedActivation = createTicketClientActivationService({
      resolveTargetBySecretHash: hash => postgresActivationStore.resolveTargetBySecretHash(hash),
      transaction: work => postgresActivationStore.transaction(tx => work({ ...tx,
        async appendActivationAudit() { throw new Error('Synthetic audit failure'); },
      })),
    }, verifier, () => now);
    await expect(interruptedActivation.activate({ invitationToken, providerCredential }))
      .rejects.toMatchObject({ status: 503 });
    expect(await readContactVerification(firstTarget)).toBe('unverified_submission');
    const rolledBack = await db.query<{ client_user_id: string | null; status: string; grants: number }>(
      `select t.client_user_id,i.status,
         (select count(*)::int from alpha_private.ticket_client_grants g
           where g.workspace_id=t.workspace_id and g.ticket_id=t.id) as grants
       from alpha_private.tickets t join alpha_private.ticket_invitations i
         on i.workspace_id=t.workspace_id and i.ticket_id=t.id
       where t.workspace_id=$1 and t.id=$2`, [workspaceId, firstTarget.ticketId],
    );
    expect(rolledBack.rows[0]).toEqual({ client_user_id: null, status: 'pending', grants: 0 });

    await expect(activation.activate({ invitationToken, providerCredential })).resolves.toEqual({ activated: true });
    // Fresh PM reads use the persisted result, not an in-memory success flag.
    expect(await readContactVerification(firstTarget)).toBe('verified');
    expect(await readContactVerification(secondTarget)).toBe('unverified_submission');
    const persistedVerification = await db.query<{ email_verified: boolean }>(
      `select c.email_verified from alpha_private.ticket_contacts c
       join alpha_private.tickets t on t.workspace_id=c.workspace_id and t.contact_id=c.id
       where t.workspace_id=$1 and t.id=$2`, [workspaceId, firstTarget.ticketId],
    );
    expect(persistedVerification.rows[0]?.email_verified).toBe(true);

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
    expect(JSON.stringify(detail)).not.toContain(clientEmail);
    expect(JSON.stringify(detail)).not.toContain('emailVerified');
    expect(JSON.stringify(detail)).not.toContain('verification');
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
      () => now, () => 'client-portal-invitation-2',
    );
    const invitation = await invitations.issue(firstTarget, pm);
    const activation = createTicketClientActivationService(new PostgresTicketClientActivationStore(db), {
      verifyCredential: vi.fn(async () => verifiedIdentity),
    }, () => now);

    // This test covers the returning-sign-in eligibility lookup, so create the
    // provider-owned auth.users row as Supabase Auth would after link creation.
    await db.query(`create table if not exists auth.users (
      id uuid primary key, email text not null, email_confirmed_at timestamptz
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
      identity: 'client-portal-test-provider', async send() {},
      async sendContent(recipient) { sent.push(recipient); },
    };
    const signIn = createTicketClientSignInService(
      new PostgresTicketClientSignInStore(db), identityProvider, emailProvider, webOrigin,
    );

    await expect(signIn.request(clientEmail)).resolves.toEqual({ accepted: true });
    await expect(signIn.request('unknown@example.test')).resolves.toEqual({ accepted: true });
    expect(generatedLinks).toEqual([{ email: clientEmail, type: 'magiclink' }]);
    expect(sent).toEqual([clientEmail]);

    const unavailable = vi.fn();
    const restrictedSignIn = createTicketClientSignInService(
      new PostgresTicketClientSignInStore(db), identityProvider,
      { ...emailProvider, canSendTo: () => false }, webOrigin, unavailable,
    );
    await expect(restrictedSignIn.request(clientEmail)).resolves.toEqual({ accepted: true });
    expect(generatedLinks).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(unavailable).toHaveBeenCalledWith();
  }, 60_000);

  it('connects production activation, secure cookies, scoped reads, returning sign-in and logout routes', async () => {
    await submitInquiry(firstTarget, clientEmail, 'd15921fb-f001-4b9b-94c3-8f2b8f431004');
    await submitInquiry(secondTarget, 'other-client@example.test', 'd15921fb-f001-4b9b-94c3-8f2b8f431005');
    await reviewInquiry(firstTarget);
    await db.query(`create table if not exists auth.users (id uuid primary key, email text not null, email_confirmed_at timestamptz)`);
    await db.query(`insert into auth.users(id,email,email_confirmed_at) values ($1,$2,now())`, [clientId, clientEmail]);

    const consumedProofs = new Set<string>();
    const sendContent = vi.fn(async () => undefined);
    // Only the provider network is simulated. Composition, SQL, cookie guards,
    // services, grants and response projections below are production code.
    vi.resetModules();
    vi.doMock('../config/env.js', async importOriginal => ({
      ...await importOriginal<typeof import('../config/env.js')>(), IS_CLOUD: true, IS_DESKTOP: false,
    }));
    const { createTicketClientComposition: compose } = await import('../controllers/ticketClientComposition.js');
    // Replace only the provider network calls used by the fresh composition.
    const { TicketClientIdentityProvider: Provider } = await import('../services/ticketClientIdentityProvider.js');
    vi.spyOn(Provider.prototype, 'generateEmailLink').mockImplementation(async (_email, type) => ({ userId: clientId, tokenHash: providerTokenHash, type }));
    vi.spyOn(Provider.prototype, 'verifyCredential').mockResolvedValue(verifiedIdentity);
    vi.spyOn(Provider.prototype, 'verifyEmailLink').mockImplementation(async (proof, type) => {
      const key = `${type}:${proof}`;
      if (proof !== providerTokenHash || consumedProofs.has(key)) return null;
      consumedProofs.add(key); return { credential: providerCredential, identity: verifiedIdentity };
    });
    const composition = compose({ database: db, supabaseUrl: 'https://project.supabase.co',
      supabaseAnonKey: 'synthetic-anon', supabaseServiceRoleKey: 'synthetic-service', sessionSecret, webOrigin,
      emailProvider: { identity: 'synthetic-provider', send: async () => undefined, sendContent } });
    const invitation = await createTicketInvitationService(new PostgresTicketInvitationStore(db),
      composition.pmInvitation.policy, composition.pmInvitation.secretProtector, () => now).issue(firstTarget, pm);
    const pending = await db.query<{ payload: { protectedToken: string } }>(
      `select payload from alpha_private.ticket_outbox_events where workspace_id=$1 and ticket_id=$2
       and payload->>'activationVersion'='1'`, [workspaceId, firstTarget.ticketId]);
    const invitationToken = composition.pmInvitation.secretProtector.unprotect(pending.rows[0].payload.protectedToken,
      { workspaceId, ticketId: firstTarget.ticketId, invitationId: invitation.invitationId, expiresAt: invitation.expiresAt });
    expect(await invokeClientRoute(composition.router, 'GET', '/session')).toMatchObject({ status: 200, body: { authenticated: false } });
    const proof = { invitationToken, providerTokenHash, providerTokenType: 'invite' };
    expect(await invokeClientRoute(composition.router, 'POST', '/auth/activate', { body: proof, origin: 'https://foreign.example' }))
      .toMatchObject({ status: 403 });
    const activation = await invokeClientRoute(composition.router, 'POST', '/auth/activate', { body: proof });
    expect(activation).toMatchObject({ status: 200, body: { activated: true } });
    const setCookies = activation.headers['set-cookie'] as string[];
    expect(setCookies[0]).toContain('HttpOnly'); expect(setCookies[0]).toContain('Secure');
    expect(setCookies[0]).toContain('Path=/api/client');
    expect(setCookies[1]).not.toContain('HttpOnly'); expect(setCookies[1]).toContain('Path=/;');
    const cookie = setCookies.map(value => value.split(';')[0]).join('; ');
    const csrf = decodeURIComponent(setCookies[1].split(';')[0].split('=')[1]);
    expect(await invokeClientRoute(composition.router, 'GET', '/session', { cookie })).toMatchObject({ status: 200, body: { authenticated: true } });
    const queue = await invokeClientRoute(composition.router, 'GET', '/workspaces/:workspaceId/tickets', { cookie, params: { workspaceId } });
    expect(queue.status).toBe(200);
    expect((queue.body as { items: Array<{ id: string }> }).items.map(item => item.id)).toEqual([firstTarget.ticketId]);
    const detail = await invokeClientRoute(composition.router, 'GET', '/workspaces/:workspaceId/tickets/:ticketId', { cookie, params: { ...firstTarget } });
    expect(detail.status).toBe(200);
    expect(JSON.stringify(detail.body)).not.toMatch(/internal|contact|email_verified|protectedToken|providerCredential/);
    await expect(invokeClientRoute(composition.router, 'GET', '/workspaces/:workspaceId/tickets/:ticketId', { cookie, params: { ...secondTarget } }))
      .rejects.toMatchObject({ status: 404 });
    expect(await invokeClientRoute(composition.router, 'POST', '/session/logout', { cookie, body: {} })).toMatchObject({ status: 403 });
    expect(await invokeClientRoute(composition.router, 'POST', '/session/logout', { cookie, csrf, body: {} })).toMatchObject({ status: 204 });
    expect(await invokeClientRoute(composition.router, 'GET', '/session', { cookie })).toMatchObject({ status: 200, body: { authenticated: false } });
    const returning = await invokeClientRoute(composition.router, 'POST', '/auth/sign-in-link', { body: { email: clientEmail } });
    expect(returning).toMatchObject({ status: 202, body: { accepted: true } });
    expect(sendContent).toHaveBeenCalledWith(clientEmail, 'Your Alpha client sign-in link', expect.stringContaining('/#/client/activate?'), expect.any(String));
    const signedIn = await invokeClientRoute(composition.router, 'POST', '/auth/session', { body: { providerTokenHash, providerTokenType: 'magiclink' } });
    expect(signedIn).toMatchObject({ status: 200, body: { authenticated: true } });
    expect(await invokeClientRoute(composition.router, 'POST', '/auth/session', { body: { providerTokenHash, providerTokenType: 'magiclink' } }))
      .toMatchObject({ status: 401 });
  }, 60_000);
});
