import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import type { TicketClientSessionRecord, TicketClientSessionStore } from '../store/ticketClientSessionStore.js';
import type { TicketSubject } from '../store/ticketCommandStore.js';
import { createTicketClientSessionService } from './ticketClientSessionService.js';

const identity = { userId: 'provider-user-1', email: 'client@example.test', emailVerified: true };
const sessionHash = (purpose: 'session' | 'csrf', value: string) => createHash('sha256')
  .update(`alpha-client-${purpose}-v1\0`, 'utf8').update(value, 'utf8').digest('hex');

function fixture(activeGrant = true) {
  let instant = new Date('2026-10-08T12:00:00.000Z');
  const rows = new Map<string, TicketClientSessionRecord>();
  const audits: unknown[] = [];
  const tx = {
    hasActiveClientServiceGrant: vi.fn(async (userId: string) => activeGrant && userId === identity.userId),
    insertSession: vi.fn(async (record: TicketClientSessionRecord) => { rows.set(record.sessionIdHash, { ...record }); }),
    revokeSession: vi.fn(async (id: string, userId: string, revokedAt: string) => {
      const row = rows.get(id);
      if (!row || row.providerUserId !== userId || row.revokedAt !== null) return false;
      rows.set(id, { ...row, revokedAt });
      return true;
    }),
    appendAudit: vi.fn(async (audit: unknown) => { audits.push(audit); }),
  };
  const store = {
    resolveSession: vi.fn(async (id: string) => rows.get(id) ?? null),
    resolveClientName: vi.fn(async () => '  Test client  '),
    transaction: vi.fn(async (work: (transaction: typeof tx) => Promise<unknown>) => work(tx)),
  } as unknown as TicketClientSessionStore;
  const verifier = { verifyCredential: vi.fn(async () => identity),
    getVerifiedEmail: vi.fn(async (userId: string) => userId === identity.userId ? identity.email : null) };
  const service = createTicketClientSessionService(
    store, verifier, { lifetimeMs: 30 * 60 * 1000 }, () => new Date(instant),
  );
  return { service, store, verifier, tx, rows, audits, advanceTime: (date: string) => { instant = new Date(date); } };
}

describe('client session application service', () => {
  it('issues raw browser secrets once but persists only purpose-separated hashes', async () => {
    const f = fixture();
    const issued = await f.service.exchange('verified-provider-credential');

    expect(issued).not.toBeNull();
    expect(issued?.sessionCookieValue).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued?.csrfCookieValue).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued?.expiresAt).toBe('2026-10-08T12:30:00.000Z');
    const stored = [...f.rows.values()][0];
    expect(stored.sessionIdHash).toBe(sessionHash('session', issued!.sessionCookieValue));
    expect(stored.csrfHash).toBe(sessionHash('csrf', issued!.csrfCookieValue));
    expect(JSON.stringify(stored)).not.toContain(issued!.sessionCookieValue);
    expect(JSON.stringify(stored)).not.toContain(issued!.csrfCookieValue);
    expect(JSON.stringify(stored)).not.toContain('verified-provider-credential');
    expect(f.audits).toEqual([{
      providerUserId: identity.userId, type: 'client_session_created', occurredAt: '2026-10-08T12:00:00.000Z',
    }]);
  });

  it('does not create an open-signup session without a prior client service grant', async () => {
    const f = fixture(false);

    await expect(f.service.exchange('verified-provider-credential')).resolves.toBeNull();
    expect(f.tx.hasActiveClientServiceGrant).toHaveBeenCalledWith(identity.userId);
    expect(f.tx.insertSession).not.toHaveBeenCalled();
    expect(f.tx.appendAudit).not.toHaveBeenCalled();
    expect(f.rows.size).toBe(0);
  });

  it('requires the exact CSRF cookie/header pair and returns only the client identity', async () => {
    const f = fixture();
    const issued = await f.service.exchange('verified-provider-credential');
    const session = issued!.sessionCookieValue;
    const csrf = issued!.csrfCookieValue;

    await expect(f.service.authenticate(session, csrf, csrf, true)).resolves.toEqual({
      kind: 'authenticated',
      subject: { kind: 'client', userId: identity.userId, sessionId: sessionHash('session', session) },
      expiresAt: issued!.expiresAt,
    });
    await expect(f.service.authenticate(session, csrf, 'A'.repeat(43), true)).resolves.toEqual({ kind: 'csrf_invalid' });
    await expect(f.service.authenticate(session, undefined, undefined, true)).resolves.toEqual({ kind: 'csrf_invalid' });
    expect(f.store.resolveSession).toHaveBeenCalledTimes(3);
  });

  it('resolves only the current verified email for the authenticated provider identity', async () => {
    const f = fixture();
    const subject = { kind: 'client' as const, userId: identity.userId, sessionId: 'a'.repeat(64) };
    await expect(f.service.emailFor(subject)).resolves.toBe(identity.email);
    expect(f.verifier.getVerifiedEmail).toHaveBeenCalledWith(identity.userId);
    await expect(f.service.emailFor({ ...subject, userId: 'another-user' })).resolves.toBeNull();
    f.verifier.getVerifiedEmail.mockRejectedValueOnce(new Error('provider unavailable'));
    await expect(f.service.emailFor(subject)).resolves.toBeNull();
  });

  it('refuses expired sessions at the expiry boundary', async () => {
    const f = fixture();
    const issued = await f.service.exchange('verified-provider-credential');
    f.advanceTime(issued!.expiresAt);

    await expect(f.service.authenticate(issued!.sessionCookieValue)).resolves.toEqual({ kind: 'unauthenticated' });
  });

  it('returns a bounded contact name and keeps display lookup failures separate from authentication', async () => {
    const f = fixture();
    const subject = { kind: 'client' as const, userId: identity.userId, sessionId: 'a'.repeat(64) };
    await expect(f.service.nameFor(subject)).resolves.toBe('Test client');
    expect(f.store.resolveClientName).toHaveBeenCalledWith(identity.userId);
    vi.mocked(f.store.resolveClientName!).mockResolvedValueOnce('x'.repeat(201));
    await expect(f.service.nameFor(subject)).resolves.toBeNull();
    vi.mocked(f.store.resolveClientName!).mockRejectedValueOnce(new Error('profile lookup unavailable'));
    await expect(f.service.nameFor(subject)).resolves.toBeNull();
    vi.mocked(f.store.resolveClientName!).mockClear();
    await expect(f.service.nameFor({ ...subject, sessionId: 'invalid' })).resolves.toBeNull();
    expect(f.store.resolveClientName).not.toHaveBeenCalled();
  });

  it('revokes only the exact current client session and makes it unusable', async () => {
    const f = fixture();
    const issued = await f.service.exchange('verified-provider-credential');
    const authenticated = await f.service.authenticate(issued!.sessionCookieValue);
    if (authenticated.kind !== 'authenticated') throw new Error('Expected a valid client session.');

    await f.service.revoke(authenticated.subject as Extract<TicketSubject, { kind: 'client' }>);

    expect(f.tx.revokeSession).toHaveBeenCalledWith(
      sessionHash('session', issued!.sessionCookieValue), identity.userId, '2026-10-08T12:00:00.000Z',
    );
    expect(f.audits).toHaveLength(2);
    await expect(f.service.authenticate(issued!.sessionCookieValue)).resolves.toEqual({ kind: 'unauthenticated' });
  });
});
