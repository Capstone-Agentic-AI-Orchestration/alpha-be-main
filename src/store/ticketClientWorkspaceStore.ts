import type { TicketSubject } from './ticketCommandStore.js';

export interface TicketClientWorkspaceRecord {
  workspaceId: string;
  /** Deliberately published, client-safe label; never an internal workspace row. */
  displayName: string;
}

export interface TicketClientWorkspaceTransaction {
  /**
   * Recheck the exact persisted client session and current active client-service
   * grants in one coherent snapshot. Return only explicitly client-visible
   * workspace choices. No ticket/project/repository query belongs here.
   */
  listAuthorizedWorkspaces(subject: Extract<TicketSubject, { kind: 'client' }>): Promise<TicketClientWorkspaceRecord[]>;
}

export interface TicketClientWorkspaceStore {
  transaction<T>(work: (tx: TicketClientWorkspaceTransaction) => Promise<T>): Promise<T>;
}
