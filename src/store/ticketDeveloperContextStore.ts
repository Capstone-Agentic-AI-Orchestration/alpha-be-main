import type { IssueStatus } from '../models/index.js';
import type { TicketIssueCorrection, TicketSubject } from './ticketCommandStore.js';
import type { TicketWorkflow } from '../ticketing/workflow.js';

/** Minimum rows needed to build developer work context; never load conversation,
 * client contact, PM notes, unpublished delivery material, or unrelated Issues.
 */
export interface TicketDeveloperContextSnapshot {
  workspaceId: string;
  /** Access of the requesting verified developer to this Issue's project. */
  developerProjectAccessActive: boolean;
  issue: {
    id: string;
    workspaceId: string;
    projectId: string;
    ticketId: string;
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
   * Return null for missing/foreign/inactive identity, workspace/project access,
   * or Issue. Recheck the persisted internal session/bearer, active developer
   * membership and project access, exact tenant/Issue/ticket links. Do not require
   * an individual Issue assignee for ticket-linked work. Project safety is freshly
   * derived from the existing execution/release path, not a caller flag. No
   * unrelated client data is read.
   */
  loadAuthorizedWorkContext(workspaceId: string, issueId: string, subject: TicketSubject): Promise<TicketDeveloperContextSnapshot | null>;
}
export interface TicketDeveloperContextStore {
  transaction<T>(work: (tx: TicketDeveloperContextTransaction) => Promise<T>): Promise<T>;
}
