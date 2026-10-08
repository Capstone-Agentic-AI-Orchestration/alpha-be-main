import { createHash } from 'node:crypto';

import type { LockedTicket, SavedTicketOperation, TicketOperationKey, TicketOperationReceipt } from '../store/ticketCommandStore.js';
import { TicketWorkflowError } from '../ticketing/workflow.js';

export function ticketOperationKey(ticket: LockedTicket, operationId: string): TicketOperationKey {
  return {
    workspaceId: ticket.state.workspaceId, ticketId: ticket.state.id,
    actorKind: ticket.actor.kind, actorId: ticket.actor.userId, operationId,
  };
}
/** Only validated JSON input; sorted keys, preserved array order. No payload logs. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export function ticketOperationFingerprint(kind: SavedTicketOperation['kind'], payload: unknown): string {
  return createHash('sha256').update(canonical({ kind, payload })).digest('hex');
}
export function ticketOperationConflict(): never {
  throw new TicketWorkflowError(409, 'ticket_operation_conflict', 'This operation ID was already used for a different decision.');
}
export function ticketOperationReceipt(operation: SavedTicketOperation, key: TicketOperationKey): TicketOperationReceipt {
  if (Object.keys(key).some(field => key[field as keyof TicketOperationKey] !== operation.key[field as keyof TicketOperationKey])
    || operation.receipt.ticketId !== key.ticketId || operation.receipt.operationId !== key.operationId) {
    throw new Error('Ticket operation store returned a mismatched record.');
  }
  const receipt = {
    ticketId: operation.receipt.ticketId, operationId: operation.receipt.operationId,
    version: operation.receipt.version, status: operation.receipt.status,
  };
  if (operation.kind === 'command') return receipt;
  if (operation.kind === 'create') {
    if (key.actorKind !== 'client' || !operation.reference || operation.reference.length > 200 || operation.reference.trim() !== operation.reference
      || receipt.version !== 0 || receipt.status !== 'received') throw new Error('Ticket operation store returned an invalid outcome.');
    return { ...receipt, reference: operation.reference };
  }
  if (operation.kind === 'note' && key.actorKind !== 'pm') {
    throw new TicketWorkflowError(404, 'ticket_not_found', 'Ticket not found.');
  }
  if (!['message', 'note'].includes(operation.kind) || !operation.messageId || operation.messageId.length > 200
    || operation.messageId.trim() !== operation.messageId) throw new Error('Ticket operation store returned an invalid outcome.');
  return { ...receipt, messageId: operation.messageId };
}
