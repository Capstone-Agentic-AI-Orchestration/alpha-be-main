import type {
  LockedTicket, SavedTicketOperation, TicketCommandReceipt, TicketOperationKey, TicketSubject, TicketTarget,
} from './ticketCommandStore.js';

export interface TicketWorkspaceProject { id: string; name: string }
export interface TicketCurrentProjectLink { projectId: string | null; projectName: string | null; clientVisible: boolean }
export interface TicketProjectLinkAudit {
  key: TicketOperationKey; occurredAt: string; previousProjectId: string | null; projectId: string | null;
  previousClientVisible: boolean; clientVisible: boolean; projectName: string | null;
}
export interface TicketProjectManagementTransaction {
  lockAuthorizedTicket(target: TicketTarget, subject: TicketSubject): Promise<LockedTicket | null>;
  findOperation(key: TicketOperationKey): Promise<SavedTicketOperation | null>;
  loadCurrentProjectLink(target: TicketTarget): Promise<TicketCurrentProjectLink>;
  findWorkspaceProject(workspaceId: string, projectId: string): Promise<TicketWorkspaceProject | null>;
  saveProjectLink(target: TicketTarget, expectedVersion: number, state: LockedTicket['state'], projectName: string | null,
    clientVisible: boolean, occurredAt: string): Promise<boolean>;
  appendProjectLinkAudit(audit: TicketProjectLinkAudit): Promise<void>;
  enqueueChange(signal: { key: TicketOperationKey; version: number; occurredAt: string }): Promise<void>;
  insertOperation(operation: Extract<SavedTicketOperation, { kind: 'command' }>): Promise<void>;
  setClientRequestsEnabled(target: TicketTarget, subject: TicketSubject, enabled: boolean): Promise<boolean>;
}
export interface TicketProjectManagementStore {
  transaction<T>(work: (tx: TicketProjectManagementTransaction) => Promise<T>): Promise<T>;
}

export interface TicketProjectLinkReceipt extends TicketCommandReceipt {
  projectId: string | null;
  projectName: string | null;
  clientVisible: boolean;
}
