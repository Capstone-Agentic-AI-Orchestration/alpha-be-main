import type { TicketSubject } from '../store/ticketCommandStore.js';
import type { TicketClientIntakeContextStore } from '../store/ticketClientIntakeContextStore.js';
import { TicketReadInvariantError } from '../ticketing/readModels.js';
import { TicketWorkflowError } from '../ticketing/workflow.js';

const opaque = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 200 && value.trim() === value;

/** Supplies the client form's exact approved context and published project choices. */
export function createTicketClientIntakeContextService(store: TicketClientIntakeContextStore) {
  return {
    async get(workspaceId: string, subject: TicketSubject) {
      if (subject.kind !== 'client' || !opaque(subject.userId) || !/^[a-f0-9]{64}$/.test(subject.sessionId)) {
        throw new TicketWorkflowError(403, 'ticket_action_forbidden', 'You cannot submit a client request here.');
      }
      return store.transaction(async tx => {
        const context = await tx.resolveAuthorizedContext(workspaceId, subject);
        if (!opaque(workspaceId) || !context || context.workspaceId !== workspaceId
          || context.clientId !== subject.userId || context.accessActive !== true
          || !opaque(context.id)
          || !['enabled', 'disabled', 'maintenance', undefined].includes(context.mode)
          || !opaque(context.companyLabel)) {
          throw new TicketWorkflowError(404, 'ticket_not_found', 'Ticket intake is unavailable.');
        }
        const rows = await tx.listSharedProjectOptions(context);
        if (!Array.isArray(rows) || rows.length > 1000) throw new TicketReadInvariantError();
        const ids = new Set<string>();
        const sharedProjects = rows.map(row => {
          if (!row || row.workspaceId !== context.workspaceId || row.clientId !== context.clientId
            || !opaque(row.id) || !opaque(row.projectId) || !opaque(row.displayName)
            || row.active !== true || row.clientVisible !== true || ids.has(row.id)) {
            throw new TicketReadInvariantError();
          }
          ids.add(row.id);
          // Deliberately omit internal project ID from the client response.
          return { optionId: row.id, displayName: row.displayName };
        });
        sharedProjects.sort((a, b) => a.displayName.localeCompare(b.displayName) || a.optionId.localeCompare(b.optionId));
        return {
          intakeContextId: context.id,
          canCreate: context.mode === 'enabled',
          sharedProjects,
        };
      });
    },
  };
}
