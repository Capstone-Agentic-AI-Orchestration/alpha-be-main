import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDatabase, sqlFor } from './testDatabase.js';
import type { TransactionalSql } from './database.js';
import { PostgresTicketClientAccountStore } from './ticketClientAccountPostgresStore.js';
import { PostgresTicketClientActivationStore } from './ticketClientActivationPostgresStore.js';
import { PostgresTicketClientSessionStore } from './ticketClientSessionPostgresStore.js';
import { PostgresTicketClientSignInStore } from './ticketClientSignInPostgresStore.js';
import { PostgresTicketInvitationStore } from './ticketInvitationPostgresStore.js';
import { PostgresTicketPublicIntakeStore } from './ticketPublicIntakePostgresStore.js';
import { PostgresTicketTriageStore } from './ticketTriagePostgresStore.js';
import { createTicketClientAccountService } from '../services/ticketClientAccountService.js';
import { createTicketClientActivationService } from '../services/ticketClientActivationService.js';
import { createTicketClientSessionService } from '../services/ticketClientSessionService.js';
import { createTicketPublicIntakeService } from '../services/ticketPublicIntakeService.js';
import { createTicketCommandService } from '../services/ticketCommandService.js';
import { createTicketInvitationService } from '../services/ticketInvitationService.js';
import type { TicketClientIdentityProvider } from '../services/ticketClientIdentityProvider.js';
import type { TicketSubject } from './ticketCommandStore.js';
import { createClientTicketInvitationSecretProtector } from '../ticketing/clientTicketSecrets.js';
import { createTicketClientAccountRouter } from '../controllers/ticketClientAccountController.js';
import type { Router } from 'express';

vi.mock('../config/env.js', async original => ({ ...await original<typeof import('../config/env.js')>(), IS_CLOUD: true }));
const userId = '00000000-0000-4000-8000-000000000064';
const email = 'account-client@example.test';
const origin = 'https://accounts.example.test';
const workspaceId = 'account-workspace';
const secret = 'account-setup-test-secret-of-sufficient-length';
const credential = 'verified-provider-credential';
const initialPassword = 'first-password-123';
const pm: TicketSubject = { kind: 'internal', userId: 'account-pm',
  authentication: { kind: 'verified_github_bearer', verificationId: 'account-test' } };
let pg: PGlite;
let db: TransactionalSql;
let currentPassword: string;
let provider: TicketClientIdentityProvider;
let app: ReturnType<typeof createTicketClientAccountService>;
let sessions: ReturnType<typeof createTicketClientSessionService>;
const sendContent = vi.fn(async () => undefined);

beforeEach(async () => {
  pg = await createTestDatabase();
  const sql = sqlFor(pg);
  db = { ...sql, transaction: work => pg.transaction(tx => work(sqlFor(tx as unknown as PGlite))) };
  currentPassword = ''; sendContent.mockClear();
  await db.query(`create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,encrypted_password text)`);
  await db.query(`insert into auth.users values ($1,$2,now(),'')`, [userId, email]);
  await db.query(`insert into public.workspaces(id,name,slug,status,settings_json)
    values ($1,'Account tests','account-tests','active','{"ticketing_write_mode":"enabled"}')`, [workspaceId]);
  await db.query(`insert into public.workspace_members(id,workspace_id,user_id,role)
    values ('account-pm-member',$1,'account-pm','pm')`, [workspaceId]);
  await db.query(`insert into alpha_private.ticket_intake_entries
    (id,workspace_id,slug,company_label,published,write_mode,policy_version,per_source_max,per_entry_max,window_seconds)
    values ('account-intake',$1,'account-intake','Account tests',true,'enabled','v1',30,30,60)`, [workspaceId]);
  const identity = { userId, email, emailVerified: true };
  provider = {
    verifyEmailLink: vi.fn(async () => ({ credential, identity })),
    verifyCredential: vi.fn(async () => identity),
    signInWithPassword: vi.fn(async (address, password) => address === email && password === currentPassword && password
      ? { credential, identity } : null),
    setPassword: vi.fn(async (_proof, password) => {
      currentPassword = password;
      await db.query(`update auth.users set encrypted_password='configured' where id=$1`, [userId]);
    }),
    generateRecoveryLink: vi.fn(async () => ({ userId, tokenHash: 'recovery-proof-with-sufficient-length' })),
  } as unknown as TicketClientIdentityProvider;
  const activationStore = new PostgresTicketClientActivationStore(db);
  const activate = createTicketClientActivationService(activationStore, provider);
  sessions = createTicketClientSessionService(new PostgresTicketClientSessionStore(db), provider, { lifetimeMs: 3600000 });
  app = createTicketClientAccountService({ store: new PostgresTicketClientAccountStore(db),
    signInStore: new PostgresTicketClientSignInStore(db), activationStore, provider, sessions,
    activate: activate.activate, emailProvider: { identity: 'test', send: vi.fn(), sendContent }, webOrigin: origin, secret });
}, 60000);
afterEach(async () => { await pg?.close(); });

async function invite(ticketId = 'account-ticket') {
  const now = new Date();
  const intake = createTicketPublicIntakeService(new PostgresTicketPublicIntakeStore(db), {
    async admitRequest(entry) { return { entryId: entry.id, rateSubjectKey: 'b'.repeat(64),
      issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60000).toISOString() }; },
  }, { fingerprintKeys: [{ id: 'test', secret: new Uint8Array(32).fill(7) }], maxRequestAgeMs: 60000 }, () => now, () => ticketId);
  await intake.submit('account-intake', { schemaVersion: 1, operationId: crypto.randomUUID(), fullName: 'Test client',
    email, company: null, title: 'A client request', description: 'A real persisted inquiry for account setup tests.', requestedDeadline: null },
  { origin, remoteAddress: '192.0.2.65' });
  const target = { workspaceId, ticketId };
  await createTicketCommandService(new PostgresTicketTriageStore(db)).execute(target, pm,
    { schemaVersion: 1, operationId: `review-${ticketId}`, expectedVersion: 0, command: { type: 'review' } });
  const protector = createClientTicketInvitationSecretProtector(secret).invitation;
  const receipt = await createTicketInvitationService(new PostgresTicketInvitationStore(db), { lifetimeMs: 3600000 }, protector).issue(target, pm);
  const pending = await db.query<{ payload: { protectedToken: string } }>(
    `select payload from alpha_private.ticket_outbox_events where ticket_id=$1 and event_type='ticket_invitation_requested'`, [ticketId]);
  const invitationToken = protector.unprotect(pending.rows[0].payload.protectedToken,
    { ...target, invitationId: receipt.invitationId, expiresAt: receipt.expiresAt });
  return { invitationToken, providerTokenHash: 'provider-proof-with-sufficient-length', providerTokenType: 'invite' as const };
}

function invoke(router: Router, method: 'get' | 'post', path: string, body?: unknown, cookie?: string, csrf?: string, requestOrigin = origin) {
  const handler = (router as any).stack.find((layer: any) => layer.route?.path === path && layer.route.methods[method]).route.stack[0].handle;
  return new Promise<{ status: number; body: any; headers: Record<string, string | string[]> }>((resolve, reject) => {
    let status = 200; const headers: Record<string, string | string[]> = {};
    const req = { body, headers: { cookie }, get: (name: string) => name.toLowerCase() === 'origin' ? requestOrigin : csrf,
      is: () => true };
    const res = { setHeader: (name: string, value: string | string[]) => { headers[name.toLowerCase()] = value; },
      append: (name: string, value: string[]) => { headers[name.toLowerCase()] = [...(headers[name.toLowerCase()] as string[] ?? []), ...value]; },
      status: (value: number) => { status = value; return res; },
      json: (value: unknown) => { resolve({ status, body: value, headers }); return res; } };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

describe('client password account workflow on PostgreSQL', () => {
  it('preserves the inquiry, verifies the invitation, resumes setup, then signs into the same account', async () => {
    const link = await invite();
    const router = createTicketClientAccountRouter(app, { secure: true, allowedOrigins: [origin] },
      { check: async () => ({ allowed: true, retryAfterSeconds: null }) });
    expect((await invoke(router, 'post', '/auth/setup/link', link, undefined, undefined, 'https://foreign.test')).status).toBe(403);
    const begun = await invoke(router, 'post', '/auth/setup/link', link);
    expect(begun.status).toBe(200);
    expect(begun.body).toMatchObject({ email, action: 'set_password' });
    expect(JSON.stringify(begun.body)).not.toMatch(/token|credential|csrf/);
    const cookieParts = begun.headers['set-cookie'] as string[];
    expect(cookieParts[0]).toContain('HttpOnly'); expect(cookieParts[0]).toContain('Secure');
    const cookie = cookieParts.map(value => value.split(';')[0]).join('; ');
    const csrf = cookieParts[1].split(';')[0].split('=')[1];
    expect((await invoke(router, 'get', '/auth/setup', undefined, cookie)).body).toEqual(begun.body);
    expect((await db.query(`select * from alpha_private.ticket_client_grants`)).rows).toHaveLength(0);
    expect((await invoke(router, 'post', '/auth/setup/complete', { password: initialPassword }, cookie)).status).toBe(403);
    const finished = await invoke(router, 'post', '/auth/setup/complete', { password: initialPassword }, cookie, csrf);
    expect(finished.status).toBe(200); expect(finished.body.authenticated).toBe(true);
    expect((await db.query(`select client_user_id from alpha_private.ticket_client_grants`)).rows).toEqual([{ client_user_id: userId }]);
    expect((await db.query(`select email_verified from alpha_private.ticket_contacts`)).rows[0]).toEqual({ email_verified: true });
    const session = await app.signIn({ email: ` ${email.toUpperCase()} `, password: initialPassword });
    expect(await sessions.authenticate(session.sessionCookieValue)).toMatchObject({ kind: 'authenticated', subject: { userId } });
    expect((await invoke(router, 'post', '/auth/setup/complete', { password: 'replacement-password' }, cookie, csrf)).status).toBe(404);
    expect(provider.setPassword).toHaveBeenCalledTimes(1);
    expect((await db.query(`select * from auth.users`)).rows).toHaveLength(1);
    expect((await db.query(`select protected_proof from alpha_private.ticket_client_account_setups`)).rows).toEqual([{ protected_proof: null }]);
  }, 60000);

  it('lets an invited identity choose its password even when Supabase has a provider-side password hash', async () => {
    await db.query(`update auth.users set encrypted_password='provider-generated-hash' where id=$1`, [userId]);
    await db.query(`insert into alpha_private.ticket_service_grants
      (id,workspace_id,client_user_id,status,display_name) values ('legacy-client-grant',$1,$2,'active','Legacy client')`, [workspaceId, userId]);
    const setup = await app.begin(await invite());
    expect(setup.action).toBe('set_password');
    await expect(app.finish(setup.token, setup.csrf, { password: initialPassword })).resolves.toHaveProperty('sessionCookieValue');
    expect(currentPassword).toBe(initialPassword);
    expect(provider.setPassword).toHaveBeenCalledOnce();
    expect((await db.query(`select client_user_id from alpha_private.ticket_client_password_credentials`)).rows)
      .toEqual([{ client_user_id: userId }]);
  }, 60000);

  it('does not admit unknown accounts or a wrong password', async () => {
    await expect(app.signIn({ email, password: initialPassword })).rejects.toMatchObject({ status: 401 });
    expect(provider.signInWithPassword).not.toHaveBeenCalled();
    const setup = await app.begin(await invite()); await app.finish(setup.token, setup.csrf, { password: initialPassword });
    await expect(app.signIn({ email, password: 'wrong-password' })).rejects.toMatchObject({ status: 401 });
    await expect(app.signIn({ email: 'unknown@example.test', password: initialPassword })).rejects.toMatchObject({ status: 401 });
  }, 60000);

  it('keeps recovery generic and revokes old Alpha cookies when resetting the password', async () => {
    const setup = await app.begin(await invite());
    const old = await app.finish(setup.token, setup.csrf, { password: initialPassword });
    expect(await app.recover({ email: 'unknown@example.test' })).toEqual({ accepted: true });
    expect(sendContent).not.toHaveBeenCalled();
    expect(await app.recover({ email })).toEqual({ accepted: true });
    expect(sendContent).toHaveBeenCalledWith(email, 'Set your Alpha client password', expect.stringContaining('providerTokenType=recovery'), expect.any(String));
    const recovery = await app.begin({ providerTokenHash: 'recovery-proof-with-sufficient-length', providerTokenType: 'recovery' });
    expect(recovery.action).toBe('reset_password');
    const renewed = await app.finish(recovery.token, recovery.csrf, { password: 'replacement-password-123' });
    expect(await sessions.authenticate(old.sessionCookieValue)).toEqual({ kind: 'unauthenticated' });
    expect(await sessions.authenticate(renewed.sessionCookieValue)).toMatchObject({ kind: 'authenticated' });
    await expect(app.signIn({ email, password: initialPassword })).rejects.toMatchObject({ status: 401 });
    await expect(app.signIn({ email, password: 'replacement-password-123' })).resolves.toHaveProperty('sessionCookieValue');
  }, 60000);

  it('requires the existing password for another invitation and never replaces it', async () => {
    const first = await app.begin(await invite()); await app.finish(first.token, first.csrf, { password: initialPassword });
    const second = await app.begin(await invite('account-ticket-two'));
    expect(second.action).toBe('sign_in');
    await expect(app.finish(second.token, second.csrf, { password: 'wrong-password' })).rejects.toMatchObject({ status: 401 });
    await app.finish(second.token, second.csrf, { password: initialPassword });
    expect(provider.setPassword).toHaveBeenCalledTimes(1);
    expect((await db.query(`select client_user_id from alpha_private.ticket_client_grants`)).rows)
      .toEqual([{ client_user_id: userId }, { client_user_id: userId }]);
  }, 60000);

  it('rejects mismatched email proof, expired setup, weak passwords and revoked invitations', async () => {
    const link = await invite();
    vi.mocked(provider.verifyEmailLink).mockResolvedValueOnce({ credential, identity: { userId, email: 'other@example.test', emailVerified: true } });
    await expect(app.begin(link)).rejects.toMatchObject({ status: 404 });
    const setup = await app.begin(link);
    await expect(app.finish(setup.token, setup.csrf, { password: 'short' })).rejects.toMatchObject({ status: 400 });
    await db.query(`update alpha_private.ticket_invitations set status='revoked'`);
    await expect(app.finish(setup.token, setup.csrf, { password: initialPassword })).rejects.toMatchObject({ status: 404 });
    expect(provider.setPassword).not.toHaveBeenCalled();
    await db.query(`update alpha_private.ticket_client_account_setups set expires_at=now()-interval '1 second',created_at=now()-interval '1 hour'`);
    await expect(app.inspect(setup.token)).rejects.toMatchObject({ status: 404 });
  }, 60000);

  it('recovers a provider password success followed by a lost response without a duplicate account', async () => {
    const setup = await app.begin(await invite());
    const set = vi.mocked(provider.setPassword).getMockImplementation()!;
    vi.mocked(provider.setPassword).mockImplementationOnce(async (proof, password) => { await set(proof, password); throw new Error('lost provider response'); });
    await expect(app.finish(setup.token, setup.csrf, { password: initialPassword })).rejects.toThrow();
    // Supabase can invalidate the original credential after changing the password.
    vi.mocked(provider.verifyCredential).mockResolvedValueOnce(null);
    await expect(app.finish(setup.token, setup.csrf, { password: 'wrong-password' })).rejects.toMatchObject({ status: 401 });
    vi.mocked(provider.verifyCredential).mockResolvedValueOnce(null);
    await expect(app.finish(setup.token, setup.csrf, { password: initialPassword })).resolves.toHaveProperty('sessionCookieValue');
    expect(provider.setPassword).toHaveBeenCalledTimes(1);
    expect((await db.query(`select * from alpha_private.ticket_client_grants`)).rows).toHaveLength(1);
  }, 60000);

  it('migrates an existing passwordless client without creating a new identity or inquiry', async () => {
    const link = await invite();
    await createTicketClientActivationService(new PostgresTicketClientActivationStore(db), provider)
      .activate({ invitationToken: link.invitationToken, providerCredential: credential });
    const setup = await app.begin({ providerTokenHash: 'legacy-sign-in-proof-long-enough', providerTokenType: 'magiclink' });
    expect(setup.action).toBe('set_password');
    await app.finish(setup.token, setup.csrf, { password: initialPassword });
    expect((await db.query(`select * from alpha_private.tickets`)).rows).toHaveLength(1);
    expect((await db.query(`select * from auth.users`)).rows).toHaveLength(1);
    expect((await db.query(`select client_user_id from alpha_private.ticket_client_grants`)).rows).toEqual([{ client_user_id: userId }]);
  }, 60000);
});
