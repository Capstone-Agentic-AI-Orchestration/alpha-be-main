import { assertTicketActor, TicketWorkflowError } from '../ticketing/workflow.js';
import type { LockedTicket, TicketCommandTransaction, TicketSubject, TicketTarget } from '../store/ticketCommandStore.js';
import type { LockedTicketQueue, TicketQueueTransaction } from '../store/ticketQueueStore.js';

/** Reusable inside one transaction. Authorization always precedes input parsing,
 * data projection, pagination and operation replay. Not an HTTP auth middleware.
 */
export async function authorizeTicketAccess(
  tx: Pick<TicketCommandTransaction, 'lockAuthorizedTicket'>, target: TicketTarget, subject: TicketSubject,
): Promise<LockedTicket> {
  const ticket = await tx.lockAuthorizedTicket(target, subject);
  if (!ticket || ticket.state.id !== target.ticketId || ticket.state.workspaceId !== target.workspaceId
    || ticket.actor.userId !== subject.userId
    || (ticket.actor.kind === 'client') !== (subject.kind === 'client')) {
    throw new TicketWorkflowError(404, 'ticket_not_found', 'Ticket not found.');
  }
  assertTicketActor(ticket.state, ticket.actor);
  return ticket;
}

/** Collection access does not grant client workspace membership or access to
 * every ticket. Each query must still join current ticket-specific grants.
 */
export async function authorizeTicketQueueAccess(
  tx: Pick<TicketQueueTransaction, 'lockAuthorizedQueue'>, workspaceId: string, subject: TicketSubject,
): Promise<LockedTicketQueue> {
  const scope = await tx.lockAuthorizedQueue(workspaceId, subject);
  if (!scope || scope.workspaceId !== workspaceId || scope.principal.userId !== subject.userId
    || (scope.principal.kind === 'client') !== (subject.kind === 'client')
    || (scope.principal.kind === 'client' && !scope.principal.accessActive)) {
    throw new TicketWorkflowError(404, 'ticket_not_found', 'Ticket not found.');
  }
  if (scope.principal.kind !== 'client' && (scope.principal.kind !== 'pm'
    || !scope.principal.membershipActive || !scope.principal.canManageTickets)) {
    throw new TicketWorkflowError(403, 'ticket_action_forbidden', 'You cannot read the ticket queue.');
  }
  return scope;
}
