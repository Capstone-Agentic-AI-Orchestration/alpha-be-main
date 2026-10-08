import type { TicketSubject } from './ticketCommandStore.js';
import type { AuthorizedTicketCreateContext, SharedTicketProjectOption } from './ticketCreationStore.js';

export interface TicketClientIntakeContextTransaction {
  /**
   * Resolve the exact context only after rechecking the persisted client
   * session, active service grant, and requested workspace. Workspace ID is a
   * selector, never permission. Return null for inaccessible/missing contexts.
   */
  resolveAuthorizedContext(
    workspaceId: string,
    subject: Extract<TicketSubject, { kind: 'client' }>,
  ): Promise<AuthorizedTicketCreateContext | null>;
  /** Return only active, explicitly client-visible options from this workspace. */
  listSharedProjectOptions(context: AuthorizedTicketCreateContext): Promise<SharedTicketProjectOption[]>;
}

export interface TicketClientIntakeContextStore {
  transaction<T>(work: (tx: TicketClientIntakeContextTransaction) => Promise<T>): Promise<T>;
}
