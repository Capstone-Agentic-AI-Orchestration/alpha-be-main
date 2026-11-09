import { randomUUID } from 'node:crypto';

import type { SavedTicketOperation, TicketCreationReceipt, TicketSubject } from '../store/ticketCommandStore.js';
import type { AuthorizedTicketCreateContext, TicketCreationStore, TicketCreationTransaction, TicketCreateOperationKey } from '../store/ticketCreationStore.js';
import { parseTicketCreate } from '../ticketing/intake.js';
import { newTicketWorkflow, TicketWorkflowError } from '../ticketing/workflow.js';
import { authorizeTicketAccess } from './ticketAccess.js';
import { ticketOperationConflict, ticketOperationFingerprint, ticketOperationReceipt } from './ticketOperations.js';

const opaque = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200 && value.trim() === value;
export function createTicketCreationService(store: TicketCreationStore, now: () => Date = () => new Date(), nextId: () => string = randomUUID) {
  async function authorize(tx: TicketCreationTransaction, contextId: string, subject: TicketSubject) {
    if (subject.kind !== 'client') throw new TicketWorkflowError(403, 'ticket_action_forbidden', 'Only clients can submit a new request here.');
    const context = await tx.lockAuthorizedCreateContext(contextId, subject);
    if (!opaque(contextId) || !context || context.id !== contextId || !opaque(context.workspaceId)
      || !opaque(context.clientId) || context.clientId !== subject.userId || !context.accessActive) {
      throw new TicketWorkflowError(404, 'ticket_not_found', 'Ticket not found.');
    }
    return context;
  }
  function keyFor(context: AuthorizedTicketCreateContext, operationId: string): TicketCreateOperationKey {
    return { workspaceId: context.workspaceId, clientId: context.clientId, operationId };
  }
  async function replay(tx: TicketCreationTransaction, saved: Extract<SavedTicketOperation, { kind: 'create' }>, key: TicketCreateOperationKey, subject: TicketSubject) {
    if (saved.kind !== 'create' || saved.key.workspaceId !== key.workspaceId || saved.key.actorKind !== 'client'
      || saved.key.actorId !== key.clientId || saved.key.operationId !== key.operationId || !opaque(saved.key.ticketId)) {
      throw new Error('Ticket creation store returned a mismatched operation.');
    }
    const target = { workspaceId: key.workspaceId, ticketId: saved.key.ticketId };
    await authorizeTicketAccess(tx, target, subject);
    const result = ticketOperationReceipt(saved, saved.key);
    if (!('reference' in result)) throw new Error('Ticket creation store returned an invalid outcome.');
    return result;
  }
  return {
    async create(contextId: string, subject: TicketSubject, input: unknown): Promise<TicketCreationReceipt> {
      return store.transaction(async tx => {
        const context = await authorize(tx, contextId, subject);
        if (context.mode !== 'enabled') {
          throw new TicketWorkflowError(503, 'ticket_writes_disabled', 'Ticket changes are unavailable right now.');
        }
        const parsed = parseTicketCreate(input);
        const key = keyFor(context, parsed.operationId);
        const fingerprint = ticketOperationFingerprint('create', { contextId: context.id, ...parsed });
        const saved = await tx.lockCreateOperation(key);
        if (saved) {
          const receipt = await replay(tx, saved, key, subject);
          if (saved.fingerprint !== fingerprint) ticketOperationConflict();
          return receipt;
        }
        // Follow-up links do not inherit the old scope, project or work approval.
        if (parsed.relatedTicketId) await authorizeTicketAccess(tx, { workspaceId: context.workspaceId, ticketId: parsed.relatedTicketId }, subject);
        let preferredProjectId: string | null = null;
        let requestedProjectLabel: string | null = null;
        if (parsed.projectPreference.kind === 'shared_project') {
          const option = await tx.loadSharedProjectOption(context, parsed.projectPreference.optionId);
          if (!option || option.id !== parsed.projectPreference.optionId || option.workspaceId !== context.workspaceId
            || option.clientId !== context.clientId || !option.active || !option.clientVisible || !opaque(option.projectId)
            || !opaque(option.displayName)) {
            throw new TicketWorkflowError(404, 'ticket_not_found', 'Ticket not found.');
          }
          preferredProjectId = option.projectId;
          requestedProjectLabel = option.displayName;
        }
        const ticketId = nextId();
        if (!opaque(ticketId)) throw new Error('The server could not assign a ticket identity.');
        const occurredAt = now().toISOString();
        const reference = await tx.allocateReference(context);
        if (!opaque(reference)) throw new Error('The server could not assign a ticket reference.');
        const target = { workspaceId: context.workspaceId, ticketId };
        const state = {
          ...newTicketWorkflow(ticketId, context.workspaceId, context.clientId),
          projectId: preferredProjectId,
        };
        const sharedProject = preferredProjectId && requestedProjectLabel ? {
          projectId: preferredProjectId,
          displayName: requestedProjectLabel,
          clientVisible: true,
        } : null;
        await tx.insertTicket({
          state,
          header: {
            ...target, reference, title: parsed.title, description: parsed.description, clientSafeCompanyLabel: context.companyLabel,
            createdAt: occurredAt, clientUpdatedAt: occurredAt, internalUpdatedAt: occurredAt,
            closedAt: null, relatedTicketId: parsed.relatedTicketId, sharedProject,
          },
          request: {
            source: 'authenticated_client', intakeContextId: context.id, projectPreference: parsed.projectPreference,
            preferredProjectId, requestedProjectLabel, requestedDeadline: parsed.requestedDeadline, contact: null,
          },
        });
        await tx.grantCreatedTicket(context, target);
        // Prove the adapter actually installed the exact grant before receipt.
        await authorizeTicketAccess(tx, target, subject);
        const audit = { target, clientId: context.clientId, operationId: parsed.operationId, type: 'ticket_created' as const, occurredAt };
        await tx.appendCreatedAudit(audit);
        await tx.enqueueCreated(audit);
        const receipt: TicketCreationReceipt = { ticketId, reference, operationId: parsed.operationId, version: 0, status: 'received' };
        await tx.insertCreateOperation({
          kind: 'create', key: { ...target, actorKind: 'client', actorId: context.clientId, operationId: parsed.operationId },
          fingerprint, reference, receipt: { ticketId, operationId: parsed.operationId, version: 0, status: 'received' },
        });
        return { ...receipt };
      });
    },
    /** Reconcile the SAME operation after uncertain COMMIT, with current context
     * and created-ticket access. Feature-off does not remove retained lookup.
     */
    async lookup(contextId: string, subject: TicketSubject, operationId: string): Promise<TicketCreationReceipt | null> {
      return store.transaction(async tx => {
        const context = await authorize(tx, contextId, subject);
        if (!opaque(operationId)) throw new TicketWorkflowError(400, 'invalid_ticket_intake', 'This ticket request is invalid.');
        const key = keyFor(context, operationId);
        const saved = await tx.lockCreateOperation(key);
        return saved ? replay(tx, saved, key, subject) : null;
      });
    },
  };
}
