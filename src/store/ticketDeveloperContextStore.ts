import type { IssueStatus } from '../models/index.js';
import type { TicketIssueCorrection, TicketSubject } from './ticketCommandStore.js';
import type { TicketWorkflow } from '../ticketing/workflow.js';

/** Minimum rows needed to build developer work context; never load conversation,
 * client contact, PM notes, unpublished delivery material, or unrelated Issues.
 */
export interface TicketDeveloperContextSnapshot {
  workspaceId: string;
  issue: {
    id: string;
    workspaceId: string;
    projectId: string;
    ticketId: string;
    assignedDeveloperId: string;
    assignmentActive: boolean;
    revisionId: string;
    initialRevisionId: string;
    status: IssueStatus;
  };
  project: { id: string; workspaceId: string; nonProductionSafe: boolean };
  ticket: { id: string; workspaceId: string; reference: string; state: TicketWorkflow };
  scope: {
    id: string;
    ticketId: string;
    workspaceId: string;
    developerBrief: string;
    immutable: boolean;
    clientAgreed: boolean;
  };
  /** Exact immutable brief for the current correction revision, or null only
   * when revisionId equals the initial authorized revision. Read atomically
   * with the revision pointer; do not substitute messages or private notes.
   */
  correction: TicketIssueCorrection | null;
}

/** Current authorization must be resolved in one coherent read snapshot. */
export interface TicketDeveloperContextTransaction {
  /**
   * Return null for missing/foreign/inactive identity, workspace membership,
   * assignment or Issue. Recheck the persisted internal session/bearer, active
   * developer membership, exact human assignment, project and ticket links.
   * Project safety is freshly derived from the existing execution/release path,
   * not copied from a caller-controlled flag. No unrelated client data is read.
   */
  loadAssignedWorkContext(workspaceId: string, issueId: string, subject: TicketSubject): Promise<TicketDeveloperContextSnapshot | null>;
}
export interface TicketDeveloperContextStore {
  transaction<T>(work: (tx: TicketDeveloperContextTransaction) => Promise<T>): Promise<T>;
}
