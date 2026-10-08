import { TicketWorkflowError, type TicketStatus } from './workflow.js';

/** Created only by the server-side identity-provider verifier, never from a
 * request body or user-editable provider metadata. */
export interface VerifiedClientIdentity {
  userId: string;
  email: string | null;
  emailVerified: boolean;
}

/** Loaded by a secret-hash lookup inside the activation transaction. */
export interface PendingTicketInvitation {
  id: string;
  ticketId: string;
  workspaceId: string;
  /** Points to the immutable original inquiry contact; contains no PII. */
  contactBindingId: string;
  status: 'pending' | 'expired' | 'consumed' | 'revoked';
  expiresAt: string;
}

/** Re-read privately from the same original inquiry contact inside activation. */
export interface TicketInvitationContactForActivation {
  bindingId: string;
  email: string | null;
}

/** The activation transaction must read both records from the same workspace. */
export interface InquiryTicketForActivation {
  id: string;
  workspaceId: string;
  version: number;
  status: TicketStatus;
  clientId: string | null;
  source: 'public_inquiry' | 'authenticated_request';
}

export interface TicketClientBinding {
  invitationId: string;
  workspaceId: string;
  ticketId: string;
  clientUserId: string;
}

const opaque = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 200 && value.trim() === value;

function unavailable(): never {
  // Deliberately non-enumerating: callers cannot distinguish expired,
  // revoked, consumed, wrong-email or wrong-ticket invitations.
  throw new TicketWorkflowError(404, 'client_invitation_unavailable', 'This invitation is unavailable.');
}

function canonicalEmail(value: string | null): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

/**
 * Check the one-time account-binding preconditions after the store has resolved
 * the invitation secret and locked the invitation and ticket. Call this inside
 * that same transaction immediately before consuming the invite and granting
 * access. It creates no workspace membership or project permission.
 */
export function authorizeTicketInvitationActivation(
  invitation: PendingTicketInvitation | null,
  ticket: InquiryTicketForActivation | null,
  contact: TicketInvitationContactForActivation | null,
  identity: VerifiedClientIdentity,
  now: Date = new Date(),
): TicketClientBinding {
  const nowMs = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(nowMs) || !invitation || !ticket
    || !opaque(invitation.id) || !opaque(invitation.ticketId) || !opaque(invitation.workspaceId)
    || !opaque(invitation.contactBindingId) || !contact || contact.bindingId !== invitation.contactBindingId
    || !opaque(ticket.id) || !opaque(ticket.workspaceId)
    || !Number.isSafeInteger(ticket.version) || ticket.version < 0
    || invitation.ticketId !== ticket.id || invitation.workspaceId !== ticket.workspaceId
    || invitation.status !== 'pending' || ticket.source !== 'public_inquiry'
    || ticket.clientId !== null || ticket.status !== 'under_review'
    || !Number.isFinite(Date.parse(invitation.expiresAt)) || Date.parse(invitation.expiresAt) <= nowMs
    || !opaque(identity?.userId) || identity.emailVerified !== true) unavailable();

  const invitedEmail = canonicalEmail(contact.email);
  const verifiedEmail = canonicalEmail(identity.email);
  if (!invitedEmail || !verifiedEmail || invitedEmail !== verifiedEmail) unavailable();

  return {
    invitationId: invitation.id,
    workspaceId: ticket.workspaceId,
    ticketId: ticket.id,
    clientUserId: identity.userId,
  };
}
