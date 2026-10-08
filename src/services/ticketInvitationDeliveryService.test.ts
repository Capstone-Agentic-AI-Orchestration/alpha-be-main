import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import type {
  TicketInvitationDeliveryClaim, TicketInvitationDeliveryStore,
} from '../store/ticketInvitationDeliveryStore.js';
import { createTicketInvitationDeliveryService, type TicketInvitationDeliveryPolicy, type TicketInvitationEmailProvider } from './ticketInvitationDeliveryService.js';
import { createTicketInvitationSecretProtector } from '../ticketing/invitationSecret.js';

const now = new Date('2026-10-08T10:00:00.000Z');
const token = Buffer.alloc(32, 23).toString('base64url');
const secretContext = { workspaceId: 'ws-1', ticketId: 'ticket-1', invitationId: 'invite-1', expiresAt: '2026-10-09T10:00:00.000Z' };
const protector = createTicketInvitationSecretProtector('key-1', new Map([['key-1', new Uint8Array(32).fill(7)]]));
const policy: TicketInvitationDeliveryPolicy = {
  webOrigin: 'https://alpha.example', leaseDurationMs: 30_000,
  maxAttempts: 3, retryBaseDelayMs: 1000, retryMaxDelayMs: 60_000,
};

function makeClaim(overrides: Partial<TicketInvitationDeliveryClaim> = {}): TicketInvitationDeliveryClaim {
  return {
    eventId: 'event-1', leaseToken: 'lease-1', attempt: 1,
    signal: {
      type: 'ticket_invitation_requested', target: { workspaceId: 'ws-1', ticketId: 'ticket-1' },
      invitationId: 'invite-1', protectedToken: protector.protect(token, secretContext), occurredAt: '2026-10-08T09:00:00.000Z',
    },
    invitation: {
      id: secretContext.invitationId, workspaceId: secretContext.workspaceId, ticketId: secretContext.ticketId,
      expiresAt: secretContext.expiresAt, contactBindingId: 'contact-1',
      secretHash: createHash('sha256').update(Buffer.from(token, 'base64url')).digest('hex'),
      status: 'pending', createdAt: '2026-10-08T09:00:00.000Z',
    },
    ticket: {
      id: 'ticket-1', workspaceId: 'ws-1', status: 'under_review', clientId: null,
      scopeVersionId: null, agreedScopeVersionId: null, authorizedScopeVersionId: null,
      projectId: null, requiredIssueIds: [],
    },
    contact: { bindingId: 'contact-1', source: 'public_inquiry', email: 'Client@Example.com', emailVerified: false },
    ...overrides,
  };
}

function fixture(claim = makeClaim()) {
  const store: TicketInvitationDeliveryStore = {
    claimNext: vi.fn(async () => claim),
    markDelivered: vi.fn(async () => true),
    scheduleRetry: vi.fn(async () => true),
    deadLetter: vi.fn(async () => true),
    discard: vi.fn(async () => true),
  };
  const provider: TicketInvitationEmailProvider = { send: vi.fn(async () => {}) };
  const service = createTicketInvitationDeliveryService(store, provider, protector, policy, () => now);
  return { store, provider, service };
}

describe('ticket invitation delivery service', () => {
  it('sends a minimal plain-text invitation from the claimed immutable contact', async () => {
    const { store, provider, service } = fixture();

    await expect(service.deliverNext()).resolves.toEqual({ kind: 'delivered' });

    expect(store.claimNext).toHaveBeenCalledWith({
      now: now.toISOString(), leaseUntil: '2026-10-08T10:00:30.000Z',
    });
    expect(provider.send).toHaveBeenCalledTimes(1);
    const message = vi.mocked(provider.send).mock.calls[0][0];
    expect(message.to).toBe('client@example.com');
    expect(message.subject).toBe('Your Alpha client portal invitation');
    expect(message.text).toContain(`https://alpha.example/#/client/activate?token=${token}`);
    expect(message.text).toContain('2026-10-09T10:00:00.000Z');
    expect(message.text).not.toContain('ticket-1');
    expect(message.text).not.toContain('client@example.com');
    expect(message.idempotencyKey).toBe('ticket-invitation:ws-1:invite-1');
    expect(store.markDelivered).toHaveBeenCalledWith(expect.anything(), now.toISOString());
  });

  it('retries the same outbox event after a provider failure without exposing provider details', async () => {
    const { store, provider, service } = fixture(makeClaim({ attempt: 2 }));
    vi.mocked(provider.send).mockRejectedValueOnce(new Error('private SMTP credentials and host'));

    await expect(service.deliverNext()).resolves.toEqual({ kind: 'retry_scheduled', retryAt: '2026-10-08T10:00:02.000Z' });

    expect(store.scheduleRetry).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'event-1' }), '2026-10-08T10:00:02.000Z', 'provider_failure');
    expect(store.deadLetter).not.toHaveBeenCalled();
  });

  it('dead-letters a token whose digest does not match the invitation verifier', async () => {
    const claim = makeClaim({ invitation: { ...makeClaim().invitation, secretHash: '0'.repeat(64) } });
    const { store, provider, service } = fixture(claim);

    await expect(service.deliverNext()).resolves.toEqual({ kind: 'dead_lettered' });

    expect(store.deadLetter).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'event-1' }), now.toISOString(), 'secret_integrity_failure');
    expect(provider.send).not.toHaveBeenCalled();
  });

  it.each([
    ['expired', makeClaim({ invitation: { ...makeClaim().invitation, expiresAt: '2026-10-08T09:59:59.000Z' } })],
    ['contact_changed', makeClaim({ contact: { ...makeClaim().contact, bindingId: 'different-contact' } })],
    ['ticket_ineligible', makeClaim({ ticket: { ...makeClaim().ticket, status: 'declined' } })],
  ] as const)('suppresses an invitation when its current %s evidence is no longer eligible', async (reason, claim) => {
    const { store, provider, service } = fixture(claim);

    await expect(service.deliverNext()).resolves.toEqual({ kind: 'suppressed', reason });

    expect(store.discard).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'event-1' }), now.toISOString(), reason);
    expect(provider.send).not.toHaveBeenCalled();
  });

  it('reports an unknown delivery outcome if provider accepted but the lease no longer owns completion', async () => {
    const { store, provider, service } = fixture();
    vi.mocked(store.markDelivered).mockResolvedValueOnce(false);

    await expect(service.deliverNext()).resolves.toEqual({ kind: 'outcome_unknown' });

    expect(provider.send).toHaveBeenCalledTimes(1);
    expect(store.scheduleRetry).not.toHaveBeenCalled();
  });

  it('rejects insecure non-loopback email origins before claiming work', () => {
    expect(() => createTicketInvitationDeliveryService(
      { claimNext: vi.fn() } as unknown as TicketInvitationDeliveryStore,
      { send: vi.fn() }, protector,
      { ...policy, webOrigin: 'http://alpha.example' }, () => now,
    )).toThrow('Invitation delivery configuration is invalid.');
  });
});
