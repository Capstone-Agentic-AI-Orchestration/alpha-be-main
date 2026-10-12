import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { TicketInvitationRecord, TicketInvitationStore } from '../store/ticketInvitationStore.js';
import { isTransactionOutcomeUnknown } from '../store/transactionOutcome.js';
import type { TicketSubject, TicketTarget } from '../store/ticketCommandStore.js';
import type { TicketInvitationSecretContext, TicketInvitationSecretProtector } from '../ticketing/invitationSecret.js';
import { TicketReadInvariantError } from '../ticketing/readModels.js';
import { TicketWorkflowError } from '../ticketing/workflow.js';
import { authorizeTicketAccess } from './ticketAccess.js';

const MAX_INVITATION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const opaque = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 200 && value.trim() === value;
function workflowError(status: 403 | 409 | 503, code: string, message: string): never {
  throw new TicketWorkflowError(status, code, message);
}
function canonicalEmail(value: string | null): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}
function validInvitation(row: TicketInvitationRecord, target: TicketTarget): boolean {
  return opaque(row.id) && row.workspaceId === target.workspaceId && row.ticketId === target.ticketId
    && opaque(row.contactBindingId) && /^[a-f0-9]{64}$/.test(row.secretHash)
    && ['pending', 'expired', 'revoked', 'consumed'].includes(row.status)
    && Number.isFinite(Date.parse(row.createdAt)) && Number.isFinite(Date.parse(row.expiresAt))
    && Date.parse(row.expiresAt) > Date.parse(row.createdAt);
}

export interface TicketInvitationPolicy {
  /** Server-owned deployment setting. Never accepted from the PM request. */
  lifetimeMs: number;
  /** Optional server-owned sender restriction, checked after PM authorization. */
  recipientAllowed?: (email: string) => boolean;
}

export interface TicketInvitationReceipt {
  invitationId: string;
  ticketId: string;
  expiresAt: string;
  alreadyPending: boolean;
}

/**
 * PM invitation issuance only. It does not send email or activate a client.
 * The DB outbox signal and invitation row commit atomically; a worker later
 * resolves the recipient from the private inquiry and delivers through the
 * configured identity provider.
 */
export function createTicketInvitationService(
  store: TicketInvitationStore,
  policy: TicketInvitationPolicy,
  secretProtector: TicketInvitationSecretProtector,
  now: () => Date = () => new Date(),
  nextId: () => string = randomUUID,
) {
  const policyValid = Number.isSafeInteger(policy?.lifetimeMs)
    && policy.lifetimeMs > 0 && policy.lifetimeMs <= MAX_INVITATION_LIFETIME_MS
    && (policy.recipientAllowed === undefined || typeof policy.recipientAllowed === 'function');
  const protectorValid = typeof secretProtector?.protect === 'function'
    && typeof secretProtector?.unprotect === 'function';

  async function issue(target: TicketTarget, subject: TicketSubject): Promise<TicketInvitationReceipt> {
    if (!policyValid || !protectorValid) workflowError(503, 'ticket_invitation_unavailable', 'Client invitations are unavailable right now.');
    try {
      return await store.transaction(async tx => {
        // Fresh access precedes private contact lookup and any invitation replay.
        const ticket = await authorizeTicketAccess(tx, target, subject);
        if (ticket.actor.kind !== 'pm') workflowError(403, 'ticket_action_forbidden', 'You cannot invite a client to this ticket.');
        if ((ticket.mode ?? 'disabled') !== 'enabled') workflowError(503, 'ticket_writes_disabled', 'Ticket changes are unavailable right now.');
        if (ticket.state.status !== 'under_review') workflowError(409, 'invalid_ticket_transition', 'Review the inquiry before inviting its client.');
        if (ticket.state.clientId !== null || ticket.state.scopeVersionId !== null || ticket.state.agreedScopeVersionId !== null
          || ticket.state.authorizedScopeVersionId !== null || ticket.state.projectId !== null || ticket.state.requiredIssueIds.length > 0) {
          workflowError(409, 'ticket_invitation_unavailable', 'This inquiry is not eligible for client activation.');
        }

        const contact = await tx.loadInvitationContact(ticket);
        const email = contact?.source === 'public_inquiry' && contact.emailVerified === false
          ? canonicalEmail(contact.email) : null;
        if (!email || !opaque(contact?.bindingId)) workflowError(409, 'ticket_invitation_unavailable', 'This inquiry is not eligible for client activation.');
        if (policy.recipientAllowed && !policy.recipientAllowed(email)) {
          workflowError(409, 'ticket_invitation_recipient_restricted', 'The email sender cannot deliver to this inquiry contact with its current recipient restriction.');
        }

        const instant = now();
        const createdMs = instant instanceof Date ? instant.getTime() : Number.NaN;
        if (!Number.isFinite(createdMs)) throw new TicketReadInvariantError();
        const createdAt = new Date(createdMs).toISOString();
        const latest = await tx.lockLatestInvitation(target);
        if (latest) {
          if (!validInvitation(latest, target)) throw new TicketReadInvariantError();
          if (latest.status === 'consumed') throw new TicketReadInvariantError();
          if (latest.status === 'pending' && Date.parse(latest.expiresAt) > createdMs) {
            if (latest.contactBindingId !== contact.bindingId) {
              workflowError(409, 'ticket_invitation_contact_changed', 'The inquiry contact changed. Review it before issuing another invitation.');
            }
            return { invitationId: latest.id, ticketId: target.ticketId, expiresAt: latest.expiresAt, alreadyPending: true };
          }
          if (latest.status === 'pending') {
            if (!await tx.expireInvitation(target, latest.id, createdAt)) {
              workflowError(409, 'ticket_version_conflict', 'The invitation changed. Refresh and try again.');
            }
            await tx.appendInvitationAudit({ target, invitationId: latest.id, actorId: ticket.actor.userId, type: 'invitation_expired', occurredAt: createdAt });
          }
        }

        const id = nextId();
        if (!opaque(id) || id.length > 200) throw new TicketReadInvariantError();
        const expiresAt = new Date(createdMs + policy.lifetimeMs).toISOString();
        if (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= createdMs) throw new TicketReadInvariantError();
        const tokenBytes = randomBytes(32);
        const token = tokenBytes.toString('base64url');
        const secretHash = createHash('sha256').update(tokenBytes).digest('hex');
        const secretContext: TicketInvitationSecretContext = {
          workspaceId: target.workspaceId, ticketId: target.ticketId, invitationId: id, expiresAt,
        };
        const protectedToken = secretProtector.protect(token, secretContext);
        if (!opaque(protectedToken) || protectedToken === token || !protectedToken.startsWith('v1.')) {
          throw new TicketReadInvariantError();
        }
        const record: TicketInvitationRecord = {
          id, workspaceId: target.workspaceId, ticketId: target.ticketId,
          contactBindingId: contact.bindingId, secretHash,
          status: 'pending', createdAt, expiresAt,
        };
        await tx.insertInvitation(record);
        await tx.appendInvitationAudit({ target, invitationId: id, actorId: ticket.actor.userId, type: 'invitation_issued', occurredAt: createdAt });
        await tx.enqueueInvitationSignal({ type: 'ticket_invitation_requested', target, invitationId: id, protectedToken, occurredAt: createdAt });
        return { invitationId: id, ticketId: target.ticketId, expiresAt, alreadyPending: false };
      });
    } catch (error) {
      if (error instanceof TicketWorkflowError || error instanceof TicketReadInvariantError) throw error;
      if (isTransactionOutcomeUnknown(error)) {
        throw new TicketWorkflowError(409, 'ticket_invitation_outcome_unknown', 'The invitation result is uncertain. Retry the same request to reconcile it.');
      }
      throw new TicketWorkflowError(503, 'ticket_invitation_unavailable', 'Client invitations are unavailable right now.');
    }
  }

  return { issue };
}
