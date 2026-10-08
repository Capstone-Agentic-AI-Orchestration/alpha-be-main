import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import type { TicketInvitationRecord, TicketInvitationStore } from '../store/ticketInvitationStore.js';
import type { LockedTicket, TicketSubject, TicketTarget } from '../store/ticketCommandStore.js';
import { createTicketInvitationSecretProtector } from '../ticketing/invitationSecret.js';
import { newTicketWorkflow } from '../ticketing/workflow.js';
import { createTicketInvitationService } from './ticketInvitationService.js';

const target: TicketTarget = { workspaceId: 'workspace-1', ticketId: 'ticket-1' };
const pm: TicketSubject = { kind: 'internal', userId: 'pm-1', authentication: { kind: 'session', sessionId: 'pm-session' } };
const now = new Date('2026-10-08T12:00:00.000Z');
const contact = { bindingId: 'contact-1', source: 'public_inquiry' as const, email: 'Client@Example.test', emailVerified: false };
const protector = createTicketInvitationSecretProtector('test-key', new Map([['test-key', new Uint8Array(32).fill(11)]]));

function fixture(options: {
  contact?: typeof contact | null;
  latest?: TicketInvitationRecord | null;
  actor?: LockedTicket['actor'];
  state?: LockedTicket['state'];
  mode?: LockedTicket['mode'];
  expireResult?: boolean;
  transactionError?: Error;
} = {}) {
  const trace: string[] = [];
  const inserted: TicketInvitationRecord[] = [];
  const audits: unknown[] = [];
  const signals: unknown[] = [];
  const state = options.state ?? {
    ...newTicketWorkflow(target.ticketId, target.workspaceId),
    version: 2, status: 'under_review' as const, nextAction: 'reply' as const,
  };
  const ticket: LockedTicket = {
    state,
    actor: options.actor ?? { kind: 'pm', userId: pm.userId, workspaceId: target.workspaceId, membershipActive: true, canManageTickets: true },
    mode: options.mode ?? 'enabled',
  };
  const tx = {
    lockAuthorizedTicket: vi.fn(async () => { trace.push('authorize'); return ticket; }),
    loadInvitationContact: vi.fn(async () => { trace.push('contact'); return options.contact === undefined ? contact : options.contact; }),
    lockLatestInvitation: vi.fn(async () => { trace.push('latest'); return options.latest ?? null; }),
    expireInvitation: vi.fn(async () => { trace.push('expire'); return options.expireResult ?? true; }),
    insertInvitation: vi.fn(async (record: TicketInvitationRecord) => { trace.push('insert'); inserted.push(record); }),
    appendInvitationAudit: vi.fn(async (audit: unknown) => { trace.push('audit'); audits.push(audit); }),
    enqueueInvitationSignal: vi.fn(async (signal: unknown) => { trace.push('signal'); signals.push(signal); }),
  };
  const store = {
    transaction: vi.fn(async (work: (transaction: typeof tx) => Promise<unknown>) => {
      if (options.transactionError) throw options.transactionError;
      return work(tx);
    }),
  } as unknown as TicketInvitationStore;
  const service = createTicketInvitationService(
    store, { lifetimeMs: 24 * 60 * 60 * 1000 }, protector, () => now, () => 'invitation-new',
  );
  return { service, tx, trace, inserted, audits, signals };
}

describe('PM client-invitation application service', () => {
  it('stores only a token hash and emits an encrypted, context-bound delivery signal', async () => {
    const f = fixture();

    await expect(f.service.issue(target, pm)).resolves.toEqual({
      invitationId: 'invitation-new', ticketId: target.ticketId,
      expiresAt: '2026-10-09T12:00:00.000Z', alreadyPending: false,
    });

    expect(f.trace).toEqual(['authorize', 'contact', 'latest', 'insert', 'audit', 'signal']);
    const record = f.inserted[0];
    expect(record).toMatchObject({
      id: 'invitation-new', ...target, contactBindingId: contact.bindingId,
      status: 'pending', createdAt: now.toISOString(), expiresAt: '2026-10-09T12:00:00.000Z',
    });
    expect(record.secretHash).toMatch(/^[a-f0-9]{64}$/);
    expect(record).not.toHaveProperty('email');
    const signal = f.signals[0] as { type: string; target: TicketTarget; invitationId: string; protectedToken: string; occurredAt: string };
    expect(signal).toMatchObject({ type: 'ticket_invitation_requested', target, invitationId: record.id, occurredAt: now.toISOString() });
    expect(signal.protectedToken).not.toMatch(/^[A-Za-z0-9_-]{43}$/);
    const token = protector.unprotect(signal.protectedToken, {
      workspaceId: target.workspaceId, ticketId: target.ticketId, invitationId: record.id, expiresAt: record.expiresAt,
    });
    expect(createHash('sha256').update(Buffer.from(token, 'base64url')).digest('hex')).toBe(record.secretHash);
    expect(JSON.stringify(signal)).not.toContain(contact.email);
    expect(f.audits).toEqual([{
      target, invitationId: record.id, actorId: pm.userId, type: 'invitation_issued', occurredAt: now.toISOString(),
    }]);
  });

  it('reuses a valid pending invitation without creating a second delivery signal', async () => {
    const pending: TicketInvitationRecord = {
      id: 'invitation-existing', ...target, contactBindingId: contact.bindingId,
      secretHash: 'a'.repeat(64), status: 'pending', createdAt: '2026-10-08T11:00:00.000Z',
      expiresAt: '2026-10-09T11:00:00.000Z',
    };
    const f = fixture({ latest: pending });

    await expect(f.service.issue(target, pm)).resolves.toEqual({
      invitationId: pending.id, ticketId: target.ticketId, expiresAt: pending.expiresAt, alreadyPending: true,
    });

    expect(f.tx.insertInvitation).not.toHaveBeenCalled();
    expect(f.tx.appendInvitationAudit).not.toHaveBeenCalled();
    expect(f.tx.enqueueInvitationSignal).not.toHaveBeenCalled();
  });

  it('expires an old pending invitation before issuing a replacement', async () => {
    const expired: TicketInvitationRecord = {
      id: 'invitation-old', ...target, contactBindingId: contact.bindingId,
      secretHash: 'b'.repeat(64), status: 'pending', createdAt: '2026-10-01T11:00:00.000Z',
      expiresAt: '2026-10-08T11:00:00.000Z',
    };
    const f = fixture({ latest: expired });

    const receipt = await f.service.issue(target, pm);

    expect(f.trace).toEqual(['authorize', 'contact', 'latest', 'expire', 'audit', 'insert', 'audit', 'signal']);
    expect(f.tx.expireInvitation).toHaveBeenCalledWith(target, expired.id, now.toISOString());
    expect(f.audits).toEqual([
      { target, invitationId: expired.id, actorId: pm.userId, type: 'invitation_expired', occurredAt: now.toISOString() },
      { target, invitationId: receipt.invitationId, actorId: pm.userId, type: 'invitation_issued', occurredAt: now.toISOString() },
    ]);
  });

  it('refuses unverified-ineligible, non-PM, and pre-review invitation attempts', async () => {
    const badContact = fixture({ contact: { ...contact, emailVerified: true } });
    await expect(badContact.service.issue(target, pm)).rejects.toMatchObject({ status: 409, code: 'ticket_invitation_unavailable' });
    expect(badContact.tx.lockLatestInvitation).not.toHaveBeenCalled();
    expect(badContact.tx.insertInvitation).not.toHaveBeenCalled();

    const client: TicketSubject = { kind: 'client', userId: 'client-1', sessionId: 'c'.repeat(64) };
    const clientTicket = fixture({
      actor: { kind: 'client', userId: client.userId, workspaceId: target.workspaceId, ticketId: target.ticketId, grantActive: true },
      state: { ...newTicketWorkflow(target.ticketId, target.workspaceId, client.userId), status: 'under_review' },
    });
    await expect(clientTicket.service.issue(target, client)).rejects.toMatchObject({ status: 403, code: 'ticket_action_forbidden' });
    expect(clientTicket.tx.loadInvitationContact).not.toHaveBeenCalled();

    const received = fixture({ state: newTicketWorkflow(target.ticketId, target.workspaceId) });
    await expect(received.service.issue(target, pm)).rejects.toMatchObject({ status: 409, code: 'invalid_ticket_transition' });
    expect(received.tx.loadInvitationContact).not.toHaveBeenCalled();
  });

  it('does not issue a replacement if expiring the previous invitation loses its compare-and-set', async () => {
    const expired: TicketInvitationRecord = {
      id: 'invitation-old', ...target, contactBindingId: contact.bindingId,
      secretHash: 'd'.repeat(64), status: 'pending', createdAt: '2026-10-01T11:00:00.000Z',
      expiresAt: '2026-10-08T11:00:00.000Z',
    };
    const f = fixture({ latest: expired, expireResult: false });

    await expect(f.service.issue(target, pm)).rejects.toMatchObject({ status: 409, code: 'ticket_version_conflict' });
    expect(f.tx.insertInvitation).not.toHaveBeenCalled();
    expect(f.tx.enqueueInvitationSignal).not.toHaveBeenCalled();
  });
});
