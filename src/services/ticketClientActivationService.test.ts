import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import type { TicketClientActivationStore } from '../store/ticketClientActivationStore.js';
import { createTicketClientActivationService } from './ticketClientActivationService.js';

const token = Buffer.alloc(32, 37).toString('base64url');
const target = { workspaceId: 'workspace-1', ticketId: 'ticket-1' };
const invitation = {
  id: 'invitation-1', ...target, contactBindingId: 'contact-1', status: 'pending' as const,
  expiresAt: '2026-10-09T00:00:00.000Z',
};
const ticket = {
  id: target.ticketId, workspaceId: target.workspaceId, version: 3, status: 'under_review' as const,
  clientId: null, source: 'public_inquiry' as const,
};
const contact = { bindingId: 'contact-1', email: 'Client@Example.test' };
const identity = { userId: 'provider-user-1', email: 'client@example.test', emailVerified: true };

function fixture(options: {
  identity?: typeof identity | null;
  contact?: typeof contact | null;
  invitation?: typeof invitation | null;
  ticket?: typeof ticket | null;
  serviceGrant?: boolean;
  times?: string[];
} = {}) {
  const trace: string[] = [];
  const grants: unknown[] = [];
  const audits: unknown[] = [];
  const signals: unknown[] = [];
  const times = [...(options.times ?? ['2026-10-08T12:00:00.000Z'])];
  const tx = {
    ensureClientServiceGrant: vi.fn(async () => { trace.push('service-grant'); return options.serviceGrant ?? true; }),
    lockInquiryTicket: vi.fn(async () => { trace.push('ticket'); return options.ticket === undefined ? ticket : options.ticket; }),
    lockInvitationBySecretHash: vi.fn(async () => { trace.push('invitation'); return options.invitation === undefined ? invitation : options.invitation; }),
    loadOriginalContact: vi.fn(async () => { trace.push('contact'); return options.contact === undefined ? contact : options.contact; }),
    consumeInvitation: vi.fn(async () => { trace.push('consume'); return true; }),
    bindTicketClient: vi.fn(async () => { trace.push('bind-ticket'); return true; }),
    insertTicketGrant: vi.fn(async (grant: unknown) => { trace.push('ticket-grant'); grants.push(grant); }),
    appendActivationAudit: vi.fn(async (audit: unknown) => { trace.push('audit'); audits.push(audit); }),
    enqueueActivationSignal: vi.fn(async (signal: unknown) => { trace.push('signal'); signals.push(signal); }),
  };
  const store = {
    resolveTargetBySecretHash: vi.fn(async (hash: string) => {
      expect(hash).toBe(createHash('sha256').update(Buffer.from(token, 'base64url')).digest('hex'));
      return target;
    }),
    transaction: vi.fn(async (work: (transaction: typeof tx) => Promise<unknown>) => work(tx)),
  } as unknown as TicketClientActivationStore;
  const verifier = { verifyCredential: vi.fn(async () => options.identity === undefined ? identity : options.identity) };
  const service = createTicketClientActivationService(
    store, verifier, () => new Date(times.shift() ?? '2026-10-08T12:00:00.000Z'),
  );
  return { service, store, verifier, tx, trace, grants, audits, signals };
}

describe('client invitation activation application service', () => {
  it('binds one verified identity to only the invited ticket, in authorization-first order', async () => {
    const f = fixture();

    await expect(f.service.activate({ invitationToken: token, providerCredential: 'provider-credential' }))
      .resolves.toEqual({ activated: true });

    expect(f.trace).toEqual(['service-grant', 'ticket', 'invitation', 'contact', 'consume', 'bind-ticket', 'ticket-grant', 'audit', 'signal']);
    expect(f.tx.ensureClientServiceGrant).toHaveBeenCalledWith(target.workspaceId, identity.userId, '2026-10-08T12:00:00.000Z');
    expect(f.tx.insertTicketGrant).toHaveBeenCalledWith({
      invitationId: invitation.id, ...target, clientUserId: identity.userId,
    }, '2026-10-08T12:00:00.000Z');
    expect(f.grants).toHaveLength(1);
    expect(f.audits).toHaveLength(1);
    expect(f.signals).toEqual([{ target, type: 'ticket_client_activated', occurredAt: '2026-10-08T12:00:00.000Z' }]);
  });

  it('rejects a different verified email without consuming the invitation or granting the ticket', async () => {
    const f = fixture({ identity: { ...identity, email: 'someone-else@example.test' } });

    await expect(f.service.activate({ invitationToken: token, providerCredential: 'provider-credential' }))
      .rejects.toMatchObject({ status: 404, code: 'client_invitation_unavailable' });

    expect(f.tx.consumeInvitation).not.toHaveBeenCalled();
    expect(f.tx.bindTicketClient).not.toHaveBeenCalled();
    expect(f.tx.insertTicketGrant).not.toHaveBeenCalled();
    expect(f.tx.appendActivationAudit).not.toHaveBeenCalled();
    expect(f.tx.enqueueActivationSignal).not.toHaveBeenCalled();
  });

  it('checks expiry after acquiring the ticket and invitation locks', async () => {
    const f = fixture({ times: ['2026-10-08T23:59:00.000Z', '2026-10-09T00:00:00.000Z'] });

    await expect(f.service.activate({ invitationToken: token, providerCredential: 'provider-credential' }))
      .rejects.toMatchObject({ status: 404, code: 'client_invitation_unavailable' });

    expect(f.trace).toEqual(['service-grant', 'ticket', 'invitation', 'contact']);
    expect(f.tx.consumeInvitation).not.toHaveBeenCalled();
  });

  it('does not look up or create a client grant for an invalid or unverified identity', async () => {
    const f = fixture({ identity: { ...identity, emailVerified: false } });

    await expect(f.service.activate({ invitationToken: token, providerCredential: 'provider-credential' }))
      .rejects.toMatchObject({ status: 404, code: 'client_invitation_unavailable' });
    await expect(f.service.activate({ invitationToken: 'not-a-token', providerCredential: 'provider-credential' }))
      .rejects.toMatchObject({ status: 404, code: 'client_invitation_unavailable' });

    expect(f.store.resolveTargetBySecretHash).not.toHaveBeenCalled();
    expect(f.store.transaction).not.toHaveBeenCalled();
    expect(f.tx.ensureClientServiceGrant).not.toHaveBeenCalled();
  });

  it('does not touch the ticket when a client-service grant is revoked', async () => {
    const f = fixture({ serviceGrant: false });

    await expect(f.service.activate({ invitationToken: token, providerCredential: 'provider-credential' }))
      .rejects.toMatchObject({ status: 404, code: 'client_invitation_unavailable' });

    expect(f.trace).toEqual(['service-grant']);
    expect(f.tx.lockInquiryTicket).not.toHaveBeenCalled();
  });
});
