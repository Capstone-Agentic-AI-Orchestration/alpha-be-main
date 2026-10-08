import type { TicketSubject } from '../store/ticketCommandStore.js';
import type { TicketClientWorkspaceStore } from '../store/ticketClientWorkspaceStore.js';
import { TicketReadInvariantError } from '../ticketing/readModels.js';
import { TicketWorkflowError } from '../ticketing/workflow.js';

const opaque = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 200 && value.trim() === value;

/** Returns only workspaces explicitly granted to this verified client. */
export function createTicketClientWorkspaceService(store: TicketClientWorkspaceStore) {
  return {
    async list(subject: TicketSubject) {
      if (subject.kind !== 'client' || !opaque(subject.userId) || !/^[a-f0-9]{64}$/.test(subject.sessionId)) {
        throw new TicketWorkflowError(403, 'ticket_action_forbidden', 'You cannot view client workspaces.');
      }
      return store.transaction(async tx => {
        const rows = await tx.listAuthorizedWorkspaces(subject);
        if (!Array.isArray(rows) || rows.length > 1000) throw new TicketReadInvariantError();
        const ids = new Set<string>();
        const items = rows.map(row => {
          if (!row || !opaque(row.workspaceId) || typeof row.displayName !== 'string'
            || !row.displayName.trim() || row.displayName !== row.displayName.trim()
            || row.displayName.length > 200 || ids.has(row.workspaceId)) {
            throw new TicketReadInvariantError();
          }
          ids.add(row.workspaceId);
          return { workspaceId: row.workspaceId, displayName: row.displayName };
        });
        return items.sort((a, b) => a.displayName.localeCompare(b.displayName) || a.workspaceId.localeCompare(b.workspaceId));
      });
    },
  };
}
