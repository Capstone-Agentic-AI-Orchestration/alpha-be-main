import type { LockedTicket, TicketSubject, TicketTarget } from './ticketCommandStore.js';

export type TicketInvitationStatus = 'pending' | 'expired' | 'revoked' | 'consumed';
export type TicketInvitationOutboxStatus = 'pending' | 'retry' | 'leased' | 'delivered' | 'dead' | 'discarded';

/** The invitation row contains no email; the recipient is resolved from the
 * private original inquiry only when the delivery worker processes the event. */
export interface TicketInvitationRecord {
  id: string;
  workspaceId: string;
  ticketId: string;
  /** Internal reference to the immutable contact captured by the original inquiry. */
  contactBindingId: string;
  /** SHA-256 of the 32-byte random token; raw token is never stored here. */
  secretHash: string;
  status: TicketInvitationStatus;
  createdAt: string;
  expiresAt: string;
}

/** Private request data, available only inside the authorized PM transaction. */
export interface TicketInvitationContact {
  /** Stable, server-owned ID for the original contact record; never a request field. */
  bindingId: string;
  source: 'public_inquiry' | 'authenticated_request';
  email: string | null;
  emailVerified: boolean;
}

export interface TicketInvitationAudit {
  target: TicketTarget;
  invitationId: string;
  actorId: string;
  type: 'invitation_issued' | 'invitation_expired';
  occurredAt: string;
}

/** Contains no recipient or message body. The retryable secret is authenticated
 * ciphertext bound to the invitation context; the worker resolves the email
 * from the private inquiry only after commit. */
export interface TicketInvitationSignal {
  type: 'ticket_invitation_requested';
  target: TicketTarget;
  invitationId: string;
  protectedToken: string;
  occurredAt: string;
}

export interface TicketInvitationTransaction {
  /** Same fresh session, workspace membership and ticket checks as other ticket services. */
  lockAuthorizedTicket(target: TicketTarget, subject: TicketSubject): Promise<LockedTicket | null>;
  /** Scoped to the locked ticket; contact binding must remain immutable and private. */
  loadInvitationContact(ticket: LockedTicket): Promise<TicketInvitationContact | null>;
  /** Lock the current invitation for this exact ticket, including terminal history if present. */
  lockLatestInvitation(target: TicketTarget): Promise<TicketInvitationRecord | null>;
  /** Read the matching terminal/retry state without exposing provider or recipient data. */
  loadInvitationOutboxStatus(target: TicketTarget, invitationId: string): Promise<TicketInvitationOutboxStatus | null>;
  /** Pending -> expired compare-and-set; false means the transaction must abort. */
  expireInvitation(target: TicketTarget, invitationId: string, occurredAt: string): Promise<boolean>;
  /** Enforce one pending invitation per ticket with a database uniqueness constraint. */
  insertInvitation(record: TicketInvitationRecord): Promise<void>;
  appendInvitationAudit(audit: TicketInvitationAudit): Promise<void>;
  enqueueInvitationSignal(signal: TicketInvitationSignal): Promise<void>;
}

export interface TicketInvitationStore {
  /** One DB transaction; hash, invitation/outbox/audit changes roll back together.
   * Shared auth/session/principal lock comes first; then ticket, invitation,
   * contact read, audit and outbox. Outbox encryption is local; no provider,
   * email, or network call inside this callback.
   */
  transaction<T>(work: (tx: TicketInvitationTransaction) => Promise<T>): Promise<T>;
}
