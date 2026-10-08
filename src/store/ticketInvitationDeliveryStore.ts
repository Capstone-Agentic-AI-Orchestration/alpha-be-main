import type {
  TicketInvitationContact, TicketInvitationRecord, TicketInvitationSignal,
} from './ticketInvitationStore.js';
import type { TicketStatus } from '../ticketing/workflow.js';

export interface TicketInvitationDeliveryClaim {
  /** Stable outbox identity and an unguessable lease token, both server-owned. */
  eventId: string;
  leaseToken: string;
  /** 1-based attempt number incremented atomically when the lease is claimed. */
  attempt: number;
  signal: TicketInvitationSignal;
  invitation: TicketInvitationRecord;
  ticket: {
    id: string;
    workspaceId: string;
    status: TicketStatus;
    clientId: string | null;
    scopeVersionId: string | null;
    agreedScopeVersionId: string | null;
    authorizedScopeVersionId: string | null;
    projectId: string | null;
    requiredIssueIds: readonly string[];
  };
  /** Private inquiry data; it must never be copied into the outbox or logs. */
  contact: TicketInvitationContact;
}

export type TicketInvitationDeliverySkipReason = 'expired' | 'invitation_inactive' | 'ticket_ineligible' | 'contact_changed';
export type TicketInvitationDeliveryFailureCode = 'provider_failure' | 'secret_unavailable' | 'secret_integrity_failure' | 'attempt_limit_reached';

/** Durable worker boundary. Every mutation must compare the active lease token. */
export interface TicketInvitationDeliveryStore {
  /**
   * Atomically leases one due invitation event and loads its invitation,
   * current ticket eligibility, and immutable original contact in one coherent
   * snapshot. Return null when no event is due. A contact/email is not persisted
   * into the outbox. Lease expiry makes crashed workers recoverable.
   */
  claimNext(input: { now: string; leaseUntil: string }): Promise<TicketInvitationDeliveryClaim | null>;
  /**
   * True only when this worker still owns the event lease and wins completion.
   * On success, erase the protected token envelope from the completed outbox
   * record; the invitation verifier hash remains for activation.
   */
  markDelivered(claim: TicketInvitationDeliveryClaim, deliveredAt: string): Promise<boolean>;
  /** Retry the same event and envelope; failure codes are enums, never provider text. */
  scheduleRetry(claim: TicketInvitationDeliveryClaim, retryAt: string, code: TicketInvitationDeliveryFailureCode): Promise<boolean>;
  /** Stop retrying after the configured attempt limit or an integrity failure; erase the envelope. */
  deadLetter(claim: TicketInvitationDeliveryClaim, occurredAt: string, code: TicketInvitationDeliveryFailureCode): Promise<boolean>;
  /** Suppress delivery after eligibility changes; erase the unusable envelope. */
  discard(claim: TicketInvitationDeliveryClaim, occurredAt: string, reason: TicketInvitationDeliverySkipReason): Promise<boolean>;
}
