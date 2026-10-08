import type { TicketCommandTransaction, TicketOperationKey, TicketTarget } from './ticketCommandStore.js';
import type { TicketMessageReadRow } from './ticketReadStore.js';

/** Body is stored once in the immutable note/message row, not copied to audit. */
export interface TicketNoteAudit {
  key: TicketOperationKey;
  type: 'internal_note_added';
  messageId: string;
  occurredAt: string;
  workflowVersion: number;
}
export interface TicketMessageTransaction extends TicketCommandTransaction {
  insertMessage(message: TicketMessageReadRow): Promise<void>;
  /** Compare workflow version atomically. Public replies update public+internal
   * clocks; notes update ONLY the internal clock, never shared workflow version.
   * Keep clocks monotonic using the DB's authoritative timestamp policy. An
   * answer_close decision must also retain its terminal closedAt atomically;
   * notes cannot modify closure metadata or public sorting/count fields.
   */
  updateMessageClocks(target: TicketTarget, expectedVersion: number, audience: 'client' | 'internal', occurredAt: string): Promise<boolean>;
  appendNoteAudit(audit: TicketNoteAudit): Promise<void>;
}
export interface TicketMessageStore {
  /** Same atomic rollback/unknown-COMMIT rules as the command store. Public
   * message, decision, metadata clocks, audit, outbox and operation save together.
   * Private note saves ONLY private message/clock/audit/operation; no public
   * change signal, notification, client timestamp or workflow version mutation.
   */
  transaction<T>(work: (tx: TicketMessageTransaction) => Promise<T>): Promise<T>;
}
