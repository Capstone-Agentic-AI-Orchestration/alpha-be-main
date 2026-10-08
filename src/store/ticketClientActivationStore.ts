import type {
  InquiryTicketForActivation, PendingTicketInvitation, TicketClientBinding,
  TicketInvitationContactForActivation,
} from '../ticketing/clientActivation.js';
import type { TicketTarget } from './ticketCommandStore.js';

export interface TicketClientActivationAudit {
  binding: TicketClientBinding;
  type: 'client_invitation_activated';
  occurredAt: string;
}

/** No contact data, provider credential, token, or message body in the signal. */
export interface TicketClientActivationSignal {
  target: TicketTarget;
  type: 'ticket_client_activated';
  occurredAt: string;
}

export interface TicketClientActivationTransaction {
  /**
   * Lock/create the exact workspace-level client-service grant first. Return
   * false for a revoked grant; never silently reactivate it. A newly inserted
   * grant rolls back if invitation/email validation later fails.
   */
  ensureClientServiceGrant(workspaceId: string, clientUserId: string, occurredAt: string): Promise<boolean>;
  /** Lock the ticket after principal/service authorization; token is still required below. */
  lockInquiryTicket(target: TicketTarget): Promise<InquiryTicketForActivation | null>;
  /** Then lock and verify the invite by hash, scoped to that exact ticket/workspace. */
  lockInvitationBySecretHash(target: TicketTarget, secretHash: string): Promise<PendingTicketInvitation | null>;
  /** Read only the private original-contact version pinned by the invitation. */
  loadOriginalContact(target: TicketTarget, contactBindingId: string): Promise<TicketInvitationContactForActivation | null>;
  /** Compare-and-set pending -> consumed. A false result aborts the transaction. */
  consumeInvitation(target: TicketTarget, invitationId: string, occurredAt: string): Promise<boolean>;
  /** Compare-and-set the same unbound Under-review ticket; increment workflow version. */
  bindTicketClient(target: TicketTarget, expectedVersion: number, clientUserId: string): Promise<boolean>;
  /** Create exactly this ticket's grant; never a workspace/project membership. */
  insertTicketGrant(binding: TicketClientBinding, occurredAt: string): Promise<void>;
  appendActivationAudit(audit: TicketClientActivationAudit): Promise<void>;
  enqueueActivationSignal(signal: TicketClientActivationSignal): Promise<void>;
}

export interface TicketClientActivationStore {
  /**
   * Hash lookup only discovers the candidate ticket before the transaction.
   * It is never returned to the caller. Inside the transaction, acquire the
   * client-service authorization lock first, then lock ticket before invitation
   * and revalidate the exact hash to close races.
   */
  resolveTargetBySecretHash(secretHash: string): Promise<TicketTarget | null>;
  /**
   * One transaction: client-service grant -> ticket -> invitation -> contact
   * -> ticket grant -> audit/outbox. Revalidate the invitation after the
   * candidate target lookup; no external calls inside this transaction.
   */
  transaction<T>(work: (tx: TicketClientActivationTransaction) => Promise<T>): Promise<T>;
}
