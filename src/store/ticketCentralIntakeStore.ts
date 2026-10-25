import type { PublicTicketInquiryInput } from '../ticketing/intake.js';
import type { TicketSubject } from './ticketCommandStore.js';

export interface CentralIntakeCursor { submittedAt: string; id: string }
export interface CentralIntakeItem {
  id: string; publicReference: string; fullName: string; email: string; company: string | null; title: string;
  description: string; requestedDeadline: string | null; submittedAt: string;
  status?: 'pending' | 'accepted' | 'declined';
  handledAt?: string | null;
  outcomeEmailStatus?: 'pending' | 'retry' | 'leased' | 'delivered' | 'dead' | null;
}
/** Store cursor stays structured; the service encodes it at the HTTP boundary. */
export interface CentralIntakePage { items: CentralIntakeItem[]; nextCursor: CentralIntakeCursor | null }
export interface CentralIntakeRatePolicy {
  perSourceMax: number; perOrganizationMax: number; windowSeconds: number;
}
export interface CentralIntakeFingerprint { keyId: string; fingerprint: string }
export interface CentralIntakeAcceptance {
  ticketId: string; workspaceId: string; reference: string; operationId: string;
}
export interface CentralIntakeDeclineReceipt { intakeId: string; operationId: string; status: 'declined' }

export interface TicketCentralIntakeStore {
  consumeAttempt(organizationKey: string, sourceHash: string, occurredAt: string,
    policy: CentralIntakeRatePolicy): Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }>;
  submit(organizationKey: string, id: string, publicReference: string, input: PublicTicketInquiryInput,
    fingerprints: readonly CentralIntakeFingerprint[], occurredAt: string): Promise<{ kind: 'received'; publicReference: string } | { kind: 'conflict' }>;
  listPending(organizationKey: string, workspaceId: string, subject: TicketSubject,
    cursor: CentralIntakeCursor | null, limit: number, filter?: 'pending' | 'handled'): Promise<CentralIntakePage | 'forbidden'>;
  accept(input: {
    organizationKey: string; intakeId: string; workspaceId: string; subject: TicketSubject;
    operationId: string; ticketId: string; reference: string; occurredAt: string;
  }): Promise<CentralIntakeAcceptance | 'not_found' | 'already_handled' | 'workspace_unavailable' | 'forbidden'>;
  decline(input: {
    organizationKey: string; intakeId: string; workspaceId: string; subject: TicketSubject;
    operationId: string; reason: string | null; occurredAt: string;
  }): Promise<CentralIntakeDeclineReceipt | 'not_found' | 'already_handled' | 'forbidden'>;
}
