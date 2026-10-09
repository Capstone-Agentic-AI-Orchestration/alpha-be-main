import type { TicketTarget, TicketWriteMode } from './ticketCommandStore.js';
import type { TicketHeaderRow, TicketRequestReadRow } from './ticketReadStore.js';
import type { TicketWorkflow } from '../ticketing/workflow.js';
import type { PublicTicketIntakeRequestContext } from '../ticketing/publicIntake.js';

export interface PublishedTicketIntakeEntry {
  id: string; slug: string; workspaceId: string; companyLabel: string;
  published: boolean; mode?: TicketWriteMode;
  policy: { version: string; perSourceMax: number; perEntryMax: number; windowSeconds: number };
}
/** Server-derived admission for one public request. Origin checks are not
 * authentication: they constrain browser submissions, while durable database
 * budgets limit source and total entry volume. The source key is an HMAC; raw
 * addresses must never leave the guard.
 */
export interface PublicTicketIntakeAdmission {
  entryId: string; rateSubjectKey: string;
  issuedAt: string; expiresAt: string;
}
export interface PublicTicketIntakeGuard {
  /** Admit only an exact allowed HTTPS origin with a server-resolved source
   * address and configured HMAC key. Origin is spoofable by non-browser callers
   * and must never be treated as identity or a substitute for the durable rate
   * budgets. Missing request context/configuration fails closed.
   */
  admitRequest(entry: PublishedTicketIntakeEntry, request: PublicTicketIntakeRequestContext): Promise<PublicTicketIntakeAdmission | null>;
}
export interface PublicTicketIntakeOperationKey { workspaceId: string; entryId: string; operationId: string }
export interface SavedPublicTicketIntakeOperation {
  key: PublicTicketIntakeOperationKey;
  target: TicketTarget;
  fingerprint: string;
  fingerprintKeyId: string;
}
export interface PublicTicketInquiryRecord {
  state: TicketWorkflow;
  header: TicketHeaderRow;
  request: TicketRequestReadRow & { entryId: string };
}
export interface PublicTicketInquiryAudit {
  target: TicketTarget; entryId: string; operationId: string;
  type: 'inquiry_received'; occurredAt: string;
}
export interface TicketPublicIntakeTransaction {
  /** Fresh published entry/workspace/policy gate under compatible locks; no
   * remapping a slug to another tenant between verification and write.
   */
  lockPublishedEntry(slug: string): Promise<PublishedTicketIntakeEntry | null>;
  /** Serialize absent keys too. An orphaned operation is an error, not absent.
   * Private dedupe only, no anonymous ticket-status or email/account lookup.
   */
  lockInquiryOperation(key: PublicTicketIntakeOperationKey): Promise<SavedPublicTicketIntakeOperation | null>;
  allocateReference(entry: PublishedTicketIntakeEntry): Promise<string>;
  insertInquiry(record: PublicTicketInquiryRecord): Promise<void>;
  appendInquiryAudit(audit: PublicTicketInquiryAudit): Promise<void>;
  /** Minimal durable signal; worker resolves PM recipients/contact safely later.
   * No email/body, no shared-board broadcast, no success claim of mail delivery.
   */
  enqueueInquiryReceived(signal: PublicTicketInquiryAudit): Promise<void>;
  insertInquiryOperation(operation: SavedPublicTicketIntakeOperation): Promise<void>;
}
export interface TicketPublicIntakeStore {
  loadPublishedEntry(slug: string): Promise<PublishedTicketIntakeEntry | null>;
  /** One independent committed atomic budget operation for BOTH source and
   * entry limits, with live policy/gate recheck. Attempts are charged even when
   * later validation or inquiry transaction fails. No process-local limiter,
   * raw IP/email key, counter reset after rollback, or default unlimited fallback.
   * Denial must not increment only one bucket or extend a fixed window forever.
   */
  consumeIntakeAttempt(entry: PublishedTicketIntakeEntry, admission: PublicTicketIntakeAdmission, occurredAt: string): Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }>;
  /** One actual transaction: inquiry/audit/signal/dedupe together, no network.
   * Unknown COMMIT propagates; retry the SAME ID, never create a fallback ticket.
   */
  transaction<T>(work: (tx: TicketPublicIntakeTransaction) => Promise<T>): Promise<T>;
}
