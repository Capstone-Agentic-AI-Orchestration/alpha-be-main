import type {
  TicketCommandReceipt, TicketCommandTransaction, TicketOperationKey,
} from './ticketCommandStore.js';

export interface TicketScopeVersionRecord {
  workspaceId: string;
  ticketId: string;
  id: string;
  publicSummary: string;
  /** Never included in a client read projection. */
  developerBrief: string;
  proposedAt: string;
  proposedByPmId: string;
  immutable: true;
  clientVisible: true;
}

export interface TicketScopeProposalReceipt extends TicketCommandReceipt {
  scopeVersionId: string;
}

export interface SavedTicketScopeProposal {
  key: TicketOperationKey;
  fingerprint: string;
  receipt: TicketScopeProposalReceipt;
}

/** Scope version, workflow transition, audit, outbox and idempotency commit together.
 * lockAuthorizedTicket must serialize proposals for this ticket through commit;
 * operation rows are insert-only/unique and every method uses the same DB transaction.
 */
export interface TicketScopeProposalTransaction extends TicketCommandTransaction {
  findScopeProposal(key: TicketOperationKey): Promise<SavedTicketScopeProposal | null>;
  insertScopeVersion(scope: TicketScopeVersionRecord): Promise<void>;
  insertScopeProposal(proposal: SavedTicketScopeProposal): Promise<void>;
}

export interface TicketScopeStore {
  transaction<T>(work: (tx: TicketScopeProposalTransaction) => Promise<T>): Promise<T>;
}
