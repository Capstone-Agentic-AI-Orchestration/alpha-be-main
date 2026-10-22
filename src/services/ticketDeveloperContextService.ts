import type { TicketSubject } from '../store/ticketCommandStore.js';
import type { TicketDeveloperContextStore } from '../store/ticketDeveloperContextStore.js';
import { projectDeveloperTicketContext } from '../ticketing/developerContext.js';
import { TicketWorkflowError } from '../ticketing/workflow.js';

const opaque = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 200 && value.trim().length > 0 && value.trim() === value;

/** Read-only, project-access-scoped developer view. This service never starts work. */
export function createTicketDeveloperContextService(store: TicketDeveloperContextStore) {
  return {
    async read(workspaceId: string, issueId: string, subject: TicketSubject) {
      if (subject.kind !== 'internal' || !opaque(workspaceId) || !opaque(issueId) || !opaque(subject.userId)) {
        throw new TicketWorkflowError(404, 'ticket_not_found', 'Task not found.');
      }
      return store.transaction(async tx => {
        const snapshot = await tx.loadAuthorizedWorkContext(workspaceId, issueId, subject);
        if (!snapshot) throw new TicketWorkflowError(404, 'ticket_not_found', 'Task not found.');
        return projectDeveloperTicketContext(workspaceId, issueId, subject.userId, snapshot);
      });
    },
  };
}
