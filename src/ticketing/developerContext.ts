import type { IssueStatus } from '../models/index.js';
import type { TicketWorkflow } from './workflow.js';
import type { TicketDeveloperContextSnapshot } from '../store/ticketDeveloperContextStore.js';
import { TicketReadInvariantError } from './readModels.js';
import { TicketWorkflowError } from './workflow.js';

export interface DeveloperTicketWorkContext {
  ticketReference: string;
  ticketVersion: number;
  issueId: string;
  projectId: string;
  issueRevisionId: string;
  scopeVersionId: string;
  brief: string;
  correction: { instructions: string; authorizedAt: string } | null;
}

const opaque = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 200 && value.trim().length > 0 && value.trim() === value;
const statuses = new Set<IssueStatus>(['todo', 'in_progress', 'agent_running']);
function invariant(value: unknown): asserts value { if (!value) throw new TicketReadInvariantError(); }

/**
 * Project only the minimum approved work brief for the assigned developer.
 * This is read context, not execution authorization. Every run start/retry must
 * independently recheck the live ticket/scope/Issue gate in its own transaction.
 */
export function projectDeveloperTicketContext(
  workspaceId: string,
  issueId: string,
  userId: string,
  snapshot: TicketDeveloperContextSnapshot,
): DeveloperTicketWorkContext {
  const { issue, project, ticket, scope, correction } = snapshot;
  const state: TicketWorkflow = ticket.state;
  invariant(opaque(workspaceId) && opaque(issueId) && opaque(userId)
    && snapshot.workspaceId === workspaceId
    && issue.workspaceId === workspaceId && issue.id === issueId
    && project.workspaceId === workspaceId && project.id === issue.projectId
    && issue.projectId === state.projectId && issue.ticketId === state.id
    && ticket.workspaceId === workspaceId && ticket.id === state.id
    && scope.workspaceId === workspaceId && scope.ticketId === state.id
    && scope.id === state.scopeVersionId
    && issue.assignedDeveloperId === userId && issue.assignmentActive === true
    && statuses.has(issue.status)
    && Number.isSafeInteger(state.version) && state.version >= 0
    && Array.isArray(state.requiredIssueIds)
    && new Set(state.requiredIssueIds).size === state.requiredIssueIds.length);

  if (!project.nonProductionSafe || state.clientId === null || state.withdrawalRequested
    // Conversation routing is not work authorization: a client reply or PM
    // request for details can change nextAction without suspending agreed work.
    || state.status !== 'in_progress' || state.hold !== null
    || state.delivery !== null || state.correctionRequestedFor !== null
    || !state.requiredIssueIds.includes(issue.id)
    || !scope.immutable || !scope.clientAgreed
    || state.agreedScopeVersionId !== scope.id || state.authorizedScopeVersionId !== scope.id) {
    throw new TicketWorkflowError(409, 'ticket_work_not_authorized', 'This issue has no current approved work context.');
  }
  invariant(opaque(ticket.reference) && opaque(issue.revisionId) && opaque(issue.initialRevisionId)
    && typeof scope.developerBrief === 'string' && scope.developerBrief.trim().length > 0
    && scope.developerBrief.length <= 12000);

  if (issue.revisionId === issue.initialRevisionId) invariant(correction === null);
  else {
    invariant(correction && correction.immutable === true
      && correction.workspaceId === workspaceId && correction.ticketId === ticket.id
      && correction.projectId === project.id && correction.issueId === issue.id
      && correction.scopeVersionId === scope.id && correction.issueRevisionId === issue.revisionId
      && opaque(correction.previousRevisionId) && correction.previousRevisionId !== issue.revisionId
      && opaque(correction.authorizedByPmId)
      && (correction.source === 'request_fixes' || correction.source === 'authorize_correction')
      && typeof correction.developerInstructions === 'string' && correction.developerInstructions.trim().length > 0
      && correction.developerInstructions.length <= 4000
      && typeof correction.authorizedAt === 'string' && Number.isFinite(Date.parse(correction.authorizedAt)));
  }

  return {
    ticketReference: ticket.reference,
    ticketVersion: state.version,
    issueId: issue.id,
    projectId: project.id,
    issueRevisionId: issue.revisionId,
    scopeVersionId: scope.id,
    brief: scope.developerBrief,
    correction: correction ? { instructions: correction.developerInstructions, authorizedAt: correction.authorizedAt } : null,
  };
}
